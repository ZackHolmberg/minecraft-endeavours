/**
 * Dig-in executor simulation: the real digAndSeal / wait / climbOut flow against an in-memory world
 * (dig, gravity, placement and the pillar replaced by physics-lite fakes), for the straight-down
 * pocket and the hillside tunnel, using plans chosen by the real `choosePocket`.
 */
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { choosePocket, type Probe } from "../pocket.js";
import type { StepRunContext } from "../runner.js";

const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const S = {
  world: new Map<string, string>(),
  fill: (_x: number, y: number): string => (y > 63 ? "air" : y === 63 ? "grass_block" : y >= 60 ? "dirt" : "stone"),
  pos: new Vec3(0.5, 64, 0.5),
  inv: {} as Record<string, number>,
  polls: 0,
  dawnAfter: 2,
  log: [] as string[],
  headAtSeal: null as string | null,
};
const nameAt = (x: number, y: number, z: number): string => S.world.get(k(x, y, z)) ?? S.fill(x, y);
const solid = (n: string): boolean => n !== "air";
const probe: Probe = (x, y, z) => ({ name: nameAt(x, y, z), solid: solid(nameAt(x, y, z)) });

function settle(): void {
  // gravity: fall to the first solid below the feet (same column)
  const x = Math.floor(S.pos.x);
  const z = Math.floor(S.pos.z);
  let y = Math.floor(S.pos.y + 0.01);
  while (!solid(nameAt(x, y - 1, z))) y--;
  S.pos = new Vec3(S.pos.x, y, S.pos.z);
}

vi.mock("./util.js", () => ({ tracked: (_b: unknown, _n: string, p: unknown, fn: (p: unknown) => Promise<unknown>) => fn(p) }));
vi.mock("../../state/index.js", () => ({ getBotState: () => undefined }));
vi.mock("../../skills/melee-guard.js", () => ({ fightNearbyHostiles: async () => 0 }));
vi.mock("../../skills/navigation.js", () => ({
  navigate: async (_b: unknown, goal: { x: number; y: number; z: number }) => {
    if (solid(nameAt(goal.x, goal.y, goal.z)) || solid(nameAt(goal.x, goal.y + 1, goal.z))) return { ok: false, message: "no path" };
    S.pos = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
    settle();
    S.log.push(`nav ${goal.x},${goal.y},${goal.z}`);
    return { ok: true, message: "ok" };
  },
}));
vi.mock("../../skills/world.js", () => ({
  placeBlock: async (_b: unknown, { type, position: p }: { type: string; position: { x: number; y: number; z: number } }) => {
    if ((S.inv[type] ?? 0) < 1) return { ok: false, message: `no ${type}` };
    if (solid(nameAt(p.x, p.y, p.z))) return { ok: false, message: "occupied" };
    S.inv[type]!--;
    S.world.set(k(p.x, p.y, p.z), type);
    if (S.log.filter((l) => l.startsWith("place")).length === 0) S.headAtSeal = nameAt(Math.floor(S.pos.x), Math.floor(S.pos.y) + 1, Math.floor(S.pos.z));
    S.log.push(`place ${type} ${p.x},${p.y},${p.z}`);
    return { ok: true, message: "placed" };
  },
}));
vi.mock("../../skills/pillar.js", () => ({
  PILLAR_FILLER_PRIORITY: ["dirt", "cobblestone"],
  waitForGrounded: async () => true,
  pickFiller: () => {
    const name = ["dirt", "cobblestone"].find((n) => (S.inv[n] ?? 0) > 0);
    return name ? { name, count: S.inv[name], type: 1 } : null;
  },
  pillarUpBy: async (_b: unknown, h: number) => {
    for (let i = 0; i < h; i++) {
      if ((S.inv.dirt ?? 0) < 1) return { ok: false, message: "no filler" };
      S.inv.dirt!--;
      S.world.set(k(Math.floor(S.pos.x), Math.floor(S.pos.y), Math.floor(S.pos.z)), "dirt");
      S.pos = new Vec3(S.pos.x, S.pos.y + 1, S.pos.z);
    }
    S.log.push(`pillar ${h}`);
    return { ok: true, message: "ok" };
  },
}));

const mkBot = (): Bot =>
  ({
    username: "nb",
    health: 20,
    get isSleeping() {
      return false;
    },
    get entity() {
      return { position: S.pos, onGround: true };
    },
    get time() {
      S.polls += 1;
      return { timeOfDay: S.polls > S.dawnAfter ? 23_600 : 14_000 };
    },
    registry: { blocksArray: [] },
    findBlock: () => null,
    heldItem: null,
    setControlState: () => undefined,
    lookAt: async () => undefined,
    stopDigging: () => undefined,
    inventory: { items: () => Object.entries(S.inv).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count, type: 1 })) },
    blockAt: (p: Vec3) => {
      const name = nameAt(p.x, p.y, p.z);
      return { name, position: p, boundingBox: solid(name) ? "block" : "empty" };
    },
    dig: async (b: { position: Vec3; name: string }) => {
      S.world.set(k(b.position.x, b.position.y, b.position.z), "air");
      S.log.push(`dig ${b.name} ${b.position.x},${b.position.y},${b.position.z}`);
      if (b.name === "grass_block" || b.name === "dirt") S.inv.dirt = (S.inv.dirt ?? 0) + 1;
      settle();
    },
  }) as unknown as Bot;

const ctx = (): StepRunContext => ({ signal: new AbortController().signal, radius: 64, baseline: 0, jobId: "j" });
const reset = (x: number, y: number, z: number): void => {
  S.world = new Map();
  S.inv = {};
  S.polls = 0;
  S.log = [];
  S.headAtSeal = null;
  S.pos = new Vec3(x + 0.5, y, z + 0.5);
};

describe("dig-in executor simulation", () => {
  it("straight down: digs 3 from inside out, seals the top with the dug dirt, waits, opens up and climbs out", async () => {
    reset(0, 64, 0);
    const plan = choosePocket(probe, { x: 0, y: 64, z: 0 })!;
    expect(plan.kind).toBe("down");
    const { createNightDeps } = await import("./night.js");
    const r = await createNightDeps(mkBot()).digInThrough!(plan, ctx());
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    const digs = S.log.filter((l) => l.startsWith("dig"));
    expect(digs).toHaveLength(plan.dig.length + 1); // 3 down + the lid at dawn
    expect(digs.slice(0, 3).map((l) => l.split(" ")[2])).toEqual(plan.dig.map((c) => `${c.x},${c.y},${c.z}`));
    const placed = S.log.filter((l) => l.startsWith("place"));
    expect(placed).toEqual([`place dirt ${plan.seal[0]!.x},${plan.seal[0]!.y},${plan.seal[0]!.z}`]);
    expect(S.headAtSeal).toBe("air"); // head room left under the lid
    expect(S.log.indexOf("pillar 3")).toBeGreaterThan(S.log.findIndex((l) => l.startsWith("place")));
    expect(Math.floor(S.pos.y)).toBe(plan.stand.y); // back on the surface
  }, 15_000);

  it("hillside: tunnels in two cells, steps in, plugs the entrance feet+head, opens it at dawn", async () => {
    const hillFill = (x: number, y: number): string => (x >= 3 ? (y <= 68 ? "dirt" : "air") : y > 63 ? "air" : "sand");
    S.fill = hillFill;
    try {
      reset(0, 64, 0);
      const hillProbe: Probe = (x, y, z) => ({ name: nameAt(x, y, z), solid: solid(nameAt(x, y, z)) });
      const plan = choosePocket(hillProbe, { x: 0, y: 64, z: 0 })!;
      expect(plan.kind).toBe("hill");
      const { createNightDeps } = await import("./night.js");
      const r = await createNightDeps(mkBot()).digInThrough!(plan, ctx());
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
      const placed = S.log.filter((l) => l.startsWith("place")).map((l) => l.split(" ")[2]);
      expect(placed).toEqual(plan.seal.map((c) => `${c.x},${c.y},${c.z}`));
      expect(S.headAtSeal).toBe("air");
      // after dawn the entrance is open again and the bot is outside
      for (const c of plan.seal) expect(nameAt(c.x, c.y, c.z)).toBe("air");
      expect(Math.floor(S.pos.x)).toBe(plan.stand.x);
    } finally {
      S.fill = (_x, y) => (y > 63 ? "air" : y === 63 ? "grass_block" : y >= 60 ? "dirt" : "stone");
    }
  }, 15_000);

  it("a pocket that cannot be sealed fails with the reason instead of waiting in an open hole", async () => {
    reset(0, 64, 0);
    const plan = choosePocket(probe, { x: 0, y: 64, z: 0 })!;
    const bot = mkBot();
    // dug blocks yield nothing
    (bot as unknown as { dig: (b: { position: Vec3 }) => Promise<void> }).dig = async (b) => {
      S.world.set(k(b.position.x, b.position.y, b.position.z), "air");
      settle();
    };
    const { createNightDeps } = await import("./night.js");
    const r = await createNightDeps(bot).digInThrough!(plan, ctx());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.failure.detail).toMatch(/couldn't dig in: nothing to seal/);
  }, 15_000);

  // ── review M3: a sealed pocket is always reopened ──────────────────────────
  const abortWhen = (ac: AbortController, cond: () => boolean): void => {
    const t = setInterval(() => {
      if (cond()) {
        ac.abort();
        clearInterval(t);
      }
    }, 10);
  };
  const ctxOf = (ac: AbortController): StepRunContext => ({ signal: ac.signal, radius: 64, baseline: 0, jobId: "j" });

  it("cancelled while sealed in: opens the lid and climbs out (not left entombed)", async () => {
    reset(0, 64, 0);
    S.dawnAfter = 1e9;
    try {
      const plan = choosePocket(probe, { x: 0, y: 64, z: 0 })!;
      expect(plan.kind).toBe("down");
      const ac = new AbortController();
      abortWhen(ac, () => S.log.some((l) => l.startsWith("place")));
      const { createNightDeps } = await import("./night.js");
      const r = await createNightDeps(mkBot()).digInThrough!(plan, ctxOf(ac));
      expect(r.ok === false && r.failure.kind).toBe("cancelled");
      expect(S.log.some((l) => l.startsWith("pillar"))).toBe(true);
      expect(Math.floor(S.pos.y)).toBe(plan.stand.y); // back on the surface
      expect(nameAt(plan.seal[0]!.x, plan.seal[0]!.y, plan.seal[0]!.z)).not.toBe("air"); // column refilled by the pillar, not a hole
    } finally {
      S.dawnAfter = 2;
    }
  }, 15_000);

  it("cancelled in the middle of digging: the half-dug shaft is left too", async () => {
    reset(0, 64, 0);
    const plan = choosePocket(probe, { x: 0, y: 64, z: 0 })!;
    const ac = new AbortController();
    const bot = mkBot();
    const realDig = (bot as unknown as { dig: (b: { position: Vec3; name: string }) => Promise<void> }).dig;
    let digs = 0;
    (bot as unknown as { dig: typeof realDig }).dig = async (b) => {
      await realDig(b);
      if (++digs === 2) ac.abort(); // stop requested after the second cell
    };
    const { createNightDeps } = await import("./night.js");
    const r = await createNightDeps(bot).digInThrough!(plan, ctxOf(ac));
    expect(r.ok === false && r.failure.kind).toBe("cancelled");
    expect(Math.floor(S.pos.y)).toBe(plan.stand.y);
  }, 15_000);

  it("hillside pocket cancelled while sealed: entrance reopened and the bot outside", async () => {
    S.fill = (x, y) => (x >= 3 ? (y <= 68 ? "dirt" : "air") : y > 63 ? "air" : "sand");
    S.dawnAfter = 1e9;
    try {
      reset(0, 64, 0);
      const plan = choosePocket(probe, { x: 0, y: 64, z: 0 })!;
      expect(plan.kind).toBe("hill");
      const ac = new AbortController();
      abortWhen(ac, () => S.log.filter((l) => l.startsWith("place")).length >= plan.seal.length);
      const { createNightDeps } = await import("./night.js");
      const r = await createNightDeps(mkBot()).digInThrough!(plan, ctxOf(ac));
      expect(r.ok === false && r.failure.kind).toBe("cancelled");
      for (const c of plan.seal) expect(nameAt(c.x, c.y, c.z)).toBe("air");
      expect(Math.floor(S.pos.x)).toBe(plan.stand.x);
    } finally {
      S.fill = (_x, y) => (y > 63 ? "air" : y === 63 ? "grass_block" : y >= 60 ? "dirt" : "stone");
      S.dawnAfter = 2;
    }
  }, 15_000);

  it("boot recovery: a bot found inside its pocket climbs out; one outside is left alone", async () => {
    reset(0, 64, 0);
    const plan = choosePocket(probe, { x: 0, y: 64, z: 0 })!;
    // state after a restart mid-night: cells dug, lid placed, bot resting inside
    for (const c of plan.dig) S.world.set(k(c.x, c.y, c.z), "air");
    for (const c of plan.seal) S.world.set(k(c.x, c.y, c.z), "dirt");
    S.inv = { dirt: 3 };
    S.pos = new Vec3(plan.rest.x + 0.5, plan.rest.y, plan.rest.z + 0.5);
    const { createNightDeps } = await import("./night.js");
    const deps = createNightDeps(mkBot());
    expect(await deps.leavePocket!(plan, new AbortController().signal)).toBe(true);
    expect(Math.floor(S.pos.y)).toBe(plan.stand.y);

    reset(0, 64, 0);
    S.pos = new Vec3(plan.stand.x + 0.5, plan.stand.y, plan.stand.z + 0.5);
    expect(await createNightDeps(mkBot()).leavePocket!(plan, new AbortController().signal)).toBe(false);
    expect(S.log).toEqual([]);
  }, 15_000);
});
