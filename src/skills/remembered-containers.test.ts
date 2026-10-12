/**
 * Containers the bot has seen (not opened): captured into world.json by the proximity scan, listed in the
 * context block beyond the live scan, and used by the deposit/withdraw resolution as a ~64-block fallback.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { rememberedContainersLine } from "../agent/planning-context.js";
import { readWorldKnowledge, syncSeenContainers, upsertContainer } from "../memory/world-knowledge.js";

vi.mock("../mineflayer-glue/event-hooks.js", () => ({ noteContainerOpening: () => {} }));
vi.mock("./navigation.js", () => ({ navigate: async () => ({ ok: true, message: "" }) }));

const { rememberSeenContainers } = await import("./containers.js");
const { resolveChestBlock } = await import("./storage.js");

let cwd: string;
let dir: string;
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "mc-world-"));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const world = new Map<string, string>();
const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;

function fakeBot(at: Vec3): Bot {
  return {
    username: "Tbot",
    entity: { position: at },
    registry: { blocksByName: { chest: { id: 1, name: "chest" }, barrel: { id: 2, name: "barrel" } } },
    findBlocks: ({ point, maxDistance }: { point: Vec3; maxDistance: number }) =>
      [...world.entries()]
        .filter(([, n]) => n === "chest" || n === "barrel")
        .map(([k]) => new Vec3(...(k.split(",").map(Number) as [number, number, number])))
        .filter((p) => p.distanceTo(point) <= maxDistance),
    blockAt: (p: Vec3) => (world.has(key(p)) ? { name: world.get(key(p))!, position: p, boundingBox: "block" } : null),
  } as unknown as Bot;
}

describe("seen containers", () => {
  it("the scan records chests in sight (no contents), skips the second half of a double chest, and never overwrites an opened one", async () => {
    world.clear();
    world.set("10,64,0", "chest");
    world.set("11,64,0", "chest");
    world.set("0,64,12", "barrel");
    const bot = fakeBot(new Vec3(0, 64, 0));
    await upsertContainer("Tbot", { type: "barrel", position: { x: 0, y: 64, z: 12 }, contents: [{ item: "dirt", count: 3 }], openedBy: "Tbot" });
    expect(await rememberSeenContainers(bot)).toBe(1);
    const w = await readWorldKnowledge("Tbot");
    expect(w.containers).toHaveLength(2);
    const chest = w.containers.find((c) => c.type === "chest")!;
    expect(chest).toMatchObject({ seen: true, position: { x: 10, y: 64, z: 0 } });
    expect(chest.contents).toBeUndefined();
    expect(w.containers.find((c) => c.type === "barrel")).toMatchObject({ contents: [{ item: "dirt", count: 3 }] });
    expect(w.containers.find((c) => c.type === "barrel")!.seen).toBeUndefined();
    // the other half, seen from the other side, is not a new entry
    expect(await syncSeenContainers("Tbot", [{ type: "chest", position: { x: 11, y: 64, z: 0 } }])).toBe(0);
    // opening it later replaces the seen entry with a real record
    await upsertContainer("Tbot", { type: "chest", position: { x: 10, y: 64, z: 0 }, contents: [], openedBy: "Tbot" });
    expect((await readWorldKnowledge("Tbot")).containers.find((c) => c.type === "chest")!.seen).toBeUndefined();
  });

  it("a seen entry whose block is loaded in range and no longer a container is dropped", async () => {
    world.clear();
    world.set("5,64,0", "chest");
    const bot = fakeBot(new Vec3(0, 64, 0));
    await rememberSeenContainers(bot);
    expect((await readWorldKnowledge("Tbot")).containers).toHaveLength(1);
    world.set("5,64,0", "air");
    await rememberSeenContainers(bot);
    expect((await readWorldKnowledge("Tbot")).containers).toHaveLength(0);
    // out of range / unloaded: kept
    world.set("5,64,0", "chest");
    await rememberSeenContainers(bot);
    world.delete("5,64,0");
    await rememberSeenContainers(bot);
    expect((await readWorldKnowledge("Tbot")).containers).toHaveLength(1);
  });

  it("the context line lists at most 3 seen containers beyond 16 m, nearest first, with distances", () => {
    const mk = (x: number, dist: number, seen = true) => ({ type: "chest", pos: { x, y: 64, z: 0 }, dist, ...(seen ? { seen: true } : {}) });
    const line = rememberedContainersLine([mk(70, 70), mk(30, 30), mk(10, 10), mk(40, 40), mk(50, 50), mk(20, 20, false)]);
    expect(line).toContain("(30m)");
    expect(line).toContain("(40m)");
    expect(line).toContain("(50m)");
    expect(line).not.toContain("(70m)");
    expect(line).not.toContain("(10m)");
    expect(line).not.toContain("(20m)");
    expect(rememberedContainersLine([mk(10, 10)])).toBeNull();
  });

  it("deposit / withdraw fall back to the nearest seen container within 64 blocks, none beyond", async () => {
    world.clear();
    world.set("40,64,0", "chest");
    world.set("90,64,0", "chest");
    const bot = fakeBot(new Vec3(0, 64, 0));
    await syncSeenContainers("Tbot", [
      { type: "chest", position: { x: 40, y: 64, z: 0 } },
      { type: "chest", position: { x: 90, y: 64, z: 0 } },
    ]);
    const dep = await resolveChestBlock(bot, undefined, "deposit");
    expect(dep).toMatchObject({ ok: true, source: "nearest known" });
    expect(dep.ok && dep.block.position.x).toBe(40);
    const wd = await resolveChestBlock(bot, undefined, "withdraw", "oak_log");
    expect(wd).toMatchObject({ ok: true, source: "remembered, contents unknown" });
    // only the far one remains: out of the fallback range
    const far = fakeBot(new Vec3(-30, 64, 0));
    await syncSeenContainers("Tbot", [], (c) => c.position.x === 40);
    world.delete("40,64,0");
    const none = await resolveChestBlock(far, undefined, "deposit");
    expect(none.ok).toBe(false);
    expect(!none.ok && none.message).toContain("none remembered within 64");
  });
});
