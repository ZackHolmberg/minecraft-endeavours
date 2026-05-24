import type { Bot, EquipmentDestination } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { resolveItem } from "./item-naming.js";
import { goTo } from "./movement.js";
import { ensureMovements, type BotWithPathfinder } from "./pathfinder-config.js";
import type { SkillResult } from "./types.js";

const PICKUP_DEFAULT_RADIUS = 8;
const PICKUP_MAX_RADIUS = 32;
const PICKUP_PER_ITEM_WAIT_MS = 350;
const POST_GOTO_PICKUP_WAIT_MS = 250;
const GIVE_DROP_REACH = 2;

// Slot indices inside the player's own inventory window (prismarine-windows
// PlayerWin layout): 5–8 are armor (head/torso/legs/feet), 45 is the off-hand.
const ARMOR_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8 } as const;
const OFFHAND_SLOT = 45;

const EQUIPMENT_DESTINATIONS = new Set<EquipmentDestination>([
  "hand",
  "off-hand",
  "head",
  "torso",
  "legs",
  "feet",
]);

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
  const r = resolveItem(bot, item);
  if (!r.ok) return { ok: false, message: `item ${r.message}` };
  const itemData = r.data;
  const name = r.normalized;
  if (count !== undefined && count < 1) {
    return { ok: false, message: `count must be >= 1, got ${count}` };
  }

  const available = bot.inventory.items().filter((i) => i.type === itemData.id);
  if (available.length === 0) {
    return { ok: false, message: `no ${name} in inventory to drop` };
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
        message: `dropped ${dropped} of ${want} ${name}; toss failed: ${message}`,
        state: { dropped },
      };
    }
  }

  if (dropped < want) {
    return {
      ok: false,
      message: `dropped ${dropped} of ${want} ${name}; only ${totalAvailable} were available`,
      state: { dropped },
    };
  }
  return { ok: true, message: `dropped ${dropped} ${name}`, state: { dropped } };
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
  const r = resolveItem(bot, item);
  if (!r.ok) return { ok: false, message: `item ${r.message}` };
  const itemData = r.data;
  const name = r.normalized;

  const playerInfo = bot.players[player];
  if (!playerInfo?.entity) {
    return { ok: false, message: `player "${player}" is not visible to the bot` };
  }

  const have = bot.inventory.items().filter((i) => i.type === itemData.id);
  if (have.length === 0) {
    return { ok: false, message: `no ${name} in inventory to give to ${player}` };
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

  const drop = await dropItem(bot, count !== undefined ? { item: name, count } : { item: name });
  if (!drop.ok) {
    return { ok: false, message: `reached ${player} but: ${drop.message}`, state: drop.state };
  }
  const droppedCount = (drop.state as { dropped: number }).dropped;
  return {
    ok: true,
    message: `gave ${droppedCount} ${name} to ${player}`,
    state: drop.state,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CheckInventoryParams {
  // No params — always returns the full grouped view.
}

interface InventoryGroup {
  name: string;
  count: number;
  /** Number of slots this item occupies (separate stacks). */
  stacks: number;
  /** Percent durability remaining, only for damageable items. */
  durabilityPct?: number;
  /** Where this item is equipped, if anywhere. */
  equippedAt?: EquipmentDestination;
}

/**
 * Read-only inventory report. Aggregates main inventory + hotbar + armor +
 * off-hand into a flat grouped list, with durability for damageable items
 * and equipped-slot annotations. Without this skill the model only sees
 * `heldItem` via observeSurroundings — it can't know whether shears /
 * buckets / hoes / etc. are available before trying to use them.
 */
export async function checkInventory(bot: Bot, _params: CheckInventoryParams = {}): Promise<SkillResult> {
  void _params;
  const slots = bot.inventory.slots;
  const armorSlots = bot.inventory.slots;

  const heldStackIndex = bot.heldItem ? bot.inventory.hotbarStart + bot.quickBarSlot : -1;

  type Entry = InventoryGroup & { _slots: number[] };
  const groups = new Map<string, Entry>();

  const recordItem = (item: Item, slotIdx: number, equippedAt?: EquipmentDestination): void => {
    let entry = groups.get(item.name);
    if (!entry) {
      entry = {
        name: item.name,
        count: 0,
        stacks: 0,
        _slots: [],
      };
      groups.set(item.name, entry);
    }
    entry.count += item.count;
    entry.stacks += 1;
    entry._slots.push(slotIdx);
    if (item.maxDurability && item.maxDurability > 0) {
      const used = item.durabilityUsed ?? 0;
      const pct = Math.max(0, Math.round(((item.maxDurability - used) / item.maxDurability) * 100));
      // For multi-stack tools, take the freshest durability we've seen.
      if (entry.durabilityPct === undefined || pct > entry.durabilityPct) {
        entry.durabilityPct = pct;
      }
    }
    if (equippedAt && entry.equippedAt === undefined) entry.equippedAt = equippedAt;
  };

  // Main inventory + hotbar — bot.inventory.items() returns just these.
  for (const item of bot.inventory.items()) {
    const slotIdx = item.slot;
    const equippedAt: EquipmentDestination | undefined = slotIdx === heldStackIndex ? "hand" : undefined;
    recordItem(item, slotIdx, equippedAt);
  }

  // Armor + off-hand are outside items(); read by slot index.
  for (const [name, slotIdx] of Object.entries(ARMOR_SLOTS) as Array<[keyof typeof ARMOR_SLOTS, number]>) {
    const item = armorSlots[slotIdx] as Item | null | undefined;
    if (!item) continue;
    recordItem(item, slotIdx, name);
  }
  const offhand = armorSlots[OFFHAND_SLOT] as Item | null | undefined;
  if (offhand) recordItem(offhand, OFFHAND_SLOT, "off-hand");

  const groupsOut: InventoryGroup[] = [...groups.values()]
    .map(({ _slots, ...rest }) => {
      void _slots;
      return rest;
    })
    .sort((a, b) => b.count - a.count);

  // ~36 main+hotbar slots; off-hand and armor are separate.
  const mainCapacity = bot.inventory.inventoryEnd - bot.inventory.inventoryStart + 9;
  const occupied = bot.inventory.items().length;

  const summary = groupsOut
    .slice(0, 6)
    .map((g) =>
      g.durabilityPct !== undefined
        ? `${g.name} (${g.durabilityPct}%)`
        : g.count > 1
          ? `${g.count} ${g.name}`
          : g.name,
    )
    .join(", ");
  const message = groupsOut.length === 0
    ? "inventory empty"
    : `${summary}${groupsOut.length > 6 ? ` (+${groupsOut.length - 6} more)` : ""}; ${occupied}/${mainCapacity} slots used`;

  return {
    ok: true,
    message,
    state: {
      groups: groupsOut,
      heldItem: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null,
      occupiedSlots: occupied,
      mainCapacity,
    },
  };
}

export interface EquipItemParams {
  item: string;
  slot?: EquipmentDestination;
}

/**
 * Explicit equip to a destination slot. Defaults to `hand`. Lookup is by
 * item name across the entire inventory (main + hotbar + already-equipped
 * armor). Failures distinguish "not in inventory" from "equip API rejected".
 */
export async function equipItem(
  bot: Bot,
  { item, slot = "hand" }: EquipItemParams,
): Promise<SkillResult> {
  if (!EQUIPMENT_DESTINATIONS.has(slot)) {
    return {
      ok: false,
      message: `slot must be one of hand / off-hand / head / torso / legs / feet; got "${slot}"`,
    };
  }
  const r = resolveItem(bot, item);
  if (!r.ok) return { ok: false, message: `item ${r.message}` };
  const itemData = r.data;
  const name = r.normalized;

  // Already in the requested slot? Skip the API call.
  if (slot === "hand" && bot.heldItem?.type === itemData.id) {
    return { ok: true, message: `already holding ${name}`, state: { equipped: name, slot } };
  }

  const stack = bot.inventory.items().find((i) => i.type === itemData.id);
  // Also check armor slots — re-equipping armor that's already worn is a no-op
  // path the API handles, but we want a specific message either way.
  const allSlots = bot.inventory.slots;
  const armorStack = !stack
    ? Object.values(ARMOR_SLOTS).map((idx) => allSlots[idx]).find((i) => i?.type === itemData.id)
    : null;
  const offhandStack = !stack && !armorStack && (allSlots[OFFHAND_SLOT] as Item | null | undefined)?.type === itemData.id
    ? (allSlots[OFFHAND_SLOT] as Item)
    : null;
  const found = stack ?? armorStack ?? offhandStack;
  if (!found) {
    return { ok: false, message: `no ${name} in inventory to equip` };
  }

  try {
    await bot.equip(found, slot);
    return { ok: true, message: `equipped ${name} (${slot})`, state: { equipped: name, slot } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `equip ${name} → ${slot} failed: ${message}` };
  }
}
