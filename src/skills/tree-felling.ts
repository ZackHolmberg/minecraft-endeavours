/**
 * Felling trees like a player (v2 regression R5: jungle drops unreachable).
 *
 * Mining a log with another log directly beneath it drops the item onto that
 * log (or onto leaves), where the bot can't reach it; in a jungle the bot even
 * climbed the canopy to chop the upper logs. The player's way, enforced here:
 *
 *  - **Bottom-up per column.** A log is only a candidate when the cell below it
 *    is not a log, so every drop falls to the ground (leaves below are broken
 *    first, see `leavesBelow`).
 *  - **Reachable from the ground.** Only logs at most {@link FELL_MAX_HEIGHT}
 *    above the floor under them (about arm's reach from the ground, or from a
 *    1-block step) are candidates; towering is never needed. A jungle giant
 *    therefore yields its bottom 5 logs per trunk column, not its canopy.
 *  - **Short trees first.** Candidate trees are ranked by distance plus a
 *    penalty per block of height above {@link SHORT_TREE_HEIGHT} minus a small
 *    bonus per reachable log, so a nearby oak beats a jungle giant. The
 *    requested species still decides *which* blocks are searched at all.
 *
 * Everything here is pure over a `blockAt` function (unit-testable without a
 * bot); `skills/world.ts` supplies the live one.
 */

import { Vec3 } from "vec3";

/** Highest log (blocks above the floor beneath it, 0 = lowest) we mine from the ground. */
export const FELL_MAX_HEIGHT = 4;
/** Trees up to this tall are "short": no ranking penalty. */
export const SHORT_TREE_HEIGHT = 7;
/** Ranking penalty (in blocks of walking) per block of tree height above {@link SHORT_TREE_HEIGHT}. */
export const TALL_TREE_PENALTY = 2;
/** Ranking bonus per reachable log in a tree (capped at {@link REACHABLE_BONUS_CAP} logs). */
export const REACHABLE_LOG_BONUS = 0.4;
export const REACHABLE_BONUS_CAP = 10;
/** Bonus for staying on the tree we just chopped (finish a trunk before wandering). */
export const SAME_TREE_BONUS = 8;
/** Tie-break toward the lower log of a tree. */
const LOWER_LOG_WEIGHT = 0.3;
const FLOOR_SCAN_DEPTH = 12;
const TREE_CLUSTER_CAP = 200;

export type BlockLike = { name: string; boundingBox?: string } | null | undefined;
export type BlockAt = (p: Vec3) => BlockLike;

const TREE_LOG_RE = /^(?!stripped_)[a-z_]+_(log|wood)$/;
const ANY_LOG_RE = /_(log|wood)$/;
const LEAF_RE = /_leaves$/;
const VINE_RE = /^(vine|cave_vines(_plant)?|weeping_vines(_plant)?|twisting_vines(_plant)?)$/;

/** Natural (unstripped) log / wood block name. */
export function isTreeLogName(name: string): boolean {
  return TREE_LOG_RE.test(name);
}
export function isLeafName(name: string): boolean {
  return LEAF_RE.test(name);
}

export interface FellInfo {
  /** Candidate: nothing log-like beneath it and low enough to reach from the floor. */
  ok: boolean;
  /** Why not: `under_log` (a log is below: not the bottom of its column) or `too_high`. */
  reason: "ok" | "under_log" | "too_high" | "unknown";
  /** Blocks above the floor beneath the log (0 = lowest). */
  height: number;
  /** Floor level: y of the first cell above the solid block under the column. */
  floorY: number;
  /** Leaves/vines between the log and the floor, nearest the log first. The drop would rest on them. */
  leavesBelow: Vec3[];
}

/** Scan down from `log`: which cells would the dropped item fall through, and where does it land? */
export function fellInfo(blockAt: BlockAt, log: Vec3): FellInfo {
  const leaves: Vec3[] = [];
  for (let d = 1; d <= FLOOR_SCAN_DEPTH; d++) {
    const p = new Vec3(log.x, log.y - d, log.z);
    const b = blockAt(p);
    if (!b) return { ok: false, reason: "unknown", height: d - 1, floorY: p.y + 1, leavesBelow: leaves };
    if (ANY_LOG_RE.test(b.name)) return { ok: false, reason: "under_log", height: d - 1, floorY: p.y + 1, leavesBelow: leaves };
    if (LEAF_RE.test(b.name) || VINE_RE.test(b.name)) {
      leaves.push(p);
      continue;
    }
    if (b.boundingBox === "empty") continue; // air, grass, water... the drop falls through
    const height = log.y - (p.y + 1);
    return {
      ok: height <= FELL_MAX_HEIGHT,
      reason: height <= FELL_MAX_HEIGHT ? "ok" : "too_high",
      height,
      floorY: p.y + 1,
      leavesBelow: leaves,
    };
  }
  return { ok: false, reason: "too_high", height: FLOOR_SCAN_DEPTH, floorY: log.y - FLOOR_SCAN_DEPTH, leavesBelow: leaves };
}

export interface TreeInfo {
  /** Every log of the connected cluster (26-neighbourhood, capped). */
  cells: Vec3[];
  keys: Set<string>;
  /** Cluster height in blocks (top y - bottom y + 1). */
  height: number;
  /** Logs that are candidates right now. */
  reachable: Vec3[];
  /** Ranking penalty (lower is better), distance excluded. */
  penalty: number;
}

export const posKey = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;

/** Connected natural-log cluster around `start`, with felling stats. */
export function analyzeTree(blockAt: BlockAt, start: Vec3): TreeInfo {
  const keys = new Set<string>([posKey(start)]);
  const cells: Vec3[] = [start];
  for (let i = 0; i < cells.length && cells.length < TREE_CLUSTER_CAP; i++) {
    const c = cells[i]!;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const n = new Vec3(c.x + dx, c.y + dy, c.z + dz);
      const k = posKey(n);
      if (keys.has(k)) continue;
      const b = blockAt(n);
      if (!b || !TREE_LOG_RE.test(b.name)) continue;
      keys.add(k);
      cells.push(n);
    }
  }
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of cells) {
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
  }
  const reachable = cells.filter((c) => fellInfo(blockAt, c).ok);
  const height = maxY - minY + 1;
  const penalty =
    TALL_TREE_PENALTY * Math.max(0, height - SHORT_TREE_HEIGHT) - REACHABLE_LOG_BONUS * Math.min(reachable.length, REACHABLE_BONUS_CAP);
  return { cells, keys, height, reachable, penalty };
}

export interface RankedLog {
  pos: Vec3;
  score: number;
  tree: TreeInfo;
  fell: FellInfo;
}

export interface FellRanking {
  /** Fellable candidates, best first. */
  ranked: RankedLog[];
  /** Tree logs refused because a log lies below them (not column-bottom). */
  underLog: number;
  /** Tree logs refused because they are above reach from the ground. */
  tooHigh: number;
}

/**
 * Rank the natural logs among `positions` for felling. `from` is the bot's
 * position; `lastTree` (keys of the tree just chopped) gets {@link SAME_TREE_BONUS}.
 * Non-candidates are dropped. Pure.
 */
export function rankLogs(blockAt: BlockAt, positions: Vec3[], from: Vec3, lastTree?: ReadonlySet<string> | null): FellRanking {
  const trees = new Map<string, TreeInfo>();
  const ranked: RankedLog[] = [];
  let underLog = 0;
  let tooHigh = 0;
  for (const pos of positions) {
    const fell = fellInfo(blockAt, pos);
    if (!fell.ok) {
      if (fell.reason === "under_log") underLog += 1;
      else if (fell.reason === "too_high") tooHigh += 1;
      continue;
    }
    const k = posKey(pos);
    let tree = [...trees.values()].find((t) => t.keys.has(k));
    if (!tree) {
      tree = analyzeTree(blockAt, pos);
      trees.set(k, tree);
    }
    const score =
      pos.distanceTo(from) + tree.penalty + LOWER_LOG_WEIGHT * fell.height - (lastTree?.has(k) ? SAME_TREE_BONUS : 0);
    ranked.push({ pos, score, tree, fell });
  }
  ranked.sort((a, b) => a.score - b.score);
  return { ranked, underLog, tooHigh };
}

/**
 * Planner/perception view of a log species: from the log positions found (nearest
 * first), the score of the best fellable log (`dist + tree penalty`, floored at the
 * raw distance) and how many are fellable. null when none can be felled from the ground.
 */
export function speciesViewScore(blockAt: BlockAt, positions: Vec3[], from: Vec3): { count: number; score: number } | null {
  const r = rankLogs(blockAt, positions, from);
  const best = r.ranked[0];
  if (!best) return null;
  return { count: r.ranked.length, score: Math.max(best.pos.distanceTo(from), best.score) };
}
