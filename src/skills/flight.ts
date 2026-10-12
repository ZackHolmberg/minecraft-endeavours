/**
 * Creative flight — used only where a straight-line move is provably safe.
 *
 * mineflayer's `bot.creative.flyTo` zeroes gravity and teleports the bot
 * 0.5 blocks per 50ms along a straight line with NO collision handling, no
 * timeout and no cancellation, and `stopFlying()` sets gravity to `null` if
 * `startFlying()` was never called. So we run our own loop with the same
 * step size (≈10 b/s, creative fly speed) and:
 *  - only fly legs whose whole swept body volume is air (`segmentClear`);
 *    a blocked direct line falls back to up → across → down at a clear
 *    cruise height, else we don't fly at all;
 *  - honour the cancellation flag and a distance-scaled timeout;
 *  - track the saved gravity ourselves so landing always restores it;
 *  - send the serverbound `abilities` flying flag like a vanilla client does
 *    on double-tap jump (best effort).
 *
 * Pathfinder walking stays the default everywhere. Flight is used for:
 * reaching build spots out of reach from the ground (placeBlocks), goTo
 * targets well above the bot or unreachable on foot ("come up here"), long goTo
 * trips in creative (`flyLongTrip`), and the follow job when the followed player
 * is flying (`flyFollowTick`, one 0.5-block step per 50 ms tick).
 * Hovering is left on after a build; `land()` runs before any other skill
 * (harness) and on every `game` event (mode change, respawn).
 */

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { getBotState } from "../state/index.js";
import { isCreative } from "./game-mode.js";
import { waitForGrounded } from "./pillar.js";
import type { BotWithPathfinder } from "./pathfinder-config.js";
import type { SkillResult } from "./types.js";

const STEP = 0.5; // blocks per 50ms tick, same as mineflayer's flyTo
const TICK_MS = 50;
const SAMPLE_SPACING = 0.25;
const HALF_WIDTH = 0.3;
const BODY_SAMPLE_YS = [0.05, 0.9, 1.75];
const CRUISE_LIFTS = [0, 1, 2, 3, 5, 8, 12];
const LAND_TIMEOUT_MS = 8_000;
const MAX_FLIGHT_DIST = 96;
const EYE = 1.62;
/** Creative block reach is 5; stay a margin inside it. */
const CREATIVE_PLACE_REACH = 4.5;

const savedGravity = new WeakMap<Bot, number>();

export function isFlying(bot: Bot): boolean {
  return savedGravity.has(bot);
}

function sendAbilities(bot: Bot, flying: boolean): void {
  try {
    bot._client.write("abilities", { flags: flying ? 0x02 : 0x00 });
  } catch {
    // cosmetic for the server; never fail flight on it
  }
}

function startFlying(bot: Bot): void {
  if (!savedGravity.has(bot)) {
    savedGravity.set(bot, bot.physics.gravity);
    sendAbilities(bot, true);
  }
  (bot as BotWithPathfinder).pathfinder?.setGoal(null);
  bot.clearControlStates();
  bot.physics.gravity = 0;
  bot.entity.velocity.set(0, 0, 0);
}

/** Restore gravity without waiting (mode switch / respawn / disconnect paths). */
export function stopFlyingNow(bot: Bot): void {
  const g = savedGravity.get(bot);
  if (g === undefined) return;
  savedGravity.delete(bot);
  bot.physics.gravity = g;
  sendAbilities(bot, false);
}

/** Stop flying and wait to touch down. No-op when not flying. */
export async function land(bot: Bot): Promise<void> {
  if (!isFlying(bot)) return;
  stopFlyingNow(bot);
  await waitForGrounded(bot, LAND_TIMEOUT_MS);
}

function passable(bot: Bot, x: number, y: number, z: number): boolean {
  const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  return b !== null && b.boundingBox === "empty";
}

/** Would the bot's 0.6×1.8 hitbox with feet at `feet` touch any solid block? */
export function bodyClearAt(bot: Bot, feet: Vec3): boolean {
  for (const dy of BODY_SAMPLE_YS) {
    for (const dx of [-HALF_WIDTH, HALF_WIDTH]) {
      for (const dz of [-HALF_WIDTH, HALF_WIDTH]) {
        if (!passable(bot, feet.x + dx, feet.y + dy, feet.z + dz)) return false;
      }
    }
  }
  return true;
}

function segmentClear(bot: Bot, a: Vec3, b: Vec3): boolean {
  const d = a.distanceTo(b);
  const steps = Math.max(1, Math.ceil(d / SAMPLE_SPACING));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = new Vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
    if (!bodyClearAt(bot, p)) return false;
  }
  return true;
}

/** Straight line if clear, else up → across → down at the lowest clear cruise height. */
function planLegs(bot: Bot, from: Vec3, to: Vec3): Vec3[] | null {
  if (segmentClear(bot, from, to)) return [to];
  const base = Math.max(from.y, to.y);
  for (const lift of CRUISE_LIFTS) {
    const y = base + lift;
    const up = new Vec3(from.x, y, from.z);
    const over = new Vec3(to.x, y, to.z);
    if (segmentClear(bot, from, up) && segmentClear(bot, up, over) && segmentClear(bot, over, to)) {
      return [up, over, to];
    }
  }
  return null;
}

async function flyLeg(bot: Bot, dest: Vec3): Promise<"ok" | "cancelled" | "timeout"> {
  const cancellation = getBotState(bot.username)?.cancellation;
  const deadline = Date.now() + (bot.entity.position.distanceTo(dest) / STEP) * TICK_MS * 3 + 2_000;
  while (true) {
    if (!bot.entity) return "cancelled";
    if (cancellation?.isRequested()) return "cancelled";
    if (Date.now() > deadline) return "timeout";
    bot.physics.gravity = 0;
    bot.entity.velocity.set(0, 0, 0);
    const pos = bot.entity.position;
    const v = dest.minus(pos);
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (len <= STEP) {
      pos.set(dest.x, dest.y, dest.z);
      await sleep(TICK_MS);
      return "ok";
    }
    pos.add(v.scaled(STEP / len));
    await sleep(TICK_MS);
  }
}

/**
 * Fly the bot's feet to `dest` if (and only if) a clear route exists. Leaves
 * the bot hovering; call `land()` to come down.
 */
export async function flyTo(bot: Bot, dest: Vec3, label: string): Promise<SkillResult> {
  if (!isCreative(bot)) return { ok: false, message: "can only fly in creative mode" };
  const from = bot.entity.position.clone();
  if (from.distanceTo(dest) > MAX_FLIGHT_DIST) {
    return { ok: false, message: `${label} is too far to fly in one hop (${Math.round(from.distanceTo(dest))} blocks)` };
  }
  const legs = planLegs(bot, from, dest);
  if (!legs) return { ok: false, message: `no clear flight line to ${label}` };
  startFlying(bot);
  for (const leg of legs) {
    const r = await flyLeg(bot, leg);
    if (r === "cancelled") return { ok: false, message: `flight to ${label} cancelled`, state: { cancelled: true } };
    if (r === "timeout") return { ok: false, message: `flight to ${label} timed out` };
  }
  return { ok: true, message: `flew to ${label}` };
}

export interface FlyFollowResult {
  /** The bot is within `dist` (+ slack) of the target and hovering. */
  arrived: boolean;
  /** The step toward the target was refused: every candidate step would put the body inside a block (or an unloaded chunk). */
  blocked: boolean;
}

/** Hover this far inside "arrived" so a player drifting a little does not make the bot jitter. */
const FOLLOW_ARRIVE_SLACK = 1.0;
/** Over-the-obstacle detours stop this far above the followed player. */
const FOLLOW_MAX_CLIMB = 24;

/**
 * One creative-flight step of the follow job: move <= 0.5 blocks toward the point `dist` blocks from `target` (on the line
 * to the bot, so it stops beside the player, not inside them), only if the new body volume is free of blocks. A refused
 * straight step tries up, then each axis alone, then gives up for this tick (`blocked`) and keeps hovering. Takes off on
 * first use; `land()` / `stopFlyingNow()` ends it. Never flies in survival.
 */
export function flyFollowTick(bot: Bot, target: Vec3, dist: number): FlyFollowResult {
  if (!isCreative(bot) || !bot.entity) return { arrived: false, blocked: true };
  if (!isFlying(bot)) startFlying(bot);
  bot.physics.gravity = 0;
  bot.entity.velocity.set(0, 0, 0);
  const pos = bot.entity.position;
  const d = pos.minus(target);
  const len = d.norm();
  if (len <= dist + FOLLOW_ARRIVE_SLACK) return { arrived: true, blocked: false };
  const goal = len > 0 ? target.plus(d.scaled(dist / len)) : target.clone();
  const toGoal = goal.minus(pos);
  const gl = toGoal.norm();
  if (gl < 1e-6) return { arrived: true, blocked: false };
  const step = toGoal.scaled(Math.min(STEP, gl) / gl);
  // Straight on; else sideways at the same height (slides along / over an obstacle), each axis alone, then up (over it).
  // Going down is only ever part of the straight step, so a wall cannot make it bob up and down.
  const flat = new Vec3(step.x, 0, step.z);
  const flatLen = flat.norm();
  const tries = [step, ...(flatLen > 1e-6 ? [flat.scaled(Math.min(STEP, gl) / flatLen)] : []), new Vec3(step.x, 0, 0), new Vec3(0, 0, step.z), new Vec3(0, STEP, 0)];
  for (const [i, t] of tries.entries()) {
    if (t.norm() < 1e-6) continue;
    // climbing over an obstacle is fine, climbing forever is not: stop going up well above the player
    if (i === tries.length - 1 && pos.y >= target.y + FOLLOW_MAX_CLIMB) continue;
    const next = pos.plus(t);
    if (bodyClearAt(bot, next)) {
      pos.set(next.x, next.y, next.z);
      return { arrived: false, blocked: false };
    }
  }
  return { arrived: false, blocked: true };
}

/** y of the first free cell above the topmost solid block of column (x,z) near `aroundY` (feet height to hover at), null when unloaded. */
export function columnHoverY(bot: Bot, x: number, z: number, aroundY: number, clearance = 2): number | null {
  const top = Math.min(Math.floor(aroundY) + 40, 318);
  const bottom = Math.max(Math.floor(aroundY) - 60, -64);
  for (let y = top; y >= bottom; y--) {
    const b = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)));
    if (!b) return null;
    if (b.boundingBox !== "empty") return y + 1 + clearance;
  }
  return null;
}

/**
 * Creative long trip: hop toward `dest` at hover height over the terrain (<= 4 hops of <= 80 blocks, along a verified-clear
 * route each time) until it is within `finishWithin` blocks horizontally, then land so the normal walk/stand logic takes over.
 * Stops quietly at the first hop that cannot be flown (blocked line, unloaded chunk); the caller walks the rest.
 * Returns how far it flew.
 */
export async function flyLongTrip(bot: Bot, dest: Vec3, label: string, finishWithin = 40): Promise<{ flew: number; note: string }> {
  if (!isCreative(bot)) return { flew: 0, note: "not creative" };
  const start = bot.entity.position.clone();
  let note = "";
  for (let hop = 0; hop < 4; hop++) {
    const here = bot.entity.position;
    const remaining = Math.hypot(dest.x - here.x, dest.z - here.z);
    if (remaining <= finishWithin) break;
    const f = Math.min(80, remaining - finishWithin * 0.5) / remaining;
    const hx = here.x + (dest.x - here.x) * f;
    const hz = here.z + (dest.z - here.z) * f;
    const hy = columnHoverY(bot, hx, hz, Math.max(here.y, dest.y));
    if (hy === null) {
      note = "chunks ahead not loaded";
      break;
    }
    const r = await flyTo(bot, new Vec3(Math.floor(hx) + 0.5, hy, Math.floor(hz) + 0.5), `${label} (hop ${hop + 1})`);
    if (!r.ok) {
      note = r.message;
      break;
    }
  }
  await land(bot);
  return { flew: Math.round(Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z)), note };
}

function solid(bot: Bot, p: Vec3): boolean {
  const b = bot.blockAt(p);
  return b !== null && b.boundingBox === "block";
}

/**
 * Hover spot from which the bot can place against `ref` to fill `target`:
 * body clear, not overlapping the target cell, eye within creative reach of
 * the reference face, reachable by a clear flight line. Prefers spots above
 * the target (builds go ground-up, so the layer being placed stays free),
 * then the nearest one.
 */
export function findPlaceHoverSpot(bot: Bot, target: Vec3, ref: Vec3): Vec3 | null {
  const from = bot.entity.position;
  const refCenter = ref.offset(0.5, 0.5, 0.5);
  const cands: Array<{ p: Vec3; score: number }> = [];
  for (const dy of [2, 1, 0, -1]) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const feet = new Vec3(target.x + dx + 0.5, target.y + dy, target.z + dz + 0.5);
        // Never hover inside the target cell itself.
        if (dx === 0 && dz === 0 && dy > -2 && dy < 1) continue;
        if (feet.offset(0, EYE, 0).distanceTo(refCenter) > CREATIVE_PLACE_REACH) continue;
        if (!bodyClearAt(bot, feet)) continue;
        cands.push({ p: feet, score: from.distanceTo(feet) + (dy <= 0 ? 3 : 0) });
      }
    }
  }
  return firstFlyable(bot, from, cands);
}

/**
 * Standing spot near `dest` (within `reach + 1` horizontally) with solid
 * ground below and a clear flight line from here — for "come up here".
 */
export function findStandSpotNear(bot: Bot, dest: Vec3, reach: number): Vec3 | null {
  const from = bot.entity.position;
  const r = Math.max(1, Math.ceil(reach) + 1);
  const base = dest.floored();
  const cands: Array<{ p: Vec3; score: number }> = [];
  for (let dy = 1; dy >= -2; dy--) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const cell = base.offset(dx, dy, dz);
        if (!solid(bot, cell.offset(0, -1, 0))) continue;
        const feet = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5);
        // Not on top of the target itself (it's usually a player standing there).
        if (Math.hypot(feet.x - dest.x, feet.z - dest.z) < 0.9) continue;
        if (!bodyClearAt(bot, feet)) continue;
        cands.push({ p: feet, score: feet.distanceTo(dest) * 2 + from.distanceTo(feet) * 0.1 });
      }
    }
  }
  return firstFlyable(bot, from, cands);
}

/** Best-scored candidate with a clear flight route (route checks are the expensive part). */
function firstFlyable(bot: Bot, from: Vec3, cands: Array<{ p: Vec3; score: number }>): Vec3 | null {
  cands.sort((a, b) => a.score - b.score);
  for (const c of cands) if (planLegs(bot, from, c.p)) return c.p;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
