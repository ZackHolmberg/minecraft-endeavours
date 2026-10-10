/**
 * Quick night shelter, pure part (v2 slice 2c-B, "dig in"): choose where to dig a 1x2 pocket.
 *
 * What a player does at dusk with no bed and no time: dig straight down 3 blocks (a 1x2 room
 * with the top block as its lid) or tunnel 2 deep into a hillside, step in and plug the hole
 * with the dirt they just dug. Seconds of work, natural blocks only.
 *
 *  - `down`: stand on the surface column; dig `dig[0..2]` (the ground block under the feet and the two
 *    below it); the bot ends up at `rest` (the lowest cell) with its head in the cell above; `seal[0]`
 *    (the top dug cell) is refilled from inside, against a side wall.
 *  - `hill`: stand outside a hillside at `stand`; dig feet+head of two cells straight into the slope,
 *    walk to the far one (`rest`), refill the near one (`seal`, feet then head) from inside.
 *
 * Safety rules baked into the choice: only natural, diggable blocks (never ores, player builds or
 * anything within 3 blocks of crafted blocks); no falling block (sand / gravel) above a dug cell or in a
 * wall; no water or lava within 2 blocks (a dug cell next to a source floods); every wall, ceiling and
 * floor of the resting cells is solid, so a cave can't open into the pocket.
 *
 * The bot-bound half (walk, dig, seal, wait, leave) is `steps/night.ts`.
 */
import type { Cell } from "../build/types.js";
import { craftedWithin, isFallingBlockName } from "../skills/structure-guard.js";

export interface ProbeBlock {
  name: string;
  /** Full-cube collision (what holds mobs back and a block can be placed against). */
  solid: boolean;
}
/** World read; null = not loaded. */
export type Probe = (x: number, y: number, z: number) => ProbeBlock | null;

export interface PocketPlan {
  kind: "down" | "hill";
  /** Where to stand (feet cell) before the first dig. */
  stand: Cell;
  /** Cells to dig, in order. */
  dig: Cell[];
  /** Feet cell of the sealed pocket (the head is the cell above). */
  rest: Cell;
  /** Cells to refill from inside, in order. */
  seal: Cell[];
  /** Hill only: unit step from the stand cell into the slope. */
  dir?: { x: number; z: number };
  /** Rough seconds: digging + walking to `stand`. Lower is better. */
  cost: number;
  /** Filler blocks (dirt / cobble) the digging yields. */
  yields: number;
  summary: string;
}

export interface PocketOpts {
  /** Search radius (blocks, horizontal) around `from`. */
  radius?: number;
  /** The bot carries a pickaxe: stone is quick to dig and drops cobblestone. */
  hasPickaxe?: boolean;
  /** Filler blocks (dirt, cobblestone, ...) already in the inventory. */
  filler?: number;
}

export const DEFAULT_RADIUS = 8;

const SOFT = new Set(["dirt", "grass_block", "coarse_dirt", "podzol", "mycelium", "rooted_dirt", "mud", "clay", "moss_block", "snow_block"]);
const FILLER_SOFT = new Set(["dirt", "grass_block", "coarse_dirt", "podzol", "mycelium", "rooted_dirt", "mud"]);
const HARD = new Set(["stone", "granite", "diorite", "andesite", "tuff", "sandstone", "red_sandstone", "calcite"]);
const DEEP = new Set(["deepslate"]);

const LIQUID_RE = /^(water|lava|bubble_column|flowing_water|flowing_lava)$/;
/** Never a wall / floor / ceiling of a bedroom. */
const DANGER_RE = /magma|cactus|fire|powder_snow|tnt|spawner|chest|barrel|furnace|_bed$|sign|campfire|sweet_berry|cobweb|honey|slime/;

export const isLiquidName = (n: string): boolean => LIQUID_RE.test(n);

/** Seconds to dig `name` (Infinity = not allowed). */
export function digSeconds(name: string, hasPickaxe: boolean): number {
  if (SOFT.has(name)) return 0.8;
  if (HARD.has(name)) return hasPickaxe ? 1.5 : 9;
  if (DEEP.has(name)) return hasPickaxe ? 3 : 35;
  return Number.POSITIVE_INFINITY;
}

/** Does digging `name` give a block we can seal with? */
export function yieldsFiller(name: string, hasPickaxe: boolean): boolean {
  if (FILLER_SOFT.has(name)) return true;
  if (!hasPickaxe) return false;
  return (HARD.has(name) && !/sandstone/.test(name)) || DEEP.has(name);
}

const SIDES: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const passable = (b: ProbeBlock | null): boolean => !!b && !b.solid && !isLiquidName(b.name);
/** A wall / floor / ceiling that holds: solid, not a liquid, not dangerous, doesn't fall. */
const holds = (b: ProbeBlock | null): boolean => !!b && b.solid && !isLiquidName(b.name) && !DANGER_RE.test(b.name) && !isFallingBlockName(b.name);

function liquidNear(probe: Probe, c: Cell, r: number, yLo: number, yHi: number): boolean {
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let y = c.y + yLo; y <= c.y + yHi; y++) {
    const b = probe(c.x + dx, y, c.z + dz);
    if (b && isLiquidName(b.name)) return true;
  }
  return false;
}

function craftedNear(probe: Probe, c: Cell, r: number): boolean {
  return craftedWithin((p) => probe(p.x, p.y, p.z), c as never, r);
}

/** Dig-time of a cell, or Infinity when it may not be dug (not terrain, unloaded). */
function digCost(probe: Probe, c: Cell, hasPickaxe: boolean): number {
  const b = probe(c.x, c.y, c.z);
  return b && b.solid ? digSeconds(b.name, hasPickaxe) : Number.POSITIVE_INFINITY;
}

/** A free stand cell: air to stand in, air above, a solid floor. */
function standable(probe: Probe, x: number, y: number, z: number): boolean {
  return passable(probe(x, y, z)) && passable(probe(x, y + 1, z)) && !!probe(x, y - 1, z)?.solid && !isLiquidName(probe(x, y - 1, z)!.name);
}

function evalDown(probe: Probe, x: number, topY: number, z: number, from: Cell, o: Required<PocketOpts>): PocketPlan | null {
  const dig: Cell[] = [0, 1, 2].map((i) => ({ x, y: topY - i, z }));
  let secs = 0;
  let yields = 0;
  for (const c of dig) {
    const t = digCost(probe, c, o.hasPickaxe);
    if (!Number.isFinite(t)) return null;
    secs += t;
    if (yieldsFiller(probe(c.x, c.y, c.z)!.name, o.hasPickaxe)) yields += 1;
  }
  if (yields + o.filler < 1) return null;
  if (!standable(probe, x, topY + 1, z)) return null;
  if (!holds(probe(x, topY - 3, z))) return null;
  // walls of the two resting cells; the lid cell needs one wall to place against and nothing flowing in
  for (const y of [topY - 1, topY - 2]) for (const [dx, dz] of SIDES) if (!holds(probe(x + dx, y, z + dz))) return null;
  if (!SIDES.some(([dx, dz]) => holds(probe(x + dx, topY, z + dz)))) return null;
  if (liquidNear(probe, { x, y: topY - 1, z }, 2, -3, 2)) return null;
  if (craftedNear(probe, { x, y: topY - 1, z }, 3)) return null;
  const stand = { x, y: topY + 1, z };
  const dist = Math.hypot(x + 0.5 - (from.x + 0.5), z + 0.5 - (from.z + 0.5)) + Math.abs(stand.y - from.y);
  return {
    kind: "down",
    stand,
    dig,
    rest: { x, y: topY - 2, z },
    seal: [{ x, y: topY, z }],
    cost: secs + 0.4 * dist,
    yields,
    summary: `dig down 3 at (${x}, ${topY}, ${z}) and seal the top`,
  };
}

function evalHill(probe: Probe, stand: Cell, dx: number, dz: number, from: Cell, o: Required<PocketOpts>): PocketPlan | null {
  const at = (k: number, up: number): Cell => ({ x: stand.x + dx * k, y: stand.y + up, z: stand.z + dz * k });
  const dig = [at(1, 0), at(1, 1), at(2, 0), at(2, 1)];
  let secs = 0;
  let yields = 0;
  for (const c of dig) {
    const t = digCost(probe, c, o.hasPickaxe);
    if (!Number.isFinite(t)) return null;
    secs += t;
    if (yieldsFiller(probe(c.x, c.y, c.z)!.name, o.hasPickaxe)) yields += 1;
  }
  if (yields + o.filler < 2) return null;
  // the far cell is the room: roof, floor, far wall and both sides hold; the near cell's floor is what we seal against and walk on
  const far = [at(2, 0), at(2, 1)];
  if (!holds(probe(far[1]!.x, far[1]!.y + 1, far[1]!.z))) return null;
  if (!holds(probe(far[0]!.x, far[0]!.y - 1, far[0]!.z))) return null;
  if (!holds(probe(at(3, 0).x, at(3, 0).y, at(3, 0).z)) || !holds(probe(at(3, 1).x, at(3, 1).y, at(3, 1).z))) return null;
  for (const c of far) for (const [sx, sz] of [[-dz, dx], [dz, -dx]] as const) if (!holds(probe(c.x + sx, c.y, c.z + sz))) return null;
  const near1 = at(1, 0);
  if (!holds(probe(near1.x, near1.y - 1, near1.z))) return null;
  // nothing may drop into the near cells when they are dug
  for (const c of [at(1, 1), at(2, 1)]) {
    const up = probe(c.x, c.y + 1, c.z);
    if (!up || isFallingBlockName(up.name)) return null;
  }
  if (liquidNear(probe, at(2, 0), 2, -2, 3)) return null;
  if (craftedNear(probe, at(2, 0), 3)) return null;
  const dist = Math.hypot(stand.x - from.x, stand.z - from.z) + Math.abs(stand.y - from.y);
  return {
    kind: "hill",
    stand,
    dig,
    rest: at(2, 0),
    seal: [at(1, 0), at(1, 1)],
    dir: { x: dx, z: dz },
    cost: secs + 0.4 * dist + 1.5, // a longer job than straight down: ties go to digging down
    yields,
    summary: `tunnel 2 deep into the slope at (${at(1, 0).x}, ${at(1, 0).y}, ${at(1, 0).z}) and seal the entrance`,
  };
}

/** Topmost standable surface of a column near `y0`: the y of its top solid block, or null. */
function surfaceY(probe: Probe, x: number, z: number, y0: number): number | null {
  for (let y = y0 + 3; y >= y0 - 6; y--) {
    const b = probe(x, y, z);
    if (!b) return null;
    if (b.solid || isLiquidName(b.name)) return standable(probe, x, y + 1, z) ? y : null;
  }
  return null;
}

/**
 * All viable pockets near `from` (the bot's feet cell), best (cheapest) first. Pure over `probe`.
 */
export function choosePockets(probe: Probe, from: Cell, opts: PocketOpts = {}): PocketPlan[] {
  const o: Required<PocketOpts> = { radius: opts.radius ?? DEFAULT_RADIUS, hasPickaxe: opts.hasPickaxe ?? false, filler: opts.filler ?? 0 };
  const plans: PocketPlan[] = [];
  for (let x = from.x - o.radius; x <= from.x + o.radius; x++) {
    for (let z = from.z - o.radius; z <= from.z + o.radius; z++) {
      if (Math.hypot(x - from.x, z - from.z) > o.radius) continue;
      const top = surfaceY(probe, x, z, from.y);
      if (top === null) continue;
      const down = evalDown(probe, x, top, z, from, o);
      if (down) plans.push(down);
      const stand = { x, y: top + 1, z };
      for (const [dx, dz] of SIDES) {
        const hill = evalHill(probe, stand, dx, dz, from, o);
        if (hill) plans.push(hill);
      }
    }
  }
  return plans.sort((a, b) => a.cost - b.cost);
}

export function choosePocket(probe: Probe, from: Cell, opts: PocketOpts = {}): PocketPlan | null {
  return choosePockets(probe, from, opts)[0] ?? null;
}
