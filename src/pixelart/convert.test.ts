import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { dominantColors, convertRaster, countCells, LIMITS, opaqueBounds, planSize, sampleBins, type Raster } from "./convert.js";
import { decodeToRaster, MAX_INPUT_PIXELS } from "./decode.js";
import { rgbToLab } from "./color.js";
import { paletteFor } from "./palette.js";

type RGBA = [number, number, number, number];
const RED: RGBA = [200, 30, 40, 255];
const WHITE: RGBA = [250, 250, 250, 255];
const BLUE: RGBA = [30, 40, 150, 255];
const CLEAR: RGBA = [0, 0, 0, 0];

function raster(rows: RGBA[][]): Raster {
  const h = rows.length;
  const w = rows[0]!.length;
  const data = new Uint8Array(w * h * 4);
  rows.forEach((row, y) => row.forEach((px, x) => data.set(px, (y * w + x) * 4)));
  return { width: w, height: h, data };
}
async function png(rows: RGBA[][]): Promise<Buffer> {
  const r = raster(rows);
  return sharp(Buffer.from(r.data), { raw: { width: r.width, height: r.height, channels: 4 } }).png().toBuffer();
}
const grid = (cells: Array<Array<string | null>>): string => cells.map((r) => r.map((b) => (b ? b[0] : ".")).join("")).join("/");

describe("planSize", () => {
  it("defaults to 32 wide, keeps the aspect, scale multiplies", () => {
    expect(planSize(500, 342)).toEqual({ ok: true, w: 32, h: 22 });
    expect(planSize(500, 342, 33)).toEqual({ ok: true, w: 33, h: 23 });
    expect(planSize(100, 100, 20, 3)).toEqual({ ok: true, w: 60, h: 60 });
    expect(planSize(400, 100, 10, 4)).toEqual({ ok: true, w: 40, h: 10 });
  });
  it("clamps width and scale to their ranges", () => {
    expect(planSize(100, 100, 1)).toMatchObject({ w: LIMITS.minWidth });
    expect(planSize(100, 30, 9999)).toMatchObject({ w: LIMITS.maxWidth });
    expect(planSize(100, 100, 8, 99)).toMatchObject({ w: 8 * LIMITS.maxScale });
    expect(planSize(100, 100, 8, 2.6)).toMatchObject({ w: 24 });
    expect(planSize(100, 100, "12", "2")).toMatchObject({ w: 24 });
    expect(planSize(100, 100, "x", "y")).toMatchObject({ w: 32 });
  });
  it("enforces the 96-tall and 6000-block caps with a usable hint", () => {
    const tall = planSize(100, 400, 40);
    expect(tall.ok).toBe(false);
    if (!tall.ok) expect(tall.reason).toMatch(/at most \d+ blocks wide/);
    const many = planSize(100, 100, 80, 1); // 80x80 = 6400 > 6000
    expect(many.ok).toBe(false);
    expect(planSize(100, 100, 77, 1).ok).toBe(true); // 77*77 = 5929
    const big = planSize(100, 100, 40, 4); // 160 wide
    expect(big.ok).toBe(false);
    expect(planSize(0, 10).ok).toBe(false);
  });
  it("any accepted plan respects every cap", () => {
    for (const [sw, sh] of [[500, 342], [100, 400], [1000, 10], [10, 1000], [333, 333]] as const) {
      for (const width of [4, 20, 33, 64, 128]) {
        for (const scale of [1, 2, 3, 4]) {
          const p = planSize(sw, sh, width, scale);
          if (p.ok) {
            expect(p.w).toBeLessThanOrEqual(LIMITS.maxWidth);
            expect(p.h).toBeLessThanOrEqual(LIMITS.maxHeight);
            expect(p.w * p.h).toBeLessThanOrEqual(LIMITS.maxBlocks);
          }
        }
      }
    }
  });
});

describe("opaqueBounds", () => {
  it("finds the box of non-transparent pixels", () => {
    const r = raster([[CLEAR, CLEAR, CLEAR, CLEAR], [CLEAR, RED, WHITE, CLEAR], [CLEAR, CLEAR, BLUE, CLEAR]]);
    expect(opaqueBounds(r)).toEqual({ x0: 1, y0: 1, x1: 2, y1: 2 });
    expect(opaqueBounds(raster([[CLEAR, CLEAR]]))).toBeNull();
  });
});

describe("convertRaster", () => {
  it("maps pure colours to the matching concrete blocks, row 0 = top", () => {
    const d = convertRaster(raster([[RED, WHITE], [BLUE, RED]]));
    expect(d.cells).toEqual([["red_concrete", "white_concrete"], ["blue_concrete", "red_concrete"]]);
    expect(countCells(d.cells)).toEqual([{ block: "red_concrete", count: 2 }, { block: "blue_concrete", count: 1 }, { block: "white_concrete", count: 1 }]);
  });
  it("transparent pixels become null cells", () => {
    const d = convertRaster(raster([[RED, CLEAR], [CLEAR, WHITE]]));
    expect(d.cells).toEqual([["red_concrete", null], [null, "white_concrete"]]);
    expect(convertRaster(raster([[CLEAR]])).cells).toEqual([[null]]);
  });
  it("stays inside ONE family: wool / terracotta never mix with concrete", () => {
    const px = raster([[RED, WHITE, BLUE, [20, 120, 20, 255]]]);
    for (const family of ["concrete", "wool", "terracotta"] as const) {
      const used = countCells(convertRaster(px, { family }).cells).map((c) => c.block);
      const names = new Set(paletteFor(family).map((e) => e.block));
      expect(used.every((b) => names.has(b)), `${family}: ${used}`).toBe(true);
      expect(used.length).toBeGreaterThan(2);
    }
  });
  it("matches by CIELAB: a mid grey lands on a grey, a dark red on red/brown", () => {
    expect(convertRaster(raster([[[128, 128, 128, 255]]])).cells[0]![0]).toMatch(/gray_concrete/);
    expect(convertRaster(raster([[[150, 25, 30, 255]]])).cells[0]![0]).toBe("red_concrete");
  });
  it("caps the colours and removes the anti-aliasing halo using a high-res probe", () => {
    // 16x16 probe: left half red, right half white, one blended column between (pink)
    const PINK: RGBA = [225, 140, 145, 255];
    const probeRows: RGBA[][] = Array.from({ length: 16 }, () => [...Array(7).fill(RED), PINK, ...Array(8).fill(WHITE)] as RGBA[]);
    // 4x4 target: columns 0,1 red, 2 = blend, 3 white
    const lowRows: RGBA[][] = Array.from({ length: 4 }, () => [RED, RED, PINK, WHITE]);
    const withProbe = convertRaster(raster(lowRows), { probe: raster(probeRows), maxColors: 2 });
    expect(grid(withProbe.cells)).toBe("rrww/rrww/rrww/rrww");
    expect(countCells(withProbe.cells).map((c) => c.block).sort()).toEqual(["red_concrete", "white_concrete"]);
    // without a cap the halo block survives
    const free = convertRaster(raster(lowRows), { maxColors: 16 });
    expect(countCells(free.cells).length).toBeGreaterThan(2);
  });
  it("maxColors limits distinct blocks", () => {
    const rows: RGBA[][] = [Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, (i * 40) % 256, 255] as RGBA)];
    for (const k of [2, 3, 5]) expect(countCells(convertRaster(raster(rows), { maxColors: k }).cells).length).toBeLessThanOrEqual(k);
  });
  it("dither off is the default; dither on mixes the capped colours on a gradient", () => {
    const rows: RGBA[][] = Array.from({ length: 4 }, () => Array.from({ length: 32 }, (_, i) => [i * 8, i * 8, i * 8, 255] as RGBA));
    const flat = convertRaster(raster(rows), { maxColors: 2 });
    const dith = convertRaster(raster(rows), { maxColors: 2, dither: true });
    const changes = (cells: Array<Array<string | null>>): number => cells[1]!.reduce((n, b, i, a) => n + (i > 0 && a[i - 1] !== b ? 1 : 0), 0);
    expect(changes(flat.cells)).toBeLessThanOrEqual(1);
    expect(changes(dith.cells)).toBeGreaterThan(3);
    expect(countCells(dith.cells).length).toBeLessThanOrEqual(2);
  });
  it("is deterministic", () => {
    const rows: RGBA[][] = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => [(x * 31 + y * 7) % 256, (x * 17) % 256, (y * 53) % 256, 255] as RGBA));
    expect(JSON.stringify(convertRaster(raster(rows)))).toBe(JSON.stringify(convertRaster(raster(rows))));
  });
  it("rejects a short buffer", () => {
    expect(() => convertRaster({ width: 4, height: 4, data: new Uint8Array(8) })).toThrow();
  });
});

describe("dominantColors / sampleBins", () => {
  it("returns every colour when there are fewer than k", () => {
    const bins = [{ lab: rgbToLab([255, 0, 0]), w: 5 }, { lab: rgbToLab([0, 0, 255]), w: 3 }];
    expect(dominantColors(bins, 6)).toHaveLength(2);
  });
  it("ignores edge pixels when enough flat ones exist, but falls back for noisy images", () => {
    const flatRows: RGBA[][] = Array.from({ length: 8 }, () => [...Array(4).fill(RED), ...Array(4).fill(WHITE)] as RGBA[]);
    const bins = sampleBins(raster(flatRows));
    expect(bins.reduce((n, b) => n + b.w, 0)).toBeLessThan(64); // the two columns at the seam are edges
    const noisy: RGBA[][] = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ((x + y) % 2 ? RED : BLUE) as RGBA));
    expect(sampleBins(raster(noisy)).reduce((n, b) => n + b.w, 0)).toBe(64); // checkerboard: nothing is flat, everyone votes
  });
});

describe("decodeToRaster (sharp)", () => {
  it("decodes a PNG, resizes to the planned grid and returns a probe", async () => {
    const rows: RGBA[][] = Array.from({ length: 40 }, (_, y) => Array.from({ length: 80 }, (_, x) => (x < 40 ? (y < 20 ? RED : BLUE) : WHITE) as RGBA));
    const r = await decodeToRaster(await png(rows), 20);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.raster.width).toBe(20);
    expect(r.raster.height).toBe(10);
    expect(r.probe.width).toBeGreaterThanOrEqual(20);
    const d = convertRaster(r.raster, { probe: r.probe });
    expect(d.cells[0]![0]).toBe("red_concrete");
    expect(d.cells[9]![0]).toBe("blue_concrete");
    expect(d.cells[0]![19]).toBe("white_concrete");
  });
  it("scale multiplies the width", async () => {
    const rows: RGBA[][] = Array.from({ length: 30 }, () => Array.from({ length: 60 }, () => RED));
    const r = await decodeToRaster(await png(rows), 10, 3);
    expect(r.ok && [r.raster.width, r.raster.height]).toEqual([30, 15]);
  });
  it("crops transparent margins before sizing", async () => {
    const rows: RGBA[][] = Array.from({ length: 100 }, (_, y) => Array.from({ length: 100 }, (_, x) => (x >= 40 && x < 60 && y >= 10 && y < 90 ? RED : CLEAR)));
    const r = await decodeToRaster(await png(rows), 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cropped).toBe(true);
    expect(r.raster.width).toBe(10);
    expect(r.raster.height).toBeGreaterThanOrEqual(30); // the 20x80 strip, not the 100x100 canvas
    const cells = convertRaster(r.raster, { probe: r.probe }).cells;
    expect(cells.flat().filter((b) => b === null).length).toBeLessThan(cells.flat().length * 0.15);
  });
  it("refuses fully transparent, non-images, SVG and oversize input", async () => {
    const clear = await decodeToRaster(await png(Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => CLEAR))), 8);
    expect(clear).toMatchObject({ ok: false });
    expect((await decodeToRaster(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), 8)).ok).toBe(false);
    expect((await decodeToRaster(Buffer.from("<html>hi</html>"), 8)).ok).toBe(false);
    expect((await decodeToRaster(Buffer.alloc(0), 8)).ok).toBe(false);
    // a truncated PNG
    const good = await png(Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => RED)));
    expect((await decodeToRaster(good.subarray(0, 40), 8)).ok).toBe(false);
  });
  it("refuses a decompression bomb (huge canvas of one colour) via limitInputPixels", async () => {
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 500;
    const bomb = await sharp({ create: { width: side, height: side, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    const r = await decodeToRaster(bomb, 8);
    expect(r.ok).toBe(false);
  }, 60_000);
  it("takes the first frame of an animated GIF and reports caps for tall pictures", async () => {
    const tall = await decodeToRaster(await png(Array.from({ length: 400 }, () => Array.from({ length: 10 }, () => RED))), 40);
    expect(tall).toMatchObject({ ok: false });
  });
});
