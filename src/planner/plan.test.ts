import { describe, expect, it } from "vitest";
import { plan } from "./plan.js";
import { getRecipeBook } from "./recipes.js";
import { burnUnits } from "./knowledge/index.js";
import type { Goal, Plan, Step, WorldView } from "./types.js";

const FOREST = { oak_log: { count: 20, nearest: 5 } };
const FOREST_STONE = { ...FOREST, stone: { count: 50, nearest: 8 } };

function mkView(o: Partial<WorldView> & { near?: Record<string, number> } = {}): WorldView {
  const { near, ...rest } = o;
  const nearbyBlocks = near
    ? Object.fromEntries(Object.entries(near).map(([k, d]) => [k, { count: 10, nearest: d }]))
    : { ...FOREST_STONE };
  return {
    inventory: {},
    gameMode: "survival",
    nearbyBlocks,
    stations: { crafting_table: false, furnace: false },
    containers: [],
    position: { x: 0, y: 64, z: 0 },
    dimension: "overworld",
    ...rest,
  };
}
const g = (item: string, count = 1): Goal => ({ item, count });
const ops = (p: Plan) => p.steps.map((s) => (s.op === "place_station" ? `place:${s.block}` : `${s.op}:${"item" in s ? s.item : s.output}`));
const find = <T extends Step["op"]>(p: Plan, op: T, item?: string) =>
  p.steps.filter((s): s is Extract<Step, { op: T }> => s.op === op && (item === undefined || ("item" in s && s.item === item) || ("output" in s && s.output === item)));

/** Execute a plan against the recipe book; fail on any under-supply. Returns final inventory. */
function simulate(p: Plan, view: WorldView): Record<string, number> {
  const book = getRecipeBook();
  const inv: Record<string, number> = { ...view.inventory };
  const chest = new Map(view.containers.map((c) => [c.pos, { ...c.items }]));
  let table = view.stations.crafting_table;
  let furnace = view.stations.furnace;
  const take = (k: string, n: number) => {
    if ((inv[k] ?? 0) < n) throw new Error(`under-supplied ${k}: need ${n}, have ${inv[k] ?? 0}`);
    inv[k] = (inv[k] ?? 0) - n;
  };
  for (const s of p.steps) {
    switch (s.op) {
      case "withdraw": {
        const c = chest.get(s.from)!;
        if ((c[s.item] ?? 0) < s.count) throw new Error(`chest lacks ${s.item}`);
        c[s.item] = (c[s.item] ?? 0) - s.count;
        inv[s.item] = (inv[s.item] ?? 0) + s.count;
        break;
      }
      case "gather":
        inv[s.item] = (inv[s.item] ?? 0) + s.count;
        break;
      case "place_station":
        take(s.block, 1);
        if (s.block === "crafting_table") table = true;
        else furnace = true;
        break;
      case "craft": {
        if (s.table && !table) throw new Error(`craft ${s.item} without table`);
        const variants = book.recipes(s.item).filter((r) => r.table === s.table);
        const r = variants.find((v) => Object.entries(v.ingredients).every(([k, n]) => (inv[k] ?? 0) >= n * s.crafts));
        if (!r) throw new Error(`cannot craft ${s.crafts}x ${s.item} from ${JSON.stringify(inv)}`);
        for (const [k, n] of Object.entries(r.ingredients)) take(k, n * s.crafts);
        inv[s.item] = (inv[s.item] ?? 0) + r.yield * s.crafts;
        expect(r.yield * s.crafts).toBe(s.count);
        break;
      }
      case "smelt":
        if (!furnace) throw new Error("smelt without furnace");
        take(s.input, s.count);
        expect(s.fuelCount * burnUnits(s.fuel)).toBeGreaterThanOrEqual(s.count);
        take(s.fuel, s.fuelCount);
        inv[s.output] = (inv[s.output] ?? 0) + s.count;
        break;
    }
  }
  return inv;
}
function expectReaches(goals: Goal[], view: WorldView) {
  const p = plan(goals, view);
  expect(p.unresolved).toEqual([]);
  const inv = simulate(p, view);
  for (const goal of goals) expect(inv[goal.item] ?? 0).toBeGreaterThanOrEqual(goal.count);
  expect(p.summary.length).toBeLessThanOrEqual(200);
  return p;
}

describe("wood tier", () => {
  it("wooden_pickaxe from nothing, forest nearby: exact counts and order", () => {
    const v = mkView();
    const p = expectReaches([g("wooden_pickaxe")], v);
    expect(ops(p)).toEqual([
      "gather:oak_log",
      "craft:oak_planks",
      "craft:stick",
      "craft:crafting_table",
      "place:crafting_table",
      "craft:wooden_pickaxe",
    ]);
    // 4 (table) + 3 (pickaxe) + 2 (sticks) = 9 planks -> 3 crafts -> 12 planks -> 3 logs
    expect(find(p, "gather", "oak_log")[0]).toMatchObject({ count: 3, blocks: ["oak_log"], tool: null });
    expect(find(p, "gather", "oak_log")[0]!.searchHint).toBeUndefined();
    expect(find(p, "craft", "oak_planks")[0]).toMatchObject({ count: 12, crafts: 3, table: false });
    expect(find(p, "craft", "stick")[0]).toMatchObject({ count: 4, crafts: 1 });
    expect(find(p, "craft", "wooden_pickaxe")[0]).toMatchObject({ table: true });
    expect(p.rawNeeds).toEqual({ oak_log: 3 });
  });

  it("no forest in view: gather carries a surface searchHint", () => {
    const p = plan([g("oak_planks", 4)], mkView({ near: {} }));
    expect(find(p, "gather", "oak_log")[0]!.searchHint).toEqual({ kind: "surface" });
  });

  it("uses the species held in inventory (jungle, not oak) even with oak in view", () => {
    const v = mkView({ inventory: { jungle_log: 3 } });
    const p = expectReaches([g("wooden_pickaxe")], v);
    expect(find(p, "craft", "jungle_planks")).toHaveLength(1);
    expect(find(p, "craft", "oak_planks")).toHaveLength(0);
    expect(find(p, "gather")).toHaveLength(0);
    expect(JSON.stringify(p.steps)).not.toContain("oak");
  });

  it("falls back to the species nearest in view", () => {
    const v = mkView({ near: { birch_log: 4, spruce_log: 20 } });
    const p = expectReaches([g("stick", 4)], v);
    expect(find(p, "gather")[0]).toMatchObject({ item: "birch_log" });
  });

  it("already-placed table nearby: no table craft or placement", () => {
    const v = mkView({ stations: { crafting_table: true, furnace: false } });
    const p = expectReaches([g("wooden_pickaxe")], v);
    expect(ops(p)).toEqual(["gather:oak_log", "craft:oak_planks", "craft:stick", "craft:wooden_pickaxe"]);
    expect(find(p, "gather", "oak_log")[0]!.count).toBe(2); // 3 planks + 2 for sticks = 5 -> 2 crafts
  });

  it("table in inventory is placed, not crafted", () => {
    const v = mkView({ inventory: { crafting_table: 1 } });
    const p = expectReaches([g("wooden_pickaxe")], v);
    expect(find(p, "craft", "crafting_table")).toHaveLength(0);
    expect(find(p, "place_station")).toHaveLength(1);
  });
});

describe("stone and iron tiers", () => {
  it("stone_pickaxe: wooden pickaxe first, then cobblestone, one table", () => {
    const v = mkView();
    const p = expectReaches([g("stone_pickaxe")], v);
    const o = ops(p);
    expect(o.indexOf("craft:wooden_pickaxe")).toBeLessThan(o.indexOf("gather:cobblestone"));
    expect(o.indexOf("gather:cobblestone")).toBeLessThan(o.indexOf("craft:stone_pickaxe"));
    expect(find(p, "craft", "crafting_table")).toHaveLength(1);
    expect(find(p, "place_station")).toHaveLength(1);
    expect(find(p, "gather", "cobblestone")[0]).toMatchObject({ count: 3, tool: "wooden_pickaxe" });
    expect(find(p, "gather", "cobblestone")[0]!.blocks).toContain("stone");
  });

  it("stone_pickaxe with a wooden pickaxe already held: no wooden craft", () => {
    const v = mkView({ inventory: { wooden_pickaxe: 1 } });
    const p = expectReaches([g("stone_pickaxe")], v);
    expect(find(p, "craft", "wooden_pickaxe")).toHaveLength(0);
  });

  it("iron_pickaxe with coal_ore in view: coal fuel, furnace from 8 cobblestone, underground iron hint", () => {
    const v = mkView({ near: { oak_log: 5, stone: 8, coal_ore: 15 } });
    const p = expectReaches([g("iron_pickaxe")], v);
    expect(find(p, "gather", "cobblestone")[0]!.count).toBe(11); // 3 stone pickaxe + 8 furnace
    const iron = find(p, "gather", "raw_iron")[0]!;
    expect(iron).toMatchObject({ count: 3, tool: "stone_pickaxe" });
    expect(iron.blocks).toEqual(["iron_ore", "deepslate_iron_ore"]);
    expect(iron.searchHint?.kind).toBe("underground");
    expect(iron.searchHint?.yRange).toEqual([-16, 48]);
    expect(find(p, "smelt")[0]).toMatchObject({ input: "raw_iron", output: "iron_ingot", count: 3, fuel: "coal", fuelCount: 1 });
    expect(find(p, "gather", "coal")[0]).toMatchObject({ count: 1 });
    const o = ops(p);
    expect(o.indexOf("place:furnace")).toBeLessThan(o.indexOf("smelt:iron_ingot"));
    expect(o.indexOf("gather:raw_iron")).toBeLessThan(o.indexOf("smelt:iron_ingot"));
    expect(o[o.length - 1]).toBe("craft:iron_pickaxe");
    expect(find(p, "craft", "crafting_table")).toHaveLength(1);
  });

  it("iron_pickaxe without coal in view: wood fuel (logs), counted in the log gather", () => {
    const v = mkView();
    const p = expectReaches([g("iron_pickaxe")], v);
    const sm = find(p, "smelt")[0]!;
    expect(sm.fuel).toBe("oak_log");
    expect(sm.fuelCount).toBe(2); // 3 smelts / 1.5
    expect(find(p, "gather", "coal")).toHaveLength(0);
    // 3 logs for planks (table 4 + 3+3+3 pickaxes... sticks) + 2 fuel
    expect(find(p, "gather", "oak_log")[0]!.count).toBe(5);
  });

  it("iron_pickaxe with owned coal uses it", () => {
    const v = mkView({ inventory: { coal: 2 } });
    const p = expectReaches([g("iron_pickaxe")], v);
    expect(find(p, "smelt")[0]).toMatchObject({ fuel: "coal", fuelCount: 1 });
    expect(find(p, "gather", "coal")).toHaveLength(0);
  });

  it("furnace/table already nearby: neither crafted nor placed", () => {
    const v = mkView({ stations: { crafting_table: true, furnace: true }, inventory: { stone_pickaxe: 1, oak_planks: 5, coal: 1 } });
    const p = expectReaches([g("iron_pickaxe")], v);
    expect(find(p, "place_station")).toHaveLength(0);
    expect(find(p, "craft", "furnace")).toHaveLength(0);
    expect(ops(p)).toEqual(["gather:raw_iron", "smelt:iron_ingot", "craft:stick", "craft:iron_pickaxe"]);
  });

  it("full iron kit: shared resources counted once", () => {
    const v = mkView({ near: { oak_log: 5, stone: 8, coal_ore: 15 } });
    const goals = ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots", "iron_sword", "iron_pickaxe"].map((i) => g(i));
    const p = expectReaches(goals, v);
    // 5+8+7+4 armor + 2 sword + 3 pickaxe = 29 ingots
    expect(find(p, "gather", "raw_iron")[0]!.count).toBe(29);
    expect(find(p, "smelt")).toHaveLength(1);
    expect(find(p, "smelt")[0]).toMatchObject({ count: 29, fuel: "coal", fuelCount: 4 });
    expect(find(p, "craft", "crafting_table")).toHaveLength(1);
    expect(find(p, "craft", "furnace")).toHaveLength(1);
    expect(find(p, "place_station")).toHaveLength(2);
    expect(find(p, "gather", "cobblestone")).toHaveLength(1);
    expect(find(p, "craft", "wooden_pickaxe")).toHaveLength(1);
    expect(find(p, "craft", "stone_pickaxe")).toHaveLength(1);
    // sticks: wooden 2 + stone 2 + sword 1 + iron pickaxe 2 = 7 -> 2 crafts
    expect(find(p, "craft", "stick")[0]).toMatchObject({ crafts: 2, count: 8 });
    for (const piece of ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots", "iron_sword", "iron_pickaxe"])
      expect(find(p, "craft", piece)).toHaveLength(1);
    expect(p.steps.length).toBeLessThan(25);
  });

  it("diamond_pickaxe: diamond_ore needs an iron pickaxe, built first", () => {
    const v = mkView({ near: { oak_log: 5, stone: 8, coal_ore: 15 } });
    const p = expectReaches([g("diamond_pickaxe")], v);
    const d = find(p, "gather", "diamond")[0]!;
    expect(d).toMatchObject({ count: 3, tool: "iron_pickaxe" });
    expect(d.searchHint?.kind).toBe("underground");
    expect(d.searchHint?.yRange?.[0]).toBeLessThan(0);
    const o = ops(p);
    expect(o.indexOf("craft:iron_pickaxe")).toBeLessThan(o.indexOf("gather:diamond"));
  });

  it("owned higher-tier tool satisfies a lower requirement", () => {
    const v = mkView({ inventory: { iron_pickaxe: 1 } });
    const p = expectReaches([g("cobblestone", 5)], v);
    expect(ops(p)).toEqual(["gather:cobblestone"]);
    expect(find(p, "gather")[0]!.tool).toBe("wooden_pickaxe");
  });

  it("golden pickaxe mines stone but not iron (gold quirk, from minecraft-data)", () => {
    const v = mkView({ inventory: { golden_pickaxe: 1 } });
    expect(ops(expectReaches([g("cobblestone", 5)], v))).toEqual(["gather:cobblestone"]);
    const p = expectReaches([g("raw_iron", 2)], v);
    expect(find(p, "craft", "stone_pickaxe")).toHaveLength(1);
  });

  it("copper pickaxe counts as stone-tier for iron", () => {
    const v = mkView({ inventory: { copper_pickaxe: 1 } });
    const p = expectReaches([g("raw_iron", 2)], v);
    expect(ops(p)).toEqual(["gather:raw_iron"]);
  });

  it("copper_ingot: copper ore (stone pickaxe), smelt", () => {
    const p = expectReaches([g("copper_ingot")], mkView());
    expect(find(p, "gather", "raw_copper")[0]).toMatchObject({ count: 1, tool: "stone_pickaxe" });
    expect(find(p, "gather", "raw_copper")[0]!.blocks).toEqual(["copper_ore", "deepslate_copper_ore"]);
    expect(find(p, "gather", "raw_copper")[0]!.searchHint?.kind).toBe("underground");
    expect(find(p, "smelt")[0]).toMatchObject({ input: "raw_copper", output: "copper_ingot" });
  });
});

describe("sources and edge cases", () => {
  it("already holding the item: no steps", () => {
    const p = plan([g("iron_pickaxe")], mkView({ inventory: { iron_pickaxe: 1 } }));
    expect(p.steps).toEqual([]);
    expect(p.unresolved).toEqual([]);
    expect(p.summary).toMatch(/already/);
  });

  it("partial holdings: only the shortfall is produced", () => {
    const p = expectReaches([g("oak_planks", 6)], mkView({ inventory: { oak_planks: 4 } }));
    expect(find(p, "craft", "oak_planks")[0]).toMatchObject({ count: 4, crafts: 1 });
    expect(find(p, "gather", "oak_log")[0]!.count).toBe(1);
  });

  it("known chest holding iron_ingot: withdraw instead of mining", () => {
    const chest = { x: 12, y: 64, z: 3 };
    const v = mkView({
      containers: [{ pos: chest, items: { iron_ingot: 3 } }],
      inventory: { stick: 2 },
      stations: { crafting_table: true, furnace: false },
    });
    const p = expectReaches([g("iron_pickaxe")], v);
    expect(ops(p)).toEqual(["withdraw:iron_ingot", "craft:iron_pickaxe"]);
    expect(find(p, "withdraw")[0]).toMatchObject({ count: 3, from: chest });
    expect(p.rawNeeds).toEqual({ iron_ingot: 3 });
  });

  it("chest covers only part: withdraw then produce the rest", () => {
    const v = mkView({ containers: [{ pos: { x: 1, y: 64, z: 1 }, items: { iron_ingot: 2 } }], inventory: { raw_iron: 0 } });
    const p = expectReaches([g("iron_ingot", 5)], v);
    expect(find(p, "withdraw")[0]!.count).toBe(2);
    expect(find(p, "smelt")[0]!.count).toBe(3);
  });

  it("unknown item is unresolved with an unknown_item reason", () => {
    const p = plan([g("unobtainium")], mkView());
    expect(p.steps).toEqual([]);
    expect(p.unresolved).toHaveLength(1);
    expect(p.unresolved[0]!.reason).toMatch(/^unknown_item/);
  });

  it("torch with coal_ore in view: gathers coal", () => {
    const v = mkView({ near: { oak_log: 5, stone: 8, coal_ore: 12 } });
    const p = expectReaches([g("torch", 4)], v);
    expect(find(p, "gather", "coal")[0]!.count).toBe(1);
    expect(find(p, "smelt")).toHaveLength(0);
    expect(find(p, "craft", "torch")[0]).toMatchObject({ count: 4, crafts: 1, table: false });
  });

  it("torch with coal held: just crafts", () => {
    const p = expectReaches([g("torch", 8)], mkView({ inventory: { coal: 2, stick: 2 } }));
    expect(ops(p)).toEqual(["craft:torch"]);
    expect(find(p, "craft", "torch")[0]!.crafts).toBe(2);
  });

  it("torch with no coal anywhere in view but logs: charcoal via smelting logs", () => {
    const v = mkView({ near: { oak_log: 5, stone: 8 } });
    const p = expectReaches([g("torch", 4)], v);
    expect(find(p, "smelt")[0]).toMatchObject({ input: "oak_log", output: "charcoal", count: 1 });
    expect(find(p, "gather", "coal")).toHaveLength(0);
    expect(find(p, "craft", "furnace")).toHaveLength(1);
  });

  it("torch with charcoal in the inventory uses it", () => {
    const p = expectReaches([g("torch", 4)], mkView({ inventory: { charcoal: 1, stick: 1 } }));
    expect(ops(p)).toEqual(["craft:torch"]);
  });

  it("bread: needs a 3-wide recipe => crafting table; wheat held", () => {
    const p = expectReaches([g("bread")], mkView({ inventory: { wheat: 3 } }));
    expect(find(p, "craft", "bread")[0]).toMatchObject({ table: true });
    expect(find(p, "craft", "crafting_table")).toHaveLength(1);
  });

  it("bread: wheat crop in view is gathered; no crop => unresolved wheat (needs a farm)", () => {
    const withCrop = expectReaches([g("bread", 2)], mkView({ near: { oak_log: 5, wheat: 9 } }));
    expect(find(withCrop, "gather", "wheat")[0]).toMatchObject({ count: 6, blocks: ["wheat"] });
    const none = plan([g("bread")], mkView());
    expect(none.unresolved).toHaveLength(1);
    expect(none.unresolved[0]).toMatchObject({ item: "wheat", count: 3 });
    expect(none.unresolved[0]!.reason).toMatch(/farm/);
  });

  it("mob drops are unresolved with a clear reason", () => {
    const p = plan([g("gunpowder", 2)], mkView());
    expect(p.unresolved[0]!.reason).toMatch(/mob/);
  });

  it("raw food from a mob: leaf (beef) is reported unresolved, not the cooked item", () => {
    const p = plan([g("cooked_beef", 2)], mkView());
    expect(p.unresolved).toHaveLength(1);
    expect(p.unresolved[0]).toMatchObject({ item: "beef", count: 2 });
  });

  it("creative mode: empty plan for the executor", () => {
    const p = plan([g("diamond", 64)], mkView({ gameMode: "creative" }));
    expect(p).toMatchObject({ steps: [], unresolved: [], summary: "creative: use getItems" });
  });

  it("Nether-only block is not planned in the Overworld, but is in the Nether", () => {
    const o = plan([g("netherrack", 4)], mkView({ near: {} }));
    expect(o.unresolved[0]!.reason).toMatch(/the_nether/);
    const n = plan([g("netherrack", 4)], mkView({ near: {}, dimension: "the_nether", inventory: { wooden_pickaxe: 1 } }));
    expect(find(n, "gather", "netherrack")).toHaveLength(1);
  });

  it("reversible compression recipes don't loop (ingot <-> nugget <-> block)", () => {
    const v = mkView({ inventory: { iron_ingot: 9 } });
    const a = expectReaches([g("iron_nugget", 9)], v);
    expect(ops(a)).toEqual(["craft:iron_nugget"]);
    const b = expectReaches([g("iron_block", 1)], mkView({ inventory: { iron_ingot: 9 }, stations: { crafting_table: true, furnace: false } }));
    expect(ops(b)).toEqual(["craft:iron_block"]);
    const c = plan([g("iron_ingot", 2)], mkView());
    expect(find(c, "smelt")).toHaveLength(1);
  });

  it("duplicate goals sum; non-positive goals are ignored", () => {
    const p = plan([g("cobblestone", 3), g("cobblestone", 2), g("stick", 0)], mkView({ inventory: { wooden_pickaxe: 1 } }));
    expect(find(p, "gather", "cobblestone")[0]!.count).toBe(5);
    expect(p.goals).toHaveLength(2);
  });

  it("maxSteps guard marks the plan unresolved instead of running away", () => {
    const p = plan([g("iron_pickaxe")], mkView(), { maxSteps: 3 });
    expect(p.steps).toHaveLength(3);
    expect(p.unresolved.some((u) => /too deep/.test(u.reason))).toBe(true);
  });

  it("summary stays within 200 chars for large plans", () => {
    const goals = ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots", "diamond_sword", "diamond_pickaxe"].map((i) => g(i));
    const p = plan(goals, mkView());
    expect(p.summary.length).toBeLessThanOrEqual(200);
  });
});
