/**
 * Pure blueprint geometry: (kind, params, facing) → placements in relative
 * cells. No world access; the executor/site code maps them onto the world.
 *
 * Canonical frame: the front (door side / portal normal) faces +z (south),
 * footprint x ∈ [0,sx), z ∈ [0,sz). `orient` rotates it to the requested facing.
 */
import type { BlockPlacement, Blueprint, BlueprintKind, Cell, Facing, FarmParams, HouseParams } from "./types.js";

export const HOUSE_LIMITS = { width: [5, 9], depth: [5, 9], height: [3, 4], windows: [0, 8] } as const;
export const FARM_LIMITS = { size: [3, 9] } as const;

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().toLowerCase().replace(/\s+/g, "_") : undefined);

export function normalizeHouseParams(raw: Record<string, unknown> | undefined): HouseParams {
  const r = raw ?? {};
  const wall = str(r.wall) ?? "oak_planks";
  const floor = str(r.floor);
  return {
    width: clampInt(r.width, ...HOUSE_LIMITS.width, 5),
    depth: clampInt(r.depth, ...HOUSE_LIMITS.depth, 5),
    height: clampInt(r.height, ...HOUSE_LIMITS.height, 3),
    wall,
    roof: str(r.roof) ?? wall,
    ...(floor ? { floor } : {}),
    door: r.door === false ? false : true,
    windows: clampInt(r.windows, ...HOUSE_LIMITS.windows, 2),
  };
}

export function normalizeFarmParams(raw: Record<string, unknown> | undefined): FarmParams {
  const r = raw ?? {};
  return { size: clampInt(r.size, ...FARM_LIMITS.size, 5), water: r.water === "external" ? "external" : "center" };
}

/** "oak_planks" → "oak_door"; anything else → oak_door. */
export function doorFor(wall: string): string {
  const m = /^([a-z]+)_planks$/.exec(wall);
  return m ? `${m[1]}_door` : "oak_door";
}

/** Rotate a canonical cell (front = +z) so the front faces `f`. `sx`,`sz` = canonical footprint. */
export function orientCell(c: Cell, f: Facing, sx: number, sz: number): Cell {
  switch (f) {
    case "south":
      return c;
    case "north":
      return { x: sx - 1 - c.x, y: c.y, z: sz - 1 - c.z };
    case "east":
      return { x: c.z, y: c.y, z: sx - 1 - c.x };
    case "west":
      return { x: sz - 1 - c.z, y: c.y, z: c.x };
  }
}

/** Footprint dimensions after rotating a canonical sx×sz footprint to face `f`. */
export function orientedDims(f: Facing, sx: number, sz: number): { x: number; z: number } {
  return f === "east" || f === "west" ? { x: sz, z: sx } : { x: sx, z: sz };
}

function orient(p: BlockPlacement, f: Facing, sx: number, sz: number): BlockPlacement {
  const c = orientCell(p, f, sx, sz);
  const out: BlockPlacement = { ...p, x: c.x, y: c.y, z: c.z };
  if (p.state?.facing) out.state = { ...p.state, facing: f };
  return out;
}

function windowSpots(w: number, d: number, doorX: number): Array<[number, number]> {
  const mz = Math.floor(d / 2);
  const mx = Math.floor(w / 2);
  const spots: Array<[number, number]> = [
    [0, mz],
    [w - 1, mz],
    [mx, 0],
    [1, d - 1],
    [w - 2, d - 1],
    [0, 1],
    [w - 1, 1],
    [0, d - 2],
    [w - 1, d - 2],
    [1, 0],
    [w - 2, 0],
  ];
  const seen = new Set<string>();
  return spots.filter(([x, z]) => {
    const k = `${x},${z}`;
    if (seen.has(k)) return false;
    seen.add(k);
    if (z === d - 1 && Math.abs(x - doorX) < 2) return false; // front wall: not next to the door
    if ((x === 0 || x === w - 1) && (z === 0 || z === d - 1)) return false; // corners
    return true;
  });
}

/**
 * House: rectangular walls with a door gap on the front, optional glass
 * windows, a flat roof covering the whole footprint (the top row), optional
 * floor. `height` = rows from the floor line to the roof inclusive, so a
 * height-3 house has 2 wall rows (a 2-high interior) and a roof row.
 */
export function house(raw: Record<string, unknown> | HouseParams | undefined, facing: Facing): Blueprint {
  const p = normalizeHouseParams(raw as Record<string, unknown> | undefined);
  const { width: w, depth: d, height: h } = p;
  const y0 = p.floor ? 1 : 0;
  const wallTop = y0 + h - 2;
  const roofY = y0 + h - 1;
  const doorX = Math.floor(w / 2);
  const winY = y0 + 1;
  const wins = new Map<string, true>();
  for (const [x, z] of windowSpots(w, d, doorX).slice(0, p.windows)) wins.set(`${x},${z}`, true);
  const out: BlockPlacement[] = [];
  const clear: Cell[] = [];

  if (p.floor) {
    for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) out.push({ x, y: 0, z, block: p.floor, role: "floor" });
  }
  for (let y = y0; y <= wallTop; y++) {
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < d; z++) {
        if (x > 0 && x < w - 1 && z > 0 && z < d - 1) continue; // interior
        const isDoorCol = x === doorX && z === d - 1;
        if (isDoorCol && y <= y0 + 1) {
          clear.push({ x, y, z });
          continue; // the gap (door goes in last)
        }
        if (y === winY && wins.has(`${x},${z}`)) {
          out.push({ x, y, z, block: "glass", optional: true, role: "window" });
          continue;
        }
        out.push({ x, y, z, block: p.wall, role: "wall" });
      }
    }
  }
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) out.push({ x, y: roofY, z, block: p.roof, role: "roof" });
  if (p.door) {
    const door = doorFor(p.wall);
    const st = (half: string): Record<string, string> => ({ half, facing: "south", hinge: "left", open: "false" });
    out.push({ x: doorX, y: y0, z: d - 1, block: door, state: st("lower"), role: "door" });
    out.push({ x: doorX, y: y0 + 1, z: d - 1, block: door, state: st("upper"), role: "door", derived: true });
  }
  const dims = orientedDims(facing, w, d);
  const placements = out.map((q) => orient(q, facing, w, d));
  const clearO = clear.map((c) => orientCell(c, facing, w, d));
  const winN = [...wins.keys()].length;
  return {
    kind: "house",
    facing,
    size: { x: dims.x, y: roofY + 1, z: dims.z },
    placements,
    clear: clearO,
    margin: 1,
    params: { ...p },
    summary: `${w}x${d} ${p.wall} house, ${h} high${p.floor ? ` with a ${p.floor} floor` : ""}, door facing ${facing}, ${winN} window${winN === 1 ? "" : "s"}`,
  };
}

/** Minimal nether portal frame: 4 wide × 5 tall, corners omitted = 10 obsidian, then lit. */
export function portal(_raw: Record<string, unknown> | undefined, facing: Facing): Blueprint {
  const out: BlockPlacement[] = [];
  const clear: Cell[] = [];
  for (const x of [1, 2]) out.push({ x, y: 0, z: 0, block: "obsidian", role: "frame" });
  for (const y of [1, 2, 3]) for (const x of [0, 3]) out.push({ x, y, z: 0, block: "obsidian", role: "frame" });
  for (const x of [1, 2]) out.push({ x, y: 4, z: 0, block: "obsidian", role: "frame" });
  for (const x of [1, 2]) for (const y of [1, 2, 3]) clear.push({ x, y, z: 0 });
  // Lighting: flint_and_steel on the top of the bottom-left frame block makes fire at (1,1); the portal fills the interior.
  out.push({ x: 1, y: 1, z: 0, block: "nether_portal", action: "ignite", role: "fire" });
  const dims = orientedDims(facing, 4, 1);
  return {
    kind: "portal",
    facing,
    size: { x: dims.x, y: 5, z: dims.z },
    placements: out.map((q) => orient(q, facing, 4, 1)),
    clear: clear.map((c) => orientCell(c, facing, 4, 1)),
    margin: 2,
    params: {},
    summary: `4x5 nether portal frame (10 obsidian), lit with flint and steel`,
  };
}

/** Farm plot: till every cell (ground level y=-1), optional centre water, then plant seeds on top (y=0). */
export function farm(raw: Record<string, unknown> | FarmParams | undefined, _facing: Facing): Blueprint {
  const p = normalizeFarmParams(raw as Record<string, unknown> | undefined);
  const s = p.size;
  const c = Math.floor(s / 2);
  const out: BlockPlacement[] = [];
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      if (p.water === "center" && x === c && z === c) continue;
      out.push({ x, y: -1, z, block: "farmland", action: "till", role: "farmland" });
    }
  }
  if (p.water === "center") out.push({ x: c, y: -1, z: c, block: "water", action: "water", role: "water" });
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      if (p.water === "center" && x === c && z === c) continue;
      out.push({ x, y: 0, z, block: "wheat", action: "plant", role: "crop" });
    }
  }
  const cells = s * s - (p.water === "center" ? 1 : 0);
  return {
    kind: "farm",
    facing: "south",
    size: { x: s, y: 1, z: s },
    placements: out,
    clear: [],
    margin: 0,
    params: { ...p },
    summary: `${s}x${s} wheat plot (${cells} crops)${p.water === "center" ? ", water source in the middle" : ", next to existing water"}`,
  };
}

export function buildBlueprint(kind: BlueprintKind, params: Record<string, unknown> | undefined, facing: Facing): Blueprint {
  switch (kind) {
    case "house":
      return house(params, facing);
    case "portal":
      return portal(params, facing);
    case "farm":
      return farm(params, facing);
  }
}

/** Footprint dims (canonical sx×sz) for a blueprint request, before orientation. */
export function canonicalFootprint(kind: BlueprintKind, params: Record<string, unknown> | undefined): { sx: number; sz: number; height: number } {
  switch (kind) {
    case "house": {
      const p = normalizeHouseParams(params);
      return { sx: p.width, sz: p.depth, height: p.height + (p.floor ? 1 : 0) };
    }
    case "portal":
      return { sx: 4, sz: 1, height: 5 };
    case "farm": {
      const p = normalizeFarmParams(params);
      return { sx: p.size, sz: p.size, height: 1 };
    }
  }
}

/** Count of placements per block name (derived and optional ones excluded unless asked). */
export function countBlocks(bp: Blueprint, opts: { optional?: boolean } = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of bp.placements) {
    if (p.derived) continue;
    if (p.optional && !opts.optional) continue;
    out[p.block] = (out[p.block] ?? 0) + 1;
  }
  return out;
}
