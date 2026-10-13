import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import { dryFirst, touchesLiquidAt } from "./world.js";

describe("dryFirst", () => {
  const names: Record<string, string> = { "0,51,0": "water", "3,60,0": "flowing_water" };
  const nameAt = (p: Vec3): string | null => names[`${p.x},${p.y},${p.z}`] ?? "stone";

  it("detects a liquid on any face or in the block itself", () => {
    expect(touchesLiquidAt(nameAt, new Vec3(0, 50, 0))).toBe(true);
    expect(touchesLiquidAt(nameAt, new Vec3(3, 60, 0))).toBe(true);
    expect(touchesLiquidAt(nameAt, new Vec3(9, 50, 9))).toBe(false);
  });

  it("moves wet candidates behind dry ones, keeping order within each group", () => {
    const wetNear = new Vec3(0, 50, 0);
    const dryA = new Vec3(5, 50, 5);
    const wetB = new Vec3(4, 60, 0);
    const dryB = new Vec3(9, 50, 9);
    const list = [wetNear, dryA, wetB, dryB];
    dryFirst(list, nameAt);
    expect(list).toEqual([dryA, dryB, wetNear, wetB]);
  });

  it("keeps an all-wet list (last resort) and an all-dry list unchanged", () => {
    const wet = [new Vec3(0, 50, 0), new Vec3(4, 60, 0)];
    dryFirst(wet, nameAt);
    expect(wet).toEqual([new Vec3(0, 50, 0), new Vec3(4, 60, 0)]);
  });
});
