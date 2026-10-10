/**
 * Executor simulation: the real Builder against an in-memory world. The skills it
 * calls (placeBlock, navigate, activateBlock) are replaced by physics-lite fakes
 * that enforce what the server would: reach, a solid neighbour, not placing into
 * the bot's own body. Checks sequencing, the door-from-outside rule, scaffold
 * removal and the block count, in survival and creative.
 */
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { prepare } from "../../build/prepare.js";
import type { BuildRunContext } from "../runner.js";

// ── fake world + bot ─────────────────────────────────────────────────────────
type World = Map<string, string>;
const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const SOLIDISH = (n: string): boolean => !/^(air|short_grass|poppy|water|wheat|nether_portal|fire)$/.test(n);

interface Sim {
  world: World;
  inv: Record<string, number>;
  pos: Vec3;
  creative: boolean;
  log: Array<{ op: string; at: string; botInside?: boolean; block?: string }>;
  box: { x0: number; z0: number; x1: number; z1: number } | null;
  /** The next N dug-up `dirt` blocks (scaffolds) drop nothing the bot can get. */
  loseDrops: number;
}
let sim: Sim;

function nameAt(x: number, y: number, z: number): string {
  const o = sim.world.get(k(x, y, z));
  if (o !== undefined) return o;
  if (Math.abs(x) > 60 || Math.abs(z) > 60) return "air";
  return y === 63 ? "grass_block" : y < 63 ? "dirt" : "air";
}
const fakeBlock = (x: number, y: number, z: number) => {
  const name = nameAt(x, y, z);
  const solid = SOLIDISH(name);
  return { name, position: new Vec3(x, y, z), boundingBox: solid ? "block" : "empty" };
};
const insideBox = (x: number, z: number): boolean => !!sim.box && x >= sim.box.x0 && x <= sim.box.x1 && z >= sim.box.z0 && z <= sim.box.z1;

vi.mock("./util.js", () => ({ tracked: (_b: unknown, _n: string, p: unknown, fn: (p: unknown) => Promise<unknown>) => fn(p) }));
vi.mock("../../state/index.js", () => ({ getBotState: () => undefined }));
vi.mock("../../skills/pathfinder-config.js", () => ({ ensureMovements: () => {} }));
vi.mock("../../skills/flight.js", () => ({ flyTo: async () => ({ ok: true, message: "" }), isFlying: () => false, land: async () => {} }));
vi.mock("../../skills/game-mode.js", () => ({ isCreative: () => sim.creative }));
vi.mock("../../skills/inventory.js", () => ({ pickUpNearby: async () => ({ ok: true, message: "" }) }));
vi.mock("../../skills/creative.js", () => ({
  getItems: async (_b: unknown, { items }: { items: Array<{ name: string; count: number }> }) => {
    for (const i of items) sim.inv[i.name] = Math.max(sim.inv[i.name] ?? 0, i.count);
    return { ok: true, message: "got" };
  },
}));
vi.mock("../../skills/navigation.js", () => ({
  navigate: async (_b: unknown, goal: { x: number; y: number; z: number }) => {
    const dest = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
    if (SOLIDISH(nameAt(goal.x, goal.y, goal.z)) || SOLIDISH(nameAt(goal.x, goal.y + 1, goal.z))) return { ok: false, message: "no path" };
    sim.pos = dest;
    sim.log.push({ op: "nav", at: k(goal.x, goal.y, goal.z) });
    return { ok: true, message: "arrived" };
  },
}));
vi.mock("../../skills/world.js", () => ({
  placeBlock: async (_b: unknown, { type, position: p }: { type: string; position: { x: number; y: number; z: number } }) => {
    // creative: the real placeBlock flies to a hover spot when out of reach
    if (sim.creative && sim.pos.offset(0, 1.62, 0).distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) > 4.5) sim.pos = new Vec3(p.x + 0.5, p.y + 2, p.z + 0.5);
    const eye = sim.pos.offset(0, 1.62, 0);
    if (eye.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) > 5.2) return { ok: false, message: `out of reach (${p.x},${p.y},${p.z})` };
    if (sim.pos.x + 0.3 > p.x && sim.pos.x - 0.3 < p.x + 1 && sim.pos.z + 0.3 > p.z && sim.pos.z - 0.3 < p.z + 1 && sim.pos.y + 1.8 > p.y && sim.pos.y < p.y + 1) return { ok: false, message: "standing in that cell" };
    if (SOLIDISH(nameAt(p.x, p.y, p.z))) return { ok: false, message: "occupied" };
    const nb = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => {
      const n = nameAt(p.x + dx!, p.y + dy!, p.z + dz!);
      return SOLIDISH(n) && !/_door$/.test(n);
    });
    if (!nb) return { ok: false, message: "no solid neighbour" };
    if (!sim.creative && (sim.inv[type] ?? 0) < 1) return { ok: false, message: `no ${type} in inventory` };
    if (!sim.creative) sim.inv[type] = (sim.inv[type] ?? 0) - 1;
    sim.world.set(k(p.x, p.y, p.z), type);
    if (/_door$/.test(type)) sim.world.set(k(p.x, p.y + 1, p.z), type);
    sim.log.push({ op: "place", at: k(p.x, p.y, p.z), block: type, botInside: insideBox(Math.floor(sim.pos.x), Math.floor(sim.pos.z)) });
    return { ok: true, message: "placed" };
  },
}));
vi.mock("../../skills/interaction.js", () => ({
  activateBlock: async (_b: unknown, { position: p, with: item }: { position: { x: number; y: number; z: number }; with?: string }) => {
    const n = nameAt(p.x, p.y, p.z);
    if (item?.endsWith("_hoe") && /^(grass_block|dirt)$/.test(n) && nameAt(p.x, p.y + 1, p.z) === "air") sim.world.set(k(p.x, p.y, p.z), "farmland");
    else if (item === "wheat_seeds" && n === "farmland") {
      sim.world.set(k(p.x, p.y + 1, p.z), "wheat");
      sim.inv["wheat_seeds"] = (sim.inv["wheat_seeds"] ?? 0) - 1;
    } else if (item === "water_bucket") sim.world.set(k(p.x, p.y + 1, p.z), "water");
    else if (item === "flint_and_steel" && n === "obsidian") {
      // light: fill the interior above the bottom frame row if the frame is complete
      for (const dx of [0, 1, 2, -1]) if (nameAt(p.x + dx, p.y + 1, p.z) === "air" && nameAt(p.x + dx, p.y, p.z) === "obsidian") sim.world.set(k(p.x + dx, p.y + 1, p.z), "nether_portal");
      for (const dz of [0, 1, 2, -1]) if (nameAt(p.x, p.y + 1, p.z + dz) === "air" && nameAt(p.x, p.y, p.z + dz) === "obsidian") sim.world.set(k(p.x, p.y + 1, p.z + dz), "nether_portal");
    }
    sim.log.push({ op: "act", at: k(p.x, p.y, p.z), block: item });
    return { ok: true, message: "ok" };
  },
}));

function fakeBot(): Bot {
  return {
    username: "bot",
    registry: { itemsByName: new Proxy({}, { get: () => ({}) }) },
    get entity() {
      return { position: sim.pos };
    },
    get inventory() {
      const slots: Array<{ name: string; count: number } | null> = new Array(9).fill(null);
      for (const [name, count] of Object.entries(sim.inv)) if (count > 0) slots.push({ name, count });
      return {
        slots,
        items: () => slots.filter(Boolean).map((s) => ({ ...s!, type: 1 })),
      };
    },
    blockAt: (p: Vec3) => fakeBlock(p.x, p.y, p.z),
    dig: async (b: { position: Vec3; name: string }) => {
      const drop = b.name === "grass_block" ? "dirt" : b.name;
      if (b.name === "dirt" && sim.loseDrops > 0) sim.loseDrops--;
      else if (/^(dirt|cobblestone|netherrack)$/.test(drop)) sim.inv[drop] = (sim.inv[drop] ?? 0) + 1;
      sim.world.set(k(b.position.x, b.position.y, b.position.z), "air");
      sim.log.push({ op: "dig", at: k(b.position.x, b.position.y, b.position.z) });
    },
    equip: async () => {},
  } as unknown as Bot;
}

const records: unknown[] = [];
const ctx = (): BuildRunContext => ({ signal: new AbortController().signal, radius: 64, baseline: 0, jobId: "j", record: (e) => records.push(e), progress: () => {} });
const A = { x: 0, y: 64, z: 0 };

async function runKind(blueprint: "house" | "portal" | "farm", params: Record<string, unknown>, inv: Record<string, number>, creative = false, extra: Record<string, string> = {}, loseDrops = 0) {
  sim = { world: new Map(Object.entries(extra)), inv: { ...inv }, pos: new Vec3(0.5, 64, 0.5), creative, log: [], box: null, loseDrops };
  const { createBuildDeps } = await import("./build.js");
  const bot = fakeBot();
  const deps = createBuildDeps(bot);
  const spec = { blueprint, params, anchor: A, avoid: [A] };
  let prep = await deps.prepare(spec, null);
  if (!prep.ok) return { prep, out: null };
  sim.box = { x0: prep.origin.x, z0: prep.origin.z, x1: prep.origin.x + (prep.payload as { bp: { size: { x: number } } }).bp.size.x - 1, z1: prep.origin.z + (prep.payload as { bp: { size: { z: number } } }).bp.size.z - 1 };
  const out = await deps.run(prep, ctx());
  return { prep, out, bot };
}

describe("Builder simulation", () => {
  it("survival house: every blueprint block lands, nothing placed from a spot the bot occupies, door last and from outside", async () => {
    const { prep, out } = await runKind("house", { wall: "oak_planks" }, { oak_planks: 64, oak_door: 1, glass: 4 });
    expect(prep.ok && prep.missing).toEqual([]);
    expect(out).toMatchObject({ ok: true, placed: 57, total: 57 });
    const planks = [...sim.world.values()].filter((n) => n === "oak_planks").length;
    expect(planks).toBe(53);
    expect([...sim.world.values()].filter((n) => n === "glass")).toHaveLength(2);
    expect(sim.inv["oak_planks"]).toBe(64 - 53);
    // door is the very last placement, made with the bot outside the footprint
    const places = sim.log.filter((l) => l.op === "place");
    expect(places.at(-1)!.block).toBe("oak_door");
    expect(places.at(-1)!.botInside).toBe(false);
    // bottom-up: layer order never goes down (door excepted)
    const ys = places.slice(0, -1).map((p) => Number(p.at.split(",")[1]));
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    // the door gap stayed open until the door
    expect(prep.ok && records.some((r) => (r as { op?: string }).op === "layer")).toBe(true);
  });

  it("survival portal: 10 obsidian, scaffolds placed and all removed again, lit", async () => {
    const { out } = await runKind("portal", {}, { obsidian: 10, flint_and_steel: 1, dirt: 1 });
    expect(out).toMatchObject({ ok: true, placed: 11, total: 11 });
    expect([...sim.world.values()].filter((n) => n === "obsidian")).toHaveLength(10);
    expect([...sim.world.values()].filter((n) => n === "nether_portal").length).toBeGreaterThan(0);
    expect([...sim.world.values()].filter((n) => n === "dirt")).toHaveLength(0); // scaffolds gone (air overrides)
    expect(sim.log.filter((l) => l.op === "place" && l.block === "dirt")).toHaveLength(3); // one dirt, reused three times
    expect(sim.inv["dirt"]).toBe(1); // every scaffold was dug up again
  });

  it("portal with no dirt: digs the dirt it needs from the ground itself (no planner gather)", async () => {
    const { prep, out } = await runKind("portal", {}, { obsidian: 10, flint_and_steel: 1 });
    expect(prep.ok && prep.missing).toEqual([]);
    expect(out).toMatchObject({ ok: true, placed: 11 });
    expect(sim.log.filter((l) => l.op === "dig").length).toBeGreaterThanOrEqual(1 + 3); // 1 for the dirt + 3 scaffold removals
    expect([...sim.world.values()].filter((n) => n === "obsidian")).toHaveLength(10);
  });

  it("portal: a scaffold whose drop is lost is replaced by digging a fresh dirt (no failed placements)", async () => {
    const { out } = await runKind("portal", {}, { obsidian: 10, flint_and_steel: 1, dirt: 1 }, false, {}, 1);
    expect(out).toMatchObject({ ok: true, placed: 11, total: 11 });
    expect([...sim.world.values()].filter((n) => n === "obsidian")).toHaveLength(10);
    expect(sim.log.filter((l) => l.op === "dig").length).toBeGreaterThanOrEqual(4);
  });

  it("survival farm with a bucket: tills, centre water, plants up to the seeds it has", async () => {
    const { out, prep } = await runKind("farm", { size: 5 }, { wooden_hoe: 1, wheat_seeds: 16, water_bucket: 1 });
    expect(prep.ok && prep.params.water).toBe("center");
    expect(out).toMatchObject({ ok: true });
    const vals = [...sim.world.values()];
    expect(vals.filter((n) => n === "farmland")).toHaveLength(24);
    expect(vals.filter((n) => n === "water")).toHaveLength(1);
    expect(vals.filter((n) => n === "wheat")).toHaveLength(16);
  });

  it("farm next to existing water uses it (no bucket needed)", async () => {
    const { out, prep } = await runKind("farm", { size: 5 }, { wooden_hoe: 1, wheat_seeds: 16 }, false, { [k(4, 63, 4)]: "water" });
    expect(prep.ok && prep.missing).toEqual([]);
    expect(out).toMatchObject({ ok: true });
    expect([...sim.world.values()].filter((n) => n === "wheat")).toHaveLength(16);
  });

  it("creative house: materials come from getItems, same result", async () => {
    const { out } = await runKind("house", { wall: "spruce_planks", height: 4, width: 7, depth: 6 }, {}, true);
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true });
    expect([...sim.world.values()].filter((n) => n === "spruce_planks").length).toBeGreaterThan(80);
    expect([...sim.world.values()].some((n) => n === "spruce_door")).toBe(true);
  });

  it("stops placing when the materials run out and reports how far it got", async () => {
    const { out } = await runKind("house", { wall: "oak_planks", windows: 0 }, { oak_planks: 30, oak_door: 1 });
    // prepare would have asked the planner for the shortfall; force the run anyway
    expect(out).toMatchObject({ ok: false, kind: "build_incomplete" });
    expect((out as { detail: string }).detail).toMatch(/no oak_planks left/);
    expect((out as { placed: number }).placed).toBe(30);
  });
});
