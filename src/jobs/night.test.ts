import { describe, expect, it } from "vitest";
import { buildBlueprint } from "../build/blueprints.js";
import { computeNeeds } from "../build/materials.js";
import { inNightWindow, pickShelterWall, shelterGeometry, ticksToDawn } from "./night.js";
import type { Facing } from "../build/types.js";

describe("night clock", () => {
  it("is night from dusk to dawn only", () => {
    expect(inNightWindow(13_000)).toBe(true);
    expect(inNightWindow(23_499)).toBe(true);
    expect(inNightWindow(23_500)).toBe(false);
    expect(inNightWindow(1_000)).toBe(false);
    expect(inNightWindow(6_000)).toBe(false);
    expect(ticksToDawn(13_000)).toBe(10_500);
    expect(ticksToDawn(2_000)).toBe(0);
  });
});

describe("pickShelterWall", () => {
  it("uses what the bot has enough of, else dirt", () => {
    expect(pickShelterWall({ stone_sword: 1, bread: 5 })).toBe("dirt");
    expect(pickShelterWall({ cobblestone: 64 })).toBe("cobblestone");
    expect(pickShelterWall({ spruce_planks: 60 })).toBe("spruce_planks");
    expect(pickShelterWall({ cobblestone: 40 })).toBe("cobblestone"); // most of it: top up
    expect(pickShelterWall({ cobblestone: 5, dirt: 3 })).toBe("dirt");
  });
});

describe("shelter blueprint", () => {
  const facings: Facing[] = ["north", "south", "east", "west"];
  it("is a 5x5 hut: 3x3 interior, 2 high, roofed, one 2-high doorway, no windows", () => {
    for (const f of facings) {
      const bp = buildBlueprint("shelter", { wall: "dirt", door: false }, f);
      expect(bp.kind).toBe("shelter");
      expect(bp.size).toEqual({ x: 5, y: 3, z: 5 });
      const cells = new Set(bp.placements.map((p) => `${p.x},${p.y},${p.z}`));
      // 16 ring cells x 2 rows - 2 doorway cells = 30 walls, 25 roof
      expect(bp.placements.filter((p) => p.role === "wall")).toHaveLength(30);
      expect(bp.placements.filter((p) => p.role === "roof")).toHaveLength(25);
      expect(bp.placements.some((p) => p.role === "window" || p.role === "door")).toBe(false);
      expect(bp.clear).toHaveLength(2);
      // interior (1..3, 0..1, 1..3) is empty
      for (let x = 1; x <= 3; x++) for (let y = 0; y <= 1; y++) for (let z = 1; z <= 3; z++) expect(cells.has(`${x},${y},${z}`)).toBe(false);
    }
  });
  it("with a door: 2 door cells instead of an open doorway", () => {
    const bp = buildBlueprint("shelter", { wall: "oak_planks", door: true }, "south");
    expect(bp.placements.filter((p) => p.role === "door")).toHaveLength(2);
    expect(bp.params).toMatchObject({ wall: "oak_planks", door: true });
  });
  it("door-less needs 2 extra wall blocks to plug the doorway; a door doesn't", () => {
    const plain = computeNeeds(buildBlueprint("shelter", { wall: "dirt", door: false }, "south"), {}, { creative: false, scaffolds: 0 });
    expect(plain.consumed["dirt"]).toBe(30 + 25 + 2);
    const withDoor = computeNeeds(buildBlueprint("shelter", { wall: "dirt", door: true }, "south"), { oak_door: 1 }, { creative: false, scaffolds: 0 });
    expect(withDoor.consumed["dirt"]).toBe(55);
    expect(withDoor.missing.some((m) => /_door$/.test(m.item))).toBe(false);
  });
});

describe("shelterGeometry", () => {
  it("puts inside / centre / corner behind the doorway for every facing", () => {
    const origin = { x: 100, y: 64, z: 200 };
    for (const f of ["north", "south", "east", "west"] as Facing[]) {
      for (const door of [true, false]) {
        const g = shelterGeometry(origin, f, door);
        const bp = buildBlueprint("shelter", { wall: "dirt", door }, f);
        const wall = new Set(bp.placements.map((p) => `${p.x + origin.x},${p.y + origin.y},${p.z + origin.z}`));
        // the doorway sits in the ring; inside, centre and corner are free interior cells at floor level
        expect(g.doorway[1].y).toBe(g.doorway[0].y + 1);
        for (const c of [g.inside, g.centre, g.corner]) {
          expect(wall.has(`${c.x},${c.y},${c.z}`)).toBe(false);
          expect(c.x).toBeGreaterThanOrEqual(origin.x + 1);
          expect(c.x).toBeLessThanOrEqual(origin.x + 3);
          expect(c.z).toBeGreaterThanOrEqual(origin.z + 1);
          expect(c.z).toBeLessThanOrEqual(origin.z + 3);
          expect(c.y).toBe(origin.y);
        }
        // outside is one step beyond the ring
        const inRing = (c: { x: number; z: number }): boolean => c.x >= origin.x && c.x <= origin.x + 4 && c.z >= origin.z && c.z <= origin.z + 4;
        expect(inRing(g.outside)).toBe(false);
        expect(inRing(g.doorway[0])).toBe(true);
        // inside is adjacent to the doorway, centre one further, in a line
        expect(Math.abs(g.inside.x - g.doorway[0].x) + Math.abs(g.inside.z - g.doorway[0].z)).toBe(1);
        expect(Math.abs(g.centre.x - g.doorway[0].x) + Math.abs(g.centre.z - g.doorway[0].z)).toBe(2);
      }
    }
  });
});
