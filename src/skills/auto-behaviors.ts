/**
 * Cheap reflexes a human player does without thinking — no LLM round-trip.
 * Wired per-connection by `mineflayer-glue/event-hooks.ts`.
 *
 *  - Idle look: face the nearest player within a few blocks (the
 *    conversation partner if present) when doing nothing else.
 *  - Auto-eat: eat when hungry, before health regen stops.
 *  - Armor: wear better armor pieces as soon as they're picked up.
 *  - Defensive swing: hit back at a hostile mob that just hurt us, if it's
 *    within reach and we're idle. No pathing — never fights the agent for
 *    control of movement.
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
import { recordEvent } from "../observability/telemetry.js";
import { getCurrentConversationPartner } from "../orchestrator/chat-router.js";
import type { BotState } from "../state/index.js";
import { pickBestWeapon, swingCooldownMs } from "./combat.js";
import { isCreative } from "./game-mode.js";
import { pickBestFood } from "./survival.js";

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

export function defendTick(bot: Bot, state: BotState): void {
  const hurt = lastHurtBy.get(bot);
  if (!hurt || Date.now() - hurt.at > DEFEND_WINDOW_MS || isCreative(bot)) return;
  if (!bot.entity || bot.health <= 0 || bot.isSleeping || isBusy(bot, state)) return;

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

