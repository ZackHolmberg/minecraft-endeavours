import type { Bot } from "mineflayer";
import pathfinderPkg, { type Pathfinder } from "mineflayer-pathfinder";

const { goals, Movements } = pathfinderPkg;
import { Vec3 } from "vec3";
import { goTo } from "./movement.js";
import type { SkillResult } from "./types.js";

const PICKUP_DEFAULT_RADIUS = 8;
const PICKUP_MAX_RADIUS = 32;
const PICKUP_PER_ITEM_WAIT_MS = 350;
const POST_GOTO_PICKUP_WAIT_MS = 250;
const GIVE_DROP_REACH = 2;

interface BotWithPathfinder extends Bot {
  pathfinder: Pathfinder;
}

export interface PickUpNearbyParams {
  /** Search radius in blocks. Defaults to 8, max 32. */
  maxDist?: number;
}

/**
 * Walk to every dropped item within `maxDist` and let natural ~1.5-block
 * auto-collect fire. Used both as a standalone skill ("pick up what I just
 * dropped") and internally by `mineBlock` to backstop the unreliable
 * post-dig auto-collect that the slice-3 smoke test surfaced.
 *
 * Snapshots the item list at entry so newly-spawned drops mid-sweep don't
 * loop forever; the skill returns and Claude can call it again if needed.
 */
export async function pickUpNearby(
  bot: Bot,
  { maxDist = PICKUP_DEFAULT_RADIUS }: PickUpNearbyParams = {},
): Promise<SkillResult> {
  if (maxDist < 1 || maxDist > PICKUP_MAX_RADIUS) {
    return { ok: false, message: `maxDist must be between 1 and ${PICKUP_MAX_RADIUS}, got ${maxDist}` };
  }

  const targets = collectDroppedItemPositions(bot, maxDist);
  if (targets.length === 0) {
    return { ok: true, message: `no dropped items within ${maxDist} blocks` };
  }

  let collected = 0;
  for (const target of targets) {
    // Re-check that the item still exists — natural pickup may have already
    // claimed it while we were walking to a previous one.
    const stillThere = bot.entities[target.entityId];
    if (!stillThere || stillThere.name !== "item") continue;

    const result = await goTo(bot, {
      target: { kind: "coords", coords: { x: target.pos.x, y: target.pos.y, z: target.pos.z } },
      reach: 1,
    });
    if (!result.ok) {
      // Path failures on individual drops are tolerable — keep sweeping.
      continue;
    }
    await sleep(POST_GOTO_PICKUP_WAIT_MS);
    if (!bot.entities[target.entityId]) collected += 1;
    await sleep(PICKUP_PER_ITEM_WAIT_MS);
  }

  if (collected === 0) {
    return {
      ok: false,
      message: `walked to ${targets.length} dropped item(s) within ${maxDist} blocks but collected none`,
      state: { walked: targets.length, collected: 0 },
    };
  }
  return {
    ok: true,
    message: `picked up ${collected} dropped item stack(s) within ${maxDist} blocks`,
    state: { walked: targets.length, collected },
  };
}

interface DropTarget {
  entityId: number;
  pos: Vec3;
  itemName: string;
}

function collectDroppedItemPositions(bot: Bot, maxDist: number): DropTarget[] {
  const me = bot.entity.position;
  const out: Array<DropTarget & { dist: number }> = [];
  for (const id of Object.keys(bot.entities)) {
    const entity = bot.entities[id];
    if (!entity || entity.name !== "item") continue;
    const dist = me.distanceTo(entity.position);
    if (dist > maxDist) continue;
    const item = entity.getDroppedItem?.();
    out.push({
      entityId: entity.id,
      pos: entity.position.clone(),
      itemName: item?.name ?? "item",
      dist,
    });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.map(({ entityId, pos, itemName }) => ({ entityId, pos, itemName }));
}

export interface DropItemParams {
  item: string;
  count?: number;
}

/**
 * Toss `count` of `item` from inventory onto the ground at the bot's feet.
 * If `count` is omitted, drops every matching stack. Partial-progress is
 * reported in `state.dropped` on failure (e.g. inventory had fewer than
 * requested).
 */
export async function dropItem(
  bot: Bot,
  { item, count }: DropItemParams,
): Promise<SkillResult> {
  if (!item) return { ok: false, message: "item is required" };
  if (count !== undefined && count < 1) {
    return { ok: false, message: `count must be >= 1, got ${count}` };
  }

  const itemData = bot.registry.itemsByName[item];
  if (!itemData) return { ok: false, message: `unknown item "${item}"` };

  const available = bot.inventory.items().filter((i) => i.type === itemData.id);
  if (available.length === 0) {
    return { ok: false, message: `no ${item} in inventory to drop` };
  }
  const totalAvailable = available.reduce((sum, s) => sum + s.count, 0);
  const want = count ?? totalAvailable;

  let dropped = 0;
  let remaining = want;
  for (const stack of available) {
    if (remaining <= 0) break;
    const take = Math.min(stack.count, remaining);
    try {
      await bot.toss(stack.type, stack.metadata ?? null, take);
      dropped += take;
      remaining -= take;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `dropped ${dropped} of ${want} ${item}; toss failed: ${message}`,
        state: { dropped },
      };
    }
  }

  if (dropped < want) {
    return {
      ok: false,
      message: `dropped ${dropped} of ${want} ${item}; only ${totalAvailable} were available`,
      state: { dropped },
    };
  }
  return { ok: true, message: `dropped ${dropped} ${item}`, state: { dropped } };
}

export interface GiveItemToParams {
  player: string;
  item: string;
  count?: number;
}

/**
 * Composite: walk within drop range of `player`, face them, drop the items.
 * The natural item-attraction radius (~1.5 blocks) pulls the stack into the
 * player. Fails if the player isn't visible, the bot can't reach them, or
 * the bot doesn't have the requested item.
 */
export async function giveItemTo(
  bot: Bot,
  { player, item, count }: GiveItemToParams,
): Promise<SkillResult> {
  if (!player) return { ok: false, message: "player name required" };
  if (!item) return { ok: false, message: "item is required" };

  const playerInfo = bot.players[player];
  if (!playerInfo?.entity) {
    return { ok: false, message: `player "${player}" is not visible to the bot` };
  }

  const itemData = bot.registry.itemsByName[item];
  if (!itemData) return { ok: false, message: `unknown item "${item}"` };
  const have = bot.inventory.items().filter((i) => i.type === itemData.id);
  if (have.length === 0) {
    return { ok: false, message: `no ${item} in inventory to give to ${player}` };
  }

  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);

  const playerPos = playerInfo.entity.position;
  const goal = new goals.GoalNear(playerPos.x, playerPos.y, playerPos.z, GIVE_DROP_REACH);
  try {
    await pBot.pathfinder.goto(goal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `couldn't reach ${player} to hand off ${item}: ${message}` };
  }

  // Refresh the player position post-walk; they may have moved.
  const liveEntity = bot.players[player]?.entity;
  if (liveEntity) {
    try {
      await bot.lookAt(liveEntity.position.offset(0, liveEntity.height ?? 1.6, 0));
    } catch {
      // lookAt is cosmetic — don't fail the skill on a look glitch.
    }
  }

  const drop = await dropItem(bot, count !== undefined ? { item, count } : { item });
  if (!drop.ok) {
    return { ok: false, message: `reached ${player} but: ${drop.message}`, state: drop.state };
  }
  const droppedCount = (drop.state as { dropped: number }).dropped;
  return {
    ok: true,
    message: `gave ${droppedCount} ${item} to ${player}`,
    state: drop.state,
  };
}

function ensureMovements(bot: BotWithPathfinder): void {
  if (!bot.pathfinder.movements || bot.pathfinder.movements.bot !== bot) {
    bot.pathfinder.setMovements(new Movements(bot));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
