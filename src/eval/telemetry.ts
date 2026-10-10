/** Eval-side telemetry reader: scenario window → ScenarioResult metric fields. */
import { existsSync, readFileSync } from "node:fs";
import type { TelemetryEvent, TaskOutcome } from "../observability/telemetry-types.js";
import type { ScenarioResult } from "./types.js";

export function readEvents(path: string): TelemetryEvent[] {
  if (!existsSync(path)) return [];
  const out: TelemetryEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TelemetryEvent);
    } catch {
      /* partial last line */
    }
  }
  return out;
}

export interface TaskState {
  starts: number;
  ends: number;
  /** A task_start has no matching task_end yet. */
  running: boolean;
  lastStartAt: number | null;
  lastEndAt: number | null;
}

export function taskState(events: readonly TelemetryEvent[], since = 0): TaskState {
  let starts = 0;
  let ends = 0;
  let lastStartAt: number | null = null;
  let lastEndAt: number | null = null;
  let running = false;
  const open = new Set<string>();
  for (const e of events) {
    if (e.kind === "task_start") {
      if (e.at >= since) {
        starts++;
        lastStartAt = e.at;
      }
      if (e.taskId) open.add(e.taskId);
      else running = true;
    } else if (e.kind === "task_end") {
      if (e.at >= since) {
        ends++;
        lastEndAt = e.at;
      }
      if (e.taskId) {
        open.delete(e.taskId);
      } else running = false;
    }
  }
  return { starts, ends, running: running || open.size > 0, lastStartAt, lastEndAt };
}

export interface JobState {
  /** A job_start has no matching job_end yet. */
  running: boolean;
  /** Time of the latest job_start / job_end (0 if none). */
  lastAt: number;
}

/** v2 jobs: a job runs in middleware after its Haiku task ended, so the bot is busy until job_end. v1 never emits job_*. */
export function jobState(events: readonly TelemetryEvent[]): JobState {
  const open = new Set<string>();
  let lastAt = 0;
  for (const e of events) {
    if (e.kind === "job_start") {
      open.add(e.jobId);
      lastAt = Math.max(lastAt, e.at);
    } else if (e.kind === "job_end") {
      open.delete(e.jobId);
      lastAt = Math.max(lastAt, e.at);
    }
  }
  return { running: open.size > 0, lastAt };
}

type Metrics = Pick<
  ScenarioResult,
  | "tasks"
  | "turns"
  | "toolCalls"
  | "toolFailures"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheCreateTokens"
  | "costUsd"
  | "cacheHitRate"
  | "outcomes"
> & { pillarEvents: number; deathEvents: number };

/** D12: only pillaring that is not an escape counts (events without a purpose, i.e. v1, all count). */
export function isPillarViolation(e: { purpose?: string }): boolean {
  return e.purpose !== "escape";
}

/** `since`: count deaths/pillar violations only at or after this time (ms). */
export function collectMetrics(events: readonly TelemetryEvent[], since?: number): Metrics {
  const m: Metrics = {
    tasks: 0,
    turns: 0,
    toolCalls: 0,
    toolFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0,
    cacheHitRate: null,
    outcomes: {},
    pillarEvents: 0,
    deathEvents: 0,
  };
  for (const e of events) {
    if (e.kind === "task_end") {
      m.tasks++;
      m.turns += e.turns;
      m.toolCalls += e.toolCalls;
      m.toolFailures += e.toolFailures;
      m.inputTokens += e.inputTokens;
      m.outputTokens += e.outputTokens;
      m.cacheReadTokens += e.cacheReadTokens;
      m.cacheCreateTokens += e.cacheCreateTokens;
      m.costUsd += e.costUsd ?? 0;
      const o: TaskOutcome = e.outcome;
      m.outcomes[o] = (m.outcomes[o] ?? 0) + 1;
    } else if (since !== undefined && e.at < since) continue;
    else if (e.kind === "pillar" && isPillarViolation(e)) m.pillarEvents++;
    else if (e.kind === "death") m.deathEvents++;
  }
  const denom = m.inputTokens + m.cacheReadTokens + m.cacheCreateTokens;
  m.cacheHitRate = denom > 0 ? m.cacheReadTokens / denom : null;
  return m;
}
