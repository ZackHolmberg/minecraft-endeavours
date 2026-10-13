/**
 * Bot-bound half of the `find` job (pure logic: src/jobs/find.ts; contract: runner.ts `FindDeps`).
 *
 *   known  -> remembered sightings (world.json pois of the block) beyond the loaded chunks are walked toward
 *   scan   -> every matching block in the loaded chunks (buried ore is visible there), cheapest first
 *   explore-> nothing known: underground targets get a staircase down to the ore's Y band + a branch tunnel
 *             (relocating away from water first, like the recovery ladder), surface targets a spiral walk
 *   act    -> "point": stand next to it; "mine": take `count`; "report": just the coordinates
 *
 * The whole search runs inside one `runSkill("find")` (holds the current-tool slot so the idle-look / auto-eat reflexes
 * stay off mid-dig, like `explore`), no 10-minute watchdog: the runner owns the 10-minute job cap and cooperative cancel.
 * It reuses `Explorer` (src/jobs/explore.ts) for the staircase, branch tunnel, spiral walk, relocation and the new
 * `tunnelToward` (a directed staircase to a seen-but-buried block).
 */
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { addPoi, readWorldKnowledge } from "../../memory/world-knowledge.js";
import { runSkill } from "../../skills/harness.js";
import { navigate } from "../../skills/navigation.js";
import { ensureMovements, type BotWithPathfinder } from "../../skills/pathfinder-config.js";
import { mineBlocks } from "../../skills/world.js";
import { Explorer, isLiquidName } from "../explore.js";
import { touchesLiquid } from "../exhausted.js";
import {
  FIND_ARRIVE,
  FIND_MAX_FROM_START,
  FIND_SCAN_RADIUS,
  FIND_SEARCH_MS,
  candKey,
  fmtPos,
  mineRefusal,
  planFind,
  rankFindCandidates,
  type FindCandidate,
} from "../find.js";
import type { FindDeps, FindRunContext, StepRunContext } from "../runner.js";
import type { FindOutcome, FindState } from "../types.js";
import { classifyFailure } from "./classify.js";

const { goals } = pathfinderPkg;

/** Stone-like blocks: if none is within this many blocks the bot stands in a lake / on a beach and digging down is hopeless. */
const GROUND_BLOCKS = ["stone", "deepslate", "andesite", "diorite", "granite", "tuff"];
const GROUND_RADIUS = 32;
const MAX_ROUNDS = 14;
const MAX_EXPLORES = 3;
const MAX_RELOCATIONS = 2;
const APPROACH_NAV_TIMEOUT_MS = 90_000;
const WALK_HOP = 40;
const WALK_MAX_HOPS = 8;

export function createFindDeps(bot: Bot): FindDeps {
  return { run: (spec, ctx) => runFind(bot, spec, ctx) };
}

async function runFind(bot: Bot, spec: FindState, ctx: FindRunContext): Promise<FindOutcome> {
  let outcome: FindOutcome = { ok: false, kind: "internal", detail: "find did not run" };
  await runSkill(
    bot,
    "find",
    { block: spec.block, action: spec.action },
    async () => {
      try {
        outcome = await findBody(bot, spec, ctx);
      } catch (err) {
        outcome = { ok: false, kind: "internal", detail: `find crashed: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: outcome.ok, message: outcome.detail };
    },
    { watchdogMs: null },
  );
  return outcome;
}

async function findBody(bot: Bot, spec: FindState, ctx: FindRunContext): Promise<FindOutcome> {
  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);
  const tag = `[${bot.username}] job find`;
  const ids = spec.blocks.map((b) => bot.registry.blocksByName[b]?.id).filter((i): i is number => i !== undefined);
  if (ids.length === 0) return { ok: false, kind: "unknown_item", detail: `no such block: ${spec.block}` };
  if (spec.action === "mine") {
    const refusal = mineRefusal({ name: spec.block, blocks: spec.blocks });
    if (refusal) return { ok: false, kind: "internal", detail: refusal };
  }
  const plan = planFind(spec.blocks);
  const start = bot.entity.position.clone();
  spec.origin = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  const searchUntil = Math.min(ctx.deadline - 25_000, Date.now() + FIND_SEARCH_MS);
  const dead = new Set<string>();
  const notes: string[] = [];
  const exCtx: StepRunContext = { signal: ctx.signal, radius: 64, baseline: 0, jobId: ctx.jobId };
  const aborted = (): boolean => ctx.signal.aborted;
  const timeUp = (): boolean => Date.now() > searchUntil;
  const nameAt = (x: number, y: number, z: number): string | null => bot.blockAt(new Vec3(x, y, z))?.name ?? null;
  const targetIsLiquid = spec.blocks.some((b) => isLiquidName(b));
  const wantsDry = !targetIsLiquid;
  const cancelled = (): FindOutcome => ({ ok: false, kind: "cancelled", detail: "cancelled" });
  const explorer = (): Explorer => new Explorer(bot, ids, exCtx, { surfaceFoundRadius: 80, tunnelFoundRadius: 48, origin: start });
  const eyeDist = (c: { x: number; y: number; z: number }): number => bot.entity.position.offset(0, 1, 0).distanceTo(new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5));
  const record = (rung: string, detail: string): void => ctx.record({ kind: "recovery", jobId: ctx.jobId, rung, detail: detail.slice(0, 200) });

  // remembered sightings (auto-captured by earlier finds / `remember`): only matter beyond the loaded chunks
  let sightings: FindCandidate[] = [];
  try {
    const world = await readWorldKnowledge(bot.username);
    sightings = world.pois.filter((p) => spec.blocks.includes(p.type)).map((p) => ({ x: p.position.x, y: p.position.y, z: p.position.z, known: true }));
  } catch {
    // memory is a bonus
  }

  /** Matching blocks in the loaded chunks plus unloaded remembered sightings, cheapest first. */
  const scan = (): FindCandidate[] => {
    const here = bot.entity.position;
    const seen = new Map<string, FindCandidate>();
    for (const p of bot.findBlocks({ point: here, matching: ids, maxDistance: FIND_SCAN_RADIUS, count: 400 })) {
      const c: FindCandidate = { x: p.x, y: p.y, z: p.z };
      if (wantsDry && spec.action !== "report") {
        // lava beside ore is a death trap; water beside it a drowning trap: skip lava, rank water-side ore last
        let lava = false;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
          const n = nameAt(p.x + dx, p.y + dy, p.z + dz);
          if (n === "lava" || n === "flowing_lava") lava = true;
        }
        if (lava) continue;
      }
      seen.set(candKey(c), c);
    }
    for (const s of sightings) {
      const b = bot.blockAt(new Vec3(s.x, s.y, s.z));
      if (b === null || spec.blocks.includes(b.name)) seen.set(candKey(s), s);
    }
    const ranked = rankFindCandidates([...seen.values()], here, start, dead, FIND_MAX_FROM_START);
    if (!wantsDry) return ranked;
    // water-side ore behind dry ore of similar cost: stable partition
    const dry = ranked.filter((c) => !touchesLiquid(nameAt, c.x, c.y, c.z));
    const wet = ranked.filter((c) => touchesLiquid(nameAt, c.x, c.y, c.z));
    return dry.length > 0 && spec.action !== "report" ? [...dry, ...wet] : ranked;
  };

  const exposed = (c: FindCandidate): boolean => {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const b = bot.blockAt(new Vec3(c.x + dx, c.y + dy, c.z + dz));
      if (b && b.boundingBox === "empty" && !isLiquidName(b.name)) return true;
    }
    return false;
  };

  const hasGround = (): boolean => bot.findBlock({ point: bot.entity.position, matching: GROUND_BLOCKS.map((n) => bot.registry.blocksByName[n]?.id).filter((i): i is number => i !== undefined), maxDistance: GROUND_RADIUS }) !== null;

  /** Walk toward an unloaded remembered sighting in hops; the next scan sees the chunks that load on the way. */
  const walkToward = async (c: FindCandidate): Promise<boolean> => {
    for (let hop = 0; hop < WALK_MAX_HOPS && !aborted() && !timeUp(); hop++) {
      const p = bot.entity.position;
      const left = Math.hypot(c.x - p.x, c.z - p.z);
      if (left <= 24 || bot.blockAt(new Vec3(c.x, c.y, c.z)) !== null) return true;
      const f = Math.min(WALK_HOP, left) / left;
      const hx = p.x + (c.x - p.x) * f;
      const hz = p.z + (c.z - p.z) * f;
      const r = await navigate(bot, new goals.GoalNearXZ(Math.round(hx), Math.round(hz), 3), { label: "find: remembered sighting", target: new Vec3(hx, p.y, hz), escape: "none" });
      if (!r.ok) return false;
    }
    return bot.blockAt(new Vec3(c.x, c.y, c.z)) !== null;
  };

  /** Get within FIND_ARRIVE of the block: walk if it is exposed / near the surface, tunnel down to it if it is buried. */
  const approach = async (c: FindCandidate): Promise<{ ok: boolean; detail: string }> => {
    if (bot.blockAt(new Vec3(c.x, c.y, c.z)) === null) {
      ctx.progress(`walking toward a remembered ${spec.block} at ${fmtPos(c)}`);
      if (!(await walkToward(c))) return { ok: false, detail: "could not walk to the remembered spot" };
      return { ok: false, detail: "remembered sighting is stale or not loaded yet; rescanning" };
    }
    if (eyeDist(c) <= FIND_ARRIVE) return { ok: true, detail: "already there" };
    const target = new Vec3(c.x, c.y, c.z);
    const feetY = Math.floor(bot.entity.position.y);
    const deep = c.y <= feetY - 4;
    const buried = !exposed(c);
    let navNote = "";
    if (!(deep && buried)) {
      ctx.progress(`walking to ${spec.block} at ${fmtPos(c)}`);
      const r = await navigate(bot, new goals.GoalNear(c.x, c.y, c.z, 2), {
        label: `${spec.block} at ${fmtPos(c)}`,
        target: target.offset(0.5, 0.5, 0.5),
        timeoutMs: APPROACH_NAV_TIMEOUT_MS,
        escape: "none",
      });
      if (aborted()) return { ok: false, detail: "cancelled" };
      if (r.ok && eyeDist(c) <= FIND_ARRIVE + 0.6) return { ok: true, detail: "walked there" };
      navNote = r.message;
      if (c.y > feetY + 2) return { ok: false, detail: `no way up to it: ${navNote}` };
    }
    ctx.progress(`digging down to ${spec.block} at ${fmtPos(c)}`);
    record("explore", `tunnelling to ${spec.block} at ${fmtPos(c)}`);
    const t = await explorer().tunnelToward(target, FIND_ARRIVE, Math.max(30_000, searchUntil - Date.now()));
    if (t.ok) return { ok: true, detail: "tunnelled there" };
    return { ok: false, detail: `${t.detail}${navNote ? ` (walking: ${navNote})` : ""}` };
  };

  const remember = async (c: FindCandidate): Promise<void> => {
    try {
      if (sightings.some((s) => Math.hypot(s.x - c.x, s.y - c.y, s.z - c.z) <= 6)) return;
      await addPoi(bot.username, { type: spec.block, position: { x: c.x, y: c.y, z: c.z }, source: "auto" });
    } catch {
      // memory is a bonus
    }
  };

  /** At the block: do what was asked. */
  const act = async (c: FindCandidate): Promise<FindOutcome> => {
    const found = { x: c.x, y: c.y, z: c.z, block: bot.blockAt(new Vec3(c.x, c.y, c.z))?.name ?? spec.block };
    void remember(c);
    spec.found = found;
    if (spec.action === "report") return { ok: true, found, detail: `${found.block} at ${fmtPos(c)}` };
    if (spec.action === "point") {
      await bot.lookAt(new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5)).catch(() => undefined);
      return { ok: true, found, detail: `standing next to ${found.block} at ${fmtPos(c)}` };
    }
    ctx.progress(`mining ${spec.block} at ${fmtPos(c)}`);
    const r = await mineBlocks(bot, { types: spec.blocks, maxCount: spec.count, maxDistance: 16 });
    if (aborted()) return cancelled();
    const mined = (r.state as { mined?: number; collected?: number } | undefined)?.mined ?? 0;
    const collected = (r.state as { collected?: number } | undefined)?.collected ?? 0;
    if (mined > 0) return { ok: true, found, detail: `mined ${mined} ${spec.block}${collected > 0 ? ` (${r.message.replace(/^collected /, "collected ")})` : " (creative: nothing drops)"}` };
    const kind = classifyFailure(r.message, r.state, "unreachable");
    return { ok: false, kind, found, detail: `found ${found.block} at ${fmtPos(c)} but couldn't mine it: ${r.message}` };
  };

  let explores = 0;
  let relocations = 0;
  /** After a search came up empty, try a different place before the next one (not the same tunnels again). */
  let needMove = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (aborted()) return cancelled();
    if (timeUp()) break;
    const cands = scan();
    if (cands.length > 0) {
      const c = cands[0]!;
      if (spec.action === "report" && bot.blockAt(new Vec3(c.x, c.y, c.z)) !== null) return act(c);
      ctx.progress(`found ${spec.block} at ${fmtPos(c)} (${Math.round(Math.hypot(c.x - start.x, c.z - start.z))} blocks out); going there`);
      console.log(`${tag}: ${spec.block} at ${fmtPos(c)}${c.known ? " (remembered)" : ""}; approaching`);
      const ap = await approach(c);
      if (aborted()) return cancelled();
      if (ap.ok) return act(c);
      if (!ap.detail.includes("rescanning")) {
        dead.add(candKey(c));
        notes.push(`${fmtPos(c)}: ${ap.detail}`);
        console.log(`${tag}: gave up on ${fmtPos(c)}: ${ap.detail}`);
      } else {
        sightings = sightings.filter((s) => candKey(s) !== candKey(c));
      }
      continue;
    }

    // nothing known or visible: explore
    if (explores >= MAX_EXPLORES) break;
    const wet = plan.kind === "underground" && !hasGround();
    if ((wet || needMove) && relocations < MAX_RELOCATIONS) {
      relocations += 1;
      needMove = false;
      ctx.progress(wet ? `no stone within ${GROUND_RADIUS} blocks here (water?); moving to drier land` : "nothing here; trying another area");
      record("relocate", wet ? `no stone within ${GROUND_RADIUS} blocks; moving away from the water` : "search came up empty; moving to another area");
      const here = bot.entity.position;
      const out = await explorer().relocate([{ x: Math.round(here.x), z: Math.round(here.z), r: wet ? GROUND_RADIUS : 40 }]);
      notes.push(`relocated: ${out.detail}`);
      if (!out.moved && wet) break;
      continue;
    }
    explores += 1;
    ctx.progress(plan.kind === "underground" ? `digging down for ${spec.block} (Y ${plan.yRange?.[0]}..${plan.yRange?.[1]})` : `searching on foot for ${spec.block}`);
    record("explore", `${plan.kind} search for ${spec.block} (${explores}/${MAX_EXPLORES})`);
    const ex = explorer();
    const out = plan.kind === "underground" ? await ex.underground(plan.yRange) : await ex.surface();
    if (aborted()) return cancelled();
    console.log(`${tag}: explore ${plan.kind}: ${out.found ? "found" : "gave up"} — ${out.detail}`);
    if (out.found) continue;
    notes.push(out.detail);
    needMove = true;
    // Dead end: climb back out (underground), then try a different place on the surface.
    if (!timeUp()) await ex.returnToStart(out, plan.kind === "underground");
  }

  const where = `within ${FIND_MAX_FROM_START} blocks of where I started (${spec.origin.x}, ${spec.origin.y}, ${spec.origin.z})`;
  const why = notes.length > 0 ? `: ${notes.slice(-3).join("; ")}` : "";
  return { ok: false, kind: "no_source", detail: `no reachable ${spec.block} found ${where}${timeUp() ? " in the time I had" : ""}${why}`.slice(0, 240) };
}
