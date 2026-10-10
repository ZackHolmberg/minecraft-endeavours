/**
 * Pure build preparation: site (or the stored one), blueprint → absolute
 * placements, what is already done, clearing/foundation, ordering with
 * scaffolds, and the materials gap. The bot adapter (src/jobs/steps/build.ts)
 * supplies the grid, inventory and position and executes the result.
 */
import type { FailureKind, Goal } from "../planner/types.js";
import { buildBlueprint, normalizeHouseParams, normalizeShelterParams } from "./blueprints.js";
import { computeNeeds, type BuildNeeds } from "./materials.js";
import { findSite, isAir, isReplaceable, isWaterName, type WorldGrid } from "./site.js";
import { isSupportBlock, planOrder, type AbsPlacement, type OrderResult } from "./support.js";
import type { Blueprint, BlueprintKind, Cell, Facing } from "./types.js";

export interface PrepareInput {
  grid: WorldGrid;
  inv: Record<string, number>;
  creative: boolean;
  spec: { blueprint: BlueprintKind; params: Record<string, unknown>; anchor: Cell; avoid: Cell[] };
  existing: { origin: Cell; facing: Facing } | null;
  botPos: Cell;
}

export interface Prepared {
  ok: true;
  origin: Cell;
  facing: Facing;
  bp: Blueprint;
  /** Resolved params (farm water mode). */
  params: Record<string, unknown>;
  /** Absolute placements still to do (optional ones without material dropped), incl. foundation. */
  remaining: AbsPlacement[];
  /** Blueprint blocks already in place. */
  doneCount: number;
  /** Blocks the blueprint has when complete (done + remaining, door halves included). */
  total: number;
  clearCells: Cell[];
  order: OrderResult;
  needs: BuildNeeds;
  /** Planner goals for the gap (survival only). */
  missing: Goal[];
  /** Creative: items to getItems before placing. */
  creativeItems: Array<{ name: string; count: number }>;
  summary: string;
}
export interface PrepareFailure {
  ok: false;
  kind: FailureKind;
  detail: string;
}

export const solidName = (n: string | null): boolean => n !== null && !isReplaceable(n) && !isWaterName(n) && n !== "lava" && isSupportBlock(n);

/** Is placement `p` already satisfied in the world? */
export function placementDone(grid: WorldGrid, p: AbsPlacement): boolean {
  const n = grid.blockAt(p.x, p.y, p.z);
  if (n === null) return false;
  if (p.role === "door") {
    if (/_door$/.test(n)) return true;
    // The client's view of a door's upper half lags / is dropped (seen live: server has both halves, mineflayer sees air
    // above the lower one), so the derived half counts as done once the lower half is there.
    const below = p.derived ? grid.blockAt(p.x, p.y - 1, p.z) : null;
    return below !== null && /_door$/.test(below);
  }
  if (p.action === "ignite") return n === "nether_portal";
  if (p.action === "till") return n === "farmland" || isWaterName(n); // a water cell in the plot needs no tilling
  if (p.action === "plant") {
    const below = grid.blockAt(p.x, p.y - 1, p.z);
    return n === "wheat" || (below !== null && isWaterName(below));
  }
  return n === p.block;
}

export function shift(p: { x: number; y: number; z: number }, o: Cell): Cell {
  return { x: p.x + o.x, y: p.y + o.y, z: p.z + o.z };
}

export function prepare(inp: PrepareInput): Prepared | PrepareFailure {
  const { grid, spec } = inp;
  let origin: Cell;
  let facing: Facing;
  let params = { ...spec.params };
  if (inp.existing) {
    origin = inp.existing.origin;
    facing = inp.existing.facing;
  } else {
    const site = findSite(grid, { kind: spec.blueprint, params, anchor: spec.anchor, avoid: spec.avoid });
    if (!site.ok) return { ok: false, kind: "no_site", detail: `no spot for the ${spec.blueprint}: ${site.reason}. Ask the player where, or try another area.` };
    origin = site.origin;
    facing = site.facing;
    if (spec.blueprint === "farm") params = { ...params, water: site.farm?.water === "center" ? "center" : "external" };
  }
  const bp = buildBlueprint(spec.blueprint, params, facing);

  const abs: AbsPlacement[] = bp.placements.map((p) => ({ ...p, ...shift(p, origin) }));
  // foundation under columns where the ground is 1 lower than the base
  if (spec.blueprint !== "farm") {
    const wall = spec.blueprint === "house" ? normalizeHouseParams(params).wall : spec.blueprint === "shelter" ? normalizeShelterParams(params).wall : "dirt";
    const seen = new Set<string>();
    for (const p of abs) {
      if (p.y !== origin.y || p.action) continue;
      const k = `${p.x},${p.z}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const below = grid.blockAt(p.x, origin.y - 1, p.z);
      if (below !== null && !solidName(below) && !isWaterName(below)) abs.unshift({ x: p.x, y: origin.y - 1, z: p.z, block: wall, role: "foundation" });
    }
  }

  const doneList = abs.filter((p) => placementDone(grid, p));
  const todo = abs.filter((p) => !placementDone(grid, p));
  const pseudo: Blueprint = { ...bp, placements: todo };
  const needs = computeNeeds(pseudo, inp.inv, { creative: inp.creative });
  // drop optional placements the bot has no material for (survival)
  const budget: Record<string, number> = { ...needs.consumed };
  const kept: AbsPlacement[] = [];
  for (const p of todo) {
    if (p.optional && !inp.creative) {
      if ((budget[p.block] ?? 0) <= 0) continue;
      budget[p.block] = (budget[p.block] ?? 0) - 1;
    }
    kept.push(p);
  }

  const clearCells: Cell[] = [];
  const dx = bp.size.x;
  const dz = bp.size.z;
  for (let x = origin.x; x < origin.x + dx; x++) {
    for (let z = origin.z; z < origin.z + dz; z++) {
      for (let y = origin.y; y < origin.y + Math.max(1, bp.size.y); y++) {
        const n = grid.blockAt(x, y, z);
        if (n !== null && !isAir(n) && isReplaceable(n)) clearCells.push({ x, y, z });
      }
    }
  }

  const placeKept = kept.filter((p) => !p.derived);
  const order = planOrder(placeKept, {
    isSolidWorld: (c) => solidName(grid.blockAt(c.x, c.y, c.z)),
    start: inp.botPos,
    keepClear: bp.clear.map((c) => ({ ...shift(c, origin) })),
  });
  // scaffold need on the real terrain replaces the flat-ground estimate
  const real = computeNeeds(pseudo, inp.inv, { creative: inp.creative, scaffolds: order.scaffolds });
  const total = doneList.length + kept.length;
  const missing: Goal[] = inp.creative ? [] : real.missing.map((m) => ({ item: m.item, count: m.count }));
  const creativeItems = inp.creative
    ? [
        ...Object.entries(real.consumed).map(([name, count]) => ({ name, count })),
        ...real.tools.map((t) => ({ name: t[0]!, count: 1 })),
        ...(real.missing.some((m) => /_door$/.test(m.item)) ? real.missing.filter((m) => /_door$/.test(m.item)).map((m) => ({ name: m.item, count: 1 })) : []),
      ]
    : [];
  return {
    ok: true,
    origin,
    facing,
    bp,
    params,
    remaining: kept,
    doneCount: doneList.length,
    total,
    clearCells,
    order,
    needs: real,
    missing,
    creativeItems,
    summary: `${bp.summary} at (${origin.x}, ${origin.y}, ${origin.z})`,
  };
}
