/**
 * Material math for a blueprint (pure): what the build consumes, what the bot
 * is missing (as planner goals), what to take with getItems in creative.
 * Tools (hoe) and any-door/any-hoe substitutions are handled here.
 */
import { scaffoldCount } from "./support.js";
import type { BlockPlacement, Blueprint } from "./types.js";

/** Scaffold material preference: cheap, mined by hand or common, never a natural-looking player block. */
export const SCAFFOLD_ITEMS = ["dirt", "cobblestone", "netherrack", "cobbled_deepslate", "coarse_dirt"] as const;
const HOES = ["netherite_hoe", "diamond_hoe", "iron_hoe", "stone_hoe", "golden_hoe", "wooden_hoe"];
/** Seeds a "small" farm should have in hand before starting (the rest of the plot is planted as seeds allow). */
export const FARM_SEEDS_TARGET = 9;
/** Blocks that close a door-less shelter's doorway from inside. */
export const SHELTER_PLUG = 2;

export interface NeedsOptions {
  creative: boolean;
  /** Scaffold blocks the ordering needs on the real terrain; omitted ⇒ computed for ideal flat ground. */
  scaffolds?: number;
}

export interface BuildNeeds {
  /** Item → count consumed (inventory must hold these to start). Tools excluded. */
  consumed: Record<string, number>;
  /** A tool/any-of item that must be present (not consumed): item list, first is what the planner makes. */
  tools: string[][];
  scaffoldItem: string | null;
  scaffoldCount: number;
  /** Optional blocks left out for lack of material (glass windows → open holes). */
  skippedOptional: Record<string, number>;
  /** Items still missing (planner goals / creative getItems), after substituting what the bot holds. */
  missing: Array<{ item: string; count: number }>;
  /** Scaffold dirt the executor digs from the ground itself (cheaper and more reliable than a planner gather); not in `missing`. */
  selfSupply: { item: string; count: number } | null;
}

/** Inventory item that places/represents `p` (undefined: needs nothing, e.g. derived door half). */
export function itemFor(p: BlockPlacement): string | undefined {
  if (p.derived) return undefined;
  switch (p.action) {
    case "till":
      return undefined; // hoe: a tool
    case "plant":
      return "wheat_seeds";
    case "water":
      return "water_bucket";
    case "ignite":
      return "flint_and_steel";
    default:
      return p.block;
  }
}

const isAnyDoor = (n: string): boolean => /_door$/.test(n) && n !== "iron_door";

export function pickScaffold(inv: Record<string, number>): string {
  return SCAFFOLD_ITEMS.find((i) => (inv[i] ?? 0) > 0) ?? "dirt";
}

export function computeNeeds(bp: Blueprint, inv: Record<string, number>, opts: NeedsOptions): BuildNeeds {
  const consumed: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const tools: string[][] = [];
  let doorWanted: string | null = null;
  let seeds = 0;
  for (const p of bp.placements) {
    if (p.derived) continue;
    if (p.action === "till" && !tools.some((t) => t[0] === "wooden_hoe")) tools.push(["wooden_hoe", ...HOES.filter((h) => h !== "wooden_hoe")]);
    const item = itemFor(p);
    if (!item) continue;
    if (p.role === "door") {
      doorWanted = item;
      continue;
    }
    if (item === "wheat_seeds") {
      seeds += 1;
      continue;
    }
    consumed[item] = (consumed[item] ?? 0) + 1;
  }
  // a door-less shelter is closed behind the bot with two wall blocks (the doorway is 2 high)
  if (bp.kind === "shelter" && !bp.placements.some((p) => p.role === "door")) {
    const wall = typeof bp.params.wall === "string" ? bp.params.wall : bp.placements.find((p) => p.role === "wall")?.block;
    if (wall) consumed[wall] = (consumed[wall] ?? 0) + SHELTER_PLUG;
  }
  // optional blocks (glass): only as many as the bot holds; creative has them all
  for (const [item, n] of Object.entries({ ...consumed })) {
    const p = bp.placements.find((q) => q.block === item && q.optional);
    if (!p) continue;
    if (opts.creative) continue;
    const have = inv[item] ?? 0;
    const use = Math.min(n, have);
    if (use < n) skipped[item] = n - use;
    if (use > 0) consumed[item] = use;
    else delete consumed[item];
  }
  if (seeds > 0) consumed["wheat_seeds"] = Math.min(seeds, FARM_SEEDS_TARGET);
  const scaff = opts.scaffolds ?? scaffoldCount(bp.placements, bp.clear);
  const scaffoldItem = scaff > 0 ? pickScaffold(inv) : null;
  if (scaffoldItem) consumed[scaffoldItem] = (consumed[scaffoldItem] ?? 0) + scaff;

  const missing: Array<{ item: string; count: number }> = [];
  let selfSupply: BuildNeeds["selfSupply"] = null;
  for (const [item, n] of Object.entries(consumed)) {
    const short = n - (inv[item] ?? 0);
    if (short <= 0) continue;
    // A dirt shelter's walls are dug by the executor too (planner gathers lose their drops on grass; `acquire` collects reliably)
    if (bp.kind === "shelter" && item === "dirt" && !opts.creative) {
      selfSupply = { item, count: short };
      continue;
    }
    if (item === scaffoldItem && item === "dirt" && !opts.creative) {
      const self = Math.min(short, scaff);
      selfSupply = { item, count: self };
      if (short - self > 0) missing.push({ item, count: short - self });
      continue;
    }
    missing.push({ item, count: short });
  }
  if (doorWanted) {
    const hasDoor = Object.keys(inv).some((k) => isAnyDoor(k) && (inv[k] ?? 0) > 0);
    if (!hasDoor) missing.push({ item: doorWanted, count: 1 });
  }
  for (const t of tools) {
    if (!t.some((i) => (inv[i] ?? 0) > 0)) missing.push({ item: t[0]!, count: 1 });
  }
  return { consumed, tools, scaffoldItem, scaffoldCount: scaff, skippedOptional: skipped, missing, selfSupply };
}

/** Which door item in `inv` to use for `wanted` (exact match first, then any non-iron door). */
export function pickDoor(inv: Record<string, number>, wanted: string): string | null {
  if ((inv[wanted] ?? 0) > 0) return wanted;
  return Object.keys(inv).find((k) => isAnyDoor(k) && (inv[k] ?? 0) > 0) ?? null;
}

export function pickHoe(inv: Record<string, number>): string | null {
  return HOES.find((h) => (inv[h] ?? 0) > 0) ?? null;
}

/** Wall/roof planks default: the plank type the bot holds most of, else oak. */
export function defaultPlanks(inv: Record<string, number>): string {
  let best = "oak_planks";
  let n = 0;
  for (const [k, v] of Object.entries(inv)) if (/_planks$/.test(k) && v > n) [best, n] = [k, v];
  return best;
}

/** Human summary of what is missing, e.g. "12 oak_planks, 1 wooden_hoe". */
export function missingText(m: BuildNeeds["missing"]): string {
  return m.map((x) => `${x.count} ${x.item}`).join(", ");
}
