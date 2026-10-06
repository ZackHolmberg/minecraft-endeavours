import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";

/**
 * "Put this utility block down next to me" — what a player does when they
 * need a crafting table or furnace and are carrying one. Used by `craftMany`
 * and `smelt` so the agent doesn't have to sequence observe → placeBlock →
 * retry for the most common production-loop step.
 *
 * Picks an empty cell within 2 blocks that has a solid, non-interactive block
 * underneath and doesn't overlap the bot's own hitbox, then places onto the
 * top face of the block below. Tries a handful of candidates before giving up.
 */

const PLACE_RADIUS = 2;
const MAX_ATTEMPTS = 4;

// Right-clicking these opens a UI / toggles state instead of placing on them.
const INTERACTIVE_RE =
  /chest|barrel|table|furnace|smoker|anvil|door|gate|bed|button|lever|shulker|hopper|dispenser|dropper|crafter|loom|stonecutter|grindstone|lectern|bell|note_block|jukebox|beacon|brewing|composter|cauldron|respawn_anchor|repeater|comparator|daylight|sign/;

export type PlaceResult = { ok: true; block: Block } | { ok: false; message: string };

export async function placeFromInventoryNearby(bot: Bot, itemName: string): Promise<PlaceResult> {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return { ok: false, message: `no ${itemName} in inventory to place` };

  const me = bot.entity.position;
  const base = me.floored();
  const candidates: Array<{ pos: Vec3; below: Block; score: number }> = [];
  for (let dx = -PLACE_RADIUS; dx <= PLACE_RADIUS; dx++) {
    for (let dz = -PLACE_RADIUS; dz <= PLACE_RADIUS; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const pos = base.offset(dx, dy, dz);
        if (overlapsBot(me, pos)) continue;
        const target = bot.blockAt(pos);
        if (!target || (target.name !== "air" && target.name !== "cave_air")) continue;
        const below = bot.blockAt(pos.offset(0, -1, 0));
        if (!below || below.boundingBox !== "block" || INTERACTIVE_RE.test(below.name)) continue;
        // Prefer same-level cells ~1.5–2 blocks out: in reach, not underfoot.
        const flat = Math.hypot(dx, dz);
        candidates.push({ pos, below, score: Math.abs(dy) * 2 + Math.abs(flat - 1.6) });
      }
    }
  }
  if (candidates.length === 0) {
    return { ok: false, message: `no clear spot within ${PLACE_RADIUS} blocks to place ${itemName} — move to open flat ground` };
  }
  candidates.sort((a, b) => a.score - b.score);

  try {
    await bot.equip(item, "hand");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `couldn't equip ${itemName} to place it: ${message}` };
  }

  let lastErr = "";
  for (const c of candidates.slice(0, MAX_ATTEMPTS)) {
    try {
      await bot.lookAt(c.pos.offset(0.5, 0, 0.5), true);
      await bot.placeBlock(c.below, new Vec3(0, 1, 0));
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    const placed = bot.blockAt(c.pos);
    if (placed && placed.name === itemName) return { ok: true, block: placed };
  }
  return { ok: false, message: `couldn't place ${itemName} nearby${lastErr ? `: ${lastErr}` : ""}` };
}

/** Does the 1×1×1 cell at `cell` intersect the bot's 0.6×1.8 hitbox at `me`? */
function overlapsBot(me: Vec3, cell: Vec3): boolean {
  const half = 0.3;
  const xOverlap = me.x + half > cell.x && me.x - half < cell.x + 1;
  const zOverlap = me.z + half > cell.z && me.z - half < cell.z + 1;
  const yOverlap = me.y + 1.8 > cell.y && me.y < cell.y + 1;
  return xOverlap && zOverlap && yOverlap;
}
