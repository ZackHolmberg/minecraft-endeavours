/** Tier 1: single-capability basics. Pattern: setup() prepares the world, run() = say + waitForDone, check() reads state. */
import { around, ask, botSaid, ensureNearby, hasItems, playerNear } from "../helpers.js";
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
  run: (ctx) => ask(ctx, "steve, chop 10 logs please"),
  check: (ctx) => hasItems(ctx, ctx.bot, /_log$/, 10),
  dryWin: (ctx) => ctx.give(ctx.bot, "oak_log", 10),
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
  run: (ctx) => ask(ctx, "steve, come here"),
  check: (ctx) => playerNear(ctx, ctx.bot, ctx.tester, 4),
  dryWin: async (ctx) => ctx.tp(ctx.bot, { ...(await ctx.position(ctx.tester)), x: (await ctx.position(ctx.tester)).x - 1 }),
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
  run: (ctx) => ask(ctx, "steve, can you give me 3 bread?"),
  check: (ctx) => hasItems(ctx, ctx.tester, "bread", 3),
  dryWin: (ctx) => ctx.give(ctx.tester, "bread", 3),
};

export const mineStone: Scenario = {
  id: "t1.mine_stone",
  tier: 1,
  category: "gather",
  title: "Mine 8 stone with a wooden pickaxe",
  timeoutMs: 4 * 60_000,
  site: "hills",
  async setup(ctx) {
    await ensureNearby(ctx, /^stone$/, "stone", 40);
    await ctx.give(ctx.bot, "wooden_pickaxe", 1);
  },
  run: (ctx) => ask(ctx, "steve, mine 8 stone"),
  check: (ctx) => hasItems(ctx, ctx.bot, "cobblestone", 8),
  dryWin: (ctx) => ctx.give(ctx.bot, "cobblestone", 8),
};

export const craftTable: Scenario = {
  id: "t1.craft_table",
  tier: 1,
  category: "craft",
  title: "Craft a crafting table from 3 logs",
  timeoutMs: 2 * 60_000,
  site: "plains",
  async setup(ctx) {
    await ctx.give(ctx.bot, "oak_log", 3);
  },
  run: (ctx) => ask(ctx, "steve, make a crafting table"),
  async check(ctx) {
    const inv = (await ctx.inventory(ctx.bot)).get("crafting_table") ?? 0;
    if (inv > 0) return { ok: true, detail: "crafting_table in inventory" };
    const placed = await ctx.countBlocks(around(await ctx.position(ctx.bot), 6, -3, 4), "crafting_table");
    return { ok: placed > 0, detail: placed > 0 ? "crafting_table placed within 6 blocks" : "no crafting_table in inventory or within 6 blocks" };
  },
  dryWin: (ctx) => ctx.give(ctx.bot, "crafting_table", 1),
};

export const eat: Scenario = {
  id: "t1.eat",
  tier: 1,
  category: "survival",
  title: "Eat when hungry (food <= 10)",
  timeoutMs: 2 * 60_000,
  site: "plains",
  async setup(ctx) {
    await ctx.give(ctx.bot, "bread", 4);
    await ctx.rcon(`effect give ${ctx.bot} minecraft:hunger 90 100 true`);
    for (let i = 0; i < 90 && (await ctx.foodLevel(ctx.bot)) > 10; i++) await ctx.sleep(1000);
    await ctx.rcon(`effect clear ${ctx.bot} minecraft:hunger`);
    ctx.scratch.food0 = await ctx.foodLevel(ctx.bot);
  },
  run: (ctx) => ask(ctx, "steve, eat something"),
  async check(ctx) {
    const f = await ctx.foodLevel(ctx.bot);
    const f0 = ctx.scratch.food0 as number;
    return { ok: f > f0, detail: `food ${f} (was ${f0} after setup)` };
  },
  dryWin: (ctx) => ctx.rcon(`effect give ${ctx.bot} minecraft:saturation 1 3 true`).then(() => undefined),
};

export const invQuestion: Scenario = {
  id: "t1.inv_question",
  tier: 1,
  category: "conversation",
  title: "Answer 'what's in your inventory?' truthfully",
  timeoutMs: 60_000,
  site: "plains",
  async setup(ctx) {
    await ctx.give(ctx.bot, "bread", 5);
    await ctx.give(ctx.bot, "torch", 3);
    await ctx.give(ctx.bot, "iron_sword", 1);
  },
  run: (ctx) => ask(ctx, "steve, what's in your inventory?"),
  async check(ctx) {
    const said = botSaid(ctx);
    const bread = /bread/i.test(said);
    const sword = /sword/i.test(said);
    return { ok: bread && sword, score: ((bread ? 1 : 0) + (sword ? 1 : 0)) / 2, detail: `reply mentions bread=${bread} sword=${sword}: "${said.slice(0, 80)}"` };
  },
  dryWin: (ctx) => ctx.rcon(`tellraw @a {"text":"<${ctx.bot}> I have 5 bread, 3 torches and an iron sword"}`).then(() => ctx.sleep(1000)),
};

export const follow: Scenario = {
  id: "t1.follow",
  tier: 1,
  category: "movement",
  title: "Follow the player as they walk 24 blocks",
  timeoutMs: 2 * 60_000,
  site: "plains",
  async setup() {},
  async run(ctx) {
    await ctx.say("steve, follow me");
    await ctx.sleep(4000);
    let p = await ctx.position(ctx.tester);
    for (let i = 0; i < 8; i++) {
      const x = Math.floor(p.x) + 3;
      p = { x, y: await ctx.surface(x, Math.floor(p.z)), z: p.z };
      await ctx.tp(ctx.tester, p);
      await ctx.sleep(1500);
    }
    ctx.scratch.walkEndedAt = Date.now();
    await ctx.sleep(10_000);
  },
  async check(ctx) {
    const end = ctx.scratch.walkEndedAt as number | undefined;
    if (!end || Date.now() - end < 10_000) return { ok: false, detail: "waiting for the walk to finish + 10s" };
    return playerNear(ctx, ctx.bot, ctx.tester, 6);
  },
  dryWin: async (ctx) => {
    ctx.scratch.walkEndedAt = Date.now() - 11_000;
    const p = await ctx.position(ctx.tester);
    await ctx.tp(ctx.bot, { ...p, x: p.x - 2 });
  },
};

export const tier1 = [chopLogs, comeHere, giveBread, mineStone, craftTable, eat, invQuestion, follow];
