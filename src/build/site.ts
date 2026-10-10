/**
 * Build-site choice over an abstract block grid (pure; the bot adapter lives in
 * src/jobs/steps/build.ts).
 *
 * "Here" = near an anchor (the requesting player, else the bot). The site is the
 * footprint nearest the anchor whose ground is natural, level within 1 block
 * (0 for farms), with only replaceable blocks (grass, flowers, snow layers)
 * above it, and no player-built blocks inside or right next to it. The
 * requesting player's position is never inside the footprint. Replaceables to
 * clear and any 1-block foundation fill are returned for the executor.
 */
import { isCraftedBlockName, isNaturalTerrain } from "../skills/structure-guard.js";
import { canonicalFootprint } from "./blueprints.js";
import type { BlueprintKind, Cell, Facing } from "./types.js";

/** Block name at a cell; null when the chunk isn't loaded. */
export interface WorldGrid {
  blockAt(x: number, y: number, z: number): string | null;
}

const AIRS = new Set(["air", "cave_air", "void_air"]);
const REPLACEABLE_EXACT = new Set([
  "short_grass", "grass", "tall_grass", "fern", "large_fern", "dead_bush", "snow", "vine", "glow_lichen", "hanging_roots",
  "dandelion", "poppy", "blue_orchid", "allium", "azure_bluet", "red_tulip", "orange_tulip", "white_tulip", "pink_tulip",
  "oxeye_daisy", "cornflower", "lily_of_the_valley", "sunflower", "lilac", "rose_bush", "peony", "torchflower", "pink_petals",
  "brown_mushroom", "red_mushroom", "sweet_berry_bush", "fire", "light",
]);

export const isAir = (n: string): boolean => AIRS.has(n);
/** Air or a plant/layer the bot may clear or build over. */
export const isReplaceable = (n: string): boolean => AIRS.has(n) || REPLACEABLE_EXACT.has(n);
/** Natural solid ground a structure may stand on (not ores, leaves, ice, player blocks). */
export function isGroundBlock(n: string): boolean {
  if (n.endsWith("_ore") || n.endsWith("_leaves") || n === "ice" || n === "packed_ice") return false;
  return isNaturalTerrain(n) && !isCraftedBlockName(n);
}
export const isTillable = (n: string): boolean => n === "grass_block" || n === "dirt" || n === "dirt_path" || n === "coarse_dirt";
export const isWaterName = (n: string): boolean => n === "water" || n === "bubble_column";

export type Column = { kind: "ground"; y: number; name: string } | { kind: "water"; y: number } | { kind: "bad"; reason: string };

/** Classify the top of column (x,z): scan down from yTop past air/replaceables. */
export function scanColumn(grid: WorldGrid, x: number, z: number, yTop: number, yBottom: number): Column {
  for (let y = yTop; y >= yBottom; y--) {
    const n = grid.blockAt(x, y, z);
    if (n === null) return { kind: "bad", reason: "unloaded chunk" };
    if (isReplaceable(n)) continue;
    if (isWaterName(n)) return { kind: "water", y };
    if (isGroundBlock(n)) return { kind: "ground", y, name: n };
    return { kind: "bad", reason: n };
  }
  return { kind: "bad", reason: "no ground" };
}

export interface SiteRequest {
  kind: BlueprintKind;
  params?: Record<string, unknown>;
  /** World cell of "here": x/z of the anchor, y = its feet level. */
  anchor: Cell;
  /** Player positions the footprint must not cover (the requester). */
  avoid?: Cell[];
  radius?: number;
  /** Rows above the ground that must be free; defaults to the blueprint height. */
  height?: number;
}

export interface SiteChoice {
  ok: true;
  /** World cell of blueprint cell (0,0,0): min x/z corner, y = standing level (ground + 1). */
  origin: Cell;
  facing: Facing;
  /** Oriented footprint dims. */
  dims: { x: number; z: number };
  /** Ground y of the footprint (highest column). */
  groundY: number;
  /** World cells (at ground level on low columns) to fill so the base is level. */
  foundation: Cell[];
  /** World cells holding replaceable non-air blocks (flowers, grass) to clear. */
  clearCells: Cell[];
  distance: number;
  farm?: { water: "existing" | "center" };
}
export interface SiteFailure {
  ok: false;
  reason: string;
}

const DEFAULT_RADIUS = 20;
const HYDRATION = 4;

function facingToward(from: { x: number; z: number }, to: { x: number; z: number }, axis: "z" | "x"): Facing {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (axis === "z") return dz < 0 ? "north" : "south";
  return dx < 0 ? "west" : "east";
}

export function findSite(grid: WorldGrid, req: SiteRequest): SiteChoice | SiteFailure {
  const fp = canonicalFootprint(req.kind, req.params);
  const height = req.height ?? fp.height;
  const R = req.radius ?? DEFAULT_RADIUS;
  const isFarm = req.kind === "farm";
  const margin = req.kind === "house" || req.kind === "shelter" ? 1 : req.kind === "portal" ? 2 : 0;
  const maxSlope = isFarm ? 0 : 1;
  const yTop = req.anchor.y + height + 6;
  const yBottom = req.anchor.y - 8;
  const avoid = req.avoid ?? [];

  const cols = new Map<string, Column>();
  const col = (x: number, z: number): Column => {
    const k = `${x},${z}`;
    let c = cols.get(k);
    if (!c) {
      c = scanColumn(grid, x, z, yTop, yBottom);
      cols.set(k, c);
    }
    return c;
  };

  const classes: Array<{ axis: "z" | "x"; dx: number; dz: number }> = [{ axis: "z", dx: fp.sx, dz: fp.sz }];
  if (!isFarm) classes.push({ axis: "x", dx: fp.sz, dz: fp.sx });

  interface Cand {
    ox: number;
    oz: number;
    cls: (typeof classes)[number];
    dist: number;
  }
  const cands: Cand[] = [];
  for (const cls of classes) {
    for (let ox = req.anchor.x - R - cls.dx; ox <= req.anchor.x + R; ox++) {
      for (let oz = req.anchor.z - R - cls.dz; oz <= req.anchor.z + R; oz++) {
        const cx = ox + cls.dx / 2;
        const cz = oz + cls.dz / 2;
        const dist = Math.hypot(cx - (req.anchor.x + 0.5), cz - (req.anchor.z + 0.5));
        if (dist > R) continue;
        cands.push({ ox, oz, cls, dist });
      }
    }
  }
  cands.sort((a, b) => a.dist - b.dist || a.oz - b.oz || a.ox - b.ox);

  let best: (SiteChoice & { cost: number }) | null = null;
  let rejected = "no level natural ground";
  const waterNear = (G: number, x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let x = x0 - HYDRATION; x <= x1 + HYDRATION; x++) {
      for (let z = z0 - HYDRATION; z <= z1 + HYDRATION; z++) {
        const c = col(x, z);
        if (c.kind === "water" && (c.y === G || c.y === G + 1)) out.push([x, z]);
      }
    }
    return out;
  };

  for (const c of cands) {
    if (best && c.dist >= best.cost) break;
    const { ox, oz, cls } = c;
    const x1 = ox + cls.dx - 1;
    const z1 = oz + cls.dz - 1;
    // never cover the requester
    if (avoid.some((a) => a.x >= ox - 1 && a.x <= x1 + 1 && a.z >= oz - 1 && a.z <= z1 + 1)) continue;

    let lo = Infinity;
    let hi = -Infinity;
    let ok = true;
    let waterCols = 0;
    let waterY = NaN;
    for (let x = ox; x <= x1 && ok; x++) {
      for (let z = oz; z <= z1; z++) {
        const k = col(x, z);
        if (k.kind === "ground") {
          if (isFarm && !isTillable(k.name)) {
            ok = false;
            rejected = `ground ${k.name} can't be tilled`;
            break;
          }
          lo = Math.min(lo, k.y);
          hi = Math.max(hi, k.y);
        } else if (isFarm && k.kind === "water") {
          waterCols += 1;
          waterY = k.y;
        } else {
          ok = false;
          rejected = k.kind === "water" ? "water" : k.reason;
          break;
        }
      }
    }
    if (!ok || !Number.isFinite(lo)) continue;
    if (hi - lo > maxSlope) {
      rejected = "ground not level";
      continue;
    }
    if (isFarm && waterCols > 0 && waterY !== hi) continue;
    const G = hi;
    if (G + 1 + height > yTop + 1) continue;

    // margin ring: no player-built blocks right next to the site
    let adjacentBuild = false;
    for (let x = ox - margin; x <= x1 + margin && !adjacentBuild; x++) {
      for (let z = oz - margin; z <= z1 + margin; z++) {
        if (x >= ox && x <= x1 && z >= oz && z <= z1) continue;
        for (let y = G; y <= G + height; y++) {
          const n = grid.blockAt(x, y, z);
          if (n !== null && isCraftedBlockName(n)) {
            adjacentBuild = true;
            break;
          }
        }
        if (adjacentBuild) break;
      }
    }
    if (adjacentBuild) {
      rejected = "next to a player build";
      continue;
    }

    // farms: hydration
    let farmWater: "existing" | "center" | undefined;
    let waterPenalty = 0;
    if (isFarm) {
      const waters = waterNear(G, ox, oz, x1, z1);
      let hydrated = waters.length > 0;
      if (hydrated) {
        outer: for (let x = ox; x <= x1; x++) {
          for (let z = oz; z <= z1; z++) {
            const k = col(x, z);
            if (k.kind === "water") continue;
            if (!waters.some(([wx, wz]) => Math.max(Math.abs(wx - x), Math.abs(wz - z)) <= HYDRATION)) {
              hydrated = false;
              break outer;
            }
          }
        }
      }
      if (hydrated) farmWater = "existing";
      else if (waterCols === 0) {
        farmWater = "center";
        waterPenalty = 8;
      } else continue;
    }

    // collect foundation + clear cells
    const foundation: Cell[] = [];
    const clearCells: Cell[] = [];
    for (let x = ox; x <= x1; x++) {
      for (let z = oz; z <= z1; z++) {
        const k = col(x, z);
        if (k.kind === "ground" && k.y < G) for (let y = k.y + 1; y <= G; y++) foundation.push({ x, y, z });
        if (k.kind !== "ground") continue;
        for (let y = k.y + 1; y <= G + height; y++) {
          const n = grid.blockAt(x, y, z);
          if (n !== null && !isAir(n) && isReplaceable(n)) clearCells.push({ x, y, z });
        }
      }
    }
    const centre = { x: ox + cls.dx / 2, z: oz + cls.dz / 2 };
    const aligned = Math.abs(req.anchor.x - centre.x) > Math.abs(req.anchor.z - centre.z) ? "x" : "z";
    const facing = isFarm ? "south" : facingToward(centre, { x: req.anchor.x + 0.5, z: req.anchor.z + 0.5 }, cls.axis);
    const cost = c.dist + (hi - lo) * 0.75 + foundation.length * 0.1 + waterPenalty + (isFarm || cls.axis === aligned ? 0 : 0.5);
    if (!best || cost < best.cost) {
      best = {
        ok: true,
        origin: { x: ox, y: G + 1, z: oz },
        facing,
        dims: { x: cls.dx, z: cls.dz },
        groundY: G,
        foundation,
        clearCells,
        distance: c.dist,
        ...(farmWater ? { farm: { water: farmWater } } : {}),
        cost,
      };
    }
  }
  if (!best) return { ok: false, reason: `no suitable spot within ${R} blocks (${rejected})` };
  const { cost: _cost, ...choice } = best;
  return choice;
}

/** Facing a bot/player at `from` would see the door on, i.e. toward `to` (used by tests/helpers). */
export function facingBetween(from: { x: number; z: number }, to: { x: number; z: number }): Facing {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) > Math.abs(dz)) return dx < 0 ? "west" : "east";
  return dz < 0 ? "north" : "south";
}
