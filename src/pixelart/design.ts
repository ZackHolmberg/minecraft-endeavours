/**
 * The persisted pixel-art design: what the job state (job.json) stores and the `pixelart` blueprint builds from.
 * Compact (palette + row strings) and strictly validated, because it round-trips through disk and because the
 * Haiku-drawn grid fallback produces one too: only blocks of the palette families can ever appear in it.
 */
import { LIMITS, countCells, type Cells, type Design } from "./convert.js";
import { familyOf, isPaletteBlock, parseFamily, type PaletteFamily } from "./palette.js";

export type Orientation = "wall" | "flat";

export interface PixelDesign {
  v: 1;
  orientation: Orientation;
  w: number;
  h: number;
  /** Palette index → block name. */
  blocks: string[];
  /** h rows of w chars, top row first: "." = nothing, otherwise an index into `blocks` (0-9, A-Z, a-z). */
  rows: string[];
  /** Provenance for the reply / telemetry. */
  title?: string;
  credit?: string;
}

const SYMBOLS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const EMPTY = ".";

/**
 * Text from the web (file titles, licences, credits) ends up in prompts and in chat: keep letters, digits and plain
 * punctuation only, collapse whitespace, cap the length. (Control characters, markup, brackets and newlines go.)
 */
export function plainText(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} .,;:'’()&/_+!?-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}
const clean = plainText;

export function encodeDesign(d: Design, meta: { orientation: Orientation; title?: string; credit?: string }): PixelDesign {
  const blocks = countCells(d.cells).map((c) => c.block);
  const idx = new Map(blocks.map((b, i) => [b, SYMBOLS[i]!]));
  const rows = d.cells.map((row) => row.map((b) => (b ? idx.get(b)! : EMPTY)).join(""));
  const title = clean(meta.title, 120);
  const credit = clean(meta.credit, 200);
  return { v: 1, orientation: meta.orientation, w: d.w, h: d.h, blocks, rows, ...(title ? { title } : {}), ...(credit ? { credit } : {}) };
}

export function decodeCells(d: PixelDesign): Cells {
  return d.rows.map((row) => [...row].map((ch) => (ch === EMPTY ? null : d.blocks[SYMBOLS.indexOf(ch)]!)));
}

/** Strict validation of an untrusted/persisted design. */
export function parseDesign(raw: unknown): { ok: true; design: PixelDesign } | { ok: false; reason: string } {
  const r = raw as Partial<PixelDesign> | null;
  if (!r || typeof r !== "object") return { ok: false, reason: "no pixel-art design" };
  const { w, h, blocks, rows } = r;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w! < 1 || h! < 1) return { ok: false, reason: "bad design size" };
  if (w! > LIMITS.maxWidth || h! > LIMITS.maxHeight || w! * h! > LIMITS.maxBlocks) return { ok: false, reason: `design too big (max ${LIMITS.maxWidth} wide, ${LIMITS.maxHeight} tall, ${LIMITS.maxBlocks} blocks)` };
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > LIMITS.maxColors || blocks.some((b) => typeof b !== "string" || !isPaletteBlock(b))) {
    return { ok: false, reason: "the design uses a block that isn't a concrete / wool / terracotta colour" };
  }
  if (new Set(blocks).size !== blocks.length) return { ok: false, reason: "duplicate palette entries" };
  if (new Set((blocks as string[]).map((b) => familyOf(b))).size !== 1) return { ok: false, reason: "mixed palette families (use one of concrete, wool, terracotta)" };
  if (!Array.isArray(rows) || rows.length !== h) return { ok: false, reason: "design rows don't match its height" };
  for (const row of rows) {
    if (typeof row !== "string" || row.length !== w) return { ok: false, reason: "design rows aren't all the same width" };
    for (const ch of row) {
      if (ch === EMPTY) continue;
      const i = SYMBOLS.indexOf(ch);
      if (i < 0 || i >= blocks.length) return { ok: false, reason: `unknown symbol "${ch}" in the design` };
    }
  }
  const orientation: Orientation = r.orientation === "flat" ? "flat" : "wall";
  const title = clean(r.title, 120);
  const credit = clean(r.credit, 200);
  const design: PixelDesign = { v: 1, orientation, w: w!, h: h!, blocks: [...(blocks as string[])], rows: [...(rows as string[])], ...(title ? { title } : {}), ...(credit ? { credit } : {}) };
  if (design.rows.every((row) => row === EMPTY.repeat(design.w))) return { ok: false, reason: "the design is empty" };
  return { ok: true, design };
}

export function designFamily(d: PixelDesign): PaletteFamily {
  return familyOf(d.blocks[0]!) ?? parseFamily(undefined);
}

export function placedCount(d: PixelDesign): number {
  let n = 0;
  for (const row of d.rows) for (const ch of row) if (ch !== EMPTY) n += 1;
  return n;
}

// ── Haiku-drawn grid fallback ──────────────────────────────────────────────

export const GRID_LIMITS = { maxWidth: 48, maxHeight: 48 } as const;

/** Validate a hand-drawn grid: rows of equal width, every symbol mapped to a palette block, size-capped. `.` and space = empty. */
export function designFromGrid(grid: unknown, palette: unknown, orientation: Orientation): { ok: true; design: PixelDesign } | { ok: false; reason: string } {
  if (!Array.isArray(grid) || grid.length === 0 || grid.some((r) => typeof r !== "string")) return { ok: false, reason: "grid must be a list of strings (one per row)" };
  if (!palette || typeof palette !== "object" || Array.isArray(palette)) return { ok: false, reason: "palette must map a character to a block name" };
  const rows = grid as string[];
  const h = rows.length;
  const w = rows[0]!.length;
  if (w < 1 || h < 1 || w > GRID_LIMITS.maxWidth || h > GRID_LIMITS.maxHeight) return { ok: false, reason: `a drawn grid can be at most ${GRID_LIMITS.maxWidth}x${GRID_LIMITS.maxHeight} (got ${w}x${h})` };
  if (rows.some((r) => r.length !== w)) return { ok: false, reason: "every grid row must have the same width" };
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(palette as Record<string, unknown>)) {
    if ([...k].length !== 1 || k === EMPTY || k === " ") return { ok: false, reason: `palette key "${k}" must be one character (not "." or space)` };
    const block = typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, "_") : "";
    if (!isPaletteBlock(block)) return { ok: false, reason: `palette block "${String(v).slice(0, 40)}" isn't allowed; use a colour of concrete, wool or terracotta (e.g. red_concrete)` };
    map.set(k, block);
  }
  const cells: Cells = [];
  for (const row of rows) {
    const out: Array<string | null> = [];
    for (const ch of row) {
      if (ch === EMPTY || ch === " ") out.push(null);
      else {
        const b = map.get(ch);
        if (!b) return { ok: false, reason: `grid character "${ch}" isn't in the palette` };
        out.push(b);
      }
    }
    cells.push(out);
  }
  const used = countCells(cells);
  if (used.length === 0) return { ok: false, reason: "the grid is empty" };
  const enc = encodeDesign({ w, h, cells }, { orientation, title: "hand-drawn grid" });
  return parseDesign(enc);
}
