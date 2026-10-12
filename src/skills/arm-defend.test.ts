import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { armTick, defendBlocked, isDarkHours } from "./auto-behaviors.js";
import { createBotState } from "../state/index.js";
import { fightNearbyHostiles, nearestHostileWithin } from "./melee-guard.js";

function fakeBot(o: { time: number; mobAt?: number; held?: string; creative?: boolean }) {
  const equip = vi.fn(async () => {});
  const sword = { name: "stone_sword", type: 7, count: 1 };
  const bot = {
    username: "armbot",
    health: 20,
    isSleeping: false,
    currentWindow: null,
    usingHeldItem: false,
    game: { gameMode: o.creative ? "creative" : "survival" },
    time: { timeOfDay: o.time },
    heldItem: o.held ? { name: o.held, type: o.held === "stone_sword" ? 7 : 9 } : null,
    entity: { position: new Vec3(0, 64, 0), height: 1.8 },
    entities: o.mobAt === undefined ? {} : { 5: { id: 5, type: "hostile", kind: "Hostile mobs", name: "zombie", position: new Vec3(o.mobAt, 64, 0) } },
    inventory: { items: () => [sword, { name: "bread", type: 3, count: 5 }] },
    equip,
  };
  return { bot: bot as unknown as Bot, equip };
}

describe("isDarkHours", () => {
  it("dusk to dawn", () => {
    expect(isDarkHours(13_000)).toBe(true);
    expect(isDarkHours(6_000)).toBe(false);
    expect(isDarkHours(23_600)).toBe(false);
    expect(isDarkHours(undefined)).toBe(false);
  });
});

describe("weapon-ready reflex", () => {
  it("equips the sword when a hostile is within 6 blocks at night and the bot is idle", async () => {
    const { bot, equip } = fakeBot({ time: 14_000, mobAt: 5, held: "bread" });
    armTick(bot, createBotState());
    await new Promise((r) => setTimeout(r, 10));
    expect(equip).toHaveBeenCalledTimes(1);
  });
  it("not by day, not when the mob is far, not when already armed, not mid-skill", async () => {
    const st = createBotState();
    for (const o of [
      { time: 6_000, mobAt: 5, held: "bread" },
      { time: 14_000, mobAt: 12, held: "bread" },
      { time: 14_000, mobAt: 5, held: "stone_sword" },
      { time: 14_000, mobAt: 5, held: "bread", creative: true },
    ]) {
      const { bot, equip } = fakeBot(o);
      armTick(bot, st);
      await new Promise((r) => setTimeout(r, 5));
      expect(equip).not.toHaveBeenCalled();
    }
    const { bot, equip } = fakeBot({ time: 14_000, mobAt: 5, held: "bread" });
    const busy = createBotState();
    busy.currentTool.begin("mineBlocks");
    armTick(bot, busy);
    await new Promise((r) => setTimeout(r, 5));
    expect(equip).not.toHaveBeenCalled();
  });
});

describe("defensive swing while a job skill runs", () => {
  it("is blocked only for skills that handle threats / eating / sleeping themselves", () => {
    const { bot } = fakeBot({ time: 14_000 });
    const st = createBotState();
    expect(defendBlocked(bot, st)).toBe(false);
    for (const [tool, blocked] of [["mineBlocks", false], ["build", true], ["goTo", false], ["explore", false], ["attack", true], ["eat", true], ["sleepIn", true]] as const) {
      const s = createBotState();
      s.currentTool.begin(tool);
      expect(defendBlocked(bot, s)).toBe(blocked);
    }
  });
});

describe("melee guard (Builder)", () => {
  it("swings at a hostile within reach, with the weapon, and not at one that is far", async () => {
    const near = fakeBot({ time: 14_000, mobAt: 2, held: "bread" });
    const attack = vi.fn();
    const b = near.bot as unknown as { attack: typeof attack; lookAt: () => Promise<void> };
    b.attack = attack;
    b.lookAt = async () => {};
    let n = 0;
    // the mob "dies" after two swings
    const ents = (near.bot as unknown as { entities: Record<number, unknown> }).entities;
    attack.mockImplementation(() => {
      if (++n >= 2) delete ents[5];
    });
    const swings = await fightNearbyHostiles(near.bot, () => false, 3000);
    expect(swings).toBe(2);
    expect(near.equip).toHaveBeenCalled();
    const far = fakeBot({ time: 14_000, mobAt: 10 });
    expect(nearestHostileWithin(far.bot, 3.4)).toBeNull();
    expect(await fightNearbyHostiles(far.bot, () => false)).toBe(0);
  });
});
