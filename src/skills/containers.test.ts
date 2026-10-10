import { describe, expect, it } from "vitest";
import { isContainerName, isDoubleChestHalf } from "./containers.js";

describe("containers", () => {
  it("recognises every container block, including coloured shulker boxes", () => {
    for (const n of ["chest", "trapped_chest", "barrel", "shulker_box", "red_shulker_box", "light_blue_shulker_box"]) expect(isContainerName(n)).toBe(true);
    for (const n of ["ender_chest", "crafting_table", "chest_minecart", "furnace", "shulker_shell"]) expect(isContainerName(n)).toBe(false);
  });

  it("a double chest is two adjacent same-type blocks at the same height", () => {
    const a = { name: "chest", x: 1, y: 64, z: 1 };
    expect(isDoubleChestHalf(a, { name: "chest", x: 2, y: 64, z: 1 })).toBe(true);
    expect(isDoubleChestHalf(a, { name: "chest", x: 1, y: 64, z: 0 })).toBe(true);
    expect(isDoubleChestHalf(a, { name: "chest", x: 2, y: 64, z: 2 })).toBe(false);
    expect(isDoubleChestHalf(a, { name: "chest", x: 2, y: 65, z: 1 })).toBe(false);
    expect(isDoubleChestHalf(a, { name: "trapped_chest", x: 2, y: 64, z: 1 })).toBe(false);
    expect(isDoubleChestHalf({ name: "barrel", x: 1, y: 64, z: 1 }, { name: "barrel", x: 2, y: 64, z: 1 })).toBe(false);
  });
});
