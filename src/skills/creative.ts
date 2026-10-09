/**
 * Creative-mode inventory: `getItems` (the skill) and `creativeGive` (the
 * helper other skills use to auto-supply blocks / items in creative).
 *
 * Mechanism: `bot.creative.setInventorySlot(slot, item)` sends
 * `set_creative_slot`, which a creative-mode server honours for any item.
 * Gotchas from mineflayer 4.x `lib/plugins/creative.js` on a 1.21.3+ server
 * (feature `noAckOnCreateSetSlotPacket`):
 *  - The server sends NO ack. mineflayer writes the slot locally right away
 *    and, if `waitTimeout > 0`, watches `updateSlot:<n>` for a "rejection" —
 *    but that check compares `newItem.itemId`, which prismarine-item doesn't
 *    have (and throws on a null newItem), so it can never detect one. We pass
 *    `waitTimeout = 0` (no buggy listener) and pace ourselves instead.
 *  - Consequence: a set in survival would leave phantom local items the server
 *    never gave us. So every call is gated on the LIVE game mode.
 *  - Calling it twice on the same slot before the first settles throws; we set
 *    slots strictly one at a time.
 *  - Slot numbers are player-inventory window slots: 9–35 main, 36–44 hotbar
 *    (0–8 are crafting/armor, 45 off-hand is out of the allowed 0–44 range).
 */

import type { Bot } from "mineflayer";
import prismarineItem, { type Item } from "prismarine-item";
import { currentGameMode, isCreative } from "./game-mode.js";
import { resolveItem } from "./item-naming.js";
import type { SkillResult } from "./types.js";

const HOTBAR_SLOTS = [36, 37, 38, 39, 40, 41, 42, 43, 44];
const MAIN_SLOTS = Array.from({ length: 27 }, (_, i) => 9 + i);
/** Hotbar first — that's where a creative builder keeps their palette. */
const FILL_ORDER = [...HOTBAR_SLOTS, ...MAIN_SLOTS];
/** Pause between slot writes; keeps us well under Paper's packet limiter. */
const SLOT_WRITE_GAP_MS = 60;
export const GET_ITEMS_MAX_TYPES = 36;

type ItemCtor = typeof Item;
type ItemLoader = (registry: object) => ItemCtor;
// CJS `module.exports = loader` under NodeNext: at runtime the default import
// IS the loader, while the .d.ts types it as a namespace with `.default`.
// Accept either shape.
const loadItem = ((prismarineItem as unknown as { default?: ItemLoader }).default ??
  prismarineItem) as unknown as ItemLoader;
const ctorCache = new WeakMap<object, ItemCtor>();

function itemCtor(bot: Bot): ItemCtor {
  let ctor = ctorCache.get(bot.registry);
  if (!ctor) {
    ctor = loadItem(bot.registry);
    ctorCache.set(bot.registry, ctor);
  }
  return ctor;
}

/** Build the prismarine-item for a creative slot write. Exported for the offline sanity test. */
export function makeCreativeItem(bot: Bot, itemId: number, count: number): Item {
  const Ctor = itemCtor(bot);
  return new Ctor(itemId, count);
}

function stackSizeOf(bot: Bot, itemId: number): number {
  return bot.registry.items[itemId]?.stackSize ?? 64;
}

/** A stack we can safely rewrite with a bigger count (no enchants/damage/custom data to lose). */
function isPlainStack(item: Item): boolean {
  const comps = (item as Item & { components?: unknown[] }).components;
  return !item.nbt && (!comps || comps.length === 0);
}

async function writeSlot(bot: Bot, slot: number, item: Item): Promise<void> {
  const set = bot.creative.setInventorySlot as (slot: number, item: Item | null, waitTimeout?: number) => Promise<void>;
  await set(slot, item, 0);
  await new Promise((r) => setTimeout(r, SLOT_WRITE_GAP_MS));
}

export interface CreativeGiveResult {
  /** Items added by this call. */
  added: number;
  /** Count held after the call. */
  have: number;
  /** True if we ran out of free slots before reaching `want`. */
  full: boolean;
}

/**
 * Top the inventory up to at least `want` of `itemId` from the creative
 * inventory: grow existing plain stacks first, then fill empty slots hotbar
 * first. Never overwrites an occupied slot. Caller must have checked
 * `isCreative(bot)` — this re-checks and throws as a backstop.
 */
export async function creativeGive(bot: Bot, itemId: number, want: number): Promise<CreativeGiveResult> {
  if (!isCreative(bot)) throw new Error(`not in creative mode (${currentGameMode(bot)})`);
  const stackSize = stackSizeOf(bot, itemId);
  const before = bot.inventory.count(itemId, null);
  let need = want - before;
  if (need <= 0) return { added: 0, have: before, full: false };

  if (stackSize > 1) {
    for (const slot of FILL_ORDER) {
      if (need <= 0) break;
      const cur = bot.inventory.slots[slot];
      if (!cur || cur.type !== itemId || cur.count >= stackSize || !isPlainStack(cur)) continue;
      const add = Math.min(need, stackSize - cur.count);
      await writeSlot(bot, slot, makeCreativeItem(bot, itemId, cur.count + add));
      need -= add;
    }
  }
  for (const slot of FILL_ORDER) {
    if (need <= 0) break;
    if (bot.inventory.slots[slot]) continue;
    const n = Math.min(need, stackSize);
    await writeSlot(bot, slot, makeCreativeItem(bot, itemId, n));
    need -= n;
  }

  const have = bot.inventory.count(itemId, null);
  return { added: have - before, have, full: need > 0 };
}

export interface GetItemsParams {
  items: Array<{ name: string; count?: number }>;
}

/**
 * Creative-only: make sure the inventory holds at least `count` of each item
 * (default one full stack), taken from the creative inventory instantly — how
 * a creative player grabs building materials. Top-up semantics make repeat
 * calls harmless. Partial when the inventory fills up: ok:false with
 * state.got / state.missing so the agent can make room and retry.
 */
export async function getItems(bot: Bot, { items }: GetItemsParams): Promise<SkillResult> {
  if (!isCreative(bot)) {
    return {
      ok: false,
      message: `getItems only works in creative mode — you're in ${currentGameMode(bot)}. Gather, craft, or take it from a chest instead.`,
      state: { gameMode: currentGameMode(bot) },
    };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: "items must be a non-empty array" };
  }
  if (items.length > GET_ITEMS_MAX_TYPES) {
    return { ok: false, message: `at most ${GET_ITEMS_MAX_TYPES} item types per call (that's every slot)` };
  }

  // Resolve everything first so a typo fails before any slot is touched.
  type Resolved = { name: string; id: number; want: number };
  const resolved: Resolved[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]!;
    const r = resolveItem(bot, entry.name);
    if (!r.ok) return { ok: false, message: `items[${i}] ${r.message}` };
    if (r.normalized === "air") return { ok: false, message: `items[${i}] "air" isn't an item` };
    const want = entry.count ?? stackSizeOf(bot, r.data.id);
    if (want < 1) return { ok: false, message: `items[${i}] count must be >= 1, got ${want}` };
    resolved.push({ name: r.normalized, id: r.data.id, want });
  }

  const got: Array<{ item: string; added: number; have: number }> = [];
  const missing: Array<{ item: string; short: number }> = [];
  for (const r of resolved) {
    if (!isCreative(bot)) {
      return {
        ok: false,
        message: `game mode changed to ${currentGameMode(bot)} mid-call; stopped`,
        state: { got, gameMode: currentGameMode(bot) },
      };
    }
    try {
      const res = await creativeGive(bot, r.id, r.want);
      got.push({ item: r.name, added: res.added, have: res.have });
      if (res.full) missing.push({ item: r.name, short: r.want - res.have });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `getItems failed on ${r.name}: ${message}`, state: { got } };
    }
  }

  const summary = got.map((g) => `${g.item} x${g.have}`).join(", ");
  if (missing.length > 0) {
    return {
      ok: false,
      message: `inventory full — now holding ${summary}; still short ${missing
        .map((m) => `${m.short} ${m.item}`)
        .join(", ")}. Drop or deposit things you don't need, then call getItems again.`,
      state: { got, missing },
    };
  }
  return { ok: true, message: `got ${summary}`, state: { got } };
}
