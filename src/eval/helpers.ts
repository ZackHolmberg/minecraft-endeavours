/** Reusable building blocks for scenarios (setup builders + check helpers). */
import { inBox } from "./ctx.js";
import type { Box, CheckResult, ScenarioCtx, Vec3 } from "./types.js";

export { inBox };

export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const box = (a: Vec3, b: Vec3): Box => ({
  min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
  max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
});
const add = (p: Vec3, dx: number, dy: number, dz: number): Vec3 => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });

/** Entity position floored to block coords, for inBox tests. */
export const blockOf = (p: Vec3): Vec3 => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** Sum of inventory counts whose item name matches. */
export function countMatching(inv: Map<string, number>, match: string | RegExp): { total: number; parts: string } {
  let total = 0;
  const parts: string[] = [];
  for (const [name, n] of inv) {
    if (typeof match === "string" ? name === match : match.test(name)) {
      total += n;
      parts.push(`${name}:${n}`);
    }
  }
  return { total, parts: parts.join(",") || "none" };
}

/** CheckResult for "player holds >= need of items matching `match`" with partial credit. */
export async function hasItems(ctx: ScenarioCtx, player: string, match: string | RegExp, need: number): Promise<CheckResult> {
  const { total, parts } = countMatching(await ctx.inventory(player), match);
  return {
    ok: total >= need,
    score: Math.min(1, total / need),
    detail: `${player} has ${total}/${need} ${String(match)} (${parts})`,
  };
}

/** Same for a container (chest/barrel/furnace). */
export async function containerHas(ctx: ScenarioCtx, pos: Vec3, match: string | RegExp, need: number): Promise<CheckResult> {
  const { total, parts } = countMatching(await ctx.containerItems(pos), match);
  return { ok: total >= need, score: Math.min(1, total / need), detail: `container has ${total}/${need} ${String(match)} (${parts})` };
}

/** Is `player` within `radius` blocks (3D) of `target`? */
export async function playerNear(ctx: ScenarioCtx, player: string, target: Vec3 | string, radius: number): Promise<CheckResult> {
  const p = await ctx.position(player);
  const t = typeof target === "string" ? await ctx.position(target) : target;
  const d = dist(p, t);
  return { ok: d <= radius, score: d <= radius ? 1 : Math.max(0, 1 - (d - radius) / 30), detail: `${player} is ${d.toFixed(1)} blocks away (need <= ${radius})` };
}

export interface House {
  /** Everything incl. floor + roof; pass to ctx.protect(). */
  outer: Box;
  /** Walkable air inside (5x5x3 for size 7). */
  interior: Box;
  /** Lower door block. */
  door: Vec3;
  /** Standing cell directly outside the door. */
  outside: Vec3;
  /** Standing cell at the interior center. */
  center: Vec3;
}

/**
 * Flatten a pad and build a closed oak_planks house (floor, 4 walls, roof, closed oak door
 * facing +z, a torch so mobs can't spawn inside). `center` = ground-level standing cell of the
 * house's middle. size must be odd (default 7).
 */
export async function buildHouse(ctx: ScenarioCtx, center: Vec3, size = 7): Promise<House> {
  const h = (size - 1) / 2;
  const x0 = center.x - h, x1 = center.x + h, z0 = center.z - h, z1 = center.z + h;
  const base = center.y; // standing y; floor planks at base-1
  // Pad: level ground and clear air so slopes/trees don't interfere.
  await ctx.fill(box({ x: x0 - 3, y: base - 5, z: z0 - 3 }, { x: x1 + 3, y: base - 2, z: z1 + 3 }), "dirt");
  await ctx.fill(box({ x: x0 - 3, y: base - 1, z: z0 - 3 }, { x: x1 + 3, y: base - 1, z: z1 + 3 }), "grass_block");
  await ctx.fill(box({ x: x0 - 3, y: base, z: z0 - 3 }, { x: x1 + 3, y: base + 6, z: z1 + 3 }), "air");
  const outer = box({ x: x0, y: base - 1, z: z0 }, { x: x1, y: base + 3, z: z1 });
  await ctx.fill(outer, "oak_planks");
  const interior = box({ x: x0 + 1, y: base, z: z0 + 1 }, { x: x1 - 1, y: base + 2, z: z1 - 1 });
  await ctx.fill(interior, "air");
  const door = { x: center.x, y: base, z: z1 };
  await ctx.setBlock(door, "oak_door[half=lower,facing=south,hinge=left,open=false]");
  await ctx.setBlock(add(door, 0, 1, 0), "oak_door[half=upper,facing=south,hinge=left,open=false]");
  await ctx.setBlock({ x: x0 + 1, y: base, z: z0 + 1 }, "torch");
  await ctx.setBlock({ x: x1 - 1, y: base, z: z0 + 1 }, "torch");
  return { outer, interior, door, outside: add(door, 0, 0, 1), center };
}
