/**
 * "Exhausted areas" of a job (pure): where gathers already failed, remembered so
 * the next gather skips them and a relocation heads somewhere else.
 *
 * A failed gather reports the block positions it gave up on. The job stores
 * them as `positions` plus one circular `region` around them (the lake wall, the
 * flooded pocket): everything matching inside a region is treated as
 * unreachable, because the neighbours of an unreachable ore sit behind the same
 * water / cliff. Persisted in job.json.
 */

export interface ExhaustedRegion {
  x: number;
  z: number;
  r: number;
  /** Vertical band centre / half-height: a deepslate seam far below a flooded surface area is a different place. */
  y: number;
  dy: number;
}

export interface Exhausted {
  /** "x,y,z" of blocks that were unreachable. */
  positions: string[];
  regions: ExhaustedRegion[];
}

export type ExcludeFn = (x: number, y: number, z: number) => boolean;

/** Radius added around the failed blocks, and the minimum region radius. */
export const REGION_PAD = 24;
export const REGION_MIN_R = 24;
export const REGION_DY = 20;
/** Keep job.json small. */
const MAX_POSITIONS = 400;
const MAX_REGIONS = 12;

export function emptyExhausted(): Exhausted {
  return { positions: [], regions: [] };
}

export function parsePos(key: string): { x: number; y: number; z: number } | null {
  const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(key);
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
}

/**
 * Record `keys` (positions a gather gave up on). The region is centred on their
 * centroid (or `fallback`, the bot's position, when none were reported) and
 * covers all of them plus {@link REGION_PAD}. Returns the region added.
 */
export function noteExhausted(ex: Exhausted, keys: readonly string[], fallback: { x: number; y?: number; z: number }): ExhaustedRegion {
  const pts = keys.map(parsePos).filter((p): p is { x: number; y: number; z: number } => p !== null);
  for (const k of keys) if (!ex.positions.includes(k)) ex.positions.push(k);
  if (ex.positions.length > MAX_POSITIONS) ex.positions.splice(0, ex.positions.length - MAX_POSITIONS);
  let cx = fallback.x;
  let cz = fallback.z;
  let cy = fallback.y ?? 64;
  let r = REGION_MIN_R;
  if (pts.length > 0) {
    cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    cz = pts.reduce((a, p) => a + p.z, 0) / pts.length;
    cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    r = Math.max(REGION_MIN_R, Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.z - cz))) + REGION_PAD);
  }
  const region: ExhaustedRegion = { x: Math.round(cx), z: Math.round(cz), r: Math.round(r), y: Math.round(cy), dy: REGION_DY };
  // a region already covering this one adds nothing
  if (!ex.regions.some((g) => Math.abs(g.y - region.y) <= g.dy && Math.hypot(g.x - region.x, g.z - region.z) + region.r <= g.r + 4)) ex.regions.push(region);
  if (ex.regions.length > MAX_REGIONS) ex.regions.splice(0, ex.regions.length - MAX_REGIONS);
  return region;
}

/** Horizontal test only (relocation destinations): is (x,z) inside any exhausted area? */
export function inExhausted(ex: Exhausted | undefined, x: number, z: number): boolean {
  return !!ex && ex.regions.some((g) => Math.hypot(x - g.x, z - g.z) <= g.r);
}

/** Predicate for `mineBlocks`/`buildWorldView`; `undefined` when nothing is exhausted. */
export function excludeFor(ex: Exhausted | undefined): ExcludeFn | undefined {
  if (!ex || (ex.positions.length === 0 && ex.regions.length === 0)) return undefined;
  const set = new Set(ex.positions);
  return (x, y, z) => set.has(`${x},${y},${z}`) || ex.regions.some((g) => Math.abs(y - g.y) <= g.dy && Math.hypot(x - g.x, z - g.z) <= g.r);
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const LIQUID = /^(water|lava|flowing_water|flowing_lava|bubble_column)$/;

/** True when (x,y,z) is a liquid or touches one: an ore like that is a swim / drowning risk, not a walk. */
export function touchesLiquid(nameAt: (x: number, y: number, z: number) => string | null, x: number, y: number, z: number): boolean {
  const own = nameAt(x, y, z);
  if (own !== null && LIQUID.test(own)) return true;
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const n = nameAt(x + dx, y + dy, z + dz);
    if (n !== null && LIQUID.test(n)) return true;
  }
  return false;
}

/**
 * Once a job has written an area off as unreachable, later gathers also shun ore that touches water or lava
 * (the same failure again: lake-wall ore, a flooded pocket). Without an exhausted area nothing changes.
 */
export function withDryOres(exclude: ExcludeFn | undefined, nameAt: (x: number, y: number, z: number) => string | null): ExcludeFn | undefined {
  if (!exclude) return undefined;
  return (x, y, z) => exclude(x, y, z) || touchesLiquid(nameAt, x, y, z);
}
