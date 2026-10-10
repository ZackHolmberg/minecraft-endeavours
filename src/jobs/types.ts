/**
 * Job runner contract (v2 slice 2). Design: v2/PLANNER.md.
 *
 * One active job per bot. A job outlives the Haiku session that started it:
 * `achieve` creates it and returns; the runner executes the plan in middleware
 * and, on end, queues a synthetic event so Haiku makes the next decision.
 * Persisted to data/orchestrator/memory/<bot>/job.json (disk is the source of truth).
 */
import type { Facing, BlueprintKind } from "../build/types.js";
import type { FailureKind, Goal, Plan, Step, StepFailure, Vec3 } from "../planner/types.js";
import type { Exhausted } from "./exhausted.js";
import type { PocketPlan } from "./pocket.js";

export type JobStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

export type JobKind = "achieve" | "build";

/** What a `build` job was asked for (slice 3). `anchor` is the resolved "here" (requester, else bot). */
export interface BuildSpec {
  blueprint: BlueprintKind;
  /** Raw blueprint params from the model (normalised by the blueprint). */
  params: Record<string, unknown>;
  anchor: Vec3;
  /** Player positions the footprint must not cover. */
  avoid: Vec3[];
  /** "night": after the build, get inside, close up, light and wait for dawn (shelter blueprint; `surviveNight`). */
  hold?: "night";
}

/** A temporary support block the builder placed (and must remove again). Persisted so a crash/stop can't orphan it. */
export interface ScaffoldCell extends Vec3 {
  item: string;
}

/** Live state of a build job (persisted with the job). */
export interface BuildState extends BuildSpec {
  phase: "materials" | "building" | "holding";
  /** Chosen once at start; retries and resumes reuse them so a half-built house isn't mistaken for a player build. */
  origin: Vec3 | null;
  facing: Facing | null;
  summary: string;
  total: number;
  placed: number;
  /** True when this job continues an earlier failed/cancelled build at its stored origin (no re-siting). */
  resumed?: boolean;
  /** hold === "night": sleep in a bed that was at hand instead of building a shelter. */
  holdMode?: "sleep" | "shelter" | "pocket";
  /** holdMode === "pocket": the dig-in plan (where to dig, where to rest, what to seal). */
  pocket?: PocketPlan;
  /** How the night went (set when the hold phase ends), for the job event. */
  holdDetail?: string;
}

/** `prepare` result: the site, blueprint and materials gap, or why the build cannot start. */
export type BuildPrep =
  | {
      ok: true;
      origin: Vec3;
      facing: Facing;
      /** Params with the site-dependent choices resolved (farm water mode); the runner stores them for later attempts. */
      params: Record<string, unknown>;
      summary: string;
      /** Blocks the blueprint will have when done (for the postcondition). */
      total: number;
      /** Survival: planner goals for materials the bot lacks. Creative: always empty (getItems runs inside `run`). */
      missing: Goal[];
      /** Opaque to the runner; handed back to `run`. */
      payload: unknown;
      /** Inventory items the build consumes or needs in hand (blocks, scaffold, tools, seeds, bucket, flint): reserved for the whole job. */
      reserve?: string[];
    }
  | { ok: false; kind: FailureKind; detail: string };

export type BuildOutcome =
  | { ok: true; placed: number; total: number; detail: string }
  | { ok: false; kind: FailureKind; detail: string; placed: number; total: number };

export interface Job {
  id: string;
  kind: JobKind;
  goals: Goal[];
  /**
   * achieve: the goals as asked when any used a generic tag ("#log"). Re-plans start from these so the
   * species is re-chosen from the live world (an unreachable one is avoided); `goals` holds the latest
   * concrete resolution (what a hand-over delivers). Absent for jobs without tags.
   */
  generic?: Goal[];
  /** achieve: hand the goal items to this player when the goals are met. */
  deliverTo?: string | null;
  /** Set when kind is "build". */
  build?: BuildState;
  /** Set when the job failed at the hand-over to the player (not at gathering): not a goal-keyed failure for the ledger. */
  handoverFailed?: boolean;
  /** Scaffold blocks placed by a builder and not yet confirmed removed (survives stop/crash/restart; reclaimed by the next build or at boot). */
  scaffolds?: ScaffoldCell[];
  /** Player who asked (for the follow-up event), null if self-initiated. */
  requestedBy: string | null;
  status: JobStatus;
  startedAt: number;
  endedAt: number | null;
  /** Current plan (replaced on re-plan). */
  plan: Plan;
  /** Index into plan.steps of the step running / next to run. */
  stepIndex: number;
  replans: number;
  /** One-line live progress for the context block, e.g. "step 4/9: gather 3 iron_ore (1/3)". */
  progress: string;
  /** Set when status is failed. */
  failure: StepFailure | null;
  /** Areas where gathers already failed (unreachable ores etc.): skipped by later gathers and scans, left by `relocate`. */
  exhausted?: Exhausted;
  /** Surface relocations done this job (bounded by `MAX_RELOCATIONS`). */
  relocations?: number;
}

/** What `achieve` returns to Haiku (JSON-stringified into the tool result). */
export interface AchieveResult {
  ok: boolean;
  jobId: string | null;
  /** plan.summary, or why no job was started (e.g. all goals already satisfied, unknown item). */
  message: string;
  rawNeeds?: Record<string, number>;
  unresolved?: Plan["unresolved"];
}

/** A step failure; gathers also report which block positions they gave up on ("x,y,z"). */
export type JobStepFailure = StepFailure & { positions?: string[] };

/** Outcome of executing one step. */
export type StepResult = { ok: true; detail: string } | { ok: false; failure: JobStepFailure };

/** Executes one step against the live bot. Implementations live in src/jobs/steps/. */
export type StepExecutor = (step: Step, signal: AbortSignal) => Promise<StepResult>;
