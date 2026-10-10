/**
 * `aggregate(events, windowStart, windowEnd)` — pure reduction of telemetry
 * events into a `TelemetryAggregate`. No I/O and no bot / orchestrator
 * imports: the report CLI runs it standalone over events read from disk, and
 * the snapshot runs it over the in-memory ring.
 *
 * The window is inclusive on both ends (`windowStart <= at <= windowEnd`).
 * Percentiles are nearest-rank. Note: cancelled skill calls count as
 * `failed` too when `ok` is false; they're excluded from `successRate`'s
 * denominator and from `topFailures`.
 */

import type {
  Percentiles,
  ReflexName,
  SkillStats,
  TaskOutcome,
  TelemetryAggregate,
  TelemetryEvent,
  Vec,
} from "./telemetry-types.js";

const TOP_FAILURES = 3;
const PROBLEM_SPOTS = 5;
const PROBLEM_RESULTS = new Set(["stuck", "timeout", "no_path"]);

/** Nearest-rank percentile over an ascending-sorted array. */
function nearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function percentiles(values: number[]): Percentiles {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    max: sorted.length > 0 ? sorted[sorted.length - 1]! : null,
  };
}

/**
 * Collapse failure messages that differ only in coordinates / counts, so
 * "stopped 3.2 blocks from (10, 64, -5)" and "... 1.1 blocks from (11, 63, 2)"
 * group together.
 */
export function normalizeFailure(message: string): string {
  return message
    .replace(/\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/g, "(<pos>)")
    .replace(/-?\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

type Of<K extends TelemetryEvent["kind"]> = Extract<TelemetryEvent, { kind: K }>;

export function aggregate(
  events: readonly TelemetryEvent[],
  windowStart: number,
  windowEnd: number,
): TelemetryAggregate {
  const inWindow = events.filter((e) => e.at >= windowStart && e.at <= windowEnd);

  // ── tasks ────────────────────────────────────────────────────────────────
  const byOutcome: Record<TaskOutcome, number> = {
    finished: 0,
    stopped: 0,
    max_turns: 0,
    failed: 0,
    rate_limited: 0,
  };
  const turns: number[] = [];
  const taskDur: number[] = [];
  const firstReply: number[] = [];
  const queueWait: number[] = [];
  const ctxBuild: number[] = [];
  let contextTimeouts = 0;
  let taskCount = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let cost = 0;
  let sawCost = false;
  let guardRefusals = 0;

  // ── skills ───────────────────────────────────────────────────────────────
  const skillMap = new Map<
    string,
    { calls: number; ok: number; failed: number; cancelled: number; timedOut: number; dur: number[]; fails: Map<string, number> }
  >();

  // ── nav / misc ───────────────────────────────────────────────────────────
  const navByResult: Record<string, number> = {};
  const navDur: number[] = [];
  let navCount = 0;
  const problemSpots: Array<{ at: number; label: string; result: string; from: Vec }> = [];
  const doors = { opened: 0, closed: 0 };
  const pillar = { runs: 0, ok: 0, placed: 0 };
  let structureSkips = 0;
  const reflexes: Record<ReflexName, number> = { look: 0, eat: 0, armor: 0, defend: 0, surface: 0 };
  let deaths = 0;
  const chat = { inbound: 0, routed: 0, outbound: 0, stops: 0 };
  const health = { disconnects: 0, maxLoopLagMs: null as number | null, rateLimitEvents: 0 };

  for (const e of inWindow) {
    switch (e.kind) {
      case "task_start": {
        const ev = e as Of<"task_start">;
        if (Number.isFinite(ev.queueWaitMs)) queueWait.push(ev.queueWaitMs);
        if (ev.contextBuildMs !== null) ctxBuild.push(ev.contextBuildMs);
        else if (ev.contextInjected !== false) contextTimeouts += 1;
        break;
      }
      case "task_end": {
        const ev = e as Of<"task_end">;
        taskCount += 1;
        if (ev.outcome in byOutcome) byOutcome[ev.outcome] += 1;
        turns.push(ev.turns);
        taskDur.push(ev.durationMs);
        if (ev.firstReplyMs !== null) firstReply.push(ev.firstReplyMs);
        tokens.input += ev.inputTokens || 0;
        tokens.output += ev.outputTokens || 0;
        tokens.cacheRead += ev.cacheReadTokens || 0;
        tokens.cacheCreate += ev.cacheCreateTokens || 0;
        if (ev.costUsd !== null && Number.isFinite(ev.costUsd)) {
          cost += ev.costUsd;
          sawCost = true;
        }
        break;
      }
      case "guard_refusal":
        guardRefusals += 1;
        break;
      case "skill": {
        const ev = e as Of<"skill">;
        let s = skillMap.get(ev.skill);
        if (!s) {
          s = { calls: 0, ok: 0, failed: 0, cancelled: 0, timedOut: 0, dur: [], fails: new Map() };
          skillMap.set(ev.skill, s);
        }
        s.calls += 1;
        s.dur.push(ev.durationMs);
        if (ev.cancelled) s.cancelled += 1;
        if (ev.timedOut) s.timedOut += 1;
        if (ev.ok) {
          s.ok += 1;
        } else {
          s.failed += 1;
          if (!ev.cancelled) {
            const key = normalizeFailure(ev.message ?? "");
            s.fails.set(key, (s.fails.get(key) ?? 0) + 1);
          }
        }
        break;
      }
      case "nav": {
        const ev = e as Of<"nav">;
        navCount += 1;
        navByResult[ev.result] = (navByResult[ev.result] ?? 0) + 1;
        navDur.push(ev.durationMs);
        if (PROBLEM_RESULTS.has(ev.result)) {
          problemSpots.push({ at: ev.at, label: ev.label, result: ev.result, from: ev.from });
        }
        break;
      }
      case "door":
        if ((e as Of<"door">).action === "open") doors.opened += 1;
        else doors.closed += 1;
        break;
      case "pillar": {
        const ev = e as Of<"pillar">;
        pillar.runs += 1;
        if (ev.ok) pillar.ok += 1;
        pillar.placed += ev.placed;
        break;
      }
      case "structure_skip":
        structureSkips += (e as Of<"structure_skip">).skipped;
        break;
      case "reflex": {
        const r = (e as Of<"reflex">).reflex;
        if (r in reflexes) reflexes[r] += 1;
        break;
      }
      case "death":
        deaths += 1;
        break;
      case "chat_in": {
        const ev = e as Of<"chat_in">;
        chat.inbound += 1;
        if (ev.routed) chat.routed += 1;
        if (ev.isStop) chat.stops += 1;
        break;
      }
      case "chat_out":
        chat.outbound += 1;
        break;
      case "connection":
        if ((e as Of<"connection">).state === "disconnected") health.disconnects += 1;
        break;
      case "loop_lag": {
        const lag = (e as Of<"loop_lag">).lagMs;
        if (health.maxLoopLagMs === null || lag > health.maxLoopLagMs) health.maxLoopLagMs = lag;
        break;
      }
      case "rate_limit":
        health.rateLimitEvents += 1;
        break;
      default:
        break;
    }
  }

  const cacheDenom = tokens.cacheRead + tokens.cacheCreate + tokens.input;
  const skills: SkillStats[] = [...skillMap.entries()]
    .map(([skill, s]) => {
      const denom = s.calls - s.cancelled;
      return {
        skill,
        calls: s.calls,
        ok: s.ok,
        failed: s.failed,
        cancelled: s.cancelled,
        timedOut: s.timedOut,
        successRate: denom > 0 ? s.ok / denom : null,
        durationMs: percentiles(s.dur),
        topFailures: [...s.fails.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, TOP_FAILURES)
          .map(([message, count]) => ({ message, count })),
      };
    })
    .sort((a, b) => b.calls - a.calls || a.skill.localeCompare(b.skill));

  return {
    windowStart,
    windowEnd,
    tasks: {
      count: taskCount,
      byOutcome,
      turns: percentiles(turns),
      durationMs: percentiles(taskDur),
      firstReplyMs: percentiles(firstReply),
      queueWaitMs: percentiles(queueWait),
      contextBuildMs: percentiles(ctxBuild),
      contextTimeouts,
      cacheHitRate: cacheDenom > 0 ? tokens.cacheRead / cacheDenom : null,
      tokens,
      costUsd: sawCost ? cost : null,
      guardRefusals,
    },
    skills,
    nav: {
      count: navCount,
      byResult: navByResult,
      durationMs: percentiles(navDur),
      problemSpots: problemSpots.sort((a, b) => b.at - a.at).slice(0, PROBLEM_SPOTS),
    },
    doors,
    pillar,
    structureSkips,
    reflexes,
    deaths,
    chat,
    health,
  };
}
