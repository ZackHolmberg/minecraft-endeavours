/**
 * Per-task rows (task_start joined with task_end by taskId) and repeated
 * problem-spot clustering — the raw-event views the aggregate doesn't carry.
 * Pure functions; shared by the report CLI and its flag rules.
 */

import type { TaskOutcome, TelemetryEvent, Vec } from "../observability/telemetry-types.js";

export interface TaskRow {
  taskId: string;
  at: number;
  request: string;
  player: string | null;
  /** null while still running (no task_end yet). */
  outcome: TaskOutcome | null;
  turns: number | null;
  durationMs: number | null;
  firstReplyMs: number | null;
  queueWaitMs: number | null;
  contextBuildMs: number | null;
  cacheHitRate: number | null;
  costUsd: number | null;
  toolCalls: number | null;
  toolFailures: number | null;
}

export function buildTaskRows(events: TelemetryEvent[]): TaskRow[] {
  const rows = new Map<string, TaskRow>();
  for (const ev of events) {
    if (!ev.taskId) continue;
    if (ev.kind === "task_start") {
      rows.set(ev.taskId, {
        taskId: ev.taskId,
        at: ev.at,
        request: ev.request,
        player: ev.player,
        outcome: null,
        turns: null,
        durationMs: null,
        firstReplyMs: null,
        queueWaitMs: ev.queueWaitMs,
        contextBuildMs: ev.contextBuildMs,
        cacheHitRate: null,
        costUsd: null,
        toolCalls: null,
        toolFailures: null,
      });
    } else if (ev.kind === "task_end") {
      const row = rows.get(ev.taskId) ?? {
        taskId: ev.taskId,
        at: ev.at - ev.durationMs,
        request: "?",
        player: null,
        queueWaitMs: null,
        contextBuildMs: null,
      } as TaskRow;
      const denom = ev.cacheReadTokens + ev.cacheCreateTokens + ev.inputTokens;
      Object.assign(row, {
        outcome: ev.outcome,
        turns: ev.turns,
        durationMs: ev.durationMs,
        firstReplyMs: ev.firstReplyMs,
        cacheHitRate: denom > 0 ? ev.cacheReadTokens / denom : null,
        costUsd: ev.costUsd,
        toolCalls: ev.toolCalls,
        toolFailures: ev.toolFailures,
      });
      rows.set(ev.taskId, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.at - b.at);
}

export interface ProblemCluster {
  center: Vec;
  count: number;
  results: Record<string, number>;
  labels: string[];
  lastAt: number;
}

/** Group nav stuck/no_path/timeout events whose start points lie within `radius` blocks. */
export function clusterProblemSpots(events: TelemetryEvent[], radius: number): ProblemCluster[] {
  const clusters: ProblemCluster[] = [];
  for (const ev of events) {
    if (ev.kind !== "nav") continue;
    if (ev.result !== "stuck" && ev.result !== "no_path" && ev.result !== "timeout") continue;
    const hit = clusters.find((c) => dist(c.center, ev.from) <= radius);
    if (hit) {
      hit.count++;
      hit.results[ev.result] = (hit.results[ev.result] ?? 0) + 1;
      if (!hit.labels.includes(ev.label)) hit.labels.push(ev.label);
      hit.lastAt = Math.max(hit.lastAt, ev.at);
    } else {
      clusters.push({
        center: { ...ev.from },
        count: 1,
        results: { [ev.result]: 1 },
        labels: [ev.label],
        lastAt: ev.at,
      });
    }
  }
  return clusters.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
