/**
 * Offline check: mineBlock/mineBlocks count what lands in the inventory (drop
 * entity spawns AFTER the dig, pickups are by inventory delta), skip
 * unreachable blocks, and honour a stop request.
 *
 * Run from a scratch cwd (state persistence writes under ./data/):
 *   cd $(mktemp -d) && BOT_TELEMETRY_DIR=$PWD/tele \
 *     /path/to/repo/node_modules/.bin/tsx /path/to/repo/src/skills/__checks__/gather-counting.check.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import minecraftData from "minecraft-data";
import pathfinderPkg from "mineflayer-pathfinder";
import PrismarineBlock from "prismarine-block";
import { Vec3 } from "vec3";
import { createBotState, registerBotState, getBotState } from "../../state/index.js";
import { mineBlock, mineBlocks } from "../world.js";
import { pickUpNearby, waitForDropNear } from "../inventory.js";
import type { Bot } from "mineflayer";

const { pathfinder } = pathfinderPkg;
const registry = minecraftData("1.21.9");
const Block = PrismarineBlock(registry as never);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Opts {
  spawnDelayMs?: number;
  /** block keys whose drop never spawns (e.g. falls in lava) */
  noDrop?: Set<string>;
  /** block keys with no walkable approach */
  unreachable?: Set<string>;
  full?: boolean;
  startInv?: Array<[string, number]>;
  onDig?: (n: number) => void;
}

function makeBot(name: string, blocks: Map<string, string>, o: Opts = {}) {
  const bot = new EventEmitter() as unknown as Record<string, any>;
  bot.registry = registry;
  bot.username = name;
  bot.version = "1.21.9";
  bot.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, height: 1.62 };
  bot.entities = {} as Record<string, any>;
  bot.game = { gameMode: "survival" };
  let lastTarget: Vec3 | null = null;
  bot.world = { raycast: () => (lastTarget ? { position: lastTarget } : null) };
  bot.heldItem = null;
  const inv = new Map<string, number>(o.startInv ?? []);
  inv.set("stone_pickaxe", 1);
  inv.set("stone_axe", 1);
  bot.inventory = {
    items: () => [...inv].map(([n, c]) => ({ name: n, count: c, type: registry.itemsByName[n]!.id })),
    emptySlotCount: () => (o.full ? 0 : 20),
  };
  const mk = (p: Vec3) => {
    const n = blocks.get(`${p.x},${p.y},${p.z}`) ?? "air";
    const b = Block.fromStateId(registry.blocksByName[n]!.defaultState!, 0);
    (b as any).position = p.clone();
    return b;
  };
  bot.blockAt = mk;
  bot.findBlocks = ({ matching, count }: { matching: number | number[]; count: number }) => {
    const ids = Array.isArray(matching) ? matching : [matching];
    const out: Vec3[] = [];
    for (const [k, n] of blocks) {
      if (!ids.includes(registry.blocksByName[n]!.id)) continue;
      const [x, y, z] = k.split(",").map(Number) as [number, number, number];
      out.push(new Vec3(x, y, z));
    }
    const me = bot.entity.position as Vec3;
    out.sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
    return out.slice(0, count);
  };
  bot.findBlock = (opts: any) => bot.blockAt(bot.findBlocks({ ...opts, count: 1 })[0] ?? new Vec3(9999, 0, 0));
  bot.equip = async () => {};
  bot.setControlState = () => {};
  bot.clearControlStates = () => {};
  bot.digTime = () => 100;
  bot.stopDigging = () => {};
  let digs = 0;
  let nextId = 1000;
  bot.dig = async (block: any) => {
    const key = `${block.position.x},${block.position.y},${block.position.z}`;
    const dropItem = registry.items[(registry.blocks[block.type]!.drops as unknown as number[])[0]!]!.name;
    blocks.delete(key);
    digs += 1;
    o.onDig?.(digs);
    if (o.noDrop?.has(key)) return;
    const pos = block.position.offset(0.5, 0.2, 0.5);
    setTimeout(() => {
      const id = nextId++;
      const ent = { id, name: "item", position: pos, getDroppedItem: () => ({ name: dropItem, count: 1 }), _drop: dropItem };
      bot.entities[id] = ent;
      bot.emit("entitySpawn", ent);
    }, o.spawnDelayMs ?? 200);
  };
  // Fake pathfinding: plugin supplies real API shape; we fake goto/getPathTo.
  bot.loadPlugin = (fn: any) => fn(bot);
  bot.loadPlugin(pathfinder);
  const collectNear = () => {
    for (const [id, e] of Object.entries<any>(bot.entities)) {
      if (e.position.distanceTo(bot.entity.position) <= 1.6 && !o.full) {
        inv.set(e._drop, (inv.get(e._drop) ?? 0) + 1);
        delete bot.entities[id];
      }
    }
  };
  bot.pathfinder.getPathTo = (_m: unknown, goal: any) => {
    const p = goal.pos; // only GoalLookAtBlock targets can be "unreachable" in this stub
    const key = p ? `${p.x},${p.y},${p.z}` : "";
    const digging = (bot.pathfinder.movements as any).canDig;
    return { status: o.unreachable?.has(key) && (!digging || o.unreachable.has("*never-dig")) ? "noPath" : "success", path: [] };
  };
  bot.pathfinder.goto = async (goal: any) => {
    const p = goal.pos ?? new Vec3(goal.x, goal.y, goal.z);
    if (goal.pos) lastTarget = goal.pos;
    bot.entity.position = new Vec3(p.x + 0.5, p.y, p.z + 0.5);
    collectNear();
  };
  bot.pathfinder.isMining = () => false;
  bot.pathfinder.isBuilding = () => false;
  bot.pathfinder.isMoving = () => false;
  bot.pathfinder.stop = () => {};
  return { bot: bot as unknown as Bot, inv };
}

function logsColumn(n: number, x = 3, z = 0, name = "oak_log"): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < n; i++) m.set(`${x},${64 + i},${z}`, name);
  return m;
}

async function main(): Promise<void> {
  // 0. waitForDropNear: resolves true when the drop appears late, false when it never does.
  {
    const { bot } = makeBot("w", new Map());
    const pos = new Vec3(5, 64, 5);
    setTimeout(() => {
      const e = { id: 1, name: "item", position: pos.offset(0.3, 0, 0.3) };
      (bot as any).entities[1] = e;
      bot.emit("entitySpawn", e as never);
    }, 250);
    const t0 = Date.now();
    assert.equal(await waitForDropNear(bot, pos, 600), true);
    assert.ok(Date.now() - t0 < 500);
    assert.equal(await waitForDropNear(bot, new Vec3(50, 64, 50), 300), false);
  }

  // 1. 11 logs, drops appear 200ms AFTER the dig; asking for 10 -> collected 10 (mined 10 or 11).
  {
    registerBotState("g1", createBotState());
    const { bot, inv } = makeBot("g1", logsColumn(11));
    const r = await mineBlock(bot, { type: "oak_log", count: 10 });
    console.log("  1:", r.message, JSON.stringify(r.state));
    assert.equal(r.ok, true);
    assert.equal(inv.get("oak_log"), 10);
    assert.match(r.message, /^collected 10 oak_log/);
  }

  // 2. Some drops vanish (e.g. fell into lava): the loop keeps going until the INVENTORY has 10.
  {
    registerBotState("g2", createBotState());
    const blocks = logsColumn(14);
    const noDrop = new Set(["3,65,0", "3,67,0"]);
    const { bot, inv } = makeBot("g2", blocks, { noDrop });
    const r = await mineBlock(bot, { type: "oak_log", count: 10 });
    console.log("  2:", r.message);
    assert.equal(inv.get("oak_log"), 10);
    assert.match(r.message, /collected 10 oak_log \(mined 12\)/);
  }

  // 3. Fewer than asked exist: reports the real count, ok:true.
  {
    registerBotState("g3", createBotState());
    const { bot, inv } = makeBot("g3", logsColumn(4));
    const r = await mineBlock(bot, { type: "oak_log", count: 10 });
    console.log("  3:", r.message);
    assert.equal(r.ok, true);
    assert.equal(inv.get("oak_log"), 4);
    assert.match(r.message, /collected 4 oak_log.*no more/);
  }

  // 4. Unreachable candidates are skipped, not fatal.
  {
    registerBotState("g4", createBotState());
    const blocks = logsColumn(3, 3, 0);
    for (const [k, v] of logsColumn(3, 6, 0)) blocks.set(k, v);
    const { bot, inv } = makeBot("g4", blocks, { unreachable: new Set(["3,64,0", "3,65,0", "3,66,0", "*never-dig"]) });
    const r = await mineBlock(bot, { type: "oak_log", count: 3 });
    console.log("  4:", r.message);
    assert.equal(inv.get("oak_log"), 3);
    assert.match(r.message, /^collected 3 oak_log/);
    // x=3 column untouched: it was skipped, not dug.
    assert.equal(blocks.has("3,64,0"), true);
  }

  // 4b. Buried target (no walkable approach, but diggable): the scoped digging retry reaches it.
  {
    registerBotState("g4b", createBotState());
    const { bot, inv } = makeBot("g4b", logsColumn(2), { unreachable: new Set(["3,64,0", "3,65,0"]) });
    const r = await mineBlock(bot, { type: "oak_log", count: 2 });
    console.log("  4b:", r.message);
    assert.equal(inv.get("oak_log"), 2);
    assert.equal((bot as any).pathfinder.movements.canDig, false, "digging scope restored");
  }

  // 5. Baseline respected: existing cobblestone doesn't count; stone -> cobblestone delta.
  {
    registerBotState("g5", createBotState());
    const blocks = new Map<string, string>();
    for (let i = 0; i < 5; i++) blocks.set(`${3 + i},64,0`, "stone");
    const { bot, inv } = makeBot("g5", blocks, { startInv: [["cobblestone", 20]] });
    const r = await mineBlock(bot, { type: "stone", count: 3 });
    console.log("  5:", r.message);
    assert.equal(inv.get("cobblestone"), 23);
    assert.match(r.message, /^collected 3 cobblestone/);
  }

  // 6. Inventory full: nothing is picked up -> stops after a few fruitless digs, ok:false, says why.
  {
    registerBotState("g6", createBotState());
    const { bot } = makeBot("g6", logsColumn(10), { full: true });
    const r = await mineBlock(bot, { type: "oak_log", count: 5 });
    console.log("  6:", r.message);
    assert.equal(r.ok, false);
    assert.match(r.message, /dropped nothing|inventory is full/);
  }

  // 7. A stop landing mid-skill is not wiped by mineBlocks (no second cancellation.begin()).
  {
    registerBotState("g7", createBotState());
    const { bot, inv } = makeBot("g7", logsColumn(10), { onDig: (n) => { if (n === 2) getBotState("g7")!.cancellation.request(); } });
    const r = await mineBlock(bot, { type: "oak_log", count: 10 });
    console.log("  7:", r.message);
    assert.ok((inv.get("oak_log") ?? 0) <= 3, "stopped early");
    assert.match(r.message, /cancelled/);
    // ...and a stop requested BEFORE the skill body starts must not be erased either.
    getBotState("g7")!.cancellation.request();
    const { bot: b2 } = makeBot("g7", logsColumn(5));
    const r2 = await mineBlock(b2, { type: "oak_log", count: 5 });
    console.log("  7b:", r2.message);
    assert.match(r2.message, /cancelled|no .* within/);
    assert.equal(getBotState("g7")!.cancellation.isRequested(), true);
  }

  // 8. pickUpNearby counts the inventory delta.
  {
    const { bot, inv } = makeBot("p", new Map());
    for (let i = 0; i < 2; i++) {
      const e = { id: 50 + i, name: "item", position: new Vec3(1 + i, 64, 0), getDroppedItem: () => ({ name: "dirt" }), _drop: "dirt" };
      (bot as any).entities[e.id] = e;
    }
    const r = await pickUpNearby(bot, { maxDist: 8 });
    console.log("  8:", r.message);
    assert.equal(inv.get("dirt"), 2);
    assert.match(r.message, /picked up 2 dirt/);
  }

  console.log("gather-counting: all assertions passed");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
