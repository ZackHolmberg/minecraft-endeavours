import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { FLY_LAND_MS, FLY_TAKEOFF_MS, FlightGate, playerAirborne } from "./follow.js";
import { columnHoverY, flyFollowTick, isFlying, stopFlyingNow } from "../skills/flight.js";

describe("playerAirborne", () => {
  const free = () => "free" as const;
  it("on the ground or with anything solid/liquid within 3 blocks below is not airborne", () => {
    expect(playerAirborne(true, free)).toBe(false);
    expect(playerAirborne(false, (dy) => (dy === 3 ? "solid" : "free"))).toBe(false);
    expect(playerAirborne(undefined, (dy) => (dy === 2 ? "liquid" : "free"))).toBe(false);
  });
  it("three free cells below and not on the ground is airborne; unloaded terrain is unknown", () => {
    expect(playerAirborne(false, free)).toBe(true);
    expect(playerAirborne(undefined, free)).toBe(true);
    expect(playerAirborne(false, (dy) => (dy === 2 ? null : "free"))).toBeNull();
  });
});

describe("FlightGate", () => {
  it("takes off only after the player has been airborne continuously, lands after they have been supported continuously", () => {
    const g = new FlightGate();
    expect(g.update(0, true)).toBe(false);
    expect(g.update(FLY_TAKEOFF_MS - 1, true)).toBe(false);
    expect(g.update(FLY_TAKEOFF_MS, true)).toBe(true);
    // a one-tick flicker to "supported" does not land
    expect(g.update(5_000, false)).toBe(true);
    expect(g.update(5_100, true)).toBe(true);
    expect(g.update(6_000, false)).toBe(true);
    expect(g.update(6_000 + FLY_LAND_MS, false)).toBe(false);
  });
  it("a jump (airborne briefly) never takes off, and unknown observations keep the mode", () => {
    const g = new FlightGate();
    g.update(0, true);
    g.update(400, false);
    expect(g.update(2_000, true)).toBe(false); // the clock restarted
    expect(g.update(2_500, null)).toBe(false);
    g.reset();
    expect(g.isFlying).toBe(false);
  });
});

/** Minimal creative bot in a world given by `solid(x,y,z)`; unlisted cells are air. */
function fakeBot(pos: Vec3, solid: (x: number, y: number, z: number) => boolean, mode = "creative"): Bot {
  return {
    username: "t",
    game: { gameMode: mode },
    entity: { position: pos, velocity: new Vec3(0, 0, 0) },
    physics: { gravity: 0.08 },
    clearControlStates: () => {},
    _client: { write: () => {} },
    blockAt: (p: Vec3) => ({ name: solid(p.x, p.y, p.z) ? "stone" : "air", boundingBox: solid(p.x, p.y, p.z) ? "block" : "empty" }),
  } as unknown as Bot;
}

describe("flyFollowTick (creative follow flight)", () => {
  it("steps 0.5 blocks toward a point `dist` short of the player, then hovers there", () => {
    const bot = fakeBot(new Vec3(0.5, 70, 0.5), () => false);
    const target = new Vec3(30.5, 90, 0.5);
    const r = flyFollowTick(bot, target, 3);
    expect(r).toEqual({ arrived: false, blocked: false });
    expect(isFlying(bot)).toBe(true);
    expect(bot.physics.gravity).toBe(0);
    expect(bot.entity.position.distanceTo(new Vec3(0.5, 70, 0.5))).toBeCloseTo(0.5, 5);
    let n = 0;
    while (!flyFollowTick(bot, target, 3).arrived && n++ < 500);
    expect(bot.entity.position.distanceTo(target)).toBeLessThanOrEqual(4.01);
    expect(bot.entity.position.distanceTo(target)).toBeGreaterThan(2);
    stopFlyingNow(bot);
    expect(bot.physics.gravity).toBeCloseTo(0.08);
  });

  it("never enters a block: a wall stops it (blocked), a lower step around it is taken", () => {
    // a solid wall at x in [5,6) for every y and z: nothing gets through
    const wall = (x: number) => x >= 5 && x < 6;
    const bot = fakeBot(new Vec3(0.5, 70, 0.5), (x) => wall(x));
    const target = new Vec3(30.5, 70, 0.5);
    for (let i = 0; i < 300; i++) {
      flyFollowTick(bot, target, 3);
      expect(bot.entity.position.x + 0.3).toBeLessThan(5.0001); // the 0.6-wide body never touches the wall
    }
    expect(bot.entity.position.distanceTo(target)).toBeGreaterThan(20); // and gets no closer
    // a floor-level obstacle only: it climbs over instead of through
    const low = fakeBot(new Vec3(0.5, 70, 0.5), (x, y) => x >= 5 && x < 6 && y < 72);
    for (let i = 0; i < 120; i++) flyFollowTick(low, target, 3);
    expect(low.entity.position.x).toBeGreaterThan(8);
    stopFlyingNow(bot);
    stopFlyingNow(low);
  });

  it("does nothing in survival", () => {
    const bot = fakeBot(new Vec3(0.5, 70, 0.5), () => false, "survival");
    expect(flyFollowTick(bot, new Vec3(30, 70, 0), 3).blocked).toBe(true);
    expect(isFlying(bot)).toBe(false);
    expect(bot.entity.position.x).toBeCloseTo(0.5);
  });
});

describe("columnHoverY", () => {
  it("hovers `clearance` above the topmost block, null over unloaded chunks", () => {
    const bot = fakeBot(new Vec3(0, 70, 0), (_x, y) => y <= 64);
    expect(columnHoverY(bot, 10, 10, 70)).toBe(65 + 2);
    const unloaded = { ...bot, blockAt: () => null } as unknown as Bot;
    expect(columnHoverY(unloaded, 0, 0, 70)).toBeNull();
  });
});
