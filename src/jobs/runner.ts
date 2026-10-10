/**
 * JobRunner (v2 slice 2b). One per bot connection. Design: v2/PLANNER.md.
 *
 * `start(goals)` plans (pure planner over a fresh WorldView), persists
 * `job.json`, then executes the steps in the background: every step has a
 * postcondition (checked by its executor), a typed failure, and the recovery
 * ladder in `recovery.ts` (retry → re-plan → widen → explore → fail). Job
 * end queues a synthetic event for Haiku (`onEnd`); cancelled jobs queue none.
 *
 * All world access is injected (`RunnerDeps`), so the state machine is unit-
 * testable with fake executors.
 *
 * Cancellation: v1's stop paths (stop skill, chat preempt, death, watchdog)
 * flip the bot's CancellationFlag; `wire.ts` subscribes `notifyStop()` to it.
 * The runner's own stops (step timeout, cancel) are flagged `internalStop`
 * so they are not mistaken for a player stop.
 */
import type { Facing } from "../build/types.js";
import { stepOutputItem, describeStep, goalsText, jobLabel } from "./describe.js";
import { planReservations } from "./reserve.js";
import {
  MAX_REPLANS,
  SCAN_RADII,
  decideRecovery,
  kindFromUnresolved,
  newEpisode,
  stepKey,
  type Episode,
} from "./recovery.js";
import type { FailureKind, Goal, PlanFn, Plan, Step, StepFailure, WorldView } from "../planner/types.js";
import type { TelemetryInput } from "../observability/telemetry.js";
import type { StopReason } from "../state/cancellation.js";
import type { AchieveResult, BuildOutcome, BuildPrep, BuildSpec, Job, JobStatus, StepResult } from "./types.js";

export interface StepRunContext {
  signal: AbortSignal;
  /** Scan radius for gather steps (widened by the ladder). */
  radius: number;
  /** Inventory count of the step's output item when its episode began. Target = baseline + step.count. */
  baseline: number;
  jobId: string;
}

export type ExecuteStep = (step: Step, ctx: StepRunContext) => Promise<StepResult>;
export type GatherStep = Extract<Step, { op: "gather" }>;
export interface ExploreOutcome {
  found: boolean;
  detail: string;
}
export type ExploreFn = (step: GatherStep, ctx: StepRunContext) => Promise<ExploreOutcome>;

export interface BuildRunContext extends StepRunContext {
  /** Telemetry sink for per-layer `step` events. */
  record: (e: TelemetryInput) => void;
  /** Live progress line + blocks placed so far (persisted with the job). */
  progress: (text: string, placed: number) => void;
}

/** Bot-bound half of a build job (src/jobs/steps/build.ts); injected so the runner stays testable. */
export interface BuildDeps {
  /**
   * Choose the site (or reuse `existing`), orient the blueprint and compute the materials gap.
   * Cheap and side-effect free apart from reading the world.
   */
  prepare: (spec: BuildSpec, existing: { origin: { x: number; y: number; z: number }; facing: Facing } | null) => Promise<BuildPrep>;
  /** Place the blueprint (idempotent: cells already done count). */
  run: (prep: Extract<BuildPrep, { ok: true }>, ctx: BuildRunContext) => Promise<BuildOutcome>;
}

/** Hand `goals` to player `to`; verifies the hand-over. */
export type DeliverFn = (to: string, goals: Goal[], ctx: StepRunContext) => Promise<StepResult>;

export interface RunnerDeps {
  username: string;
  plan: PlanFn;
  buildView: (goals: Goal[], radius: number) => Promise<WorldView>;
  execute: ExecuteStep;
  explore: ExploreFn;
  /** Slice 3: builder. Absent ⇒ `startBuild` refuses. */
  build?: BuildDeps;
  /** Slice 3: deliver-to-player. Absent ⇒ jobs with `deliverTo` fail at the hand-over. */
  deliver?: DeliverFn;
  /** Inventory count of an item (postcondition baselines). */
  countItem: (item: string) => number;
  /** Ask the running skill to wind down (cancellation flag + pathfinder.stop). */
  requestStop: () => void;
  record: (e: TelemetryInput) => void;
  load: () => Job | null;
  save: (job: Job) => void;
  /**
   * Reserve the inventory the (re)planned job still needs so filler consumers (pillar escapes)
   * leave it alone; `null` clears (job end). Optional: tests may omit.
   */
  reserve?: (items: Record<string, number> | null) => void;
  /** Called once when a job ends done or failed. */
  onEnd?: (job: Job) => void;
  /** Called by `dispose()` (unsubscribe listeners). */
  onDispose?: () => void;
  now?: () => number;
}

export const JOB_MAX_MS = 30 * 60_000;
/** Build phase budget (placing is the slow part; materials have their own step timeouts). */
export const BUILD_TIMEOUT_MS = 14 * 60_000;
export const DELIVER_TIMEOUT_MS = 2 * 60_000;
export const BUILD_MAX_ATTEMPTS = 3;
/** Placeholder for failures that belong to a phase rather than a planner step (build / deliver). */
const PHASE_STEP: Step = { op: "place_station", block: "crafting_table" };
const CANCEL_WAIT_MS = 35_000;
/** After a step's own timeout fires (cooperative stop), how long a skill that ignores it gets before being abandoned. */
export const STEP_GRACE_MS = 20_000;

/** Await `p`, but give up after `ms`; the timer never outlives the race. */
async function waitUpTo(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function stepTimeoutMs(s: Step): number {
  switch (s.op) {
    case "gather":
      return Math.min(15 * 60_000, 4 * 60_000 + s.count * 20_000);
    case "smelt":
      return 60_000 + s.count * 12_000;
    case "craft":
      return 120_000;
    case "withdraw":
      return 120_000;
    case "place_station":
      return 60_000;
  }
}

let seq = 0;
function newJobId(now: number): string {
  seq += 1;
  return `j${now.toString(36)}${seq}`;
}

export class JobRunner {
  private job: Job | null;
  private ctrl: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private internalStop = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /** Bumped by every external stop; `startInner` aborts if one landed while it was planning. */
  private stopEpoch = 0;
  private readonly now: () => number;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? Date.now;
    const prev = deps.load();
    this.job = prev;
    if (prev && prev.status === "running") {
      prev.status = "interrupted";
      prev.endedAt = this.now();
      prev.progress = "interrupted by an orchestrator restart";
      this.persist(prev);
      this.recordEnd(prev);
    }
  }

  isRunning(): boolean {
    return this.job?.status === "running";
  }

  /** The running job, or the last finished one (for the context block). */
  current(): Job | null {
    return this.job;
  }

  /** Plan and start a job. Serialized: a new start cancels the running job first. */
  start(goals: Goal[], requestedBy: string | null, opts: { deliverTo?: string | null } = {}): Promise<AchieveResult> {
    const run = this.chain.then(() => this.startInner(goals, requestedBy, opts.deliverTo ?? null));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Slice 3: plan the materials gap, then start a build job (site chosen up front). */
  startBuild(spec: BuildSpec, requestedBy: string | null): Promise<AchieveResult> {
    const run = this.chain.then(() => this.startBuildInner(spec, requestedBy));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async startInner(goals: Goal[], requestedBy: string | null, deliverTo: string | null): Promise<AchieveResult> {
    if (this.disposed) return { ok: false, jobId: null, message: "job runner is shut down" };
    if (this.isRunning()) await this.cancel("replaced by a new job");
    const epoch = this.stopEpoch;
    const view = await this.deps.buildView(goals, SCAN_RADII[0]);
    if (this.disposed) return { ok: false, jobId: null, message: "job runner is shut down" };
    if (this.stopEpoch !== epoch) {
      return { ok: false, jobId: null, message: "not started: a stop request arrived while the job was being planned" };
    }
    const plan = this.deps.plan(goals, view);
    // A hand-over job may have nothing to gather (the bot already holds the items, or creative).
    const deliverOnly = deliverTo !== null && plan.steps.length === 0 && plan.unresolved.length === 0;
    if (plan.steps.length === 0 && !deliverOnly) {
      if (plan.unresolved.length === 0) {
        return { ok: false, jobId: null, message: "nothing to do: you already have everything asked for" };
      }
      return refused(plan);
    }
    if (plan.unresolved.length > 0) return refused(plan);
    const now = this.now();
    const job: Job = {
      id: newJobId(now),
      kind: "achieve",
      goals: plan.goals,
      deliverTo,
      requestedBy,
      status: "running",
      startedAt: now,
      endedAt: null,
      plan,
      stepIndex: 0,
      replans: 0,
      progress: plan.steps[0] ? `step 1/${plan.steps.length}: ${describeStep(plan.steps[0])}` : `delivering to ${deliverTo}`,
      failure: null,
    };
    const summary = deliverOnly ? `hand over ${goalsText(plan.goals)}` : deliverTo ? `${plan.summary}, then hand over to ${deliverTo}` : plan.summary;
    return this.launch(job, summary, plan.rawNeeds, (j, c) => this.runAchieve(j, c));
  }

  private async startBuildInner(spec: BuildSpec, requestedBy: string | null): Promise<AchieveResult> {
    if (this.disposed) return { ok: false, jobId: null, message: "job runner is shut down" };
    const builder = this.deps.build;
    if (!builder) return { ok: false, jobId: null, message: "building isn't available right now" };
    if (this.isRunning()) await this.cancel("replaced by a new job");
    const epoch = this.stopEpoch;
    const prep = await builder.prepare(spec, null);
    if (this.disposed) return { ok: false, jobId: null, message: "job runner is shut down" };
    if (this.stopEpoch !== epoch) return { ok: false, jobId: null, message: "not started: a stop request arrived while the build was being planned" };
    if (!prep.ok) return { ok: false, jobId: null, message: prep.detail };
    let plan: Plan = { goals: prep.missing, steps: [], rawNeeds: {}, unresolved: [], summary: "" };
    if (prep.missing.length > 0) {
      const view = await this.deps.buildView(prep.missing, SCAN_RADII[0]);
      if (this.disposed) return { ok: false, jobId: null, message: "job runner is shut down" };
      plan = this.deps.plan(prep.missing, view);
      if (plan.unresolved.length > 0) {
        const why = plan.unresolved.map((u) => `${u.count} ${u.item}: ${u.reason}`).join("; ");
        return { ok: false, jobId: null, message: `can't build that yet, missing materials I can't get: ${why}`, unresolved: plan.unresolved };
      }
    }
    const now = this.now();
    const job: Job = {
      id: newJobId(now),
      kind: "build",
      goals: prep.missing,
      requestedBy,
      status: "running",
      startedAt: now,
      endedAt: null,
      plan,
      stepIndex: 0,
      replans: 0,
      progress: plan.steps[0] ? `materials 1/${plan.steps.length}: ${describeStep(plan.steps[0])}` : `building ${spec.blueprint}`,
      failure: null,
      build: {
        ...spec,
        phase: plan.steps.length > 0 ? "materials" : "building",
        params: prep.params,
        origin: prep.origin,
        facing: prep.facing,
        summary: prep.summary,
        total: prep.total,
        placed: 0,
      },
    };
    const summary = plan.steps.length > 0 ? `${prep.summary}. First get materials: ${plan.summary}` : prep.summary;
    return this.launch(job, summary, plan.rawNeeds, (j, c) => this.runBuildJob(j, c));
  }

  /** Persist, announce and start the background loop for a freshly built job. */
  private launch(job: Job, message: string, rawNeeds: Record<string, number>, body: (j: Job, c: AbortController) => Promise<void>): AchieveResult {
    this.job = job;
    this.persist(job);
    this.setReservations(planReservations(job.plan));
    this.deps.record({ kind: "job_start", jobId: job.id, goals: job.kind === "build" ? [{ item: `build:${job.build!.blueprint}`, count: 1 }, ...job.goals] : job.goals, steps: job.plan.steps.length + (job.kind === "build" ? 1 : 0) });
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.loop = body(job, ctrl).catch((err) => {
      console.error(`[${this.deps.username}] job loop crashed:`, err);
      this.finish(job, "failed", {
        kind: "internal",
        step: job.plan.steps[job.stepIndex] ?? PHASE_STEP,
        detail: `job runner crashed: ${err instanceof Error ? err.message : String(err)}`,
        attempts: 1,
      });
    });
    return { ok: true, jobId: job.id, message, rawNeeds };
  }

  /**
   * Cancel the running job and wait (bounded) for its in-flight step to wind
   * down, so a caller can start its own skill without two fighting over the bot.
   */
  async cancel(reason: string): Promise<void> {
    const job = this.job;
    const loop = this.loop;
    if (job && job.status === "running") {
      job.progress = `cancelled: ${reason}`;
      this.finish(job, "cancelled", null);
      this.ctrl?.abort();
      this.stopInternal();
    }
    if (loop) await waitUpTo(loop, CANCEL_WAIT_MS);
  }

  /**
   * Subscribed to the bot's CancellationFlag. A player stop cancels the running
   * job quietly (the stop path already answered the player). Death and the skill
   * watchdog end it as `failed` (kind `died` / `timeout`) so the model is told
   * and can inform the player; a silent end would drop their request.
   */
  notifyStop(reason: StopReason = "player"): void {
    if (this.internalStop > 0) return;
    this.stopEpoch += 1;
    const job = this.job;
    if (!job || job.status !== "running") return;
    if (reason === "player") {
      void this.cancel("stopped (player stop or abort)");
      return;
    }
    const step = job.plan.steps[Math.min(job.stepIndex, job.plan.steps.length - 1)]!;
    const failure: StepFailure =
      reason === "death"
        ? { kind: "died", step, detail: `the bot died during "${describeStep(step)}" (its items dropped where it died)`, attempts: 1 }
        : { kind: "timeout", step, detail: `a skill hit the watchdog during "${describeStep(step)}" and the job was stopped`, attempts: 1 };
    job.progress = `failed: ${failure.kind}`;
    this.finish(job, "failed", failure);
    this.ctrl?.abort();
    this.stopInternal();
  }

  /** Shutdown / reconnect: end the running job as interrupted. */
  async dispose(): Promise<void> {
    this.disposed = true;
    try {
      this.deps.onDispose?.();
    } catch {
      // best-effort
    }
    const job = this.job;
    if (job && job.status === "running") {
      job.progress = "interrupted: orchestrator shutdown or bot reconnect";
      this.finish(job, "interrupted", null);
      this.ctrl?.abort();
      this.stopInternal();
      if (this.loop) await waitUpTo(this.loop, 5_000);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private stopInternal(): void {
    this.internalStop += 1;
    try {
      this.deps.requestStop();
    } catch {
      // best-effort
    } finally {
      this.internalStop -= 1;
    }
  }

  private setReservations(items: Record<string, number> | null): void {
    try {
      this.deps.reserve?.(items);
    } catch {
      // best-effort
    }
  }

  private persist(job: Job): void {
    try {
      this.deps.save(job);
    } catch {
      // persistence is best-effort
    }
  }

  private recordEnd(job: Job): void {
    this.deps.record({
      kind: "job_end",
      jobId: job.id,
      status: job.status,
      durationMs: Math.max(0, (job.endedAt ?? this.now()) - job.startedAt),
      steps: job.plan.steps.length,
      replans: job.replans,
      failureKind: job.failure?.kind ?? null,
      ...(job.build ? { placed: job.build.placed, total: job.build.total } : {}),
    });
  }

  /** Idempotent end-of-job: first caller wins. */
  private finish(job: Job, status: Exclude<JobStatus, "running">, failure: StepFailure | null): void {
    if (job.status !== "running") return;
    job.status = status;
    this.setReservations(null);
    job.endedAt = this.now();
    job.failure = status === "failed" ? failure : null;
    if (status === "done") job.progress = `done: ${jobLabel(job)}`;
    if (status === "failed" && failure) job.progress = `failed: ${failure.kind} — ${failure.detail}`;
    this.persist(job);
    this.recordEnd(job);
    // A disposed runner (reconnect / shutdown) belongs to a dead bot or agent: no event.
    if ((status === "done" || status === "failed") && !this.disposed) {
      try {
        this.deps.onEnd?.(job);
      } catch (err) {
        console.warn(`[${this.deps.username}] job onEnd failed:`, err);
      }
    }
  }

  private setProgress(job: Job, text: string): void {
    if (job.status !== "running") return;
    job.progress = text;
    this.persist(job);
  }

  /** Achieve job body: gather/craft to the goals, then (optionally) hand them over. */
  private async runAchieve(job: Job, ctrl: AbortController): Promise<void> {
    if ((await this.runGoals(job, ctrl)) === "ended") return;
    if (job.deliverTo && !(await this.runDeliver(job, ctrl))) return;
    this.finish(job, "done", null);
  }

  /**
   * Drive `job.plan` to completion with the recovery ladder. Returns "met" when a
   * fresh re-plan finds nothing left to do, "ended" when the job already finished
   * (failed / cancelled). Does not finish the job on success: the caller decides
   * what comes next (deliver, build).
   */
  private async runGoals(job: Job, ctrl: AbortController): Promise<"met" | "ended"> {
    const episodes = new Map<string, Episode>();
    // Block types gathers could not reach during this job; fed to the planner on every re-plan.
    const avoid = new Set<string>();
    const deadline = this.now() + JOB_MAX_MS;
    let scanRadius: number = SCAN_RADII[0];
    const live = (): boolean => job.status === "running" && !ctrl.signal.aborted;

    while (live()) {
      if (this.now() > deadline) {
        const step = job.plan.steps[job.stepIndex] ?? job.plan.steps[job.plan.steps.length - 1]!;
        this.finish(job, "failed", { kind: "timeout", step, detail: `job exceeded ${JOB_MAX_MS / 60_000} minutes`, attempts: 1 });
        return "ended";
      }

      // Plan exhausted: verify against a fresh view (re-plan finds drift).
      if (job.stepIndex >= job.plan.steps.length) {
        const verdict = await this.replan(job, scanRadius, "verify", avoid);
        if (verdict === "done") return "met";
        if (verdict === "failed") return "ended";
        continue;
      }

      const step = job.plan.steps[job.stepIndex]!;
      const key = stepKey(step);
      let ep = episodes.get(key);
      if (!ep) {
        ep = newEpisode();
        episodes.set(key, ep);
      }
      if (ep.baseline === null) ep.baseline = this.deps.countItem(stepOutputItem(step));
      const radius = SCAN_RADII[ep.radiusIdx] ?? SCAN_RADII[0];
      scanRadius = Math.max(scanRadius, radius);
      this.setProgress(job, `step ${job.stepIndex + 1}/${job.plan.steps.length}: ${describeStep(step)}`);

      const res = await this.runStep(job, step, { signal: ctrl.signal, radius, baseline: ep.baseline, jobId: job.id });
      if (!live()) return "ended";
      if (res.ok) {
        job.stepIndex += 1;
        episodes.delete(key);
        this.persist(job);
        continue;
      }

      const failure: StepFailure = { ...res.failure, attempts: ep.fails + 1 };
      for (const b of failure.avoid ?? []) {
        if (!avoid.has(b)) console.log(`[${this.deps.username}] job avoid: ${b} (unreachable); re-plans will prefer another source`);
        avoid.add(b);
      }
      const rung = decideRecovery(failure, step, ep, MAX_REPLANS - job.replans);
      this.deps.record({ kind: "recovery", jobId: job.id, rung: rung.rung, detail: `${failure.kind}: ${rung.detail}`.slice(0, 200) });
      switch (rung.rung) {
        case "cancel":
          if (job.status === "running") {
            if (failure.kind === "died") {
              this.finish(job, "failed", failure); // the model must hear about a death
            } else {
              job.progress = `cancelled: ${failure.kind}`;
              this.finish(job, "cancelled", null);
            }
          }
          return "ended";
        case "fail":
          this.finish(job, "failed", {
            ...failure,
            detail: rung.detail === failure.detail || !failure.detail ? rung.detail : `${rung.detail} (last: ${failure.detail})`,
          });
          return "ended";
        case "retry":
          this.setProgress(job, `step ${job.stepIndex + 1}/${job.plan.steps.length}: ${describeStep(step)} (retrying: ${failure.kind})`);
          break;
        case "widen":
          scanRadius = Math.max(scanRadius, rung.radius);
          this.setProgress(job, `step ${job.stepIndex + 1}/${job.plan.steps.length}: ${describeStep(step)} (widening search to ${rung.radius})`);
          break;
        case "replan": {
          const verdict = await this.replan(job, scanRadius, rung.detail, avoid);
          if (verdict === "continue") for (const e of episodes.values()) e.baseline = null; // inventory changed: re-baseline lazily
          if (verdict === "done") return "met";
          if (verdict === "failed") return "ended";
          break;
        }
        case "explore": {
          if (step.op !== "gather") break;
          this.setProgress(job, `step ${job.stepIndex + 1}/${job.plan.steps.length}: exploring for ${step.item} (${step.searchHint?.kind ?? "surface"})`);
          let out: ExploreOutcome;
          try {
            out = await this.deps.explore(step, { signal: ctrl.signal, radius, baseline: ep.baseline, jobId: job.id });
          } catch (err) {
            out = { found: false, detail: `explore crashed: ${err instanceof Error ? err.message : String(err)}` };
          }
          if (!live()) return "ended";
          this.deps.record({ kind: "recovery", jobId: job.id, rung: "explore", detail: `${out.found ? "found" : "gave up"}: ${out.detail}`.slice(0, 200) });
          break;
        }
      }
    }
    return "ended";
  }

  /** Rebuild the view and re-plan. Returns whether the goals are met / the job failed / execution continues. */
  private async replan(job: Job, radius: number, why: string, avoid: ReadonlySet<string> = new Set()): Promise<"done" | "failed" | "continue"> {
    const verifying = why === "verify";
    if (!verifying && job.replans >= MAX_REPLANS) {
      this.finish(job, "failed", this.driftFailure(job, `replan limit (${MAX_REPLANS}) reached`));
      return "failed";
    }
    let view: WorldView;
    try {
      view = await this.deps.buildView(job.goals, radius);
      if (avoid.size > 0) view = { ...view, avoidBlocks: [...avoid] };
    } catch (err) {
      this.finish(job, "failed", this.driftFailure(job, `could not rebuild the world view: ${err instanceof Error ? err.message : String(err)}`, "internal"));
      return "failed";
    }
    if (job.status !== "running") return "failed";
    const plan: Plan = this.deps.plan(job.goals, view);
    if (plan.steps.length === 0) {
      if (plan.unresolved.length === 0) return "done";
      const u = plan.unresolved[0]!;
      this.finish(job, "failed", this.driftFailure(job, `${u.item}: ${u.reason}`, kindFromUnresolved(u.reason)));
      return "failed";
    }
    if (verifying && job.replans >= MAX_REPLANS) {
      this.finish(job, "failed", this.driftFailure(job, `goal not met after the plan ran and replan limit reached; still needs: ${plan.summary}`, "missing_input"));
      return "failed";
    }
    if (plan.unresolved.length > 0) {
      const u = plan.unresolved[0]!;
      job.plan = plan; // the event's "remaining plan" shows what is left, not the stale plan
      job.stepIndex = 0;
      this.finish(job, "failed", { kind: kindFromUnresolved(u.reason), step: plan.steps[0]!, detail: `${u.item}: ${u.reason}`, attempts: 1 });
      return "failed";
    }
    job.replans += 1;
    job.plan = plan;
    job.stepIndex = 0;
    this.setReservations(planReservations(plan));
    this.deps.record({ kind: "recovery", jobId: job.id, rung: "replan", detail: `#${job.replans} ${why}: ${plan.summary}`.slice(0, 200) });
    this.setProgress(job, `step 1/${plan.steps.length}: ${describeStep(plan.steps[0]!)} (replanned)`);
    return "continue";
  }

  private driftFailure(job: Job, detail: string, kind: FailureKind = "missing_input"): StepFailure {
    const step = job.plan.steps[Math.min(job.stepIndex, job.plan.steps.length - 1)] ?? ({ op: "place_station", block: "crafting_table" } as Step);
    return { kind, step, detail, attempts: 1 };
  }

  private async runStep(job: Job, step: Step, ctx: StepRunContext): Promise<StepResult> {
    const t0 = this.now();
    const res = await this.timed(step, describeStep(step), stepTimeoutMs(step), () => this.deps.execute(step, ctx));
    this.deps.record({
      kind: "step",
      jobId: job.id,
      op: step.op,
      item: stepOutputItem(step),
      ok: res.ok,
      durationMs: this.now() - t0,
      failureKind: res.ok ? null : res.failure.kind,
    });
    return res;
  }

  /**
   * Run `exec` under the runner-owned timeout: first a cooperative stop, then, if
   * the skill ignores it, abandon it. `step` is the failure's step (a placeholder
   * for build / deliver phases).
   */
  private async timed(step: Step, label: string, limit: number, exec: () => Promise<StepResult>): Promise<StepResult> {
    let timedOut = false;
    let abandonTimer: NodeJS.Timeout | undefined;
    // The runner owns step timeouts (job steps run without the skill watchdog):
    // first a cooperative stop, then, if the skill ignores it, abandon the step.
    const timer = setTimeout(() => {
      timedOut = true;
      this.stopInternal();
      abandonTimer = setTimeout(() => {
        this.stopInternal();
        giveUp({ ok: false, failure: { kind: "timeout", step, detail: `${label} did not stop after its ${Math.round(limit / 1000)}s limit and was abandoned`, attempts: 1 } });
      }, STEP_GRACE_MS);
    }, limit);
    let giveUp: (r: StepResult) => void = () => {};
    const abandoned = new Promise<StepResult>((resolve) => {
      giveUp = resolve;
    });
    let res: StepResult;
    try {
      res = await Promise.race([exec(), abandoned]);
    } catch (err) {
      res = {
        ok: false,
        failure: { kind: "internal", step, detail: `step crashed: ${err instanceof Error ? err.message : String(err)}`, attempts: 1 },
      };
    } finally {
      clearTimeout(timer);
      if (abandonTimer) clearTimeout(abandonTimer);
    }
    if (timedOut && !res.ok && res.failure.kind === "cancelled") {
      res = { ok: false, failure: { ...res.failure, kind: "timeout", detail: `${label} timed out after ${Math.round(limit / 1000)}s` } };
    }
    return res;
  }

  /** Hand the goal items to `job.deliverTo`. Returns false when the job ended (failed / cancelled). */
  private async runDeliver(job: Job, ctrl: AbortController): Promise<boolean> {
    const to = job.deliverTo!;
    if (!ctrl.signal.aborted && job.status === "running") this.setProgress(job, `delivering ${goalsText(job.goals)} to ${to}`);
    const t0 = this.now();
    const ctx: StepRunContext = { signal: ctrl.signal, radius: SCAN_RADII[0], baseline: 0, jobId: job.id };
    const deliver = this.deps.deliver;
    const res = await this.timed(PHASE_STEP, `handing over to ${to}`, DELIVER_TIMEOUT_MS, () =>
      deliver
        ? deliver(to, job.goals, ctx)
        : Promise.resolve<StepResult>({ ok: false, failure: { kind: "internal", step: PHASE_STEP, detail: "hand-over isn't available", attempts: 1 } }),
    );
    this.deps.record({
      kind: "step",
      jobId: job.id,
      op: "deliver",
      item: job.goals.map((g) => g.item).join(","),
      ok: res.ok,
      durationMs: this.now() - t0,
      failureKind: res.ok ? null : res.failure.kind,
    });
    if (job.status !== "running" || ctrl.signal.aborted) return false;
    if (res.ok) return true;
    if (res.failure.kind === "cancelled") {
      job.progress = "cancelled during hand-over";
      this.finish(job, "cancelled", null);
    } else {
      this.finish(job, "failed", { ...res.failure, step: res.failure.step });
    }
    return false;
  }

  /** Build job body: materials via the normal plan loop, then the builder, retried a couple of times (it resumes). */
  private async runBuildJob(job: Job, ctrl: AbortController): Promise<void> {
    const builder = this.deps.build;
    const state = job.build!;
    if (!builder) {
      this.finish(job, "failed", { kind: "internal", step: PHASE_STEP, detail: "building isn't available", attempts: 1 });
      return;
    }
    const live = (): boolean => job.status === "running" && !ctrl.signal.aborted;
    if (job.plan.steps.length > 0) {
      if ((await this.runGoals(job, ctrl)) === "ended") return;
    }
    if (!live()) return;
    state.phase = "building";
    this.setProgress(job, `building ${state.summary}`);
    let last: BuildOutcome | null = null;
    // The gather phase may have dug into the planned footprint: re-pick the site once, as long as nothing is built yet.
    let resite = job.plan.steps.length > 0;
    for (let attempt = 1; attempt <= BUILD_MAX_ATTEMPTS && live(); attempt++) {
      const reuse = !resite && state.origin && state.facing ? { origin: state.origin, facing: state.facing } : null;
      resite = false;
      const prep = await builder.prepare(state, reuse);
      if (!live()) return;
      if (!prep.ok) {
        this.finish(job, "failed", { kind: prep.kind, step: PHASE_STEP, detail: prep.detail, attempts: attempt });
        return;
      }
      state.origin = prep.origin;
      state.facing = prep.facing;
      state.params = prep.params;
      state.total = prep.total;
      if (prep.missing.length > 0) {
        // materials still short after the gather phase (or consumed by a failed attempt): one more planned round
        const view = await this.deps.buildView(prep.missing, SCAN_RADII[0]);
        const plan = this.deps.plan(prep.missing, view);
        if (plan.unresolved.length > 0 || plan.steps.length === 0) {
          const u = plan.unresolved[0];
          this.finish(job, "failed", {
            kind: "missing_input",
            step: PHASE_STEP,
            detail: u ? `still missing ${prep.missing.map((m) => `${m.count} ${m.item}`).join(", ")}: ${u.reason}` : `still missing ${prep.missing.map((m) => `${m.count} ${m.item}`).join(", ")}`,
            attempts: attempt,
          });
          return;
        }
        job.goals = prep.missing;
        job.plan = plan;
        job.stepIndex = 0;
        job.replans += 1;
        state.phase = "materials";
        this.setReservations(planReservations(plan));
        if ((await this.runGoals(job, ctrl)) === "ended") return;
        state.phase = "building";
        resite = state.placed === 0;
        continue; // re-prepare with the new inventory
      }
      const t0 = this.now();
      const bctx: BuildRunContext = {
        signal: ctrl.signal,
        radius: SCAN_RADII[0],
        baseline: 0,
        jobId: job.id,
        record: (e) => this.deps.record(e),
        progress: (text, placed) => {
          state.placed = placed;
          this.setProgress(job, text);
        },
      };
      let outcome: BuildOutcome | null = null;
      const res = await this.timed(PHASE_STEP, `building the ${state.blueprint}`, BUILD_TIMEOUT_MS, async () => {
        outcome = await builder.run(prep, bctx);
        return outcome.ok
          ? { ok: true, detail: outcome.detail }
          : { ok: false, failure: { kind: outcome.kind, step: PHASE_STEP, detail: outcome.detail, attempts: attempt } };
      });
      const out = outcome as BuildOutcome | null;
      if (out) {
        state.placed = out.placed;
        state.total = out.total;
      }
      last = out ?? (res.ok ? null : { ok: false, kind: res.failure.kind, detail: res.failure.detail, placed: state.placed, total: state.total });
      this.deps.record({
        kind: "step",
        jobId: job.id,
        op: "build",
        item: state.blueprint,
        ok: res.ok,
        durationMs: this.now() - t0,
        failureKind: res.ok ? null : res.failure.kind,
      });
      if (!live()) return;
      if (res.ok) {
        this.finish(job, "done", null);
        return;
      }
      const kind = res.failure.kind;
      if (kind === "cancelled") {
        job.progress = "cancelled during the build";
        this.finish(job, "cancelled", null);
        return;
      }
      if (kind === "died" || kind === "missing_input" || kind === "no_site" || kind === "inventory_full" || kind === "unknown_item") break;
      this.deps.record({ kind: "recovery", jobId: job.id, rung: "retry", detail: `build ${kind}: ${res.failure.detail}`.slice(0, 200) });
    }
    if (!live()) return;
    const f = last && !last.ok ? last : null;
    this.finish(job, "failed", {
      kind: f?.kind ?? "internal",
      step: PHASE_STEP,
      detail: f ? `${f.detail} (placed ${f.placed}/${f.total})` : "build did not complete",
      attempts: BUILD_MAX_ATTEMPTS,
    });
  }
}

function refused(plan: Plan): AchieveResult {
  const why = plan.unresolved.map((u) => `${u.count} ${u.item}: ${u.reason}`).join("; ");
  return {
    ok: false,
    jobId: null,
    message: `can't plan that: ${why}`,
    unresolved: plan.unresolved,
    ...(plan.steps.length > 0 ? { rawNeeds: plan.rawNeeds } : {}),
  };
}
