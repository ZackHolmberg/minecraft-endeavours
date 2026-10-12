/** Tier 2: multi-step / environment-aware tasks. */
import {
  allOf, ask, blockOf, buildHouse, containerHas, ensureNearby, hasItems, houseGeometry, inBox, oreOutcrop, placeProtected, playerNear, taggedZombie, around, groundAt, countMatching,
} from "../helpers.js";
import type { CheckResult, Scenario, ScenarioCtx } from "../types.js";

export const woodenPickaxe: Scenario = {
  id: "t2.wooden_pickaxe",
  tier: 2,
  category: "craft",
  title: "Make a wooden pickaxe from scratch",
  timeoutMs: 6 * 60_000,
  site: "forest",
  async setup() {},
  run: (ctx) => ask(ctx, "steve, make a wooden pickaxe"),
  check: (ctx) => hasItems(ctx, ctx.bot, "wooden_pickaxe", 1),
  dryWin: (ctx) => ctx.give(ctx.bot, "wooden_pickaxe", 1),
};

export const stonePickaxe: Scenario = {
  id: "t2.stone_pickaxe",
  tier: 2,
  category: "progression",
  title: "Make a stone pickaxe from scratch",
  timeoutMs: 10 * 60_000,
  site: "forest",
  async setup(ctx) {
    await ensureNearby(ctx, /^(stone|cobblestone)$/, "stone", 20);
  },
  run: (ctx) => ask(ctx, "steve, make yourself a stone pickaxe"),
  check: (ctx) => hasItems(ctx, ctx.bot, "stone_pickaxe", 1),
  dryWin: (ctx) => ctx.give(ctx.bot, "stone_pickaxe", 1),
};

const houseOf = (ctx: ScenarioCtx) => houseGeometry(ctx.at(0, 0, 0));

export const doorHouse: Scenario = {
  id: "t2.door_house",
  tier: 2,
  category: "doors",
  title: "Walk into a closed house through its door (no breaking)",
  timeoutMs: 3 * 60_000,
  site: "plains2",
  async setup(ctx) {
    const house = await buildHouse(ctx, ctx.at(0, 0, 0));
    ctx.protect(house.outer, "house");
    await ctx.tp(ctx.tester, house.center);
    // Bot ~10 blocks beyond the door, on the same ground level.
    const z = house.door.z + 10;
    await ctx.tp(ctx.bot, { x: house.center.x, y: await ctx.surface(house.center.x, z), z });
    await ctx.sleep(1500);
  },
  run: (ctx) => ask(ctx, "steve, come inside the house to me"),
  async check(ctx) {
    const p = await ctx.position(ctx.bot);
    const inside = inBox(blockOf(p), houseOf(ctx).interior);
    return { ok: inside, detail: `bot at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} ${inside ? "inside" : "outside"} the house interior` };
  },
  dryWin: (ctx) => ctx.tp(ctx.bot, houseOf(ctx).center),
};

export const doorExit: Scenario = {
  id: "t2.door_exit",
  tier: 2,
  category: "doors",
  title: "Leave a closed house through its door (no breaking)",
  timeoutMs: 3 * 60_000,
  site: "plains2",
  async setup(ctx) {
    const house = await buildHouse(ctx, ctx.at(0, 0, 0));
    ctx.protect(house.outer, "house");
    await ctx.tp(ctx.bot, house.center);
    const z = house.door.z + 10;
    await ctx.tp(ctx.tester, { x: house.center.x, y: await ctx.surface(house.center.x, z), z });
    await ctx.sleep(1500);
  },
  run: (ctx) => ask(ctx, "steve, come out here"),
  async check(ctx) {
    const outside = !inBox(blockOf(await ctx.position(ctx.bot)), houseOf(ctx).outer);
    const near = await playerNear(ctx, ctx.bot, ctx.tester, 5);
    return allOf({ ok: outside, detail: outside ? "bot is outside the house" : "bot still inside" }, near);
  },
  dryWin: async (ctx) => ctx.tp(ctx.bot, await ctx.position(ctx.tester)),
};

export const chestStore: Scenario = {
  id: "t2.chest_store",
  tier: 2,
  category: "storage",
  title: "Put 16 logs into a chest",
  timeoutMs: 3 * 60_000,
  site: "plains",
  async setup(ctx) {
    await ctx.give(ctx.bot, "oak_log", 16);
    await ctx.give(ctx.bot, "cobblestone", 5);
    ctx.scratch.chest = await placeProtected(ctx, ctx.at(0, 0, 6), "chest[facing=north]", "chest");
  },
  run: (ctx) => ask(ctx, "steve, put your logs in the chest"),
  check: (ctx) => containerHas(ctx, ctx.scratch.chest, "oak_log", 16),
  dryWin: (ctx) => ctx.rcon(`item replace block ${ctx.scratch.chest.x} ${ctx.scratch.chest.y} ${ctx.scratch.chest.z} container.0 with minecraft:oak_log 16`).then(() => undefined),
};

export const smeltIron: Scenario = {
  id: "t2.smelt_iron",
  tier: 2,
  category: "craft",
  title: "Smelt 6 raw iron in a furnace",
  timeoutMs: 4 * 60_000,
  site: "plains",
  async setup(ctx) {
    await ctx.give(ctx.bot, "raw_iron", 6);
    await ctx.give(ctx.bot, "coal", 4);
    ctx.scratch.furnace = await placeProtected(ctx, ctx.at(0, 0, 5), "furnace[facing=north]", "furnace");
  },
  run: (ctx) => ask(ctx, "steve, smelt your raw iron"),
  async check(ctx) {
    const inFurnace = countMatching(await ctx.containerItems(ctx.scratch.furnace), "iron_ingot").total;
    const inInv = countMatching(await ctx.inventory(ctx.bot), "iron_ingot").total;
    const n = inFurnace + inInv;
    return { ok: n >= 6, score: Math.min(1, n / 6), detail: `${n}/6 iron_ingot (furnace ${inFurnace}, bot ${inInv})` };
  },
  dryWin: (ctx) => ctx.rcon(`item replace block ${ctx.scratch.furnace.x} ${ctx.scratch.furnace.y} ${ctx.scratch.furnace.z} container.2 with minecraft:iron_ingot 6`).then(() => undefined),
};

export const killZombie: Scenario = {
  id: "t2.kill_zombie",
  tier: 2,
  category: "combat",
  title: "Kill a zombie 8 blocks away and survive",
  timeoutMs: 2 * 60_000,
  site: "plains",
  async setup(ctx) {
    await ctx.give(ctx.bot, "iron_sword", 1);
    ctx.scratch.tag = await taggedZombie(ctx, await groundAt(ctx, 0, 8));
  },
  run: (ctx) => ask(ctx, "steve, kill that zombie"),
  async check(ctx) {
    const alive = await ctx.entityExists(`@e[tag=${ctx.scratch.tag}]`);
    const hp = await ctx.health(ctx.bot);
    return { ok: !alive && hp > 0, detail: `zombie ${alive ? "still alive" : "gone"}, bot health ${hp}` };
  },
  dryWin: (ctx) => ctx.rcon(`kill @e[tag=${ctx.scratch.tag}]`).then(() => undefined),
};

export const coal: Scenario = {
  id: "t2.coal",
  tier: 2,
  category: "gather",
  title: "Find and mine 3 coal in a cave area",
  timeoutMs: 8 * 60_000,
  site: "cave",
  async setup(ctx) {
    await ctx.give(ctx.bot, "stone_pickaxe", 1);
    if ((await ctx.countBlocks(around(ctx.site, 24, -40, 6), /coal_ore$/)) < 3) await oreOutcrop(ctx, 7, 0, [["coal_ore", 6]]);
  },
  run: (ctx) => ask(ctx, "steve, get me some coal"),
  async check(ctx): Promise<CheckResult> {
    const n = countMatching(await ctx.inventory(ctx.bot), "coal").total + countMatching(await ctx.inventory(ctx.tester), "coal").total;
    return { ok: n >= 3, score: Math.min(1, n / 3), detail: `${n}/3 coal (bot+Tester)` };
  },
  dryWin: (ctx) => ctx.give(ctx.bot, "coal", 3),
};

export const tier2 = [woodenPickaxe, stonePickaxe, doorHouse, doorExit, chestStore, smeltIron, killZombie, coal];
