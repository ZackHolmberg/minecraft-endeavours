import { describe, expect, it } from "vitest";
import { emptyExhausted, excludeFor, inExhausted, noteExhausted, touchesLiquid, withDryOres } from "./exhausted.js";
import { distinctCandidates, rankRelocations, type SurfaceFn } from "./explore.js";
import { MAX_RELOCATIONS, RELOCATE_MIN_POSITIONS, decideRecovery, newEpisode } from "./recovery.js";
import type { Step } from "../planner/types.js";

const coal: Step = { op: "gather", item: "coal", count: 8, blocks: ["coal_ore", "deepslate_coal_ore"], tool: null };
const logs: Step = { op: "gather", item: "jungle_log", count: 8, blocks: ["jungle_log"], tool: null };
const fail = (step: Step, positions: string[]) => ({ kind: "unreachable" as const, step, detail: "d", attempts: 1, positions });
const POS = ["-313,53,-581", "-312,53,-580", "-312,52,-579"];

describe("recovery: relocate rung", () => {
  it("unreachable gather with several dead positions relocates first (while relocations remain)", () => {
    const r = decideRecovery(fail(coal, POS), coal, newEpisode(), 5, MAX_RELOCATIONS);
    expect(r.rung).toBe("relocate");
  });
  it("needs enough positions, a relocation budget, and a non-log gather", () => {
    expect(POS.length).toBeGreaterThanOrEqual(RELOCATE_MIN_POSITIONS);
    expect(decideRecovery(fail(coal, POS.slice(0, 1)), coal, newEpisode(), 5, 2).rung).toBe("retry");
    expect(decideRecovery(fail(coal, POS), coal, newEpisode(), 5, 0).rung).not.toBe("relocate");
    expect(decideRecovery(fail(logs, POS), logs, newEpisode(), 5, 2).rung).not.toBe("relocate");
  });
});

describe("exhausted areas", () => {
  it("records positions + a region around them; the exclusion covers the area and the band, not a deep seam", () => {
    const ex = emptyExhausted();
    const g = noteExhausted(ex, POS, { x: 0, y: 64, z: 0 });
    expect(g.x).toBeCloseTo(-312, 0);
    expect(g.r).toBeGreaterThanOrEqual(24);
    const ex1 = excludeFor(ex)!;
    expect(ex1(-313, 53, -581)).toBe(true); // a recorded position
    expect(ex1(-300, 55, -590)).toBe(true); // other ore in the same lake wall
    expect(ex1(-300, 2, -590)).toBe(false); // deepslate far below: a different place
    expect(ex1(-200, 53, -581)).toBe(false); // far away
    expect(inExhausted(ex, -312, -580)).toBe(true);
  });
  it("falls back to the bot position, de-duplicates, and has no predicate when empty", () => {
    expect(excludeFor(emptyExhausted())).toBeUndefined();
    const ex = emptyExhausted();
    noteExhausted(ex, [], { x: 100, y: 70, z: 100 });
    noteExhausted(ex, [], { x: 101, y: 70, z: 101 });
    expect(ex.regions).toHaveLength(1);
  });
});

/** A lake to the west (x < 0), dry elsewhere, unloaded beyond |coordinate| > 200, lava far north-east. */
const world: SurfaceFn = (x, z) => {
  if (Math.abs(x) > 200 || Math.abs(z) > 200) return null;
  if (x < 0) return { y: 62, wet: true, hazard: false };
  if (x > 40 && z < -60) return { y: 64, wet: false, hazard: true };
  return { y: 64, wet: false, hazard: false };
};

describe("rankRelocations", () => {
  it("prefers dry land away from the exhausted area, never a wet / hazardous / excluded destination", () => {
    const start = { x: 5, z: 0 };
    const regions = [{ x: -5, z: 0, r: 20 }];
    const ranked = rankRelocations(world, start, regions);
    expect(ranked.length).toBeGreaterThan(0);
    const best = ranked[0]!;
    expect(best.x).toBeGreaterThan(start.x + 20); // east, away from the lake
    for (const c of ranked) {
      expect(world(c.x, c.z)!.wet).toBe(false);
      expect(world(c.x, c.z)!.hazard).toBe(false);
      expect(Math.hypot(c.x - -5, c.z)).toBeGreaterThan(20);
      expect(Math.hypot(c.x - start.x, c.z - start.z)).toBeGreaterThanOrEqual(56);
    }
    const picks = distinctCandidates(ranked, 4);
    expect(picks.length).toBeGreaterThan(1);
  });
  it("returns nothing when every direction is water or unloaded", () => {
    expect(rankRelocations(() => ({ y: 60, wet: true, hazard: false }), { x: 0, z: 0 }, [])).toEqual([]);
    expect(rankRelocations(() => null, { x: 0, z: 0 }, [])).toEqual([]);
  });
  it("respects the 250-block cap from the origin", () => {
    const ranked = rankRelocations(() => ({ y: 64, wet: false, hazard: false }), { x: 230, z: 0 }, [], { origin: { x: 0, z: 0 } });
    expect(ranked.every((c) => Math.hypot(c.x, c.z) <= 250)).toBe(true);
  });
});

describe("dry ore preference", () => {
  it("a cluster of dry exposed ore becomes the top destination (when its way is dry)", () => {
    const start = { x: 5, z: 0 };
    const regions = [{ x: -5, z: 0, r: 20 }];
    const base = rankRelocations(world, start, regions);
    const withOre = rankRelocations(world, start, regions, { ores: [{ x: 5, z: 100 }, { x: 8, z: 103 }] }); // 2 blocks of one 12-cell
    expect(withOre[0]!.z).toBeGreaterThan(90);
    expect(withOre[0]!.score).toBeGreaterThan(base[0]!.score);
    // an ore inside the exhausted area, or across the lake, is not a destination
    const bad = rankRelocations(world, start, regions, { ores: [{ x: -5, z: 10 }, { x: -120, z: 0 }] });
    expect(bad.every((c) => c.x > 0)).toBe(true);
  });
  it("liquid-touching ore is shunned only once an exclusion exists", () => {
    const names: Record<string, string> = { "0,50,0": "coal_ore", "0,51,0": "water" };
    const nameAt = (x: number, y: number, z: number): string | null => names[`${x},${y},${z}`] ?? "stone";
    expect(touchesLiquid(nameAt, 0, 50, 0)).toBe(true);
    expect(touchesLiquid(nameAt, 5, 50, 5)).toBe(false);
    expect(withDryOres(undefined, nameAt)).toBeUndefined();
    const ex = withDryOres(() => false, nameAt)!;
    expect(ex(0, 50, 0)).toBe(true);
    expect(ex(5, 50, 5)).toBe(false);
  });
});
