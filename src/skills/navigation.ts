/**
 * `navigate` — the one way skills should drive `pathfinder.goto`.
 *
 * Bare `pathfinder.goto(goal)` has three failure modes that bit us:
 *  - **It can resolve without arriving.** goto.js resolves on *any*
 *    `path_update` with an empty path — including a mid-trip recompute that
 *    finds nothing. Callers then report "arrived" from the wrong place.
 *  - **It can run forever.** Pathfinder's own stuck check just re-plans; a
 *    bot wedged on a fence corner or bobbing in water re-plans indefinitely
 *    and the agent loop is blocked with it.
 *  - **It ignores cancellation.** A "stop" from the player only lands if
 *    something polls the flag.
 *
 * `navigate` wraps goto with an arrival check, a progress watchdog (moved
 * < STUCK_MIN_MOVE blocks in STUCK_WINDOW_MS → stuck), a distance-scaled hard
 * timeout, and a cancellation poll. It never calls `cancellation.begin()` —
 * that's the top-level skill's job — so a stop requested during, say, one
 * placement of a `placeBlocks` batch still reaches the batch loop.
 */

import type { Bot } from "mineflayer";
import type { goals as GoalsNs } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import { recordEvent } from "../observability/telemetry.js";
import type { Vec } from "../observability/telemetry-types.js";
import { getBotState } from "../state/index.js";
import { ensureMovements, type BotWithPathfinder } from "./pathfinder-config.js";
import type { SkillResult } from "./types.js";

type Goal = InstanceType<typeof GoalsNs.Goal>;

const WATCHDOG_TICK_MS = 500;
const STUCK_WINDOW_MS = 12_000;
const STUCK_MIN_MOVE = 1.5;
const BASE_TIMEOUT_MS = 20_000;
// Walking is ~4.3 b/s; budget ~1 s per straight-line block to cover detours.
const TIMEOUT_PER_BLOCK_MS = 1_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

export interface NavigateOptions {
  /** Human/LLM-readable target name for messages, e.g. "oak_log at (1, 64, 2)". */
  label: string;
  /** Point used for timeout scaling and the "N blocks short" message. */
  target: Vec3;
  /** Override the distance-scaled hard timeout. */
  timeoutMs?: number;
}

export async function navigate(bot: Bot, goal: Goal, opts: NavigateOptions): Promise<SkillResult> {
  const t0 = Date.now();
  const from = vecOf(bot.entity?.position);
  const distance = bot.entity ? bot.entity.position.distanceTo(opts.target) : 0;
  let outcome: NavTelemetryResult = "error";
  try {
    const r = await navigateInner(bot, goal, opts, (o) => {
      outcome = o;
    });
    return r;
  } finally {
    try {
      recordEvent(bot.username, {
        kind: "nav",
        label: opts.label.slice(0, 200),
        result: outcome,
        distance: Math.round(distance * 10) / 10,
        durationMs: Date.now() - t0,
        from,
        to: vecOf(opts.target),
      });
    } catch {
      // observe-only
    }
  }
}

type NavTelemetryResult = "arrived" | "no_path" | "stuck" | "timeout" | "cancelled" | "error";

function vecOf(v: { x: number; y: number; z: number } | undefined): Vec {
  return v ? { x: Math.round(v.x * 10) / 10, y: Math.round(v.y * 10) / 10, z: Math.round(v.z * 10) / 10 } : { x: 0, y: 0, z: 0 };
}

async function navigateInner(
  bot: Bot,
  goal: Goal,
  opts: NavigateOptions,
  note: (r: NavTelemetryResult) => void,
): Promise<SkillResult> {
  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);
  const cancellation = getBotState(bot.username)?.cancellation;

  const startDist = bot.entity.position.distanceTo(opts.target);
  const timeoutMs = opts.timeoutMs
    ?? Math.min(MAX_TIMEOUT_MS, BASE_TIMEOUT_MS + startDist * TIMEOUT_PER_BLOCK_MS);
  const started = Date.now();

  let abort = null as string | null;
  let anchor = bot.entity.position.clone();
  let anchorAt = started;

  const watchdog = setInterval(() => {
    const now = Date.now();
    const pos = bot.entity.position;
    if (cancellation?.isRequested()) {
      abort = "cancelled";
    } else if (now - started > timeoutMs) {
      abort = `timed out after ${Math.round((now - started) / 1000)}s`;
    } else if (pos.distanceTo(anchor) >= STUCK_MIN_MOVE) {
      anchor = pos.clone();
      anchorAt = now;
    } else if (now - anchorAt > STUCK_WINDOW_MS && !isBusyInPlace(pBot)) {
      abort = `stuck (moved < ${STUCK_MIN_MOVE} blocks in ${STUCK_WINDOW_MS / 1000}s)`;
    }
    // setGoal(null) makes goto reject immediately (GoalChanged) and clears
    // control states — pathfinder.stop() would wait for the next node.
    if (abort) pBot.pathfinder.setGoal(null);
  }, WATCHDOG_TICK_MS);

  try {
    await pBot.pathfinder.goto(goal);
  } catch (err) {
    if (!abort) {
      const message = err instanceof Error ? err.message : String(err);
      note(/no ?path|noPath/i.test(message) ? "no_path" : "error");
      return fail(bot, opts, `pathfinding to ${opts.label} failed: ${message}`);
    }
  } finally {
    clearInterval(watchdog);
  }

  if (abort === "cancelled") {
    note("cancelled");
    return { ok: false, message: `movement to ${opts.label} cancelled`, state: { cancelled: true, ...posState(bot) } };
  }
  if (abort) {
    note(abort.startsWith("stuck") ? "stuck" : "timeout");
    return fail(bot, opts, `movement to ${opts.label} ${abort}`);
  }

  // Same arrival test pathfinder uses (floored feet, or one up for slabs).
  const here = bot.entity.position.floored();
  const isEnd = (v: Vec3) => goal.isEnd(v as unknown as Parameters<Goal["isEnd"]>[0]);
  if (!isEnd(here) && !isEnd(here.offset(0, 1, 0))) {
    // goto resolved on an empty path without arriving: pathfinder found no route.
    note("no_path");
    return fail(bot, opts, `path to ${opts.label} ended early`);
  }
  note("arrived");
  return { ok: true, message: `arrived near ${opts.label}`, state: posState(bot) };
}

/** Digging / placing for the path legitimately keeps the bot still. */
function isBusyInPlace(bot: BotWithPathfinder): boolean {
  return bot.pathfinder.isMining() || bot.pathfinder.isBuilding();
}

function fail(bot: Bot, opts: NavigateOptions, what: string): SkillResult {
  const short = bot.entity.position.distanceTo(opts.target);
  return {
    ok: false,
    message: `${what} — stopped ${short.toFixed(1)} blocks from target. If it's inside a building, look for its door; if across water/a cliff, try a different approach point.`,
    state: posState(bot),
  };
}

function posState(bot: Bot): { position: { x: number; y: number; z: number } } {
  const p = bot.entity.position;
  return { position: { x: round2(p.x), y: round2(p.y), z: round2(p.z) } };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
