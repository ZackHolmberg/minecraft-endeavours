/**
 * WorldView builder: the planner's picture of the world, from the live bot +
 * world memory. Cheap by design: a bounded `findBlocks` scan restricted to
 * block types the goal's plan could use (logs, stone, ores, sand, …), not a
 * full-world scan.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { readWorldKnowledge } from "../memory/world-knowledge.js";
import { plan as planGoals } from "../planner/plan.js";
import type { Goal, WorldView } from "../planner/types.js";
import { currentGameMode } from "../skills/game-mode.js";

export const DEFAULT_SCAN_RADIUS = 48;
const STATION_RADIUS = 32;
/** Nearest positions kept per block type (we only need count>0 and the nearest distance). */
const PER_TYPE_COUNT = 8;
const MAX_CONTAINER_DISTANCE = 200;

/** Always-scanned resource families (matched against registry block names). */
const BASE_RESOURCE = [
  /_log$/, // all tree species (stripped_* excluded below)
  /^(stone|deepslate|cobblestone|cobbled_deepslate|andesite|diorite|granite|tuff)$/,
  /_ore$/,
  /^(sand|red_sand|gravel|clay|sugar_cane|pumpkin|melon|bamboo|obsidian|wheat)$/,
];

/** Names (from `names`) the scan should look for, given the planner's gather blocks for these goals. */
export function relevantBlockNames(names: readonly string[], goalBlocks: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (n.startsWith("stripped_")) continue;
    if (BASE_RESOURCE.some((re) => re.test(n))) out.add(n);
  }
  for (const b of goalBlocks) if (names.includes(b)) out.add(b);
  return [...out];
}

/** Blocks the planner would gather for `goals` with nothing in view (so we scan for all of them). */
export function goalGatherBlocks(goals: Goal[], inventory: Record<string, number>, position: { x: number; y: number; z: number }): string[] {
  const empty: WorldView = {
    inventory,
    gameMode: "survival",
    nearbyBlocks: {},
    stations: { crafting_table: false, furnace: false },
    containers: [],
    position,
    dimension: "overworld",
  };
  const p = planGoals(goals, empty);
  const out = new Set<string>();
  for (const s of p.steps) if (s.op === "gather") for (const b of s.blocks) out.add(b);
  return [...out];
}

/** Item → count over main inventory, hotbar, armor and offhand (not the crafting grid). */
export function inventoryTotals(slots: ReadonlyArray<{ name: string; count: number } | null | undefined>): Record<string, number> {
  const inv: Record<string, number> = {};
  slots.forEach((it, i) => {
    if (!it) return;
    if (i >= 1 && i <= 4) return; // 2x2 crafting grid (slot 0 = craft output)
    if (i === 0) return;
    inv[it.name] = (inv[it.name] ?? 0) + it.count;
  });
  return inv;
}

function dimensionOf(bot: Bot): WorldView["dimension"] {
  const d = String(bot.game?.dimension ?? "overworld");
  if (d.includes("nether")) return "the_nether";
  if (d.includes("end")) return "the_end";
  return "overworld";
}

export async function buildWorldView(bot: Bot, goals: Goal[], radius: number = DEFAULT_SCAN_RADIUS): Promise<WorldView> {
  const mode = currentGameMode(bot);
  const pos = bot.entity.position;
  const position = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  const inventory = inventoryTotals(bot.inventory.slots);

  const nearbyBlocks: WorldView["nearbyBlocks"] = {};
  const registryNames = Object.keys(bot.registry.blocksByName);
  const wanted = relevantBlockNames(registryNames, goalGatherBlocks(goals, inventory, position));
  for (const name of wanted) {
    const id = bot.registry.blocksByName[name]?.id;
    if (id === undefined) continue;
    const found = bot.findBlocks({ point: pos, matching: id, maxDistance: radius, count: PER_TYPE_COUNT });
    if (found.length === 0) continue;
    let nearest = Infinity;
    for (const p of found) nearest = Math.min(nearest, p.distanceTo(pos));
    nearbyBlocks[name] = { count: found.length, nearest: Math.round(nearest * 10) / 10 };
  }

  const near = (block: string): boolean => {
    const id = bot.registry.blocksByName[block]?.id;
    return id !== undefined && bot.findBlock({ point: pos, matching: id, maxDistance: STATION_RADIUS }) !== null;
  };
  const stations = { crafting_table: near("crafting_table"), furnace: near("furnace") };

  const containers: WorldView["containers"] = [];
  try {
    const world = await readWorldKnowledge(bot.username);
    for (const c of world.containers) {
      if (!c.contents || c.contents.length === 0) continue;
      if (new Vec3(c.position.x, c.position.y, c.position.z).distanceTo(pos) > MAX_CONTAINER_DISTANCE) continue;
      const items: Record<string, number> = {};
      for (const it of c.contents) items[it.item] = (items[it.item] ?? 0) + it.count;
      containers.push({ pos: { x: c.position.x, y: c.position.y, z: c.position.z }, items });
    }
  } catch {
    // world memory is optional
  }

  return {
    inventory,
    gameMode: mode === "creative" ? "creative" : "survival",
    nearbyBlocks,
    stations,
    containers,
    position,
    dimension: dimensionOf(bot),
  };
}
