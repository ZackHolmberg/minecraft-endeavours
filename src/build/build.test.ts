import { describe, expect, it } from "vitest";
import { buildBlueprint, countBlocks, farm, house, normalizeHouseParams, orientCell, portal } from "./blueprints.js";
import { computeNeeds, defaultPlanks, pickDoor } from "./materials.js";
import { placementDone, prepare, solidName } from "./prepare.js";
import { findSite, type WorldGrid } from "./site.js";
import { planOrder, scaffoldCount, type AbsPlacement } from "./support.js";
import { cellKey, type Cell, type Facing } from "./types.js";

const FACINGS: Facing[] = ["north", "south", "east", "west"];

/** Synthetic world: ground top at y=63 (grass over dirt), air above, overridable per cell. */
function flatWorld(over: Record<string, string> = {}, groundY = (_x: number, _z: number) => 63): WorldGrid {
  return {
    blockAt: (x, y, z) => {
      const o = over[`${x},${y},${z}`];
      if (o !== undefined) return o;
      const g = groundY(x, z);
      if (y > g) return "air";
      return y === g ? "grass_block" : "dirt";
    },
  };
}
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

describe("blueprints: house", () => {
  it("default 5x5x3: counts, door gap, glass windows optional", () => {
    const bp = house({}, "south");
    const c = countBlocks(bp, { optional: true });
    expect(c["oak_planks"]).toBe(28 + 25); // 2 wall rows of the ring minus gap and windows, plus the roof row
    expect(c["glass"]).toBe(2);
    expect(c["oak_door"]).toBe(1);
    expect(countBlocks(bp)["glass"]).toBeUndefined();
    expect(bp.size).toEqual({ x: 5, y: 3, z: 5 });
    // door lower + derived upper at the front (z = 4), gap kept clear
    const doors = bp.placements.filter((p) => p.role === "door");
    expect(doors.map((d) => [d.x, d.y, d.z, d.state?.half, !!d.derived])).toEqual([
      [2, 0, 4, "lower", false],
      [2, 1, 4, "upper", true],
    ]);
    expect(bp.clear).toEqual([{ x: 2, y: 0, z: 4 }, { x: 2, y: 1, z: 4 }]);
    // every cell used once; nothing in the gap
    const keys = bp.placements.map(cellKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(bp.placements.some((p) => p.role === "wall" && p.x === 2 && p.z === 4 && p.y < 2)).toBe(false);
  });

  it("clamps params and derives the door from the wall; floor adds a row", () => {
    expect(normalizeHouseParams({ width: 99, depth: 1, height: 2, windows: 50 })).toMatchObject({ width: 9, depth: 5, height: 3, windows: 8 });
    const bp = house({ wall: "spruce_planks", floor: "cobblestone", height: 4, width: 7, depth: 6, windows: 0 }, "south");
    expect(bp.placements.find((p) => p.role === "door")!.block).toBe("spruce_door");
    expect(bp.placements.filter((p) => p.role === "floor")).toHaveLength(42);
    expect(Math.max(...bp.placements.map((p) => p.y))).toBe(4); // floor row 0, walls 1..3 (wall rows = height-1), roof row 4
    expect(bp.size.y).toBe(5);
    expect(bp.placements.filter((p) => p.role === "roof").every((p) => p.y === 4)).toBe(true);
  });

  it("orientation: same blocks, door on the facing side, dims swap for east/west", () => {
    const base = countBlocks(house({ width: 7, depth: 5 }, "south"), { optional: true });
    for (const f of FACINGS) {
      const bp = house({ width: 7, depth: 5 }, f);
      expect(countBlocks(bp, { optional: true })).toEqual(base);
      const swap = f === "east" || f === "west";
      expect(bp.size.x).toBe(swap ? 5 : 7);
      expect(bp.size.z).toBe(swap ? 7 : 5);
      const door = bp.placements.find((p) => p.role === "door" && !p.derived)!;
      const edge = { north: door.z === 0, south: door.z === bp.size.z - 1, west: door.x === 0, east: door.x === bp.size.x - 1 }[f];
      expect(edge, `door on the ${f} side`).toBe(true);
      expect(door.state!.facing).toBe(f);
      for (const p of bp.placements) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(bp.size.x);
        expect(p.z).toBeGreaterThanOrEqual(0);
        expect(p.z).toBeLessThan(bp.size.z);
      }
    }
  });

  it("orientCell is a bijection onto the rotated box", () => {
    for (const f of FACINGS) {
      const seen = new Set<string>();
      for (let x = 0; x < 3; x++) for (let z = 0; z < 5; z++) seen.add(cellKey(orientCell({ x, y: 0, z }, f, 3, 5)));
      expect(seen.size).toBe(15);
    }
  });
});

describe("blueprints: portal and farm", () => {
  it("portal: 10 obsidian, corners omitted, interior clear, then ignite", () => {
    for (const f of FACINGS) {
      const bp = portal(undefined, f);
      const frame = bp.placements.filter((p) => p.block === "obsidian");
      expect(frame).toHaveLength(10);
      expect(new Set(frame.map(cellKey)).size).toBe(10);
      expect(bp.clear).toHaveLength(6);
      expect(bp.placements.at(-1)).toMatchObject({ action: "ignite", block: "nether_portal" });
      const ns = f === "north" || f === "south";
      expect(bp.size).toEqual({ x: ns ? 4 : 1, y: 5, z: ns ? 1 : 4 });
      // corners of the 4x5 box are not part of the frame
      const lo = frame.reduce((m, p) => Math.min(m, ns ? p.x : p.z), 99);
      const hi = frame.reduce((m, p) => Math.max(m, ns ? p.x : p.z), -1);
      expect([lo, hi]).toEqual([0, 3]);
      expect(frame.some((p) => p.y === 0 && (ns ? p.x : p.z) === 0)).toBe(false);
      expect(frame.some((p) => p.y === 4 && (ns ? p.x : p.z) === 3)).toBe(false);
    }
  });

  it("farm: tills every cell, optional centre water, plants on top", () => {
    const c = farm({ size: 5 }, "south");
    expect(c.placements.filter((p) => p.action === "till")).toHaveLength(24);
    expect(c.placements.filter((p) => p.action === "plant")).toHaveLength(24);
    expect(c.placements.filter((p) => p.action === "water")).toEqual([expect.objectContaining({ x: 2, y: -1, z: 2 })]);
    const e = farm({ size: 3, water: "external" }, "south");
    expect(e.placements.filter((p) => p.action === "till")).toHaveLength(9);
    expect(e.placements.filter((p) => p.action === "water")).toHaveLength(0);
    expect(farm({ size: 50 }, "south").params.size).toBe(9);
  });
});

describe("site choice", () => {
  const anchor: Cell = { x: 0, y: 64, z: 0 };

  it("picks the nearest level spot, never covering the requester, door toward them", () => {
    const r = findSite(flatWorld(), { kind: "house", anchor, avoid: [anchor] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.origin.y).toBe(64);
    const { origin: o, dims: d } = r;
    expect(0 >= o.x - 1 && 0 <= o.x + d.x && 0 >= o.z - 1 && 0 <= o.z + d.z).toBe(false);
    expect(r.distance).toBeLessThan(5);
    // facing points at the anchor
    const cx = o.x + d.x / 2;
    const cz = o.z + d.z / 2;
    const toward = Math.abs(cx) > Math.abs(cz) ? (cx > 0 ? "west" : "east") : cz > 0 ? "north" : "south";
    expect(r.facing).toBe(toward);
    expect(r.foundation).toHaveLength(0);
  });

  it("skips water, trees and uneven ground; accepts a 1-block step with a foundation", () => {
    const world = flatWorld({}, (x) => (x < 3 ? 61 : 63)); // 2-high cliff at x=3
    const r = findSite(world, { kind: "house", anchor, avoid: [anchor], radius: 12 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const xs = [r.origin.x, r.origin.x + r.dims.x - 1];
    expect(xs[1]! < 3 || xs[0]! >= 3).toBe(true); // never straddles the cliff
    const step = flatWorld({}, (x) => (x < 2 ? 62 : 63));
    const s = findSite(step, { kind: "house", anchor: { x: 0, y: 64, z: 0 }, avoid: [], radius: 3 });
    expect(s.ok).toBe(true);
    if (s.ok && s.origin.x < 2 && s.origin.x + s.dims.x > 2) expect(s.foundation.length).toBeGreaterThan(0);

    const lake = findSite(flatWorld(Object.fromEntries(Array.from({ length: 41 * 41 }, (_, i) => [key((i % 41) - 20, 63, Math.floor(i / 41) - 20), "water"]))), { kind: "house", anchor, radius: 10 });
    expect(lake.ok).toBe(false);
    if (!lake.ok) expect(lake.reason).toMatch(/no suitable spot/);
  });

  it("clears replaceables (grass, flowers, snow) but refuses cells with other blocks above ground", () => {
    const over: Record<string, string> = {};
    for (let x = -3; x <= 12; x++) for (let z = -3; z <= 12; z++) over[key(x, 64, z)] = (x + z) % 2 ? "short_grass" : "poppy";
    const r = findSite(flatWorld(over), { kind: "house", anchor, avoid: [anchor], radius: 6 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clearCells.length).toBeGreaterThan(5);
    expect(r.clearCells.every((c) => c.y >= 64)).toBe(true);

    const log: Record<string, string> = {};
    for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) log[key(x, 65, z)] = "oak_leaves";
    const blocked = findSite(flatWorld(log), { kind: "house", anchor, radius: 6 });
    expect(blocked.ok).toBe(false);
  });

  it("never builds next to or on a player build", () => {
    const over: Record<string, string> = {};
    // a planks hut at x 0..6 / z 0..6, 3 high
    for (let x = 0; x <= 6; x++) for (let z = 0; z <= 6; z++) for (let y = 64; y <= 66; y++) over[key(x, y, z)] = "oak_planks";
    const r = findSite(flatWorld(over), { kind: "house", anchor: { x: 3, y: 64, z: 3 }, avoid: [], radius: 14 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = r.origin;
    const inside = (x: number, z: number): boolean => x >= 0 && x <= 6 && z >= 0 && z <= 6;
    for (let x = o.x - 1; x <= o.x + r.dims.x; x++) for (let z = o.z - 1; z <= o.z + r.dims.z; z++) expect(inside(x, z)).toBe(false);
  });

  it("farm: uses existing water within 4, else plans a centre water cell; sand is not tillable", () => {
    const water = flatWorld({ [key(4, 63, 4)]: "water" });
    const w = findSite(water, { kind: "farm", params: { size: 5 }, anchor, avoid: [anchor], radius: 12 });
    expect(w.ok && w.farm?.water).toBe("existing");
    const dry = findSite(flatWorld(), { kind: "farm", params: { size: 5 }, anchor, avoid: [], radius: 8 });
    expect(dry.ok && dry.farm?.water).toBe("center");
    const sand: WorldGrid = { blockAt: (x, y, z) => (y === 63 ? "sand" : y < 63 ? "sandstone" : "air") };
    expect(findSite(sand, { kind: "farm", params: { size: 3 }, anchor, radius: 6 }).ok).toBe(false);
    const s = flatWorld({ [key(1, 63, 1)]: "water" });
    const plot = findSite(s, { kind: "farm", params: { size: 3 }, anchor, avoid: [], radius: 6 });
    expect(plot.ok && plot.farm?.water).toBe("existing");
  });
});

describe("support ordering and scaffolds", () => {
  const flat = (c: Cell): boolean => c.y < 0;
  const abs = (bp: ReturnType<typeof house>): AbsPlacement[] => bp.placements.map((p) => ({ ...p }));

  it("house: bottom-up, no scaffolds, door last", () => {
    const bp = house({}, "south");
    const r = planOrder(abs(bp), { isSolidWorld: flat, start: { x: 0, y: 0, z: 0 }, keepClear: bp.clear });
    expect(r.scaffolds).toBe(0);
    expect(r.unplaceable).toEqual([]);
    const places = r.actions.filter((a) => a.op === "place");
    const ys = places.map((a) => (a as { p: AbsPlacement }).p.y);
    const lastNonDoor = places.filter((a) => (a as { p: AbsPlacement }).p.role !== "door").length - 1;
    expect(ys.slice(0, lastNonDoor + 1)).toEqual([...ys.slice(0, lastNonDoor + 1)].sort((a, b) => a - b));
    expect((places.at(-1) as { p: AbsPlacement }).p.role).toBe("door");
    expect(places).toHaveLength(bp.placements.filter((p) => !p.derived).length);
  });

  it("nearest-first inside a layer: consecutive placements are adjacent most of the time", () => {
    const bp = house({ windows: 0 }, "south");
    const r = planOrder(abs(bp), { isSolidWorld: flat, start: { x: 0, y: 0, z: 0 }, keepClear: bp.clear });
    const row = r.actions.filter((a) => a.op === "place" && (a as { p: AbsPlacement }).p.y === 0).map((a) => (a as { p: AbsPlacement }).p);
    let jumps = 0;
    for (let i = 1; i < row.length; i++) if (Math.abs(row[i]!.x - row[i - 1]!.x) + Math.abs(row[i]!.z - row[i - 1]!.z) > 2) jumps++;
    expect(jumps).toBeLessThanOrEqual(2);
  });

  it("portal: one scaffold block at a time (3 placements), each taken down right after the block it supported", () => {
    const bp = portal(undefined, "south");
    expect(scaffoldCount(bp.placements, bp.clear)).toBe(1);
    const r = planOrder(bp.placements.map((p) => ({ ...p })), { isSolidWorld: flat, start: { x: 0, y: 0, z: 0 }, keepClear: bp.clear });
    expect(r.unplaceable).toEqual([]);
    expect(r.scaffolds).toBe(1);
    const ops = r.actions.map((a) => a.op);
    expect(ops.filter((o) => o === "place")).toHaveLength(10);
    expect(ops.filter((o) => o === "scaffold")).toHaveLength(3);
    expect(ops.filter((o) => o === "unscaffold")).toHaveLength(3);
    expect(ops.at(-1)).toBe("act"); // ignite comes after every scaffold is gone
    expect(ops.lastIndexOf("unscaffold")).toBeLessThan(ops.indexOf("act"));
    // never more than one scaffold standing
    let alive = 0;
    for (const o of ops) {
      if (o === "scaffold") alive++;
      if (o === "unscaffold") alive--;
      expect(alive).toBeLessThanOrEqual(1);
    }
    const scaff = r.actions.filter((a) => a.op === "scaffold").map((a) => (a as { pos: Cell }).pos);
    const un = r.actions.filter((a) => a.op === "unscaffold").map((a) => (a as { pos: Cell }).pos);
    expect(un.map(cellKey).sort()).toEqual(scaff.map(cellKey).sort());
    // scaffolds never occupy the interior or a frame cell
    const forbidden = new Set([...bp.clear, ...bp.placements].map(cellKey));
    expect(scaff.some((c) => forbidden.has(cellKey(c)))).toBe(false);
    // every placement had a solid neighbour when it was made
    const solid = new Set<string>();
    const isSolid = (c: Cell): boolean => c.y < 0 || solid.has(cellKey(c));
    for (const a of r.actions) {
      if (a.op === "scaffold") solid.add(cellKey(a.pos));
      if (a.op === "place") {
        const n = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => isSolid({ x: a.p.x + dx!, y: a.p.y + dy!, z: a.p.z + dz! }));
        expect(n, `support for ${cellKey(a.p)}`).toBe(true);
        solid.add(cellKey(a.p));
      }
      if (a.op === "unscaffold") solid.delete(cellKey(a.pos));
    }
  });

  it("reports unplaceable cells instead of looping when nothing can support them", () => {
    const r = planOrder([{ x: 0, y: 20, z: 0, block: "stone" }], { isSolidWorld: flat, start: { x: 0, y: 0, z: 0 } });
    expect(r.unplaceable).toHaveLength(1);
  });
});

describe("material math", () => {
  it("house: planks/glass/door against the inventory; missing glass is skipped, missing door is a goal", () => {
    const bp = house({}, "south");
    const n = computeNeeds(bp, { oak_planks: 64, glass: 1 }, { creative: false });
    expect(n.consumed).toEqual({ oak_planks: 53, glass: 1 });
    expect(n.skippedOptional).toEqual({ glass: 1 });
    expect(n.missing).toEqual([{ item: "oak_door", count: 1 }]);
    const full = computeNeeds(bp, { oak_planks: 64, oak_door: 1, glass: 4 }, { creative: false });
    expect(full.missing).toEqual([]);
    const short = computeNeeds(bp, { oak_planks: 40, spruce_door: 1 }, { creative: false });
    expect(short.missing).toEqual([{ item: "oak_planks", count: 13 }]); // any non-iron door counts
    expect(pickDoor({ spruce_door: 1 }, "oak_door")).toBe("spruce_door");
    expect(pickDoor({ iron_door: 1 }, "oak_door")).toBeNull();
    expect(defaultPlanks({ birch_planks: 5, spruce_planks: 30, oak_log: 9 })).toBe("spruce_planks");
    expect(defaultPlanks({})).toBe("oak_planks");
  });

  it("portal: 10 obsidian + flint_and_steel + 1 reusable scaffold (dirt unless the bot carries cobblestone)", () => {
    const bp = portal(undefined, "south");
    const n = computeNeeds(bp, { obsidian: 10, flint_and_steel: 1 }, { creative: false });
    expect(n.consumed).toMatchObject({ obsidian: 10, flint_and_steel: 1, dirt: 1 });
    expect(n.missing).toEqual([]); // dirt is self-supplied by the executor (dug from the ground)
    expect(n.selfSupply).toEqual({ item: "dirt", count: 1 });
    const c = computeNeeds(bp, { obsidian: 10, flint_and_steel: 1, cobblestone: 9 }, { creative: false });
    expect(c.scaffoldItem).toBe("cobblestone");
    expect(c.missing).toEqual([]);
    expect(c.selfSupply).toBeNull();
  });

  it("farm: hoe is a tool (any tier), seeds capped at 9, bucket for centre water", () => {
    const bp = farm({ size: 5 }, "south");
    const n = computeNeeds(bp, { stone_hoe: 1, wheat_seeds: 16 }, { creative: false });
    expect(n.consumed).toEqual({ wheat_seeds: 9, water_bucket: 1 });
    expect(n.missing).toEqual([{ item: "water_bucket", count: 1 }]);
    const none = computeNeeds(farm({ size: 3, water: "external" }, "south"), {}, { creative: false });
    expect(none.missing).toEqual(expect.arrayContaining([{ item: "wheat_seeds", count: 9 }, { item: "wooden_hoe", count: 1 }]));
  });

  it("creative reports glass as available (no skipping)", () => {
    const n = computeNeeds(house({}, "south"), {}, { creative: true });
    expect(n.skippedOptional).toEqual({});
    expect(n.consumed["glass"]).toBe(2);
  });
});

describe("prepare (site + blueprint + materials on a synthetic world)", () => {
  const spec = (kind: "house" | "portal" | "farm", params: Record<string, unknown> = {}) => ({
    blueprint: kind,
    params,
    anchor: { x: 0, y: 64, z: 0 },
    avoid: [{ x: 0, y: 64, z: 0 }],
  });

  it("house on flat ground: nothing to clear, missing door becomes a goal; 'already done' cells are not required again", () => {
    const grid = flatWorld();
    const p = prepare({ grid, inv: { oak_planks: 64, glass: 4 }, creative: false, spec: spec("house"), existing: null, botPos: { x: 0, y: 64, z: 0 } });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.missing).toEqual([{ item: "oak_door", count: 1 }]);
    expect(p.total).toBe(p.bp.placements.length);
    expect(p.doneCount).toBe(0);
    // pretend the south... first 10 wall blocks already stand: resumes without re-demanding them
    const built = Object.fromEntries(p.remaining.slice(0, 10).map((q) => [key(q.x, q.y, q.z), q.block]));
    const again = prepare({ grid: flatWorld(built), inv: { oak_planks: 64, oak_door: 1, glass: 4 }, creative: false, spec: spec("house"), existing: { origin: p.origin, facing: p.facing }, botPos: { x: 0, y: 64, z: 0 } });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.doneCount).toBe(10);
      expect(again.total).toBe(p.total);
      expect(again.origin).toEqual(p.origin);
      expect(again.missing).toEqual([]);
    }
  });

  it("no site is a typed failure", () => {
    const grid: WorldGrid = { blockAt: (x, y) => (y <= 63 ? "water" : "air") };
    const p = prepare({ grid, inv: {}, creative: false, spec: spec("house"), existing: null, botPos: { x: 0, y: 64, z: 0 } });
    expect(p).toMatchObject({ ok: false, kind: "no_site" });
  });

  it("portal: scaffolds counted on the real terrain; creative leaves materials to getItems", () => {
    const grid = flatWorld();
    const p = prepare({ grid, inv: { obsidian: 10, flint_and_steel: 1 }, creative: false, spec: spec("portal"), existing: null, botPos: { x: 0, y: 64, z: 0 } });
    expect(p.ok && p.order.scaffolds).toBe(1);
    expect(p.ok && p.missing).toEqual([]);
    expect(p.ok && p.needs.selfSupply).toEqual({ item: "dirt", count: 1 });
    const c = prepare({ grid, inv: {}, creative: true, spec: spec("portal"), existing: null, botPos: { x: 0, y: 64, z: 0 } });
    expect(c.ok && c.missing).toEqual([]);
    expect(c.ok && c.creativeItems.map((i) => i.name).sort()).toEqual(["dirt", "flint_and_steel", "obsidian"]);
  });

  it("farm: resolves the water mode from the site and drops finished cells", () => {
    const p = prepare({ grid: flatWorld(), inv: { wooden_hoe: 1, wheat_seeds: 16, water_bucket: 1 }, creative: false, spec: spec("farm", { size: 5 }), existing: null, botPos: { x: 0, y: 64, z: 0 } });
    expect(p.ok && p.params.water).toBe("center");
    expect(p.ok && p.missing).toEqual([]);
    expect(solidName("grass_block")).toBe(true);
    expect(solidName("oak_door")).toBe(false);
    expect(placementDone(flatWorld({ [key(1, 63, 1)]: "farmland" }), { x: 1, y: 63, z: 1, block: "farmland", action: "till" })).toBe(true);
    // a door's upper half is done once the lower half stands (the client often never sees it)
    const lowerOnly = flatWorld({ [key(2, 64, 2)]: "oak_door" });
    expect(placementDone(lowerOnly, { x: 2, y: 65, z: 2, block: "oak_door", role: "door", derived: true })).toBe(true);
    expect(placementDone(lowerOnly, { x: 2, y: 64, z: 2, block: "oak_door", role: "door" })).toBe(true);
    expect(placementDone(flatWorld(), { x: 2, y: 65, z: 2, block: "oak_door", role: "door", derived: true })).toBe(false);
  });
});

describe("blueprint registry", () => {
  it("buildBlueprint dispatches by kind", () => {
    expect(buildBlueprint("house", {}, "south").kind).toBe("house");
    expect(buildBlueprint("portal", undefined, "east").kind).toBe("portal");
    expect(buildBlueprint("farm", { size: 3 }, "south").kind).toBe("farm");
  });
});

describe("shelter: site, prepare, materials", () => {
  const anchor = { x: 0, y: 64, z: 0 };
  const spec = (wall: string, door = false) => ({ blueprint: "shelter" as const, params: { wall, door }, anchor, avoid: [anchor] });
  it("sited beside the requester on flat ground; 55 blocks + a 2-block plug when door-less", () => {
    const r = prepare({ grid: flatWorld(), inv: { dirt: 80 }, creative: false, spec: spec("dirt"), existing: null, botPos: { x: 0, y: 64, z: 0 } });
    if (!r.ok) throw new Error(r.detail);
    expect(r.total).toBe(55);
    expect(r.missing).toEqual([]);
    expect(r.needs.consumed["dirt"]).toBe(55 + 2 + r.order.scaffolds);
    // never on top of the requester
    const o = r.origin;
    expect(anchor.x >= o.x - 1 && anchor.x <= o.x + 5 && anchor.z >= o.z - 1 && anchor.z <= o.z + 5).toBe(false);
    // the doorway stays free of blocks
    const cells = new Set(r.remaining.map(cellKey));
    for (const c of r.bp.clear) expect(cells.has(cellKey({ x: c.x + o.x, y: c.y + o.y, z: c.z + o.z }))).toBe(false);
  });
  it("a dirt shelter with no dirt: the executor digs it itself (no planner goal)", () => {
    const r = prepare({ grid: flatWorld(), inv: { stone_sword: 1 }, creative: false, spec: spec("dirt"), existing: null, botPos: { x: 0, y: 64, z: 0 } });
    if (!r.ok) throw new Error(r.detail);
    expect(r.missing).toEqual([]);
    expect(r.needs.selfSupply).toMatchObject({ item: "dirt" });
    expect(r.needs.selfSupply!.count).toBeGreaterThanOrEqual(57);
  });
  it("a cobblestone shelter with none: planner goals for the stone", () => {
    const r = prepare({ grid: flatWorld(), inv: { stone_pickaxe: 1 }, creative: false, spec: spec("cobblestone"), existing: null, botPos: { x: 0, y: 64, z: 0 } });
    if (!r.ok) throw new Error(r.detail);
    expect(r.missing.find((m) => m.item === "cobblestone")?.count ?? 0).toBeGreaterThanOrEqual(55);
  });
});
