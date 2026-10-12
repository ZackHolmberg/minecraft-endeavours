import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import { findAirRoute, findFallbackSwim, findRoofDig, roofCellDiggable, suffocatingBlock, type CellAt } from "./surfacing.js";
import { SURFACE_BACKOFF_CAP_MS, surfaceBackoffMs } from "./auto-behaviors.js";
import { fallsOnBot } from "./structure-guard.js";

type W = Map<string, string>;
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const fill = (w: W, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, name: string): void => {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) w.set(key(x, y, z), name);
};
const at = (w: W): CellAt => (p) => {
  const n = w.get(key(p.x, p.y, p.z)) ?? "air";
  return { name: n, boundingBox: n === "air" || n === "water" ? "empty" : "block" };
};

/** The R6 terrain: a flooded tunnel (y 60..62) under a sandstone roof (y 63), open to air at the west end. */
function tunnel(sealed: boolean): W {
  const w: W = new Map();
  fill(w, -10, 55, -3, 20, 59, 3, "stone"); // floor
  fill(w, -10, 60, -3, 20, 64, 3, "stone"); // rock mass
  fill(w, 0, 60, 0, 12, 62, 0, "water"); // tunnel 13 long
  if (!sealed) fill(w, 0, 63, 0, 1, 66, 0, "air"); // shaft up at the west end
  if (!sealed) fill(w, 0, 63, 0, 0, 63, 0, "air");
  return w;
}

describe("findAirRoute", () => {
  it("swims back to the open end of a flooded tunnel", () => {
    const w = tunnel(false);
    const r = findAirRoute(at(w), new Vec3(10, 62, 0))!;
    expect(r).not.toBeNull();
    const end = r.path[r.path.length - 1]!;
    expect(end.x).toBeLessThanOrEqual(1);
    expect(r.path.length).toBeGreaterThan(8);
  });
  it("returns null when the water is sealed", () => {
    expect(findAirRoute(at(tunnel(true)), new Vec3(10, 62, 0))).toBeNull();
  });
});

describe("findRoofDig", () => {
  it("digs the thinnest natural roof of sealed water", () => {
    const w = tunnel(true);
    w.set(key(8, 63, 0), "air"); // thinner: a 1-block roof at x=8 would need ... make column x=8 a 1-thick sandstone cap
    w.set(key(8, 63, 0), "sandstone");
    w.set(key(8, 64, 0), "air");
    w.set(key(8, 65, 0), "air");
    const r = findRoofDig(at(w), new Vec3(10, 62, 0))!;
    expect(r).not.toBeNull();
    expect(r.stand.x).toBe(8);
    expect(r.dig.map((d) => key(d.x, d.y, d.z))).toEqual(["8,63,0"]);
  });
  it("refuses a roof with sand in it", () => {
    const w = tunnel(true);
    fill(w, 0, 63, 0, 12, 63, 0, "sand");
    fill(w, 0, 64, 0, 12, 66, 0, "air");
    expect(findRoofDig(at(w), new Vec3(10, 62, 0))).toBeNull();
  });
});

describe("fallsOnBot", () => {
  const w: W = new Map([[key(0, 5, 0), "gravel"]]);
  const nameAt = (p: Vec3) => ({ name: w.get(key(p.x, p.y, p.z)) ?? "air" });
  it("flags a block under gravel when we stand in its column", () => {
    expect(fallsOnBot(nameAt, new Vec3(0, 4, 0), { x: 0.5, y: 3, z: 0.5 })).toBe(true);
  });
  it("allows it from beside the column and when digging down", () => {
    expect(fallsOnBot(nameAt, new Vec3(0, 4, 0), { x: 2.5, y: 4, z: 0.5 })).toBe(false);
    expect(fallsOnBot(nameAt, new Vec3(0, 3, 0), { x: 0.5, y: 4, z: 0.5 })).toBe(false);
  });
});

describe("suffocatingBlock", () => {
  const cube = [[0, 0, 0, 1, 1, 1]];
  it("full cubes suffocate; leaves, glass and slabs do not", () => {
    expect(suffocatingBlock({ name: "sand", boundingBox: "block", shapes: cube } as never)).toBe(true);
    expect(suffocatingBlock({ name: "oak_leaves", boundingBox: "block", shapes: cube } as never)).toBe(false);
    expect(suffocatingBlock({ name: "oak_slab", boundingBox: "block", shapes: [[0, 0, 0, 1, 0.5, 1]] } as never)).toBe(false);
    expect(suffocatingBlock({ name: "water", boundingBox: "empty", shapes: [] } as never)).toBe(false);
  });
});

describe("findRoofDig player-build guard (M1)", () => {
  /** A sealed pool y 60..62 with a 1-thick `stone` floor of a player's room at y=63 and the room above. */
  function pool(): W {
    const w: W = new Map();
    fill(w, -10, 55, -3, 20, 59, 3, "stone");
    fill(w, -10, 60, -3, 20, 63, 3, "stone");
    fill(w, 0, 60, 0, 12, 62, 0, "water");
    fill(w, 0, 64, 0, 12, 66, 0, "air"); // the room above the floor
    return w;
  }
  it("digs a plain natural roof with open space above (no crafted blocks around)", () => {
    expect(findRoofDig(at(pool()), new Vec3(10, 62, 0))).not.toBeNull();
  });
  it("refuses to dig a stone floor with the player's planks walls/furniture within 2 blocks", () => {
    const w = pool();
    fill(w, 0, 64, -1, 12, 65, -1, "oak_planks"); // the room's wall
    expect(findRoofDig(at(w), new Vec3(10, 62, 0))).toBeNull();
  });
  it("refuses when a crafted block sits next to the free cell above the roof", () => {
    const w = pool();
    fill(w, 0, 65, 1, 12, 65, 1, "oak_planks"); // within 2 of the space above y=63 only
    w.set(key(0, 66, 0), "glass");
    expect(findRoofDig(at(w), new Vec3(10, 62, 0))).toBeNull();
  });
  it("roofCellDiggable: natural only, never cobblestone, glass, logs", () => {
    const w: W = new Map([[key(0, 0, 0), "cobblestone"], [key(1, 0, 0), "stone"], [key(2, 0, 0), "glass"]]);
    expect(roofCellDiggable(at(w), new Vec3(0, 0, 0))).toBe(false);
    expect(roofCellDiggable(at(w), new Vec3(1, 0, 0))).toBe(false); // glass within 2
    expect(roofCellDiggable(at(new Map([[key(1, 0, 0), "stone"]])), new Vec3(1, 0, 0))).toBe(true);
  });
});

describe("findFallbackSwim (M1: when the roof can't be dug)", () => {
  it("heads for open air beyond the normal search radius", () => {
    const w: W = new Map();
    fill(w, -5, 50, -3, 60, 58, 3, "stone");
    fill(w, -5, 59, -3, 60, 70, 3, "stone");
    fill(w, 0, 60, 0, 40, 62, 0, "water"); // 40-long tunnel
    fill(w, 40, 63, 0, 40, 66, 0, "air"); // shaft at the far end
    expect(findAirRoute(at(w), new Vec3(0, 62, 0))).toBeNull(); // beyond radius 20
    const f = findFallbackSwim(at(w), new Vec3(0, 62, 0))!;
    expect(f.kind).toBe("air");
    expect(f.path.length).toBeGreaterThan(30);
  });
  it("sealed pool with nothing better: swims toward the highest water; null on a flat pool", () => {
    const w: W = new Map();
    fill(w, -5, 50, -3, 20, 70, 3, "stone");
    fill(w, 0, 60, 0, 6, 61, 0, "water");
    fill(w, 6, 62, 0, 6, 64, 0, "water"); // a chimney of water
    const f = findFallbackSwim(at(w), new Vec3(0, 61, 0))!;
    expect(f.kind).toBe("high");
    expect(f.path[f.path.length - 1]!.y).toBe(64);
    const flat: W = new Map();
    fill(flat, -5, 50, -3, 20, 70, 3, "stone");
    fill(flat, 0, 60, 0, 6, 61, 0, "water");
    expect(findFallbackSwim(at(flat), new Vec3(0, 61, 0))).toBeNull();
  });
});

describe("surfaceBackoffMs (M4)", () => {
  it("doubles from 1 s up to the 10 s cap", () => {
    expect([1, 2, 3, 4, 5, 9].map(surfaceBackoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, SURFACE_BACKOFF_CAP_MS, SURFACE_BACKOFF_CAP_MS]);
  });
});
