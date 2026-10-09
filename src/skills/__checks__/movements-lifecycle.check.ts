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
import { ensureMovements, hasConfiguredMovements, withDiggingMovements, type BotWithPathfinder } from "../pathfinder-config.js";

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
  bot: unknown; canDig: boolean; allow1by1towers: boolean; canOpenDoors: boolean; maxDropDown: number;
  liquidCost: number; scafoldingBlocks: number[]; getBlock: (p: Vec3, dx: number, dy: number, dz: number) => { safe: boolean; physical: boolean };
  countScaffoldingItems(): number;
};
const mv = (b: BotWithPathfinder): M => b.pathfinder.movements as unknown as M;

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
assert.equal(mv(bot1).canDig, false);
assert.equal(mv(bot1).allow1by1towers, false);
assert.equal(mv(bot1).canOpenDoors, false);
assert.equal(mv(bot1).liquidCost, 3);
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
assert.equal(mv(bot2).canDig, false);
assert.notEqual(mv(bot2), installed);
assert.equal(mv(bot1), installed, "old bot unaffected");

// 5. Scoped digging: on inside, restored after (also on throw), never global.
await withDiggingMovements(bot1, { allowStructures: false }, async () => {
  assert.equal(mv(bot1).canDig, true);
  assert.equal(mv(bot1).allow1by1towers, false);
  assert.deepEqual(mv(bot1).scafoldingBlocks, []);
  const inner = mv(bot1).getBlock(new Vec3(5, 64, 5), 0, 0, 0);
  assert.equal(inner.physical, false, "digging variant keeps the door patch");
  ensureMovements(bot1); // navigate() calls this inside the scope: must not clobber it
  assert.equal(mv(bot1).canDig, true);
});
assert.equal(mv(bot1), installed);
assert.equal(mv(bot1).canDig, false);
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
function room(extra: (m: Map<string, string>) => void = () => {}): Map<string, string> {
  const m = new Map<string, string>();
  for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) m.set(`${x},63,${z}`, "stone");
  for (let x = 7; x <= 9; x++) for (let z = -1; z <= 1; z++) {
    if (x === 8 && z === 0) continue;
    for (const y of [64, 65]) m.set(`${x},${y},${z}`, "stone");
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
  assert.equal(b.pathfinder.getPathTo(b.pathfinder.movements, goal, 3000).status, "noPath", "configured Movements refuses");
  const dug = await withDiggingMovements(b, {}, async () => b.pathfinder.getPathTo(b.pathfinder.movements, goal, 3000));
  assert.equal(dug.status, "success", "scoped digging reaches it");
  assert.equal(b.pathfinder.getPathTo(b.pathfinder.movements, goal, 3000).status, "noPath", "and is off again afterwards");
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

console.log("movements-lifecycle: all assertions passed");
process.exit(0);
