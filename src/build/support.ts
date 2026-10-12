/**
 * Placement ordering + temporary scaffolding (pure).
 *
 * Minecraft places a block against a face of an existing solid block, so every
 * placement needs a solid neighbour at the time it is made. `planOrder` sorts a
 * blueprint bottom-up (nearest-first inside a layer), simulates which cells are
 * solid as blocks land, and inserts scaffold blocks (and their removal as soon
 * as nothing left needs them) for placements with no support, e.g. the
 * portal's upper sides. Scaffolds never go into blueprint cells or `clear` cells.
 */
import { cellKey, type BlockPlacement, type Cell } from "./types.js";

export interface AbsPlacement extends BlockPlacement {}

export type BuildAction =
  | { op: "place"; p: AbsPlacement }
  | { op: "scaffold"; pos: Cell }
  | { op: "unscaffold"; pos: Cell }
  | { op: "act"; p: AbsPlacement };

export interface OrderOptions {
  /** Solidity of the world BEFORE the build (ground etc.). */
  isSolidWorld: (c: Cell) => boolean;
  /** Where the bot is (for nearest-first). */
  start: Cell;
  /** Cells that must stay empty at the end. */
  keepClear?: Cell[];
  /** Max scaffold chain length for one placement. */
  maxChain?: number;
}

export interface OrderResult {
  actions: BuildAction[];
  /** Placements that cannot be supported even with scaffolding. */
  unplaceable: AbsPlacement[];
  /** Most scaffold blocks alive at once = how many the bot must carry (they are removed and reused as soon as nothing needs them). */
  scaffolds: number;
}

const NEIGH: ReadonlyArray<Cell> = [
  { x: 0, y: -1, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 1, z: 0 },
];
const add = (a: Cell, b: Cell): Cell => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

/** Blocks a player can't reliably click against (doors, plants, fluids). */
export function isSupportBlock(name: string): boolean {
  return !/_door$|_trapdoor$|^torch$|^wheat$|^farmland$|^water$|^nether_portal$|^fire$|^air$/.test(name);
}

const dist2 = (a: Cell, b: Cell): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

export function planOrder(placements: AbsPlacement[], opts: OrderOptions): OrderResult {
  const maxChain = opts.maxChain ?? 3;
  const solidPlaced = new Set<string>();
  const reserved = new Set<string>();
  for (const p of placements) reserved.add(cellKey(p));
  for (const c of opts.keepClear ?? []) reserved.add(cellKey(c));
  const solid = (c: Cell): boolean => solidPlaced.has(cellKey(c)) || opts.isSolidWorld(c);
  const supported = (c: Cell): boolean => NEIGH.some((d) => solid(add(c, d)));

  const actions: BuildAction[] = [];
  const unplaceable: AbsPlacement[] = [];
  /** Scaffolds currently standing, oldest first. */
  let alive: Cell[] = [];
  let peak = 0;
  let remainingAll: AbsPlacement[] = [];

  const placeable = placements.filter((p) => !p.derived && (p.action === undefined || p.action === "place"));
  remainingAll = [...placeable];
  const adjacentToRemaining = (c: Cell): boolean => remainingAll.some((p) => NEIGH.some((d) => p.x === c.x + d.x && p.y === c.y + d.y && p.z === c.z + d.z));
  /** Take down scaffolds nothing left depends on (newest first, so chains unwind). */
  const prune = (): void => {
    for (let i = alive.length - 1; i >= 0; i--) {
      const sc = alive[i]!;
      if (adjacentToRemaining(sc)) continue;
      // a younger scaffold resting on this one keeps it up until that one is gone
      if (alive.some((o, j) => j > i && NEIGH.some((d) => o.x === sc.x + d.x && o.y === sc.y + d.y && o.z === sc.z + d.z))) continue;
      solidPlaced.delete(cellKey(sc));
      actions.push({ op: "unscaffold", pos: sc });
      alive = alive.filter((o) => o !== sc);
    }
  };
  const doors = placeable.filter((p) => p.role === "door");
  const body = placeable.filter((p) => p.role !== "door");
  const acts = placements.filter((p) => !p.derived && p.action !== undefined && p.action !== "place");

  /** Cheapest scaffold chain that makes `t` placeable: list of cells to place in order. */
  const chainFor = (t: Cell): Cell[] | null => {
    const free = (c: Cell): boolean => !reserved.has(cellKey(c)) && !solid(c);
    // depth 1: a free neighbour of t that is itself supported (below first)
    for (const d of NEIGH) {
      const s = add(t, d);
      if (free(s) && supported(s)) return [s];
    }
    if (maxChain < 2) return null;
    for (const d1 of NEIGH) {
      const s1 = add(t, d1);
      if (!free(s1)) continue;
      for (const d2 of NEIGH) {
        const s2 = add(s1, d2);
        if (cellKey(s2) === cellKey(t) || !free(s2) || !supported(s2)) continue;
        return [s2, s1];
      }
    }
    if (maxChain < 3) return null;
    for (const d1 of NEIGH) {
      const s1 = add(t, d1);
      if (!free(s1)) continue;
      for (const d2 of NEIGH) {
        const s2 = add(s1, d2);
        if (cellKey(s2) === cellKey(t) || !free(s2)) continue;
        for (const d3 of NEIGH) {
          const s3 = add(s2, d3);
          if ([t, s1].some((q) => cellKey(q) === cellKey(s3)) || !free(s3) || !supported(s3)) continue;
          return [s3, s2, s1];
        }
      }
    }
    return null;
  };

  let cur: Cell = opts.start;
  const markPlaced = (p: AbsPlacement): void => {
    if (isSupportBlock(p.block)) solidPlaced.add(cellKey(p));
    cur = p;
  };

  const layers = [...new Set(body.map((p) => p.y))].sort((a, b) => a - b);
  for (const y of layers) {
    let remaining = body.filter((p) => p.y === y);
    while (remaining.length > 0) {
      const ok = remaining.filter((p) => supported(p));
      if (ok.length === 0) {
        const t = remaining.reduce((a, b) => (dist2(a, cur) <= dist2(b, cur) ? a : b));
        const chain = chainFor(t);
        if (!chain) {
          unplaceable.push(t);
          remaining = remaining.filter((p) => p !== t);
          remainingAll = remainingAll.filter((p) => p !== t);
          continue;
        }
        for (const s of chain) {
          solidPlaced.add(cellKey(s));
          actions.push({ op: "scaffold", pos: s });
          alive.push(s);
        }
        peak = Math.max(peak, alive.length);
        continue;
      }
      const next = ok.reduce((a, b) => {
        const da = dist2(a, cur);
        const db = dist2(b, cur);
        if (da !== db) return da < db ? a : b;
        return (a.x - b.x || a.z - b.z) <= 0 ? a : b;
      });
      actions.push({ op: "place", p: next });
      markPlaced(next);
      remaining = remaining.filter((p) => p !== next);
      remainingAll = remainingAll.filter((p) => p !== next);
      prune();
    }
  }
  for (const d of doors) {
    if (supported(d)) {
      actions.push({ op: "place", p: d });
      markPlaced(d);
    } else unplaceable.push(d);
    remainingAll = remainingAll.filter((p) => p !== d);
  }
  prune();
  // anything still standing (a scaffold next to an unplaceable cell) comes out now, newest first
  for (const sc of [...alive].reverse()) actions.push({ op: "unscaffold", pos: sc });
  for (const kind of ["till", "water", "plant", "ignite"] as const) {
    let rem = acts.filter((a) => a.action === kind);
    while (rem.length > 0) {
      const next = rem.reduce((a, b) => (dist2(a, cur) <= dist2(b, cur) ? a : b));
      actions.push({ op: "act", p: next });
      cur = next;
      rem = rem.filter((q) => q !== next);
    }
  }
  return { actions, unplaceable, scaffolds: peak };
}

/** Scaffold blocks a blueprint needs on ideal flat ground (y < 0 solid), for material math. */
export function scaffoldCount(placements: BlockPlacement[], keepClear: Cell[]): number {
  const r = planOrder(placements, { isSolidWorld: (c) => c.y < 0, start: { x: 0, y: 0, z: 0 }, keepClear });
  return r.scaffolds;
}
