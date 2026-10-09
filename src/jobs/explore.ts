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
import { builtStructureReason } from "../skills/structure-guard.js";
import { ensureMovements, type BotWithPathfinder } from "../skills/pathfinder-config.js";
import { navigate } from "../skills/navigation.js";
import type { ExploreFn, ExploreOutcome, GatherStep, StepRunContext } from "./runner.js";

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

// ── bot-bound implementation ────────────────────────────────────────────────

export function createExplorer(bot: Bot): ExploreFn {
  return async (step: GatherStep, ctx: StepRunContext): Promise<ExploreOutcome> => {
    const pBot = bot as BotWithPathfinder;
    ensureMovements(pBot);
    const ids = step.blocks.map((b) => bot.registry.blocksByName[b]?.id).filter((i): i is number => i !== undefined);
    if (ids.length === 0) return { found: false, detail: `no block ids for ${step.blocks.join(",")}` };
    const hint = step.searchHint ?? { kind: "surface" as const };
    const ex = new Explorer(bot, ids, ctx);
    return hint.kind === "underground" ? ex.underground(hint.yRange) : ex.surface();
  };
}

class Explorer {
  constructor(
    private readonly bot: Bot,
    private readonly ids: number[],
    private readonly ctx: StepRunContext,
  ) {}

  private get aborted(): boolean {
    return this.ctx.signal.aborted;
  }

  private nameAt: NameAt = (x, y, z) => this.bot.blockAt(new Vec3(x, y, z))?.name ?? null;

  private airLike = (x: number, y: number, z: number): boolean => {
    const b = this.bot.blockAt(new Vec3(x, y, z));
    return !!b && b.boundingBox === "empty" && !isLiquidName(b.name);
  };

  private targetNear(radius: number): boolean {
    return this.bot.findBlock({ point: this.bot.entity.position, matching: this.ids, maxDistance: radius }) !== null;
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
      try {
        await Promise.race([
          this.bot.dig(b),
          new Promise<never>((_, rej) => setTimeout(() => {
            try {
              this.bot.stopDigging?.();
            } catch {
              /* best effort */
            }
            rej(new Error("dig timeout"));
          }, DIG_TIMEOUT_MS)),
        ]);
      } catch {
        return "failed";
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
