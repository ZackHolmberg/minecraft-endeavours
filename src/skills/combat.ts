import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { getBotState } from "../state/index.js";
import { ensureMovements, type BotWithPathfinder } from "./pathfinder-config.js";
import type { SkillResult } from "./types.js";

const ATTACK_REACH = 3;
const ATTACK_TICK_MS = 100;
/** Hard ceiling on one attack call so an unreachable target can't pin the turn. */
const ATTACK_MAX_MS = 90_000;
/** Give up if we've been unable to land a swing for this long. */
const ATTACK_NO_SWING_MS = 20_000;
/** Break off a fight with a mob at or below this health (out of 20). */
const ATTACK_LOW_HEALTH = 6;
const FLEE_DEFAULT_DIST = 16;
const FLEE_MAX_DIST = 64;
const FLEE_TICK_MS = 250;
const FLEE_REPATH_INTERVAL_MS = 1_500;
const FLEE_MAX_MS = 45_000;

// Rough tier ordering — later entries are stronger. Used to pick the best
// available weapon when entering combat.
const WEAPON_TIERS = ["wooden", "stone", "golden", "iron", "diamond", "netherite"];

/**
 * Full-charge swing interval for the held item (vanilla attack speed:
 * sword 1.6/s, axes ~0.8–1.0/s, hand 4/s — we use the hand as "anything
 * else" since the slowest non-weapon is still faster than 1/s). Swinging
 * before the cooldown refills deals proportionally less damage.
 */
export function swingCooldownMs(heldName: string | undefined): number {
  if (!heldName) return 300;
  if (heldName.endsWith("_sword")) return 650;
  if (heldName.endsWith("_axe")) {
    return heldName.startsWith("wooden_") || heldName.startsWith("stone_") ? 1_300 : 1_050;
  }
  return 300;
}


export interface AttackParams {
  entity: string;
}

/**
 * Tick-loop melee. Equip the best available weapon, close to attack reach,
 * swing on cooldown. Exits when the target dies, leaves the bot's entity
 * view, or cancellation is requested (player says "stop" / `stop` skill).
 *
 * Blocking — chat queues normally; the side-channel preempt in event-hooks
 * is what makes the player-side "stop" actually interrupt mid-fight.
 */
export async function attack(bot: Bot, { entity }: AttackParams): Promise<SkillResult> {
  if (!entity) return { ok: false, message: "entity is required" };

  const target = findEntityByName(bot, entity);
  if (!target) return { ok: false, message: `entity "${entity}" not visible to the bot` };

  const state = getBotState(bot.username);
  state?.cancellation.begin();

  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);

  const weapon = pickBestWeapon(bot);
  if (weapon && bot.heldItem?.type !== weapon.type) {
    try {
      await bot.equip(weapon, "hand");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${bot.username}] attack: failed to equip ${weapon.name}: ${message}`);
    }
  }

  pBot.pathfinder.setGoal(new goals.GoalFollow(target, ATTACK_REACH - 1), true);

  const isPlayerTarget = target.type === "player";
  const cooldownMs = swingCooldownMs(bot.heldItem?.name);
  const startedAt = Date.now();
  let swings = 0;
  let lastSwingAt = 0;
  let lastDist = bot.entity.position.distanceTo(target.position);
  try {
    while (true) {
      if (state?.cancellation.isRequested()) {
        return {
          ok: true,
          message: `stopped attacking ${entity} after ${swings} swing(s)`,
          state: { swings },
        };
      }
      const live = bot.entities[target.id];
      if (!live || !live.isValid) {
        // Entities also vanish when they walk out of tracking range; only
        // call it a kill if they were close when they disappeared.
        const killed = lastDist <= ATTACK_REACH + 3;
        return {
          ok: true,
          message: killed
            ? `killed ${entity} after ${swings} swing(s)`
            : `lost track of ${entity} (~${Math.round(lastDist)} blocks away) after ${swings} swing(s)`,
          state: { swings, killed },
        };
      }
      const now = Date.now();
      if (!isPlayerTarget && bot.health <= ATTACK_LOW_HEALTH) {
        return {
          ok: false,
          message: `broke off attacking ${entity}: my health is ${Math.round(bot.health)}/20 — flee from it, then eat`,
          state: { swings, lowHealth: true },
        };
      }
      if (now - startedAt > ATTACK_MAX_MS) {
        return { ok: false, message: `gave up attacking ${entity} after ${ATTACK_MAX_MS / 1000}s (${swings} swing(s))`, state: { swings } };
      }
      if (now - Math.max(lastSwingAt, startedAt) > ATTACK_NO_SWING_MS) {
        return {
          ok: false,
          message: `couldn't get within reach of ${entity} for ${ATTACK_NO_SWING_MS / 1000}s (${Math.round(lastDist)} blocks away) — it may be unreachable`,
          state: { swings },
        };
      }
      const dist = bot.entity.position.distanceTo(live.position);
      lastDist = dist;
      if (dist <= ATTACK_REACH && now - lastSwingAt >= cooldownMs) {
        // Face the target like a player would; the server doesn't require
        // it, but a bot hitting things behind its back looks broken.
        try {
          await bot.lookAt(live.position.offset(0, (live.height ?? 1.6) * 0.8, 0), true);
        } catch {
          /* cosmetic */
        }
        bot.attack(live);
        swings += 1;
        lastSwingAt = now;
      }
      await sleep(ATTACK_TICK_MS);
    }
  } finally {
    pBot.pathfinder.setGoal(null);
  }
}

export interface FleeParams {
  from: string;
  dist?: number;
}

/**
 * Path away from `from` until at least `dist` blocks of separation, or
 * cancellation. Re-paths every ~1.5s so a moving threat (skeleton chasing
 * the bot) doesn't end up running alongside the bot toward the same spot.
 */
export async function flee(bot: Bot, { from, dist = FLEE_DEFAULT_DIST }: FleeParams): Promise<SkillResult> {
  if (!from) return { ok: false, message: "from is required" };
  if (dist < 1 || dist > FLEE_MAX_DIST) {
    return { ok: false, message: `dist must be between 1 and ${FLEE_MAX_DIST}, got ${dist}` };
  }

  const threat = findEntityByName(bot, from);
  if (!threat) return { ok: false, message: `entity "${from}" not visible to the bot` };

  const state = getBotState(bot.username);
  state?.cancellation.begin();

  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);

  let lastRepath = 0;
  const startedAt = Date.now();
  try {
    while (true) {
      if (Date.now() - startedAt > FLEE_MAX_MS) {
        const sep = Math.round(bot.entity.position.distanceTo(threat.position));
        return {
          ok: false,
          message: `couldn't open ${dist} blocks from ${from} within ${FLEE_MAX_MS / 1000}s (now ${sep}) — I may be cornered; fight or try another direction`,
          state: { separation: sep },
        };
      }
      if (state?.cancellation.isRequested()) {
        const sep = Math.round(bot.entity.position.distanceTo(threat.position));
        return {
          ok: true,
          message: `stopped fleeing from ${from} (${sep} blocks separation)`,
          state: { separation: sep },
        };
      }
      const live = bot.entities[threat.id];
      if (!live) {
        return { ok: true, message: `${from} is no longer visible — fleeing complete` };
      }
      const sep = bot.entity.position.distanceTo(live.position);
      if (sep >= dist) {
        return {
          ok: true,
          message: `fled from ${from} to ${Math.round(sep)} blocks separation`,
          state: { separation: Math.round(sep) },
        };
      }

      const now = Date.now();
      if (now - lastRepath >= FLEE_REPATH_INTERVAL_MS) {
        // XZ-only goal: a fixed Y on hilly terrain is often unreachable and
        // the pathfinder would just stand still.
        const away = awayPoint(bot.entity.position, live.position, dist);
        pBot.pathfinder.setGoal(new goals.GoalNearXZ(away.x, away.z, 2), false);
        lastRepath = now;
      }

      await sleep(FLEE_TICK_MS);
    }
  } finally {
    pBot.pathfinder.setGoal(null);
  }
}

function awayPoint(me: Vec3, threat: Vec3, dist: number): Vec3 {
  const dx = me.x - threat.x;
  const dz = me.z - threat.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.0001) {
    // Threat is exactly on top of us — pick an arbitrary direction.
    return new Vec3(me.x + dist, me.y, me.z);
  }
  const ux = dx / len;
  const uz = dz / len;
  return new Vec3(me.x + ux * dist, me.y, me.z + uz * dist);
}

export function pickBestWeapon(bot: Bot): Item | null {
  const items = bot.inventory.items();
  let best: { item: Item; rank: number } | null = null;
  for (const item of items) {
    const rank = weaponRank(item.name);
    if (rank < 0) continue;
    if (!best || rank > best.rank) best = { item, rank };
  }
  return best?.item ?? null;
}

function weaponRank(name: string): number {
  // Sword > axe > nothing. Within a kind, the tier ordering above defines
  // strength. Returns -1 for non-weapons so they're skipped entirely.
  const isSword = name.endsWith("_sword");
  const isAxe = name.endsWith("_axe");
  if (!isSword && !isAxe) return -1;
  const tier = WEAPON_TIERS.findIndex((t) => name.startsWith(`${t}_`));
  const tierScore = tier < 0 ? 0 : tier + 1;
  return tierScore * 2 + (isSword ? 1 : 0);
}

function findEntityByName(bot: Bot, name: string): Entity | null {
  const player = bot.players[name];
  if (player?.entity) return player.entity;

  const lower = name.toLowerCase();
  let best: { entity: Entity; dist: number } | null = null;
  const me = bot.entity.position;
  for (const id of Object.keys(bot.entities)) {
    const entity = bot.entities[id];
    if (!entity || entity.id === bot.entity.id) continue;
    if (entity.name?.toLowerCase() !== lower && entity.username?.toLowerCase() !== lower) continue;
    const d = me.distanceTo(entity.position);
    if (!best || d < best.dist) best = { entity, dist: d };
  }
  return best?.entity ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
