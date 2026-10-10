import { describe, expect, it } from "vitest";
import { choosePocket, choosePockets, digSeconds, type Probe, type ProbeBlock } from "./pocket.js";

/** Synthetic world: a map of "x,y,z" -> block name; everything else is `fill(y)`. */
function world(over: Record<string, string> = {}, fill: (y: number) => string = defaultFill): Probe {
  return (x, y, z) => {
    const name = over[`${x},${y},${z}`] ?? fill(y);
    return block(name);
  };
}
const AIR = new Set(["air", "short_grass", "poppy"]);
function block(name: string): ProbeBlock {
  return { name, solid: !AIR.has(name) && name !== "water" && name !== "lava" };
}
/** Flat plains: grass at y=63, dirt 60..62, stone below, air above. */
function defaultFill(y: number): string {
  if (y > 63) return "air";
  if (y === 63) return "grass_block";
  if (y >= 60) return "dirt";
  return "stone";
}
const FROM = { x: 0, y: 64, z: 0 };

describe("choosePocket on flat ground", () => {
  it("digs straight down under the bot's feet", () => {
    const p = choosePocket(world(), FROM)!;
    expect(p.kind).toBe("down");
    expect(p.stand).toEqual({ x: 0, y: 64, z: 0 });
    expect(p.dig).toEqual([{ x: 0, y: 63, z: 0 }, { x: 0, y: 62, z: 0 }, { x: 0, y: 61, z: 0 }]);
    expect(p.rest).toEqual({ x: 0, y: 61, z: 0 });
    expect(p.seal).toEqual([{ x: 0, y: 63, z: 0 }]);
    expect(p.yields).toBe(3);
  });

  it("avoids a column with water within 2 blocks", () => {
    const p = choosePocket(world({ "1,62,1": "water" }), FROM)!;
    expect(p.kind).toBe("down");
    expect(Math.max(Math.abs(p.stand.x - 1), Math.abs(p.stand.z - 1))).toBeGreaterThan(2);
  });

  it("never digs under or through sand / gravel", () => {
    const sandy = (y: number) => (y === 63 ? "sand" : defaultFill(y));
    expect(choosePocket(world({}, sandy), FROM)).toBeNull();
    const gravelLayer = world({ "0,62,0": "gravel" });
    const p = choosePocket(gravelLayer, FROM)!;
    expect(p.stand.x !== 0 || p.stand.z !== 0).toBe(true);
  });

  it("rejects a column with an open cave beside the resting cells", () => {
    const p = choosePocket(world({ "1,61,0": "air" }), FROM)!;
    expect(p.stand.x !== 0 || p.stand.z !== 0).toBe(true);
  });

  it("rejects a floor of air (cave below)", () => {
    const cave = (y: number) => (y === 60 ? "air" : defaultFill(y));
    expect(choosePocket(world({}, cave), FROM)).toBeNull();
  });

  it("stays out of player builds", () => {
    const planks: Record<string, string> = {};
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) if ((x + z) % 3 === 0) planks[`${x},64,${z}`] = "oak_planks";
    // planks scattered everywhere touch each other diagonally-not, but craftedWithin(3) sees them
    expect(choosePocket(world(planks), FROM)).toBeNull();
  });

  it("does not dig ore", () => {
    const ore = (y: number) => (y === 63 ? "grass_block" : y >= 60 ? "iron_ore" : "stone");
    expect(choosePocket(world({}, ore), FROM)).toBeNull();
  });

  it("prefers soft ground over stone without a pickaxe, and accepts stone with a spare filler", () => {
    const stony = (y: number) => (y > 63 ? "air" : "stone");
    expect(choosePocket(world({}, stony), FROM)).toBeNull(); // nothing to seal with
    const p = choosePocket(world({}, stony), FROM, { filler: 2 })!;
    expect(p.kind).toBe("down");
    expect(p.cost).toBeGreaterThan(25);
    const q = choosePocket(world({}, stony), FROM, { hasPickaxe: true })!;
    expect(q.cost).toBeLessThan(10);
    expect(q.yields).toBe(3);
  });

  it("bare-handed stone is slow, deepslate slower", () => {
    expect(digSeconds("stone", false)).toBeGreaterThan(digSeconds("dirt", false) * 5);
    expect(digSeconds("deepslate", false)).toBeGreaterThan(digSeconds("stone", false));
    expect(digSeconds("diamond_ore", true)).toBe(Number.POSITIVE_INFINITY);
  });

  it("prefers the nearest of equal columns", () => {
    const plans = choosePockets(world(), { x: 5, y: 64, z: 5 });
    expect(plans[0]!.stand).toEqual({ x: 5, y: 64, z: 5 });
  });

  it("returns null where nothing is loaded", () => {
    expect(choosePocket(() => null, FROM)).toBeNull();
  });
});

describe("choosePocket into a hillside", () => {
  // Ground is sand (cannot dig down) with a dirt hill rising to y=68 for x >= 3.
  const hill = (x: number, y: number): string => {
    if (x >= 3) return y <= 68 ? "dirt" : "air";
    if (y > 63) return "air";
    return y === 63 ? "sand" : "sand";
  };
  const probe: Probe = (x, y, _z) => block(hill(x, y));

  it("tunnels 2 deep, sealing the entrance with 2 blocks", () => {
    const p = choosePocket(probe, FROM)!;
    expect(p.kind).toBe("hill");
    expect(p.dir).toEqual({ x: 1, z: 0 });
    expect(p.dig).toHaveLength(4);
    expect(p.seal).toHaveLength(2);
    // standing on sand next to the slope, digging into dirt
    expect(p.stand.x).toBe(2);
    expect(p.rest.x).toBe(4);
    expect(p.dig.every((c) => c.x >= 3 && c.x <= 4)).toBe(true);
  });

  it("refuses a slope that is only one block thick (the far wall would be open)", () => {
    const thin = (x: number, y: number): string => (x === 3 || x === 4 ? (y <= 68 ? "dirt" : "air") : y > 63 ? "air" : "sand");
    expect(choosePocket((x, y, _z) => block(thin(x, y)), FROM)).toBeNull();
  });

  it("refuses gravel above the tunnel", () => {
    const g = (x: number, y: number): string => (x >= 3 && y === 66 ? "gravel" : hill(x, y));
    const p = choosePocket((x, y, _z) => block(g(x, y)), FROM);
    // the stand level (y=64) head cells are y=65; roof of the far cell (y=65 head -> 66 above) is gravel
    expect(p).toBeNull();
  });
});
