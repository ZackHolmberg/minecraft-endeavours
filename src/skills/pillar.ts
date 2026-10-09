/**
 * Reliable jump-and-place pillaring ("towering up").
 *
 * Why the old version flaked ("jumps repeatedly and fails to place when it's
 * high enough"): it placed on a fixed 120ms timer after pressing jump. A
 * vanilla jump only lifts the feet past +1.0 on the 3rd physics tick
 * (0.42 → 0.75 → 1.00 → 1.17 → 1.25 apex → … back below 1.0 on tick 9), so
 * at 120ms the feet were still inside the target cell and the server refused
 * the placement as obstructed by the player. It also held jump through the
 * landing, so the bot kept bouncing, and picked "the first solid block within
 * 3 below" as the reference, which isn't the cell under the feet when the
 * bot's standing on an edge or a gap.
 *
 * This version:
 *  1. Requires the bot standing (or wading) in an empty cell with a solid
 *     block directly below it and headroom above.
 *  2. Looks straight down (forced, so no turn animation eats the window).
 *  3. Holds jump and polls each physics tick until the feet are
 *     ≥ cell + 1 + margin, releases jump, then places on the top face of the
 *     block below the cell. The place packet is sent from a promise
 *     continuation, i.e. after mineflayer has sent that tick's position
 *     packet, so the server agrees the feet are clear.
 *  4. Confirms the block exists and the bot lands on it; retries a bounded
 *     number of times per level.
 */

import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { recordEvent } from "../observability/telemetry.js";
import { getBotState } from "../state/index.js";
import type { SkillResult } from "./types.js";

export const PILLAR_FILLER_PRIORITY = [
  "cobblestone",
  "cobbled_deepslate",
  "dirt",
  "netherrack",
  "stone",
  "andesite",
  "diorite",
  "granite",
  "tuff",
  "blackstone",
] as const; // sand / gravel would fall out from under us

export const PILLAR_MAX_HEIGHT = 32;
const ATTEMPTS_PER_LEVEL = 3;
const CLEARANCE_MARGIN = 0.1; // feet must be this far above the cell top
const RISE_TIMEOUT_MS = 1_200; // ~24 ticks; a jump peaks at tick 5
const WATER_RISE_TIMEOUT_MS = 3_000; // swimming up is much slower
const LAND_TIMEOUT_MS = 1_200;
const GROUND_WAIT_MS = 1_000;

export function pickFiller(bot: Bot): Item | null {
  const items = bot.inventory.items();
  for (const name of PILLAR_FILLER_PRIORITY) {
    const found = items.find((i) => i.name === name);
    if (found) return found;
  }
  return null;
}

/**
 * Climb `height` blocks straight up by placing filler under the bot.
 * Honors the cancellation flag between levels (does not call begin()).
 */
export type PillarPurpose = "escape" | "requested";

export async function pillarUpBy(bot: Bot, height: number, purpose: PillarPurpose): Promise<SkillResult> {
  const r = await pillarUpByInner(bot, height);
  try {
    const st = r.state as { placed?: number; attempts?: number } | undefined;
    recordEvent(bot.username, {
      kind: "pillar",
      requested: height,
      placed: st?.placed ?? 0,
      attempts: pillarAttempts.get(bot) ?? 0,
      ok: r.ok,
      reason: r.ok ? null : r.message.slice(0, 200),
      purpose,
    });
  } catch {
    // observe-only
  }
  pillarAttempts.delete(bot);
  return r;
}

/** Telemetry-only: placement attempts in the current pillarUpBy call. */
const pillarAttempts = new WeakMap<Bot, number>();

async function pillarUpByInner(bot: Bot, height: number): Promise<SkillResult> {
  pillarAttempts.set(bot, 0);
  if (!Number.isInteger(height) || height < 1 || height > PILLAR_MAX_HEIGHT) {
    return { ok: false, message: `height must be an integer between 1 and ${PILLAR_MAX_HEIGHT}, got ${height}` };
  }
  const cancellation = getBotState(bot.username)?.cancellation;
  const startY = Math.floor(bot.entity.position.y);
  bot.clearControlStates();

  let placed = 0;
  while (placed < height) {
    if (cancellation?.isRequested()) {
      return result(bot, placed > 0, `pillar cancelled after ${placed}/${height} blocks`, placed, startY);
    }
    const level = await placeOneUnderFeet(bot);
    if (!level.ok) {
      return result(bot, false, `pillar stopped after ${placed}/${height} blocks: ${level.message}`, placed, startY);
    }
    placed += 1;
  }
  return result(bot, true, `pillared up ${placed} block${placed === 1 ? "" : "s"}`, placed, startY);
}

function result(bot: Bot, ok: boolean, message: string, placed: number, startY: number): SkillResult {
  const p = bot.entity.position;
  return {
    ok,
    message: `${message}; now standing at (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`,
    state: {
      placed,
      climbed: Math.floor(p.y) - startY,
      position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
    },
  };
}

async function placeOneUnderFeet(bot: Bot): Promise<SkillResult> {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= ATTEMPTS_PER_LEVEL; attempt++) {
    pillarAttempts.set(bot, (pillarAttempts.get(bot) ?? 0) + 1);
    const r = await tryOnce(bot);
    if (r.ok) return r;
    lastError = r.message;
    if (r.fatal) break;
  }
  return { ok: false, message: lastError };
}

type Attempt = SkillResult & { fatal?: boolean };

async function tryOnce(bot: Bot): Promise<Attempt> {
  // mineflayer sets isInWater on the entity at runtime; it's not in the .d.ts.
  const inWater = Boolean((bot.entity as { isInWater?: boolean }).isInWater);
  if (!inWater && !(await waitForGrounded(bot, GROUND_WAIT_MS))) {
    return { ok: false, fatal: true, message: "not standing on solid ground (mid-air, on a ladder, or falling)" };
  }

  const filler = pickFiller(bot);
  if (!filler) {
    return { ok: false, fatal: true, message: "no filler block (cobblestone/dirt/stone/etc.) in inventory" };
  }

  const pos = bot.entity.position;
  // Small epsilon: standing on a full block puts feet at exactly integer y.
  const cell = new Vec3(Math.floor(pos.x), Math.floor(pos.y + 1e-3), Math.floor(pos.z));
  const target = bot.blockAt(cell);
  if (!target || target.boundingBox !== "empty") {
    return {
      ok: false,
      fatal: true,
      message: `can't pillar here: feet cell holds ${target?.name ?? "unloaded chunk"} (standing on a slab/path/ladder?) — step onto a full block first`,
    };
  }
  const ref = bot.blockAt(cell.offset(0, -1, 0));
  if (!ref || ref.boundingBox !== "block") {
    return {
      ok: false,
      fatal: true,
      message: `no solid block directly under the bot (${ref?.name ?? "unloaded"}) — move off the edge / out of deep water first`,
    };
  }
  const ceiling = headroomBlocker(bot, pos, cell.y + 2);
  if (ceiling) {
    return { ok: false, fatal: true, message: `no headroom: ${ceiling.name} above at (${ceiling.position.x}, ${ceiling.position.y}, ${ceiling.position.z})` };
  }

  if (bot.heldItem?.type !== filler.type) {
    try {
      await bot.equip(filler, "hand");
    } catch (err) {
      return { ok: false, message: `couldn't equip ${filler.name}: ${errMsg(err)}` };
    }
  }

  // Look at the exact point placeBlock will aim for (top-face centre of the
  // reference), forced so it lands instantly. placeBlock re-runs lookAt
  // non-forced; with identical yaw/pitch that's a no-op instead of a
  // multi-tick turn that would miss the jump window.
  const aim = ref.position.offset(0.5, 1, 0.5);
  await bot.lookAt(aim, true);

  const needY = cell.y + 1 + CLEARANCE_MARGIN;
  bot.setControlState("jump", true);
  const rose = await waitForTick(bot, () => bot.entity.position.y >= needY, inWater ? WATER_RISE_TIMEOUT_MS : RISE_TIMEOUT_MS);
  bot.setControlState("jump", false); // one jump per level — no bunny-hopping
  if (!rose) {
    await waitForGrounded(bot, LAND_TIMEOUT_MS);
    return { ok: false, message: `couldn't rise above the target cell (reached y=${bot.entity.position.y.toFixed(2)}, needed ${needY.toFixed(2)})` };
  }

  // Re-aim from the raised eye position, still forced (yaw unchanged since
  // we're straight above; pitch stays ~-90°).
  await bot.lookAt(aim, true);
  try {
    await bot.placeBlock(ref, new Vec3(0, 1, 0));
  } catch (err) {
    // placeBlock throws if the update was slow even when the block landed;
    // trust the world state below rather than the exception.
    if (!isSolid(bot.blockAt(cell))) {
      await waitForGrounded(bot, LAND_TIMEOUT_MS);
      return { ok: false, message: `place rejected: ${errMsg(err)}` };
    }
  }

  await waitForGrounded(bot, LAND_TIMEOUT_MS);
  if (!isSolid(bot.blockAt(cell))) {
    return { ok: false, message: `block didn't appear at (${cell.x}, ${cell.y}, ${cell.z})` };
  }
  if (bot.entity.position.y < cell.y + 1 - 0.01) {
    // Drifted sideways and fell back beside the new block.
    return { ok: false, fatal: true, message: `placed ${filler.name} but slid off it` };
  }
  return { ok: true, message: `placed ${filler.name} under feet` };
}

/** First solid block intersecting the bot's hitbox column at layer `y`. */
function headroomBlocker(bot: Bot, pos: Vec3, y: number): Block | null {
  const half = 0.3;
  const xs = new Set([Math.floor(pos.x - half), Math.floor(pos.x + half)]);
  const zs = new Set([Math.floor(pos.z - half), Math.floor(pos.z + half)]);
  for (const x of xs) {
    for (const z of zs) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (b && b.boundingBox === "block") return b;
    }
  }
  return null;
}

function isSolid(b: Block | null): boolean {
  return b !== null && b.boundingBox === "block";
}

/** Resolve true on the first physics tick where `cond()` holds. */
function waitForTick(bot: Bot, cond: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bot.removeListener("physicsTick", onTick);
      resolve(false);
    }, timeoutMs);
    function onTick(): void {
      if (!cond()) return;
      clearTimeout(timer);
      bot.removeListener("physicsTick", onTick);
      resolve(true);
    }
    bot.on("physicsTick", onTick);
  });
}

export async function waitForGrounded(bot: Bot, timeoutMs: number): Promise<boolean> {
  if (bot.entity.onGround) return true;
  return waitForTick(bot, () => bot.entity.onGround, timeoutMs);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
