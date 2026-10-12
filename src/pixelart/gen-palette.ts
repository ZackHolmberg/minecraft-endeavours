/**
 * Dev-time script: regenerate src/pixelart/palette.json.
 *
 *   npx tsx src/pixelart/gen-palette.ts [--assets <dir>] [--version 1.21.9]
 *
 * Averages the opaque pixels of each block texture of the concrete, wool and terracotta
 * families (PrismarineJS/minecraft-assets `data/<version>/blocks/<name>.png`) and writes ONLY the
 * numbers: { block: { rgb, lab } }. No texture is stored in the repository.
 *   --assets <dir>  read <dir>/<name>.png instead of fetching from raw.githubusercontent.com
 * Not run at bot runtime.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { rgbToLab, type Rgb } from "./color.js";

const COLORS = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];
const NAMES = [...COLORS.flatMap((c) => [`${c}_concrete`, `${c}_wool`, `${c}_terracotta`]), "terracotta"];

const args = process.argv.slice(2);
const opt = (k: string): string | undefined => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const version = opt("--version") ?? "1.21.9";
const assets = opt("--assets");

async function texture(name: string): Promise<Buffer> {
  if (assets) return readFileSync(join(assets, `${name}.png`));
  const url = `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/${version}/blocks/${name}.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function average(png: Buffer): Promise<Rgb> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if ((data[i * 4 + 3] ?? 0) < 128) continue;
    r += data[i * 4]!;
    g += data[i * 4 + 1]!;
    b += data[i * 4 + 2]!;
    n += 1;
  }
  if (n === 0) throw new Error("fully transparent texture");
  return [r / n, g / n, b / n];
}

const out: Record<string, { rgb: number[]; lab: number[] }> = {};
for (const name of NAMES) {
  const rgb = await average(await texture(name));
  out[name] = { rgb: rgb.map((v) => Math.round(v)), lab: rgbToLab(rgb).map((v) => Math.round(v * 100) / 100) };
}
const file = {
  _comment: `Average colour of each block's ${version} texture (opaque pixels, sRGB mean) for pixel art. Numbers only, derived at dev time by src/pixelart/gen-palette.ts from PrismarineJS/minecraft-assets; no textures are stored. lab = CIELAB D65.`,
  mcVersion: version,
  blocks: out,
};
const lines = Object.entries(out).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
const text = `{\n "_comment": ${JSON.stringify(file._comment)},\n "mcVersion": ${JSON.stringify(version)},\n "blocks": {\n${lines.join(",\n")}\n }\n}\n`;
writeFileSync(new URL("./palette.json", import.meta.url), text);
console.log(`wrote ${Object.keys(out).length} blocks`);
