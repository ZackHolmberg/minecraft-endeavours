import { describe, expect, it } from "vitest";
import { blocksPlacement } from "./world.js";

describe("blocksPlacement", () => {
  it("flags flowers, saplings and mushrooms (not replaceable by a placement)", () => {
    for (const n of ["dandelion", "poppy", "red_tulip", "sunflower", "oak_sapling", "cherry_sapling", "mangrove_propagule", "red_mushroom", "sweet_berry_bush", "pink_petals"]) {
      expect(blocksPlacement(n), n).toBe(true);
    }
  });
  it("leaves replaceable plants, air and every player item alone", () => {
    for (const n of ["short_grass", "tall_grass", "fern", "large_fern", "dead_bush", "vine", "snow", "air", "water", "torch", "wall_torch", "white_carpet", "rail", "oak_sign", "redstone_wire", "flower_pot", "potted_poppy", "stone"]) {
      expect(blocksPlacement(n), n).toBe(false);
    }
  });
});
