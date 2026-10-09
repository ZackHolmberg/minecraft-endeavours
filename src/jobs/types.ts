/**
 * Job runner contract (v2 slice 2). Design: v2/PLANNER.md.
 *
 * One active job per bot. A job outlives the Haiku session that started it:
 * `achieve` creates it and returns; the runner executes the plan in middleware
 * and, on end, queues a synthetic event so Haiku makes the next decision.
 * Persisted to data/orchestrator/memory/<bot>/job.json (disk is the source of truth).
 */
import type { Goal, Plan, Step, StepFailure } from "../planner/types.js";

export type JobStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface Job {
  id: string;
  kind: "achieve";
  goals: Goal[];
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

/** Outcome of executing one step. */
export type StepResult = { ok: true; detail: string } | { ok: false; failure: StepFailure };

/** Executes one step against the live bot. Implementations live in src/jobs/steps/. */
export type StepExecutor = (step: Step, signal: AbortSignal) => Promise<StepResult>;
