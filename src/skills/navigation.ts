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
import { Vec3 } from "vec3";
import { recordEvent } from "../observability/telemetry.js";
import type { Vec } from "../observability/telemetry-types.js";
import { getBotState } from "../state/index.js";
import { diggingDepth, ensureMovements, withDiggingMovements, type BotWithPathfinder } from "./pathfinder-config.js";
import { pickFiller, pillarUpBy } from "./pillar.js";
import type { SkillResult } from "./types.js";

type Goal = InstanceType<typeof GoalsNs.Goal>;

const WATCHDOG_TICK_MS = 500;
const STUCK_WINDOW_MS = 12_000;
const STUCK_MIN_MOVE = 1.5;
const BASE_TIMEOUT_MS = 20_000;
// Walking is ~4.3 b/s; budget ~1 s per straight-line block to cover detours.
const TIMEOUT_PER_BLOCK_MS = 1_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
export const MAX_THINK_TIMEOUT_MS = 10_000;

export interface NavigateOptions {
  /** Human/LLM-readable target name for messages, e.g. "oak_log at (1, 64, 2)". */
  label: string;
  /** Point used for timeout scaling and the "N blocks short" message. */
  target: Vec3;
  /** Override the distance-scaled hard timeout. */
  timeoutMs?: number;
  /**
   * Pathfinder A* think budget for this goto (default: pathfinder's 5000 ms). Dense
   * terrain (jungle canopy, hills) routinely exhausts 5 s ("Took to long to decide
   * path to goal!"); gather approaches ask for more. Clamped to MAX_THINK_TIMEOUT_MS
   * and restored afterwards.
   */
  thinkTimeoutMs?: number;
  /**
   * What to try (once per call) when navigation fails with no path while the
   * bot is boxed in (a pit deeper than the drop limit, a shaft it dug):
   * "full" (default) = pillar out with inventory filler, else a one-off
   * staircase dig-out under the natural-only dig Movements; "pillar" = only the
   * pillar; "none" = never (used by the escape's own re-navigation and by
   * callers that run their own dig retry).
   */
  escape?: "full" | "pillar" | "none";
}

/** Why a failed navigate failed (`state.failure` on the SkillResult). */
export type NavFailure = "no_path" | "stuck" | "timeout" | "error";

export function navFailureOf(r: SkillResult): NavFailure | null {
  const f = (r.state as { failure?: NavFailure } | undefined)?.failure;
  return f ?? null;
}

const ESCAPE_MAX_PILLAR = 6;
const BOXED_MAX_CELLS = 150;
const BOXED_MAX_RADIUS = 6;

export async function navigate(bot: Bot, goal: Goal, opts: NavigateOptions): Promise<SkillResult> {
  const r = await navigateOnce(bot, goal, opts);
  const mode = opts.escape ?? "full";
  if (r.ok || mode === "none" || navFailureOf(r) !== "no_path") return r;
  if (getBotState(bot.username)?.cancellation.isRequested()) return r;
  try {
    return (await tryEscape(bot, goal, opts, mode, r)) ?? r;
  } catch (err) {
    console.warn(`[${bot.username}] nav escape threw: ${err instanceof Error ? err.message : String(err)}`);
    return r;
  }
}

/**
 * Bounded (one attempt per navigate call) escape for a bot with no path that
 * is enclosed. Order: pillar up with filler from the inventory; else a one-off
 * dig-out toward the goal under the natural-only dig Movements. Each step
 * emits the usual `pillar` / `nav` telemetry. Returns null when not applicable.
 */
async function tryEscape(
  bot: Bot,
  goal: Goal,
  opts: NavigateOptions,
  mode: "full" | "pillar",
  failed: SkillResult,
): Promise<SkillResult | null> {
  const pBot = bot as BotWithPathfinder;
  if (!isBoxedIn(bot)) return null;
  const cancellation = getBotState(bot.username)?.cancellation;
  const sub = { ...opts, escape: "none" as const };

  if (pickFiller(bot)) {
    let climbed = 0;
    while (climbed < ESCAPE_MAX_PILLAR && isBoxedIn(bot) && !cancellation?.isRequested()) {
      const p = await pillarUpBy(bot, 1, "escape");
      if (!p.ok) break;
      climbed += 1;
    }
    if (climbed > 0 && !isBoxedIn(bot)) {
      console.log(`[${bot.username}] nav escape: pillared ${climbed} out of an enclosed spot, re-navigating`);
      const r2 = await navigateOnce(bot, goal, { ...sub, label: `${opts.label} (after pillar escape)` });
      return r2.ok ? { ...r2, state: { ...(r2.state ?? {}), escaped: "pillar", pillared: climbed } } : r2;
    }
  }
  if (mode === "pillar" || cancellation?.isRequested() || diggingDepth(pBot) > 0) return null;

  console.log(`[${bot.username}] nav escape: enclosed with no path, trying a natural-terrain dig-out`);
  const r3 = await withDiggingMovements(pBot, {}, () => navigateOnce(bot, goal, { ...sub, label: `${opts.label} (dig-out escape)` }));
  if (r3.ok) return { ...r3, state: { ...(r3.state ?? {}), escaped: "dig" } };
  return failed;
}

const PASSABLE_NAME_RE = /_door$|_fence_gate$|_trapdoor$/;

/**
 * True if the bot cannot walk (step up 1, drop <= 3) to anywhere meaningfully
 * far from where it stands: a bounded flood fill over standing cells that
 * gives up (=> not boxed in) after BOXED_MAX_CELLS cells or BOXED_MAX_RADIUS
 * blocks of horizontal spread. Doors/gates count as passable. In liquid -> false.
 */
export function isBoxedIn(bot: Bot): boolean {
  if (!bot.entity.onGround) return false; // mid-air / swimming: not a pit
  const start = bot.entity.position.floored();
  const clear = (x: number, y: number, z: number): boolean => {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) return false; // unloaded: treat as a wall
    return b.boundingBox !== "block" || PASSABLE_NAME_RE.test(b.name);
  };
  const solid = (x: number, y: number, z: number): boolean => {
    const b = bot.blockAt(new Vec3(x, y, z));
    return !!b && b.boundingBox === "block" && !PASSABLE_NAME_RE.test(b.name);
  };
  const feet = bot.blockAt(start);
  if (feet && (feet.name === "water" || feet.name === "lava")) return false;
  const seen = new Set<string>([`${start.x},${start.y},${start.z}`]);
  const queue: Array<[number, number, number]> = [[start.x, start.y, start.z]];
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const visit = (x: number, y: number, z: number): boolean => {
    const k = `${x},${y},${z}`;
    if (seen.has(k)) return false;
    seen.add(k);
    queue.push([x, y, z]);
    return Math.max(Math.abs(x - start.x), Math.abs(z - start.z)) > BOXED_MAX_RADIUS || seen.size > BOXED_MAX_CELLS;
  };
  while (queue.length > 0) {
    const [x, y, z] = queue.shift()!;
    for (const [dx, dz] of dirs) {
      const nx = x + dx;
      const nz = z + dz;
      if (clear(nx, y, nz) && clear(nx, y + 1, nz)) {
        // walk or drop (<= 3) to the first floor below
        for (let k = 0; k <= 3; k++) {
          if (!clear(nx, y - k, nz)) break; // column blocked
          if (solid(nx, y - k - 1, nz)) {
            if (visit(nx, y - k, nz)) return false;
            break;
          }
        }
      } else if (solid(nx, y, nz) && clear(nx, y + 1, nz) && clear(nx, y + 2, nz) && clear(x, y + 2, z)) {
        // step up one
        if (visit(nx, y + 1, nz)) return false;
      }
    }
  }
  return true;
}

async function navigateOnce(bot: Bot, goal: Goal, opts: NavigateOptions): Promise<SkillResult> {
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

  const pfTimeouts = pBot.pathfinder as unknown as { thinkTimeout: number };
  const prevThink = pfTimeouts.thinkTimeout;
  if (opts.thinkTimeoutMs !== undefined) pfTimeouts.thinkTimeout = Math.min(MAX_THINK_TIMEOUT_MS, Math.max(prevThink, opts.thinkTimeoutMs));
  try {
    await pBot.pathfinder.goto(goal);
  } catch (err) {
    if (!abort) {
      const message = err instanceof Error ? err.message : String(err);
      if (/took to long/i.test(message)) {
        console.warn(`[${bot.username}] [nav] think timeout (${pfTimeouts.thinkTimeout}ms) deciding path to ${opts.label}`);
      }
      note(/no ?path|noPath/i.test(message) ? "no_path" : "error");
      const kind = /no ?path|noPath/i.test(message) ? "no_path" : "error";
      return fail(bot, opts, `pathfinding to ${opts.label} failed: ${message}`, kind);
    }
  } finally {
    clearInterval(watchdog);
    pfTimeouts.thinkTimeout = prevThink;
  }

  if (abort === "cancelled") {
    note("cancelled");
    return { ok: false, message: `movement to ${opts.label} cancelled`, state: { cancelled: true, ...posState(bot) } };
  }
  if (abort) {
    note(abort.startsWith("stuck") ? "stuck" : "timeout");
    return fail(bot, opts, `movement to ${opts.label} ${abort}`, abort.startsWith("stuck") ? "stuck" : "timeout");
  }

  // Same arrival test pathfinder uses (floored feet, or one up for slabs).
  const here = bot.entity.position.floored();
  const isEnd = (v: Vec3) => goal.isEnd(v as unknown as Parameters<Goal["isEnd"]>[0]);
  if (!isEnd(here) && !isEnd(here.offset(0, 1, 0))) {
    // goto resolved on an empty path without arriving: pathfinder found no route.
    note("no_path");
    return fail(bot, opts, `path to ${opts.label} ended early`, "no_path");
  }
  note("arrived");
  return { ok: true, message: `arrived near ${opts.label}`, state: posState(bot) };
}

/** Digging / placing for the path legitimately keeps the bot still. */
function isBusyInPlace(bot: BotWithPathfinder): boolean {
  return bot.pathfinder.isMining() || bot.pathfinder.isBuilding();
}

function fail(bot: Bot, opts: NavigateOptions, what: string, failure: NavFailure): SkillResult {
  const short = bot.entity.position.distanceTo(opts.target);
  return {
    ok: false,
    message: `${what} — stopped ${short.toFixed(1)} blocks from target. If it's inside a building, look for its door; if across water/a cliff, try a different approach point.`,
    state: { ...posState(bot), failure },
  };
}

function posState(bot: Bot): { position: { x: number; y: number; z: number } } {
  const p = bot.entity.position;
  return { position: { x: round2(p.x), y: round2(p.y), z: round2(p.z) } };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
