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

/** Geometry of buildHouse(center, size) without building anything (use in check()). */
export function houseGeometry(center: Vec3, size = 7): House {
  const h = (size - 1) / 2;
  const x0 = center.x - h, x1 = center.x + h, z0 = center.z - h, z1 = center.z + h;
  const base = center.y;
  const door = { x: center.x, y: base, z: z1 };
  return {
    outer: box({ x: x0, y: base - 1, z: z0 }, { x: x1, y: base + 3, z: z1 }),
    interior: box({ x: x0 + 1, y: base, z: z0 + 1 }, { x: x1 - 1, y: base + 2, z: z1 - 1 }),
    door,
    outside: add(door, 0, 0, 1),
    center,
  };
}

/**
 * Flatten a pad and build a closed oak_planks house (floor, 4 walls, roof, closed oak door
 * facing +z, torches so mobs can't spawn inside). `center` = ground-level standing cell of the
 * house's middle. size must be odd (default 7).
 */
export async function buildHouse(ctx: ScenarioCtx, center: Vec3, size = 7): Promise<House> {
  const g = houseGeometry(center, size);
  const base = center.y;
  const { min, max } = g.outer;
  // Pad: level ground and clear air so slopes/trees don't interfere.
  await ctx.fill(box({ x: min.x - 3, y: base - 5, z: min.z - 3 }, { x: max.x + 3, y: base - 2, z: max.z + 3 }), "dirt");
  await ctx.fill(box({ x: min.x - 3, y: base - 1, z: min.z - 3 }, { x: max.x + 3, y: base - 1, z: max.z + 3 }), "grass_block");
  await ctx.fill(box({ x: min.x - 3, y: base, z: min.z - 3 }, { x: max.x + 3, y: base + 6, z: max.z + 3 }), "air");
  await ctx.fill(g.outer, "oak_planks");
  await ctx.fill(g.interior, "air");
  await ctx.setBlock(g.door, "oak_door[half=lower,facing=south,hinge=left,open=false]");
  await ctx.setBlock(add(g.door, 0, 1, 0), "oak_door[half=upper,facing=south,hinge=left,open=false]");
  await ctx.setBlock({ x: g.interior.min.x, y: base, z: g.interior.min.z }, "torch");
  await ctx.setBlock({ x: g.interior.max.x, y: base, z: g.interior.min.z }, "torch");
  return g;
}

// ── more builders / setup helpers ─────────────────────────────────────────────

/** Standing position at site + (dx, dz), y snapped to the real surface. */
export async function groundAt(ctx: ScenarioCtx, dx: number, dz: number): Promise<Vec3> {
  const x = ctx.site.x + dx;
  const z = ctx.site.z + dz;
  return { x, y: await ctx.surface(x, z), z };
}

/** Level a square pad: dirt below, grass top at y-1, air above. `radius` blocks around `center`. */
export async function flattenPad(ctx: ScenarioCtx, center: Vec3, radius: number, up = 8): Promise<void> {
  const lo = { x: center.x - radius, z: center.z - radius };
  const hi = { x: center.x + radius, z: center.z + radius };
  await ctx.fill(box({ ...lo, y: center.y - 5 }, { ...hi, y: center.y - 2 }), "dirt");
  await ctx.fill(box({ ...lo, y: center.y - 1 }, { ...hi, y: center.y - 1 }), "grass_block");
  await ctx.fill(box({ ...lo, y: center.y }, { ...hi, y: center.y + up }), "air");
}

/** A single-block protected container (chest/furnace/barrel...) standing on the ground at `pos` (feet cell). */
export async function placeProtected(ctx: ScenarioCtx, pos: Vec3, block: string, label: string): Promise<Vec3> {
  await ctx.setBlock(pos, block);
  ctx.protect(box(pos, pos), label);
  return pos;
}

/** Count blocks of `name` in a square of `radius` around `center` over [dy0, dy1] relative y. */
export function around(center: Vec3, radius: number, dy0 = -3, dy1 = 8): Box {
  return box({ x: center.x - radius, y: center.y + dy0, z: center.z - radius }, { x: center.x + radius, y: center.y + dy1, z: center.z + radius });
}

/** Zombie tagged `eval_zombie`, wearing an iron helmet (so it doesn't burn in daylight), never despawns. */
export async function taggedZombie(ctx: ScenarioCtx, pos: Vec3): Promise<string> {
  return ctx.summon("zombie", pos, `{PersistenceRequired:1b,equipment:{head:{id:"minecraft:iron_helmet",count:1}},drop_chances:{head:0.0f}}`);
}

export interface Platform {
  /** Standing cell on top of the platform's center. */
  top: Vec3;
  /** Standing cell at the foot of the stairs. */
  stairsFoot: Vec3;
  blocks: Box;
}

/**
 * Solid 5x5 platform whose top is `height` blocks above ground, plus a 1-wide
 * stone_brick_stairs staircase ascending north onto it from the south. Center is the platform center
 * (ground-level standing cell). Flattens its own pad.
 */
export async function buildPlatformWithStairs(ctx: ScenarioCtx, center: Vec3, height = 6): Promise<Platform> {
  const base = center.y;
  await flattenPad(ctx, { x: center.x, y: base, z: center.z + (height + 2) / 2 }, height + 4, height + 4);
  const plat = box({ x: center.x - 2, y: base - 1, z: center.z - 2 }, { x: center.x + 2, y: base + height - 1, z: center.z + 2 });
  await ctx.fill(plat, "stone_bricks");
  for (let i = 1; i <= height; i++) {
    const z = center.z + 2 + (height - i + 1);
    if (i > 1) await ctx.fill(box({ x: center.x, y: base, z }, { x: center.x, y: base + i - 2, z }), "stone_bricks");
    await ctx.setBlock({ x: center.x, y: base + i - 1, z }, "stone_brick_stairs[facing=north,half=bottom]");
  }
  return {
    top: { x: center.x, y: base + height, z: center.z },
    stairsFoot: { x: center.x, y: base, z: center.z + 2 + height + 1 },
    blocks: plat,
  };
}

/** Guarantee at least `min` blocks matching `name` within `radius` of the site by dropping a small outcrop of `block` 6 blocks east. */
export async function ensureNearby(ctx: ScenarioCtx, name: RegExp, block: string, min: number, radius = 16): Promise<void> {
  const have = await ctx.countBlocks(around(ctx.site, radius, -2, 6), name);
  if (have >= min) return;
  const g = await groundAt(ctx, 7, 0);
  await ctx.fill(box({ x: g.x, y: g.y - 3, z: g.z - 3 }, { x: g.x + 5, y: g.y + 1, z: g.z + 3 }), block);
}

export const sleepAbortable = (ctx: ScenarioCtx, ms: number): Promise<void> => ctx.sleep(ms);

/** Combine CheckResults: ok = all ok, score = mean. */
export function allOf(...rs: CheckResult[]): CheckResult {
  return {
    ok: rs.every((r) => r.ok),
    score: rs.reduce((a, r) => a + (r.score ?? (r.ok ? 1 : 0)), 0) / rs.length,
    detail: rs.map((r) => r.detail).join("; "),
  };
}

/** Is the player standing inside the house's outer box (incl. walls)? */
export const insideBox = async (ctx: ScenarioCtx, player: string, b: Box): Promise<boolean> => inBox(blockOf(await ctx.position(player)), b);

/** The common scenario script: one request, then wait until the bot is done (or check passes). */
export async function ask(ctx: ScenarioCtx, message: string): Promise<void> {
  await ctx.say(message);
  await ctx.waitForDone();
}

/** Joined bot chat (for regex checks over everything the bot said). */
export const botSaid = (ctx: ScenarioCtx): string => ctx.botChats.join(" | ");

/**
 * Stone outcrop 10 blocks east of the site with exposed ore on top (feasibility aid when the
 * natural site has none). `ores` e.g. [["iron_ore", 5], ["coal_ore", 4]].
 */
export async function oreOutcrop(ctx: ScenarioCtx, dx: number, dz: number, ores: Array<[string, number]>): Promise<void> {
  const g = await groundAt(ctx, dx, dz);
  await ctx.fill(box({ x: g.x, y: g.y - 3, z: g.z - 3 }, { x: g.x + 5, y: g.y + 2, z: g.z + 3 }), "stone");
  let i = 0;
  for (const [ore, n] of ores)
    for (let k = 0; k < n; k++, i++) await ctx.setBlock({ x: g.x + (i % 6), y: g.y + 2 - (i % 2 ? 1 : 0), z: g.z - 3 + (i % 7) }, ore);
}

/** Keep the scenario running until it is aborted (timeout) or a check() poll has passed — for tasks the bot may "finish" early. */
export async function holdUntilDone(ctx: ScenarioCtx): Promise<void> {
  while (!ctx.signal.aborted && !ctx.succeeded) await ctx.sleep(1000);
}
