import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import { builtReasonAt, craftedWithin, isCheapBreak, isFreeableTreeBlock, isNaturalTerrain, isTreeLog } from "./structure-guard.js";

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

describe("isFreeableTreeBlock (H1: what freeStuckDrops may break)", () => {
  it("a natural tree's log and its leaves qualify", () => {
    const w: World = new Map();
    tree(w, 0, 0, 5);
    expect(isFreeableTreeBlock(nameAt(w), new Vec3(0, 64, 0))).toBe(true); // stump log
    expect(isFreeableTreeBlock(nameAt(w), new Vec3(1, 67, 1))).toBe(true); // canopy leaf next to the trunk
  });
  it("a leaf hedge / treehouse floor with no tree log within 4 blocks does not", () => {
    const w: World = new Map();
    fill(w, 0, 64, 0, 6, 64, 0, "oak_leaves"); // a hedge
    expect(isFreeableTreeBlock(nameAt(w), new Vec3(3, 64, 0))).toBe(false);
    const roof: World = new Map();
    fill(roof, 0, 70, 0, 4, 70, 4, "oak_leaves"); // leaf roof
    tree(roof, 20, 20, 5); // a tree far away
    expect(isFreeableTreeBlock(nameAt(roof), new Vec3(2, 70, 2))).toBe(false);
  });
  it("leaves of a real tree still do not qualify when they touch a crafted block", () => {
    const w: World = new Map();
    tree(w, 0, 0, 5);
    w.set(key(2, 67, 0), "oak_planks"); // a treehouse plank beside the canopy
    expect(isFreeableTreeBlock(nameAt(w), new Vec3(1, 67, 0))).toBe(false); // adjacent to the plank
    expect(isFreeableTreeBlock(nameAt(w), new Vec3(-2, 68, -2))).toBe(true); // far side of the crown is fine
  });
  it("a player's log post, wall or stripped log never qualifies, nor does one beside planks", () => {
    const w: World = new Map();
    fill(w, 0, 64, 0, 0, 68, 0, "oak_log"); // bare post
    expect(isFreeableTreeBlock(nameAt(w), new Vec3(0, 64, 0))).toBe(false);
    const wall: World = new Map();
    fill(wall, 0, 64, 0, 4, 66, 0, "oak_log"); // log wall
    fill(wall, -2, 67, -2, 6, 68, 2, "oak_leaves");
    expect(isFreeableTreeBlock(nameAt(wall), new Vec3(2, 64, 0))).toBe(false);
    const near: World = new Map();
    tree(near, 0, 0, 5);
    near.set(key(1, 64, 0), "spruce_planks");
    expect(isFreeableTreeBlock(nameAt(near), new Vec3(0, 64, 0))).toBe(false);
    expect(isFreeableTreeBlock(nameAt(near), new Vec3(0, 70, 5))).toBe(false); // not a tree block at all (air)
  });
  it("only logs and leaves: stone, dirt, planks never", () => {
    const w: World = new Map();
    tree(w, 0, 0, 5);
    w.set(key(3, 64, 3), "dirt");
    expect(isFreeableTreeBlock(nameAt(w), new Vec3(3, 64, 3))).toBe(false);
  });
});

describe("builtReasonAt / craftedWithin (pure forms)", () => {
  it("flags stone set into two crafted blocks, and finds crafted blocks within a radius", () => {
    const w: World = new Map();
    w.set(key(0, 0, 0), "stone");
    w.set(key(1, 0, 0), "oak_planks");
    w.set(key(-1, 0, 0), "oak_planks");
    expect(builtReasonAt(nameAt(w), { name: "stone", position: new Vec3(0, 0, 0) })).toMatch(/built wall/);
    expect(craftedWithin(nameAt(w), new Vec3(0, 2, 0), 2)).toBe(true);
    expect(craftedWithin(nameAt(w), new Vec3(0, 5, 0), 2)).toBe(false);
  });
});
