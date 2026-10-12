import type { Bot, EquipmentDestination } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { getBotState } from "../state/index.js";
import { creativeGive } from "./creative.js";
import { isCreative } from "./game-mode.js";
import { resolveItem } from "./item-naming.js";
import { goTo } from "./movement.js";
import { navigate } from "./navigation.js";
import { isFreeableTreeBlock } from "./structure-guard.js";
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

/** Item name -> total count across all inventory stacks. */
export function inventoryCounts(bot: Bot): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of bot.inventory.items()) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
  return m;
}

/** Per-item positive gain of `after` over `before`. */
export function inventoryGain(before: Map<string, number>, after: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, n] of after) {
    const d = n - (before.get(name) ?? 0);
    if (d > 0) out[name] = d;
  }
  return out;
}

const DROP_SPAWN_WAIT_MS = 600;
const DROP_RESCAN_MS = 120;
const DROP_NEAR_RADIUS = 2.5;

/** Ids of the item entities currently loaded (take BEFORE breaking a block). */
export function snapshotItemIds(bot: Bot): Set<number> {
  const out = new Set<number>();
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e && e.name === "item") out.add(e.id);
  }
  return out;
}

function hasNewItemEntityNear(bot: Bot, pos: Vec3, radius: number, known: ReadonlySet<number>): boolean {
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e && e.name === "item" && !known.has(e.id) && e.position.distanceTo(pos) <= radius) return true;
  }
  return false;
}

/**
 * After breaking a block, the item entity arrives a few ticks later (server
 * packet), so a scan immediately after `bot.dig` sees nothing. Resolves true
 * as soon as a NEW item entity (one not in `knownIds`) is within ~2.5 blocks
 * of `pos` (entitySpawn event, with a short re-scan fallback in case the spawn
 * raced the listener), false after `timeoutMs`. Items that were already lying
 * there don't count: pass the `snapshotItemIds` taken before the dig as
 * `knownIds` (defaults to a snapshot taken now). Never throws.
 */
export function waitForDropNear(
  bot: Bot,
  pos: Vec3,
  timeoutMs = DROP_SPAWN_WAIT_MS,
  knownIds: ReadonlySet<number> = snapshotItemIds(bot),
): Promise<boolean> {
  if (hasNewItemEntityNear(bot, pos, DROP_NEAR_RADIUS, knownIds)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      bot.removeListener("entitySpawn", onSpawn);
      resolve(v);
    };
    const onSpawn = (e: { id: number; name?: string; position: Vec3 }): void => {
      if (e.name === "item" && !knownIds.has(e.id) && e.position.distanceTo(pos) <= DROP_NEAR_RADIUS) finish(true);
    };
    const timer = setTimeout(() => finish(hasNewItemEntityNear(bot, pos, DROP_NEAR_RADIUS, knownIds)), timeoutMs);
    const poll = setInterval(() => {
      if (hasNewItemEntityNear(bot, pos, DROP_NEAR_RADIUS, knownIds)) finish(true);
    }, DROP_RESCAN_MS);
    bot.on("entitySpawn", onSpawn);
  });
}

/**
 * Walk to every dropped item within `maxDist` and let natural ~1.5-block
 * auto-collect fire. Used both as a standalone skill ("pick up what I just
 * dropped") and internally by `mineBlock(s)` to collect drops.
 *
 * "Collected" is the INVENTORY delta across the call (state.gained, by item
 * name), not "the entity vanished" (another player or despawn also makes it
 * vanish). Snapshots the item list at entry, then makes one more pass for
 * drops that spawned mid-sweep; the skill returns and Claude can call it
 * again if needed.
 */
/** Internal options (not part of the Haiku-facing params). */
export interface PickUpOptions {
  /** Log gathering only: break the natural tree block an item is stuck on. Off by default. */
  freeStuck?: boolean;
}

export async function pickUpNearby(
  bot: Bot,
  { maxDist = PICKUP_DEFAULT_RADIUS }: PickUpNearbyParams = {},
  opts: PickUpOptions = {},
): Promise<SkillResult> {
  if (maxDist < 1 || maxDist > PICKUP_MAX_RADIUS) {
    return { ok: false, message: `maxDist must be between 1 and ${PICKUP_MAX_RADIUS}, got ${maxDist}` };
  }

  const targets = collectDroppedItemPositions(bot, maxDist);
  if (targets.length === 0) {
    return { ok: true, message: `no dropped items within ${maxDist} blocks`, state: { walked: 0, collected: 0, gained: {} } };
  }

  const before = inventoryCounts(bot);
  const cancellation = getBotState(bot.username)?.cancellation;
  const visited = new Set<number>();
  let walked = 0;
  for (let pass = 0; pass < 2; pass++) {
    const batch = pass === 0 ? targets : collectDroppedItemPositions(bot, maxDist).filter((t) => !visited.has(t.entityId));
    for (const target of batch) {
      visited.add(target.entityId);
      // Honour a stop between drops (also when called inside mineBlock(s)).
      if (cancellation?.isRequested()) break;
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
      walked += 1;
      await sleep(POST_GOTO_PICKUP_WAIT_MS);
      await sleep(PICKUP_PER_ITEM_WAIT_MS);
    }
    if (cancellation?.isRequested()) break;
  }
  // Items still lying around after two sweeps are usually perched where we can't stand:
  // on a stump/trunk top or on leaves. Break the natural block they rest on.
  // Only while felling trees (opt-in from the log-gathering paths): never on a generic pickup.
  if (opts.freeStuck && !cancellation?.isRequested()) await freeStuckDrops(bot, maxDist);

  const gained = inventoryGain(before, inventoryCounts(bot));
  const collected = Object.values(gained).reduce((a, b) => a + b, 0);
  if (collected === 0) {
    return {
      ok: false,
      message: `walked to ${walked} of ${targets.length} dropped item(s) within ${maxDist} blocks but collected none${bot.inventory.emptySlotCount() === 0 ? " (inventory is full)" : ""}`,
      state: { walked: targets.length, collected: 0, gained },
    };
  }
  const gainedText = Object.entries(gained).map(([n, c]) => `${c} ${n}`).join(", ");
  return {
    ok: true,
    message: `picked up ${gainedText} from the ground within ${maxDist} blocks`,
    state: { walked: targets.length, collected, gained },
  };
}

const STUCK_MAX_PER_CALL = 4;
const TREE_DROP_RE = /(_log|_wood|_sapling|_propagule|^stick$|^apple$|^golden_apple$|^azalea$|^flowering_azalea$|^vine$|_leaves$)/;
const STUCK_DIG_TIMEOUT_MS = 8_000;
const STUCK_SETTLE_MS = 700;

/**
 * For each dropped item still present: if it rests on leaves or on a natural
 * tree log (a stump top, a trunk, low canopy), walk within reach, break that
 * block (natural, so fair game), let the item fall and collect it. Bounded to
 * {@link STUCK_MAX_PER_CALL} items per call; every failure is swallowed.
 */
async function freeStuckDrops(bot: Bot, maxDist: number): Promise<void> {
  const cancellation = getBotState(bot.username)?.cancellation;
  let freed = 0;
  const verdicts = new Map<string, boolean>();
  for (const t of collectDroppedItemPositions(bot, maxDist)) {
    if (freed >= STUCK_MAX_PER_CALL || cancellation?.isRequested()) return;
    const e = bot.entities[t.entityId];
    if (!e || e.name !== "item") continue;
    if (!TREE_DROP_RE.test(t.itemName)) continue; // only things a felled tree drops
    const support = bot.blockAt(new Vec3(Math.floor(e.position.x), Math.floor(e.position.y - 0.3), Math.floor(e.position.z)));
    if (!support || !isFreeableTreeBlock((p) => bot.blockAt(p), support.position, verdicts)) continue;
    freed += 1;
    try {
      await goTo(bot, { target: { kind: "coords", coords: { x: support.position.x, y: support.position.y, z: support.position.z } }, reach: 3 });
      const fresh = bot.blockAt(support.position);
      if (!fresh || fresh.name !== support.name || !bot.canDigBlock(fresh)) continue;
      const pf = (bot as Bot & { pathfinder?: { bestHarvestTool?(b: unknown): Item | null } }).pathfinder;
      const tool = pf?.bestHarvestTool?.(fresh);
      if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, "hand").catch(() => {});
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          bot.dig(fresh),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => {
              try { bot.stopDigging?.(); } catch { /* best-effort */ }
              rej(new Error("dig timeout"));
            }, STUCK_DIG_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      console.log(`[${bot.username}] [pickup] broke ${support.name} at (${support.position.x}, ${support.position.y}, ${support.position.z}) to free a ${t.itemName}`);
      await sleep(STUCK_SETTLE_MS);
      const again = bot.entities[t.entityId];
      if (again && again.name === "item") {
        await goTo(bot, { target: { kind: "coords", coords: { x: again.position.x, y: again.position.y, z: again.position.z } }, reach: 1 });
        await sleep(POST_GOTO_PICKUP_WAIT_MS + PICKUP_PER_ITEM_WAIT_MS);
      }
    } catch (err) {
      console.log(`[${bot.username}] [pickup] could not free ${t.itemName}: ${err instanceof Error ? err.message : err}`);
    }
  }
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
 * Single-item handoff. Thin wrapper around `giveItemsTo` so size-1 calls
 * share exactly the batch code path — see that skill for the full
 * walk-and-toss flow.
 */
export async function giveItemTo(
  bot: Bot,
  { player, item, count }: GiveItemToParams,
): Promise<SkillResult> {
  return giveItemsTo(bot, {
    player,
    items: [count !== undefined ? { item, count } : { item }],
  });
}

export interface GiveItemsToParams {
  player: string;
  items: Array<{ item: string; count?: number }>;
}

/**
 * Walk within drop range of `player` once, face them, then toss each item
 * in `items` in sequence. The natural ~1.5-block item-attraction radius
 * pulls each stack into the player. One LLM round-trip covers an
 * arbitrarily-large handoff (full iron toolset, full armor set, etc.) —
 * the unary `giveItemTo` is a wrapper around this.
 *
 * Failure model mirrors `placeBlocks`: pre-resolves every item (so a typo
 * fails before walking), stops at the first per-item failure, and returns
 * `state.given[]` with what landed plus `state.failedIndex` for re-planning.
 */
export async function giveItemsTo(
  bot: Bot,
  { player, items }: GiveItemsToParams,
): Promise<SkillResult> {
  if (!player) return { ok: false, message: "player name required" };
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: "items must be a non-empty array" };
  }

  const playerInfo = bot.players[player];
  if (!playerInfo?.entity) {
    return { ok: false, message: `player "${player}" is not visible to the bot` };
  }

  // Pre-resolve every item + verify inventory has stock. Fail fast before
  // walking so a typo or missing-item doesn't waste a trip.
  type Resolved = { name: string; itemId: number; want?: number };
  const resolved: Resolved[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]!;
    const r = resolveItem(bot, entry.item);
    if (!r.ok) return { ok: false, message: `items[${i}] ${r.message}` };
    if (entry.count !== undefined && entry.count < 1) {
      return { ok: false, message: `items[${i}] count must be >= 1, got ${entry.count}` };
    }
    const have = bot.inventory.count(r.data.id, null);
    if (isCreative(bot) && (have === 0 || (entry.count !== undefined && have < entry.count))) {
      // Creative: hand over what was asked even if we don't hold it yet —
      // take it from the creative inventory first (default one stack).
      const want = entry.count ?? (bot.registry.items[r.data.id]?.stackSize ?? 64);
      try {
        await creativeGive(bot, r.data.id, want);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `items[${i}] couldn't take ${r.normalized} from the creative inventory: ${message}` };
      }
    }
    if (bot.inventory.count(r.data.id, null) === 0) {
      return { ok: false, message: `items[${i}] no ${r.normalized} in inventory to give to ${player}` };
    }
    resolved.push({ name: r.normalized, itemId: r.data.id, want: entry.count });
  }

  const playerPos = playerInfo.entity.position;
  const nav = await navigate(
    bot,
    new goals.GoalNear(playerPos.x, playerPos.y, playerPos.z, GIVE_DROP_REACH),
    { label: `${player} (for handoff)`, target: playerPos },
  );
  if (!nav.ok) return { ok: false, message: `gave nothing: ${nav.message}`, state: nav.state };

  // Players rarely stand still during a walk-over; close the gap once more
  // so the toss actually lands at their feet instead of short of them.
  let liveEntity = bot.players[player]?.entity;
  if (liveEntity && bot.entity.position.distanceTo(liveEntity.position) > GIVE_DROP_REACH + 1.5) {
    const p = liveEntity.position;
    // Best effort — on failure, toss from where we are.
    await navigate(bot, new goals.GoalNear(p.x, p.y, p.z, GIVE_DROP_REACH), { label: player, target: p });
    liveEntity = bot.players[player]?.entity;
  }
  if (liveEntity) {
    try {
      await bot.lookAt(liveEntity.position.offset(0, liveEntity.height ?? 1.6, 0));
    } catch {
      // lookAt is cosmetic — don't fail the skill on a look glitch.
    }
  }

  const given: Array<{ item: string; count: number }> = [];
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i]!;
    const drop = await dropItem(
      bot,
      r.want !== undefined ? { item: r.name, count: r.want } : { item: r.name },
    );
    if (!drop.ok) {
      return {
        ok: false,
        message: `giveItemsTo failed at items[${i}] (${r.name}) after giving ${given.length} of ${resolved.length}: ${drop.message}`,
        state: { given, failedIndex: i, failedItem: r.name },
      };
    }
    given.push({ item: r.name, count: (drop.state as { dropped: number }).dropped });
  }

  const summary = given.map((g) => `${g.count} ${g.item}`).join(", ");
  return {
    ok: true,
    message: given.length === 1
      ? `gave ${summary} to ${player}`
      : `gave ${given.length} stacks (${summary}) to ${player}`,
    state: { given },
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

export interface EquipLoadoutParams {
  head?: string;
  torso?: string;
  legs?: string;
  feet?: string;
  hand?: string;
  offHand?: string;
}

/**
 * Equip several slots in one call. Slots are an object (not an array)
 * because the destinations are a closed set — keeps the call site
 * self-documenting (`{ head: "iron_helmet", torso: "iron_chestplate", ... }`)
 * and lets the agent omit slots it doesn't care about.
 *
 * Stops at the first per-slot failure and returns `state.equipped[]` plus
 * `state.failedSlot` for re-planning. Order is fixed (head → torso → legs
 * → feet → hand → off-hand) — Minecraft doesn't care about armor order, but
 * the deterministic order makes failures predictable to debug.
 *
 * `equipItem` (single slot) stays as a separate skill: it's still the right
 * call for "equip my pickaxe" and is used internally by `activateBlock` /
 * `useOnEntity` via their `with` parameter.
 */
export async function equipLoadout(
  bot: Bot,
  { head, torso, legs, feet, hand, offHand }: EquipLoadoutParams = {},
): Promise<SkillResult> {
  const requested: Array<{ slot: EquipmentDestination; item: string }> = [];
  if (head !== undefined) requested.push({ slot: "head", item: head });
  if (torso !== undefined) requested.push({ slot: "torso", item: torso });
  if (legs !== undefined) requested.push({ slot: "legs", item: legs });
  if (feet !== undefined) requested.push({ slot: "feet", item: feet });
  if (hand !== undefined) requested.push({ slot: "hand", item: hand });
  if (offHand !== undefined) requested.push({ slot: "off-hand", item: offHand });

  if (requested.length === 0) {
    return {
      ok: false,
      message: "at least one slot must be specified (head, torso, legs, feet, hand, offHand)",
    };
  }

  const equipped: Array<{ slot: EquipmentDestination; item: string }> = [];
  for (let i = 0; i < requested.length; i++) {
    const { slot, item } = requested[i]!;
    const result = await equipItem(bot, { item, slot });
    if (!result.ok) {
      return {
        ok: false,
        message: `equipLoadout failed at slot "${slot}" (${item}) after equipping ${equipped.length} of ${requested.length}: ${result.message}`,
        state: { equipped, failedSlot: slot, failedItem: item },
      };
    }
    equipped.push({ slot, item });
  }

  const summary = equipped.map((e) => `${e.item} (${e.slot})`).join(", ");
  return {
    ok: true,
    message: equipped.length === 1
      ? `equipped ${summary}`
      : `equipped ${equipped.length} slots: ${summary}`,
    state: { equipped },
  };
}
