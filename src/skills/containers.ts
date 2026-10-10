/**
 * Containers in plain sight (chests, barrels, shulker boxes), whether or not the bot ever opened
 * them. World memory only learns a chest when it is opened, so "put them in the chest" about a
 * chest 5 blocks away used to fail with "where is it?". Shared by the context block
 * (`planning-context.ts`) and the deposit/withdraw skills (`storage.ts`).
 */
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";

/** Live scan radius for containers in plain sight. */
export const CONTAINER_SCAN_RADIUS = 16;

const CONTAINER_NAME_RE = /^(chest|trapped_chest|barrel|([a-z_]+_)?shulker_box)$/;

/** Block names the container skills can open. */
export function isContainerName(name: string): boolean {
  return CONTAINER_NAME_RE.test(name);
}

export interface NearbyContainer {
  block: Block;
  name: string;
  pos: { x: number; y: number; z: number };
  /** Distance from the bot, blocks (1 decimal). */
  dist: number;
}

/** True when `b` is the other half of the double chest `a` (same type, adjacent on x or z, same y). */
export function isDoubleChestHalf(a: { name: string; x: number; y: number; z: number }, b: { name: string; x: number; y: number; z: number }): boolean {
  if ((a.name !== "chest" && a.name !== "trapped_chest") || a.name !== b.name || a.y !== b.y) return false;
  return Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1;
}

/**
 * Containers within `radius` of the bot, nearest first. A double chest is one entry (its nearer half).
 * Synchronous `findBlocks` over the loaded chunks: cheap at this radius.
 */
export function findNearbyContainers(bot: Bot, radius = CONTAINER_SCAN_RADIUS, max = 6): NearbyContainer[] {
  if (!bot.entity) return [];
  const ids = Object.values(bot.registry.blocksByName).filter((b) => isContainerName(b.name)).map((b) => b.id);
  if (ids.length === 0) return [];
  const me = bot.entity.position;
  const out: NearbyContainer[] = [];
  for (const p of bot.findBlocks({ point: me, matching: ids, maxDistance: radius, count: max * 2 + 4 })) {
    const block = bot.blockAt(p);
    if (!block) continue;
    const cur = { name: block.name, x: p.x, y: p.y, z: p.z };
    if (out.some((o) => isDoubleChestHalf({ name: o.name, ...o.pos }, cur))) continue;
    out.push({ block, name: block.name, pos: { x: p.x, y: p.y, z: p.z }, dist: Math.round(p.distanceTo(new Vec3(me.x, me.y, me.z)) * 10) / 10 });
    if (out.length >= max) break;
  }
  return out.sort((a, b) => a.dist - b.dist);
}
