/**
 * Night survival, pure parts (v2 slice 2c-B): the clock, the shelter's
 * geometry in world coordinates, and the choice of building material.
 *
 * The bot-bound half (walk in, close up, light, wait, walk out) is
 * `steps/night.ts`; the runner sequences it after the `shelter` blueprint
 * (see `runBuildJob`) or instead of it when a bed is at hand.
 */
import { buildBlueprint } from "../build/blueprints.js";
import { dirVec, type Cell, type Facing } from "../build/types.js";

/** Day ticks (0..24000): sunset ~12000, mobs spawn from ~12500, sunrise ~23000, undead burn from ~23500. */
export const NIGHT_BEGINS = 10_500; // early: a shelter takes minutes to build
export const DAWN = 23_500;

export function inNightWindow(timeOfDay: number): boolean {
  return timeOfDay >= NIGHT_BEGINS && timeOfDay < DAWN;
}

/** Ticks until dawn from `timeOfDay` (0 once it is day). */
export function ticksToDawn(timeOfDay: number): number {
  return inNightWindow(timeOfDay) ? DAWN - timeOfDay : 0;
}

/** Walls below this many blocks of one kind in the inventory are not worth planning around. */
export const SHELTER_BLOCKS = 57; // 30 wall + 25 roof + the 2-block plug

const SOLID_PREFERENCE = ["cobblestone", "cobbled_deepslate", "dirt", "coarse_dirt", "netherrack", "stone", "andesite", "diorite", "granite"] as const;

/**
 * Cheapest wall material: what the bot already holds enough of (cobblestone,
 * dirt, any planks), else dirt (dug by hand from the ground, no tool needed).
 */
export function pickShelterWall(inv: Record<string, number>): string {
  for (const b of SOLID_PREFERENCE) if ((inv[b] ?? 0) >= SHELTER_BLOCKS) return b;
  let planks: string | null = null;
  let n = 0;
  for (const [k, v] of Object.entries(inv)) if (/_planks$/.test(k) && v >= SHELTER_BLOCKS && v > n) [planks, n] = [k, v];
  if (planks) return planks;
  // Not enough of any one kind: the block we hold most of, if it is a cheap solid and already covers most of the job
  let best: string | null = null;
  let bestN = 0;
  for (const b of SOLID_PREFERENCE) if ((inv[b] ?? 0) > bestN) [best, bestN] = [b, inv[b] ?? 0];
  return best !== null && bestN >= SHELTER_BLOCKS / 2 ? best : "dirt";
}

export function holdsDoor(inv: Record<string, number>): boolean {
  return Object.entries(inv).some(([k, v]) => /_door$/.test(k) && k !== "iron_door" && v > 0);
}

export interface ShelterGeometry {
  /** The doorway: lower and upper cell (the door goes in `doorway[0]`). */
  doorway: [Cell, Cell];
  /** Interior cell right behind the doorway (stand here to open / close / plug). */
  inside: Cell;
  /** Middle of the 3x3 interior (floor level). */
  centre: Cell;
  /** A back corner of the interior (torch spot). */
  corner: Cell;
  /** Cell just outside the doorway. */
  outside: Cell;
  hasDoor: boolean;
  /** The wall block (also what plugs a door-less doorway). */
  wall: string;
}

/** World-space key cells of a built shelter. `door` must match the blueprint params. */
export function shelterGeometry(origin: Cell, facing: Facing, door: boolean, wall = "dirt"): ShelterGeometry {
  const bp = buildBlueprint("shelter", { wall, door }, facing);
  const gap = (door ? bp.placements.filter((p) => p.role === "door").map((p) => ({ x: p.x, y: p.y, z: p.z })) : bp.clear).sort((a, b) => a.y - b.y);
  const lo = gap[0]!;
  const hi = gap[1] ?? { ...lo, y: lo.y + 1 };
  const abs = (c: Cell): Cell => ({ x: c.x + origin.x, y: c.y + origin.y, z: c.z + origin.z });
  const out = dirVec(facing);
  const step = (c: Cell, k: number): Cell => ({ x: c.x + out.x * k, y: c.y, z: c.z + out.z * k });
  const perp = { x: -out.z, z: out.x };
  const doorway: [Cell, Cell] = [abs(lo), abs(hi)];
  const back = step(abs(lo), -3);
  return {
    doorway,
    inside: step(abs(lo), -1),
    centre: step(abs(lo), -2),
    corner: { x: back.x + perp.x, y: back.y, z: back.z + perp.z },
    outside: step(abs(lo), 1),
    hasDoor: door,
    wall,
  };
}
