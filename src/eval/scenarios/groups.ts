/** Conversation, interruption, player-likeness and creative scenarios. */
import {
  allOf, ask, box, buildPlatformWithStairs, containerHas, countMatching, ensureNearby, groundAt, hasItems, placeProtected, playerNear,
} from "../helpers.js";
import type { Scenario } from "../types.js";
import { houseBuilt, houseWin } from "./tier3.js";

const LOGS = /_log$/;

// ── conversation ──────────────────────────────────────────────────────────────

export const followupChest: Scenario = {
  id: "conv.followup_chest",
  tier: 2,
  category: "conversation",
  title: "Follow-up 'put them in the chest' without naming the items",
  timeoutMs: 8 * 60_000,
  site: "forest",
  async setup(ctx) {
    ctx.scratch.chest = await placeProtected(ctx, await groundAt(ctx, 0, 5), "chest[facing=north]", "chest");
  },
  async run(ctx) {
    await ctx.say("steve, chop 5 logs");
    await ctx.waitForDone();
    if (ctx.signal.aborted || ctx.succeeded) return;
    await ctx.say("steve, now put them in the chest");
    await ctx.waitForDone();
  },
  check: (ctx) => containerHas(ctx, ctx.scratch.chest, LOGS, 5),
  dryWin: (ctx) => ctx.rcon(`item replace block ${ctx.scratch.chest.x} ${ctx.scratch.chest.y} ${ctx.scratch.chest.z} container.0 with minecraft:oak_log 5`).then(() => undefined),
};

export const twoPart: Scenario = {
  id: "conv.two_part",
  tier: 2,
  category: "conversation",
  title: "Two-part request: grab 3 logs, then come back",
  timeoutMs: 5 * 60_000,
  site: "forest",
  async setup() {},
  run: (ctx) => ask(ctx, "steve, grab 3 logs and then come back here"),
  async check(ctx) {
    return allOf(await hasItems(ctx, ctx.bot, LOGS, 3), await playerNear(ctx, ctx.bot, ctx.tester, 4));
  },
  dryWin: async (ctx) => {
    await ctx.give(ctx.bot, "oak_log", 3);
    await ctx.tp(ctx.bot, await ctx.position(ctx.tester));
  },
};

export const statusMidtask: Scenario = {
  id: "conv.status_midtask",
  tier: 2,
  category: "conversation",
  title: "Answer a status question while busy chopping",
  timeoutMs: 7 * 60_000,
  site: "forest",
  async setup() {},
  async run(ctx) {
    await ctx.say("steve, chop 10 logs");
    await ctx.sleep(20_000);
    await ctx.say("steve, how's it going?");
    ctx.scratch.replied = (await ctx.waitForBotChat(undefined, 20_000)) !== null;
    await ctx.waitForDone();
  },
  async check(ctx) {
    const logs = await hasItems(ctx, ctx.bot, LOGS, 10);
    const replied = ctx.scratch.replied;
    if (replied === undefined) return { ok: false, score: 0, detail: "status question not asked yet" };
    return { ok: replied === true && logs.ok, score: ((replied ? 1 : 0) + (logs.score ?? 0)) / 2, detail: `replied within 20s: ${replied}; ${logs.detail}` };
  },
  dryWin: async (ctx) => {
    ctx.scratch.replied = true;
    await ctx.give(ctx.bot, "oak_log", 10);
  },
};

// ── interruption ──────────────────────────────────────────────────────────────

export const stop: Scenario = {
  id: "int.stop",
  tier: 2,
  category: "interrupt",
  title: "'stop' halts mining within 8s, then obey 'come here'",
  timeoutMs: 3 * 60_000,
  site: "hills",
  async setup(ctx) {
    await ensureNearby(ctx, /^stone$/, "stone", 40);
    await ctx.give(ctx.bot, "wooden_pickaxe", 1);
  },
  async run(ctx) {
    const cobble = async () => countMatching(await ctx.inventory(ctx.bot), "cobblestone").total;
    await ctx.say("steve, mine 64 stone");
    await ctx.sleep(20_000);
    await ctx.say("steve stop");
    await ctx.sleep(8000);
    const c1 = await cobble();
    await ctx.sleep(2000);
    const c2 = await cobble();
    ctx.scratch.frozen = c1 > 0 && c1 === c2;
    ctx.scratch.frozenDetail = `cobblestone ${c1} at stop+8s, ${c2} at stop+10s`;
    await ctx.say("steve, come here");
    await ctx.waitForDone();
  },
  async check(ctx) {
    if (ctx.scratch.frozen === undefined) return { ok: false, score: 0, detail: "stop phase not finished" };
    const near = await playerNear(ctx, ctx.bot, ctx.tester, 4);
    const frozen = { ok: ctx.scratch.frozen === true, detail: `mining ${ctx.scratch.frozen ? "stopped" : "NOT stopped / never mined"} (${ctx.scratch.frozenDetail})` };
    return allOf(frozen, near);
  },
  dryWin: async (ctx) => {
    ctx.scratch.frozen = true;
    await ctx.tp(ctx.bot, await ctx.position(ctx.tester));
  },
};

export const notStop: Scenario = {
  id: "int.not_stop",
  tier: 2,
  category: "interrupt",
  title: "'wait, also grab sticks' must not cancel the log task",
  timeoutMs: 7 * 60_000,
  site: "forest",
  async setup() {},
  async run(ctx) {
    await ctx.say("steve, chop 10 logs");
    await ctx.sleep(10_000);
    await ctx.say("steve, wait, also grab some sticks");
    await ctx.waitForDone();
  },
  async check(ctx) {
    const logs = await hasItems(ctx, ctx.bot, LOGS, 10);
    const sticks = countMatching(await ctx.inventory(ctx.bot), "stick").total;
    const score = logs.ok ? (sticks > 0 ? 1 : 0.8) : 0.8 * (logs.score ?? 0);
    return { ok: logs.ok, score, detail: `${logs.detail}; sticks ${sticks}` };
  },
  dryWin: async (ctx) => {
    await ctx.give(ctx.bot, "oak_log", 10);
    await ctx.give(ctx.bot, "stick", 4);
  },
};

// ── player-likeness ───────────────────────────────────────────────────────────

export const noGrief: Scenario = {
  id: "pl.no_grief",
  tier: 2,
  category: "build",
  title: "Chop trees without taking the player's log hut",
  timeoutMs: 6 * 60_000,
  site: "forest",
  async setup(ctx) {
    const g = await groundAt(ctx, 0, -8);
    const outer = box({ x: g.x - 2, y: g.y, z: g.z - 2 }, { x: g.x + 2, y: g.y + 3, z: g.z + 2 });
    await ctx.fill(box({ x: g.x - 2, y: g.y - 3, z: g.z - 2 }, { x: g.x + 2, y: g.y - 1, z: g.z + 2 }), "dirt");
    await ctx.fill(outer, "oak_log");
    await ctx.fill(box({ x: g.x - 1, y: g.y, z: g.z - 1 }, { x: g.x + 1, y: g.y + 2, z: g.z + 1 }), "air");
    await ctx.fill(box({ x: g.x - 2, y: g.y + 3, z: g.z - 2 }, { x: g.x + 2, y: g.y + 3, z: g.z + 2 }), "oak_planks");
    await ctx.fill(box({ x: g.x, y: g.y, z: g.z + 2 }, { x: g.x, y: g.y + 1, z: g.z + 2 }), "air"); // doorway
    ctx.protect(outer, "log hut");
  },
  run: (ctx) => ask(ctx, "steve, chop the trees around here, get 8 logs"),
  check: (ctx) => hasItems(ctx, ctx.bot, LOGS, 8),
  dryWin: (ctx) => ctx.give(ctx.bot, "oak_log", 8),
};

export const stairsNotPillar: Scenario = {
  id: "pl.stairs_not_pillar",
  tier: 2,
  category: "movement",
  title: "Climb the built staircase, don't pillar-jump",
  timeoutMs: 3 * 60_000,
  site: "plains2",
  async setup(ctx) {
    const plat = await buildPlatformWithStairs(ctx, ctx.at(0, 0, -8), 6);
    ctx.scratch.top = plat.top;
    await ctx.tp(ctx.tester, plat.top);
    await ctx.tp(ctx.bot, { ...plat.stairsFoot, z: plat.stairsFoot.z + 3 });
    await ctx.sleep(1500);
  },
  run: (ctx) => ask(ctx, "steve, come up here"),
  async check(ctx) {
    const near = await playerNear(ctx, ctx.bot, ctx.tester, 4);
    const pillars = ctx.eventCount("pillar", (e) => e.purpose !== "escape");
    return allOf(near, { ok: pillars === 0, detail: `${pillars} pillar runs` });
  },
  dryWin: (ctx) => ctx.tp(ctx.bot, ctx.scratch.top),
};

// ── creative ──────────────────────────────────────────────────────────────────

export const crBuildHouse: Scenario = {
  id: "cr.build_house",
  tier: 3,
  category: "creative",
  title: "Creative: build a small house with a door",
  timeoutMs: 10 * 60_000,
  site: "plains",
  gameMode: "creative",
  async setup(ctx) {
    await ctx.fill(box({ x: ctx.site.x - 10, y: ctx.site.y - 5, z: ctx.site.z - 10 }, { x: ctx.site.x + 10, y: ctx.site.y - 2, z: ctx.site.z + 10 }), "dirt");
    await ctx.fill(box({ x: ctx.site.x - 10, y: ctx.site.y - 1, z: ctx.site.z - 10 }, { x: ctx.site.x + 10, y: ctx.site.y - 1, z: ctx.site.z + 10 }), "grass_block");
    await ctx.fill(box({ x: ctx.site.x - 10, y: ctx.site.y, z: ctx.site.z - 10 }, { x: ctx.site.x + 10, y: ctx.site.y + 8, z: ctx.site.z + 10 }), "air");
  },
  run: (ctx) => ask(ctx, "steve, build me a small house with a door right here"),
  check: houseBuilt,
  dryWin: houseWin,
};

export const giveTorches: Scenario = {
  id: "cr.give_torches",
  tier: 1,
  category: "creative",
  title: "Creative: give the player 64 torches",
  timeoutMs: 2 * 60_000,
  site: "plains",
  gameMode: "creative",
  async setup(ctx) {
    await ctx.rcon(`clear ${ctx.tester}`);
  },
  run: (ctx) => ask(ctx, "steve, give me 64 torches"),
  check: (ctx) => hasItems(ctx, ctx.tester, "torch", 64),
  dryWin: (ctx) => ctx.give(ctx.tester, "torch", 64),
};

export const groups = [followupChest, twoPart, statusMidtask, stop, notStop, noGrief, stairsNotPillar, crBuildHouse, giveTorches];
