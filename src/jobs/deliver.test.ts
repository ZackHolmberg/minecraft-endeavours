import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import { creativeGive, getItems, isOperatorItem } from "../skills/creative.js";
import { deliverCap, DELIVER_MAX_STACKS, DELIVER_MAX_UNSTACKABLE } from "./tools.js";
import { judgeHandover, PICKUP_WAIT_MS, type TrackedDrop } from "./steps/deliver.js";

// ── M5: caps and the creative denylist ───────────────────────────────────────

describe("deliverCap (M5)", () => {
  it("2 stacks of a stackable, 4 of an unstackable", () => {
    expect(deliverCap(64)).toBe(128);
    expect(deliverCap(16)).toBe(32);
    expect(deliverCap(1)).toBe(DELIVER_MAX_UNSTACKABLE);
    expect(DELIVER_MAX_STACKS).toBe(2);
  });
});

describe("isOperatorItem / creative refusal (M5)", () => {
  it("covers the operator and technical items", () => {
    for (const n of [
      "command_block", "chain_command_block", "repeating_command_block", "command_block_minecart",
      "structure_block", "structure_void", "jigsaw", "barrier", "light", "bedrock", "debug_stick",
      "zombie_spawn_egg", "creeper_spawn_egg", "knowledge_book", "end_portal_frame", "spawner", "trial_spawner", "reinforced_deepslate",
    ]) expect(isOperatorItem(n), n).toBe(true);
  });
  it("refuses griefing tools (tnt, lava, end crystals)", () => {
    for (const n of ["tnt", "tnt_minecart", "lava_bucket", "end_crystal"]) expect(isOperatorItem(n), n).toBe(true);
  });
  it("leaves normal items alone", () => {
    for (const n of ["cobblestone", "torch", "oak_planks", "diamond_pickaxe", "flint_and_steel", "light_gray_wool", "lightning_rod"]) expect(isOperatorItem(n), n).toBe(false);
  });

  const creativeBot = (): Bot =>
    ({
      game: { gameMode: "creative" },
      registry: {
        items: { 1: { name: "command_block", stackSize: 64 }, 2: { name: "torch", stackSize: 64 } },
        itemsByName: { command_block: { id: 1, name: "command_block" }, torch: { id: 2, name: "torch" } },
        itemsArray: [{ id: 1, name: "command_block" }, { id: 2, name: "torch" }],
      },
      inventory: { count: () => 0, slots: [] },
    }) as unknown as Bot;

  it("creativeGive throws for an operator item before touching any slot", async () => {
    await expect(creativeGive(creativeBot(), 1, 1)).rejects.toThrow(/operator/);
  });
  it("getItems refuses a request containing one, and writes nothing", async () => {
    const bot = creativeBot();
    const r = await getItems(bot, { items: [{ name: "command_block", count: 1 }] });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/operator/);
  });
});

// ── M6: hand-over verdict ────────────────────────────────────────────────────

const drop = (id: string, status: TrackedDrop["status"], count: number | null = 3): TrackedDrop => ({ id, item: "bread", count, status });
const GOALS = [{ item: "bread", count: 3 }];
const ev = (over: Partial<{ seenInHand: boolean; gone: Record<string, number> }> = {}) => ({ seenInHand: false, gone: { bread: 3 }, ...over });

describe("judgeHandover (M6)", () => {
  it("player collected it: success, says so", () => {
    const r = judgeHandover("Alex", GOALS, [drop("1", "player")], ev());
    expect(r).toMatchObject({ ok: true });
    expect((r as { detail: string }).detail).toMatch(/Alex picked it up/);
  });
  it("entity vanished without a collect event: success but flagged as not confirmed", () => {
    const r = judgeHandover("Alex", GOALS, [drop("1", "gone")], ev());
    expect(r).toMatchObject({ ok: true });
    expect((r as { detail: string }).detail).toMatch(/not directly confirmed/);
  });
  it("vanished + seen in the player's hand counts as confirmed", () => {
    const r = judgeHandover("Alex", GOALS, [drop("1", "gone")], ev({ seenInHand: true }));
    expect((r as { detail: string }).detail).toMatch(/seen in their hand/);
  });
  it("still on the ground after the wait: unreachable, reports how much", () => {
    const r = judgeHandover("Alex", GOALS, [drop("1", "ground", 3)], ev());
    expect(r).toMatchObject({ ok: false, failure: { kind: "unreachable" } });
    expect((r as { failure: { detail: string } }).failure.detail).toMatch(/3 item\(s\) are still on the ground after 10s/);
    expect(PICKUP_WAIT_MS).toBe(10_000);
  });
  it("the bot collected its own toss again: failure naming that, even though only the bot's inventory delta is short", () => {
    const r = judgeHandover("Alex", GOALS, [drop("1", "bot")], ev({ gone: { bread: 0 } }));
    expect(r).toMatchObject({ ok: false });
    expect((r as { failure: { detail: string } }).failure.detail).toMatch(/came back to me/);
  });
  it("a partial hand-over reports both parts", () => {
    const r = judgeHandover("Alex", [{ item: "bread", count: 5 }], [drop("1", "player", 3), drop("2", "ground", 2)], ev({ gone: { bread: 5 } }));
    expect((r as { failure: { detail: string } }).failure.detail).toMatch(/2 item\(s\) are still on the ground.*Alex took 3 item\(s\)/);
  });
  it("no entity ever seen: success is explicitly unconfirmed; inventory not short is an internal failure", () => {
    expect((judgeHandover("Alex", GOALS, [], ev()) as { detail: string }).detail).toMatch(/unconfirmed/);
    expect(judgeHandover("Alex", GOALS, [], ev({ gone: { bread: 1 } }))).toMatchObject({ ok: false, failure: { kind: "internal" } });
  });
  it("unknown stack sizes are described by entity count, not 0", () => {
    const r = judgeHandover("Alex", GOALS, [drop("1", "ground", null)], ev());
    expect((r as { failure: { detail: string } }).failure.detail).toMatch(/1 dropped stack\(s\)/);
  });
});

// ── M6: createDeliver tracks only ITS toss, via entity events ────────────────

vi.mock("./steps/util.js", () => ({
  itemCount: (bot: { inv: Record<string, number> }, item: string) => bot.inv[item] ?? 0,
  tracked: (_bot: unknown, _name: string, params: unknown, fn: (p: unknown) => Promise<unknown>) => fn(params),
}));
const giveMock = vi.fn();
vi.mock("../skills/inventory.js", () => ({ giveItemsTo: (...a: unknown[]) => giveMock(...a) }));

describe("createDeliver with entity events (M6)", () => {
  class FakeBot extends EventEmitter {
    username = "Steve";
    inv: Record<string, number> = { bread: 6 };
    players: Record<string, { entity: object | null }> = { Alex: { entity: {} } };
    entities: Record<string, { id: number; name: string; position: { distanceTo(): number }; getDroppedItem(): { name: string; count: number } | null }> = {};
    entity = { id: 1, position: {} };
    game = { gameMode: "survival" };
  }
  const item = (id: number, name: string | null, count = 3) => ({ id, name: "item", position: { distanceTo: () => 2 }, getDroppedItem: () => (name ? { name, count } : null) });
  const ctx = { signal: { aborted: false } as AbortSignal, radius: 64, baseline: 0, jobId: "j" };

  it("ignores the bot's own leftovers lying nearby (the old false failure) and confirms by playerCollect", async () => {
    const { createDeliver } = await import("./steps/deliver.js");
    const bot = new FakeBot();
    bot.entities["99"] = item(99, "bread", 4); // leftover from gathering, never picked up
    giveMock.mockImplementationOnce(async () => {
      bot.inv["bread"] = 3;
      bot.entities["100"] = item(100, "bread", 3);
      bot.emit("entitySpawn", bot.entities["100"]);
      setTimeout(() => {
        bot.emit("playerCollect", { username: "Alex", id: 7 }, { id: 100 });
        delete bot.entities["100"];
      }, 200);
      return { ok: true, message: "gave" };
    });
    const res = await createDeliver(bot as unknown as Bot)("Alex", [{ item: "bread", count: 3 }], ctx);
    expect(res).toMatchObject({ ok: true });
    expect((res as { detail: string }).detail).toMatch(/Alex picked it up/);
    expect(bot.listenerCount("entitySpawn")).toBe(0); // listeners removed
  });

  it("an item whose stack metadata hasn't arrived yet still counts as present (no false success)", async () => {
    const { createDeliver } = await import("./steps/deliver.js");
    vi.useFakeTimers();
    try {
      const bot = new FakeBot();
      giveMock.mockImplementationOnce(async () => {
        bot.inv["bread"] = 3;
        bot.entities["100"] = item(100, null);
        bot.emit("entitySpawn", bot.entities["100"]);
        return { ok: true, message: "gave" };
      });
      const p = createDeliver(bot as unknown as Bot)("Alex", [{ item: "bread", count: 3 }], ctx);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await p).toMatchObject({ ok: false, failure: { kind: "unreachable" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports that the bot picked its own toss back up", async () => {
    const { createDeliver } = await import("./steps/deliver.js");
    const bot = new FakeBot();
    giveMock.mockImplementationOnce(async () => {
      bot.inv["bread"] = 3;
      bot.entities["100"] = item(100, "bread");
      bot.emit("entitySpawn", bot.entities["100"]);
      setTimeout(() => {
        bot.inv["bread"] = 6;
        bot.emit("playerCollect", { username: "Steve", id: 1 }, { id: 100 });
        delete bot.entities["100"];
      }, 100);
      return { ok: true, message: "gave" };
    });
    const res = await createDeliver(bot as unknown as Bot)("Alex", [{ item: "bread", count: 3 }], ctx);
    expect(res).toMatchObject({ ok: false });
    expect((res as { failure: { detail: string } }).failure.detail).toMatch(/came back to me/);
  });
});
