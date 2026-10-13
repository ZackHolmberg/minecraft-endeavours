import { describe, expect, it } from "vitest";
import { encodeDesign, placedCount, type Orientation } from "../pixelart/design.js";
import { buildBlueprint, canonicalFootprint, countBlocks, pixelart } from "./blueprints.js";
import { pixelSiteTuning, prepare } from "./prepare.js";
import { planOrder, type AbsPlacement } from "./support.js";
import { dirVec, type Facing } from "./types.js";

const FACINGS: Facing[] = ["north", "south", "east", "west"];
const ALPHA = [
  ["red_concrete", "white_concrete", "blue_concrete"],
  ["yellow_concrete", null, "black_concrete"],
];
const design = (cells: Array<Array<string | null>>, orientation: Orientation) =>
  encodeDesign({ w: cells[0]!.length, h: cells.length, cells }, { orientation });

/** What a viewer standing on the `facing` side sees, as rows of block names (top row first, left to right). */
function view(placements: Array<{ x: number; y: number; z: number; block: string }>, facing: Facing, orientation: Orientation): Array<Array<string | null>> {
  const f = dirVec(facing);
  const look = { x: -f.x, z: -f.z }; // the viewer looks at the art
  const right = { x: -look.z, z: look.x };
  const pts = placements.map((p) => ({ block: p.block, col: p.x * right.x + p.z * right.z, row: orientation === "wall" ? p.y : p.x * look.x + p.z * look.z }));
  const cols = [...new Set(pts.map((p) => p.col))].sort((a, b) => a - b);
  const rows = [...new Set(pts.map((p) => p.row))].sort((a, b) => b - a);
  return rows.map((r) => cols.map((c) => pts.find((p) => p.row === r && p.col === c)?.block ?? null));
}

describe("pixelart blueprint: orientation", () => {
  for (const orientation of ["wall", "flat"] as const) {
    for (const facing of FACINGS) {
      it(`${orientation} facing ${facing} reads correctly from the facing side (no mirroring)`, () => {
        const bp = pixelart({ design: design(ALPHA, orientation) }, facing);
        expect(bp.kind).toBe("pixelart");
        expect(bp.placements).toHaveLength(5);
        // fix the transparent hole: the viewer grid has a gap where nothing is placed
        const seen = view(bp.placements, facing, orientation);
        expect(seen).toEqual(ALPHA);
      });
    }
  }

  it("wall: vertical plane, image top = highest y, 1 thick; dims swap for east/west", () => {
    const d = design(ALPHA, "wall");
    const south = pixelart({ design: d }, "south");
    expect(south.size).toEqual({ x: 3, y: 2, z: 1 });
    expect(south.placements.every((p) => p.z === 0 && p.y >= 0 && p.y <= 1 && p.role === "wall")).toBe(true);
    expect(south.placements.find((p) => p.block === "red_concrete")).toMatchObject({ y: 1 });
    expect(south.placements.find((p) => p.block === "yellow_concrete")).toMatchObject({ y: 0 });
    expect(pixelart({ design: d }, "east").size).toEqual({ x: 1, y: 2, z: 3 });
  });
  it("flat: one layer at standing level, image top = far side", () => {
    const flat = pixelart({ design: design(ALPHA, "flat") }, "south");
    expect(flat.size).toEqual({ x: 3, y: 1, z: 2 });
    expect(flat.placements.every((p) => p.y === 0 && p.role === "floor")).toBe(true);
    expect(flat.placements.find((p) => p.block === "red_concrete")).toMatchObject({ x: 0, z: 0 }); // top row = z 0 = far from a viewer standing south
  });
  it("transparent cells place nothing; counts, summary and params carry the design", () => {
    const bp = buildBlueprint("pixelart", { design: design(ALPHA, "wall") }, "north");
    expect(countBlocks(bp)).toEqual({ red_concrete: 1, white_concrete: 1, blue_concrete: 1, yellow_concrete: 1, black_concrete: 1 });
    expect(bp.summary).toMatch(/^pixel art 3x2 wall/);
    expect(bp.summary).toContain("3x2 wall");
    expect(placedCount((bp.params["design"] as ReturnType<typeof design>))).toBe(5);
    expect(new Set(bp.placements.map((p) => `${p.x},${p.y},${p.z}`)).size).toBe(5);
  });
  it("canonical footprint matches the oriented blueprint", () => {
    expect(canonicalFootprint("pixelart", { design: design(ALPHA, "wall") })).toEqual({ sx: 3, sz: 1, height: 2 });
    expect(canonicalFootprint("pixelart", { design: design(ALPHA, "flat") })).toEqual({ sx: 3, sz: 2, height: 1 });
  });
  it("refuses an invalid design instead of building something", () => {
    expect(() => pixelart({ design: { v: 1, w: 1, h: 1, blocks: ["tnt"], rows: ["0"] } }, "south")).toThrow();
    expect(() => pixelart({}, "south")).toThrow();
  });
});

// flat world, ground top at y=63
const world = (over: Record<string, string> = {}) => ({
  blockAt: (x: number, y: number, z: number) => over[`${x},${y},${z}`] ?? (y > 63 ? "air" : y === 63 ? "grass_block" : "dirt"),
});
const big = (w: number, h: number, orientation: Orientation) =>
  design(Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => ["red_concrete", "white_concrete", "blue_concrete"][(r + c) % 3]!)), orientation);
const input = (d: ReturnType<typeof design>, extra: Partial<Parameters<typeof prepare>[0]> = {}): Parameters<typeof prepare>[0] => ({
  grid: world(),
  inv: {},
  creative: true,
  spec: { blueprint: "pixelart", params: { design: d }, anchor: { x: 0, y: 64, z: 0 }, avoid: [{ x: 0, y: 64, z: 0 }] },
  existing: null,
  botPos: { x: 0, y: 64, z: 0 },
  ...extra,
});

describe("prepare: pixel art", () => {
  it("wall: sited away from the player, facing them, all placements ordered, creative materials fetched just in time", () => {
    const r = prepare(input(big(33, 23, "wall")));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(759);
    expect(r.order.unplaceable).toHaveLength(0);
    expect(r.creativeItems).toEqual([]); // the Builder tops up per colour (see Builder.creativeBatch)
    expect(r.missing).toEqual([]);
    // the whole picture is >= 13 blocks from the requester and faces them
    const { origin, facing } = r;
    const f = dirVec(facing);
    const wallCentre = { x: origin.x + (facing === "south" || facing === "north" ? 16.5 : 0.5), z: origin.z + (facing === "east" || facing === "west" ? 16.5 : 0.5) };
    expect(Math.hypot(wallCentre.x, wallCentre.z)).toBeGreaterThanOrEqual(12);
    expect(f.x * (0 - wallCentre.x) + f.z * (0 - wallCentre.z)).toBeGreaterThan(0); // the player is on the facing side
    // bottom row stands on the ground
    expect(Math.min(...r.remaining.map((p) => p.y))).toBe(64);
    expect(Math.max(...r.remaining.map((p) => p.y))).toBe(64 + 22);
  });
  it("flat: on the ground surface, replacing flowers and grass", () => {
    const over: Record<string, string> = {};
    for (let x = -30; x <= 30; x++) for (let z = -30; z <= 30; z++) if ((x + z) % 3 === 0) over[`${x},64,${z}`] = (x + z) % 2 ? "poppy" : "short_grass";
    const r = prepare(input(big(20, 12, "flat"), { grid: world(over) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.remaining.every((p) => p.y === 64)).toBe(true);
    expect(r.clearCells.length).toBeGreaterThan(20); // the flowers/grass under the picture get cleared first
    expect(r.clearCells.every((c) => ["poppy", "short_grass"].includes(world(over).blockAt(c.x, c.y, c.z)!))).toBe(true);
  });
  it("resumes onto an existing origin and skips blocks already placed", () => {
    const d = big(10, 6, "wall");
    const first = prepare(input(d));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const done: Record<string, string> = {};
    for (const p of first.remaining.slice(0, 20)) done[`${p.x},${p.y},${p.z}`] = p.block;
    const again = prepare(input(d, { grid: world(done), existing: { origin: first.origin, facing: first.facing } }));
    expect(again.ok && again.doneCount).toBe(20);
    expect(again.ok && again.total).toBe(60);
    expect(again.ok && again.remaining.length).toBe(40);
  });
  it("survival: lists the blocks as missing materials", () => {
    const r = prepare(input(big(6, 4, "wall"), { creative: false, inv: { red_concrete: 3 } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const miss = Object.fromEntries(r.missing.map((m) => [m.item, m.count]));
    expect(miss["red_concrete"]).toBe(8 - 3); // 24 cells / 3 colours = 8 each
    expect(miss["white_concrete"]).toBe(8);
  });
  it("fails cleanly (no throw) on a broken design or no room", () => {
    const r = prepare({ ...input(big(6, 4, "wall")), spec: { blueprint: "pixelart", params: { design: { w: 1 } }, anchor: { x: 0, y: 64, z: 0 }, avoid: [] } });
    expect(r).toMatchObject({ ok: false });
    const wet = prepare(input(big(33, 23, "wall"), { grid: { blockAt: (_x, y) => (y > 63 ? "air" : "water") } }));
    expect(wet).toMatchObject({ ok: false, kind: "no_site" });
  });
  it("site tuning: stand-off grows with the wall, flat has none, radius is capped", () => {
    expect(pixelSiteTuning("house", {})).toEqual({});
    const w = pixelSiteTuning("pixelart", { design: big(33, 23, "wall") });
    expect(w.standoff).toBe(13);
    expect(w.radius).toBeGreaterThanOrEqual(w.standoff! + 16);
    expect(pixelSiteTuning("pixelart", { design: big(60, 40, "flat") }).standoff).toBeUndefined();
    expect(pixelSiteTuning("pixelart", { design: big(128, 46, "wall") }).radius).toBeLessThanOrEqual(48);
  });
});

describe("planOrder at pixel-art scale", () => {
  it("orders thousands of cells in one layer quickly and completely", () => {
    const cells: AbsPlacement[] = [];
    for (let x = 0; x < 80; x++) for (let z = 0; z < 70; z++) cells.push({ x, y: 64, z, block: "red_concrete" });
    const t0 = Date.now();
    const r = planOrder(cells, { isSolidWorld: (c) => c.y <= 63, start: { x: 0, y: 64, z: 0 } });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.actions.filter((a) => a.op === "place")).toHaveLength(5600);
    expect(r.unplaceable).toHaveLength(0);
    expect(r.scaffolds).toBe(0);
  });
  it("a floating island of cells above a hole gets scaffolded or reported, never dropped silently", () => {
    const cells: AbsPlacement[] = [{ x: 0, y: 64, z: 0, block: "red_concrete" }, { x: 0, y: 66, z: 0, block: "red_concrete" }];
    const r = planOrder(cells, { isSolidWorld: (c) => c.y <= 63, start: { x: 0, y: 64, z: 0 } });
    const placed = r.actions.filter((a) => a.op === "place").length;
    expect(placed + r.unplaceable.length).toBe(2);
  });
});
