/**
 * Finds concrete scenario sites in the fixed-seed test world and records them
 * in src/eval/sites.json (committed). Run once per seed:
 *   npx tsx src/eval/scout.ts [--only forest,plains,...]
 * Uses RCON `locate` for candidates and the Tester to read terrain. Visiting a
 * site generates its chunks, so run this BEFORE `world.ts snapshot`.
 * Site coordinates are the *standing* position (feet y = surface + 1).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { SITES_PATH, makeRcon, sleep, testServerEnv } from "./env.js";
import type { Rcon } from "./rcon.js";
import { Tester } from "./tester.js";
import type { SiteName, Vec3 } from "./types.js";

export interface SiteRecord extends Vec3 {
  note: string;
  /** cave only: an underground air pocket next to exposed ore. */
  underground?: Vec3;
}
export interface SitesFile {
  seed: string;
  scoutedAt: string;
  sites: Partial<Record<SiteName, SiteRecord>>;
}

export function loadSites(): SitesFile {
  if (!existsSync(SITES_PATH)) throw new Error("src/eval/sites.json missing; run src/eval/scout.ts");
  return JSON.parse(readFileSync(SITES_PATH, "utf8")) as SitesFile;
}

const MIN_SEPARATION = 160;
const ORIGINS: Array<[number, number]> = [
  [0, 0], [900, 0], [-900, 0], [0, 900], [0, -900], [900, 900], [-900, -900], [900, -900], [-900, 900],
  [1800, 0], [-1800, 0], [0, 1800], [0, -1800],
];

const dist2d = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

interface Ctx {
  rcon: Rcon;
  t: Tester;
}

async function locate(c: Ctx, kind: "biome" | "structure", id: string, from: [number, number]): Promise<{ x: number; z: number } | null> {
  const out = await c.rcon.command(`execute positioned ${from[0]} 64 ${from[1]} run locate ${kind} ${id}`);
  const m = /\[(-?\d+), (~|-?\d+), (-?\d+)\]/.exec(out);
  return m ? { x: Number(m[1]), z: Number(m[3]) } : null;
}

async function candidates(c: Ctx, kind: "biome" | "structure", ids: string[]): Promise<Array<{ x: number; z: number }>> {
  const out: Array<{ x: number; z: number }> = [];
  for (const id of ids)
    for (const o of ORIGINS) {
      const p = await locate(c, kind, id, o);
      if (p && !out.some((q) => dist2d(p, q) < 100)) out.push(p);
    }
  out.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  return out;
}

/** Park the Tester over (x,z) and wait until the whole ±r square has loaded chunks. */
async function visit(c: Ctx, x: number, z: number, r = 64): Promise<boolean> {
  await c.rcon.command(`tp Tester ${x} 200 ${z}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    await sleep(1500);
    // Keep Tester airborne-safe: re-tp up if it has fallen to the ground early.
    const ok = [[-r, -r], [r, r], [-r, r], [r, -r], [0, 0]].every(([dx, dz]) => c.t.surfaceY(x + dx!, z + dz!) !== null);
    if (ok) return true;
  }
  return false;
}

interface Col {
  y: number;
  name: string;
}
function column(c: Ctx, x: number, z: number): Col | null {
  const y = c.t.surfaceY(x, z);
  if (y === null) return null;
  return { y, name: c.t.blockNameAt({ x, y, z }) ?? "?" };
}

const OPEN_ABOVE = (c: Ctx, x: number, y: number, z: number, h = 3) => {
  for (let i = 1; i <= h; i++) {
    const n = c.t.blockNameAt({ x, y: y + i, z });
    if (n === null) return false;
    if (n !== "air" && !/grass|fern|flower|poppy|dandelion|tulip|cornflower|daisy|azure|allium|orchid|bush|rose|peony|lilac|snow/.test(n)) return false;
  }
  return true;
};

type Scorer = (c: Ctx, cx: number, cz: number) => Promise<{ score: number; site: SiteRecord } | null>;

/** Best flat, open, grassy 24x24 window around a located point. */
const makeFlatScorer = (maxRange: number, minGrass: number, maxBad: number): Scorer => async (c, cx, cz) => {
  const W = 24;
  // coarse heightmap step 2 over ±56
  const R = 56;
  const H = new Map<string, Col>();
  for (let x = cx - R; x <= cx + R; x += 2)
    for (let z = cz - R; z <= cz + R; z += 2) {
      const col = column(c, x, z);
      if (col) H.set(`${x},${z}`, col);
    }
  let best: { score: number; x: number; z: number } | null = null;
  for (let x0 = cx - R; x0 <= cx + R - W; x0 += 4)
    for (let z0 = cz - R; z0 <= cz + R - W; z0 += 4) {
      let min = 999, max = -999, grass = 0, n = 0;
      for (let x = x0; x <= x0 + W; x += 2)
        for (let z = z0; z <= z0 + W; z += 2) {
          const col = H.get(`${x},${z}`);
          if (!col) { n = -1e9; continue; }
          n++;
          min = Math.min(min, col.y);
          max = Math.max(max, col.y);
          if (col.name === "grass_block") grass++;
        }
      if (n <= 0 || max - min > maxRange || grass / n < minGrass) continue;
      // Prefer being close to the located point (inside the biome core).
      const score = grass / n - Math.hypot(x0 + W / 2 - cx, z0 + W / 2 - cz) / 400;
      if (!best || score > best.score) best = { score, x: x0 + W / 2, z: z0 + W / 2 };
    }
  if (!best) return null;
  // Exact verification at step 1 (full 24x24) around the chosen center.
  const sx = Math.round(best.x), sz = Math.round(best.z);
  let min = 999, max = -999, bad = 0;
  for (let x = sx - 12; x <= sx + 12; x++)
    for (let z = sz - 12; z <= sz + 12; z++) {
      const col = column(c, x, z);
      if (!col) return null;
      min = Math.min(min, col.y);
      max = Math.max(max, col.y);
      if (col.name !== "grass_block" || !OPEN_ABOVE(c, x, col.y, z, 4)) bad++;
    }
  if (max - min > maxRange || bad > maxBad) return null;
  const y = column(c, sx, sz)!.y + 1;
  return { score: best.score, site: { x: sx, y, z: sz, note: `flat grass 25x25, height range ${max - min}, ${bad} non-clear columns` } };
};

const flatScorer = makeFlatScorer(1, 0.9, 20);
/** Looser: scenarios flatten their own build pad (helpers.flattenPad), so mild slopes are fine. */
const flatScorerLoose = makeFlatScorer(3, 0.75, 120);

const forestScorer: Scorer = async (c, cx, cz) => {
  const R = 40;
  const trunks: Array<{ x: number; z: number }> = [];
  const info = new Map<string, Col>();
  for (let x = cx - R; x <= cx + R; x++)
    for (let z = cz - R; z <= cz + R; z++) {
      const col = column(c, x, z);
      if (!col) return null;
      info.set(`${x},${z}`, col);
      if (/_log$/.test(c.t.blockNameAt({ x, y: col.y + 1, z }) ?? "")) trunks.push({ x, z });
    }
  let best: { n: number; x: number; z: number } | null = null;
  for (let x = cx - R + 10; x <= cx + R - 10; x += 2)
    for (let z = cz - R + 10; z <= cz + R - 10; z += 2) {
      const col = info.get(`${x},${z}`)!;
      if (!OPEN_ABOVE(c, x, col.y, z, 3) || /water|lava/.test(c.t.blockNameAt({ x, y: col.y, z }) ?? "")) continue;
      const n = trunks.filter((t) => Math.hypot(t.x - x, t.z - z) <= 10).length;
      if (!best || n > best.n) best = { n, x, z };
    }
  if (!best || best.n < 10) return null;
  const y = info.get(`${best.x},${best.z}`)!.y + 1;
  return { score: best.n, site: { x: best.x, y, z: best.z, note: `${best.n} tree trunks within 10 blocks` } };
};

const hillsScorer: Scorer = async (c, cx, cz) => {
  const R = 14;
  let min = 999, max = -999, water = 0, tot = 0;
  let sx = cx, sz = cz, sy = -999;
  for (let x = cx - R; x <= cx + R; x += 2)
    for (let z = cz - R; z <= cz + R; z += 2) {
      const col = column(c, x, z);
      if (!col) return null;
      tot++;
      if (/water|ice/.test(col.name)) water++;
      min = Math.min(min, col.y);
      max = Math.max(max, col.y);
      if (col.y > sy && OPEN_ABOVE(c, x, col.y, z, 3) && !/leaves|water/.test(col.name)) { sy = col.y; sx = x; sz = z; }
    }
  // want relief but a walkable (not sheer) spot: choose a mid-height open cell
  const range = max - min;
  if (range < 10 || water / tot > 0.1) return null;
  const mid = (min + max) >> 1;
  let pick: { x: number; z: number; y: number } | null = null;
  for (let x = cx - R; x <= cx + R; x++)
    for (let z = cz - R; z <= cz + R; z++) {
      const col = column(c, x, z);
      if (!col || !OPEN_ABOVE(c, x, col.y, z, 3) || /leaves|water/.test(col.name)) continue;
      if (!pick || Math.abs(col.y - mid) < Math.abs(pick.y - mid)) pick = { x, z, y: col.y };
    }
  if (!pick) return null;
  return { score: range, site: { x: pick.x, y: pick.y + 1, z: pick.z, note: `relief ${range} blocks (y ${min}..${max}) within 14 blocks` } };
};

const caveScorer: Scorer = async (c, cx, cz) => {
  const R = 22;
  const surf = column(c, cx, cz);
  if (!surf || /water|leaves|ice/.test(surf.name)) return null;
  let ores = 0, pockets = 0;
  let under: Vec3 | null = null;
  const isAir = (n: string | null) => n === "air" || n === "cave_air";
  for (let x = cx - R; x <= cx + R; x += 1)
    for (let z = cz - R; z <= cz + R; z += 1) {
      const col = column(c, x, z);
      if (!col) return null;
      for (let y = Math.max(-50, col.y - 45); y < col.y - 4; y++) {
        const n = c.t.blockNameAt({ x, y, z });
        if (n && /^(coal|iron|copper)_ore$|^deepslate_(coal|iron|copper)_ore$/.test(n)) {
          const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => isAir(c.t.blockNameAt({ x: x + dx!, y: y + dy!, z: z + dz! })));
          if (nb) {
            ores++;
            if (!under) under = { x: x, y: y, z: z };
          }
        } else if (isAir(n)) pockets++;
      }
    }
  if (ores < 3) return null;
  const site: SiteRecord = { x: cx, y: surf.y + 1, z: cz, note: `${ores} cave-exposed ores, ${pockets} underground air cells within ${R} blocks; surface ${surf.name}` };
  if (under) site.underground = under;
  return { score: ores + pockets / 200, site };
};

const PLAN: Record<string, { kind: "biome" | "structure"; ids: string[]; scorer: Scorer; tries: number }> = {
  forest: { kind: "biome", ids: ["minecraft:forest", "minecraft:birch_forest", "minecraft:taiga"], scorer: forestScorer, tries: 8 },
  plains: { kind: "biome", ids: ["minecraft:plains"], scorer: flatScorer, tries: 10 },
  plains2: { kind: "biome", ids: ["minecraft:plains"], scorer: flatScorerLoose, tries: 14 },
  hills: { kind: "biome", ids: ["minecraft:windswept_hills", "minecraft:windswept_forest", "minecraft:meadow", "minecraft:grove", "minecraft:stony_peaks"], scorer: hillsScorer, tries: 8 },
  cave: { kind: "biome", ids: ["minecraft:windswept_hills", "minecraft:stony_peaks", "minecraft:dripstone_caves", "minecraft:lush_caves", "minecraft:windswept_savanna", "minecraft:badlands"], scorer: caveScorer, tries: 10 },
};

async function scoutVillage(c: Ctx, farEnough: (p: { x: number; z: number }) => boolean): Promise<SiteRecord | null> {
  const found: Array<{ x: number; z: number; d: number; id: string }> = [];
  for (const id of ["village_plains", "village_savanna", "village_desert", "village_taiga", "village_snowy"])
    for (const o of ORIGINS.slice(0, 5)) {
      const p = await locate(c, "structure", `minecraft:${id}`, o);
      if (p && !found.some((q) => dist2d(p, q) < 50)) found.push({ ...p, d: Math.hypot(p.x, p.z), id });
    }
  found.sort((a, b) => a.d - b.d);
  for (const best of found) {
    if (best.d > 1600) break;
    if (!farEnough(best)) continue;
    if (!(await visit(c, best.x, best.z, 40))) continue;
    // Stand on a clear spot near the structure origin.
    for (let r = 0; r < 30; r += 2)
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [0, 0]] as const) {
        const col = column(c, best.x + dx, best.z + dz);
        if (col && OPEN_ABOVE(c, best.x + dx, col.y, best.z + dz, 3) && !/water|leaves|lava/.test(col.name))
          return { x: best.x + dx, y: col.y + 1, z: best.z + dz, note: `${best.id} structure origin, ~${Math.round(best.d)} blocks from spawn` };
      }
  }
  return null;
}

async function scoutSpawn(c: Ctx): Promise<SiteRecord | null> {
  if (!(await visit(c, 0, 0, 24))) return null;
  for (let r = 0; r < 100; r += 3)
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [0, 0]] as const) {
      const col = column(c, dx, dz);
      if (col && OPEN_ABOVE(c, dx, col.y, dz, 3) && !/water|leaves|lava|ice/.test(col.name))
        return { x: dx, y: col.y + 1, z: dz, note: "nearest land to world origin" };
    }
  return null;
}

export async function scout(only?: string[]): Promise<SitesFile> {
  const env = testServerEnv();
  const rcon = makeRcon(env);
  await rcon.connect();
  const t = new Tester(env.host, env.port, env.version, "Tester", "Steve_v2");
  await t.connect();
  await rcon.command("gamemode creative Tester");
  await rcon.command("effect give Tester minecraft:resistance infinite 255 true");
  const c: Ctx = { rcon, t };
  const prev: SitesFile = existsSync(SITES_PATH)
    ? (JSON.parse(readFileSync(SITES_PATH, "utf8")) as SitesFile)
    : { seed: env.rconEnv.LEVEL_SEED ?? "", scoutedAt: "", sites: {} };
  const sites: SitesFile["sites"] = only ? { ...prev.sites } : {};
  const want = (n: string) => !only || only.includes(n);
  if (only) for (const n of only) delete sites[n as SiteName];
  const used = () => Object.values(sites).filter(Boolean) as SiteRecord[];
  const farEnough = (p: { x: number; z: number }) => used().every((s) => dist2d(p, s) >= MIN_SEPARATION);

  for (const name of ["forest", "plains", "plains2", "hills", "cave"] as const) {
    if (!want(name)) continue;
    const plan = PLAN[name]!;
    console.log(`[scout] ${name}: locating candidates...`);
    const cands = await candidates(c, plan.kind, plan.ids);
    console.log(`[scout] ${name}: ${cands.length} candidates`);
    let tries = 0;
    for (const cand of cands) {
      if (tries >= plan.tries) break;
      if (!farEnough(cand)) continue;
      tries++;
      process.stdout.write(`[scout] ${name}: try ${cand.x},${cand.z} ... `);
      if (!(await visit(c, cand.x, cand.z, 64))) { console.log("chunks did not load"); continue; }
      const r = await plan.scorer(c, cand.x, cand.z);
      if (r && farEnough(r.site)) {
        sites[name] = r.site;
        console.log(`OK ${JSON.stringify(r.site)}`);
        break;
      }
      console.log("no");
    }
    if (!sites[name]) console.log(`[scout] ${name}: NOT FOUND`);
  }
  if (want("village")) {
    const v = await scoutVillage(c, farEnough);
    if (v) { sites.village = v; console.log(`[scout] village: ${JSON.stringify(v)}`); } else console.log("[scout] village: none within 1600 blocks");
  }
  if (want("spawn")) {
    const s = await scoutSpawn(c);
    if (s) sites.spawn = s;
    console.log(`[scout] spawn: ${JSON.stringify(s)}`);
  }
  // Pregenerate: visit every site so its chunks are saved to disk.
  for (const [name, s] of Object.entries(sites)) {
    if (!s) continue;
    console.log(`[scout] pregenerating ${name}`);
    await visit(c, s.x, s.z, 80);
    await sleep(2000);
  }
  await rcon.command("tp Tester 0 120 0");
  await rcon.command("save-all flush");
  const file: SitesFile = { seed: env.rconEnv.LEVEL_SEED ?? "", scoutedAt: new Date().toISOString(), sites };
  writeFileSync(SITES_PATH, JSON.stringify(file, null, 2) + "\n");
  t.end();
  rcon.close();
  return file;
}

if (process.argv[1]?.endsWith("scout.ts")) {
  const i = process.argv.indexOf("--only");
  const only = i > 0 ? process.argv[i + 1]?.split(",") : undefined;
  scout(only).then(
    (f) => {
      console.log(JSON.stringify(f, null, 2));
      process.exit(0);
    },
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
