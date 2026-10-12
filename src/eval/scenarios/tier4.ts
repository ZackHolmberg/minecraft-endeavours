/** Tier 4 (stretch suite): very long horizon. Run at milestones only. */
import { around, ask, hasItems } from "../helpers.js";
import type { Scenario } from "../types.js";

const KIT = ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots", "iron_sword", "iron_pickaxe"];

export const ironKit: Scenario = {
  id: "t4.iron_kit",
  tier: 4,
  category: "progression",
  title: "Full iron kit: armor, sword, pickaxe",
  suite: "stretch",
  timeoutMs: 60 * 60_000,
  site: "forest",
  async setup() {},
  run: (ctx) => ask(ctx, "steve, get yourself a full iron kit: armor, sword and pickaxe"),
  async check(ctx) {
    const inv = await ctx.inventory(ctx.bot);
    const have = KIT.filter((k) => (inv.get(k) ?? 0) > 0);
    return { ok: have.length === KIT.length, score: have.length / KIT.length, detail: `${have.length}/6 iron kit pieces (${have.join(",") || "none"})` };
  },
  dryWin: async (ctx) => {
    for (const k of KIT) await ctx.give(ctx.bot, k, 1);
  },
};

export const diamonds: Scenario = {
  id: "t4.diamonds",
  tier: 4,
  category: "progression",
  title: "Find diamonds with an iron pickaxe",
  suite: "stretch",
  timeoutMs: 30 * 60_000,
  site: "cave",
  async setup(ctx) {
    await ctx.give(ctx.bot, "iron_pickaxe", 1);
    await ctx.give(ctx.bot, "torch", 32);
    await ctx.give(ctx.bot, "bread", 16);
  },
  run: (ctx) => ask(ctx, "steve, go find some diamonds"),
  check: (ctx) => hasItems(ctx, ctx.bot, "diamond", 1),
  dryWin: (ctx) => ctx.give(ctx.bot, "diamond", 1),
};

export const portalScratch: Scenario = {
  id: "t4.portal_scratch",
  tier: 4,
  category: "progression",
  title: "Nether portal from scratch",
  suite: "stretch",
  timeoutMs: 60 * 60_000,
  site: "forest",
  async setup() {},
  run: (ctx) => ask(ctx, "steve, build a nether portal"),
  async check(ctx) {
    const n = await ctx.countBlocks(around(ctx.site, 64, -6, 14), "nether_portal");
    return { ok: n >= 1, detail: `${n} nether_portal blocks within 64` };
  },
  dryWin: (ctx) => ctx.setBlock(ctx.at(2, 1, 2), "nether_portal[axis=x]"),
};

export const tier4 = [ironKit, diamonds, portalScratch];
