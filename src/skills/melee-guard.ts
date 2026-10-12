/**
 * Fight off a hostile mob that is right on top of the bot, from INSIDE a long skill that owns the bot's
 * hands (the Builder). The defensive-swing reflex stays out of those skills (it would swap the held item
 * between the skill's equip and its placement); the skill calls this between its actions instead.
 *
 * Only mobs within melee range are fought; nothing is chased. Bounded, cancellable.
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { isCreative } from "./game-mode.js";
import { pickBestWeapon, swingCooldownMs } from "./combat.js";

const MELEE_RANGE = 3.4;
const MAX_FIGHT_MS = 8_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isHostileMob(e: Entity): boolean {
  return e.type !== "player" && (e.kind ?? "").toLowerCase().includes("hostile");
}

export function nearestHostileWithin(bot: Bot, range: number): Entity | null {
  if (!bot.entity) return null;
  const me = bot.entity.position;
  let best: Entity | null = null;
  let bestD = range;
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === bot.entity || !isHostileMob(e)) continue;
    const d = me.distanceTo(e.position);
    if (d <= bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

/** Returns the number of swings made (0 = nothing was near). */
export async function fightNearbyHostiles(bot: Bot, stopped: () => boolean, maxMs = MAX_FIGHT_MS): Promise<number> {
  if (isCreative(bot)) return 0;
  const t0 = Date.now();
  let swings = 0;
  while (!stopped() && Date.now() - t0 < maxMs && bot.entity && bot.health > 0) {
    const mob = nearestHostileWithin(bot, MELEE_RANGE);
    if (!mob) break;
    try {
      const weapon = pickBestWeapon(bot);
      if (weapon && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, "hand");
      await bot.lookAt(mob.position.offset(0, (mob.height ?? 1.6) * 0.8, 0), true);
      bot.attack(mob);
      swings += 1;
    } catch {
      break;
    }
    await sleep(swingCooldownMs(bot.heldItem?.name));
  }
  if (swings > 0) console.log(`[${bot.username}] melee guard: ${swings} swing(s) at a mob on top of the bot`);
  return swings;
}
