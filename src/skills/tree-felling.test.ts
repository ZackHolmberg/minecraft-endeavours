import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import { fellInfo, posKey, rankLogs, speciesViewScore, type BlockAt } from "./tree-felling.js";

/** Tiny world: stone floor at y=0, everything else air unless set. */
function world(blocks: Record<string, string>): BlockAt {
  return (p) => {
    const n = blocks[posKey(p)];
    if (n) return { name: n, boundingBox: n === "air" ? "empty" : "block" };
    if (p.y <= 0) return { name: "stone", boundingBox: "block" };
    return { name: "air", boundingBox: "empty" };
  };
}
function trunk(b: Record<string, string>, x: number, z: number, h: number, name: string): void {
  for (let y = 1; y <= h; y++) b[`${x},${y},${z}`] = name;
}

describe("fellInfo", () => {
  it("accepts the bottom log and refuses the ones stacked on it", () => {
    const b: Record<string, string> = {};
    trunk(b, 0, 0, 8, "oak_log");
    const at = world(b);
    expect(fellInfo(at, new Vec3(0, 1, 0))).toMatchObject({ ok: true, height: 0 });
    expect(fellInfo(at, new Vec3(0, 2, 0))).toMatchObject({ ok: false, reason: "under_log" });
  });
  it("a column's next log becomes a candidate once the one below is gone, up to reach", () => {
    const b: Record<string, string> = {};
    trunk(b, 0, 0, 10, "oak_log");
    for (let y = 1; y <= 4; y++) delete b[`0,${y},0`]; // 4 mined from the bottom
    const at = world(b);
    expect(fellInfo(at, new Vec3(0, 5, 0))).toMatchObject({ ok: true, height: 4 }); // 5th log: still arm's reach
    expect(fellInfo(at, new Vec3(0, 6, 0))).toMatchObject({ ok: false, reason: "under_log" });
    delete b["0,5,0"];
    expect(fellInfo(at, new Vec3(0, 6, 0))).toMatchObject({ ok: false, reason: "too_high", height: 5 }); // would need towering
  });
  it("reports leaves under a log (the drop would rest on them)", () => {
    const b: Record<string, string> = { "0,3,0": "oak_log", "0,2,0": "oak_leaves" };
    const info = fellInfo(world(b), new Vec3(0, 3, 0));
    expect(info.ok).toBe(true);
    expect(info.leavesBelow.map(posKey)).toEqual(["0,2,0"]);
  });
});

describe("rankLogs", () => {
  it("prefers a short oak over a closer jungle giant, but only the species requested is ever passed in", () => {
    const b: Record<string, string> = {};
    // jungle 2x2 giant, 20 tall, right next to the bot
    for (const [x, z] of [[1, 0], [2, 0], [1, 1], [2, 1]] as const) trunk(b, x, z, 20, "jungle_log");
    // small oak 12 blocks away
    trunk(b, 12, 0, 5, "oak_log");
    const at = world(b);
    const all: Vec3[] = Object.entries(b).map(([k]) => new Vec3(...(k.split(",").map(Number) as [number, number, number])));
    const r = rankLogs(at, all, new Vec3(0, 1, 0));
    expect(r.ranked[0]!.pos.x).toBe(12);
    expect(r.ranked[0]!.pos.y).toBe(1);
    // species-only call still works for the jungle
    const jungle = all.filter((p) => b[posKey(p)] === "jungle_log");
    const rj = rankLogs(at, jungle, new Vec3(0, 1, 0));
    expect(rj.ranked.length).toBe(4); // bottom log of each of the 4 columns
    expect(rj.ranked.every((x) => x.pos.y === 1)).toBe(true);
    expect(rj.underLog).toBe(76);
  });
  it("sticks to the tree just chopped", () => {
    const b: Record<string, string> = {};
    trunk(b, 3, 0, 5, "oak_log");
    trunk(b, 0, 4, 5, "oak_log");
    const at = world(b);
    const all = [new Vec3(3, 1, 0), new Vec3(0, 1, 4)];
    const first = rankLogs(at, all, new Vec3(0, 1, 0));
    expect(first.ranked[0]!.pos.x).toBe(3);
    const stick = rankLogs(at, all, new Vec3(0, 1, 0), first.ranked[1]!.tree.keys);
    expect(stick.ranked[0]!.pos.z).toBe(4);
  });
  it("speciesViewScore is null when nothing is choppable from the ground", () => {
    const b: Record<string, string> = {};
    for (let y = 8; y <= 12; y++) b[`0,${y},0`] = "jungle_log"; // floating canopy limb
    const at = world(b);
    expect(speciesViewScore(at, [new Vec3(0, 8, 0)], new Vec3(0, 1, 0))).toBeNull();
  });
});
