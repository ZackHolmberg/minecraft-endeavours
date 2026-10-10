/**
 * Cheap reflexes a human player does without thinking — no LLM round-trip.
 * Wired per-connection by `mineflayer-glue/event-hooks.ts`.
 *
 *  - Idle look: face the nearest player within a few blocks (the
 *    conversation partner if present) when doing nothing else.
 *  - Auto-eat: eat when hungry, before health regen stops.
 *  - Armor: wear better armor pieces as soon as they're picked up.
 *  - Defensive swing: hit back at a hostile mob that just hurt us, if it's
 *    within reach. No pathing — never fights the agent for control of
 *    movement. It also fires while a job skill (mining, building, walking) is
 *    in flight: standing still being hit because a dig is "busy" is how the
 *    bot died in the night test. Skills that fight / eat / sleep themselves
 *    are left alone, and so is `build` (the Builder owns the bot's hands and
 *    fights between its actions: a reflex swapping to the sword mid-placement
 *    made placements fail with "refused to place stone_sword").
 *  - Weapon ready: at night, with a hostile mob within a few blocks and the
 *    bot idle, put the best sword/axe in hand (before it gets hit).
 *  - Breath / suffocation (`survivalTick`): the one reflex that does NOT wait
 *    for the agent. Low oxygen (<= SURFACE_AT of 20), or a swim that the
 *    remaining air will not cover, interrupts whatever movement is running,
 *    holds jump and swims the shortest way to air (digging a natural roof
 *    when the water is sealed); a head inside a solid block is dug out (natural)
 *    or walked out of. `navigate` resumes its goal afterwards (see
 *    {@link surfaceInterrupted}). Emits `reflex: "surface"` with the reason.
 *
 * Creative mode (read live on every tick): auto-eat, armor and the defensive
 * swing are off — there's no hunger, armor does nothing for an invulnerable
 * player, and mobs neither target nor hurt creative players, so swinging at
 * passers-by would just look odd (`attack` still works when asked). The
 * idle look stays on in every mode.
 *
 * Every reflex runs only while no skill is in flight (or, for eating, while
 * only a movement skill is), never while a window is open, and holds the
 * per-bot reflex lock while it touches the inventory. `runSkill` waits on
 * that lock before starting a skill so a skill's equip / window clicks
 * can't interleave with a reflex's.
 */

import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { recordEvent } from "../observability/telemetry.js";
import { getCurrentConversationPartner } from "../orchestrator/chat-router.js";
import type { BotState } from "../state/index.js";
import { pickBestWeapon, swingCooldownMs } from "./combat.js";
import { isCreative } from "./game-mode.js";
import { pickBestFood } from "./survival.js";
import { builtStructureReason, craftedWithin, isCheapBreak, isNaturalTerrain } from "./structure-guard.js";
import { findAirRoute, findFallbackSwim, findRoofDig, isPassable, isWet, ROOF_CRAFTED_RADIUS, suffocatingBlock } from "./surfacing.js";

const IDLE_LOOK_RANGE = 6;
const AUTO_EAT_FOOD_AT = 14;
const AUTO_EAT_STARVING = 6;
const AUTO_EAT_RETRY_MS = 4_000;
const AUTO_EAT_NO_FOOD_BACKOFF_MS = 60_000;
const DEFEND_WINDOW_MS = 8_000;
const DEFEND_REACH = 3;
const REFLEX_LOCK_MAX_WAIT_MS = 4_000;
/** Telemetry: idle-look fires every tick; record only a changed gaze target, at most this often. */
const LOOK_TELEMETRY_MIN_GAP_MS = 30_000;

/** Skills during which eating is harmless (they don't depend on the held item). */
const EAT_OK_DURING = new Set(["goTo", "followPlayer"]);

// ── reflex lock ──────────────────────────────────────────────────────────────

const reflexLocks = new Map<string, Promise<void>>();

async function withReflexLock(username: string, fn: () => Promise<void>): Promise<void> {
  if (reflexLocks.has(username)) return; // one reflex at a time; skip, don't queue
  const run = fn().catch((err) => {
    console.warn(`[${username}] reflex failed:`, err instanceof Error ? err.message : err);
  });
  reflexLocks.set(username, run);
  try {
    await run;
  } finally {
    reflexLocks.delete(username);
  }
}

/** Await any in-flight reflex (bounded) before a skill touches the inventory. */
export async function awaitReflexIdle(username: string): Promise<void> {
  const pending = reflexLocks.get(username);
  if (!pending) return;
  await Promise.race([pending, new Promise((r) => setTimeout(r, REFLEX_LOCK_MAX_WAIT_MS))]);
}

function isBusy(bot: Bot, state: BotState): boolean {
  return state.currentTool.current() !== null || bot.currentWindow !== null || reflexLocks.has(bot.username);
}

// ── idle look ────────────────────────────────────────────────────────────────

export function idleLookTick(bot: Bot, state: BotState): void {
  if (!bot.entity || isBusy(bot, state)) return;
  const pBot = bot as Bot & { pathfinder?: { isMoving(): boolean } };
  if (pBot.pathfinder?.isMoving() || bot.targetDigBlock || bot.usingHeldItem || bot.isSleeping) return;

  const me = bot.entity.position;
  const partner = getCurrentConversationPartner(bot.username);
  let target: Entity | null = null;
  let best = Infinity;
  for (const p of Object.values(bot.players)) {
    const e = p.entity;
    if (!e || p.username === bot.username) continue;
    const d = me.distanceTo(e.position);
    if (d > IDLE_LOOK_RANGE) continue;
    // Conversation partner wins regardless of who's closer.
    const score = p.username === partner ? -1 : d;
    if (score < best) {
      best = score;
      target = e;
    }
  }
  if (!target) return;
  noteLookTarget(bot, target);
  // Non-forced look turns smoothly over a few ticks, like a head turn.
  void bot.lookAt(target.position.offset(0, target.height ?? 1.62, 0), false).catch(() => {});
}

const lastLookTelemetry = new WeakMap<Bot, { target: string; at: number }>();

function noteLookTarget(bot: Bot, target: Entity): void {
  const name = target.username ?? target.name ?? String(target.id);
  const prev = lastLookTelemetry.get(bot);
  if (prev && (prev.target === name || Date.now() - prev.at < LOOK_TELEMETRY_MIN_GAP_MS)) return;
  lastLookTelemetry.set(bot, { target: name, at: Date.now() });
  recordEvent(bot.username, { kind: "reflex", reflex: "look", detail: `looking at ${name}` });
}

// ── auto-eat ─────────────────────────────────────────────────────────────────

const lastEatAttempt = new WeakMap<Bot, number>();

export function maybeAutoEat(bot: Bot, state: BotState): void {
  if (!bot.entity || bot.health <= 0 || isCreative(bot)) return;
  const hungry = bot.food <= AUTO_EAT_FOOD_AT || (bot.health < 14 && bot.food < 18);
  if (!hungry) return;
  const tool = state.currentTool.current();
  if (tool && !EAT_OK_DURING.has(tool.name)) return;
  if (bot.currentWindow || reflexLocks.has(bot.username) || bot.usingHeldItem) return;
  const last = lastEatAttempt.get(bot) ?? 0;
  if (Date.now() - last < AUTO_EAT_RETRY_MS) return;
  lastEatAttempt.set(bot, Date.now());

  const food = pickBestFood(bot, { allowRottenFlesh: bot.food <= AUTO_EAT_STARVING });
  if (!food) {
    // Nothing to eat — don't re-check on every health packet for a while.
    lastEatAttempt.set(bot, Date.now() + AUTO_EAT_NO_FOOD_BACKOFF_MS);
    return;
  }
  void withReflexLock(bot.username, async () => {
    const stack = bot.inventory.items().find((i) => i.name === food);
    if (!stack) return;
    const previous = bot.heldItem;
    const before = bot.food;
    await bot.equip(stack, "hand");
    await bot.consume();
    console.log(`[${bot.username}] auto-ate ${food} (food ${before} → ${bot.food})`);
    recordEvent(bot.username, { kind: "reflex", reflex: "eat", detail: `ate ${food} (food ${before} → ${bot.food})` });
    state.actions.record(`ate ${food} (hungry, food was ${before}/20)`);
    await reequip(bot, previous);
  });
}

async function reequip(bot: Bot, previous: Item | null): Promise<void> {
  if (!previous || bot.heldItem?.type === previous.type) return;
  const again = bot.inventory.items().find((i) => i.type === previous.type);
  if (again) await bot.equip(again, "hand").catch(() => {});
}

// ── armor ────────────────────────────────────────────────────────────────────

const ARMOR_TIERS = ["leather", "golden", "chainmail", "iron", "turtle", "diamond", "netherite"];
const ARMOR_SLOTS = [
  { dest: "head", slot: 5, suffix: ["_helmet"] },
  { dest: "torso", slot: 6, suffix: ["_chestplate"] },
  { dest: "legs", slot: 7, suffix: ["_leggings"] },
  { dest: "feet", slot: 8, suffix: ["_boots"] },
] as const;

function armorRank(name: string): number {
  // turtle_helmet ≈ iron; everything else ranks by material prefix.
  return ARMOR_TIERS.findIndex((t) => name.startsWith(`${t}_`));
}

export function maybeEquipArmor(bot: Bot, state: BotState): void {
  if (!bot.entity || isBusy(bot, state) || isCreative(bot)) return;
  const upgrades: Item[] = [];
  for (const { slot, suffix } of ARMOR_SLOTS) {
    const worn = bot.inventory.slots[slot];
    const wornRank = worn ? armorRank(worn.name) : -1;
    let best: Item | null = null;
    let bestRank = wornRank;
    for (const it of bot.inventory.items()) {
      if (!suffix.some((s) => it.name.endsWith(s))) continue;
      const r = armorRank(it.name);
      if (r > bestRank) {
        best = it;
        bestRank = r;
      }
    }
    if (best) upgrades.push(best);
  }
  if (upgrades.length === 0) return;
  void withReflexLock(bot.username, async () => {
    for (const it of upgrades) {
      const dest = ARMOR_SLOTS.find((a) => a.suffix.some((s) => it.name.endsWith(s)))!.dest;
      await bot.equip(it, dest);
    }
    const names = upgrades.map((u) => u.name).join(", ");
    console.log(`[${bot.username}] auto-equipped armor: ${names}`);
    recordEvent(bot.username, { kind: "reflex", reflex: "armor", detail: `put on ${names}`.slice(0, 200) });
    state.actions.record(`put on ${names}`);
  });
}

// ── defensive swing ──────────────────────────────────────────────────────────

const lastHurtBy = new WeakMap<Bot, { attackerId: number | null; at: number }>();
const lastSwing = new WeakMap<Bot, number>();

export function noteHurt(bot: Bot, attacker: Entity | undefined): void {
  lastHurtBy.set(bot, { attackerId: attacker?.id ?? null, at: Date.now() });
}

/** Skills that already handle a threat, eating or sleeping: the defensive swing leaves them alone. */
const OWN_THREAT_HANDLING = new Set(["attack", "flee", "eat", "sleepIn", "fish", "build"]);

/** Busy for the defensive swing: a window open, a reflex mid-flight, or a skill that fights / eats / sleeps itself. */
export function defendBlocked(bot: Bot, state: BotState): boolean {
  if (bot.currentWindow !== null || reflexLocks.has(bot.username) || bot.usingHeldItem) return true;
  const tool = state.currentTool.current();
  return tool !== null && OWN_THREAT_HANDLING.has(tool.name);
}

const ARM_RANGE = 6;
const ARM_RETRY_MS = 3_000;
const lastArm = new WeakMap<Bot, number>();

/** Night = mobs spawn in the open (dusk ~12500 to dawn ~23500). */
export function isDarkHours(timeOfDay: number | undefined | null): boolean {
  return typeof timeOfDay === "number" && timeOfDay >= 12_500 && timeOfDay < 23_500;
}

/** Idle at night with a hostile mob within {@link ARM_RANGE}: hold the best weapon. */
export function armTick(bot: Bot, state: BotState): void {
  if (!bot.entity || bot.health <= 0 || bot.isSleeping || isCreative(bot)) return;
  if (!isDarkHours((bot as { time?: { timeOfDay?: number } }).time?.timeOfDay)) return;
  if (isBusy(bot, state)) return; // mid-dig / mid-walk: the swing reflex re-equips when it matters
  const me = bot.entity.position;
  let near = false;
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !isHostile(e)) continue;
    if (me.distanceTo(e.position) <= ARM_RANGE) {
      near = true;
      break;
    }
  }
  if (!near) return;
  const weapon = pickBestWeapon(bot);
  if (!weapon || bot.heldItem?.type === weapon.type) return;
  const now = Date.now();
  if (now - (lastArm.get(bot) ?? 0) < ARM_RETRY_MS) return;
  lastArm.set(bot, now);
  void withReflexLock(bot.username, async () => {
    await bot.equip(weapon, "hand");
    recordEvent(bot.username, { kind: "reflex", reflex: "defend", detail: `readied ${weapon.name}` });
  });
}

export function defendTick(bot: Bot, state: BotState): void {
  armTick(bot, state);
  const hurt = lastHurtBy.get(bot);
  if (!hurt || Date.now() - hurt.at > DEFEND_WINDOW_MS || isCreative(bot)) return;
  if (!bot.entity || bot.health <= 0 || bot.isSleeping || defendBlocked(bot, state)) return;

  // Prefer whoever hit us (if it's a hostile mob); else the nearest hostile.
  const me = bot.entity.position;
  let target: Entity | null = null;
  const attacker = hurt.attackerId !== null ? bot.entities[hurt.attackerId] : undefined;
  if (attacker && isHostile(attacker) && me.distanceTo(attacker.position) <= DEFEND_REACH) {
    target = attacker;
  } else {
    let best = DEFEND_REACH;
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !isHostile(e)) continue;
      const d = me.distanceTo(e.position);
      if (d <= best) {
        best = d;
        target = e;
      }
    }
  }
  if (!target) return;

  const now = Date.now();
  if (now - (lastSwing.get(bot) ?? 0) < swingCooldownMs(bot.heldItem?.name)) return;
  lastSwing.set(bot, now);
  const t = target;
  void withReflexLock(bot.username, async () => {
    const weapon = pickBestWeapon(bot);
    if (weapon && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, "hand");
    await bot.lookAt(t.position.offset(0, (t.height ?? 1.6) * 0.8, 0), true);
    bot.attack(t);
    recordEvent(bot.username, { kind: "reflex", reflex: "defend", detail: `hit ${t.name ?? t.displayName ?? "mob"}` });
  });
}

function isHostile(e: Entity): boolean {
  if (e.type === "player") return false;
  return (e.kind ?? "").toLowerCase().includes("hostile");
}


// ── breath / suffocation (R6) ────────────────────────────────────────────────

/** Surface when oxygen is at or below this (of 20; one unit ~ 0.75 s). Drowning damage starts at 0. */
export const SURFACE_AT = 8;
/** Early trigger: oxygen is falling, at most this, and the swim to air is longer than the air will cover. */
const SURFACE_EARLY_AT = 14;
/** Blocks swum per oxygen unit, with margin (swimming ~2 b/s, 0.75 s per unit). */
const SWIM_BLOCKS_PER_OXYGEN = 1.3;
const SURFACE_MAX_MS = 25_000;
const SURFACE_STEP_MS = 100;
const REPLAN_MS = 300;
/** Consecutive ticks with the head inside a solid block before we dig out (rules out one-tick glitches). */
const SUFFOCATE_TICKS = 2;
const SUFFOCATE_MAX_DIGS = 5;
const REFLEX_DIG_TIMEOUT_MS = 8_000;

/** Back-off after a routine that found no way out: 1 s, 2 s, 4 s, 8 s, then this cap (review M4). */
export const SURFACE_BACKOFF_CAP_MS = 10_000;
/** The reflex logs/records telemetry at most once per this long (more are counted and folded into the next). */
export const SURFACE_EVENT_MIN_GAP_MS = 10_000;

/** Pure: delay before the reflex may retry after `streak` consecutive failed attempts (1-based). */
export function surfaceBackoffMs(streak: number): number {
  return Math.min(SURFACE_BACKOFF_CAP_MS, 1_000 * 2 ** Math.max(0, streak - 1));
}

interface SurfaceState {
  active: boolean;
  endedAt: number;
  lastOxygen: number;
  suffocateTicks: number;
  /** Consecutive routines that did not get the bot out (drives the back-off). */
  failStreak: number;
  nextAllowedAt: number;
  lastEventAt: number;
  suppressed: number;
}
const surfaceStates = new WeakMap<Bot, SurfaceState>();
function surfaceState(bot: Bot): SurfaceState {
  let st = surfaceStates.get(bot);
  if (!st) {
    st = { active: false, endedAt: 0, lastOxygen: 20, suffocateTicks: 0, failStreak: 0, nextAllowedAt: 0, lastEventAt: 0, suppressed: 0 };
    surfaceStates.set(bot, st);
  }
  return st;
}

/** True while the surfacing / dig-out routine is running. */
export function isSurfacing(bot: Bot): boolean {
  return surfaceStates.get(bot)?.active === true;
}

/**
 * Called by `navigate` when its goal was dropped under it: was that the survival
 * reflex? If so wait (bounded) for it to finish and return true so the caller
 * re-issues the goal from the new position.
 */
export async function surfaceInterrupted(bot: Bot): Promise<boolean> {
  const st = surfaceStates.get(bot);
  if (!st) return false;
  if (!st.active && Date.now() - st.endedAt > 1_500) return false;
  const deadline = Date.now() + SURFACE_MAX_MS + 2_000;
  while (st.active && Date.now() < deadline) await sleepMs(100);
  return true;
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function eyeCell(bot: Bot): Vec3 {
  const p = bot.entity.position;
  return new Vec3(Math.floor(p.x), Math.floor(p.y + (bot.entity.height ?? 1.62) * 0.9), Math.floor(p.z));
}

/**
 * The bot's OWN oxygen (0..20). `bot.oxygenLevel` is wrong near any other air-breathing-
 * metadata entity: mineflayer 4.39 (entities.js) assigns it from EVERY entity's `air_supply`
 * update, so fish, squid and other players in the same lake overwrite it (seen live: 9, 19, 17,
 * 20 within seconds of a real, steady drain). {@link trackSurvivalState} listens for our own
 * entity's packets instead.
 */
const ownOxygen = new WeakMap<Bot, number>();
const ownOxygenTracked = new WeakSet<Bot>();
/** Our own reading; before the first own packet assume full air (bot.oxygenLevel is polluted by other entities) unless tracking is unavailable. */
const oxygenOf = (bot: Bot): number =>
  ownOxygen.get(bot) ?? (ownOxygenTracked.has(bot) ? 20 : typeof bot.oxygenLevel === "number" ? bot.oxygenLevel : 20);

function headInWater(bot: Bot): boolean {
  return isWet(bot.blockAt(eyeCell(bot)));
}

/** Reflex tick: start the survival routine when the bot is drowning or suffocating. Runs regardless of skills in flight. */
export function survivalTick(bot: Bot, state: BotState): void {
  if (!bot.entity || bot.health <= 0 || isCreative(bot) || bot.isSleeping) return;
  const st = surfaceState(bot);
  if (st.active) return;

  const oxygen = oxygenOf(bot);
  const falling = oxygen < st.lastOxygen;
  st.lastOxygen = oxygen;

  // suffocation: head inside a solid cube
  const headBlock = bot.blockAt(eyeCell(bot));
  if (suffocatingBlock(headBlock as never)) {
    st.suffocateTicks += 1;
    if (st.suffocateTicks >= SUFFOCATE_TICKS) {
      st.suffocateTicks = 0;
      if (Date.now() >= st.nextAllowedAt) startRoutine(bot, state, st, `suffocation: head inside ${headBlock!.name}`, "suffocate");
    }
    return;
  }
  st.suffocateTicks = 0;

  if (!headInWater(bot)) return;
  let reason: string | null = null;
  if (oxygen <= SURFACE_AT) reason = `drowning: oxygen ${oxygen}/20`;
  else if (falling && oxygen <= SURFACE_EARLY_AT) {
    const route = findAirRoute((p) => bot.blockAt(p), eyeCell(bot));
    if (!route || route.path.length > oxygen * SWIM_BLOCKS_PER_OXYGEN) {
      reason = `underwater, oxygen ${oxygen}/20 falling, ${route ? `${route.path.length} blocks to air` : "no open air reachable"}`;
    }
  }
  if (reason && Date.now() >= st.nextAllowedAt) startRoutine(bot, state, st, reason, "surface");
}

/** Record a failed attempt and delay the next one. */
function backOff(st: SurfaceState): void {
  st.failStreak += 1;
  st.nextAllowedAt = Date.now() + surfaceBackoffMs(st.failStreak);
}

/** Log + telemetry + action log, at most once per {@link SURFACE_EVENT_MIN_GAP_MS}; suppressed ones are counted into the next. */
function emitReflex(bot: Bot, state: BotState, st: SurfaceState, detail: string): void {
  const now = Date.now();
  if (now - st.lastEventAt < SURFACE_EVENT_MIN_GAP_MS) {
    st.suppressed += 1;
    return;
  }
  const text = st.suppressed > 0 ? `${detail} (+${st.suppressed} similar suppressed)` : detail;
  st.suppressed = 0;
  st.lastEventAt = now;
  console.warn(`[${bot.username}] [reflex] ${text}`);
  recordEvent(bot.username, { kind: "reflex", reflex: "surface", detail: text.slice(0, 200) });
  state.actions.record(`reflex: ${text}`);
}

/** Is there any way out of the water: a swim to air, a diggable roof, or a wider/other swim? Read-only. */
function hasSurfaceWay(bot: Bot): boolean {
  const at = (p: Vec3) => bot.blockAt(p);
  const head = eyeCell(bot);
  return !!findAirRoute(at, head) || !!findRoofDig(at, head) || !!findFallbackSwim(at, head);
}

function startRoutine(bot: Bot, state: BotState, st: SurfaceState, reason: string, mode: "surface" | "suffocate"): void {
  // With nowhere to go, leave the pathfinder and any running dig alone (they may be the bot's best chance) and back off.
  if (mode === "surface" && !hasSurfaceWay(bot)) {
    emitReflex(bot, state, st, `${reason}; no swim, roof dig or shore found, backing off`);
    backOff(st);
    return;
  }
  st.active = true; // set synchronously: navigate's catch checks it when the goal drops
  emitReflex(bot, state, st, reason);
  void (async () => {
    let ok = false;
    try {
      interruptMovement(bot); // once per attempt
      ok = mode === "suffocate" ? await digOut(bot) : await swimToAir(bot, (d) => emitReflex(bot, state, st, d));
    } catch (err) {
      console.warn(`[${bot.username}] survival reflex failed:`, err instanceof Error ? err.message : err);
    } finally {
      releaseControls(bot);
      st.active = false;
      st.endedAt = Date.now();
      if (ok) {
        st.failStreak = 0;
        st.nextAllowedAt = 0;
      } else backOff(st);
    }
  })();
}

function interruptMovement(bot: Bot): void {
  const pf = (bot as Bot & { pathfinder?: { setGoal(g: null): void } }).pathfinder;
  try { pf?.setGoal(null); } catch { /* best-effort */ }
  if (bot.targetDigBlock) {
    try { bot.stopDigging(); } catch { /* best-effort */ }
  }
  releaseControls(bot);
}

function releaseControls(bot: Bot): void {
  for (const c of ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const) bot.setControlState(c, false);
}

/** Face the horizontal direction of `to` and press forward (jump is held by the caller). */
async function steerTo(bot: Bot, to: Vec3): Promise<void> {
  const p = bot.entity.position;
  const dx = to.x + 0.5 - p.x;
  const dz = to.z + 0.5 - p.z;
  const horiz = Math.hypot(dx, dz);
  if (horiz > 0.25) {
    await bot.look(Math.atan2(-dx, -dz), 0, true);
    bot.setControlState("forward", true);
  } else {
    bot.setControlState("forward", false);
  }
}

/** Returns true when the head ended up out of the water. */
async function swimToAir(bot: Bot, note: (detail: string) => void): Promise<boolean> {
  const t0 = Date.now();
  const at = (p: Vec3) => bot.blockAt(p);
  let dug = false;
  let airSince = 0;
  let fellBack = false;
  bot.setControlState("jump", true);
  while (Date.now() - t0 < SURFACE_MAX_MS && bot.health > 0) {
    const head = eyeCell(bot);
    if (!isWet(at(head))) {
      // Head is out. Keep swimming a moment (to clear the water's edge), then call it done.
      airSince ||= Date.now();
      if (Date.now() - airSince > 1_000 || oxygenOf(bot) >= 18) return true;
      await sleepMs(SURFACE_STEP_MS);
      continue;
    }
    airSince = 0;
    const route = findAirRoute(at, head);
    if (route && route.path.length > 0) {
      const target = route.path.find((c) => c.x !== head.x || c.z !== head.z) ?? route.path[0]!;
      const upOnly = target.x === head.x && target.z === head.z;
      if (upOnly) bot.setControlState("forward", false);
      else await steerTo(bot, target);
      bot.setControlState("jump", true);
      await sleepMs(REPLAN_MS);
      continue;
    }
    // Sealed water: dig up through a natural roof that is not a player's floor/ceiling (M1) ...
    const roof = findRoofDig(at, head);
    if (roof) {
      const roofReached = roof.stand.x === head.x && roof.stand.z === head.z && roof.stand.y <= head.y + 0;
      if (!roofReached) {
        const step = roof.swim[0] ?? roof.stand;
        if (step.y > head.y) { bot.setControlState("jump", true); bot.setControlState("forward", false); }
        else { bot.setControlState("jump", false); await steerTo(bot, step); }
        await sleepMs(REPLAN_MS);
        continue;
      }
      releaseControls(bot);
      const block = at(roof.dig[0]!);
      // re-check against the live world right before breaking
      if (!block || builtStructureReason(bot, block) !== null || craftedWithin((p) => bot.blockAt(p), block.position, ROOF_CRAFTED_RADIUS) || !(await digWithTool(bot, block))) return false;
      dug = true;
      bot.setControlState("jump", true);
      await sleepMs(SURFACE_STEP_MS);
      continue;
    }
    // ... or, with no roof we may dig, swim toward the nearest air / the highest water instead.
    const fb = findFallbackSwim(at, head);
    if (!fb || fb.path.length === 0) {
      console.warn(`[${bot.username}] [reflex] no air and no diggable roof reachable from ${head.x},${head.y},${head.z}`);
      return false;
    }
    if (!fellBack) {
      fellBack = true;
      note(`sealed water and the roof is not safe to dig; swimming toward ${fb.kind === "air" ? "open air" : "the highest water"} (${fb.path.length} blocks)`);
    }
    const target = fb.path.find((c) => c.x !== head.x || c.z !== head.z) ?? fb.path[0]!;
    if (target.x === head.x && target.z === head.z) bot.setControlState("forward", false);
    else await steerTo(bot, target);
    bot.setControlState("jump", true);
    await sleepMs(REPLAN_MS);
  }
  if (dug) console.log(`[${bot.username}] [reflex] dug through a roof to reach air`);
  return !isWet(at(eyeCell(bot)));
}

async function digWithTool(bot: Bot, block: NonNullable<ReturnType<Bot["blockAt"]>>): Promise<boolean> {
  if (!bot.canDigBlock(block)) return false;
  try {
    const pf = (bot as Bot & { pathfinder?: { bestHarvestTool?(b: unknown): Item | null } }).pathfinder;
    const tool = pf?.bestHarvestTool?.(block);
    if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, "hand").catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    let expected = 0;
    try { expected = bot.digTime(block); } catch { /* material data missing */ }
    const budget = Math.min(30_000, Math.max(REFLEX_DIG_TIMEOUT_MS, expected * 1.5 + 3_000));
    try {
      await Promise.race([
        bot.dig(block, true),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => {
            try { bot.stopDigging(); } catch { /* best-effort */ }
            rej(new Error("dig timeout"));
          }, budget);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return true;
  } catch (err) {
    console.warn(`[${bot.username}] [reflex] dig ${block.name} failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/** Head inside a solid block: dig it if natural and not set into a player build (repeat for falling blocks that refill), else step out. */
async function digOut(bot: Bot): Promise<boolean> {
  for (let i = 0; i < SUFFOCATE_MAX_DIGS && bot.health > 0; i++) {
    const head = bot.blockAt(eyeCell(bot));
    if (!suffocatingBlock(head as never)) return true;
    if (head && (isNaturalTerrain(head.name) || isCheapBreak(head.name)) && builtStructureReason(bot, head) === null) {
      if (await digWithTool(bot, head)) {
        await sleepMs(250);
        continue;
      }
    }
    break;
  }
  if (!suffocatingBlock(bot.blockAt(eyeCell(bot)) as never)) return true;
  // Not natural / player-built (or the dig failed): walk to the nearest free 2-high cell.
  const p = bot.entity.position;
  const base = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  let best: { c: Vec3; d: number } | null = null;
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) {
    const feet = base.offset(dx, dy, dz);
    if (!isPassable(bot.blockAt(feet)) || !isPassable(bot.blockAt(feet.offset(0, 1, 0)))) continue;
    const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy);
    if (d > 0 && (!best || d < best.d)) best = { c: feet, d };
  }
  if (!best) return false;
  const t0 = Date.now();
  bot.setControlState("jump", true);
  while (Date.now() - t0 < 4_000 && suffocatingBlock(bot.blockAt(eyeCell(bot)) as never)) {
    await steerTo(bot, best.c);
    await sleepMs(SURFACE_STEP_MS);
  }
  return !suffocatingBlock(bot.blockAt(eyeCell(bot)) as never);
}

// ── hurt cause (telemetry) ───────────────────────────────────────────────────

interface FallTrack {
  /** Most negative vertical velocity seen recently. */
  minVy: number;
  at: number;
}
const fallTracks = new WeakMap<Bot, FallTrack>();
const FALL_WINDOW_MS = 800;

/**
 * Wired once per connection: (a) our own oxygen from our own entity_metadata packets, (b) vertical
 * speed so a hurt right after a hard landing can be called a fall.
 */
export function trackSurvivalState(bot: Bot): void {
  const airKey = (bot.registry.entitiesByName.player as { metadataKeys?: string[] } | undefined)?.metadataKeys?.indexOf("air_supply") ?? -1;
  const client = (bot as unknown as { _client: { on(ev: string, fn: (p: { entityId: number; metadata: Array<{ key: number; value: unknown }> }) => void): void } })._client;
  if (airKey >= 0) {
    ownOxygenTracked.add(bot);
    client.on("entity_metadata", (packet) => {
      if (!bot.entity || packet.entityId !== bot.entity.id) return;
      const m = packet.metadata.find((e) => e.key === airKey);
      if (m && typeof m.value === "number") ownOxygen.set(bot, Math.max(0, Math.min(20, Math.round(m.value / 15))));
    });
  }
  bot.on("respawn", () => { ownOxygen.set(bot, 20); });
  bot.on("physicsTick", () => {
    const vy = bot.entity?.velocity?.y ?? 0;
    const t = fallTracks.get(bot);
    const now = Date.now();
    if (vy < -0.6 && (!t || now - t.at > FALL_WINDOW_MS || vy < t.minVy)) fallTracks.set(bot, { minVy: vy, at: now });
    else if (t && now - t.at > FALL_WINDOW_MS) fallTracks.delete(bot);
  });
}

/** Best-effort damage cause for the `hurt` telemetry event; "unknown" when nothing matches. */
export function inferHurtCause(bot: Bot, source: Entity | undefined): string {
  if (source) return source.username ?? source.name ?? "mob";
  if (!bot.entity) return "unknown";
  const head = bot.blockAt(eyeCell(bot));
  if (suffocatingBlock(head as never)) return "suffocation";
  if (isWet(head) && oxygenOf(bot) <= 0) return "drowning";
  const feet = bot.blockAt(bot.entity.position.floored());
  if (feet && (feet.name === "lava" || (bot.entity as { isInLava?: boolean }).isInLava)) return "lava";
  if (feet && /^(fire|soul_fire)$/.test(feet.name)) return "fire";
  const fall = fallTracks.get(bot);
  if (fall && Date.now() - fall.at < FALL_WINDOW_MS && bot.entity.onGround) return "fall";
  const below = bot.blockAt(bot.entity.position.offset(0, -0.5, 0));
  if (below?.name === "magma_block") return "magma block";
  if (below?.name === "campfire" || below?.name === "soul_campfire") return "campfire";
  if (bot.food <= 0) return "starvation";
  const wide = bot.entity.position.floored();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const n = bot.blockAt(wide.offset(dx, 0, dz));
    if (n?.name === "cactus") return "cactus";
    if (n?.name === "sweet_berry_bush") return "berry bush";
  }
  return "unknown";
}
