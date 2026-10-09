/** Tier 3: long-horizon tasks (planning, many skills, survival). */
import { around, ask, box, flattenPad, hasItems, holdUntilDone, oreOutcrop } from "../helpers.js";
import type { Box, CheckResult, Scenario, ScenarioCtx } from "../types.js";

export const ironPickaxe: Scenario = {
  id: "t3.iron_pickaxe",
  tier: 3,
  category: "progression",
  title: "Make an iron pickaxe from scratch",
  timeoutMs: 25 * 60_000,
  site: "forest",
  async setup(ctx) {
    // Feasibility aid: a stone outcrop with exposed iron + coal 10 blocks away (the natural forest has none nearby).
    await oreOutcrop(ctx, 10, 0, [["iron_ore", 5], ["coal_ore", 4]]);
  },
  run: (ctx) => ask(ctx, "steve, make an iron pickaxe"),
  check: (ctx) => hasItems(ctx, ctx.bot, "iron_pickaxe", 1),
  dryWin: (ctx) => ctx.give(ctx.bot, "iron_pickaxe", 1),
};

const NIGHT_TICKS = 10_500; // 13000 -> 23500

export const surviveNight: Scenario = {
  id: "t3.survive_night",
  tier: 3,
  category: "survival",
  title: "Survive until dawn (time 13000 -> 23500)",
  timeoutMs: 12 * 60_000,
  site: "plains",
  async setup(ctx) {
    await ctx.give(ctx.bot, "stone_sword", 1);
    await ctx.give(ctx.bot, "bread", 5);
    await ctx.setTime(13000);
    ctx.scratch.t0 = await ctx.gameTime();
  },
  async run(ctx) {
    await ctx.say("steve, it's getting dark, survive the night");
    await holdUntilDone(ctx);
  },
  async check(ctx) {
    const elapsed = (await ctx.gameTime()) - (ctx.scratch.t0 as number);
    const deaths = ctx.eventCount("death");
    if (elapsed < NIGHT_TICKS) return { ok: false, score: (0.5 * elapsed) / NIGHT_TICKS, detail: `night ${elapsed}/${NIGHT_TICKS} ticks, deaths ${deaths}` };
    return { ok: deaths === 0, score: deaths === 0 ? 1 : deaths === 1 ? 0.5 : 0, detail: `reached dawn, deaths ${deaths}` };
  },
  dryWin: async (ctx) => {
    ctx.scratch.t0 = (await ctx.gameTime()) - NIGHT_TICKS - 5;
  },
};

const houseBox = (ctx: { site: { x: number; y: number; z: number } }): Box =>
  box({ x: ctx.site.x - 8, y: ctx.site.y - 1, z: ctx.site.z - 8 }, { x: ctx.site.x + 7, y: ctx.site.y + 8, z: ctx.site.z + 7 });

/** Dry-run helper: fake a built house (planks cube + door). */
export async function houseWin(ctx: ScenarioCtx): Promise<void> {
  const c = ctx.at(0, 0, 0);
  await ctx.fill(box({ x: c.x - 3, y: c.y, z: c.z - 3 }, { x: c.x + 3, y: c.y + 2, z: c.z + 3 }), "oak_planks");
  await ctx.setBlock({ x: c.x, y: c.y, z: c.z + 3 }, "oak_door[half=lower]");
}

/** Shared by t3.build_house and cr.build_house: >=40 newly placed blocks in the 16-block box AND a door. */
export async function houseBuilt(ctx: ScenarioCtx): Promise<CheckResult> {
  const b = houseBox(ctx);
  const n = await ctx.placedBlocks(b);
  const door = (await ctx.countBlocks(b, /_door$/)) > 0;
  return { ok: n >= 40 && door, score: 0.5 * Math.min(1, n / 40) + (door ? 0.5 : 0), detail: `${n} blocks placed in the 16-block box (need 40), door ${door ? "placed" : "missing"}` };
}

export const buildHouse: Scenario = {
  id: "t3.build_house",
  tier: 3,
  category: "build",
  title: "Build a small house from supplied materials",
  timeoutMs: 15 * 60_000,
  site: "plains",
  async setup(ctx) {
    await flattenPad(ctx, ctx.site, 10, 8);
    await ctx.give(ctx.bot, "oak_planks", 64);
    await ctx.give(ctx.bot, "oak_door", 1);
    await ctx.give(ctx.bot, "glass", 4);
  },
  run: (ctx) => ask(ctx, "steve, build a small house here"),
  check: houseBuilt,
  dryWin: houseWin,
};

export const wheatFarm: Scenario = {
  id: "t3.wheat_farm",
  tier: 3,
  category: "farm",
  title: "Set up a small wheat farm next to water",
  timeoutMs: 10 * 60_000,
  site: "plains",
  async setup(ctx) {
    await flattenPad(ctx, ctx.site, 10, 4);
    await ctx.give(ctx.bot, "wooden_hoe", 1);
    await ctx.give(ctx.bot, "wheat_seeds", 16);
    await ctx.setBlock(ctx.at(0, -1, 3), "water");
  },
  run: (ctx) => ask(ctx, "steve, set up a small wheat farm here"),
  async check(ctx) {
    const n = await ctx.countBlocks(around(ctx.site, 10, -2, 3), "wheat");
    return { ok: n >= 9, score: Math.min(1, n / 9), detail: `${n}/9 wheat crops within 10 blocks` };
  },
  dryWin: async (ctx) => {
    const c = ctx.at(-1, 0, 0);
    await ctx.fill(box({ x: c.x - 1, y: c.y - 1, z: c.z - 4 }, { x: c.x + 1, y: c.y - 1, z: c.z - 2 }), "farmland");
    await ctx.fill(box({ x: c.x - 1, y: c.y, z: c.z - 4 }, { x: c.x + 1, y: c.y, z: c.z - 2 }), "wheat");
  },
};

export const portal: Scenario = {
  id: "t3.portal",
  tier: 3,
  category: "progression",
  title: "Build and light a nether portal",
  timeoutMs: 10 * 60_000,
  site: "plains",
  async setup(ctx) {
    await flattenPad(ctx, ctx.site, 8, 8);
    await ctx.give(ctx.bot, "obsidian", 10);
    await ctx.give(ctx.bot, "flint_and_steel", 1);
  },
  run: (ctx) => ask(ctx, "steve, build a nether portal here"),
  async check(ctx) {
    const n = await ctx.countBlocks(around(ctx.site, 12, -2, 8), "nether_portal");
    return { ok: n >= 1, detail: `${n} nether_portal blocks within 12` };
  },
  dryWin: (ctx) => ctx.setBlock(ctx.at(2, 1, 2), "nether_portal[axis=x]"),
};

export const tier3 = [ironPickaxe, surviveNight, buildHouse, wheatFarm, portal];
