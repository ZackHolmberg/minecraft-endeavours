/**
 * The `pixelArt` skill: image (Wikimedia name / pasted URL) or a Haiku-drawn grid → block design → a `pixelart`
 * build job. Haiku picks the source and a few knobs; every coordinate and colour decision is code.
 */
import type { Bot } from "mineflayer";
import { build } from "../jobs/tools.js";
import { inventoryTotals } from "../jobs/world-view.js";
import { getCurrentConversationPartner } from "../orchestrator/chat-router.js";
import { isCreative } from "../skills/game-mode.js";
import type { SkillResult } from "../skills/types.js";
import { convertRaster, countCells, planSize } from "./convert.js";
import { decodeCells, designFromGrid, encodeDesign, parseDesign, type Orientation, type PixelDesign } from "./design.js";
import { validateUrl } from "./netguard.js";
import { parseFamily } from "./palette.js";
import { say } from "../skills/chat.js";
import { creditChatLine } from "./credit.js";
import { loadImage } from "./source.js";

export interface PixelArtParams {
  source: { name?: string; url?: string; grid?: string[]; palette?: Record<string, string> };
  width?: number;
  scale?: number;
  palette?: string;
  orientation?: string;
  at?: "here" | { x: number; y: number; z: number };
  dither?: boolean;
  maxColors?: number;
}

/** Survival can only reach a few rows from the ground (the Builder walks, it does not tower). */
export const SURVIVAL_MAX_WALL_HEIGHT = 4;
export const FETCH_RATE = { perPlayer: 3, windowMs: 10 * 60_000 };

const fetchLog = new Map<string, number[]>();
let gate: Promise<unknown> = Promise.resolve();

/** At most `perPlayer` image fetches per `windowMs` per requester. Returns the seconds to wait, or 0 (and records the fetch). */
export function takeFetchSlot(who: string, now = Date.now()): number {
  const recent = (fetchLog.get(who) ?? []).filter((t) => now - t < FETCH_RATE.windowMs);
  if (recent.length >= FETCH_RATE.perPlayer) {
    fetchLog.set(who, recent);
    return Math.ceil((FETCH_RATE.windowMs - (now - recent[0]!)) / 1000);
  }
  recent.push(now);
  fetchLog.set(who, recent);
  return 0;
}
export const resetFetchLog = (): void => fetchLog.clear();

/** Global concurrency 1 for image fetches. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn, fn);
  gate = run.catch(() => undefined);
  return run;
}

/** Block → count for a design. */
export const designCounts = (d: PixelDesign): Array<{ block: string; count: number }> => countCells(decodeCells(d));

/** Materials a design needs that the inventory doesn't hold: [] when covered. */
export function shortfall(d: PixelDesign, inv: Record<string, number>): Array<{ block: string; need: number; have: number }> {
  return designCounts(d)
    .filter((c) => (inv[c.block] ?? 0) < c.count)
    .map((c) => ({ block: c.block, need: c.count, have: inv[c.block] ?? 0 }));
}

const fail = (message: string): SkillResult => ({ ok: false, message });

export async function pixelArt(bot: Bot, p: PixelArtParams): Promise<SkillResult> {
  const src = p.source ?? {};
  const kinds = [src.name !== undefined, src.url !== undefined, src.grid !== undefined].filter(Boolean).length;
  if (kinds !== 1) return fail("source needs exactly one of: name (an image to look up on Wikimedia, e.g. 'Montreal Canadiens logo'), url (a direct https image link), or grid (+ palette) as a last resort");
  const creative = isCreative(bot);
  const family = parseFamily(p.palette);
  const orientation: Orientation = p.orientation === "flat" ? "flat" : p.orientation === "wall" ? "wall" : creative ? "wall" : "flat";
  const requester = getCurrentConversationPartner(bot.username) ?? "";

  let design: PixelDesign;
  let creditLine: string | null = null;
  if (src.grid !== undefined) {
    const g = designFromGrid(src.grid, src.palette, orientation);
    if (!g.ok) return fail(`can't use that grid: ${g.reason}`);
    design = g.design;
  } else {
    if (src.url !== undefined) {
      const v = validateUrl(src.url);
      if (!v.ok) return fail(`can't use that link: ${v.reason}`);
    } else if (typeof src.name !== "string" || src.name.trim().length < 2) return fail("source.name is empty");
    const wait = takeFetchSlot(requester || bot.username);
    if (wait > 0) return fail(`I've fetched a few images already; try again in about ${Math.ceil(wait / 60)} min, or draw it with a grid`);
    const res = await serialized(() => loadImage({ source: src.url !== undefined ? { url: src.url } : { name: src.name! }, width: p.width, scale: p.scale }));
    if (!res.ok) {
      console.log(`[${bot.username}] pixelArt: ${src.url !== undefined ? "url" : "name"} source failed: ${res.reason}`);
      return fail(`couldn't get that image: ${res.reason}. ${src.url !== undefined ? "Try another link or a name to look up on Wikimedia" : "Try a more specific name, a direct image link from the player, or (last resort) a drawn grid"}.`);
    }
    console.log(`[${bot.username}] pixelArt: ${res.info.from} ${res.info.sourceHost} ${res.bytes} bytes -> ${res.raster.width}x${res.raster.height}`);
    const cells = convertRaster(res.raster, { family, probe: res.probe, ...(p.maxColors !== undefined ? { maxColors: p.maxColors } : {}), dither: p.dither === true });
    design = encodeDesign(cells, { orientation });
    creditLine = creditChatLine(res.info);
  }

  const parsed = parseDesign(design);
  if (!parsed.ok) return fail(`that picture didn't convert: ${parsed.reason}`);
  design = parsed.design;
  const size = planSize(design.w, design.h, design.w, 1);
  if (!size.ok) return fail(size.reason);
  const counts = designCounts(design);
  const total = counts.reduce((a, c) => a + c.count, 0);

  if (!creative) {
    if (design.orientation === "wall" && design.h > SURVIVAL_MAX_WALL_HEIGHT) {
      return fail(`in survival I can't build a ${design.h}-high wall (I can't reach above ~${SURVIVAL_MAX_WALL_HEIGHT} rows). Use orientation:"flat" to lay it on the ground, or a smaller width.`);
    }
    const short = shortfall(design, inventoryTotals(bot.inventory.slots));
    if (short.length > 0) {
      const list = short.map((s) => `${s.block} ${s.have}/${s.need}`).join(", ");
      return fail(`survival: ${family} blocks can't be gathered or crafted by me (concrete needs powder + water, wool needs sheep, terracotta needs clay), and I don't hold enough: ${list}. Ask a player for those blocks, or build it in creative.`);
    }
  }

  const res = await build(bot, { blueprint: "pixelart", params: { design }, ...(p.at ? { at: p.at } : {}) });
  if (!res.ok) return res;
  const colours = counts.map((c) => `${c.block} ${c.count}`).join(", ");
  // The credit is posted by CODE from a fixed template; web text never reaches the model, job events or the prompt.
  let credited = false;
  if (creditLine) {
    try {
      credited = (await say(bot, { message: creditLine })).ok;
    } catch {
      credited = false;
    }
  }
  return {
    ok: true,
    message: `pixel art started: ${design.w}x${design.h} ${design.orientation === "wall" ? "wall" : "flat on the ground"}, ${total} blocks (${colours}).${credited ? " Image credit posted in chat." : ""} ${res.message}`,
    ...(res.state !== undefined ? { state: res.state } : {}),
  };
}
