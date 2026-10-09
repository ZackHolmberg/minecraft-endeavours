/** Tier 1: single-skill basics. Pattern: setup() prepares the world, run() = say + waitForDone, check() reads state. */
import { hasItems, playerNear } from "../helpers.js";
import type { Scenario } from "../types.js";

export const chopLogs: Scenario = {
  id: "t1.chop_logs",
  tier: 1,
  category: "gather",
  title: "Chop 10 logs (empty-handed, forest)",
  timeoutMs: 6 * 60_000,
  site: "forest",
  async setup() {
    // Standard reset already cleared the bot's inventory; nothing else to prepare.
  },
  async run(ctx) {
    await ctx.say("steve, chop 10 logs please");
    await ctx.waitForDone();
  },
  check: (ctx) => hasItems(ctx, ctx.bot, /_log$/, 10),
};

export const comeHere: Scenario = {
  id: "t1.come_here",
  tier: 1,
  category: "movement",
  title: "Come to the player 25 blocks away",
  timeoutMs: 2 * 60_000,
  site: "plains",
  async setup(ctx) {
    const x = ctx.site.x + 25;
    await ctx.tp(ctx.tester, { x, y: await ctx.surface(x, ctx.site.z), z: ctx.site.z });
    await ctx.sleep(1500);
  },
  async run(ctx) {
    await ctx.say("steve, come here");
    await ctx.waitForDone();
  },
  check: (ctx) => playerNear(ctx, ctx.bot, ctx.tester, 4),
};

export const giveBread: Scenario = {
  id: "t1.give_bread",
  tier: 1,
  category: "conversation",
  title: "Give the player 3 of 6 bread",
  timeoutMs: 2 * 60_000,
  site: "plains",
  async setup(ctx) {
    await ctx.rcon(`clear ${ctx.tester}`);
    await ctx.give(ctx.bot, "bread", 6);
  },
  async run(ctx) {
    await ctx.say("steve, can you give me 3 bread?");
    await ctx.waitForDone();
  },
  check: (ctx) => hasItems(ctx, ctx.tester, "bread", 3),
};
