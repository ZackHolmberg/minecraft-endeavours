/** Palette families for pixel art, backed by palette.json (see gen-palette.ts). Pure. */
import { readFileSync } from "node:fs";
import type { Lab, Rgb } from "./color.js";

export type PaletteFamily = "concrete" | "wool" | "terracotta";
export const PALETTE_FAMILIES: readonly PaletteFamily[] = ["concrete", "wool", "terracotta"];

export interface PaletteEntry {
  block: string;
  rgb: Rgb;
  lab: Lab;
}

interface PaletteFile {
  mcVersion: string;
  blocks: Record<string, { rgb: number[]; lab: number[] }>;
}

const file = JSON.parse(readFileSync(new URL("./palette.json", import.meta.url), "utf8")) as PaletteFile;

export const PALETTE_MC_VERSION = file.mcVersion;

const all: PaletteEntry[] = Object.entries(file.blocks).map(([block, v]) => ({ block, rgb: v.rgb as unknown as Rgb, lab: v.lab as unknown as Lab }));
const byName = new Map(all.map((e) => [e.block, e]));

export function familyOf(block: string): PaletteFamily | null {
  if (block.endsWith("_concrete")) return byName.has(block) ? "concrete" : null;
  if (block.endsWith("_wool")) return byName.has(block) ? "wool" : null;
  if (block === "terracotta" || block.endsWith("_terracotta")) return byName.has(block) ? "terracotta" : null;
  return null;
}

export function paletteFor(family: PaletteFamily): PaletteEntry[] {
  return all.filter((e) => familyOf(e.block) === family);
}

/** True for a block name pixel art may place (any palette family). The ONLY blocks a design may contain. */
export const isPaletteBlock = (block: string): boolean => byName.has(block);

export const paletteEntry = (block: string): PaletteEntry | undefined => byName.get(block);

export function parseFamily(v: unknown): PaletteFamily {
  return typeof v === "string" && (PALETTE_FAMILIES as readonly string[]).includes(v) ? (v as PaletteFamily) : "concrete";
}
