/** Polish batch B: pixel art (D20). */
import { ask, box, placeProtected } from "../helpers.js";
import type { CheckResult, Scenario, ScenarioCtx } from "../types.js";

const COLOURS = ["red", "white", "blue", "black", "yellow", "light_blue", "gray", "light_gray", "orange", "green", "lime", "cyan", "purple", "magenta", "pink", "brown"];
const PAD = 32;

/** Level creative pad (dirt, grass top at site.y - 1, air above up to the wall height). Fills are sliced to stay under the 32768-block limit. */
async function pad(ctx: ScenarioCtx): Promise<void> {
  const { x, y, z } = ctx.site;
  const lo = { x: x - PAD, z: z - PAD };
  const hi = { x: x + PAD, z: z + PAD };
  await ctx.fill(box({ ...lo, y: y - 5 }, { ...hi, y: y - 2 }), "dirt");
  await ctx.fill(box({ ...lo, y: y - 1 }, { ...hi, y: y - 1 }), "grass_block");
  for (let dy = 0; dy < 28; dy += 7) await ctx.fill(box({ ...lo, y: y + dy }, { ...hi, y: y + dy + 6 }), "air");
}

/** >= 300 concrete blocks in the area AND >= 3 distinct concrete colours. */
export async function pixelArtBuilt(ctx: ScenarioCtx): Promise<CheckResult> {
  const area = box({ x: ctx.site.x - 36, y: ctx.site.y - 1, z: ctx.site.z - 36 }, { x: ctx.site.x + 36, y: ctx.site.y + 26, z: ctx.site.z + 36 });
  const total = await ctx.countBlocks(area, /_concrete$/);
  let colours = 0;
  if (total > 0) {
    for (const c of COLOURS) {
      if ((await ctx.countBlocks(area, `${c}_concrete`)) > 0) colours += 1;
      if (colours >= 3) break;
    }
  }
  const ok = total >= 300 && colours >= 3;
  return { ok, score: 0.5 * Math.min(1, Math.max(0, total) / 300) + 0.5 * Math.min(1, colours / 3), detail: `${total} concrete blocks in the area (need 300), ${colours >= 3 ? "3+" : colours} distinct colour${colours === 1 ? "" : "s"} (need 3)` };
}

export const crPixelArt: Scenario = {
  id: "cr.pixel_art",
  tier: 3,
  category: "creative",
  title: "Creative: build the Montreal Canadiens logo as pixel art",
  timeoutMs: 15 * 60_000,
  site: "plains",
  gameMode: "creative",
  async setup(ctx) {
    await pad(ctx);
    // a player's build the picture must stay clear of
    await placeProtected(ctx, ctx.at(24, 0, 24), "stone_bricks", "player pillar");
    await placeProtected(ctx, ctx.at(24, 1, 24), "stone_bricks", "player pillar top");
  },
  run: (ctx) => ask(ctx, "steve, build the Montreal Canadiens logo here", { confirm: true }),
  check: pixelArtBuilt,
  async dryWin(ctx) {
    const c = ctx.at(-16, 0, -20);
    for (const [i, block] of ["red_concrete", "white_concrete", "blue_concrete"].entries()) {
      await ctx.fill(box({ x: c.x + i * 8, y: c.y, z: c.z }, { x: c.x + i * 8 + 7, y: c.y + 13, z: c.z }), block);
    }
  },
};

/** A custom row (placeBlocks, not a blueprint) over flowers, a sapling and grass: flowers must be broken first, grass is just replaced. */
const ROW = ["poppy", "short_grass", "dandelion", "oak_sapling", "red_tulip", "short_grass", "poppy"];
export const crPlaceOnFlowers: Scenario = {
  id: "cr.place_on_flowers",
  tier: 2,
  category: "creative",
  title: "Creative: place a custom row of blocks over flowers and grass",
  timeoutMs: 4 * 60_000,
  site: "plains",
  gameMode: "creative",
  async setup(ctx) {
    await pad(ctx);
    for (const [i, plant] of ROW.entries()) {
      const c = ctx.at(3 + i, 0, 4);
      await ctx.fill(box(c, c), plant);
    }
  },
  run: (ctx) => {
    const a = ctx.at(3, 0, 4);
    const b = ctx.at(3 + ROW.length - 1, 0, 4);
    return ask(ctx, `steve, place a row of cobblestone from ${a.x} ${a.y} ${a.z} to ${b.x} ${b.y} ${b.z}`);
  },
  async check(ctx) {
    const a = ctx.at(3, 0, 4);
    const b = ctx.at(3 + ROW.length - 1, 0, 4);
    const n = await ctx.countBlocks(box(a, b), "cobblestone");
    return { ok: n === ROW.length, score: n / ROW.length, detail: `${n}/${ROW.length} cobblestone placed over the flowers/grass row` };
  },
  async dryWin(ctx) {
    await ctx.fill(box(ctx.at(3, 0, 4), ctx.at(3 + ROW.length - 1, 0, 4)), "cobblestone");
  },
};

export const polishB = [crPixelArt, crPlaceOnFlowers];
