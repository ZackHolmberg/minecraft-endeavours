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
import { FOLLOW_MAX_MS } from "./follow.js";
import { planReservations } from "./reserve.js";
import { emptyExhausted, excludeFor, noteExhausted, type ExcludeFn } from "./exhausted.js";
import { inNightWindow, shelterGeometry, type ShelterGeometry } from "./night.js";
import type { PocketPlan } from "./pocket.js";
import {
  MAX_RELOCATIONS,
  MAX_REPLANS,
  SCAN_RADII,
  decideRecovery,
  kindFromUnresolved,
  newEpisode,
  stepKey,
  type Episode,
} from "./recovery.js";
import { isGoalTag } from "../planner/knowledge/tags.js";
import type { FailureKind, Goal, PlanFn, Plan, Step, StepFailure, WorldView } from "../planner/types.js";
import type { TelemetryInput } from "../observability/telemetry.js";
import type { StopReason } from "../state/cancellation.js";
import type { AchieveResult, BuildOutcome, BuildPrep, BuildSpec, FollowOutcome, FollowState, Job, JobStatus, JobStepFailure, ScaffoldCell, StepResult } from "./types.js";

export interface StepRunContext {
  signal: AbortSignal;
  /** Scan radius for gather steps (widened by the ladder). */
  radius: number;
  /** Inventory count of the step's output item when its episode began. Target = baseline + step.count. */
  baseline: number;
  jobId: string;
  /** Positions/areas this job already found unreachable: gathers and scans skip them. */
  exclude?: ExcludeFn;
}

export type ExecuteStep = (step: Step, ctx: StepRunContext) => Promise<StepResult>;
export type GatherStep = Extract<Step, { op: "gather" }>;
export interface ExploreOutcome {
  found: boolean;
  detail: string;
}
export type ExploreFn = (step: GatherStep, ctx: StepRunContext) => Promise<ExploreOutcome>;
export interface RelocateOutcome {
  moved: boolean;
  detail: string;
}
/** Walk to another (dry, surface) area >= 48 blocks from `from`, avoiding the job's exhausted regions. */
export type RelocateFn = (step: GatherStep, ctx: StepRunContext, regions: ReadonlyArray<{ x: number; z: number; r: number }>) => Promise<RelocateOutcome>;

/** Bot-bound half of night survival (src/jobs/steps/night.ts); injected so the runner stays testable. */
export interface NightDeps {
  /** Server time of day (0..24000), null when unknown. */
  timeOfDay: () => number | null;
  /** A bed to sleep in (one within reach of a walk, or in the inventory): a short description, else null. */
  findBed: () => string | null;
  /** Go to the bed, sleep, and wait (re-sleeping if woken) until dawn. */
  sleepThrough: (ctx: StepRunContext) => Promise<StepResult>;
  /** From wherever the bot stands near the finished shelter: get in, close up, light it, wait for dawn, come out. */
  holdInShelter: (geo: ShelterGeometry, ctx: StepRunContext) => Promise<StepResult>;
  /** Quick shelter: where a 1x2 pocket can be dug into the ground / a hillside near the bot (null = nowhere safe). Cheap world read. */
  planPocket?: () => PocketPlan | null;
  /** Dig the planned pocket from inside out, seal it, wait for dawn, open up and step out. */
  digInThrough?: (plan: PocketPlan, ctx: StepRunContext) => Promise<StepResult>;
  /** Boot recovery: if the bot is still inside a pocket from an earlier run (restart while dug in), open it and climb out. True when it acted. */
  leavePocket?: (plan: PocketPlan, signal: AbortSignal) => Promise<boolean>;
}

export interface BuildRunContext extends StepRunContext {
  /** Telemetry sink for per-layer `step` events. */
  record: (e: TelemetryInput) => void;
  /** Live progress line + blocks placed so far (persisted with the job). */
  progress: (text: string, placed: number) => void;
  /** Scaffold blocks left in the world by an earlier attempt/job: the builder removes them before anything else. */
  scaffolds: ScaffoldCell[];
  /** The builder's current scaffold list; persisted in job.json at once so a stop/crash can't orphan blocks. Empty clears. */
  setScaffolds: (list: ScaffoldCell[]) => void;
}

/** Bot-bound half of a build job (src/jobs/steps/build.ts); injected so the runner stays testable. */
export interface BuildDeps {
  /**
   * Choose the site (or reuse `existing`), orient the blueprint and compute the materials gap.
   * Cheap and side-effect free apart from reading the world.
   */
  prepare: (
    spec: BuildSpec,
    existing: { origin: { x: number; y: number; z: number }; facing: Facing } | null,
    /** Leftover scaffold blocks: not terrain (the world is read as if they were air). */
    scaffolds?: ScaffoldCell[],
  ) => Promise<BuildPrep>;
  /** Place the blueprint (idempotent: cells already done count). Removes its scaffolds in a `finally` (best effort). */
  run: (prep: Extract<BuildPrep, { ok: true }>, ctx: BuildRunContext) => Promise<BuildOutcome>;
  /** Remove leftover scaffolds (boot / next job); returns those still standing (failed, or skipped because the bot is dead / gone). */
  reclaim?: (scaffolds: ScaffoldCell[], signal: AbortSignal) => Promise<ScaffoldCell[]>;
}

/** Remembered builds (failure ledger): unfinished structures to resume onto, and "this keeps failing here" refusals. */
export interface BuildHistory {
  refusal: (spec: BuildSpec) => string | null;
  partial: (spec: BuildSpec) => { origin: { x: number; y: number; z: number }; facing: Facing; params: Record<string, unknown>; placed: number; total: number } | null;
}

export interface FollowRunContext {
  signal: AbortSignal;
  jobId: string;
  /** Epoch ms after which the follow ends on its own (the 30-minute cap). */
  deadline: number;
  /** Telemetry sink (`recovery` events for lost-sight / re-acquired). */
  record: (e: TelemetryInput) => void;
  /** Live progress line for the context block (persisted with the job). */
  progress: (text: string) => void;
}

/** Bot-bound half of a follow job (src/jobs/steps/follow.ts); injected so the runner stays testable. */
export interface FollowDeps {
  /**
   * Keep ~`dist` blocks from the player until `ctx.signal` aborts, the deadline passes, or it fails for good
   * (player left, lost for ~45 s, can't reach). Resolves quietly on abort (the runner already ended the job).
   */
  run: (spec: FollowState, ctx: FollowRunContext) => Promise<FollowOutcome>;
}

/** Hand `goals` to player `to`; verifies the hand-over. */
export type DeliverFn = (to: string, goals: Goal[], ctx: StepRunContext) => Promise<StepResult>;

export interface RunnerDeps {
  username: string;
  plan: PlanFn;
  buildView: (goals: Goal[], radius: number, exclude?: ExcludeFn) => Promise<WorldView>;
  execute: ExecuteStep;
  explore: ExploreFn;
  /** Explore-elsewhere rung (absent ⇒ unreachable gathers skip straight to the avoid-and-replan rung). */
  relocate?: RelocateFn;
  /** Slice 3: builder. Absent ⇒ `startBuild` refuses. */
  build?: BuildDeps;
  /** Slice 3: deliver-to-player. Absent ⇒ jobs with `deliverTo` fail at the hand-over. */
  deliver?: DeliverFn;
  /** Follow job (live-test fix 2026-10-10): follow a player in the background. Absent => `startFollow` refuses. */
  follow?: FollowDeps;
  /** Slice 2c-B: night survival (sleep / wait in the shelter). Absent ⇒ `surviveNight` refuses. */
  night?: NightDeps;
  /** Inventory count of an item (postcondition baselines). */
  countItem: (item: string) => number;
  /** The bot's position (centre for an exhausted area when a failure reported no positions). Optional: tests may omit. */
  position?: () => { x: number; y: number; z: number };
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
  /** Slice 3 review M3: called when a BUILD job ends in any state (also cancelled / interrupted), to record what it left behind. */
  onBuildEnd?: (job: Job) => void;
  /** Slice 3 review M3: ledger view used by `startBuild`. */
  buildHistory?: BuildHistory;
  /** Called by `dispose()` (unsubscribe listeners). */
  onDispose?: () => void;
  now?: () => number;
}

export const JOB_MAX_MS = 30 * 60_000;
/** Build phase budget (placing is the slow part; materials have their own step timeouts). */
export const BUILD_TIMEOUT_MS = 14 * 60_000;
export const DELIVER_TIMEOUT_MS = 2 * 60_000;
/** A night is 10 500 ticks = 8.75 min at 20 tps; double that for slow ticks and getting in / out. */
export const NIGHT_HOLD_TIMEOUT_MS = 18 * 60_000;
export const BUILD_MAX_ATTEMPTS = 3;
/** Don't start another build attempt with less than this left of the job's time cap. */
export const MIN_BUILD_ATTEMPT_MS = 60_000;
/** After an attempt is abandoned/aborted, how long the old Builder gets to wind down (and strip scaffolds) before the job fails. */
export const BUILDER_WIND_DOWN_MS = 30_000;
/** Boot-time scaffold reclaim budget. */
const RECLAIM_WAIT_MS = 30_000;
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
  /** Items the active BUILD job needs beyond its plan (blocks, scaffold, tools, seeds...): merged into every reservation. */
  private buildReserve: Record<string, number> = {};
  private reclaiming: Promise<void> | null = null;
  private reclaimCtrl: AbortController | null = null;

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

  /** Start a follow job (replaces the running job). Returns at once; the follow runs until stopped, failed or the 30-min cap. */
  startFollow(spec: FollowState, requestedBy: string | null): Promise<AchieveResult> {
    const run = this.chain.then(() => this.startFollowInner(spec, requestedBy));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async startFollowInner(spec: FollowState, requestedBy: string | null): Promise<AchieveResult> {
    if (this.disposed) return { ok: false, jobId: null, message: "job runner is shut down" };
    if (!this.deps.follow) return { ok: false, jobId: null, message: "following isn't available right now" };
    if (this.isRunning()) await this.cancel("replaced by a new job");
    await this.settleReclaim();
    if (this.disposed) return { ok: false, jobId: null, message: "job runner is shut down" };
    const now = this.now();
    const summary = `follow ${spec.player} at ~${spec.dist} blocks`;
    const job: Job = {
      id: newJobId(now),
      kind: "follow",
      goals: [],
      requestedBy,
      status: "running",
      startedAt: now,
      endedAt: null,
      plan: { goals: [], steps: [], rawNeeds: {}, unresolved: [], summary: "" },
      stepIndex: 0,
      replans: 0,
      progress: `following ${spec.player}`,
      failure: null,
      follow: { ...spec },
    };
    return this.launch(job, summary, {}, (j, c) => this.runFollowJob(j, c));
  }

  private async startInner(goals: Goal[], requestedBy: string | null, deliverTo: string | null): Promise<AchieveResult> {
    if (this.disposed) return { ok: false, jobId: null, message: "job runner is shut down" };
    if (this.isRunning()) await this.cancel("replaced by a new job");
    await this.settleReclaim();
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
      ...(goals.some((g) => isGoalTag(g.item)) ? { generic: goals.map((g) => ({ ...g })) } : {}),
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
    const refusal = this.deps.buildHistory?.refusal(spec) ?? null;
    // The night job defers this check: a refused hut must not block digging in or sleeping.
    if (refusal && spec.hold !== "night") {
      console.log(`[${this.deps.username}] build refused by the failure ledger: ${spec.blueprint}`);
      return { ok: false, jobId: null, message: refusal };
    }
    if (spec.hold === "night") {
      const t = this.deps.night?.timeOfDay() ?? null;
      if (!this.deps.night) return { ok: false, jobId: null, message: "night survival isn't available right now" };
      if (t !== null && !inNightWindow(t)) return { ok: false, jobId: null, message: `it's daytime (time ${t}); there is nothing to shelter from. Night starts around 12500 (dusk ~11000).` };
    }
    if (this.isRunning()) await this.cancel("replaced by a new job");
    await this.settleReclaim();
    const epoch = this.stopEpoch;
    if (spec.hold === "night" && spec.params.useBed !== false) {
      const bed = this.deps.night!.findBed();
      if (bed) return this.launchSleep(spec, bed, requestedBy);
    }
    // No bed: dig in. Seconds of work with natural blocks, versus minutes for the hut (mobs arrive ~2 min after dusk).
    if (spec.hold === "night" && spec.params.shelter !== "hut") {
      const pocket = this.deps.night!.planPocket?.() ?? null;
      if (pocket) return this.launchPocket(spec, pocket, requestedBy);
    }
    if (refusal) {
      console.log(`[${this.deps.username}] build refused by the failure ledger: ${spec.blueprint}`);
      return { ok: false, jobId: null, message: refusal };
    }
    // An unfinished structure of this kind nearby: continue it at its stored origin, never start a second one beside it.
    const resume = this.deps.buildHistory?.partial(spec) ?? this.partialFromLastJob(spec);
    if (resume) spec = { ...spec, params: { ...resume.params } };
    const prep = await builder.prepare(spec, resume ? { origin: resume.origin, facing: resume.facing } : null, this.job?.scaffolds);
    if (this.disposed) return { ok: false, jobId: null, message: "job runner is shut down" };
    if (this.stopEpoch !== epoch) return { ok: false, jobId: null, message: "not started: a stop request arrived while the build was being planned" };
    if (!prep.ok) {
      const where = resume ? `${resume.origin.x}, ${resume.origin.y}, ${resume.origin.z}` : "";
      return { ok: false, jobId: null, message: resume ? `there is an unfinished ${spec.blueprint} (${resume.placed}/${resume.total}) at ${where} and I can't continue it: ${prep.detail}. I won't start a second one next to it.` : prep.detail };
    }
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
    const summaryText = resume ? `continuing the unfinished ${spec.blueprint} at ${prep.origin.x}, ${prep.origin.y}, ${prep.origin.z} (${resume.placed}/${resume.total} placed): ${prep.summary}` : prep.summary;
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
        summary: summaryText,
        total: prep.total,
        placed: resume?.placed ?? 0,
        ...(resume ? { resumed: true } : {}),
      },
    };
    const summary = plan.steps.length > 0 ? `${summaryText}. First get materials: ${plan.summary}` : summaryText;
    this.buildReserve = Object.fromEntries((prep.reserve ?? []).map((i) => [i, Number.POSITIVE_INFINITY]));
    return this.launch(job, summary, plan.rawNeeds, (j, c) => this.runBuildJob(j, c));
  }

  /** A bed is at hand: no building, just sleep through the night (the hold phase does the walking and waiting). */
  private launchSleep(spec: BuildSpec, bed: string, requestedBy: string | null): AchieveResult {
    const now = this.now();
    const summary = `sleep in ${bed} until morning`;
    const job: Job = {
      id: newJobId(now),
      kind: "build",
      goals: [],
      requestedBy,
      status: "running",
      startedAt: now,
      endedAt: null,
      plan: { goals: [], steps: [], rawNeeds: {}, unresolved: [], summary: "" },
      stepIndex: 0,
      replans: 0,
      progress: summary,
      failure: null,
      build: { ...spec, phase: "holding", origin: null, facing: null, summary, total: 0, placed: 0, holdMode: "sleep" },
    };
    return this.launch(job, summary, {}, (j, c) => this.runBuildJob(j, c));
  }

  /** No bed: dig a 1x2 pocket into the ground / a hillside, seal it and wait inside. No builder, no materials phase. */
  private launchPocket(spec: BuildSpec, pocket: PocketPlan, requestedBy: string | null): AchieveResult {
    const now = this.now();
    const summary = `dig in for the night (${pocket.summary}), wait inside until morning`;
    const job: Job = {
      id: newJobId(now),
      kind: "build",
      goals: [],
      requestedBy,
      status: "running",
      startedAt: now,
      endedAt: null,
      plan: { goals: [], steps: [], rawNeeds: {}, unresolved: [], summary: "" },
      stepIndex: 0,
      replans: 0,
      progress: summary,
      failure: null,
      build: { ...spec, phase: "holding", origin: null, facing: null, summary, total: 0, placed: 0, holdMode: "pocket", pocket },
    };
    return this.launch(job, summary, {}, (j, c) => this.runBuildJob(j, c));
  }

  /** The previous job, when it was an unfinished build of this blueprint near `spec.anchor` (job.json survives restarts). */
  private partialFromLastJob(spec: BuildSpec): ReturnType<BuildHistory["partial"]> {
    const prev = this.job;
    const b = prev?.build;
    if (!prev || !b || prev.kind !== "build" || prev.status === "running" || prev.status === "done") return null;
    if (b.blueprint !== spec.blueprint || !b.origin || !b.facing || b.placed <= 0 || b.placed >= b.total) return null;
    if (this.now() - (prev.endedAt ?? 0) > 2 * 60 * 60_000) return null;
    const d = (p: { x: number; z: number }): number => Math.hypot(p.x - spec.anchor.x, p.z - spec.anchor.z);
    if (d(b.origin) > 16 && d(b.anchor) > 16) return null;
    return { origin: b.origin, facing: b.facing, params: b.params, placed: b.placed, total: b.total };
  }

  /**
   * Boot / next start: remove scaffold blocks an earlier run left standing (persisted in job.json), and (M3) climb out of a
   * night pocket the bot is still sealed in after a restart. Best effort, bounded.
   */
  reclaimOrphans(): Promise<void> {
    const job = this.job;
    const build = this.deps.build;
    const night = this.deps.night;
    const scaffolds = job?.scaffolds?.length && build?.reclaim ? job.scaffolds : null;
    const pocket = job && job.status !== "done" && job.build?.holdMode === "pocket" && job.build.pocket && night?.leavePocket ? job.build.pocket : null;
    if (this.disposed || this.reclaiming || this.isRunning() || (!scaffolds && !pocket)) return this.reclaiming ?? Promise.resolve();
    const ctrl = new AbortController();
    this.reclaimCtrl = ctrl;
    const timer = setTimeout(() => ctrl.abort(), RECLAIM_WAIT_MS);
    this.reclaiming = (async () => {
      try {
        if (pocket) await night!.leavePocket!(pocket, ctrl.signal);
        if (scaffolds) {
          const left = await build!.reclaim!(scaffolds, ctrl.signal);
          job!.scaffolds = left.length > 0 ? left : undefined;
          this.persist(job!);
        }
      } catch (err) {
        console.warn(`[${this.deps.username}] orphan reclaim failed:`, err);
      } finally {
        clearTimeout(timer);
        this.reclaimCtrl = null;
        this.reclaiming = null;
      }
    })();
    return this.reclaiming;
  }

  private async settleReclaim(): Promise<void> {
    if (this.reclaiming) await waitUpTo(this.reclaiming, RECLAIM_WAIT_MS + 2_000);
  }

  /** Persist, announce and start the background loop for a freshly built job. */
  private launch(job: Job, message: string, rawNeeds: Record<string, number>, body: (j: Job, c: AbortController) => Promise<void>): AchieveResult {
    // Scaffold blocks an earlier job left standing stay on the books (the next build removes them).
    if (!job.scaffolds && this.job?.scaffolds?.length) job.scaffolds = this.job.scaffolds.map((c) => ({ ...c }));
    this.job = job;
    this.persist(job);
    this.reservePlan(job.plan);
    this.deps.record({ kind: "job_start", jobId: job.id, goals: job.kind === "build" ? [{ item: `build:${job.build!.blueprint}`, count: 1 }, ...job.goals] : job.kind === "follow" ? [{ item: `follow:${job.follow!.player}`, count: 1 }] : job.goals, steps: job.plan.steps.length + (job.kind === "build" ? 1 : 0) });
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
    const step = job.plan.steps[Math.min(job.stepIndex, job.plan.steps.length - 1)] ?? PHASE_STEP; // builds / night holds with no material steps have none
    const what = job.kind === "follow" ? `following ${job.follow?.player ?? "the player"}` : describeStep(step);
    const failure: StepFailure =
      reason === "death"
        ? { kind: "died", step, detail: `the bot died during "${what}" (its items dropped where it died)`, attempts: 1 }
        : { kind: "timeout", step, detail: `a skill hit the watchdog during "${what}" and the job was stopped`, attempts: 1 };
    job.progress = `failed: ${failure.kind}`;
    this.finish(job, "failed", failure);
    this.ctrl?.abort();
    this.stopInternal();
  }

  /** Shutdown / reconnect: end the running job as interrupted. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.reclaimCtrl?.abort();
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

  /** Reserve the plan's inputs plus (build jobs) everything the build itself consumes or needs in hand. */
  private reservePlan(plan: Plan): void {
    this.setReservations({ ...planReservations(plan), ...this.buildReserve });
  }

  private setBuildReserve(items: readonly string[] | undefined, plan: Plan): void {
    this.buildReserve = Object.fromEntries((items ?? []).map((i) => [i, Number.POSITIVE_INFINITY]));
    this.reservePlan(plan);
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
    this.buildReserve = {};
    this.setReservations(null);
    job.endedAt = this.now();
    job.failure = status === "failed" ? failure : null;
    if (status === "done") job.progress = `done: ${jobLabel(job)}`;
    if (status === "failed" && failure) job.progress = `failed: ${failure.kind} — ${failure.detail}`;
    this.persist(job);
    this.recordEnd(job);
    if (job.kind === "build") this.noteBuildEnd(job);
    // A disposed runner (reconnect / shutdown) belongs to a dead bot or agent: no event.
    if ((status === "done" || status === "failed") && !this.disposed) {
      try {
        this.deps.onEnd?.(job);
      } catch (err) {
        console.warn(`[${this.deps.username}] job onEnd failed:`, err);
      }
    }
  }

  private noteBuildEnd(job: Job): void {
    try {
      this.deps.onBuildEnd?.(job);
    } catch (err) {
      console.warn(`[${this.deps.username}] job onBuildEnd failed:`, err);
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
    const deadline = job.startedAt + JOB_MAX_MS; // one cap for the whole job, also across a build's phases
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

      const res = await this.runStep(job, step, { signal: ctrl.signal, radius, baseline: ep.baseline, jobId: job.id, exclude: excludeFor(job.exhausted) });
      if (!live()) return "ended";
      if (res.ok) {
        job.stepIndex += 1;
        episodes.delete(key);
        this.persist(job);
        continue;
      }

      const failure: JobStepFailure = { ...res.failure, attempts: ep.fails + 1 };
      const rung = decideRecovery(failure, step, ep, MAX_REPLANS - job.replans, this.deps.relocate ? MAX_RELOCATIONS - (job.relocations ?? 0) : 0);
      if (rung.rung !== "relocate") {
        // The positions stay remembered either way; the species is avoided only once relocating is out of the question.
        if (failure.positions?.length) {
          job.exhausted ??= emptyExhausted();
          for (const k of failure.positions) if (!job.exhausted.positions.includes(k)) job.exhausted.positions.push(k);
        }
        for (const b of failure.avoid ?? []) {
          if (!avoid.has(b)) console.log(`[${this.deps.username}] job avoid: ${b} (unreachable); re-plans will prefer another source`);
          avoid.add(b);
        }
      }
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
        case "relocate": {
          if (step.op !== "gather") break;
          const here = this.deps.position?.() ?? { x: 0, y: 64, z: 0 };
          job.relocations = (job.relocations ?? 0) + 1;
          job.exhausted ??= emptyExhausted();
          const region = noteExhausted(job.exhausted, failure.positions ?? [], here);
          this.persist(job);
          console.log(`[${this.deps.username}] job area exhausted: ${failure.positions?.length ?? 0} unreachable ${step.item} source blocks around (${region.x}, ${region.y}, ${region.z}) r=${region.r}`);
          this.setProgress(job, `step ${job.stepIndex + 1}/${job.plan.steps.length}: ${describeStep(step)} (moving to another area)`);
          const rctx: StepRunContext = { signal: ctrl.signal, radius, baseline: ep.baseline, jobId: job.id, exclude: excludeFor(job.exhausted) };
          let out: RelocateOutcome;
          try {
            out = (await this.deps.relocate?.(step, rctx, job.exhausted.regions)) ?? { moved: false, detail: "relocation isn't available" };
          } catch (err) {
            out = { moved: false, detail: `relocate crashed: ${err instanceof Error ? err.message : String(err)}` };
          }
          if (!live()) return "ended";
          this.deps.record({ kind: "recovery", jobId: job.id, rung: "relocate", detail: `${out.moved ? "moved" : "stayed"}: ${out.detail}`.slice(0, 200) });
          episodes.delete(key); // a fresh area is a fresh episode (scan radius, retries)
          scanRadius = SCAN_RADII[0];
          if (!out.moved) break;
          // rescan from the new spot: the plan may now find the ore in view (or fall back to deep variants / shafts on its own)
          if (job.replans < MAX_REPLANS) {
            const verdict = await this.replan(job, scanRadius, "relocated: rescan", avoid);
            if (verdict === "continue") for (const e of episodes.values()) e.baseline = null;
            if (verdict === "done") return "met";
            if (verdict === "failed") return "ended";
          }
          break;
        }
        case "explore": {
          if (step.op !== "gather") break;
          this.setProgress(job, `step ${job.stepIndex + 1}/${job.plan.steps.length}: exploring for ${step.item} (${step.searchHint?.kind ?? "surface"})`);
          let out: ExploreOutcome;
          try {
            out = await this.deps.explore(step, { signal: ctrl.signal, radius, baseline: ep.baseline, jobId: job.id, exclude: excludeFor(job.exhausted) });
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
      view = await this.deps.buildView(job.goals, radius, excludeFor(job.exhausted));
      if (avoid.size > 0) view = { ...view, avoidBlocks: [...avoid] };
    } catch (err) {
      this.finish(job, "failed", this.driftFailure(job, `could not rebuild the world view: ${err instanceof Error ? err.message : String(err)}`, "internal"));
      return "failed";
    }
    if (job.status !== "running") return "failed";
    const plan: Plan = this.deps.plan(job.generic ?? job.goals, view);
    if (job.generic && plan.goals.length > 0) job.goals = plan.goals; // latest concrete resolution (a hand-over delivers this)
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
    this.reservePlan(plan);
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
      job.handoverFailed = true;
      this.finish(job, "failed", { ...res.failure, step: res.failure.step });
    }
    return false;
  }

  /** Follow job body: the bot-bound runner does the work; this maps how it ended onto the job status. */
  private async runFollowJob(job: Job, ctrl: AbortController): Promise<void> {
    const follow = this.deps.follow;
    const spec = job.follow!;
    if (!follow) {
      this.finish(job, "failed", { kind: "internal", step: PHASE_STEP, detail: "following isn't available", attempts: 1 });
      return;
    }
    const out = await follow.run(spec, {
      signal: ctrl.signal,
      jobId: job.id,
      deadline: job.startedAt + FOLLOW_MAX_MS,
      record: (e) => this.deps.record(e),
      progress: (text) => this.setProgress(job, text),
    });
    // Stopped by the player, replaced, or interrupted: the job already ended quietly (no event).
    if (job.status !== "running" || ctrl.signal.aborted) return;
    if (out.ok) this.finish(job, "done", null);
    else this.finish(job, "failed", { kind: out.kind, step: PHASE_STEP, detail: out.detail, attempts: 1 });
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
    const deadline = job.startedAt + JOB_MAX_MS;
    if (state.holdMode === "sleep" || state.holdMode === "pocket") {
      await this.runNightHold(job, ctrl);
      return;
    }
    if (job.plan.steps.length > 0) {
      if ((await this.runGoals(job, ctrl)) === "ended") return;
    }
    if (!live()) return;
    state.phase = "building";
    this.setProgress(job, `building ${state.summary}`);
    let last: BuildOutcome | null = null;
    // The gather phase may have dug into the planned footprint: re-pick the site once, as long as nothing is built yet.
    // A resumed build keeps its stored origin: that is the structure it continues.
    let resite = job.plan.steps.length > 0 && !state.resumed;
    for (let attempt = 1; attempt <= BUILD_MAX_ATTEMPTS && live(); attempt++) {
      // Retries must fit inside the job's time cap (M7): a shorter last attempt, or none.
      const budget = Math.min(BUILD_TIMEOUT_MS, deadline - this.now() - BUILDER_WIND_DOWN_MS);
      if (budget < MIN_BUILD_ATTEMPT_MS) {
        this.finish(job, "failed", {
          kind: "timeout",
          step: PHASE_STEP,
          detail: `no time left for another build attempt within the ${JOB_MAX_MS / 60_000}-minute job cap${last && !last.ok ? ` (last: ${last.detail}, placed ${last.placed}/${last.total})` : ""}${this.leftoverNote(job)}`,
          attempts: attempt - 1 || 1,
        });
        return;
      }
      const reuse = !resite && state.origin && state.facing ? { origin: state.origin, facing: state.facing } : null;
      resite = false;
      const prep = await builder.prepare(state, reuse, job.scaffolds);
      if (!live()) return;
      if (!prep.ok) {
        this.finish(job, "failed", { kind: prep.kind, step: PHASE_STEP, detail: prep.detail + this.leftoverNote(job), attempts: attempt });
        return;
      }
      state.origin = prep.origin;
      state.facing = prep.facing;
      state.params = prep.params;
      if (!state.resumed) state.summary = prep.summary; // a re-sited build must not keep reporting the old location
      state.total = prep.total;
      this.buildReserve = Object.fromEntries((prep.reserve ?? []).map((i) => [i, Number.POSITIVE_INFINITY]));
      this.reservePlan(job.plan);
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
        this.setBuildReserve(prep.reserve, plan);
        if ((await this.runGoals(job, ctrl)) === "ended") return;
        state.phase = "building";
        resite = state.placed === 0 && !state.resumed;
        continue; // re-prepare with the new inventory
      }
      const t0 = this.now();
      // One Builder at a time (M7): each attempt has its own abort signal, tripped when the attempt is abandoned.
      const attemptCtrl = new AbortController();
      const onJobAbort = (): void => attemptCtrl.abort();
      ctrl.signal.addEventListener("abort", onJobAbort);
      const bctx: BuildRunContext = {
        signal: attemptCtrl.signal,
        radius: SCAN_RADII[0],
        baseline: 0,
        jobId: job.id,
        record: (e) => this.deps.record(e),
        progress: (text, placed) => {
          state.placed = placed;
          this.setProgress(job, text);
        },
        scaffolds: (job.scaffolds ?? []).map((c) => ({ ...c })),
        setScaffolds: (list) => {
          job.scaffolds = list.length > 0 ? list.map((c) => ({ ...c })) : undefined;
          this.persist(job);
        },
      };
      let outcome: BuildOutcome | null = null;
      let builderRun: Promise<unknown> = Promise.resolve();
      let builderSettled = false;
      const res = await this.timed(PHASE_STEP, `building the ${state.blueprint}`, budget, async () => {
        builderRun = builder.run(prep, bctx).then(
          (o) => {
            outcome = o;
            builderSettled = true;
          },
          (err) => {
            builderSettled = true;
            throw err;
          },
        );
        await builderRun;
        builderSettled = true;
        const o = outcome as BuildOutcome | null;
        if (!o) return { ok: false, failure: { kind: "internal", step: PHASE_STEP, detail: "build did not run", attempts: attempt } };
        return o.ok
          ? { ok: true, detail: o.detail }
          : { ok: false, failure: { kind: o.kind, step: PHASE_STEP, detail: o.detail, attempts: attempt } };
      });
      ctrl.signal.removeEventListener("abort", onJobAbort);
      if (!builderSettled) {
        // The step was abandoned while the Builder is still going: stop it (it strips its scaffolds on the way out) and wait.
        attemptCtrl.abort();
        await waitUpTo(builderRun.catch(() => undefined), BUILDER_WIND_DOWN_MS);
        if (!builderSettled && job.status === "running") {
          this.finish(job, "failed", { kind: "timeout", step: PHASE_STEP, detail: `the builder did not stop after its time limit; not starting a second one${this.leftoverNote(job)}`, attempts: attempt });
          return;
        }
      }
      const out = outcome as BuildOutcome | null;
      if (out) {
        state.placed = out.placed;
        state.total = out.total;
        // A stop/cancel ended the job before the final block count was known: update what the ledger remembers.
        if (job.status !== "running") this.noteBuildEnd(job);
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
        if (state.hold === "night") {
          await this.runNightHold(job, ctrl);
          return;
        }
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
      detail: (f ? `${f.detail} (placed ${f.placed}/${f.total})` : "build did not complete") + this.leftoverNote(job),
      attempts: BUILD_MAX_ATTEMPTS,
    });
  }

  /**
   * Night hold phase: sleep in the bed, or (after the shelter is built) go in, close up and wait for dawn.
   * Ends the job: done with a one-line account of the night, or failed with why.
   */
  private async runNightHold(job: Job, ctrl: AbortController): Promise<void> {
    const state = job.build!;
    const night = this.deps.night;
    const live = (): boolean => job.status === "running" && !ctrl.signal.aborted;
    if (!night) {
      this.finish(job, "failed", { kind: "internal", step: PHASE_STEP, detail: "night survival isn't available", attempts: 1 });
      return;
    }
    const mode = state.holdMode ?? "shelter";
    state.phase = "holding";
    this.buildReserve = {}; // the shelter is done; whatever is left is free to use
    this.setProgress(job, mode === "sleep" ? "sleeping until morning" : mode === "pocket" ? "digging in for the night" : "inside the shelter, waiting for dawn");
    const ctx: StepRunContext = { signal: ctrl.signal, radius: SCAN_RADII[0], baseline: 0, jobId: job.id };
    let exec: () => Promise<StepResult>;
    if (mode === "sleep") exec = () => night.sleepThrough(ctx);
    else if (mode === "pocket") {
      const plan = state.pocket;
      if (!plan || !night.digInThrough) {
        this.finish(job, "failed", { kind: "internal", step: PHASE_STEP, detail: "dig-in plan missing", attempts: 1 });
        return;
      }
      exec = () => night.digInThrough!(plan, ctx);
    } else {
      if (!state.origin || !state.facing) {
        this.finish(job, "failed", { kind: "internal", step: PHASE_STEP, detail: "shelter position unknown", attempts: 1 });
        return;
      }
      const geo = shelterGeometry(state.origin, state.facing, state.params.door === true, typeof state.params.wall === "string" ? state.params.wall : "dirt");
      exec = () => night.holdInShelter(geo, ctx);
    }
    const t0 = this.now();
    const res = await this.timed(PHASE_STEP, "waiting out the night", NIGHT_HOLD_TIMEOUT_MS, exec);
    this.deps.record({
      kind: "step",
      jobId: job.id,
      op: "hold",
      item: mode,
      ok: res.ok,
      durationMs: this.now() - t0,
      failureKind: res.ok ? null : res.failure.kind,
    });
    if (!live()) return;
    if (res.ok) {
      state.holdDetail = res.detail;
      this.finish(job, "done", null);
      return;
    }
    if (res.failure.kind === "cancelled") {
      job.progress = "cancelled during the night";
      this.finish(job, "cancelled", null);
      return;
    }
    this.finish(job, "failed", { ...res.failure, step: PHASE_STEP });
  }

  /** " (left 2 dirt at (1,64,2), ...)" when scaffold blocks are still standing, else "". */
  private leftoverNote(job: Job): string {
    const left = job.scaffolds ?? [];
    if (left.length === 0) return "";
    const byItem = new Map<string, ScaffoldCell[]>();
    for (const c of left) byItem.set(c.item, [...(byItem.get(c.item) ?? []), c]);
    const parts = [...byItem.entries()].map(([item, cs]) => `${cs.length} ${item} at ${cs.slice(0, 3).map((c) => `(${c.x}, ${c.y}, ${c.z})`).join(", ")}${cs.length > 3 ? ", ..." : ""}`);
    return ` (left ${parts.join("; ")}; will be removed on the next build)`;
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
