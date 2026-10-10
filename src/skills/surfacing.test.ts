import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import { findAirRoute, findRoofDig, suffocatingBlock, type CellAt } from "./surfacing.js";
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
