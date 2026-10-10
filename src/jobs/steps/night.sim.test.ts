/**
 * Night executor simulation: the real enterAndSeal / light / wait / leave flow against an in-memory
 * world (navigate, activateBlock and placeBlock replaced by physics-lite fakes), for the door and the
 * door-less shelter, plus the bed path. The clock is a counter that reaches dawn after a few polls.
 */
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { shelterGeometry } from "../night.js";
import type { StepRunContext } from "../runner.js";

type W = Map<string, string>;
const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const S = {
  world: new Map() as W,
  doorOpen: false,
  pos: new Vec3(0.5, 64, 10.5),
  inv: {} as Record<string, number>,
  polls: 0,
  dawnAfter: 3,
  sleeping: false,
  sleepFails: 0,
  log: [] as string[],
};
const solid = (n: string): boolean => !/^(air|torch)$/.test(n) && !/_door$/.test(n);
const nameAt = (x: number, y: number, z: number): string => S.world.get(k(x, y, z)) ?? (y < 64 ? "grass_block" : "air");

vi.mock("./util.js", () => ({ tracked: (_b: unknown, _n: string, p: unknown, fn: (p: unknown) => Promise<unknown>) => fn(p) }));
vi.mock("../../state/index.js", () => ({ getBotState: () => undefined }));
vi.mock("../../skills/navigation.js", () => ({
  navigate: async (_b: unknown, goal: { x: number; y: number; z: number }) => {
    // a closed door blocks the way in
    const doorCells = [...S.world.entries()].filter(([, n]) => /_door$/.test(n)).map(([c]) => c);
    const inShelter = (x: number, z: number): boolean => x >= 100 && x <= 104 && z >= 200 && z <= 204;
    if (!S.doorOpen && doorCells.length > 0 && inShelter(goal.x, goal.z) && !inShelter(Math.floor(S.pos.x), Math.floor(S.pos.z))) return { ok: false, message: "no path (closed door)" };
    if (solid(nameAt(goal.x, goal.y, goal.z)) || solid(nameAt(goal.x, goal.y + 1, goal.z))) return { ok: false, message: "no path" };
    S.pos = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
    S.log.push(`nav ${goal.x},${goal.y},${goal.z}`);
    return { ok: true, message: "ok" };
  },
}));
vi.mock("../../skills/interaction.js", () => ({
  activateBlock: async (_b: unknown, { position: p }: { position: { x: number; y: number; z: number } }) => {
    if (/_door$/.test(nameAt(p.x, p.y, p.z))) {
      S.doorOpen = !S.doorOpen;
      S.log.push(`door ${S.doorOpen ? "open" : "closed"}`);
    }
    return { ok: true, message: "ok" };
  },
}));
vi.mock("../../skills/world.js", () => ({
  placeBlock: async (_b: unknown, { type, position: p }: { type: string; position: { x: number; y: number; z: number } }) => {
    if ((S.inv[type] ?? 0) < 1) return { ok: false, message: `no ${type}` };
    if (new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5).distanceTo(S.pos.offset(0, 1.62, 0)) > 4.5) return { ok: false, message: "out of reach" };
    if (solid(nameAt(p.x, p.y, p.z))) return { ok: false, message: "occupied" };
    S.inv[type]!--;
    S.world.set(k(p.x, p.y, p.z), type);
    S.log.push(`place ${type} ${p.x},${p.y},${p.z}`);
    return { ok: true, message: "placed" };
  },
}));
vi.mock("../../skills/survival.js", () => ({
  sleepIn: async () => {
    if (S.sleepFails > 0) {
      S.sleepFails--;
      return { ok: false, message: "monsters nearby" };
    }
    S.sleeping = true;
    S.log.push("sleep");
    return { ok: true, message: "sleeping in white_bed at (1, 64, 1) (nearby)" };
  },
}));
vi.mock("../../skills/place-helper.js", () => ({ placeFromInventoryNearby: async () => ({ ok: true, block: {} }) }));

const mkBot = (): Bot =>
  ({
    username: "nb",
    health: 20,
    get isSleeping() {
      return S.sleeping;
    },
    get entity() {
      return { position: S.pos };
    },
    get time() {
      S.polls += 1;
      return { timeOfDay: S.polls > S.dawnAfter ? 23_600 : 14_000 };
    },
    registry: { blocksArray: [{ name: "white_bed", id: 1 }] },
    findBlock: () => null,
    inventory: { items: () => Object.entries(S.inv).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count, type: 1 })) },
    blockAt: (p: Vec3) => {
      const name = nameAt(p.x, p.y, p.z);
      return { name, position: p, boundingBox: solid(name) || /_door$/.test(name) ? "block" : "empty", getProperties: () => ({ open: S.doorOpen }) };
    },
    dig: async (b: { position: Vec3 }) => {
      S.world.set(k(b.position.x, b.position.y, b.position.z), "air");
      S.log.push(`dig ${b.position.x},${b.position.y},${b.position.z}`);
    },
  }) as unknown as Bot;

const ctx = (): StepRunContext => ({ signal: new AbortController().signal, radius: 64, baseline: 0, jobId: "j" });
const ORIGIN = { x: 100, y: 64, z: 200 };

function reset(door: boolean, inv: Record<string, number>): void {
  S.world = new Map();
  const geo = shelterGeometry(ORIGIN, "south", door, "dirt");
  // walls: ring x 0..4, z 0..4, rows 0..1, roof row 2; doorway left open (or a closed door)
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) for (let y = 0; y < 3; y++) {
    const ring = x === 0 || x === 4 || z === 0 || z === 4;
    if (y < 2 && !ring) continue;
    S.world.set(k(ORIGIN.x + x, ORIGIN.y + y, ORIGIN.z + z), "dirt");
  }
  for (const c of geo.doorway) S.world.delete(k(c.x, c.y, c.z));
  if (door) {
    S.world.set(k(geo.doorway[0].x, geo.doorway[0].y, geo.doorway[0].z), "oak_door");
    S.world.set(k(geo.doorway[1].x, geo.doorway[1].y, geo.doorway[1].z), "oak_door");
  }
  S.doorOpen = false;
  S.inv = { ...inv };
  S.pos = new Vec3(geo.outside.x + 0.5, geo.outside.y, geo.outside.z + 0.5);
  S.polls = 0;
  S.sleeping = false;
  S.sleepFails = 0;
  S.log = [];
}

describe("night executor simulation", () => {
  it("door shelter: opens, walks in, closes the door, lights the torch, waits for dawn, opens up and leaves", async () => {
    reset(true, { torch: 2 });
    const { createNightDeps } = await import("./night.js");
    const geo = shelterGeometry(ORIGIN, "south", true, "dirt");
    const r = await createNightDeps(mkBot()).holdInShelter(geo, ctx());
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    const doors = S.log.filter((l) => l.startsWith("door"));
    expect(doors).toEqual(["door open", "door closed", "door open"]); // in, shut behind me, out at dawn
    const closeAt = S.log.indexOf("door closed");
    expect(S.log.slice(0, closeAt).some((l) => l === `nav ${geo.centre.x},${geo.centre.y},${geo.centre.z}`)).toBe(true); // inside before closing
    expect(S.log.some((l) => l.startsWith("place torch"))).toBe(true);
    expect(S.log.at(-1)).toBe(`nav ${geo.outside.x},${geo.outside.y},${geo.outside.z}`);
  });

  it("door-less shelter: plugs the 2-high doorway from inside, waits, digs the plug out at dawn", async () => {
    reset(false, { dirt: 3 });
    const { createNightDeps } = await import("./night.js");
    const geo = shelterGeometry(ORIGIN, "south", false, "dirt");
    const r = await createNightDeps(mkBot()).holdInShelter(geo, ctx());
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    const placed = S.log.filter((l) => l.startsWith("place dirt"));
    expect(placed).toEqual([`place dirt ${geo.doorway[0].x},${geo.doorway[0].y},${geo.doorway[0].z}`, `place dirt ${geo.doorway[1].x},${geo.doorway[1].y},${geo.doorway[1].z}`]);
    expect(S.log.filter((l) => l.startsWith("dig"))).toHaveLength(2);
    expect(S.log.some((l) => l.startsWith("place torch"))).toBe(false); // none carried: fine
  });

  it("a doorway that cannot be reached fails with a reason instead of waiting outside", async () => {
    reset(true, {});
    S.world.delete(k(...(Object.values(shelterGeometry(ORIGIN, "south", true, "dirt").doorway[0]) as [number, number, number])));
    const { createNightDeps } = await import("./night.js");
    const r = await createNightDeps(mkBot()).holdInShelter(shelterGeometry(ORIGIN, "south", true, "dirt"), ctx());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.failure.detail).toMatch(/couldn't shelter/);
  });

  it("sleepThrough: retries a failed sleep, then sleeps until dawn", async () => {
    reset(true, {});
    S.sleepFails = 1;
    const { createNightDeps } = await import("./night.js");
    // wake-up check: stay asleep until dawn flips the clock
    const bot = mkBot();
    const r = await createNightDeps(bot).sleepThrough(ctx());
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(S.log.filter((l) => l === "sleep")).toHaveLength(1);
  }, 15_000);
});
