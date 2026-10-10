/**
 * Night survival executor (v2 slice 2c-B): the bot-bound half of a `surviveNight` job.
 *
 *  - `sleepThrough`: a bed is at hand (nearby, or carried and placed): `sleepIn`, then wait for dawn
 *    (re-sleeping if something woke the bot).
 *  - `holdInShelter`: the `shelter` blueprint is built. Open the door, walk to the middle, close it
 *    (a door-less hut is plugged with two wall blocks instead), set a torch in a back corner when
 *    the bot carries one (mobs spawn on dark floor, also inside), then WAIT for dawn and come out.
 *
 * The wait is NOT inside a tracked skill, so the reflexes (auto-eat, the defensive swing, weapon
 * ready) keep working; only the enter / seal / light and exit parts are tracked skills.
 */
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { Cell } from "../../build/types.js";
import type { Step } from "../../planner/types.js";
import { activateBlock } from "../../skills/interaction.js";
import { navigate } from "../../skills/navigation.js";
import { sleepIn } from "../../skills/survival.js";
import { placeBlock } from "../../skills/world.js";
import { placeFromInventoryNearby } from "../../skills/place-helper.js";
import { fightNearbyHostiles } from "../../skills/melee-guard.js";
import { PILLAR_FILLER_PRIORITY, pickFiller, pillarUpBy, waitForGrounded } from "../../skills/pillar.js";
import { getBotState } from "../../state/index.js";
import { inNightWindow, type ShelterGeometry } from "../night.js";
import { choosePocket, type PocketPlan, type Probe } from "../pocket.js";
import type { NightDeps, StepRunContext } from "../runner.js";
import type { StepResult } from "../types.js";
import { tracked } from "./util.js";

const { goals } = pathfinderPkg;

const POLL_MS = 1000;
const BED_RADIUS = 32;
const MAX_SLEEP_TRIES = 3;
/** Used when the server clock is unknown: one night. */
const FALLBACK_WAIT_MS = 9 * 60_000;
const EXIT_BUDGET_MS = 25_000;
const PLACEHOLDER: Step = { op: "place_station", block: "crafting_table" };

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const v = (c: Cell): Vec3 => new Vec3(c.x, c.y, c.z);
const okR = (detail: string): StepResult => ({ ok: true, detail });
const failR = (kind: "cancelled" | "internal" | "unreachable" | "missing_input" | "died", detail: string): StepResult => ({
  ok: false,
  failure: { kind, step: PLACEHOLDER, detail, attempts: 1 },
});

export function createNightDeps(bot: Bot): NightDeps {
  return {
    timeOfDay: () => timeOfDay(bot),
    findBed: () => findBed(bot),
    sleepThrough: (ctx) => sleepThrough(bot, ctx),
    holdInShelter: (geo, ctx) => holdInShelter(bot, geo, ctx),
    planPocket: () => planPocket(bot),
    digInThrough: (plan, ctx) => digInThrough(bot, plan, ctx),
  };
}

function timeOfDay(bot: Bot): number | null {
  const t = (bot as { time?: { timeOfDay?: number } }).time?.timeOfDay;
  return typeof t === "number" && Number.isFinite(t) ? t : null;
}

function bedItem(bot: Bot): string | null {
  return bot.inventory.items().find((i) => i.name.endsWith("_bed"))?.name ?? null;
}

function nearbyBed(bot: Bot): { name: string; pos: Vec3 } | null {
  const ids = bot.registry.blocksArray.filter((b) => b.name.endsWith("_bed")).map((b) => b.id);
  if (ids.length === 0) return null;
  const b = bot.findBlock({ point: bot.entity.position, matching: ids, maxDistance: BED_RADIUS });
  return b ? { name: b.name, pos: b.position } : null;
}

/** A bed the bot can sleep in right now. */
function findBed(bot: Bot): string | null {
  const b = nearbyBed(bot);
  if (b) return `${b.name} at (${b.pos.x}, ${b.pos.y}, ${b.pos.z})`;
  const held = bedItem(bot);
  return held ? `the ${held} I carry` : null;
}

function stopped(bot: Bot, ctx: StepRunContext): boolean {
  return ctx.signal.aborted || getBotState(bot.username)?.cancellation.isRequested() === true;
}

function alive(bot: Bot): boolean {
  return !!bot.entity && !(typeof bot.health === "number" && bot.health <= 0);
}

function log(bot: Bot, msg: string): void {
  console.log(`[${bot.username}] night ${msg}`);
}

/** Poll until dawn. `wakeCheck`: stop early (returns "woke") when it says so. */
async function waitForDawn(bot: Bot, ctx: StepRunContext, wakeCheck?: () => boolean): Promise<"dawn" | "cancelled" | "dead" | "woke"> {
  const t0 = Date.now();
  while (true) {
    if (stopped(bot, ctx)) return "cancelled";
    if (!alive(bot)) return "dead";
    const t = timeOfDay(bot);
    if (t !== null ? !inNightWindow(t) : Date.now() - t0 > FALLBACK_WAIT_MS) return "dawn";
    if (wakeCheck?.()) return "woke";
    await sleepMs(POLL_MS);
  }
}

async function sleepThrough(bot: Bot, ctx: StepRunContext): Promise<StepResult> {
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_SLEEP_TRIES; attempt++) {
    if (stopped(bot, ctx)) return failR("cancelled", "cancelled");
    const t = timeOfDay(bot);
    if (t !== null && !inNightWindow(t)) return okR("it was already morning");
    if (!nearbyBed(bot)) {
      const held = bedItem(bot);
      if (held) {
        const r = await placeFromInventoryNearby(bot, held);
        if (!r.ok) lastErr = r.message;
      }
    }
    const r = await tracked(bot, "sleepIn", {}, () => sleepIn(bot, {}));
    if (!r.ok) {
      lastErr = r.message;
      log(bot, `sleep attempt ${attempt} failed: ${r.message}`);
      await sleepMs(3000); // a mob nearby / not tired yet: the defend reflex gets a few seconds
      continue;
    }
    log(bot, `sleeping: ${r.message}`);
    const res = await waitForDawn(bot, ctx, () => !bot.isSleeping);
    if (res === "dawn") return okR(`slept through the night (${r.message})`);
    if (res === "cancelled") return failR("cancelled", "cancelled");
    if (res === "dead") return failR("died", "died during the night");
    lastErr = "woke up before dawn (something hit me?)";
  }
  return failR("internal", `couldn't sleep through the night: ${lastErr || "no bed worked"}. Try surviveNight with useBed:false to build a shelter instead`);
}

function doorOpen(bot: Bot, pos: Cell): boolean | null {
  const b = bot.blockAt(v(pos));
  if (!b || !/_door$/.test(b.name)) return null;
  const props = (b as { getProperties?: () => Record<string, unknown> }).getProperties?.() ?? {};
  return String(props.open) === "true";
}

async function toggleDoor(bot: Bot, pos: Cell, wantOpen: boolean): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const open = doorOpen(bot, pos);
    if (open === null) return false;
    if (open === wantOpen) return true;
    await activateBlock(bot, { position: pos });
    const t0 = Date.now();
    while (Date.now() - t0 < 1200) {
      if (doorOpen(bot, pos) === wantOpen) return true;
      await sleepMs(80);
    }
  }
  return doorOpen(bot, pos) === wantOpen;
}

const solid = (bot: Bot, c: Cell): boolean => bot.blockAt(v(c))?.boundingBox === "block";

async function goTo(bot: Bot, c: Cell, label: string): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    const r = await navigate(bot, new goals.GoalBlock(c.x, c.y, c.z), { label, target: new Vec3(c.x + 0.5, c.y, c.z + 0.5), escape: "none" });
    if (r.ok) return true;
  }
  return false;
}

/** Get inside and close the shelter. Returns an error text, or null when sealed. */
async function enterAndSeal(bot: Bot, geo: ShelterGeometry, wall: string): Promise<string | null> {
  const [lo, hi] = geo.doorway;
  if (geo.hasDoor) {
    if (doorOpen(bot, lo) === null) return "the door isn't there (the build didn't finish?)";
    if (!(await toggleDoor(bot, lo, true))) return "couldn't open the door";
  } else if (solid(bot, lo) || solid(bot, hi)) {
    return "the doorway is blocked";
  }
  if (!(await goTo(bot, geo.centre, "into the shelter"))) return "couldn't get inside";
  if (geo.hasDoor) {
    if (!(await toggleDoor(bot, lo, false))) return "couldn't close the door";
    return null;
  }
  // door-less: plug the 2-high doorway from the cell right behind it
  if (!(await goTo(bot, geo.inside, "behind the doorway"))) return "couldn't reach the doorway to plug it";
  for (const c of [lo, hi]) {
    for (let i = 0; i < 3 && !solid(bot, c); i++) {
      const r = await placeBlock(bot, { type: wall, position: { x: c.x, y: c.y, z: c.z } });
      if (!r.ok) await sleepMs(300);
      else await sleepMs(200);
    }
    if (!solid(bot, c)) return `couldn't plug the doorway with ${wall}`;
  }
  return null;
}

async function lightUp(bot: Bot, geo: ShelterGeometry): Promise<boolean> {
  if (!bot.inventory.items().some((i) => i.name === "torch")) return false;
  const c = geo.corner;
  const near = bot.entity.position.distanceTo(v(c));
  if (near > 3.5) await goTo(bot, geo.centre, "to light the shelter");
  const r = await placeBlock(bot, { type: "torch", position: { x: c.x, y: c.y, z: c.z } });
  return r.ok;
}

async function leave(bot: Bot, geo: ShelterGeometry, wall: string): Promise<void> {
  const t0 = Date.now();
  const [lo, hi] = geo.doorway;
  try {
    if (geo.hasDoor) await toggleDoor(bot, lo, true);
    else {
      for (const c of [hi, lo]) {
        const b = bot.blockAt(v(c));
        if (b && b.name === wall && Date.now() - t0 < EXIT_BUDGET_MS) await bot.dig(b).catch(() => undefined);
      }
    }
    if (Date.now() - t0 < EXIT_BUDGET_MS) await goTo(bot, geo.outside, "out of the shelter");
  } catch {
    // best effort: the night is over either way
  }
}

async function holdInShelter(bot: Bot, geo: ShelterGeometry, ctx: StepRunContext): Promise<StepResult> {
  const wallBlock = geo.wall;
  let err: string | null = "not started";
  let lit = false;
  await tracked(bot, "shelter", { at: geo.centre }, async () => {
    err = await enterAndSeal(bot, geo, wallBlock);
    if (!err) lit = await lightUp(bot, geo);
    return { ok: !err, message: err ?? `sealed in${lit ? ", torch lit" : ""}` };
  });
  if (stopped(bot, ctx)) return failR("cancelled", "cancelled");
  if (!alive(bot)) return failR("died", "died before the night began");
  if (err) return failR("unreachable", `couldn't shelter: ${err}`);
  log(bot, `inside the shelter (${geo.hasDoor ? "door closed" : "doorway plugged"}${lit ? ", torch lit" : ", no torch"}); waiting for dawn`);
  const res = await waitForDawn(bot, ctx);
  if (res === "cancelled") return failR("cancelled", "cancelled");
  if (res === "dead") return failR("died", "died in the shelter");
  await tracked(bot, "shelter", { leave: true }, async () => {
    await leave(bot, geo, wallBlock);
    return { ok: true, message: "left the shelter" };
  });
  return okR(`waited out the night in a ${geo.hasDoor ? "door-closed" : "plugged"} shelter${lit ? " with a torch" : ""} and walked out at dawn`);
}


// ── quick shelter: dig in ───────────────────────────────────────────────────

const DIG_TIMEOUT_MS = 25_000;
const SEAL_TRIES = 4;

const countOf = (bot: Bot, names: readonly string[]): number =>
  bot.inventory.items().filter((i) => names.includes(i.name)).reduce((n, i) => n + i.count, 0);
const hasPickaxe = (bot: Bot): boolean => bot.inventory.items().some((i) => /_pickaxe$/.test(i.name));

function probeOf(bot: Bot): Probe {
  return (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z));
    return b ? { name: b.name, solid: b.boundingBox === "block" } : null;
  };
}

/** Where to dig a 1x2 pocket near the bot, or null. Cheap world read, no side effects. */
function planPocket(bot: Bot): PocketPlan | null {
  if (!bot.entity) return null;
  const p = bot.entity.position.floored();
  const plan = choosePocket(probeOf(bot), { x: p.x, y: p.y, z: p.z }, {
    hasPickaxe: hasPickaxe(bot),
    filler: countOf(bot, PILLAR_FILLER_PRIORITY),
  });
  if (plan) log(bot, `pocket plan: ${plan.summary} (~${plan.cost.toFixed(1)}s, yields ${plan.yields})`);
  else log(bot, "no safe spot to dig in nearby");
  return plan;
}

async function equipForDig(bot: Bot, block: { name: string }): Promise<void> {
  try {
    const pf = (bot as Bot & { pathfinder?: { bestHarvestTool?(b: unknown): { type: number } | null } }).pathfinder;
    const tool = pf?.bestHarvestTool?.(block);
    if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool as never, "hand");
  } catch {
    // bare hands are fine for dirt
  }
}

async function digCell(bot: Bot, c: Cell): Promise<string | null> {
  const b = bot.blockAt(v(c));
  if (!b) return `(${c.x}, ${c.y}, ${c.z}) isn't loaded`;
  if (b.boundingBox !== "block") return null; // already open
  await waitForGrounded(bot, 1500);
  await equipForDig(bot, b);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      bot.dig(b),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          try { bot.stopDigging?.(); } catch { /* best effort */ }
          rej(new Error(`dig timeout after ${DIG_TIMEOUT_MS}ms`));
        }, DIG_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    return `couldn't dig ${b.name} at (${c.x}, ${c.y}, ${c.z}): ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return null;
}

/** Wait (bounded) for the bot to stand in the cell column `c` at height <= c.y + 0.3 (it falls into a dug shaft). */
async function settleAt(bot: Bot, c: Cell, maxMs = 1500): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const p = bot.entity.position;
    if (Math.floor(p.x) === c.x && Math.floor(p.z) === c.z && p.y <= c.y + 0.3 && bot.entity.onGround) return;
    await sleepMs(60);
  }
}

const isOpen = (bot: Bot, c: Cell): boolean => {
  const b = bot.blockAt(v(c));
  return !!b && b.boundingBox !== "block" && !/^(water|lava)$/.test(b.name);
};

/** Shuffle onto the middle of the column so the 0.6-wide body drops cleanly into a 1-wide shaft. */
async function centreOn(bot: Bot, x: number, z: number): Promise<void> {
  try {
    bot.setControlState("sneak", true); // slow and exact; also keeps us from stumbling off
    for (let i = 0; i < 25; i++) {
      const p = bot.entity.position;
      const dx = x + 0.5 - p.x;
      const dz = z + 0.5 - p.z;
      if (Math.hypot(dx, dz) < 0.12) break;
      await bot.lookAt(new Vec3(x + 0.5, p.y + 1.6, z + 0.5), true);
      bot.setControlState("forward", true);
      await sleepMs(Math.hypot(dx, dz) > 0.5 ? 120 : 45);
      bot.setControlState("forward", false);
      await sleepMs(70);
    }
  } finally {
    bot.setControlState("forward", false);
    bot.setControlState("sneak", false);
  }
}

/** Dig from inside out and seal. Returns an error text, or null when sealed in. */
async function digAndSeal(bot: Bot, plan: PocketPlan, ctx: StepRunContext): Promise<string | null> {
  const s = plan.stand;
  const flat = Math.hypot(bot.entity.position.x - (s.x + 0.5), bot.entity.position.z - (s.z + 0.5));
  if (flat > 0.8 || Math.abs(bot.entity.position.y - s.y) > 1.2) {
    if (!(await goTo(bot, s, "to the dig-in spot"))) return "couldn't reach the spot to dig in";
  }
  const hill = plan.kind === "hill";
  if (!hill) await centreOn(bot, s.x, s.z);
  for (let i = 0; i < plan.dig.length; i++) {
    if (stopped(bot, ctx)) return "cancelled";
    if (!alive(bot)) return "died";
    const c = plan.dig[i]!;
    await fightNearbyHostiles(bot, () => stopped(bot, ctx));
    const err = await digCell(bot, c);
    if (err) return err;
    if (hill) {
      // after a cell pair is open, step into it (the next pair is dug from inside)
      if (i === 1 || i === 3) {
        const feet = plan.dig[i - 1]!;
        if (!(await goTo(bot, feet, "into the tunnel"))) return "couldn't step into the tunnel";
      }
    } else {
      await settleAt(bot, c);
    }
  }
  // we should now stand in the resting cell with the head free
  const r = plan.rest;
  await settleAt(bot, r, 1200);
  const at = bot.entity.position;
  if (Math.floor(at.x) !== r.x || Math.floor(at.z) !== r.z || Math.floor(at.y + 0.01) !== r.y) {
    return `not where expected after digging (at ${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}, wanted ${r.x}, ${r.y}, ${r.z})`;
  }
  // drops land in the cell we fell into / walked through: give the pick-up a moment
  const t0 = Date.now();
  while (!pickFiller(bot) && Date.now() - t0 < 2000) await sleepMs(100);
  for (const c of plan.seal) {
    let done = false;
    for (let attempt = 0; attempt < SEAL_TRIES && !done; attempt++) {
      if (stopped(bot, ctx)) return "cancelled";
      await fightNearbyHostiles(bot, () => stopped(bot, ctx));
      const filler = pickFiller(bot);
      if (!filler) return "nothing to seal the pocket with (the dug blocks left no dirt / cobblestone)";
      const res = await placeBlock(bot, { type: filler.name, position: { x: c.x, y: c.y, z: c.z } });
      await sleepMs(res.ok ? 150 : 350);
      done = !isOpen(bot, c);
    }
    if (!done) return `couldn't seal the pocket at (${c.x}, ${c.y}, ${c.z})`;
  }
  const head = { x: r.x, y: r.y + 1, z: r.z };
  if (!isOpen(bot, head)) return "no room for my head in the pocket";
  return null;
}

/** Dawn: open the seal and get back to the surface. Best effort, bounded. */
async function climbOut(bot: Bot, plan: PocketPlan): Promise<void> {
  const t0 = Date.now();
  const left = (): boolean => Date.now() - t0 < EXIT_BUDGET_MS;
  try {
    // top-most seal block first
    for (const c of [...plan.seal].reverse()) {
      const b = bot.blockAt(v(c));
      if (b && b.boundingBox === "block" && left()) {
        await equipForDig(bot, b);
        await bot.dig(b).catch(() => undefined);
        await sleepMs(250);
      }
    }
    if (plan.kind === "down") {
      const rise = plan.stand.y - Math.floor(bot.entity.position.y);
      if (rise > 0 && left()) await pillarUpBy(bot, rise, "escape"); // refills the pocket with the dirt we dug
    }
    if (left() && bot.entity.position.distanceTo(v(plan.stand).offset(0.5, 0, 0.5)) > 1.2) await goTo(bot, plan.stand, "out of the pocket");
  } catch {
    // best effort: the night is over either way
  }
}

async function digInThrough(bot: Bot, plan: PocketPlan, ctx: StepRunContext): Promise<StepResult> {
  let err: string | null = "not started";
  await tracked(bot, "digIn", { kind: plan.kind, at: plan.rest }, async () => {
    err = await digAndSeal(bot, plan, ctx);
    return { ok: !err, message: err ?? "sealed in" };
  });
  if (stopped(bot, ctx)) return failR("cancelled", "cancelled");
  if (!alive(bot)) return failR("died", "died while digging in");
  if (err) {
    // half-dug and unsealed: get out rather than wait in an open hole
    await tracked(bot, "digIn", { escape: true }, async () => {
      await climbOut(bot, plan);
      return { ok: true, message: "left the half-dug pocket" };
    });
    return failR("unreachable", `couldn't dig in: ${err}. Try surviveNight with shelter:"hut"`);
  }
  log(bot, `sealed in the ${plan.kind === "down" ? "ground" : "hillside"} pocket at (${plan.rest.x}, ${plan.rest.y}, ${plan.rest.z}); waiting for dawn`);
  const res = await waitForDawn(bot, ctx);
  if (res === "cancelled") return failR("cancelled", "cancelled");
  if (res === "dead") return failR("died", "died in the pocket");
  await tracked(bot, "digIn", { leave: true }, async () => {
    await climbOut(bot, plan);
    return { ok: true, message: "opened the pocket" };
  });
  return okR(`dug into the ${plan.kind === "down" ? "ground" : "hillside"}, sealed in, waited out the night and opened up at dawn`);
}
