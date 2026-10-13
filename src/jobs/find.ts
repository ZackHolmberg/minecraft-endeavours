/**
 * Pure logic of the `find` job (no bot, no I/O): which blocks count as the target, whether it is a surface or an
 * underground search, and which known sighting to go to first. The bot-bound executor is src/jobs/steps/find.ts.
 *
 * `find({ block, action })` = go and locate a block the way a player would: look at what is already known (remembered
 * sightings, then everything in the loaded chunks), else explore (underground targets: a staircase down to the ore's Y band
 * and a branch tunnel; surface targets: a spiral walk), then "point" (stand next to it and say where), "mine" (take it) or
 * "report" (just the coordinates). Works in creative and survival.
 */
import { ORE_BANDS, oreBandForBlock } from "../planner/knowledge/ores.js";
import { isNaturalTerrain } from "../skills/structure-guard.js";
import { isTreeLogName } from "../skills/tree-felling.js";
import type { FindAction } from "./types.js";

/** Never wander further than this (horizontally) from where the find began. */
export const FIND_MAX_FROM_START = 250;
/** Wall-clock cap of the whole job (the runner's hard cap is a little above, for the wind-down). */
export const FIND_MAX_MS = 10 * 60_000;
/** The executor stops searching this long before the cap so a final approach/report still fits. */
export const FIND_SEARCH_MS = 9 * 60_000 + 30_000;
/** Block scan radius over the loaded chunks (buried ore shows up there; the server sends no hidden-ore masking). */
export const FIND_SCAN_RADIUS = 128;
/** "Next to it": the bot stops once the block is within this distance of its body centre (so <= ~4 from its feet). */
export const FIND_ARRIVE = 3.0;
export const FIND_MAX_COUNT = 16;
/** Cost of one block of staircase down relative to one block walked (a stair step takes ~3 s, a walked block ~0.25 s; kept conservative). */
const DIG_DOWN_WEIGHT = 4;

export const FIND_ACTIONS: readonly FindAction[] = ["point", "mine", "report"];

/**
 * `find` with action "mine" runs unattended for up to 10 minutes, so it may only take natural terrain, ores and
 * (unstripped) tree logs: never a chest, furnace, bed, planks... that a player put down (live-polish review M3).
 * `point` / `report` stay open to any block. The per-block structure guard still applies on top of this.
 */
export function isMineableFindTarget(name: string): boolean {
  return isNaturalTerrain(name) || oreBandForBlock(name) !== undefined || isTreeLogName(name);
}

export function mineRefusal(target: { name: string; blocks: readonly string[] }): string | null {
  const bad = target.blocks.find((b) => !isMineableFindTarget(b));
  if (bad === undefined) return null;
  return `I only mine natural blocks (stone, dirt, sand, ores, tree logs) with find, and ${bad} isn't one of those, so I won't break it (it may be something a player built). I can still point it out or report where it is (action point / report).`;
}

export interface FindTarget {
  /** Canonical name as the player means it ("diamond_ore", "oak_log"). */
  name: string;
  /** Every block that counts (stone and deepslate ore variants). */
  blocks: string[];
}

/** Ore item names players say ("diamond", "diamonds", "iron", "lapis") -> the ore band entry. */
function bandByWord(word: string): (typeof ORE_BANDS)[number] | undefined {
  const w = word.toLowerCase().replace(/\s+/g, "_");
  const bare = w.replace(/_ores?$/, "");
  const forms = new Set([w, bare, bare.replace(/s$/, ""), bare.replace(/^raw_/, ""), bare.replace(/^raw_/, "").replace(/s$/, "")]);
  return ORE_BANDS.find((o) => [o.item, o.item.replace(/^raw_/, ""), o.item.replace(/_lazuli$/, "")].some((n) => forms.has(n)));
}

/**
 * Resolve what the player asked for. `known(block)` says whether a block name exists in this Minecraft version.
 * Ores expand to both variants ("diamond" / "diamonds" / "diamond_ore" / "deepslate_diamond_ore" -> both); any other
 * name is used as is. null when nothing matches.
 */
export function resolveFindTarget(input: string, known: (block: string) => boolean): FindTarget | null {
  const raw = input.trim().toLowerCase().replace(/^minecraft:/, "").replace(/[\s-]+/g, "_");
  if (!raw) return null;
  const direct = raw.replace(/^deepslate_/, "");
  const band = oreBandForBlock(raw) ?? oreBandForBlock(direct) ?? bandByWord(raw);
  if (band) {
    const blocks = band.blocks.filter(known);
    if (blocks.length > 0) return { name: band.blocks[0]!, blocks };
  }
  if (known(raw)) return { name: raw, blocks: [raw] };
  return null;
}

export interface FindPlan {
  kind: "underground" | "surface";
  /** Ore Y band to dig down to (underground only). */
  yRange?: [number, number];
}

/**
 * Surface or underground? Ores whose richest layer is at/below Y=40 (iron, gold, diamond, redstone, lapis) are dug for;
 * coal, copper and emerald show on hillsides and mountains, and everything that is not an ore is a surface target.
 */
export function planFind(blocks: readonly string[]): FindPlan {
  const band = blocks.map(oreBandForBlock).find(Boolean);
  if (band && band.best <= 40) return { kind: "underground", yRange: [...band.search] as [number, number] };
  return { kind: "surface" };
}

export interface FindCandidate {
  x: number;
  y: number;
  z: number;
  /** A remembered sighting (world memory) rather than a block seen in the loaded chunks. */
  known?: boolean;
}

export const candKey = (c: { x: number; y: number; z: number }): string => `${c.x},${c.y},${c.z}`;

/**
 * Order candidates by how cheap they are to get to: horizontal walk plus a penalty for every block of digging down,
 * minus a small bonus for remembered sightings. Drops dead (already failed) ones and anything beyond `maxFromStart`
 * horizontally from where the find began.
 */
export function rankFindCandidates(
  cands: readonly FindCandidate[],
  from: { x: number; y: number; z: number },
  start: { x: number; z: number },
  dead: ReadonlySet<string>,
  maxFromStart = FIND_MAX_FROM_START,
): FindCandidate[] {
  const cost = (c: FindCandidate): number => Math.hypot(c.x - from.x, c.z - from.z) + DIG_DOWN_WEIGHT * Math.max(0, from.y - c.y) + 0.5 * Math.max(0, c.y - from.y) - (c.known ? 10 : 0);
  return cands
    .filter((c) => !dead.has(candKey(c)) && Math.hypot(c.x - start.x, c.z - start.z) <= maxFromStart)
    .map((c) => ({ c, k: cost(c) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.c);
}

/** Whole-number "x, y, z" for messages. */
export function fmtPos(p: { x: number; y: number; z: number }): string {
  return `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
}
