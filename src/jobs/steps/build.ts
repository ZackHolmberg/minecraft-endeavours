/**
 * Build executor (v2 slice 3): the bot-bound half of a `build` job.
 *
 *  - `prepare` reads the world through a thin grid adapter and calls the pure
 *    `src/build/prepare.ts` (site, blueprint → placements, what's done, scaffold
 *    ordering, materials gap).
 *  - `run` executes the ordered actions: clear replaceables, creative `getItems`,
 *    place bottom-up / nearest-first (pre-positioning the bot so it never stands
 *    in a cell it is about to fill), temporary scaffolds, door last from OUTSIDE,
 *    till / plant / water for farms, flint-and-steel for portals; then counts the
 *    blueprint's blocks in the world as the postcondition.
 *
 * Idempotent: cells already satisfied are skipped, so the runner's retries resume.
 * Survival and creative share the path; creative skips stand-spot walking (the
 * existing `placeBlock` flies to high spots) and fetches materials with `getItems`.
 */
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { pickDoor, pickHoe, pickScaffold } from "../../build/materials.js";
import { placementDone, prepare, solidName, type Prepared } from "../../build/prepare.js";
import { isAir, isReplaceable, isWaterName, type WorldGrid } from "../../build/site.js";
import { isFallingBlockName } from "../../skills/structure-guard.js";
import { planOrder, type AbsPlacement, type BuildAction } from "../../build/support.js";
import { cellKey, dirVec, type Cell } from "../../build/types.js";
import { chooseDirtCell, DIRT_DIG_CAP } from "../dirt-source.js";
import type { FailureKind } from "../../planner/types.js";
import { getItems } from "../../skills/creative.js";
import { flyTo, isFlying, land } from "../../skills/flight.js";
import { isCreative } from "../../skills/game-mode.js";
import { pickUpNearby } from "../../skills/inventory.js";
import { fightNearbyHostiles } from "../../skills/melee-guard.js";
import { activateBlock } from "../../skills/interaction.js";
import { navigate } from "../../skills/navigation.js";
import { ensureMovements, type BotWithPathfinder } from "../../skills/pathfinder-config.js";
import { placeBlock } from "../../skills/world.js";
import { getBotState } from "../../state/index.js";
import type { BuildDeps, BuildRunContext } from "../runner.js";
import type { BuildOutcome, BuildPrep, ScaffoldCell } from "../types.js";
import { inventoryTotals } from "../world-view.js";
import { tracked } from "./util.js";

const { goals } = pathfinderPkg;

/** Eye-to-target distance we place from (server reach is ~4.5-5.5; keep a margin). */
const REACH = 4.0;
const SETTLE_MS = 1500;
const MAX_FAIL_STREAK = 5;
const DIG_TIMEOUT_MS = 15_000;
/** Total time the scaffold clean-up (stop / failure / boot) may take before it gives up and leaves the rest on the books. */
export const CLEANUP_BUDGET_MS = 20_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const v = (c: Cell): Vec3 => new Vec3(c.x, c.y, c.z);

export function gridOf(bot: Bot): WorldGrid {
  return { blockAt: (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name ?? null };
}

/**
 * The world as if known scaffold blocks were air: a leftover dirt block from an earlier attempt is
 * not terrain (it must not count as ground, support or a footprint obstacle). Only cells that
 * still hold the recorded item are masked, so an unrelated block placed there later stays real.
 */
export function maskScaffolds(grid: WorldGrid, cells: readonly ScaffoldCell[]): WorldGrid {
  if (cells.length === 0) return grid;
  const at = new Map(cells.map((c) => [cellKey(c), c.item]));
  return {
    blockAt: (x, y, z) => {
      const n = grid.blockAt(x, y, z);
      return n !== null && at.get(cellKey({ x, y, z })) === n ? "air" : n;
    },
  };
}

/** Items a build needs to keep for its whole duration (reserved so the pillar filler never spends them). */
export function buildReserve(res: Prepared, inv: Record<string, number>): string[] {
  const out = new Set<string>(Object.keys(res.needs.consumed));
  if (res.needs.scaffoldItem) out.add(res.needs.scaffoldItem);
  if (res.needs.selfSupply) out.add(res.needs.selfSupply.item);
  for (const tool of res.needs.tools) for (const t of tool) out.add(t);
  for (const p of res.bp.placements) if (p.role === "door" && !p.derived) out.add(p.block);
  if (res.bp.placements.some((p) => p.role === "door")) for (const k of Object.keys(inv)) if (/_door$/.test(k) && k !== "iron_door") out.add(k);
  return [...out];
}

export function createBuildDeps(bot: Bot): BuildDeps {
  return {
    reclaim: async (cells, signal) => {
      if (cells.length === 0) return [];
      const b = Builder.forReclaim(bot, cells, signal);
      try {
        await b.cleanupScaffolds();
      } finally {
        b.dispose();
      }
      return b.leftovers();
    },
    prepare: async (spec, existing, scaffolds) => {
      const creative = isCreative(bot);
      // unknown materials fail before any walking
      for (const key of ["wall", "roof", "floor"] as const) {
        const name = spec.params[key];
        if (typeof name === "string" && !bot.registry.itemsByName[name]) {
          return { ok: false, kind: "unknown_item", detail: `${key} "${name}" isn't a block I know (use a snake_case id like oak_planks or cobblestone)` };
        }
        // must be a full solid, non-falling block (water_bucket / torch / sand would pass the item check and then fail every placement)
        const blocks = (bot.registry as { blocksByName?: Record<string, { boundingBox?: string }> }).blocksByName;
        if (typeof name === "string" && blocks && (blocks[name]?.boundingBox !== "block" || isFallingBlockName(name))) {
          return { ok: false, kind: "unknown_item", detail: `${key} "${name}" isn't a full solid block I can build with (try planks, cobblestone, stone_bricks, ...)` };
        }
      }
      const pos = bot.entity.position;
      // Players who walked into the area since the request (gathering can take minutes) are avoided too.
      const spec2 = existing ? spec : { ...spec, avoid: [...spec.avoid, ...nearbyPlayers(bot)] };
      const res = prepare({
        grid: maskScaffolds(gridOf(bot), scaffolds ?? []),
        inv: inventoryTotals(bot.inventory.slots),
        creative,
        spec: spec2,
        existing,
        botPos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
      });
      if (!res.ok) return res;
      const skipped = Object.entries(res.needs.skippedOptional).map(([k, n]) => `${n} ${k}`);
      const prep: BuildPrep = {
        ok: true,
        origin: res.origin,
        facing: res.facing,
        params: res.params,
        summary: res.summary + (skipped.length > 0 ? ` (no ${skipped.join(", ")}: those windows stay open)` : ""),
        total: res.total,
        missing: res.missing,
        payload: res,
        reserve: buildReserve(res, inventoryTotals(bot.inventory.slots)),
      };
      return prep;
    },
    run: (prep, ctx) => runBuild(bot, prep.payload as Prepared, ctx),
  };
}

function nearbyPlayers(bot: Bot): Cell[] {
  const out: Cell[] = [];
  for (const [name, p] of Object.entries(bot.players ?? {})) {
    if (name === bot.username || !p.entity) continue;
    if (p.entity.position.distanceTo(bot.entity.position) <= 48) out.push({ x: Math.floor(p.entity.position.x), y: Math.floor(p.entity.position.y), z: Math.floor(p.entity.position.z) });
  }
  return out;
}

async function runBuild(bot: Bot, prepd: Prepared, ctx: BuildRunContext): Promise<BuildOutcome> {
  let outcome: BuildOutcome = { ok: false, kind: "internal", detail: "build did not run", placed: prepd.doneCount, total: prepd.total };
  await tracked(bot, "build", { blueprint: prepd.bp.kind, origin: prepd.origin }, async () => {
    outcome = await new Builder(bot, prepd, ctx).run();
    return { ok: outcome.ok, message: outcome.detail };
  });
  return outcome;
}

class Builder {
  private readonly creative: boolean;
  private readonly grid: WorldGrid;
  private readonly origin: Cell;
  private readonly dims: { x: number; z: number };
  /** Cells that will hold (or temporarily hold) a block: never stand in them. */
  private readonly reserved = new Set<string>();
  /** Every scaffold block this builder (or an earlier attempt/job) placed and has not confirmed removed. Mirrored to job.json. */
  private scaffolds: ScaffoldCell[];
  private scaffoldItem = "dirt";
  private lastError = "";
  private ended = false;
  private readonly onEnd = (): void => {
    this.ended = true;
  };
  /** Clean-up mode: the stop flag / abort signal that ended the run no longer stop us, only a NEW stop, the clock or death do. */
  private cleaning = false;
  private cleanupUntil = 0;

  constructor(
    private readonly bot: Bot,
    private readonly prepd: Prepared,
    private readonly ctx: BuildRunContext,
  ) {
    this.creative = isCreative(bot);
    this.grid = gridOf(bot);
    this.origin = prepd.origin;
    this.dims = { x: prepd.bp.size.x, z: prepd.bp.size.z };
    for (const p of prepd.remaining) this.reserved.add(cellKey(p));
    this.scaffolds = (ctx.scaffolds ?? []).map((c) => ({ ...c }));
    if (this.scaffolds.length > 0) this.scaffoldItem = this.scaffolds[this.scaffolds.length - 1]!.item;
    (bot as { once?: (ev: string, fn: () => void) => void }).once?.("end", this.onEnd);
  }

  /** A Builder with nothing to build, only a scaffold list to clear (boot-time reclaim). */
  static forReclaim(bot: Bot, cells: readonly ScaffoldCell[], signal: AbortSignal): Builder {
    const empty = { ok: true, origin: { x: 0, y: 0, z: 0 }, facing: "south", bp: { kind: "house", size: { x: 0, y: 0, z: 0 }, placements: [], clear: [] }, remaining: [], doneCount: 0, total: 0 } as unknown as Prepared;
    const ctx = { signal, radius: 0, baseline: 0, jobId: "reclaim", record: () => {}, progress: () => {}, scaffolds: [...cells], setScaffolds: () => {} } as BuildRunContext;
    return new Builder(bot, empty, ctx);
  }

  dispose(): void {
    (this.bot as { removeListener?: (ev: string, fn: () => void) => void }).removeListener?.("end", this.onEnd);
  }

  leftovers(): ScaffoldCell[] {
    return this.scaffolds.map((c) => ({ ...c }));
  }

  /** False once the bot is dead or its connection ended: nothing in the world can be done then. */
  private alive(): boolean {
    const { bot } = this;
    return !this.ended && !!bot.entity && !(typeof bot.health === "number" && bot.health <= 0);
  }

  private syncScaffolds(): void {
    try {
      this.ctx.setScaffolds(this.scaffolds);
    } catch {
      // persistence is best-effort
    }
  }

  private log(msg: string): void {
    console.log(`[${this.bot.username}] build ${msg}`);
  }

  private stopped(): boolean {
    const flag = getBotState(this.bot.username)?.cancellation.isRequested() === true;
    if (this.cleaning) return !this.alive() || Date.now() > this.cleanupUntil || flag;
    return this.ctx.signal.aborted || flag;
  }

  private inv(): Record<string, number> {
    return inventoryTotals(this.bot.inventory.slots);
  }

  private outcome(ok: boolean, kind: FailureKind, detail: string): BuildOutcome {
    const placed = this.countDone();
    return ok ? { ok: true, placed, total: this.prepd.total, detail } : { ok: false, kind, detail, placed, total: this.prepd.total };
  }

  private countDone(): number {
    return this.prepd.doneCount + this.prepd.remaining.filter((p) => placementDone(this.grid, p)).length;
  }

  /**
   * Build, then ALWAYS take the scaffolds down again (stop, failure, timeout, thrown error): the list is
   * persisted as it changes, and whatever cannot be removed now (dead bot, no route, out of time) stays on
   * the books for the next build / boot to retry.
   */
  async run(): Promise<BuildOutcome> {
    try {
      return await this.runInner();
    } finally {
      try {
        await this.cleanupScaffolds();
      } catch (err) {
        this.log(`scaffold clean-up crashed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.dispose();
    }
  }

  private async runInner(): Promise<BuildOutcome> {
    const { bot, prepd, ctx } = this;
    ensureMovements(bot as BotWithPathfinder);
    const kind = prepd.bp.kind;

    // 0. leftovers from an earlier attempt / job / crash: take them down before anything else
    if (this.scaffolds.length > 0) await this.cleanupScaffolds();
    const stale = this.leftovers();

    // 1. materials (creative: take them from the creative inventory in one call)
    if (this.creative && prepd.creativeItems.length > 0) {
      const r = await getItems(bot, { items: prepd.creativeItems.slice(0, 36).map((i) => ({ name: i.name, count: i.count })) });
      if (!r.ok) return this.outcome(false, "inventory_full", r.message);
    }

    // 1b. survival scaffold dirt: dig it from the ground nearby (reliable, and the planner's gather is not)
    const sup = prepd.needs.selfSupply;
    if (sup && !this.creative) {
      const want = (prepd.needs.consumed[sup.item] ?? sup.count) + 1; // one spare: a recovered scaffold can go missing
      if (!(await this.acquire(sup.item, want))) return this.outcome(false, "missing_input", `couldn't dig ${sup.count} ${sup.item} for scaffolding near the site (${this.lastError || "no diggable ground"})`);
    }

    // 2. clear flowers / grass / snow layers inside the footprint volume
    const t0 = Date.now();
    let cleared = 0;
    for (const c of prepd.clearCells) {
      if (this.stopped()) return this.outcome(false, "cancelled", "build cancelled");
      if (await this.dig(c)) cleared += 1;
    }
    if (prepd.clearCells.length > 0) {
      ctx.record({ kind: "step", jobId: ctx.jobId, op: "clear", item: `${kind}`, ok: cleared === prepd.clearCells.length, durationMs: Date.now() - t0, failureKind: null });
    }

    // 3. order against the live world (clearing changed it)
    this.scaffoldItem = prepd.needs.scaffoldItem ?? pickScaffold(this.inv());
    const pos = bot.entity.position;
    const terrain = maskScaffolds(this.grid, stale); // a leftover we could not remove is not ground
    const order = planOrder(prepd.remaining.filter((p) => !p.derived), {
      isSolidWorld: (c) => solidName(terrain.blockAt(c.x, c.y, c.z)),
      start: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
      keepClear: prepd.bp.clear.map((c) => ({ x: c.x + this.origin.x, y: c.y + this.origin.y, z: c.z + this.origin.z })),
    });
    for (const a of order.actions) if (a.op === "scaffold") this.reserved.add(cellKey(a.pos));

    // 4. execute
    let layerY: number | null = null;
    let layerT = Date.now();
    let layerOk = true;
    let failStreak = 0;
    const flushLayer = (): void => {
      if (layerY === null) return;
      ctx.record({
        kind: "step",
        jobId: ctx.jobId,
        op: "layer",
        item: `${kind}:y${layerY - this.origin.y}`,
        ok: layerOk,
        durationMs: Date.now() - layerT,
        failureKind: layerOk ? null : "build_incomplete",
      });
      layerY = null;
    };
    let sinceProgress = 0;
    let reportedFirst = false; // the first block is reported at once: a stop right after it must still leave a resumable record
    for (const a of order.actions) {
      if (this.stopped()) return this.outcome(false, "cancelled", "build cancelled"); // `run` strips the scaffolds
      if (a.op === "place") {
        if (layerY !== a.p.y) {
          flushLayer();
          layerY = a.p.y;
          layerT = Date.now();
          layerOk = true;
        }
      } else flushLayer();

      const ok = await this.perform(a);
      if (ok) failStreak = 0;
      else {
        if (a.op === "place") layerOk = false;
        failStreak += 1;
        if (failStreak >= MAX_FAIL_STREAK) {
          flushLayer();
          return this.outcome(false, "build_incomplete", `${failStreak} placements in a row failed; last: ${this.lastError}`);
        }
      }
      if (++sinceProgress >= 4 || (ok && a.op === "place" && !reportedFirst)) {
        reportedFirst = true;
        sinceProgress = 0;
        ctx.progress(`building ${kind}: ${this.countDone()}/${prepd.total}`, this.countDone());
      }
    }
    flushLayer();
    await this.removeScaffolds();

    // 5. postcondition: count the blueprint's blocks in the world
    const placed = this.countDone();
    const door = prepd.remaining.find((p) => p.role === "door" && !p.derived) ?? prepd.bp.placements.map((q) => ({ ...q, x: q.x + this.origin.x, y: q.y + this.origin.y, z: q.z + this.origin.z })).find((q) => q.role === "door" && !q.derived);
    if (door) this.log(`door column (${door.x}, *, ${door.z}) y${door.y - 1}..y${door.y + 2}: ${[-1, 0, 1, 2].map((dy) => this.blockName({ x: door.x, y: door.y + dy, z: door.z })).join(" | ")}`);
    this.log(`done ${kind}: ${placed}/${prepd.total} at origin (${this.origin.x}, ${this.origin.y}, ${this.origin.z}) facing ${prepd.facing}; ${order.actions.length} actions, ${order.unplaceable.length} unplaceable${this.lastError ? `; last error: ${this.lastError}` : ""}`);
    ctx.progress(`built ${kind}: ${placed}/${prepd.total}`, placed);
    return this.judge(placed);
  }

  private judge(placed: number): BuildOutcome {
    const { prepd } = this;
    const total = prepd.total;
    if (prepd.bp.kind === "farm") {
      const all = [...prepd.remaining];
      const till = all.filter((p) => p.action === "till");
      const crops = all.filter((p) => p.action === "plant");
      const tilled = till.filter((p) => placementDone(this.grid, p)).length;
      const planted = crops.filter((p) => placementDone(this.grid, p)).length;
      const need = Math.min(9, crops.length);
      if (tilled >= till.length - 1 && planted >= need) return this.outcome(true, "internal", `farm ready: ${tilled}/${till.length} cells tilled, ${planted}/${crops.length} crops planted`);
      const why = planted < need ? `only ${planted} of ${need} crops planted (seeds ${this.inv()["wheat_seeds"] ?? 0} left)` : `only ${tilled}/${till.length} cells tilled`;
      return this.outcome(false, planted < need && (this.inv()["wheat_seeds"] ?? 0) === 0 ? "missing_input" : "build_incomplete", `${why}; ${this.lastError}`.trim());
    }
    if (placed >= total) {
      const extra = prepd.bp.kind === "portal" ? " and lit" : "";
      return this.outcome(true, "internal", `built ${prepd.bp.summary}${extra}: ${placed}/${total} blocks`);
    }
    const missing = prepd.remaining.filter((p) => !placementDone(this.grid, p));
    const roles = [...new Set(missing.map((p) => p.role ?? p.block))].slice(0, 4).join(", ");
    return this.outcome(false, "build_incomplete", `placed ${placed}/${total} blocks (missing: ${roles}); ${this.lastError}`.trim());
  }

  /** Between actions: a mob on top of the bot gets fought first (the swing reflex stays out of the Builder, see auto-behaviors). */
  private async guard(): Promise<void> {
    if (this.creative || this.cleaning) return;
    await fightNearbyHostiles(this.bot, () => this.stopped());
  }

  private async perform(a: BuildAction): Promise<boolean> {
    await this.guard();
    switch (a.op) {
      case "place":
        return this.placeCell(a.p);
      case "scaffold": {
        // Record the intent BEFORE placing: a block that shows up after the settle timeout is still ours to remove.
        this.scaffolds.push({ ...a.pos, item: this.scaffoldItem });
        this.syncScaffolds();
        return this.placeCell({ ...a.pos, block: this.scaffoldItem, role: "foundation" }, this.scaffoldItem);
      }
      case "unscaffold": {
        const ok = await this.removeScaffold(a.pos);
        if (ok) this.forget(a.pos);
        return ok;
      }
      case "act":
        return this.act(a.p);
    }
  }

  // ── placement ──────────────────────────────────────────────────────────

  private botCell(): string {
    const p = this.bot.entity.position;
    return `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
  }

  private blockName(c: Cell): string | null {
    return this.grid.blockAt(c.x, c.y, c.z);
  }

  private async placeCell(p: AbsPlacement, itemOverride?: string): Promise<boolean> {
    const { bot } = this;
    if (itemOverride === undefined && placementDone(this.grid, p)) return true;
    const isDoor = p.role === "door";
    let item = itemOverride ?? p.block;
    if (isDoor) item = pickDoor(this.inv(), p.block) ?? p.block;
    if ((this.inv()[item] ?? 0) < 1) {
      if (!this.creative && itemOverride !== undefined && item === "dirt" && (await this.acquire(item, 1))) {
        // a scaffold we dug up never made it back into the inventory: dug a fresh one
      } else if (this.creative) {
        const r = await getItems(bot, { items: [{ name: item, count: isDoor ? 1 : 64 }] });
        if (!r.ok) {
          this.lastError = r.message;
          return false;
        }
      } else {
        this.lastError = `no ${item} left in inventory`;
        this.log(`FAILED ${item} at (${p.x}, ${p.y}, ${p.z}): ${this.lastError}`);
        return false;
      }
    }
    if (isDoor) await this.stepOutside(p);
    else if (!this.creative) await this.ensureReach(p);

    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.stopped()) return false;
      const r = await placeBlock(bot, { type: item, position: { x: p.x, y: p.y, z: p.z } });
      if (r.ok && (await this.settled(p, isDoor))) {
        if (isDoor || p.role === "foundation") this.log(`placed ${item} at (${p.x}, ${p.y}, ${p.z}); bot at ${this.botCell()}`);
        return true;
      }
      this.lastError = r.ok ? `${item} at (${p.x}, ${p.y}, ${p.z}) didn't appear` : r.message;
      this.log(`FAILED ${item} at (${p.x}, ${p.y}, ${p.z}) try ${attempt + 1}: ${this.lastError}; bot at ${this.botCell()}`);
      if (!this.creative) await this.ensureReach(p, true);
      else await sleep(150);
    }
    return false;
  }

  private async settled(p: AbsPlacement, isDoor: boolean): Promise<boolean> {
    const t0 = Date.now();
    do {
      const n = this.blockName(p);
      if (n !== null && (isDoor ? /_door$/.test(n) : n === p.block || n === this.scaffoldItem)) return true;
      await sleep(80);
    } while (Date.now() - t0 < SETTLE_MS);
    return false;
  }

  private insideFootprint(x: number, z: number): boolean {
    return x >= this.origin.x && x < this.origin.x + this.dims.x && z >= this.origin.z && z < this.origin.z + this.dims.z;
  }

  private overlapsBot(c: Cell): boolean {
    const p = this.bot.entity.position;
    return p.x + 0.3 > c.x && p.x - 0.3 < c.x + 1 && p.z + 0.3 > c.z && p.z - 0.3 < c.z + 1 && p.y + 1.8 > c.y && p.y < c.y + 1;
  }

  /** Walkable stand cells from which `target` is within reach, best first. */
  private standSpots(target: Cell, avoidFootprint: boolean): Cell[] {
    const { bot } = this;
    const me = bot.entity.position;
    const tc = new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5);
    const out: Array<{ c: Cell; score: number }> = [];
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        if (dx === 0 && dz === 0) continue;
        for (let dy = -5; dy <= 0; dy++) {
          const c = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
          if (this.reserved.has(cellKey(c)) || this.reserved.has(cellKey({ ...c, y: c.y + 1 }))) continue;
          const feet = bot.blockAt(v(c));
          const head = bot.blockAt(v({ ...c, y: c.y + 1 }));
          const below = bot.blockAt(v({ ...c, y: c.y - 1 }));
          if (!feet || !head || !below) continue;
          if (feet.boundingBox !== "empty" || head.boundingBox !== "empty" || below.boundingBox !== "block") continue;
          if (isWaterName(feet.name) || isWaterName(head.name) || /lava|fire|cactus|magma/.test(feet.name + below.name)) continue;
          const eye = new Vec3(c.x + 0.5, c.y + 1.62, c.z + 0.5);
          if (eye.distanceTo(tc) > REACH) continue;
          const walk = Math.abs(c.x + 0.5 - me.x) + Math.abs(c.z + 0.5 - me.z) + Math.abs(c.y - me.y) * 2;
          const inside = this.insideFootprint(c.x, c.z);
          out.push({ c, score: walk + (inside && avoidFootprint ? 6 : inside ? 1.5 : 0) });
        }
      }
    }
    out.sort((a, b) => a.score - b.score);
    return out.map((o) => o.c);
  }

  /** Make `p` placeable: in reach and not standing in its cell. `force` = move even if already in reach. */
  private async ensureReach(p: Cell, force = false): Promise<void> {
    const { bot } = this;
    const eye = bot.entity.position.offset(0, 1.62, 0);
    const inReach = eye.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) <= REACH;
    if (inReach && !force && !this.overlapsBot(p) && !this.standingInReserved()) return;
    const spots = this.standSpots(p, true).slice(0, force ? 4 : 3);
    for (const s of spots) {
      if (this.stopped()) return;
      if (force && Math.abs(bot.entity.position.x - (s.x + 0.5)) < 0.6 && Math.abs(bot.entity.position.z - (s.z + 0.5)) < 0.6) continue;
      const r = await navigate(bot, new goals.GoalBlock(s.x, s.y, s.z), { label: `a spot to build at (${p.x}, ${p.y}, ${p.z})`, target: v(s), escape: "none" });
      if (r.ok) return;
    }
  }

  private standingInReserved(): boolean {
    const p = this.bot.entity.position;
    const c = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    return this.reserved.has(cellKey(c)) || this.reserved.has(cellKey({ ...c, y: c.y + 1 }));
  }

  /** The door goes in last and from outside: leave the footprint through the gap first. */
  private async stepOutside(door: AbsPlacement): Promise<void> {
    const { bot } = this;
    await this.grounded();
    const f = dirVec(this.prepd.facing);
    const out = { x: door.x + f.x * 2, y: door.y, z: door.z + f.z * 2 };
    const me = bot.entity.position;
    const outside = !this.insideFootprint(Math.floor(me.x), Math.floor(me.z));
    const near = me.distanceTo(new Vec3(door.x + 0.5, door.y, door.z + 0.5)) <= 3.5;
    if (outside && near) return;
    let r = await navigate(bot, new goals.GoalBlock(out.x, out.y, out.z), { label: "outside the doorway", target: v(out), escape: "none" });
    if (!r.ok) r = await navigate(bot, new goals.GoalNear(out.x, out.y, out.z, 2), { label: "outside the doorway", target: v(out), escape: "none" });
    if (!r.ok && this.creative) await flyTo(bot, new Vec3(out.x + 0.5, out.y, out.z + 0.5), "outside the doorway");
  }

  // ── digging (clear / scaffold removal) ─────────────────────────────────

  /** Creative placement may leave the bot hovering; walking steps (pathfinder) need it on the ground. */
  private async grounded(): Promise<void> {
    if (this.creative && isFlying(this.bot)) await land(this.bot);
  }

  private async dig(c: Cell): Promise<boolean> {
    const { bot } = this;
    await this.grounded();
    const b = bot.blockAt(v(c));
    if (!b || isAir(b.name)) return true;
    const eye = bot.entity.position.offset(0, 1.62, 0);
    if (eye.distanceTo(new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5)) > 4.5) {
      const r = await navigate(bot, new goals.GoalNear(c.x, c.y, c.z, 3), { label: `${b.name} at (${c.x}, ${c.y}, ${c.z})`, target: v(c), escape: "none" });
      if (!r.ok) {
        this.lastError = r.message;
        return false;
      }
    }
    const tool = this.toolFor(b.name);
    try {
      if (tool) await bot.equip(tool, "hand");
    } catch {
      // dig by hand
    }
    try {
      await Promise.race([bot.dig(b, true), sleep(this.cleaning ? Math.max(1_000, Math.min(DIG_TIMEOUT_MS, this.cleanupUntil - Date.now())) : DIG_TIMEOUT_MS).then(() => Promise.reject(new Error("dig timed out")))]);
    } catch (err) {
      this.lastError = `dig ${b.name}: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
    return true;
  }

  private toolFor(name: string): ReturnType<Bot["inventory"]["items"]>[number] | undefined {
    const items = this.bot.inventory.items();
    const pick = items.find((i) => i.name.endsWith("_pickaxe"));
    const shovel = items.find((i) => i.name.endsWith("_shovel"));
    if (/stone|cobble|deepslate|netherrack|obsidian|brick|ore/.test(name)) return pick;
    if (/dirt|sand|gravel|clay|grass_block|snow|podzol|mycelium/.test(name)) return shovel;
    return undefined;
  }

  /** Drop `c` from the scaffold list (removed, or no longer ours). */
  private forget(c: Cell): void {
    const i = this.scaffolds.findIndex((x) => x.x === c.x && x.y === c.y && x.z === c.z);
    if (i < 0) return;
    this.scaffolds.splice(i, 1);
    this.syncScaffolds();
  }

  private async removeScaffold(c: Cell): Promise<boolean> {
    const item = this.scaffolds.find((x) => x.x === c.x && x.y === c.y && x.z === c.z)?.item ?? this.scaffoldItem;
    const n = this.blockName(c);
    if (n === null || isAir(n)) return true;
    if (n !== item) return true; // not ours any more
    if (this.overlapsBot(c)) await this.ensureReach(c, true);
    const before = this.inv()[n] ?? 0;
    const ok = await this.dig(c);
    if (ok) await this.collect(n, before); // scaffolds are reused, so the drop must come back
    return ok;
  }

  /** Wait for a dug block's drop to land in the inventory; walk over to it if it doesn't. */
  private async collect(item: string, before: number): Promise<boolean> {
    for (let round = 0; round < 3; round++) {
      const t0 = Date.now();
      while ((this.inv()[item] ?? 0) <= before && Date.now() - t0 < (round === 0 ? 1200 : 500)) await sleep(100);
      if ((this.inv()[item] ?? 0) > before) return true;
      if (this.stopped()) return false;
      const r = await pickUpNearby(this.bot, { maxDist: 6 });
      if ((this.inv()[item] ?? 0) > before) return true;
      this.log(`collect ${item} round ${round + 1}: ${r.message}`);
    }
    return false;
  }

  /** Dig natural ground (outside the site) until the inventory holds `want` of `item` (dirt). */
  /** Ground blocks dug for self-supplied dirt so far (capped at DIRT_DIG_CAP, review M4). */
  private dirtDug = 0;

  private async acquire(item: string, want: number): Promise<boolean> {
    const maxTries = Math.max(10, Math.ceil(want * 1.6)); // a dirt shelter needs ~60 blocks, a portal's scaffold 1-3
    let failed = 0;
    for (let tries = 0; tries < maxTries && (this.inv()[item] ?? 0) < want && failed < 8; tries++) {
      if (this.stopped()) return false;
      if (this.dirtDug >= DIRT_DIG_CAP) {
        this.lastError = `dug the ${DIRT_DIG_CAP}-block limit of natural ground for this build`;
        break;
      }
      const c = this.pickDigCell();
      if (!c) {
        this.lastError = "no diggable ground near the site";
        break;
      }
      await this.guard();
      const before = this.inv()[item] ?? 0;
      if (!(await this.dig(c))) {
        failed += 1;
        continue;
      }
      this.dirtDug += 1;
      if (!(await this.collect(item, before))) failed += 1;
      else failed = 0;
    }
    return (this.inv()[item] ?? 0) >= want;
  }

  /** Nearest natural dirt/grass ground cell clear of the site and of anything a player built (see ../dirt-source.ts). */
  private pickDigCell(): Cell | null {
    const o = this.origin;
    return chooseDirtCell((x, y, z) => this.blockName({ x, y, z }), this.bot.entity.position, {
      site: { minX: o.x, maxX: o.x + this.dims.x - 1, minZ: o.z, maxZ: o.z + this.dims.z - 1 },
    });
  }

  /** Normal end of a build: remove what is still standing. Failures stay on the list (never forgotten). */
  private async removeScaffolds(): Promise<void> {
    const t0 = Date.now();
    const list = [...this.scaffolds].reverse();
    if (list.length === 0) return;
    let ok = true;
    for (const c of list) {
      if (await this.removeScaffold(c)) this.forget(c);
      else ok = false;
    }
    this.ctx.record({ kind: "step", jobId: this.ctx.jobId, op: "scaffold", item: this.scaffoldItem, ok, durationMs: Date.now() - t0, failureKind: ok ? null : "unreachable" });
  }

  /**
   * Remove every scaffold still on the books, even though the stop flag / abort signal that ended the run is
   * still set (those were consumed by ending the run; a NEW stop, death, a dropped connection or
   * {@link CLEANUP_BUDGET_MS} do stop it). Walks back to each block if needed. Entries whose removal fails
   * stay on the list (and in job.json) for the next build or boot.
   */
  async cleanupScaffolds(budgetMs: number = CLEANUP_BUDGET_MS): Promise<void> {
    if (this.scaffolds.length === 0) return;
    if (!this.alive()) {
      this.log(`not removing ${this.scaffolds.length} scaffold block(s): bot is dead or disconnected (kept for the next build/boot)`);
      return;
    }
    const t0 = Date.now();
    getBotState(this.bot.username)?.cancellation.begin();
    this.cleaning = true;
    this.cleanupUntil = t0 + budgetMs;
    let failed = 0;
    try {
      if (isCreative(this.bot) && isFlying(this.bot)) await land(this.bot).catch(() => {});
      for (const c of [...this.scaffolds].reverse()) {
        if (this.stopped()) {
          failed += 1;
          continue;
        }
        if (await this.removeScaffold(c)) this.forget(c);
        else failed += 1;
      }
    } finally {
      this.cleaning = false;
    }
    this.log(`scaffold clean-up: ${failed === 0 ? "done" : `${failed} block(s) left standing: ${this.scaffolds.map((c) => `${c.item}@${c.x},${c.y},${c.z}`).join(" ")}`}`);
    this.ctx.record({ kind: "step", jobId: this.ctx.jobId, op: "scaffold", item: this.scaffoldItem, ok: failed === 0, durationMs: Date.now() - t0, failureKind: failed === 0 ? null : "unreachable" });
  }

  // ── farm / portal actions ──────────────────────────────────────────────

  private async act(p: AbsPlacement): Promise<boolean> {
    await this.grounded();
    switch (p.action) {
      case "till":
        return this.till(p);
      case "plant":
        return this.plant(p);
      case "water":
        return this.water(p);
      case "ignite":
        return this.ignite(p);
      default:
        return true;
    }
  }

  private async pollBlock(c: Cell, match: (n: string) => boolean, ms = 1500): Promise<boolean> {
    const t0 = Date.now();
    do {
      const n = this.blockName(c);
      if (n !== null && match(n)) return true;
      await sleep(80);
    } while (Date.now() - t0 < ms);
    return false;
  }

  private async till(p: AbsPlacement): Promise<boolean> {
    const n = this.blockName(p);
    if (n === "farmland" || (n !== null && isWaterName(n))) return true;
    const hoe = pickHoe(this.inv());
    if (!hoe) {
      this.lastError = "no hoe in inventory";
      return false;
    }
    const above = { x: p.x, y: p.y + 1, z: p.z };
    const an = this.blockName(above);
    if (an !== null && !isAir(an) && isReplaceable(an)) await this.dig(above);
    for (let i = 0; i < 2; i++) {
      if (this.stopped()) return false;
      const r = await activateBlock(this.bot, { position: { x: p.x, y: p.y, z: p.z }, with: hoe });
      if (r.ok && (await this.pollBlock(p, (b) => b === "farmland"))) return true;
      this.lastError = r.ok ? `${n ?? "?"} at (${p.x}, ${p.y}, ${p.z}) didn't turn into farmland` : r.message;
    }
    return false;
  }

  private async plant(p: AbsPlacement): Promise<boolean> {
    if (placementDone(this.grid, p)) return true;
    const ground = { x: p.x, y: p.y - 1, z: p.z };
    const gn = this.blockName(ground);
    if (gn !== "farmland") {
      this.lastError = `nothing to plant on at (${ground.x}, ${ground.y}, ${ground.z}) (${gn ?? "unloaded"})`;
      return false;
    }
    if ((this.inv()["wheat_seeds"] ?? 0) < 1) {
      this.lastError = "out of wheat_seeds";
      return true; // partial planting is judged at the end
    }
    for (let i = 0; i < 2; i++) {
      if (this.stopped()) return false;
      const r = await activateBlock(this.bot, { position: ground, with: "wheat_seeds" });
      if (r.ok && (await this.pollBlock(p, (b) => b === "wheat"))) return true;
      this.lastError = r.ok ? `seeds at (${p.x}, ${p.y}, ${p.z}) didn't take` : r.message;
    }
    return false;
  }

  private async water(p: AbsPlacement): Promise<boolean> {
    const n = this.blockName(p);
    if (n !== null && isWaterName(n)) return true;
    if ((this.inv()["water_bucket"] ?? 0) < 1) {
      this.lastError = "no water_bucket";
      return false;
    }
    // stand on the plot next to the hole, not in it
    const stand = { x: p.x, y: p.y + 1, z: p.z + 1 };
    await navigate(this.bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { label: "beside the water spot", target: v(stand), escape: "none" });
    if (n !== null && !isAir(n) && !(await this.dig(p))) return false;
    const below = { x: p.x, y: p.y - 1, z: p.z };
    for (let i = 0; i < 2; i++) {
      if (this.stopped()) return false;
      const r = await activateBlock(this.bot, { position: below, with: "water_bucket" });
      if (r.ok && (await this.pollBlock(p, (b) => isWaterName(b), 2000))) return true;
      this.lastError = r.ok ? "water didn't appear" : r.message;
    }
    return false;
  }

  private async ignite(p: AbsPlacement): Promise<boolean> {
    const { bot } = this;
    if (placementDone(this.grid, p)) return true;
    if ((this.inv()["flint_and_steel"] ?? 0) < 1) {
      this.lastError = "no flint_and_steel";
      return false;
    }
    const f = dirVec(this.prepd.facing);
    // stand two blocks out on the front side so the lit portal isn't walked into
    const stand = { x: p.x + f.x * 2, y: p.y - 1, z: p.z + f.z * 2 };
    await navigate(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { label: "in front of the portal", target: v(stand), escape: "none" });
    const frameBlock = { x: p.x, y: p.y - 1, z: p.z };
    for (let i = 0; i < 2; i++) {
      if (this.stopped()) return false;
      const r = await activateBlock(bot, { position: frameBlock, with: "flint_and_steel" });
      if (r.ok && (await this.pollBlock(p, (b) => b === "nether_portal", 4000))) {
        // step well clear of the portal plane (standing in it teleports after a few seconds)
        const away = { x: p.x + f.x * 4, y: p.y - 1, z: p.z + f.z * 4 };
        await navigate(bot, new goals.GoalNear(away.x, away.y, away.z, 1), { label: "away from the portal", target: v(away), escape: "none" });
        this.ctx.record({ kind: "step", jobId: this.ctx.jobId, op: "light", item: "nether_portal", ok: true, durationMs: 0, failureKind: null });
        return true;
      }
      this.lastError = r.ok ? "the portal didn't light (frame incomplete?)" : r.message;
    }
    this.ctx.record({ kind: "step", jobId: this.ctx.jobId, op: "light", item: "nether_portal", ok: false, durationMs: 0, failureKind: "build_incomplete" });
    return false;
  }
}
