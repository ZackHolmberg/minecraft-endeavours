/**
 * Offline simulation of `Explorer.tunnelToward` (the find job's directed staircase) in a fake block world:
 * stone below y=63, air above, a stack of ore as the target. Pathfinder moves are replaced by teleports to the
 * goal cell; digging turns blocks to air. Checks the geometry: never straight down, never into the target, arrives
 * within reach, copes with a target nearer in plan than it is deep (the stairs first run away).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";

vi.mock("../skills/navigation.js", () => ({
  navigate: async (bot: Bot, goal: { x: number; y: number; z: number }) => {
    bot.entity.position.set(goal.x + 0.5, goal.y, goal.z + 0.5);
    return { ok: true, message: "ok" };
  },
}));
vi.mock("../skills/structure-guard.js", () => ({ builtStructureReason: () => null }));

const { Explorer } = await import("./explore.js");

function world(extra: Record<string, string> = {}) {
  const over = new Map<string, string>(Object.entries(extra));
  const nameAt = (x: number, y: number, z: number): string => over.get(`${x},${y},${z}`) ?? (y > 63 ? "air" : y === 63 ? "grass_block" : y <= -40 ? "deepslate" : "stone");
  const dug: string[] = [];
  const block = (p: Vec3) => {
    const name = nameAt(p.x, p.y, p.z);
    const air = name === "air";
    return { name, position: p.clone(), boundingBox: air ? "empty" : "block", canHarvest: () => true, digTime: () => 0 };
  };
  const bot = {
    username: "t",
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 },
    inventory: { items: () => [] },
    heldItem: null,
    blockAt: (p: Vec3) => block(p.floored()),
    dig: async (b: { position: Vec3 }) => {
      over.set(`${b.position.x},${b.position.y},${b.position.z}`, "air");
      dug.push(`${b.position.x},${b.position.y},${b.position.z}`);
    },
    stopDigging: () => {},
    findBlocks: () => [],
    findBlock: () => null,
  } as unknown as Bot;
  return { bot, dug, nameAt };
}

/** digCell waits 250 ms per dug cell (falling gravel); run the whole tunnel on fake time. */
async function run<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.finally(() => (done = true));
  for (let i = 0; i < 20_000 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  return p;
}

const ctx = () => ({ signal: new AbortController().signal, radius: 64, baseline: 0, jobId: "j" });

describe("Explorer.tunnelToward", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("digs a staircase down to a deep ore that is nearer in plan than it is deep, and stops within reach without digging it", async () => {
    const target = new Vec3(18, -26, 9);
    const w = world({ "18,-26,9": "diamond_ore", "19,-26,9": "diamond_ore", "18,-25,9": "diamond_ore" });
    const ex = new Explorer(w.bot, [], ctx(), { origin: new Vec3(0.5, 64, 0.5) });
    const r = await run(ex.tunnelToward(target, 3.0, 60 * 60_000));
    expect(r.ok, r.detail).toBe(true);
    const d = w.bot.entity.position.offset(0, 1, 0).distanceTo(target.offset(0.5, 0.5, 0.5));
    expect(d).toBeLessThanOrEqual(3.0);
    for (const o of ["18,-26,9", "19,-26,9", "18,-25,9"]) expect(w.dug).not.toContain(o);
    // a staircase, not a shaft: the bot is never directly above the cell it just dug out below it
    expect(w.dug.length).toBeGreaterThan(80);
    expect(w.dug.length).toBeLessThan(600);
    // never straight down: consecutive stair columns differ horizontally
    const cols = new Set(w.dug.map((k) => k.split(",").filter((_, i) => i !== 1).join(",")));
    expect(cols.size).toBeGreaterThan(40); // the way back from the away-leg re-uses columns, a shaft would be ~3
  });

  it("a target far away horizontally and only slightly deeper: stairs down, then a level tunnel", async () => {
    const target = new Vec3(-30, 40, 5);
    const w = world({ "-30,40,5": "iron_ore" });
    const ex = new Explorer(w.bot, [], ctx(), { origin: new Vec3(0.5, 64, 0.5) });
    const r = await run(ex.tunnelToward(target, 3.0, 60 * 60_000));
    expect(r.ok, r.detail).toBe(true);
    expect(w.dug).not.toContain("-30,40,5");
    expect(Math.abs(w.bot.entity.position.y - 40)).toBeLessThanOrEqual(2);
  });

  it("refuses to dig into lava: fails with the reason instead of tunnelling through", async () => {
    // a lava lake across the whole route at y=20
    const extra: Record<string, string> = { "18,-26,9": "diamond_ore" };
    for (let x = -80; x <= 80; x++) for (let z = -80; z <= 80; z++) extra[`${x},20,${z}`] = "lava";
    const w = world(extra);
    const ex = new Explorer(w.bot, [], ctx(), { origin: new Vec3(0.5, 64, 0.5) });
    const r = await run(ex.tunnelToward(new Vec3(18, -26, 9), 3.0, 60 * 60_000));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/liquid|unsafe|won't dig/);
    expect(w.bot.entity.position.y).toBeGreaterThan(18);
  });

  it("stops when cancelled", async () => {
    const w = world();
    const ac = new AbortController();
    const ex = new Explorer(w.bot, [], { ...ctx(), signal: ac.signal }, { origin: new Vec3(0.5, 64, 0.5) });
    ac.abort();
    const r = await run(ex.tunnelToward(new Vec3(18, -26, 9), 3.0, 60 * 60_000));
    expect(r).toEqual({ ok: false, detail: "cancelled" });
    expect(w.dug).toHaveLength(0);
  });
});
