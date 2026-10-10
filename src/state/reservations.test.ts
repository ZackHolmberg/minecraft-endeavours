import { describe, expect, it } from "vitest";
import { planReservations } from "../jobs/reserve.js";
import { plan } from "../planner/plan.js";
import { clearReserved, reservedCount, setReserved, spendable } from "./reservations.js";

describe("reservations", () => {
  it("set / count / spendable / clear are per bot", () => {
    setReserved("a", { cobblestone: 3, dirt: Infinity });
    expect(reservedCount("a", "cobblestone")).toBe(3);
    expect(spendable("a", "cobblestone", 5)).toBe(2);
    expect(spendable("a", "cobblestone", 2)).toBe(0);
    expect(spendable("a", "dirt", 100)).toBe(0);
    expect(spendable("b", "cobblestone", 5)).toBe(5);
    clearReserved("a");
    expect(spendable("a", "cobblestone", 5)).toBe(5);
  });

  it("planReservations covers outputs, craft ingredients (all variants) and goals", () => {
    const p = plan([{ item: "stone_pickaxe", count: 1 }], {
      inventory: { stick: 2, wooden_pickaxe: 1 },
      gameMode: "survival",
      nearbyBlocks: { stone: { count: 9, nearest: 5 } },
      stations: { crafting_table: true, furnace: false },
      containers: [],
      position: { x: 0, y: 64, z: 0 },
      dimension: "overworld",
    });
    const r = planReservations(p);
    expect(r.cobblestone).toBe(Infinity); // gather output + stone_pickaxe ingredient
    expect(r.stick).toBe(Infinity); // owned ingredient no step produces
    expect(r.stone_pickaxe).toBe(Infinity);
    expect(r.dirt).toBeUndefined(); // free to use as filler
  });
});
