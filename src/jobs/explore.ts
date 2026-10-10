/**
 * Exploration rungs of the recovery ladder: find a block type that is not in
 * range, the way a player would.
 *
 *  - `surface`: walk square-spiral legs (~40 blocks, growing), re-scanning for
 *    the target after every ~20-block hop. Max 6 legs.
 *  - `underground`: a staircase down (forward + one down per step, never
 *    straight down) to the hint's mid Y, then a 2-high branch tunnel, re-
 *    scanning for the ore every few cells. Every cell is checked before it is
 *    dug: natural diggable blocks only, nothing adjacent to water/lava, the
 *    structure guard, a solid floor.
 *
 * It returns as soon as a target block is within scan range; the runner then
 * re-runs the gather step (mineBlocks does the actual mining). Pure helpers
 * are exported for tests; world access goes through `blockNameAt`.
 */
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { touchesLiquid } from "./exhausted.js";
import { builtStructureReason } from "../skills/structure-guard.js";
import { ensureMovements, type BotWithPathfinder } from "../skills/pathfinder-config.js";
import { runSkill } from "../skills/harness.js";
import { navigate } from "../skills/navigation.js";
import type { ExploreFn, ExploreOutcome, GatherStep, RelocateFn, RelocateOutcome, StepRunContext } from "./runner.js";

const { goals } = pathfinderPkg;

// ── tunables ────────────────────────────────────────────────────────────────
export const SURFACE_MAX_LEGS = 6;
const SURFACE_HOP = 20;
const SURFACE_MAX_MS = 6 * 60_000;
/** Found-check radius after every hop / few cells: the gather step takes over from here. */
const FOUND_RADIUS = 40;
const TUNNEL_FOUND_RADIUS = 10;
const RESCAN_EVERY = 3;
const UNDERGROUND_MAX_MS = 10 * 60_000;
const DIG_TIMEOUT_MS = 15_000;
const BRANCH_SEGMENT = 24;
const BRANCH_SHIFT = 3;
const BRANCH_MAX_CELLS = 140;
const MIN_Y = -58;
/** Never wander further than this (horizontally) from where the explore began. */
export const MAX_FROM_START = 250;
/** Walking back to the start after a failed search: hop length, max hops, time box. */
const RETURN_HOP = 40;
const RETURN_MAX_HOPS = 8;
const RETURN_MAX_MS = 3 * 60_000;
const RETURN_ARRIVED = 6;
/** Relocation (the explore-elsewhere rung): how far to go, how long it may take. */
export const RELOCATE_MIN_DIST = 48;
const RELOCATE_DISTANCES = [56, 72, 90] as const;
const RELOCATE_BEARINGS = 16;
const RELOCATE_SAMPLE_STEP = 8;
const RELOCATE_MAX_MS = 4 * 60_000;
const RELOCATE_MAX_TRIES = 4;
const RELOCATE_FOUND_RADIUS = 32;

// ── pure helpers ────────────────────────────────────────────────────────────

/** Square-spiral legs: E, S, W, N, E, S with lengths 40, 40, 80, 80, 120, 120. */
export function spiralLegs(n: number = SURFACE_MAX_LEGS): Array<{ dx: number; dz: number; length: number }> {
  const dirs = [
    { dx: 1, dz: 0 },
    { dx: 0, dz: 1 },
    { dx: -1, dz: 0 },
    { dx: 0, dz: -1 },
  ];
  return Array.from({ length: n }, (_, i) => ({ ...dirs[i % 4]!, length: 40 * (Math.floor(i / 2) + 1) }));
}

/** Y to dig down to for an ore search window; `null` = already inside the window (branch here). */
export function targetY(currentY: number, yRange: [number, number] | undefined): number | null {
  if (!yRange) return null;
  const [lo, hi] = yRange;
  if (currentY >= lo && currentY <= hi) return null;
  if (currentY < lo) return null; // we only dig down; branch from where we are
  return Math.max(MIN_Y, Math.round((lo + hi) / 2));
}

const LIQUID_RE = /^(water|lava|flowing_water|flowing_lava|bubble_column)$/;
const DANGER_FLOOR_RE = /magma|lava|fire|cactus|powder_snow|sweet_berry|campfire|water|wither_rose/;
const DIGGABLE_RE =
  /^(stone|deepslate|cobblestone|cobbled_deepslate|dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|gravel|sand|red_sand|sandstone|red_sandstone|clay|andesite|diorite|granite|tuff|calcite|smooth_basalt|dripstone_block|terracotta|mud|moss_block|snow_block|snow|netherrack|basalt|blackstone|[a-z_]+_terracotta|[a-z_]+_ore|raw_[a-z]+_block|infested_[a-z_]+)$/;

export function isLiquidName(name: string | null): boolean {
  return name !== null && LIQUID_RE.test(name);
}
/** Natural blocks we are willing to dig through. */
export function isDiggableName(name: string): boolean {
  return DIGGABLE_RE.test(name);
}

/** Horizontal (x/z) distance between two points. */
export function horizontalDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export type NameAt = (x: number, y: number, z: number) => string | null;

const NEIGH: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** True when no neighbour of the cell (or the cell) is water/lava, or unloaded. */
export function liquidSafe(nameAt: NameAt, x: number, y: number, z: number): boolean {
  if (isLiquidName(nameAt(x, y, z))) return false;
  for (const [dx, dy, dz] of NEIGH) {
    const n = nameAt(x + dx, y + dy, z + dz);
    if (isLiquidName(n)) return false;
  }
  return true;
}

export interface CellPlan {
  ok: boolean;
  reason: string;
}

/**
 * Can we advance one step in direction (dx,dz) from standing cell (x,y,z)?
 * `down`: staircase step (3 cells, ends 1 lower); else a level tunnel step (2 cells).
 * `isAirLike(name)` = passable without digging.
 */
export function stepIsSafe(
  nameAt: NameAt,
  isAirLike: (x: number, y: number, z: number) => boolean,
  x: number,
  y: number,
  z: number,
  dx: number,
  dz: number,
  down: boolean,
): CellPlan {
  const nx = x + dx;
  const nz = z + dz;
  const ys = down ? [y + 1, y, y - 1] : [y + 1, y];
  const floorY = down ? y - 2 : y - 1;
  for (const cy of ys) {
    if (isAirLike(nx, cy, nz)) {
      if (!liquidSafe(nameAt, nx, cy, nz)) return { ok: false, reason: `liquid next to (${nx},${cy},${nz})` };
      continue;
    }
    const name = nameAt(nx, cy, nz);
    if (name === null) return { ok: false, reason: "unloaded chunk ahead" };
    if (!isDiggableName(name)) return { ok: false, reason: `won't dig ${name} at (${nx},${cy},${nz})` };
    if (!liquidSafe(nameAt, nx, cy, nz)) return { ok: false, reason: `liquid next to (${nx},${cy},${nz})` };
  }
  const floor = nameAt(nx, floorY, nz);
  if (floor === null) return { ok: false, reason: "unloaded floor" };
  if (isLiquidName(floor) || DANGER_FLOOR_RE.test(floor)) return { ok: false, reason: `unsafe floor ${floor}` };
  if (isAirLike(nx, floorY, nz)) return { ok: false, reason: "pit ahead (no floor)" };
  return { ok: true, reason: "" };
}

/** Preference order of cardinal directions: straight on first, then right, left, back. */
export function directionOrder(preferred: { dx: number; dz: number }): Array<{ dx: number; dz: number }> {
  const { dx, dz } = preferred;
  return [
    { dx, dz },
    { dx: 0 - dz, dz: dx },
    { dx: dz, dz: 0 - dx },
    { dx: 0 - dx, dz: 0 - dz },
  ];
}

// ── relocation (pure) ───────────────────────────────────────────────────────

/** What the top of a column looks like. `null` from a {@link SurfaceFn} = chunk not loaded. */
export interface SurfaceProbe {
  y: number;
  /** Water on top (a lake, a river): the bot would have to swim. */
  wet: boolean;
  /** Lava, magma, cactus, fire... */
  hazard: boolean;
}
export type SurfaceFn = (x: number, z: number) => SurfaceProbe | null;

export interface RelocationCandidate {
  x: number;
  z: number;
  dist: number;
  /** Bearing in radians (0 = +x, pi/2 = +z). */
  bearing: number;
  wetFraction: number;
  score: number;
}

export interface RankOptions {
  distances?: readonly number[];
  bearings?: number;
  /** Never plan a destination further than this (horizontally) from `origin` (default: `start`). */
  maxFromOrigin?: number;
  origin?: { x: number; z: number };
  /** Surface ore that stands dry and exposed (see `Explorer.dryOres`): each cluster becomes a destination with a bonus. */
  ores?: ReadonlyArray<{ x: number; z: number }>;
}

/** Score bonus of a destination that is next to dry, exposed ore. */
export const ORE_BONUS = 40;
const ORE_MIN_DIST = 40;

/**
 * Candidate destinations for "go somewhere else on dry land": a fan of bearings
 * x distances from `start`. A candidate is dropped when its column is water,
 * hazardous or unloaded, when any sample on the way is unloaded or hazardous,
 * when it falls inside an exhausted region or beyond `maxFromOrigin`. The rest are
 * scored: less water on the way is better, then directions pointing away from the
 * exhausted areas, then a mild preference for ~64 blocks and for level ground.
 * Best first. Pure over `surface`.
 */
export function rankRelocations(
  surface: SurfaceFn,
  start: { x: number; z: number },
  regions: ReadonlyArray<{ x: number; z: number; r: number }>,
  opts: RankOptions = {},
): RelocationCandidate[] {
  const distances = opts.distances ?? RELOCATE_DISTANCES;
  const nb = opts.bearings ?? RELOCATE_BEARINGS;
  const origin = opts.origin ?? start;
  const maxFrom = opts.maxFromOrigin ?? MAX_FROM_START;
  const here = surface(Math.round(start.x), Math.round(start.z));
  const y0 = here?.y ?? 64;
  // unit vector pointing away from the nearest exhausted centre
  let awayX = 0;
  let awayZ = 0;
  let nearest = Infinity;
  for (const g of regions) {
    const d = Math.hypot(start.x - g.x, start.z - g.z);
    if (d < nearest) {
      nearest = d;
      awayX = d > 0 ? (start.x - g.x) / d : 0;
      awayZ = d > 0 ? (start.z - g.z) / d : 0;
    }
  }
  const out: RelocationCandidate[] = [];
  // fan of bearings x distances, plus one destination per cluster of dry exposed ore
  const targets: Array<{ ux: number; uz: number; dist: number; dx: number; dz: number; bearing: number; bonus: number }> = [];
  for (let b = 0; b < nb; b++) {
    const bearing = (b * 2 * Math.PI) / nb;
    const ux = Math.cos(bearing);
    const uz = Math.sin(bearing);
    for (const dist of distances) targets.push({ ux, uz, dist, dx: Math.round(start.x + ux * dist), dz: Math.round(start.z + uz * dist), bearing, bonus: 0 });
  }
  const seenCell = new Set<string>();
  for (const o of opts.ores ?? []) {
    const cell = `${Math.floor(o.x / 12)},${Math.floor(o.z / 12)}`;
    if (seenCell.has(cell)) continue;
    seenCell.add(cell);
    const dist = Math.hypot(o.x - start.x, o.z - start.z);
    if (dist < ORE_MIN_DIST) continue;
    const ux = (o.x - start.x) / dist;
    const uz = (o.z - start.z) / dist;
    // stand a couple of blocks short of the ore, on the start's side
    targets.push({ ux, uz, dist: Math.max(RELOCATE_SAMPLE_STEP, dist - 2), dx: Math.round(o.x - ux * 2), dz: Math.round(o.z - uz * 2), bearing: Math.atan2(uz, ux), bonus: ORE_BONUS });
  }
  for (const { ux, uz, dist, dx, dz, bearing, bonus } of targets) {
    {
      if (Math.hypot(dx - origin.x, dz - origin.z) > maxFrom) continue;
      if (regions.some((g) => Math.hypot(dx - g.x, dz - g.z) <= g.r + 8)) continue;
      let wet = 0;
      let n = 0;
      let bad = false;
      let last: SurfaceProbe | null = null;
      for (let t = RELOCATE_SAMPLE_STEP; t <= dist; t += RELOCATE_SAMPLE_STEP) {
        const p = surface(Math.round(start.x + ux * t), Math.round(start.z + uz * t));
        if (!p || p.hazard) {
          bad = true;
          break;
        }
        n += 1;
        if (p.wet) wet += 1;
        last = p;
      }
      const end = surface(dx, dz);
      if (bad || !end || end.wet || end.hazard || !last) continue;
      const wetFraction = n > 0 ? wet / n : 0;
      const away = ux * awayX + uz * awayZ;
      const score = 100 - wetFraction * 120 + away * 15 - Math.abs(dist - 64) * 0.2 - Math.abs(end.y - y0) * 0.3 + bonus;
      out.push({ x: dx, z: dz, dist, bearing, wetFraction, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Best few candidates that point in clearly different directions (a blocked bearing should not retry its neighbour). */
export function distinctCandidates(c: readonly RelocationCandidate[], n: number, minAngle = Math.PI / 4): RelocationCandidate[] {
  const out: RelocationCandidate[] = [];
  for (const cand of c) {
    if (out.every((o) => Math.abs(Math.atan2(Math.sin(o.bearing - cand.bearing), Math.cos(o.bearing - cand.bearing))) >= minAngle)) out.push(cand);
    if (out.length >= n) break;
  }
  return out;
}

// ── bot-bound implementation ────────────────────────────────────────────────

export function createExplorer(bot: Bot): ExploreFn {
  return async (step: GatherStep, ctx: StepRunContext): Promise<ExploreOutcome> => {
    const pBot = bot as BotWithPathfinder;
    ensureMovements(pBot);
    const ids = step.blocks.map((b) => bot.registry.blocksByName[b]?.id).filter((i): i is number => i !== undefined);
    if (ids.length === 0) return { found: false, detail: `no block ids for ${step.blocks.join(",")}` };
    const hint = step.searchHint ?? { kind: "surface" as const };
    const ex = new Explorer(bot, ids, ctx);
    let outcome: ExploreOutcome | null = null;
    // Through `runSkill` like every other skill: it holds the current-tool slot
    // (so the idle-look / auto-eat / armor reflexes stay off mid-dig), records
    // the skill telemetry, and waits for any in-flight reflex first. No 10-min
    // watchdog: the explore carries its own time boxes.
    await runSkill(
      bot,
      "explore",
      { item: step.item, kind: hint.kind },
      async () => {
        const out = hint.kind === "underground" ? await ex.underground(hint.yRange) : await ex.surface();
        outcome = out.found || ex.isAborted ? out : await ex.returnToStart(out, hint.kind === "underground");
        return { ok: outcome.found, message: `explore ${hint.kind}: ${outcome.detail}` };
      },
      { watchdogMs: null },
    );
    return outcome ?? { found: false, detail: "explore crashed" };
  };
}

export function createRelocator(bot: Bot): RelocateFn {
  return async (step: GatherStep, ctx: StepRunContext, regions): Promise<RelocateOutcome> => {
    ensureMovements(bot as BotWithPathfinder);
    const ids = step.blocks.map((b) => bot.registry.blocksByName[b]?.id).filter((i): i is number => i !== undefined);
    const ex = new Explorer(bot, ids, ctx);
    let outcome: RelocateOutcome = { moved: false, detail: "relocate did not run" };
    await runSkill(
      bot,
      "explore",
      { item: step.item, kind: "relocate" },
      async () => {
        outcome = await ex.relocate(regions);
        return { ok: outcome.moved, message: `explore relocate: ${outcome.detail}` };
      },
      { watchdogMs: null },
    );
    return outcome;
  };
}

class Explorer {
  private readonly start: Vec3;

  constructor(
    private readonly bot: Bot,
    private readonly ids: number[],
    private readonly ctx: StepRunContext,
  ) {
    this.start = bot.entity.position.clone();
  }

  private get aborted(): boolean {
    return this.ctx.signal.aborted;
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  private fromStart(p: { x: number; z: number } = this.bot.entity.position): number {
    return horizontalDistance(p, this.start);
  }

  /**
   * After a failed search: walk back toward where the explore began (bounded,
   * cancellable), so the job doesn't strand the bot far from its base. Reports
   * the end position either way.
   */
  async returnToStart(out: ExploreOutcome, underground: boolean): Promise<ExploreOutcome> {
    const t0 = Date.now();
    if (this.fromStart() > RETURN_ARRIVED) {
      this.log(`giving up; walking back to the start (${Math.round(this.fromStart())} blocks)`);
      for (let hop = 0; hop < RETURN_MAX_HOPS && Date.now() - t0 < RETURN_MAX_MS && !this.aborted; hop++) {
        const here = this.bot.entity.position;
        const d = this.fromStart();
        if (d <= RETURN_ARRIVED) break;
        let goal;
        let target: Vec3;
        if (underground) {
          // tunnels are not straight: path to the start itself (the whole route is loaded and walkable)
          goal = new goals.GoalNear(Math.floor(this.start.x), Math.floor(this.start.y), Math.floor(this.start.z), 3);
          target = this.start;
        } else {
          const f = Math.min(RETURN_HOP, d) / d;
          const tx = here.x + (this.start.x - here.x) * f;
          const tz = here.z + (this.start.z - here.z) * f;
          goal = new goals.GoalNearXZ(Math.round(tx), Math.round(tz), 3);
          target = new Vec3(tx, here.y, tz);
        }
        const r = await navigate(this.bot, goal, { label: "explore return", target, escape: "none" });
        if (!r.ok) break;
        if (underground) break; // one direct path; success means we are back
      }
    }
    const end = this.bot.entity.position;
    const left = Math.round(this.fromStart());
    const where = left <= RETURN_ARRIVED + 3 ? "walked back to the start" : `ended ${left} blocks from the start at (${Math.round(end.x)}, ${Math.round(end.y)}, ${Math.round(end.z)})`;
    return { found: false, detail: `${out.detail}; ${where}` };
  }

  private nameAt: NameAt = (x, y, z) => this.bot.blockAt(new Vec3(x, y, z))?.name ?? null;

  private airLike = (x: number, y: number, z: number): boolean => {
    const b = this.bot.blockAt(new Vec3(x, y, z));
    return !!b && b.boundingBox === "empty" && !isLiquidName(b.name);
  };

  /** A target block within `radius` that the job has not already found unreachable. */
  private targetNear(radius: number): boolean {
    const ex = this.ctx.exclude;
    if (!ex) return this.bot.findBlock({ point: this.bot.entity.position, matching: this.ids, maxDistance: radius }) !== null;
    return this.bot.findBlocks({ point: this.bot.entity.position, matching: this.ids, maxDistance: radius, count: 64 }).some((p) => !ex(p.x, p.y, p.z));
  }

  /** An ore block standing dry and exposed at the surface: air beside it, no water / lava touching it, top of its column within 4 blocks. */
  private dryExposed(p: Vec3): boolean {
    if (touchesLiquid(this.nameAt, p.x, p.y, p.z)) return false;
    let air = false;
    for (const [dx, dy, dz] of NEIGH) if (this.airLike(p.x + dx, p.y + dy, p.z + dz)) air = true;
    if (!air) return false;
    const top = this.surfaceAt(p.x, p.z);
    return !!top && !top.wet && top.y - p.y <= 4;
  }

  /** Dry exposed target blocks the job has not written off, within `radius` of the bot. */
  private dryOres(radius: number): Vec3[] {
    const ex = this.ctx.exclude;
    return this.bot
      .findBlocks({ point: this.bot.entity.position, matching: this.ids, maxDistance: radius, count: 400 })
      .filter((p) => !ex?.(p.x, p.y, p.z) && this.dryExposed(p));
  }

  /** Top of the column at (x,z), from the loaded chunks. */
  private surfaceAt: SurfaceFn = (x, z) => {
    const y0 = Math.floor(this.bot.entity.position.y);
    for (let y = Math.min(y0 + 40, 318); y >= Math.max(y0 - 48, -60); y--) {
      const b = this.bot.blockAt(new Vec3(x, y, z));
      if (!b) return null;
      if (b.name === "air" || b.name === "cave_air" || b.name === "void_air") continue;
      if (isLiquidName(b.name)) return { y, wet: b.name === "water" || b.name === "flowing_water", hazard: b.name === "lava" || b.name === "flowing_lava" };
      if (b.boundingBox === "empty") continue; // grass, flowers, snow layers, torches
      return { y, wet: false, hazard: DANGER_FLOOR_RE.test(b.name) && !/water/.test(b.name) };
    }
    return null;
  };

  // ── relocate (explore elsewhere) ──
  /**
   * Leave an exhausted area: walk >= RELOCATE_MIN_DIST blocks over dry surface (pathfinder swims only at a
   * steep cost) toward the best-ranked destination, falling back to the next distinct bearing when a leg is
   * blocked, and stop early once a target block the job has not written off is in range. No return trip:
   * the point is to gather over there.
   */
  async relocate(regions: ReadonlyArray<{ x: number; z: number; r: number }>): Promise<RelocateOutcome> {
    const t0 = Date.now();
    const start = this.start.clone();
    const ores = this.dryOres(128);
    const ranked = rankRelocations(this.surfaceAt, start, regions, { origin: start, ores });
    const picks = distinctCandidates(ranked, RELOCATE_MAX_TRIES);
    if (picks.length === 0) return { moved: false, detail: "no dry land to relocate to within range (water / unloaded chunks all around)" };
    let note = "";
    for (const c of picks) {
      this.log(`relocating toward (${c.x}, ${c.z}) ${Math.round(c.dist)} blocks out, ${Math.round(c.wetFraction * 100)}% water on the way${c.score > 100 + ORE_BONUS - 30 ? ", dry ore there" : ""} (${ores.length} dry ore blocks in range)`);
      while (!this.aborted && Date.now() - t0 < RELOCATE_MAX_MS) {
        const p = this.bot.entity.position;
        const left = horizontalDistance(p, c);
        if (left <= 6) break;
        const f = Math.min(SURFACE_HOP, left) / left;
        const moved = await this.walkTo(p.x + (c.x - p.x) * f, p.z + (c.z - p.z) * f, "explore relocate");
        if (!moved) {
          note = `blocked at ${Math.round(this.fromStart())} blocks`;
          break;
        }
        if (this.fromStart() >= RELOCATE_MIN_DIST && this.dryOres(RELOCATE_FOUND_RADIUS).length > 0) {
          return { moved: true, detail: `dry target block in range ${Math.round(this.fromStart())} blocks from the old area` };
        }
      }
      if (this.aborted) return { moved: this.fromStart() >= 16, detail: "cancelled" };
      if (this.fromStart() >= RELOCATE_MIN_DIST) break;
    }
    const d = Math.round(this.fromStart());
    const end = this.bot.entity.position;
    return {
      moved: d >= 32,
      detail: `${d >= RELOCATE_MIN_DIST ? "relocated" : "only got"} ${d} blocks from the old area to (${Math.round(end.x)}, ${Math.round(end.y)}, ${Math.round(end.z)})${note ? `; ${note}` : ""}`,
    };
  }

  private log(msg: string): void {
    console.log(`[${this.bot.username}] explore: ${msg}`);
  }

  // ── surface ──
  async surface(): Promise<ExploreOutcome> {
    const t0 = Date.now();
    let travelled = 0;
    for (const [i, leg] of spiralLegs().entries()) {
      for (let walked = 0; walked < leg.length; walked += SURFACE_HOP) {
        if (this.aborted) return { found: false, detail: "cancelled" };
        if (Date.now() - t0 > SURFACE_MAX_MS) return { found: false, detail: `surface search timed out after ${travelled} blocks` };
        const p = this.bot.entity.position;
        const hop = Math.min(SURFACE_HOP, leg.length - walked);
        if (this.fromStart({ x: p.x + leg.dx * hop, z: p.z + leg.dz * hop }) > MAX_FROM_START) break; // too far out: turn
        const moved = await this.walkTo(p.x + leg.dx * hop, p.z + leg.dz * hop, `explore leg ${i + 1}`);
        if (!moved) break; // blocked: next leg turns
        travelled += hop;
        if (this.targetNear(FOUND_RADIUS)) {
          this.log(`target in range after ${travelled} blocks (leg ${i + 1})`);
          return { found: true, detail: `target block in range after walking ~${travelled} blocks` };
        }
      }
    }
    return { found: false, detail: `walked ~${travelled} blocks in ${SURFACE_MAX_LEGS} legs without finding it` };
  }

  private async walkTo(x: number, z: number, label: string): Promise<boolean> {
    const here = this.bot.entity.position;
    const r = await navigate(this.bot, new goals.GoalNearXZ(Math.round(x), Math.round(z), 3), {
      label,
      target: new Vec3(x, here.y, z),
      escape: "none",
    });
    if (r.ok) return true;
    if (this.aborted) return false;
    // one sidestep: pathing straight can fail on water / a cliff
    const side = new Vec3(x - here.x, 0, z - here.z);
    const px = Math.sign(-side.z) * 12;
    const pz = Math.sign(side.x) * 12;
    const r2 = await navigate(this.bot, new goals.GoalNearXZ(Math.round(x + px), Math.round(z + pz), 3), {
      label: `${label} (sidestep)`,
      target: new Vec3(x + px, here.y, z + pz),
      escape: "none",
    });
    return r2.ok;
  }

  // ── underground ──
  async underground(yRange: [number, number] | undefined): Promise<ExploreOutcome> {
    const t0 = Date.now();
    const y0 = Math.floor(this.bot.entity.position.y);
    const goalY = targetY(y0, yRange);
    let dir = this.initialDirection();
    let cells = 0;
    let steps = 0;

    if (goalY !== null) {
      this.log(`staircase down from y=${y0} to y=${goalY}`);
      const maxSteps = y0 - goalY + 12;
      while (Math.floor(this.bot.entity.position.y) > goalY && steps < maxSteps) {
        if (this.aborted) return { found: false, detail: "cancelled" };
        if (Date.now() - t0 > UNDERGROUND_MAX_MS) return { found: false, detail: "underground search timed out during descent" };
        const adv = await this.advance(dir, true);
        if (!adv.ok) return { found: false, detail: `staircase blocked at y=${Math.floor(this.bot.entity.position.y)}: ${adv.reason}` };
        dir = adv.dir;
        steps += 1;
        cells += 3;
        if (steps % RESCAN_EVERY === 0 && this.targetNear(TUNNEL_FOUND_RADIUS)) {
          return { found: true, detail: `target ore near the staircase at y=${Math.floor(this.bot.entity.position.y)}` };
        }
      }
    }

    // branch mine: rake of level 2-high tunnels, 3 apart
    const y = Math.floor(this.bot.entity.position.y);
    this.log(`branch mining at y=${y}`);
    let along = 0;
    let dug = 0;
    let heading = dir;
    let turnedAround = false;
    while (dug < BRANCH_MAX_CELLS) {
      if (this.aborted) return { found: false, detail: "cancelled" };
      if (Date.now() - t0 > UNDERGROUND_MAX_MS) return { found: false, detail: `underground search timed out after ${dug} cells` };
      const adv = await this.advance(heading, false);
      if (!adv.ok) {
        // dead end (liquid, unloaded chunk, structure): head back the way we came once, else give up
        if (turnedAround) return { found: false, detail: `branch mine blocked after ${dug} cells: ${adv.reason}` };
        turnedAround = true;
        heading = { dx: -heading.dx, dz: -heading.dz };
        along = 0;
        continue;
      }
      heading = adv.dir;
      dug += 1;
      along += 1;
      if (dug % RESCAN_EVERY === 0 && this.targetNear(TUNNEL_FOUND_RADIUS)) {
        return { found: true, detail: `target ore within ${TUNNEL_FOUND_RADIUS} blocks of the tunnel at y=${y}` };
      }
      if (along >= BRANCH_SEGMENT) {
        // shift sideways BRANCH_SHIFT cells, then run the next tunnel back the other way
        let sideDir = { dx: -heading.dz, dz: heading.dx };
        for (let k = 0; k < BRANCH_SHIFT; k++) {
          const s = await this.advance(sideDir, false);
          if (!s.ok) break;
          sideDir = s.dir;
          dug += 1;
        }
        heading = { dx: -heading.dx, dz: -heading.dz };
        along = 0;
      }
    }
    return { found: false, detail: `dug ${dug} cells of branch tunnel at y=${y} without finding it` };
  }

  private initialDirection(): { dx: number; dz: number } {
    const yaw = this.bot.entity.yaw;
    // mineflayer yaw 0 = -z (north); east = -pi/2
    const dx = -Math.round(Math.sin(yaw));
    const dz = -Math.round(Math.cos(yaw));
    return dx === 0 && dz === 0 ? { dx: 1, dz: 0 } : { dx, dz };
  }

  /** Advance one step (down-stair or level), trying `preferred` first, then the other directions. */
  private async advance(
    preferred: { dx: number; dz: number },
    down: boolean,
  ): Promise<{ ok: true; dir: { dx: number; dz: number } } | { ok: false; reason: string }> {
    if (this.fromStart() > MAX_FROM_START) return { ok: false, reason: `${MAX_FROM_START} blocks from the start` };
    const feet = this.bot.entity.position.floored();
    let firstReason = "";
    for (const d of directionOrder(preferred)) {
      const plan = stepIsSafe(this.nameAt, this.airLike, feet.x, feet.y, feet.z, d.dx, d.dz, down);
      if (!plan.ok) {
        firstReason ||= plan.reason;
        continue;
      }
      const nx = feet.x + d.dx;
      const nz = feet.z + d.dz;
      const ys = down ? [feet.y + 1, feet.y, feet.y - 1] : [feet.y + 1, feet.y];
      for (const cy of ys) {
        const r = await this.digCell(new Vec3(nx, cy, nz));
        if (r !== "ok") {
          firstReason ||= `dig ${r} at (${nx},${cy},${nz})`;
          return { ok: false, reason: firstReason };
        }
      }
      const toY = down ? feet.y - 1 : feet.y;
      const nav = await navigate(this.bot, new goals.GoalBlock(nx, toY, nz), {
        label: `tunnel (${nx}, ${toY}, ${nz})`,
        target: new Vec3(nx + 0.5, toY, nz + 0.5),
        escape: "none",
      });
      if (!nav.ok) return { ok: false, reason: `could not step into the tunnel: ${nav.message}` };
      return { ok: true, dir: d };
    }
    return { ok: false, reason: firstReason || "no safe direction" };
  }

  /** Dig one cell if it needs it. 'ok' also for cells already passable. */
  private async digCell(pos: Vec3): Promise<"ok" | "refused" | "failed" | "cancelled"> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.aborted) return "cancelled";
      const b = this.bot.blockAt(pos);
      if (!b) return "refused";
      if (b.boundingBox === "empty" && !isLiquidName(b.name)) return "ok";
      if (isLiquidName(b.name) || !isDiggableName(b.name)) return "refused";
      if (builtStructureReason(this.bot, b)) return "refused";
      if (!liquidSafe(this.nameAt, pos.x, pos.y, pos.z)) return "refused";
      await this.equipFor(b);
      // The timer must not outlive the dig: a leaked timer would fire
      // `stopDigging()` in the middle of a LATER dig (every cell is a dig).
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.bot.dig(b),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => {
              try {
                this.bot.stopDigging?.();
              } catch {
                /* best effort */
              }
              rej(new Error("dig timeout"));
            }, DIG_TIMEOUT_MS);
          }),
        ]);
      } catch {
        return "failed";
      } finally {
        if (timer) clearTimeout(timer);
      }
      await new Promise((r) => setTimeout(r, 250)); // gravel / sand above may fall into the cell
    }
    const after = this.bot.blockAt(pos);
    return after && after.boundingBox === "empty" ? "ok" : "failed";
  }

  private async equipFor(block: Block): Promise<void> {
    let best: { item: ReturnType<Bot["inventory"]["items"]>[number]; t: number } | null = null;
    for (const item of this.bot.inventory.items()) {
      if (!block.canHarvest(item.type) && block.canHarvest(null) === false) continue;
      let t = Infinity;
      try {
        t = block.digTime(item.type, false, false, false, [], []);
      } catch {
        /* unknown material */
      }
      if (!best || t < best.t) best = { item, t };
    }
    let handT = Infinity;
    try {
      handT = block.canHarvest(null) ? block.digTime(null, false, false, false, [], []) : Infinity;
    } catch {
      /* ignore */
    }
    if (best && best.t < handT && this.bot.heldItem?.type !== best.item.type) {
      try {
        await this.bot.equip(best.item, "hand");
      } catch {
        /* dig with whatever is held */
      }
    }
  }
}
