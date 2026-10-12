/**
 * Pixel-art conversion core (pure: no sharp, no I/O).
 *
 *   planSize        target block grid from the source aspect, `width` and `scale`, with the hard caps
 *   opaqueBounds    bounding box of non-transparent pixels (crop transparent margins before resizing)
 *   convertRaster   resized RGBA → block grid: cap to N dominant colours (k-means in Lab, kills the
 *                   anti-aliasing halo), match each to the nearest block of ONE palette family
 *                   (CIELAB), optional Floyd–Steinberg dither over the capped palette
 */
import { dist2, rgbToLab, type Lab } from "./color.js";
import { paletteFor, type PaletteEntry, type PaletteFamily } from "./palette.js";

export const LIMITS = {
  maxBlocks: 6000,
  maxHeight: 96,
  maxWidth: 128,
  minWidth: 4,
  defaultWidth: 32,
  maxScale: 4,
  defaultColors: 6,
  minColors: 2,
  maxColors: 16,
} as const;

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array | Uint8ClampedArray | Buffer;
}

export type Cells = Array<Array<string | null>>;

export interface Design {
  w: number;
  h: number;
  /** Row 0 = top of the picture. `null` = transparent (nothing is placed). */
  cells: Cells;
}

export type SizePlan = { ok: true; w: number; h: number } | { ok: false; reason: string };

const toInt = (v: unknown, dflt: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : dflt;
};

/** Final grid size: `width` blocks wide (default 32) × `scale` (1..4), height from the aspect ratio. Caps → a reason that tells how to fit. */
export function planSize(srcW: number, srcH: number, width?: unknown, scale?: unknown): SizePlan {
  if (!(srcW > 0) || !(srcH > 0)) return { ok: false, reason: "the image has no size" };
  const base = Math.min(LIMITS.maxWidth, Math.max(LIMITS.minWidth, toInt(width, LIMITS.defaultWidth)));
  const sc = Math.min(LIMITS.maxScale, Math.max(1, toInt(scale, 1)));
  const w = base * sc;
  const h = Math.max(1, Math.round((w * srcH) / srcW));
  if (w > LIMITS.maxWidth || h > LIMITS.maxHeight || w * h > LIMITS.maxBlocks) {
    // the largest width that fits, for the message
    let fit = Math.min(LIMITS.maxWidth, w);
    while (fit > LIMITS.minWidth && (Math.round((fit * srcH) / srcW) > LIMITS.maxHeight || fit * Math.max(1, Math.round((fit * srcH) / srcW)) > LIMITS.maxBlocks)) fit -= 1;
    const per = sc > 1 ? ` (width ${base} x scale ${sc})` : "";
    return { ok: false, reason: `${w}x${h}${per} = ${w * h} blocks is over the cap (max ${LIMITS.maxWidth} wide, ${LIMITS.maxHeight} tall, ${LIMITS.maxBlocks} blocks). For this picture use at most ${fit} blocks wide in total (width x scale)` };
  }
  return { ok: true, w, h };
}

/** Bounding box (inclusive) of pixels with alpha >= `minAlpha`; null when nothing is opaque. */
export function opaqueBounds(r: Raster, minAlpha = 16): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = r.width;
  let y0 = r.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if ((r.data[(y * r.width + x) * 4 + 3] ?? 0) < minAlpha) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

interface Bin {
  lab: Lab;
  w: number;
}

/** Deterministic weighted k-means (farthest-point init) in Lab. Returns the centroids. */
export function dominantColors(bins: Bin[], k: number): Lab[] {
  if (bins.length <= k) return bins.map((b) => b.lab);
  const centers: Lab[] = [bins.reduce((a, b) => (b.w > a.w ? b : a)).lab];
  while (centers.length < k) {
    let best = -1;
    let bi = -1;
    for (let i = 0; i < bins.length; i++) {
      let d = Infinity;
      for (const c of centers) d = Math.min(d, dist2(bins[i]!.lab, c));
      const score = d * bins[i]!.w;
      if (score > best) {
        best = score;
        bi = i;
      }
    }
    if (bi < 0 || best <= 0) break;
    centers.push(bins[bi]!.lab);
  }
  for (let iter = 0; iter < 12; iter++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (const b of bins) {
      let bc = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dist2(b.lab, centers[c]!);
        if (d < bd) {
          bd = d;
          bc = c;
        }
      }
      const s = sum[bc]!;
      s[0]! += b.lab[0] * b.w;
      s[1]! += b.lab[1] * b.w;
      s[2]! += b.lab[2] * b.w;
      s[3]! += b.w;
    }
    let moved = 0;
    for (let c = 0; c < centers.length; c++) {
      const s = sum[c]!;
      if (s[3]! <= 0) continue;
      const n: Lab = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!];
      moved += dist2(n, centers[c]!);
      centers[c] = n;
    }
    if (moved < 0.01) break;
  }
  return centers;
}

const nearest = (lab: Lab, pal: readonly PaletteEntry[]): PaletteEntry => {
  let best = pal[0]!;
  let bd = Infinity;
  for (const e of pal) {
    const d = dist2(lab, e.lab);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
};

/**
 * Histogram of the colours worth keeping: opaque pixels whose neighbours are (nearly) the same colour. Edge pixels are
 * blends of two real colours (the anti-aliasing halo), so they must not vote for a palette entry; if almost nothing
 * is flat (a photo) every pixel votes.
 */
export function sampleBins(r: Raster, cutoff = 128): Bin[] {
  const { width: w, height: h } = r;
  const labs: Array<Lab | null> = new Array(w * h).fill(null);
  let opaque = 0;
  for (let i = 0; i < w * h; i++) {
    if ((r.data[i * 4 + 3] ?? 0) < cutoff) continue;
    labs[i] = rgbToLab([r.data[i * 4]!, r.data[i * 4 + 1]!, r.data[i * 4 + 2]!]);
    opaque += 1;
  }
  const collect = (flatOnly: boolean): { bins: Map<number, Bin>; n: number } => {
    const bins = new Map<number, Bin>();
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const lab = labs[y * w + x];
        if (!lab) continue;
        if (flatOnly) {
          let flat = true;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const o = labs[ny * w + nx];
            if (o && dist2(lab, o) > EDGE_DELTA2) {
              flat = false;
              break;
            }
          }
          if (!flat) continue;
        }
        const i = (y * w + x) * 4;
        const key = ((r.data[i]! >> 3) << 10) | ((r.data[i + 1]! >> 3) << 5) | (r.data[i + 2]! >> 3);
        const e = bins.get(key);
        if (e) e.w += 1;
        else bins.set(key, { lab, w: 1 });
        n += 1;
      }
    }
    return { bins, n };
  };
  const flat = collect(true);
  if (flat.n >= Math.max(8, opaque * 0.05)) return [...flat.bins.values()];
  return [...collect(false).bins.values()];
}

/** Squared ΔE between neighbours above which a pixel counts as an edge (ΔE 6). */
const EDGE_DELTA2 = 36;

export interface ConvertOptions {
  family?: PaletteFamily;
  /** Dominant colours kept (2..16, default 6). */
  maxColors?: number;
  /** Floyd–Steinberg over the capped palette (photos); off for flat logos. */
  dither?: boolean;
  /** Alpha below this is transparent (null cell). */
  alphaCutoff?: number;
  /** Higher-resolution copy of the same picture: the dominant colours are chosen from it (edges are a smaller share there). */
  probe?: Raster;
}

export function convertRaster(r: Raster, opts: ConvertOptions = {}): Design {
  const family = opts.family ?? "concrete";
  const k = Math.min(LIMITS.maxColors, Math.max(LIMITS.minColors, toInt(opts.maxColors, LIMITS.defaultColors)));
  const cutoff = opts.alphaCutoff ?? 128;
  const pal = paletteFor(family);
  if (pal.length === 0) throw new Error(`empty palette family ${family}`);
  const { width: w, height: h } = r;
  if (r.data.length < w * h * 4) throw new Error("raster buffer too small");

  const labs: Array<Lab | null> = new Array(w * h).fill(null);
  for (let i = 0; i < w * h; i++) {
    if ((r.data[i * 4 + 3] ?? 0) < cutoff) continue;
    labs[i] = rgbToLab([r.data[i * 4]!, r.data[i * 4 + 1]!, r.data[i * 4 + 2]!]);
  }
  const bins = sampleBins(opts.probe ?? r, cutoff);

  // 1. cap to the dominant colours, 2. map each to its nearest block of the family (dedup)
  const centres = dominantColors(bins, k);
  const used = new Map<string, PaletteEntry>();
  for (const c of centres) {
    const e = nearest(c, pal);
    used.set(e.block, e);
  }
  const capped = [...used.values()];

  const cells: Cells = Array.from({ length: h }, () => new Array<string | null>(w).fill(null));
  if (!opts.dither) {
    for (let i = 0; i < w * h; i++) {
      const lab = labs[i];
      if (lab) cells[Math.floor(i / w)]![i % w] = nearest(lab, capped).block;
    }
  } else {
    const err = new Float64Array(w * h * 3);
    const diffuse = (x: number, y: number, e: readonly number[], f: number): void => {
      if (x < 0 || x >= w || y >= h) return;
      const j = (y * w + x) * 3;
      err[j]! += e[0]! * f;
      err[j + 1]! += e[1]! * f;
      err[j + 2]! += e[2]! * f;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const lab = labs[i];
        if (!lab) continue;
        const j = i * 3;
        const want: Lab = [lab[0] + err[j]!, lab[1] + err[j + 1]!, lab[2] + err[j + 2]!];
        const pick = nearest(want, capped);
        cells[y]![x] = pick.block;
        const e = [want[0] - pick.lab[0], want[1] - pick.lab[1], want[2] - pick.lab[2]];
        diffuse(x + 1, y, e, 7 / 16);
        diffuse(x - 1, y + 1, e, 3 / 16);
        diffuse(x, y + 1, e, 5 / 16);
        diffuse(x + 1, y + 1, e, 1 / 16);
      }
    }
  }
  return { w, h, cells };
}

/** Blocks used and their counts, most frequent first. */
export function countCells(cells: Cells): Array<{ block: string; count: number }> {
  const m = new Map<string, number>();
  for (const row of cells) for (const b of row) if (b) m.set(b, (m.get(b) ?? 0) + 1);
  return [...m.entries()].map(([block, count]) => ({ block, count })).sort((a, b) => b.count - a.count || a.block.localeCompare(b.block));
}
