import type { Bot } from "mineflayer";
import pathfinderPkg, { type Pathfinder } from "mineflayer-pathfinder";

const { goals, Movements } = pathfinderPkg;
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { getBotState } from "../state/index.js";
import type { SkillResult } from "./types.js";

const ATTACK_REACH = 3;
const ATTACK_COOLDOWN_MS = 600;
const ATTACK_TICK_MS = 100;
const FLEE_DEFAULT_DIST = 16;
const FLEE_MAX_DIST = 64;
const FLEE_TICK_MS = 250;
const FLEE_REPATH_INTERVAL_MS = 1_500;

// Rough tier ordering — later entries are stronger. Used to pick the best
// available weapon when entering combat.
const WEAPON_TIERS = ["wooden", "stone", "golden", "iron", "diamond", "netherite"];

interface BotWithPathfinder extends Bot {
  pathfinder: Pathfinder;
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

  let swings = 0;
  let lastSwingAt = 0;
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
        return {
          ok: true,
          message: `killed ${entity} after ${swings} swing(s)`,
          state: { swings, killed: true },
        };
      }
      const dist = bot.entity.position.distanceTo(live.position);
      if (dist <= ATTACK_REACH) {
        const now = Date.now();
        if (now - lastSwingAt >= ATTACK_COOLDOWN_MS) {
          bot.attack(live);
          swings += 1;
          lastSwingAt = now;
        }
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
  try {
    while (true) {
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
        const away = awayPoint(bot.entity.position, live.position, dist);
        pBot.pathfinder.setGoal(new goals.GoalNear(away.x, away.y, away.z, 1), false);
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

function pickBestWeapon(bot: Bot): Item | null {
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

function ensureMovements(bot: BotWithPathfinder): void {
  if (!bot.pathfinder.movements || bot.pathfinder.movements.bot !== bot) {
    bot.pathfinder.setMovements(new Movements(bot));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
