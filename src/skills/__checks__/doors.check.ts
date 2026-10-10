/**
 * Offline check for doors.ts (v2 regression: bot reached closed doors and never
 * opened them). Reproduces the root cause with the REAL pathfinder A* +
 * postProcessPath, then exercises the path-based detection and the assist loop
 * on a fake bot.
 *
 * Run: BOT_TELEMETRY_DIR=$(mktemp -d) npx tsx src/skills/__checks__/doors.check.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import minecraftData from "minecraft-data";
import pathfinderPkg from "mineflayer-pathfinder";
import PrismarineBlock from "prismarine-block";
import { Vec3 } from "vec3";
import { ensureMovements, type BotWithPathfinder } from "../pathfinder-config.js";
import { blocksTravel, doorCellForNode, findDoorAhead, installDoorAssist, normalizeDoorNodes, pathUsesDoor, type BlockAtFn } from "../doors.js";

const { pathfinder, goals } = pathfinderPkg;
const registry = minecraftData("1.21.9");
const Block = PrismarineBlock(registry as never);

// --- tiny world: stone floor y=63, stone walls x=7 (z -1..1, y 64..65) with a door at (7,64,0) ---
class World {
  blocks = new Map<string, string>();
  props = new Map<string, Record<string, string>>();
  constructor(doorProps: Record<string, string> = { facing: "west", hinge: "left", open: "false" }, doorName = "oak_door") {
    for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) this.blocks.set(`${x},63,${z}`, "stone");
    for (let x = 7; x <= 9; x++) for (let z = -1; z <= 1; z++) {
      if (x === 8 && z === 0) continue;
      for (const y of [64, 65]) this.blocks.set(`${x},${y},${z}`, "stone");
    }
    this.blocks.set("7,64,0", doorName);
    this.blocks.set("7,65,0", doorName);
    this.props.set("7,64,0", { ...doorProps, half: "lower" });
    this.props.set("7,65,0", { ...doorProps, half: "upper" });
  }
  blockAt: BlockAtFn & ((p: Vec3) => ReturnType<typeof Block.fromStateId>) = (p: Vec3) => {
    const k = `${p.x},${p.y},${p.z}`;
    const name = this.blocks.get(k) ?? "air";
    const pr = this.props.get(k);
    const b = pr ? Block.fromProperties(name, pr as never, 0) : Block.fromStateId(registry.blocksByName[name]!.defaultState!, 0);
    return Object.assign(b, { position: p.clone() }) as never;
  };
  setOpen(open: boolean): void {
    for (const k of ["7,64,0", "7,65,0"]) this.props.set(k, { ...this.props.get(k)!, open: String(open) });
  }
  isOpen(): boolean {
    return this.props.get("7,64,0")!.open === "true";
  }
}

function fakeBot(world: World, withPlugin: boolean, pos = new Vec3(0.5, 64, 0.5)): BotWithPathfinder {
  const bot = new EventEmitter() as unknown as Record<string, unknown>;
  bot.registry = registry;
  bot.username = "doorbot";
  bot.version = "1.21.9";
  bot.entity = { position: pos, velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0 };
  bot.entities = {};
  bot.players = {};
  bot.game = { gameMode: "survival" };
  bot.inventory = { items: () => [] };
  bot.world = {};
  bot.blockAt = world.blockAt;
  bot.setControlState = () => {};
  bot.clearControlStates = () => {};
  bot.loadPlugin = (fn: (b: unknown) => void) => fn(bot);
  if (withPlugin) (bot.loadPlugin as (fn: unknown) => void)(pathfinder);
  return bot as unknown as BotWithPathfinder;
}

// 1. ROOT CAUSE: real A* + postProcessPath mangles the door node.
{
  const world = new World();
  const b = fakeBot(world, true);
  ensureMovements(b);
  const r = b.pathfinder.getPathTo(b.pathfinder.movements, new goals.GoalBlock(8, 64, 0), 3000) as unknown as { status: string; path: Array<{ x: number; y: number; z: number }> };
  assert.equal(r.status, "success");
  const doorNode = r.path.find((n) => Math.floor(n.x) === 7)!;
  assert.ok(doorNode.y > 64.5, `precondition: pathfinder lifts the door node (y=${doorNode.y})`);
  assert.ok(doorNode.x !== 7.5, "precondition: and offsets it by the leaf shape");
  assert.equal(doorCellForNode(doorNode, world.blockAt)!.position.toString(), "(7, 64, 0)", "mangled node still maps to the door");
  const fixed = normalizeDoorNodes(r.path, world.blockAt);
  assert.equal(fixed, 1);
  assert.deepEqual([doorNode.x, doorNode.y, doorNode.z], [7.5, 64, 0.5], "normalized to cell centre at feet level");
  // the unrelated nodes were not touched
  assert.deepEqual([r.path[0]!.x, r.path[0]!.y], [1.5, 64]);
  assert.equal(normalizeDoorNodes(r.path, world.blockAt), 0, "idempotent");
}

// 2. findDoorAhead: path-based (no yaw), reach, open/closed, hinge/facing variants.
{
  const world = new World();
  const nodes = [{ x: 5.5, y: 64, z: 0.5 }, { x: 6.5, y: 64, z: 0.5 }, { x: 7.5, y: 64, z: 0.5 }, { x: 8.5, y: 64, z: 0.5 }];
  const at = (x: number, rest = nodes.slice(Math.max(0, Math.floor(x - 5.5)))) => findDoorAhead(new Vec3(x, 64, 0.5), rest, world.blockAt);
  assert.equal(at(4.5), null, "3 blocks away: not yet");
  const hit = at(5.6, nodes.slice(1));
  assert.ok(hit, "~2 blocks away with the door among the next nodes");
  assert.equal(hit!.axis, "x");
  assert.equal(hit!.door.position.toString(), "(7, 64, 0)");
  assert.ok(findDoorAhead(new Vec3(6.5, 64, 0.5), nodes.slice(2), world.blockAt), "adjacent");
  // inside the door cell with the way out in the path
  assert.ok(findDoorAhead(new Vec3(7.5, 64, 0.5), [{ x: 7.5, y: 64, z: 0.5 }, { x: 8.5, y: 64, z: 0.5 }], world.blockAt), "standing in the cell, closed door");
  world.setOpen(true);
  assert.equal(findDoorAhead(new Vec3(6.5, 64, 0.5), nodes.slice(2), world.blockAt), null, "open door does not block");
  // every facing x hinge x open: a leaf blocks x-travel iff closed (leaf spans z-edge) or (open and leaf lies across the path).
  for (const facing of ["north", "south", "east", "west"]) for (const hinge of ["left", "right"]) for (const open of ["true", "false"]) {
    const w = new World({ facing, hinge, open });
    const blocks = blocksTravel(w.blockAt(new Vec3(7, 64, 0)) as never, "x");
    const blocksZ = blocksTravel(w.blockAt(new Vec3(7, 64, 0)) as never, "z");
    // A door can never block both axes and is never "open and across both".
    assert.ok(!(blocks && blocksZ && open === "true"), `${facing}/${hinge}/open=${open}`);
  }
  // fence gate and iron door
  const gate = new World({ facing: "west", open: "false", in_wall: "false", powered: "false" }, "oak_fence_gate");
  gate.props.delete("7,65,0"); gate.blocks.delete("7,65,0"); gate.props.set("7,64,0", { facing: "west", open: "false", in_wall: "false", powered: "false" });
  assert.ok(findDoorAhead(new Vec3(6.5, 64, 0.5), nodes.slice(2), gate.blockAt), "closed fence gate on path");
  const iron = new World({ facing: "west", hinge: "left", open: "false" }, "iron_door");
  assert.equal(findDoorAhead(new Vec3(6.5, 64, 0.5), nodes.slice(2), iron.blockAt), null, "iron doors are never touched");
  assert.equal(pathUsesDoor(nodes.slice(1), { x: 7, y: 64, z: 0 }), true);
  assert.equal(pathUsesDoor([{ x: 9.5, y: 64, z: 0.5 }], { x: 7, y: 64, z: 0 }), false);
}

// 3. Assist loop end to end: path_update (mangled by the real pathfinder) -> open -> walk through -> close behind.
{
  process.env.BOT_TELEMETRY_DIR ??= `${process.env.TMPDIR ?? "/tmp"}/doors-check-tele`;
  const world = new World();
  const planner = fakeBot(world, true);
  ensureMovements(planner);
  const res = planner.pathfinder.getPathTo(planner.pathfinder.movements, new goals.GoalBlock(8, 64, 0), 3000) as unknown as { path: Array<{ x: number; y: number; z: number }> };
  const mangled = res.path.map((n) => ({ ...n }));
  assert.ok(mangled.some((n) => n.y > 64.5), "assist input is the mangled path");

  const pos = new Vec3(5.5, 64, 0.5);
  const bot = fakeBot(world, false, pos);
  let moving = true;
  (bot as unknown as { pathfinder: unknown }).pathfinder = { isMoving: () => moving };
  const activations: string[] = [];
  (bot as unknown as { activateBlock: (b: { position: Vec3 }) => Promise<void> }).activateBlock = async (b) => {
    activations.push(b.position.toString());
    await new Promise((r) => setTimeout(r, 30));
    world.setOpen(!world.isOpen());
  };
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    installDoorAssist(bot);
    installDoorAssist(bot); // idempotent
    const e = bot as unknown as EventEmitter;
    e.emit("goal_updated");
    const live = mangled.slice(mangled.findIndex((n) => n.y > 64.5) - 1); // from the node before the door
    e.emit("path_update", { status: "success", path: live });
    assert.ok(Math.floor(live[1]!.x) === 7 && live[1]!.y === 64, "listener repaired the live path in place");
    e.emit("physicsTick");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(activations.length, 1, "opened exactly once");
    assert.equal(world.isOpen(), true);
    assert.ok(logs.some((l) => l.includes("[door] open at 7,64,0")), "log tag");
    e.emit("physicsTick");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(activations.length, 1, "no re-toggle while open");
    // walk through and beyond: door closes behind us
    live.shift(); live.shift();
    pos.x = 8.5;
    e.emit("physicsTick");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(activations.length, 1, "still inside close-behind distance");
    pos.x = 10.5; pos.z = 0.5;
    moving = false;
    e.emit("physicsTick");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(activations.length, 2);
    assert.equal(world.isOpen(), false, "closed behind");
    assert.ok(logs.some((l) => l.includes("[door] close at 7,64,0")), "close log tag");
  } finally {
    console.log = origLog;
  }
}

console.log("doors.check: all assertions passed");
