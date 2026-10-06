/**
 * Automatic performance flags. Every threshold is a named constant so tuning
 * is a one-line change. `computeFlags` works from the aggregate alone (what
 * the dashboard has); the report CLI also passes per-task rows and clustered
 * problem spots from the raw events for sharper messages.
 */

import { MAX_TURNS_PER_EVENT } from "../agent/limits.js";
import type { TelemetryAggregate } from "../observability/telemetry-types.js";
import type { ProblemCluster, TaskRow } from "./tasks.js";

// ── Thresholds ──────────────────────────────────────────────────────────────
/** Below this, cache reads aren't covering the prompt prefix. */
export const CACHE_HIT_MIN = 0.5;
/** Median time to the first in-game reply before per_task startup cost is too visible. */
export const FIRST_REPLY_P50_MAX_MS = 5_000;
/** Tail first-reply latency players will notice. */
export const FIRST_REPLY_P95_MAX_MS = 12_000;
/** The enforced per-task turn cap (single source of truth in src/agent/limits.ts). */
export const TURN_CAP = MAX_TURNS_PER_EVENT;
/** A task at or above this many turns is "near the cap". */
export const NEAR_CAP_TURNS = Math.floor(TURN_CAP * 0.9);
/** Skill success-rate floor, applied only to skills with enough calls to judge. */
export const SKILL_SUCCESS_MIN = 0.6;
export const SKILL_MIN_CALLS = 5;
/** Context-build p95 that eats noticeably into first-reply latency. */
export const CONTEXT_BUILD_P95_MAX_MS = 2_000;
/** Same-spot nav failures: radius (blocks) and count that make it "repeated". */
export const STUCK_RADIUS_BLOCKS = 3;
export const STUCK_REPEAT_MIN = 2;
/** Guard refusals per task above which the model is looping on failed calls. */
export const GUARD_REFUSALS_PER_TASK_MAX = 0.3;
/** Queue-wait p95 — chat sitting behind a running task. */
export const QUEUE_WAIT_P95_MAX_MS = 5_000;
/** Share of tasks that ended without the bot ever speaking. */
export const SILENT_TASK_FRACTION_MAX = 0.2;
/** Event-loop lag that delays reflexes and pathfinder ticks. */
export const LOOP_LAG_MAX_MS = 1_000;
/** Mean cost per task worth a look on Haiku. */
export const COST_PER_TASK_MAX_USD = 0.05;
/** Don't judge rates on tiny samples. */
export const MIN_TASKS_FOR_RATES = 3;

export type FlagLevel = "warn" | "info";

export interface Flag {
  level: FlagLevel;
  code: string;
  message: string;
}

export interface FlagExtras {
  tasks?: TaskRow[];
  clusters?: ProblemCluster[];
}

export function computeFlags(agg: TelemetryAggregate, extras: FlagExtras = {}): Flag[] {
  const flags: Flag[] = [];
  const add = (level: FlagLevel, code: string, message: string): void => {
    flags.push({ level, code, message });
  };
  const t = agg.tasks;
  const enough = t.count >= MIN_TASKS_FOR_RATES;

  // ── Prompt caching ────────────────────────────────────────────────────
  if (enough && t.cacheHitRate !== null && t.cacheHitRate < CACHE_HIT_MIN) {
    add("warn", "cache_hit_low",
      `cache hit ${pct(t.cacheHitRate)} < ${pct(CACHE_HIT_MIN)} — prompt prefix may not be stable (system prompt / tool list / context block ordering changing between tasks?)`);
  }

  // ── Latency ───────────────────────────────────────────────────────────
  const fr = t.firstReplyMs;
  if (fr.p50 !== null && fr.p50 > FIRST_REPLY_P50_MAX_MS) {
    add("warn", "first_reply_slow",
      `p50 first reply ${sec(fr.p50)} > ${sec(FIRST_REPLY_P50_MAX_MS)} — per_task session startup is costing latency; consider session_mode: persistent`);
  } else if (fr.p95 !== null && fr.p95 > FIRST_REPLY_P95_MAX_MS) {
    add("info", "first_reply_tail",
      `p95 first reply ${sec(fr.p95)} > ${sec(FIRST_REPLY_P95_MAX_MS)} — some requests feel unresponsive`);
  }
  const replied = fr.count;
  const stopped = t.byOutcome.stopped ?? 0;
  const judged = t.count - stopped;
  if (enough && judged > 0 && (judged - replied) / judged > SILENT_TASK_FRACTION_MAX) {
    add("info", "silent_tasks",
      `${judged - replied}/${judged} non-stopped tasks never said anything — players get no acknowledgement`);
  }
  if (t.queueWaitMs.p95 !== null && t.queueWaitMs.p95 > QUEUE_WAIT_P95_MAX_MS) {
    add("info", "queue_wait",
      `p95 queue wait ${sec(t.queueWaitMs.p95)} — chat is waiting behind running tasks`);
  }

  // ── Turn budget ───────────────────────────────────────────────────────
  const maxTurns = t.byOutcome.max_turns ?? 0;
  if (maxTurns > 0) {
    add("warn", "max_turns_hit", `${maxTurns} task(s) hit the ${TURN_CAP}-turn cap`);
  }
  if (extras.tasks) {
    const near = extras.tasks.filter((r) => r.turns !== null && r.turns >= NEAR_CAP_TURNS && r.outcome !== "max_turns");
    if (near.length > 0) {
      const list = near.slice(0, 3).map((r) => `"${trunc(r.request, 30)}" (${r.turns}t)`).join(", ");
      add("warn", "near_turn_cap", `${near.length} task(s) used ≥${NEAR_CAP_TURNS}/${TURN_CAP} turns: ${list}`);
    }
  } else if (maxTurns === 0 && t.turns.max !== null && t.turns.max >= NEAR_CAP_TURNS) {
    add("warn", "near_turn_cap", `a task used ${t.turns.max}/${TURN_CAP} turns`);
  }

  // ── Context build ─────────────────────────────────────────────────────
  if (t.contextTimeouts > 0) {
    add("warn", "context_timeouts",
      `${t.contextTimeouts} context build(s) timed out — those tasks ran without world/conversation context`);
  }
  if (t.contextBuildMs.p95 !== null && t.contextBuildMs.p95 > CONTEXT_BUILD_P95_MAX_MS) {
    add("info", "context_slow", `context build p95 ${sec(t.contextBuildMs.p95)} adds directly to first-reply latency`);
  }

  // ── Model behaviour ───────────────────────────────────────────────────
  if (enough && t.guardRefusals / t.count > GUARD_REFUSALS_PER_TASK_MAX) {
    add("warn", "guard_refusals",
      `${t.guardRefusals} guard refusals over ${t.count} tasks — model keeps retrying identical failing calls`);
  }
  const failed = (t.byOutcome.failed ?? 0) + (t.byOutcome.rate_limited ?? 0);
  if (failed > 0) {
    add("warn", "task_errors",
      `${t.byOutcome.failed ?? 0} failed + ${t.byOutcome.rate_limited ?? 0} rate-limited task(s)`);
  }
  if (enough && t.costUsd !== null && t.costUsd / t.count > COST_PER_TASK_MAX_USD) {
    add("info", "cost_per_task", `$${(t.costUsd / t.count).toFixed(3)}/task > $${COST_PER_TASK_MAX_USD}`);
  }

  // ── Skills ────────────────────────────────────────────────────────────
  const weak = agg.skills
    .filter((s) => s.calls >= SKILL_MIN_CALLS && s.successRate !== null && s.successRate < SKILL_SUCCESS_MIN)
    .sort((a, b) => (a.successRate ?? 0) - (b.successRate ?? 0));
  for (const s of weak) {
    const top = s.topFailures[0];
    add("warn", "skill_unreliable",
      `${s.skill}: ${pct(s.successRate!)} success over ${s.calls} calls${top ? ` — mostly "${trunc(top.message, 50)}" ×${top.count}` : ""}`);
  }
  const timedOut = agg.skills.reduce((n, s) => n + s.timedOut, 0);
  if (timedOut > 0) {
    const which = agg.skills.filter((s) => s.timedOut > 0).map((s) => `${s.skill}×${s.timedOut}`).join(", ");
    add("warn", "skill_watchdog", `${timedOut} skill call(s) hit the harness watchdog: ${which}`);
  }

  // ── Movement ──────────────────────────────────────────────────────────
  const clusters = extras.clusters ?? clusterFromAggregate(agg);
  for (const c of clusters.filter((c) => c.count >= STUCK_REPEAT_MIN).slice(0, 3)) {
    const kinds = Object.entries(c.results).map(([k, n]) => `${k}×${n}`).join(" ");
    add("warn", "repeat_stuck",
      `${c.count} nav failures near ${fmtVec(c.center)} (${kinds}; ${c.labels.slice(0, 3).join(", ")}) — likely terrain/door trap there`);
  }

  // ── Health ────────────────────────────────────────────────────────────
  if (agg.deaths > 0) add("info", "deaths", `${agg.deaths} death(s)`);
  if (agg.health.disconnects > 0) add("warn", "disconnects", `${agg.health.disconnects} disconnect(s)`);
  if (agg.health.maxLoopLagMs !== null && agg.health.maxLoopLagMs > LOOP_LAG_MAX_MS) {
    add("info", "loop_lag", `max event-loop lag ${sec(agg.health.maxLoopLagMs)} — reflexes/pathfinding stall during spikes`);
  }
  if (agg.health.rateLimitEvents > 0) add("info", "rate_limit", `${agg.health.rateLimitEvents} rate-limit event(s)`);

  return flags.sort((a, b) => (a.level === b.level ? 0 : a.level === "warn" ? -1 : 1));
}

/** Fallback clustering over the aggregate's (short) problemSpots list. */
function clusterFromAggregate(agg: TelemetryAggregate): ProblemCluster[] {
  const clusters: ProblemCluster[] = [];
  for (const p of agg.nav.problemSpots ?? []) {
    const hit = clusters.find((c) => Math.hypot(c.center.x - p.from.x, c.center.y - p.from.y, c.center.z - p.from.z) <= STUCK_RADIUS_BLOCKS);
    if (hit) {
      hit.count++;
      hit.results[p.result] = (hit.results[p.result] ?? 0) + 1;
      if (!hit.labels.includes(p.label)) hit.labels.push(p.label);
    } else {
      clusters.push({ center: { ...p.from }, count: 1, results: { [p.result]: 1 }, labels: [p.label], lastAt: p.at });
    }
  }
  return clusters.sort((a, b) => b.count - a.count);
}

function pct(r: number): string {
  return `${Math.round(r * 100)}%`;
}
function sec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
function fmtVec(v: { x: number; y: number; z: number }): string {
  return `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;
}
