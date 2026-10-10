/**
 * Offline check: ensureMovements installs v1's policy on a real
 * mineflayer-pathfinder plugin instance (which pre-creates a default
 * Movements whose .bot === bot), once per Bot object, incl. a "reconnect".
 *
 * Run: npx tsx src/skills/__checks__/movements-lifecycle.check.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import minecraftData from "minecraft-data";
import pathfinderPkg from "mineflayer-pathfinder";
import PrismarineBlock from "prismarine-block";
import { Vec3 } from "vec3";
import { BASE_DIG_COST, LIQUID_COST, SCOPED_DIG_COST, diggingDepth, ensureMovements, hasConfiguredMovements, resetMovementsToBase, withDiggingMovements, DIG_SCOPE_MAX_MS, type BotWithPathfinder } from "../pathfinder-config.js";
import { isBoxedIn, navigate, navFailureOf } from "../navigation.js";
import { isNaturalTerrain } from "../structure-guard.js";

const { pathfinder } = pathfinderPkg;
const registry = minecraftData("1.21.9");
const Block = PrismarineBlock(registry as never);

function fakeBot(username: string, blocks: Map<string, string> = new Map()): BotWithPathfinder {
  const bot = new EventEmitter() as unknown as Record<string, unknown>;
  bot.registry = registry;
  bot.username = username;
  bot.version = "1.21.9";
  bot.entity = { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0 };
  bot.entities = {};
  bot.game = { gameMode: "survival" };
  bot.inventory = { items: () => [] };
  bot.world = {};
  bot.blockAt = (p: Vec3) => {
    const name = blocks.get(`${p.x},${p.y},${p.z}`) ?? "air";
    return Block.fromStateId(registry.blocksByName[name]!.defaultState!, 0) && Object.assign(Block.fromStateId(registry.blocksByName[name]!.defaultState!, 0), { position: p.clone() });
  };
  bot.setControlState = () => {};
  bot.clearControlStates = () => {};
  bot.loadPlugin = (fn: (b: unknown) => void) => fn(bot);
  (bot.loadPlugin as (fn: unknown) => void)(pathfinder);
  return bot as unknown as BotWithPathfinder;
}

type M = {
  bot: unknown; canDig: boolean; blocksCantBreak: Set<number>; allow1by1towers: boolean; canOpenDoors: boolean; maxDropDown: number;
  liquidCost: number; scafoldingBlocks: number[]; getBlock: (p: Vec3, dx: number, dy: number, dz: number) => { safe: boolean; physical: boolean };
  countScaffoldingItems(): number;
};
const mv = (b: BotWithPathfinder): M => b.pathfinder.movements as unknown as M;
const id = (n: string): number => registry.blocksByName[n]!.id;
/** Can A* break this block under the currently installed Movements? */
const breaks = (m: M, name: string): boolean => m.canDig && !m.blocksCantBreak.has(id(name));
/** "Scoped digging variant installed": the cheap one (base digs natural terrain too, but at BASE_DIG_COST). */
const digs = (m: M): boolean => m.canDig && (m as unknown as { digCost: number }).digCost === SCOPED_DIG_COST;

// 0. Reproduce the bug: the plugin's own default Movements already has .bot === bot and canDig.
const blocks = new Map([["5,64,5", "oak_door"]]);
const bot1 = fakeBot("a", blocks);
assert.equal(mv(bot1).bot, bot1);
assert.equal(mv(bot1).canDig, true, "precondition: default Movements digs");
assert.equal(mv(bot1).allow1by1towers, true);
const defaultDoor = mv(bot1).getBlock(new Vec3(5, 64, 5), 0, 0, 0);
assert.equal(defaultDoor.physical, true, "precondition: default Movements treats a door as solid");
const defaultInstance = mv(bot1);

// 1. ensureMovements installs the configured one.
assert.equal(hasConfiguredMovements(bot1), false);
ensureMovements(bot1);
assert.notEqual(mv(bot1), defaultInstance, "default instance replaced");
assert.equal(digs(mv(bot1)), false, "base is the expensive variant");
assert.equal((mv(bot1) as unknown as { digCost: number }).digCost, BASE_DIG_COST);
// cheap-break foliage allowlist: leaves/vines/plants yes, everything else no
for (const n of ["oak_leaves", "jungle_leaves", "azalea_leaves", "cherry_leaves", "mangrove_leaves", "vine", "short_grass", "tall_grass", "fern", "large_fern", "stone", "dirt", "grass_block", "sand", "gravel", "iron_ore", "coal_ore", "andesite"]) assert.equal(breaks(mv(bot1), n), true, `base breaks ${n}`);
for (const n of ["oak_log", "jungle_log", "oak_planks", "cobblestone", "oak_door", "glass", "chest", "crafting_table", "bedrock", "water", "white_wool", "furnace", "oak_stairs", "red_bed"]) assert.equal(breaks(mv(bot1), n), false, `base must not break ${n}`);
assert.equal(mv(bot1).allow1by1towers, false);
assert.equal(mv(bot1).canOpenDoors, false);
assert.equal(mv(bot1).liquidCost, LIQUID_COST);
assert.equal(mv(bot1).maxDropDown, 3);
assert.deepEqual(mv(bot1).scafoldingBlocks, [], "A* may not place scaffolding");
const door = mv(bot1).getBlock(new Vec3(5, 64, 5), 0, 0, 0);
assert.equal(door.safe, true, "door patch: walkable");
assert.equal(door.physical, false, "door patch: not a wall");
assert.equal(mv(bot1).countScaffoldingItems(), 0);

// 2. Exactly once: same instance on later calls; creative toggles maxDropDown only.
const installed = mv(bot1);
ensureMovements(bot1);
assert.equal(mv(bot1), installed);
(bot1.game as { gameMode: string }).gameMode = "creative";
ensureMovements(bot1);
assert.equal(mv(bot1), installed);
assert.equal(mv(bot1).maxDropDown, 8);
(bot1.game as { gameMode: string }).gameMode = "survival";
ensureMovements(bot1);
assert.equal(mv(bot1).maxDropDown, 3);

// 3. Someone installs a foreign default instance: healed.
const { Movements } = pathfinderPkg;
bot1.pathfinder.setMovements(new Movements(bot1));
assert.equal(mv(bot1).canDig, true);
ensureMovements(bot1);
assert.equal(mv(bot1), installed);

// 4. Reconnect = new Bot object with its own plugin default; configured again.
const bot2 = fakeBot("a", blocks);
assert.equal(mv(bot2).canDig, true);
ensureMovements(bot2);
assert.equal(digs(mv(bot2)), false);
assert.notEqual(mv(bot2), installed);
assert.equal(mv(bot1), installed, "old bot unaffected");

// 5. Scoped digging: on inside, restored after (also on throw), never global.
await withDiggingMovements(bot1, { allowStructures: false }, async () => {
  assert.equal(digs(mv(bot1)), true);
  assert.equal(mv(bot1).allow1by1towers, false);
  assert.deepEqual(mv(bot1).scafoldingBlocks, []);
  const inner = mv(bot1).getBlock(new Vec3(5, 64, 5), 0, 0, 0);
  assert.equal(inner.physical, false, "digging variant keeps the door patch");
  ensureMovements(bot1); // navigate() calls this inside the scope: must not clobber it
  assert.equal(digs(mv(bot1)), true);
});
assert.equal(mv(bot1), installed);
assert.equal(digs(mv(bot1)), false);
await assert.rejects(withDiggingMovements(bot1, {}, async () => { throw new Error("boom"); }), /boom/);
assert.equal(mv(bot1), installed, "restored after throw");

// 6. Structure guard in the digging variant: planks joined to planks are unbreakable, plain stone is not.
const wall = new Map([["0,64,0", "oak_planks"], ["1,64,0", "oak_planks"], ["0,64,3", "stone"]]);
const bot3 = fakeBot("c", wall);
await withDiggingMovements(bot3, { allowStructures: false }, async () => {
  const m = bot3.pathfinder.movements as unknown as { exclusionBreak(b: unknown): number };
  assert.ok(m.exclusionBreak(bot3.blockAt(new Vec3(0, 64, 0))) >= 100, "player-built wall excluded");
  assert.equal(m.exclusionBreak(bot3.blockAt(new Vec3(0, 64, 3))), 0, "natural stone breakable");
});
await withDiggingMovements(bot3, { allowStructures: true }, async () => {
  const m = bot3.pathfinder.movements as unknown as { exclusionBreak(b: unknown): number };
  assert.equal(m.exclusionBreak(bot3.blockAt(new Vec3(0, 64, 0))), 0, "allowStructures lifts the guard");
});

// 7. End-to-end A* on a tiny world: 21x21 stone floor at y=63 (nothing beyond is loaded),
//    a closed 3x3 stone room around (8,64,0). Default Movements tunnels in; ours says noPath;
//    scoped digging finds a path; a gap with cobblestone in the inventory is NOT bridged.
function room(extra: (m: Map<string, string>) => void = () => {}, wall = "stone"): Map<string, string> {
  const m = new Map<string, string>();
  for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) m.set(`${x},63,${z}`, "stone");
  for (let x = 7; x <= 9; x++) for (let z = -1; z <= 1; z++) {
    if (x === 8 && z === 0) continue;
    for (const y of [64, 65]) m.set(`${x},${y},${z}`, wall);
  }
  extra(m);
  return m;
}
const goals = pathfinderPkg.goals;
const goal = new goals.GoalBlock(8, 64, 0);
{
  const b = fakeBot("r", room());
  const dflt = b.pathfinder.getPathTo(b.pathfinder.movements, goal, 3000);
  assert.equal(dflt.status, "success", "default Movements tunnels into the closed room");
  ensureMovements(b);
  // v2 change: base Movements may dig NATURAL terrain (stone walls), at BASE_DIG_COST.
  assert.equal(b.pathfinder.getPathTo(b.pathfinder.movements, goal, 3000).status, "success", "base digs natural stone");
  const dug = await withDiggingMovements(b, {}, async () => b.pathfinder.getPathTo(b.pathfinder.movements, goal, 3000));
  assert.equal(dug.status, "success", "scoped digging reaches it");
  // ...but never a built room: planks walls stay a wall for both variants.
  const pb = fakeBot("rp", room(() => {}, "oak_planks"));
  ensureMovements(pb);
  assert.equal(pb.pathfinder.getPathTo(pb.pathfinder.movements, goal, 3000).status, "noPath", "base refuses a planks room");
  const pdug = await withDiggingMovements(pb, {}, async () => pb.pathfinder.getPathTo(pb.pathfinder.movements, goal, 3000));
  assert.equal(pdug.status, "noPath", "scoped digging refuses a planks room");
  // ...and cobblestone / logs / doors-less glass likewise
  for (const wall of ["cobblestone", "oak_log", "glass"]) {
    const w = fakeBot("rw", room(() => {}, wall));
    ensureMovements(w);
    assert.equal(w.pathfinder.getPathTo(w.pathfinder.movements, goal, 3000).status, "noPath", `base refuses a ${wall} room`);
  }
}
{
  // A door in the room wall: configured Movements walks in through it (planner treats it as passable).
  const b = fakeBot("d", room((m) => { m.delete("7,64,0"); m.delete("7,65,0"); m.set("7,64,0", "oak_door"); }));
  ensureMovements(b);
  assert.equal(b.pathfinder.getPathTo(b.pathfinder.movements, goal, 3000).status, "success", "door is a way in");
}
{
  // 1-wide trench across the only route with cobblestone in hand: must not bridge/scaffold.
  const w = room((m) => { for (let z = -10; z <= 10; z++) { m.delete(`4,63,${z}`); } });
  const target = new goals.GoalBlock(8, 64, 5);
  const b = fakeBot("t", w);
  (b.inventory as unknown as { items: () => unknown[] }).items = () => [{ type: registry.itemsByName.cobblestone!.id, count: 64, name: "cobblestone" }];
  const dflt = b.pathfinder.getPathTo(b.pathfinder.movements, target, 3000);
  assert.equal(dflt.status, "success", "(parkour/places across a 1-wide trench by default)");
  ensureMovements(b);
  const ours = b.pathfinder.getPathTo(b.pathfinder.movements, target, 3000) as { path: Array<{ toPlace: unknown[] }> };
  assert.ok(ours.path.every((n) => n.toPlace.length === 0), "no block placement in any path node");
}

// 8. Re-entrant scopes: base is restored only when the OUTERMOST scope exits.
{
  const b = fakeBot("depth", new Map());
  ensureMovements(b);
  const base = mv(b);
  assert.equal(diggingDepth(b), 0);
  await withDiggingMovements(b, {}, async () => {
    assert.equal(diggingDepth(b), 1);
    const dig = mv(b);
    assert.equal(digs(dig), true);
    await withDiggingMovements(b, { allowStructures: true }, async () => {
      assert.equal(diggingDepth(b), 2);
      assert.equal(mv(b), dig, "nested scope reuses the digging instance");
    });
    assert.equal(diggingDepth(b), 1);
    assert.equal(mv(b), dig, "inner exit must NOT restore base early");
    assert.equal(digs(mv(b)), true);
  });
  assert.equal(diggingDepth(b), 0);
  assert.equal(mv(b), base);
  // Overlapping (parallel skills): A enters, B enters, A exits first -> still digging for B.
  let releaseA!: () => void, releaseB!: () => void;
  const a = withDiggingMovements(b, {}, () => new Promise<void>((r) => { releaseA = r; }));
  const bb = withDiggingMovements(b, {}, () => new Promise<void>((r) => { releaseB = r; }));
  assert.equal(diggingDepth(b), 2);
  releaseA(); await a;
  assert.equal(diggingDepth(b), 1);
  assert.equal(digs(mv(b)), true, "B still has digging after A exits");
  releaseB(); await bb;
  assert.equal(mv(b), base);
  // Throw inside nested scope unwinds the counter.
  await assert.rejects(withDiggingMovements(b, {}, () => withDiggingMovements(b, {}, async () => { throw new Error("x"); })), /x/);
  assert.equal(diggingDepth(b), 0);
  assert.equal(mv(b), base);
  // Structure guard stays on while any open scope wants it.
  const wallB = fakeBot("strict", new Map([["0,64,0", "oak_planks"], ["1,64,0", "oak_planks"]]));
  await withDiggingMovements(wallB, {}, async () => {
    await withDiggingMovements(wallB, { allowStructures: true }, async () => {
      const m = wallB.pathfinder.movements as unknown as { exclusionBreak(b: unknown): number };
      assert.ok(m.exclusionBreak(wallB.blockAt(new Vec3(0, 64, 0))) >= 100, "strict outer scope keeps the guard");
    });
  });
  // Abandoned (watchdogged) scope: reset puts base back, and the zombie's later finally is a no-op
  // (it must not underflow/clobber the NEXT skill's scope).
  let finishZombie!: () => void;
  const zombie = withDiggingMovements(b, {}, () => new Promise<void>((r) => { finishZombie = r; }));
  assert.equal(diggingDepth(b), 1);
  resetMovementsToBase(b);
  assert.equal(diggingDepth(b), 0);
  assert.equal(mv(b), base, "watchdog reset restores base");
  let nextRelease!: () => void;
  const next = withDiggingMovements(b, {}, () => new Promise<void>((r) => { nextRelease = r; }));
  finishZombie(); await zombie;
  assert.equal(diggingDepth(b), 1, "zombie exit leaves the new scope alone");
  assert.equal(mv(b).canDig, true);
  nextRelease(); await next;
  assert.equal(mv(b), base);
  // Timestamp backstop: a scope open past DIG_SCOPE_MAX_MS is reset by the next ensureMovements.
  let stuck!: () => void;
  const leaked = withDiggingMovements(b, {}, () => new Promise<void>((r) => { stuck = r; }));
  const realNow = Date.now;
  Date.now = () => realNow() + DIG_SCOPE_MAX_MS + 1000;
  try { ensureMovements(b); } finally { Date.now = realNow; }
  assert.equal(diggingDepth(b), 0, "stale scope reset");
  assert.equal(mv(b), base);
  stuck(); await leaked;
  assert.equal(mv(b), base);
  // A leaked digging instance with no open scope is healed back to base.
  await withDiggingMovements(b, {}, async () => {});
  const digInst = (b as unknown as { pathfinder: { movements: unknown } }).pathfinder.movements;
  b.pathfinder.setMovements(mv(b) === base ? (new Movements(b) as never) : (base as never));
  ensureMovements(b);
  assert.equal(mv(b), base);
  void digInst;
}

// 9. Dig variant is natural-terrain only: blocksCantBreak is the complement of the allowlist.
{
  const b = fakeBot("natural", new Map());
  await withDiggingMovements(b, {}, async () => {
    const cant = (b.pathfinder.movements as unknown as { blocksCantBreak: Set<number> }).blocksCantBreak;
    const id = (n: string): number => registry.blocksByName[n]!.id;
    const mustProtect = [
      "furnace", "blast_furnace", "smoker", "crafting_table", "chest", "trapped_chest", "barrel", "ender_chest", "bookshelf",
      "oak_planks", "spruce_planks", "cobblestone", "mossy_cobblestone", "cobbled_deepslate", "stone_bricks", "glass", "glass_pane",
      "white_wool", "red_bed", "oak_door", "oak_fence", "oak_stairs", "oak_slab", "oak_log", "stripped_oak_log", "oak_sign",
      "torch", "farmland", "wheat", "hay_block", "redstone_wire", "lever", "tnt", "obsidian", "bedrock", "water", "lava",
      "white_concrete", "bricks", "glazed_terracotta", "cyan_terracotta", "magenta_glazed_terracotta", "sea_lantern", "ladder",
    ].filter((n) => registry.blocksByName[n]);
    for (const n of mustProtect) assert.ok(cant.has(id(n)), `${n} must be unbreakable for pathing`);
    const mustAllow = [
      "stone", "granite", "diorite", "andesite", "deepslate", "tuff", "dirt", "grass_block", "coarse_dirt", "podzol", "mycelium",
      "sand", "red_sand", "gravel", "clay", "sandstone", "terracotta", "orange_terracotta", "netherrack", "basalt", "blackstone",
      "iron_ore", "deepslate_diamond_ore", "nether_gold_ore", "oak_leaves", "snow_block", "ice", "moss_block", "calcite", "dripstone_block",
    ].filter((n) => registry.blocksByName[n]);
    assert.ok(mustAllow.length >= 28, "allowlist sample resolved against minecraft-data");
    for (const n of mustAllow) assert.ok(!cant.has(id(n)), `${n} is natural terrain: breakable`);
    for (const n of ["cobblestone", "oak_log", "furnace", "oak_planks"]) assert.equal(isNaturalTerrain(n), false, n);
    // And the live predicate: safeToBreak honours it.
    const m = b.pathfinder.movements as unknown as { safeToBreak(blk: unknown): boolean; blocksCantBreak: Set<number> };
    const mk = (n: string, pos: Vec3) => Object.assign(Block.fromStateId(registry.blocksByName[n]!.defaultState!, 0), { position: pos });
    assert.equal(m.safeToBreak(mk("furnace", new Vec3(0, 70, 0))), false);
    assert.equal(m.safeToBreak(mk("cobblestone", new Vec3(0, 70, 0))), false);
  });
  // Base policy: natural terrain only (expensive); its own safeToBreak agrees.
  assert.equal(digs(mv(b)), false);
  {
    const m = b.pathfinder.movements as unknown as { safeToBreak(blk: unknown): boolean };
    const mk = (n: string, pos: Vec3) => Object.assign(Block.fromStateId(registry.blocksByName[n]!.defaultState!, 0), { position: pos });
    for (const n of ["jungle_leaves", "stone", "dirt"]) assert.equal(m.safeToBreak(mk(n, new Vec3(0, 70, 0))), true, `base may break ${n}`);
    for (const n of ["oak_planks", "furnace", "oak_log", "cobblestone"]) assert.equal(m.safeToBreak(mk(n, new Vec3(0, 70, 0))), false, `base must not break ${n}`);
  }
}

// 10. isBoxedIn: sealed shaft / deep pit = boxed; open ground, 1-high step, door = not.
{
  const flat = (extra: (m: Map<string, string>) => void = () => {}): Map<string, string> => {
    const m = new Map<string, string>();
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) m.set(`${x},63,${z}`, "stone");
    extra(m);
    return m;
  };
  const at = (blocks: Map<string, string>, y = 64): BotWithPathfinder => {
    const b = fakeBot("box", blocks);
    b.entity.position = new Vec3(0.5, y, 0.5);
    return b;
  };
  assert.equal(isBoxedIn(at(flat())), false, "open ground");
  // 1x1 shaft 5 deep: walls x=±1 / z=±1 from y=59..68, floor at y=58 (bot at y=59).
  const shaft = flat((m) => {
    for (let y = 58; y <= 62; y++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) m.set(`${dx},${y},${dz}`, "stone");
    for (let y = 58; y <= 63; y++) m.delete(`0,${y},0`);
    m.set("0,58,0", "stone");
    for (let y = 59; y <= 63; y++) m.delete(`0,${y},0`);
  });
  assert.equal(isBoxedIn(at(shaft, 59)), true, "sealed 1x1 pit deeper than the drop limit");
  // Wide pit 9x9, 6 deep.
  const wide = flat((m) => {
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = 58; y <= 63; y++) m.delete(`${x},${y},${z}`);
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) m.set(`${x},57,${z}`, "stone");
  });
  assert.equal(isBoxedIn(at(wide, 58)), true, "wide pit: every wall is >1 high");
  // Same pit with a ramp: not boxed.
  const ramp = flat((m) => {
    for (let x = -5; x <= 5; x++) for (let z = -4; z <= 4; z++) for (let y = 58; y <= 63; y++) m.delete(`${x},${y},${z}`);
    for (let x = -5; x <= 5; x++) for (let z = -4; z <= 4; z++) m.set(`${x},57,${z}`, "stone");
    // stairs rising toward +x: standing cell at x=k is y=58+k (k=1..5), solid below it
    for (let k = 1; k <= 5; k++) for (let y = 58; y < 58 + k; y++) for (let z = -4; z <= 4; z++) m.set(`${k},${y},${z}`, "stone");
  });
  assert.equal(isBoxedIn(at(ramp, 58)), false, "ramp out");
  // Closed room with a door: not boxed.
  const room2 = flat((m) => {
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (Math.abs(x) === 2 || Math.abs(z) === 2) for (const y of [64, 65]) m.set(`${x},${y},${z}`, "stone");
    m.set("2,64,0", "oak_door"); m.delete("2,65,0");
  });
  assert.equal(isBoxedIn(at(room2)), false, "door counts as passable");
  const room3 = new Map(room2); room3.set("2,64,0", "stone"); room3.set("2,65,0", "stone");
  assert.equal(isBoxedIn(at(room3)), true, "sealed room");
  const air = at(shaft, 59); air.entity.onGround = false;
  assert.equal(isBoxedIn(air), false, "not on the ground: not a pit");
}

// 11. navigate() escape: bounded, once per call, only when boxed in, dig variant is natural-only.
{
  const pit = new Map<string, string>();
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) pit.set(`${x},63,${z}`, "stone");
  for (let y = 58; y <= 62; y++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) pit.set(`${dx},${y},${dz}`, "stone");
  for (let y = 59; y <= 63; y++) pit.delete(`0,${y},0`);
  pit.set("0,58,0", "stone");
  const mkNav = (name: string, blocks: Map<string, string>, y: number, digWorks: boolean) => {
    const b = fakeBot(name, blocks);
    b.entity.position = new Vec3(0.5, y, 0.5);
    const calls: boolean[] = [];
    (b.pathfinder as unknown as { goto: (g: unknown) => Promise<void> }).goto = async () => {
      const dig = digs(mv(b));
      calls.push(dig);
      if (!dig || !digWorks) throw new Error("No path to the goal!");
      b.entity.position = new Vec3(8.5, 64, 0.5); // "arrived"
    };
    (b.pathfinder as unknown as { isMining: () => boolean; isBuilding: () => boolean }).isMining = () => false;
    (b.pathfinder as unknown as { isBuilding: () => boolean }).isBuilding = () => false;
    return { b, calls };
  };
  const target = new Vec3(8.5, 64, 0.5);
  const goalNear = new goals.GoalNear(8, 64, 0, 1);
  {
    const { b, calls } = mkNav("esc1", pit, 59, true);
    const r = await navigate(b, goalNear as never, { label: "x", target });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(calls, [false, true], "no-dig attempt, then exactly one dig-out");
    assert.equal((r.state as { escaped?: string }).escaped, "dig");
    assert.equal(diggingDepth(b), 0);
    assert.equal(digs(mv(b)), false);
  }
  {
    const { b, calls } = mkNav("esc2", pit, 59, false);
    const r = await navigate(b, goalNear as never, { label: "x", target });
    assert.equal(r.ok, false);
    assert.equal(navFailureOf(r), "no_path");
    assert.deepEqual(calls, [false, true], "bounded: one escape attempt, no loop");
  }
  {
    const { b, calls } = mkNav("esc3", pit, 59, true);
    const r = await navigate(b, goalNear as never, { label: "x", target, escape: "none" });
    assert.equal(r.ok, false);
    assert.deepEqual(calls, [false], "escape: none never digs");
    const { b: b4, calls: c4 } = mkNav("esc4", pit, 59, true);
    const r4 = await navigate(b4, goalNear as never, { label: "x", target, escape: "pillar" });
    assert.equal(r4.ok, false);
    assert.deepEqual(c4, [false], "pillar-only mode without filler does not dig");
  }
  {
    const open = new Map<string, string>();
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) open.set(`${x},63,${z}`, "stone");
    const { b, calls } = mkNav("esc5", open, 64, true);
    const r = await navigate(b, goalNear as never, { label: "x", target });
    assert.equal(r.ok, false);
    assert.deepEqual(calls, [false], "not boxed in: no escape (plain unreachable target)");
  }
}

console.log("movements-lifecycle: all assertions passed");
process.exit(0);
