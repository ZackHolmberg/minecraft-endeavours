import { describe, expect, it } from "vitest";
import type { Step } from "../planner/types.js";
import { formatJobEvent, jobContextLines } from "./describe.js";
import { directionOrder, isDiggableName, liquidSafe, spiralLegs, stepIsSafe, targetY, type NameAt } from "./explore.js";
import { MAX_EXPLORES, SCAN_RADII, decideRecovery, kindFromUnresolved, newEpisode, stepKey } from "./recovery.js";
import { classifyFailure } from "./steps/classify.js";
import { naturalBlocks } from "./steps/gather.js";
import { JOB_EXEMPT_TOOLS, shouldCancelJobFor } from "./tools.js";
import type { Job } from "./types.js";
import { inventoryTotals, relevantBlockNames } from "./world-view.js";

describe("auto-cancel policy", () => {
  it("exempts reads, talk, notes and job control", () => {
    for (const t of ["say", "whisper", "observeSurroundings", "checkInventory", "remember", "setTaskQueue", "advanceTaskQueue", "achieve", "build", "cancelJob"]) {
      expect(shouldCancelJobFor(t, true)).toBe(false);
    }
    expect([...JOB_EXEMPT_TOOLS]).toHaveLength(10);
  });
  it("cancels for movement / mining / crafting / building tools, only while a job runs", () => {
    for (const t of ["goTo", "mineBlock", "mineBlocks", "craft", "craftMany", "smelt", "placeBlocks", "followPlayer", "attack", "stop", "withdrawFromChest", "pillarUp"]) {
      expect(shouldCancelJobFor(t, true)).toBe(true);
      expect(shouldCancelJobFor(t, false)).toBe(false);
    }
  });
});

describe("classifyFailure (messages the v1 skills emit)", () => {
  const cases: Array<[string, string]> = [
    ["no oak_log within 64 blocks", "no_source"],
    ["no mineable blocks within 64 blocks (skipped: iron_ore)", "no_source"],
    ["no minable stone within 64 blocks — 2 more could not be reached without climbing or digging (x)", "no_source"],
    ["collected 2 oak_log; no more within 64 blocks", "no_source"],
    ["could not reach any oak_log (3 tried; no path to oak_log at (1, 2, 3))", "unreachable"],
    ["stuck retargeting same block at (1, 2, 3)", "unreachable"],
    ["cannot mine any requested type — iron_ore: no pickaxe in inventory to mine iron_ore", "missing_tool"],
    ["lost the tool needed for stone mid-task", "missing_tool"],
    ["mining cancelled: collected 2 oak_log", "cancelled"],
    ["stopped after 3 blocks dropped nothing I could pick up", "unreachable"],
    ["collected 3 stone; inventory is full", "inventory_full"],
    ["craftMany failed at items[0] (stone_pickaxe) after crafting 0 of 1: cannot craft 1 stone_pickaxe: missing 2 stick", "missing_input"],
    ["craftMany failed at items[0] (x) after crafting 0 of 1: no crafting_table within 32 blocks, none in inventory, and none remembered", "station_unavailable"],
    ["cannot smelt 3 raw_iron: only 1 in inventory", "missing_input"],
    ["no furnace/blast_furnace within 32 blocks and none remembered; mine 8 cobblestone", "station_unavailable"],
    ["not enough fuel: need 2 oak_planks (smelts 1.5/unit), have 0", "missing_input"],
    ["smelt timeout: collected 1 of 3 raw_iron", "timeout"],
    ["withdrawManyFromChest failed at items[0] (iron_ingot): chest at (1, 2, 3) has no iron_ingot", "no_source"],
    ["mineBlocks crashed: boom", "internal"],
  ];
  for (const [msg, kind] of cases) it(`${kind}: ${msg.slice(0, 60)}`, () => expect(classifyFailure(msg)).toBe(kind));
  it("state.cancelled wins; unknown messages use the fallback", () => {
    expect(classifyFailure("whatever", { cancelled: true })).toBe("cancelled");
    expect(classifyFailure("something odd", undefined, "unreachable")).toBe("unreachable");
  });
});

describe("recovery ladder policy", () => {
  const hint = { kind: "underground" as const, yRange: [-16, 48] as [number, number] };
  const g = (extra: object = {}): Extract<Step, { op: "gather" }> => ({ op: "gather", item: "raw_iron", count: 3, blocks: ["iron_ore"], tool: "stone_pickaxe", ...extra });
  const f = (kind: Parameters<typeof decideRecovery>[0]["kind"], step: Step) => ({ kind, step, detail: "d", attempts: 1 });

  it("no_source with a hint: widen, widen, explore x MAX_EXPLORES, fail", () => {
    const step = g({ searchHint: hint });
    const ep = newEpisode();
    const seq = Array.from({ length: SCAN_RADII.length - 1 + MAX_EXPLORES + 1 }, () => decideRecovery(f("no_source", step), step, ep, 5).rung);
    expect(seq).toEqual(["widen", "widen", "explore", "explore", "fail"]);
  });
  it("no_source without a hint re-plans first (stale view), once", () => {
    const step = g();
    const ep = newEpisode();
    expect(decideRecovery(f("no_source", step), step, ep, 5).rung).toBe("replan");
    expect(decideRecovery(f("no_source", step), step, ep, 5).rung).toBe("widen");
  });
  it("transient kinds retry once, then re-plan or fail", () => {
    const step: Step = { op: "craft", item: "stick", count: 4, crafts: 1, table: false };
    const ep = newEpisode();
    expect(decideRecovery(f("station_unavailable", step), step, ep, 5).rung).toBe("retry");
    expect(decideRecovery(f("station_unavailable", step), step, ep, 5).rung).toBe("replan");
    expect(decideRecovery(f("station_unavailable", step), step, ep, 5).rung).toBe("fail");
  });
  it("no replans left skips straight to fail", () => {
    const step: Step = { op: "craft", item: "stick", count: 4, crafts: 1, table: false };
    expect(decideRecovery(f("missing_input", step), step, newEpisode(), 0).rung).toBe("fail");
  });
  it("cancelled/died end the job as cancelled; inventory_full/not_obtainable fail at once", () => {
    const step = g();
    expect(decideRecovery(f("cancelled", step), step, newEpisode(), 5).rung).toBe("cancel");
    expect(decideRecovery(f("died", step), step, newEpisode(), 5).rung).toBe("cancel");
    expect(decideRecovery(f("inventory_full", step), step, newEpisode(), 5).rung).toBe("fail");
  });
  it("step keys separate different remainders; unresolved tags map to kinds", () => {
    expect(stepKey(g())).not.toBe(stepKey(g({ count: 2 })));
    expect(kindFromUnresolved("no_source: wheat needs a farm")).toBe("no_source");
    expect(kindFromUnresolved("weird")).toBe("not_obtainable");
  });
});

describe("explore helpers", () => {
  it("spiral legs: 6 legs of 40,40,80,80,120,120 turning E,S,W,N", () => {
    const legs = spiralLegs();
    expect(legs.map((l) => l.length)).toEqual([40, 40, 80, 80, 120, 120]);
    expect(legs.slice(0, 4).map((l) => [l.dx, l.dz])).toEqual([[1, 0], [0, 1], [-1, 0], [0, -1]]);
  });
  it("targetY: descend to the window middle, never dig up, branch where we are inside the window", () => {
    expect(targetY(70, [-16, 48])).toBe(16);
    expect(targetY(30, [-16, 48])).toBeNull();
    expect(targetY(-40, [-16, 48])).toBeNull();
    expect(targetY(70, [-64, -48])).toBe(-56);
    expect(targetY(70, undefined)).toBeNull();
  });
  it("only natural blocks are diggable", () => {
    for (const n of ["stone", "deepslate", "dirt", "gravel", "iron_ore", "deepslate_coal_ore", "andesite"]) expect(isDiggableName(n)).toBe(true);
    for (const n of ["oak_planks", "chest", "spawner", "bedrock", "obsidian", "glass", "oak_door", "water"]) expect(isDiggableName(n)).toBe(false);
  });
  // tiny world: solid stone everywhere except what `over` overrides; y<=floor solid
  const world = (over: Record<string, string>): NameAt => (x, y, z) => over[`${x},${y},${z}`] ?? "stone";
  const airLike = (over: Record<string, string>) => (x: number, y: number, z: number) => ["air", "cave_air"].includes(over[`${x},${y},${z}`] ?? "stone");
  it("liquid next to a cell makes it unsafe, at any of the 6 neighbours", () => {
    expect(liquidSafe(world({}), 0, 0, 0)).toBe(true);
    for (const k of ["1,0,0", "-1,0,0", "0,1,0", "0,-1,0", "0,0,1", "0,0,-1"]) expect(liquidSafe(world({ [k]: "lava" }), 0, 0, 0)).toBe(false);
  });
  it("stair step: safe in solid stone; refuses water/lava next to a dug cell, bad blocks, pits and magma floors", () => {
    const ok = stepIsSafe(world({}), airLike({}), 0, 10, 0, 1, 0, true);
    expect(ok.ok).toBe(true);
    expect(stepIsSafe(world({ "2,10,0": "water" }), airLike({}), 0, 10, 0, 1, 0, true).ok).toBe(false); // next to dug (1,10,0)
    expect(stepIsSafe(world({ "1,11,0": "oak_planks" }), airLike({}), 0, 10, 0, 1, 0, true).reason).toContain("won't dig");
    const pit = { "1,8,0": "air" };
    expect(stepIsSafe(world(pit), airLike(pit), 0, 10, 0, 1, 0, true).reason).toContain("pit");
    expect(stepIsSafe(world({ "1,8,0": "magma_block" }), airLike({}), 0, 10, 0, 1, 0, true).ok).toBe(false);
    const unloaded: NameAt = (x, y, z) => (x === 1 ? null : "stone");
    expect(stepIsSafe(unloaded, airLike({}), 0, 10, 0, 1, 0, true).ok).toBe(false);
  });
  it("level tunnel step needs a floor and clear 2-high cells", () => {
    expect(stepIsSafe(world({}), airLike({}), 0, 10, 0, 0, 1, false).ok).toBe(true);
    const pit = { "0,9,1": "air" };
    expect(stepIsSafe(world(pit), airLike(pit), 0, 10, 0, 0, 1, false).ok).toBe(false);
  });
  it("direction order: straight, right, left, back", () => {
    expect(directionOrder({ dx: 1, dz: 0 })).toEqual([{ dx: 1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }, { dx: -1, dz: 0 }]);
  });
});

describe("world view + gather helpers", () => {
  it("inventoryTotals counts main, hotbar, armor and offhand but not the crafting grid", () => {
    const slots = Array.from({ length: 46 }, () => null) as Array<{ name: string; count: number } | null>;
    slots[0] = { name: "stick", count: 4 }; // craft output
    slots[2] = { name: "oak_planks", count: 4 }; // craft grid
    slots[5] = { name: "iron_helmet", count: 1 };
    slots[10] = { name: "cobblestone", count: 10 };
    slots[36] = { name: "cobblestone", count: 5 };
    slots[45] = { name: "shield", count: 1 };
    expect(inventoryTotals(slots)).toEqual({ iron_helmet: 1, cobblestone: 15, shield: 1 });
  });
  it("relevantBlockNames: logs, stone family, ores, sand; not stripped logs or random blocks; plus goal blocks", () => {
    const names = ["oak_log", "stripped_oak_log", "stone", "dirt", "iron_ore", "deepslate_diamond_ore", "sand", "gravel", "oak_planks", "wheat", "sugar_cane", "glowstone"];
    const out = relevantBlockNames(names, ["glowstone", "not_a_block"]);
    expect(out).toEqual(expect.arrayContaining(["oak_log", "stone", "iron_ore", "deepslate_diamond_ore", "sand", "gravel", "wheat", "sugar_cane", "glowstone"]));
    expect(out).not.toContain("stripped_oak_log");
    expect(out).not.toContain("dirt");
    expect(out).not.toContain("oak_planks");
    expect(out).not.toContain("not_a_block");
  });
  it("naturalBlocks prefers stone over player-looking cobblestone", () => {
    expect(naturalBlocks(["stone", "cobblestone"])).toEqual(["stone"]);
    expect(naturalBlocks(["cobblestone"])).toEqual(["cobblestone"]);
  });
});

describe("job text", () => {
  const base: Job = {
    id: "j1",
    kind: "achieve",
    goals: [{ item: "iron_pickaxe", count: 1 }],
    requestedBy: "Alex",
    status: "done",
    startedAt: 0,
    endedAt: 252_000,
    plan: { goals: [], steps: [{ op: "craft", item: "iron_pickaxe", count: 1, crafts: 1, table: true }], rawNeeds: {}, unresolved: [], summary: "" },
    stepIndex: 0,
    replans: 0,
    progress: "",
    failure: null,
  };
  it("done event names goal, duration and requester", () => {
    const t = formatJobEvent(base)!;
    expect(t).toContain("[job finished] achieve iron_pickaxe x1 — done in 4m12s");
    expect(t).toContain("Alex");
  });
  it("failed event carries kind, detail and remaining plan", () => {
    const t = formatJobEvent({ ...base, status: "failed", failure: { kind: "no_source", step: base.plan.steps[0]!, detail: "no iron_ore within 160 blocks after exploring", attempts: 3 } })!;
    expect(t).toContain("[job failed]");
    expect(t).toContain("failure: no_source — no iron_ore within 160 blocks");
    expect(t).toContain("remaining plan: craft 1 iron_pickaxe");
  });
  it("cancelled / interrupted jobs produce no event", () => {
    expect(formatJobEvent({ ...base, status: "cancelled" })).toBeNull();
    expect(formatJobEvent({ ...base, status: "interrupted" })).toBeNull();
  });
  it("context: running job shows progress; ended <2 min shows outcome; older shows nothing", () => {
    const running: Job = { ...base, status: "running", endedAt: null, progress: "step 1/1: craft 1 iron_pickaxe" };
    expect(jobContextLines(running, 60_000).join("\n")).toContain("progress: step 1/1: craft 1 iron_pickaxe");
    expect(jobContextLines(base, 252_000 + 30_000).join("\n")).toContain("done");
    expect(jobContextLines(base, 252_000 + 5 * 60_000)).toEqual([]);
    expect(jobContextLines(null)).toEqual([]);
  });
});

describe("eval busy signal", () => {
  it("jobState: running between job_start and job_end; v1 telemetry (no job_*) is never busy", async () => {
    const { jobState } = await import("../eval/telemetry.js");
    const b = { bot: "b", runId: "r", taskId: null };
    expect(jobState([{ ...b, at: 1, kind: "loop_lag", lagMs: 1 }])).toEqual({ running: false, lastAt: 0 });
    const start = { ...b, at: 10, kind: "job_start" as const, jobId: "j1", goals: [], steps: 2 };
    expect(jobState([start])).toEqual({ running: true, lastAt: 10 });
    const end = { ...b, at: 20, kind: "job_end" as const, jobId: "j1", status: "done", durationMs: 10, steps: 2, replans: 0, failureKind: null };
    expect(jobState([start, end])).toEqual({ running: false, lastAt: 20 });
  });
});
