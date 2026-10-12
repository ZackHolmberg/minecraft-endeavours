import { describe, expect, it } from "vitest";
import { LIMITS } from "./convert.js";
import { decodeCells, designFromGrid, encodeDesign, GRID_LIMITS, parseDesign, placedCount } from "./design.js";
import { isPaletteBlock, paletteFor, PALETTE_FAMILIES, PALETTE_MC_VERSION } from "./palette.js";
import { createRequire } from "node:module";

const cells = [
  ["red_concrete", "white_concrete", null],
  ["blue_concrete", null, "red_concrete"],
];

describe("design encode / parse", () => {
  it("round-trips cells, keeps provenance, drops control characters", () => {
    const d = encodeDesign({ w: 3, h: 2, cells }, { orientation: "wall", title: "Hab\u0000s\nlogo", credit: "PD" });
    expect(d.blocks).toEqual(["red_concrete", "blue_concrete", "white_concrete"]); // most used first
    expect(d.rows).toEqual(["02.", "1.0"]);
    const p = parseDesign(JSON.parse(JSON.stringify(d)));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(decodeCells(p.design)).toEqual(cells);
    expect(p.design.title).toBe("Hab s logo");
    expect(placedCount(p.design)).toBe(4);
  });
  it("rejects anything that is not a valid design", () => {
    const good = encodeDesign({ w: 3, h: 2, cells }, { orientation: "flat" });
    const bad = (mut: (d: Record<string, unknown>) => void): void => {
      const d = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      mut(d);
      expect(parseDesign(d).ok).toBe(false);
    };
    expect(parseDesign(good).ok).toBe(true);
    expect(parseDesign(null).ok).toBe(false);
    expect(parseDesign("x").ok).toBe(false);
    bad((d) => (d.blocks = ["tnt"]));
    bad((d) => (d.blocks = ["red_concrete", "lava"]));
    bad((d) => (d.blocks = ["command_block"]));
    bad((d) => (d.blocks = ["red_concrete", "white_wool"])); // mixed families
    bad((d) => (d.blocks = ["red_concrete", "red_concrete", "blue_concrete"])); // duplicates
    bad((d) => (d.blocks = []));
    bad((d) => (d.blocks = Array.from({ length: 17 }, () => "red_concrete")));
    bad((d) => (d.w = 4));
    bad((d) => (d.h = 3));
    bad((d) => (d.rows = ["01.", "2.0x"]));
    bad((d) => (d.rows = ["01.", "9.0"])); // index out of range
    bad((d) => (d.rows = ["...", "..."])); // empty
    bad((d) => (d.rows = "01.,2.0"));
    bad((d) => (d.w = 0));
    bad((d) => (d.w = 1.5));
  });
  it("enforces the size caps", () => {
    const row = (w: number): string => "0".repeat(w);
    const mk = (w: number, h: number) => ({ v: 1, orientation: "wall", w, h, blocks: ["red_concrete"], rows: Array.from({ length: h }, () => row(w)) });
    expect(parseDesign(mk(LIMITS.maxWidth, 46)).ok).toBe(true); // 5888
    expect(parseDesign(mk(LIMITS.maxWidth, 47)).ok).toBe(false); // 6016 blocks
    expect(parseDesign(mk(60, LIMITS.maxHeight)).ok).toBe(true);
    expect(parseDesign(mk(10, LIMITS.maxHeight + 1)).ok).toBe(false);
    expect(parseDesign(mk(LIMITS.maxWidth + 1, 2)).ok).toBe(false);
  });
});

describe("hand-drawn grid fallback", () => {
  const pal = { R: "red_concrete", W: "white_concrete" };
  it("accepts a valid grid", () => {
    const r = designFromGrid(["RW.", "WR "], pal, "wall");
    expect(r.ok).toBe(true);
    if (r.ok) expect(decodeCells(r.design)).toEqual([["red_concrete", "white_concrete", null], ["white_concrete", "red_concrete", null]]);
  });
  it("normalises block names", () => {
    expect(designFromGrid(["R"], { R: " Red Concrete " }, "flat").ok).toBe(true);
  });
  it("rejects ragged, oversize, unmapped, disallowed and mixed grids", () => {
    expect(designFromGrid(["RW", "R"], pal, "wall").ok).toBe(false);
    expect(designFromGrid([], pal, "wall").ok).toBe(false);
    expect(designFromGrid("RW" as unknown, pal, "wall").ok).toBe(false);
    expect(designFromGrid(["RX"], pal, "wall").ok).toBe(false);
    expect(designFromGrid(["R"], { R: "tnt" }, "wall").ok).toBe(false);
    expect(designFromGrid(["R"], { R: "lava_bucket" }, "wall").ok).toBe(false);
    expect(designFromGrid(["R"], { R: "bedrock" }, "wall").ok).toBe(false);
    expect(designFromGrid(["RW"], { R: "red_concrete", W: "white_wool" }, "wall").ok).toBe(false);
    expect(designFromGrid(["R"], { RR: "red_concrete" }, "wall").ok).toBe(false);
    expect(designFromGrid(["R"], { ".": "red_concrete" }, "wall").ok).toBe(false);
    expect(designFromGrid(["R"], null, "wall").ok).toBe(false);
    expect(designFromGrid(["R"], ["red_concrete"], "wall").ok).toBe(false);
    expect(designFromGrid(["R".repeat(GRID_LIMITS.maxWidth + 1)], pal, "wall").ok).toBe(false);
    expect(designFromGrid(Array.from({ length: GRID_LIMITS.maxHeight + 1 }, () => "R"), pal, "wall").ok).toBe(false);
    expect(designFromGrid(["..", ".."], pal, "wall").ok).toBe(false);
  });
});

describe("palette.json", () => {
  const require = createRequire(import.meta.url);
  it("covers 16 colours of concrete and wool and 17 terracotta", () => {
    expect(paletteFor("concrete")).toHaveLength(16);
    expect(paletteFor("wool")).toHaveLength(16);
    expect(paletteFor("terracotta")).toHaveLength(17);
    expect(PALETTE_FAMILIES).toHaveLength(3);
  });
  it("every block exists in minecraft-data for the palette's version and is a full solid block", () => {
    const mc = require("minecraft-data")(PALETTE_MC_VERSION) as { blocksByName: Record<string, { boundingBox?: string; name: string }>; itemsByName: Record<string, unknown> };
    for (const fam of PALETTE_FAMILIES) {
      for (const e of paletteFor(fam)) {
        expect(isPaletteBlock(e.block)).toBe(true);
        expect(mc.blocksByName[e.block], e.block).toBeDefined();
        expect(mc.blocksByName[e.block]!.boundingBox, e.block).toBe("block");
        expect(mc.itemsByName[e.block], e.block).toBeDefined();
        expect(e.rgb).toHaveLength(3);
        expect(e.lab[0]).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it("matches the configured server version", async () => {
    const env = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../.env", import.meta.url), "utf8")).catch(() => "");
    const m = /^MC_VERSION=(\S+)/m.exec(env);
    if (m) expect(m[1]).toBe(PALETTE_MC_VERSION);
  });
  it("known texture averages (white / red / blue concrete)", () => {
    const by = (b: string) => paletteFor("concrete").find((e) => e.block === b)!;
    expect(by("white_concrete").rgb).toEqual([207, 213, 214]);
    expect(by("red_concrete").rgb).toEqual([142, 33, 33]);
    expect(by("blue_concrete").rgb).toEqual([45, 47, 143]);
  });
});
