import { describe, expect, it } from "vitest";
import { chooseDirtCell, CLEARANCE, DIRT_DIG_CAP, isPlayerBlock } from "./dirt-source.js";

const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Flat natural world: grass at y=63, dirt 60..62, stone below; overrides in `w`. */
function world(over: Record<string, string> = {}) {
  const w = new Map(Object.entries(over));
  return (x: number, y: number, z: number): string => w.get(k(x, y, z)) ?? (y > 63 ? "air" : y === 63 ? "grass_block" : y >= 60 ? "dirt" : "stone");
}
const me = { x: 0.5, y: 64, z: 0.5 };
const site = { minX: 100, maxX: 104, minZ: 100, maxZ: 104 };

describe("chooseDirtCell (promotion review M4)", () => {
  it("picks plain natural ground when nothing is built nearby", () => {
    const c = chooseDirtCell(world(), me, { site });
    expect(c).not.toBeNull();
    expect(c!.y).toBe(63);
  });

  it("never digs within CLEARANCE blocks of a crafted or player block, even a non-obvious one", () => {
    for (const block of ["oak_planks", "cobblestone", "furnace", "crafting_table", "chest", "torch", "farmland"]) {
      const nameAt = world({ [k(0, 64, 0)]: block });
      // with radius 3 every candidate is within 4 of the block
      const c = chooseDirtCell(nameAt, me, { site, radius: 3 });
      expect(c, block).toBeNull();
    }
    expect(CLEARANCE).toBe(4);
  });

  it("digs again once the player's block is farther than the clearance", () => {
    const nameAt = world({ [k(0, 64, 20)]: "oak_planks" });
    const c = chooseDirtCell(nameAt, me, { site });
    expect(c).not.toBeNull();
    expect(Math.max(Math.abs(c!.x - 0), Math.abs(c!.z - 20))).toBeGreaterThan(CLEARANCE);
  });

  it("never takes a 1-thick dirt floor or path (air or a non-natural layer underneath)", () => {
    // a raised dirt platform: grass over air
    const platform = world(Object.fromEntries([-8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap((x) => [-8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap((z) => [[k(x, 62, z), "air"], [k(x, 61, z), "air"]]))));
    expect(chooseDirtCell(platform, me, { site })).toBeNull();
  });

  it("stays away from farmland, dirt paths and saplings (adjacent) but may use ground beyond them", () => {
    const nameAt = world({ [k(2, 63, 0)]: "dirt_path", [k(-2, 64, 0)]: "oak_sapling" });
    const c = chooseDirtCell(nameAt, me, { site, radius: 2 });
    // cells touching the path (x 1..3, z -1..1) or the sapling (x -3..-1, z -1..1) are excluded
    if (c) {
      const nearPath = Math.abs(c.x - 2) <= 1 && Math.abs(c.z) <= 1;
      const nearSap = Math.abs(c.x + 2) <= 1 && Math.abs(c.z) <= 1;
      expect(nearPath || nearSap).toBe(false);
    }
  });

  it("prefers a slope (open side) over a lawn cell, and skips the build site and the block underfoot", () => {
    // a one-block bank at x=3: the cell at (3,63,0) has air on its -x side because (2,63,0) was removed earlier
    const nameAt = world({ [k(2, 63, 0)]: "air", [k(2, 62, 0)]: "air" });
    const c = chooseDirtCell(nameAt, me, { site, radius: 4 });
    expect(c).toMatchObject({ y: 63, z: 0 });
    expect([1, 3]).toContain(c!.x); // beside the notch, not a lawn cell that is equally close
    // the site footprint is off limits
    const near = chooseDirtCell(world(), { x: 99.5, y: 64, z: 99.5 }, { site, radius: 2 });
    expect(near === null || near.x < site.minX - 3 || near.z < site.minZ - 3).toBe(true);
    // never the block underfoot
    const under = chooseDirtCell(world(), me, { site, radius: 0 });
    expect(under).toBeNull();
  });

  it("classifies player blocks", () => {
    expect(isPlayerBlock("furnace")).toBe(true);
    expect(isPlayerBlock("oak_planks")).toBe(true);
    expect(isPlayerBlock("grass_block")).toBe(false);
    expect(isPlayerBlock("oak_log")).toBe(false); // trees are natural
    expect(DIRT_DIG_CAP).toBeGreaterThanOrEqual(60); // a dirt hut needs ~57+
  });
});
