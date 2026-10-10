import { afterEach, describe, expect, it } from "vitest";
import type { Bot } from "mineflayer";
import { pickFiller } from "./pillar.js";
import { clearReserved, setReserved } from "../state/reservations.js";

const bot = (items: Record<string, number>): Bot =>
  ({ username: "fillbot", inventory: { items: () => Object.entries(items).map(([name, count]) => ({ name, count, type: 1 })) } }) as unknown as Bot;

afterEach(() => clearReserved("fillbot"));

describe("pickFiller", () => {
  it("prefers dirt and other junk over cobblestone", () => {
    expect(pickFiller(bot({ cobblestone: 9, dirt: 3 }))?.name).toBe("dirt");
    expect(pickFiller(bot({ cobblestone: 9, andesite: 1, granite: 2 }))?.name).toBe("andesite");
    expect(pickFiller(bot({ cobblestone: 9, stone: 4 }))?.name).toBe("cobblestone");
    expect(pickFiller(bot({ oak_planks: 4 }))).toBeNull();
  });

  it("never uses reserved items (job needs 3 cobblestone, holds 3: not usable)", () => {
    setReserved("fillbot", { cobblestone: Infinity });
    expect(pickFiller(bot({ cobblestone: 3 }))).toBeNull();
    expect(pickFiller(bot({ cobblestone: 3, dirt: 10 }))?.name).toBe("dirt");
  });

  it("count-based reservations leave the surplus usable", () => {
    setReserved("fillbot", { cobblestone: 3 });
    expect(pickFiller(bot({ cobblestone: 3 }))).toBeNull();
    expect(pickFiller(bot({ cobblestone: 5 }))?.name).toBe("cobblestone");
  });
});
