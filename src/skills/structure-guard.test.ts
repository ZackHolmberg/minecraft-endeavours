import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import { isCheapBreak, isNaturalTerrain, isTreeLog } from "./structure-guard.js";

type World = Map<string, string>;
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const nameAt = (w: World) => (p: Vec3): { name: string } | null => ({ name: w.get(key(p.x, p.y, p.z)) ?? "air" });
const fill = (w: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, name: string): void => {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) w.set(key(x, y, z), name);
};

/** Trunk of `h` logs with a leaf crown (radius 2 around the top). */
function tree(w: World, x: number, z: number, h: number, log = "oak_log"): void {
  fill(w, x, 64, z, x, 63 + h, z, log);
  fill(w, x - 2, 62 + h, z - 2, x + 2, 64 + h, z + 2, "oak_leaves");
  fill(w, x, 64, z, x, 63 + h, z, log); // trunk over the crown
}

describe("isTreeLog", () => {
  it("accepts every log of a natural tree", () => {
    const w: World = new Map();
    tree(w, 0, 0, 5);
    for (let y = 64; y <= 68; y++) expect(isTreeLog(nameAt(w), new Vec3(0, y, 0))).toBe(true);
  });

  it("accepts a 2x2 dark-oak style trunk", () => {
    const w: World = new Map();
    fill(w, 0, 64, 0, 1, 68, 1, "dark_oak_log");
    fill(w, -2, 67, -2, 3, 70, 3, "dark_oak_leaves");
    fill(w, 0, 64, 0, 1, 68, 1, "dark_oak_log");
    expect(isTreeLog(nameAt(w), new Vec3(1, 65, 1))).toBe(true);
  });

  it("rejects a 5x5 log-wall hut with a plank roof, even with leaves right next to it", () => {
    const w: World = new Map();
    fill(w, 0, 64, 0, 4, 67, 4, "oak_log");
    fill(w, 1, 64, 1, 3, 66, 3, "air");
    fill(w, 0, 67, 0, 4, 67, 4, "oak_planks");
    for (const [x, y, z] of [[0, 64, 0], [2, 64, 0], [0, 66, 2], [4, 65, 4]] as const) expect(isTreeLog(nameAt(w), new Vec3(x, y, z))).toBe(false);
    fill(w, -2, 64, -2, -1, 68, 6, "oak_leaves"); // forest next door
    expect(isTreeLog(nameAt(w), new Vec3(0, 64, 0))).toBe(false);
  });

  it("rejects a bare log pillar, a stripped log and a log beam", () => {
    const w: World = new Map();
    fill(w, 0, 64, 0, 0, 68, 0, "oak_log");
    expect(isTreeLog(nameAt(w), new Vec3(0, 66, 0))).toBe(false); // no leaves anywhere near
    const s: World = new Map();
    tree(s, 0, 0, 4);
    s.set(key(0, 65, 0), "stripped_oak_log");
    expect(isTreeLog(nameAt(s), new Vec3(0, 66, 0))).toBe(false); // cluster contains a stripped log
    const b: World = new Map();
    tree(b, 0, 0, 4);
    fill(b, 0, 67, 0, 3, 67, 0, "oak_log"); // 4-long beam off the trunk
    expect(isTreeLog(nameAt(b), new Vec3(0, 66, 0))).toBe(false);
  });

  it("memoises one verdict for the whole cluster", () => {
    const w: World = new Map();
    tree(w, 0, 0, 5);
    const memo = new Map<string, boolean>();
    expect(isTreeLog(nameAt(w), new Vec3(0, 64, 0), memo)).toBe(true);
    expect(memo.size).toBe(5);
    w.clear(); // would now be false if recomputed
    w.set(key(0, 64, 0), "oak_log");
    expect(isTreeLog(nameAt(w), new Vec3(0, 64, 0), memo)).toBe(true);
  });
});

describe("path-digging allowlist", () => {
  it("natural terrain + foliage yes; logs and built blocks no", () => {
    for (const n of ["stone", "dirt", "grass_block", "sand", "gravel", "andesite", "coal_ore", "oak_leaves", "jungle_leaves", "vine", "short_grass", "fern"]) {
      expect(isNaturalTerrain(n) || isCheapBreak(n), n).toBe(true);
    }
    for (const n of ["oak_log", "jungle_log", "stripped_oak_log", "oak_planks", "cobblestone", "oak_door", "glass", "chest", "crafting_table", "furnace", "white_wool"]) {
      expect(isNaturalTerrain(n) || isCheapBreak(n), n).toBe(false);
    }
  });
});
