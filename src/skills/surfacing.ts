/**
 * Pure geometry for the drowning / suffocation reflex (v2 regression R6).
 *
 * The bot died swimming along a flooded tunnel under a sandstone roof: oxygen
 * ran out 15 s after it went under and nothing took it back up. These helpers
 * answer, over a `blockAt` function (so they unit-test without a bot):
 *  - {@link findAirRoute}: the shortest swim from the head cell to a cell where
 *    the head is in air (and the body fits), through water/air only.
 *  - {@link findRoofDig}: when the water is sealed, the cheapest natural roof to
 *    dig through from inside it, never under a falling block.
 * The executor (controls, digging, telemetry) lives in `auto-behaviors.ts`.
 */

import { Vec3 } from "vec3";
import { isCheapBreak, isFallingBlockName, isNaturalTerrain } from "./structure-guard.js";

export type CellBlock = { name: string; boundingBox?: string } | null | undefined;
export type CellAt = (p: Vec3) => CellBlock;

const WET_RE = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
export const isWet = (b: CellBlock): boolean => !!b && WET_RE.test(b.name);
/** Something the body can occupy: not solid, not lava, and loaded. */
export const isPassable = (b: CellBlock): boolean => !!b && b.boundingBox !== "block" && b.name !== "lava";

const k = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;

const MOVES: ReadonlyArray<[number, number, number]> = [
  [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0],
];

/** Head cell `h` is usable when the head and the feet cell below it are both free. */
function fits(at: CellAt, h: Vec3): boolean {
  return isPassable(at(h)) && isPassable(at(h.offset(0, -1, 0)));
}

export interface AirRoute {
  /** Head cells to move through, nearest first; the last one has its head in air. */
  path: Vec3[];
}

export interface SwimSearchOptions {
  radius?: number;
  maxCells?: number;
}

interface Reach {
  /** Visited head cells -> previous cell key (start maps to null). */
  prev: Map<string, string | null>;
  cells: Map<string, Vec3>;
  /** Steps from the start. */
  dist: Map<string, number>;
  firstAir: Vec3 | null;
}

function flood(at: CellAt, start: Vec3, opts: SwimSearchOptions): Reach {
  const radius = opts.radius ?? 20;
  const maxCells = opts.maxCells ?? 6000;
  const prev = new Map<string, string | null>([[k(start), null]]);
  const cells = new Map<string, Vec3>([[k(start), start]]);
  const dist = new Map<string, number>([[k(start), 0]]);
  const queue: Vec3[] = [start];
  let firstAir: Vec3 | null = null;
  for (let i = 0; i < queue.length && queue.length < maxCells; i++) {
    const c = queue[i]!;
    if (!firstAir && i > 0 && !isWet(at(c)) && fits(at, c)) firstAir = c;
    for (const [dx, dy, dz] of MOVES) {
      const n = new Vec3(c.x + dx, c.y + dy, c.z + dz);
      if (Math.abs(n.x - start.x) > radius || Math.abs(n.z - start.z) > radius || Math.abs(n.y - start.y) > radius) continue;
      const nk = k(n);
      if (prev.has(nk) || !fits(at, n)) continue;
      prev.set(nk, k(c));
      cells.set(nk, n);
      dist.set(nk, (dist.get(k(c)) ?? 0) + 1);
      queue.push(n);
    }
  }
  return { prev, cells, dist, firstAir };
}

function pathTo(r: Reach, goal: Vec3): Vec3[] {
  const out: Vec3[] = [];
  let key: string | null | undefined = k(goal);
  while (key) {
    const cell = r.cells.get(key);
    const p: string | null | undefined = r.prev.get(key);
    if (!cell || p === null) break; // reached the start (not included)
    out.push(cell);
    key = p;
  }
  return out.reverse();
}

/** Shortest swim from head cell `head` to a cell with the head in air. null when no air is reachable. */
export function findAirRoute(at: CellAt, head: Vec3, opts: SwimSearchOptions = {}): AirRoute | null {
  const r = flood(at, head, opts);
  return r.firstAir ? { path: pathTo(r, r.firstAir) } : null;
}

export interface RoofDig {
  /** Head cell to swim to first. */
  stand: Vec3;
  swim: Vec3[];
  /** Blocks to break, lowest first. */
  dig: Vec3[];
}

const ROOF_MAX_THICKNESS = 3;
const ROOF_AIR_SCAN = 8;

/**
 * Sealed water: the cheapest natural ceiling to dig through. Candidate = a
 * reachable water head cell with 1..{@link ROOF_MAX_THICKNESS} natural solid blocks
 * above it followed by free space that leads to air. Never a column that has a
 * falling block (sand/gravel) in or directly above the dug cells, which would drop on
 * the bot's head.
 */
export function findRoofDig(at: CellAt, head: Vec3, opts: SwimSearchOptions = {}): RoofDig | null {
  const r = flood(at, head, opts);
  let best: { cell: Vec3; dig: Vec3[]; score: number } | null = null;
  for (const [key, cell] of r.cells) {
    const dig: Vec3[] = [];
    let y = cell.y + 1;
    let ok = true;
    for (; dig.length <= ROOF_MAX_THICKNESS; y++) {
      const b = at(new Vec3(cell.x, y, cell.z));
      if (!b) { ok = false; break; }
      if (b.boundingBox === "block") {
        if (!(isNaturalTerrain(b.name) || isCheapBreak(b.name)) || isFallingBlockName(b.name)) { ok = false; break; }
        dig.push(new Vec3(cell.x, y, cell.z));
        continue;
      }
      break;
    }
    if (!ok || dig.length === 0 || dig.length > ROOF_MAX_THICKNESS) continue;
    // free space above the roof, with a falling block never directly over the last dug cell
    const above = at(new Vec3(cell.x, y, cell.z));
    if (!isPassable(above) || (above && isFallingBlockName(above.name))) continue;
    let air = false;
    for (let j = 0; j < ROOF_AIR_SCAN; j++) {
      const b = at(new Vec3(cell.x, y + j, cell.z));
      if (!isPassable(b)) break;
      if (!isWet(b)) { air = true; break; }
    }
    if (!air) continue;
    const score = (r.dist.get(key) ?? 0) + 3 * dig.length;
    if (!best || score < best.score) best = { cell, dig, score };
  }
  return best ? { stand: best.cell, swim: pathTo(r, best.cell), dig: best.dig } : null;
}

/**
 * Suffocation test: is the eye point inside a full solid cube that suffocates?
 * (Leaves, glass, ice and partial shapes do not.)
 */
export function suffocatingBlock(b: (CellBlock & { shapes?: number[][] }) | null | undefined): boolean {
  if (!b || b.boundingBox !== "block") return false;
  if (/leaves|glass|ice$|scaffolding|slime|honey|barrier/.test(b.name)) return false;
  const s = b.shapes;
  return !!s && s.length === 1 && s[0]!.length >= 6 && s[0]![0]! <= 0.01 && s[0]![1]! <= 0.01 && s[0]![2]! <= 0.01 && s[0]![3]! >= 0.99 && s[0]![4]! >= 0.99 && s[0]![5]! >= 0.99;
}
