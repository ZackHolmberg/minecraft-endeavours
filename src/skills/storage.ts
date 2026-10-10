import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { noteContainerOpening } from "../mineflayer-glue/event-hooks.js";
import { readWorldKnowledge, type Container } from "../memory/world-knowledge.js";
import { CONTAINER_SCAN_RADIUS, findNearbyContainers, isContainerName } from "./containers.js";
import { resolveItem } from "./item-naming.js";
import { navigate } from "./navigation.js";
import type { Coords, SkillResult } from "./types.js";

const CHEST_REACH = 2;
/** Live scan radius for a chest in plain sight when memory has nothing closer. */
const CHEST_SEARCH_RADIUS = CONTAINER_SCAN_RADIUS;

export interface DepositToChestParams {
  item: string;
  count?: number;
  pos?: Coords;
}

/**
 * Single-item deposit. Thin wrapper around `depositManyToChest` so size-1
 * calls share exactly the batch code path.
 */
export async function depositToChest(
  bot: Bot,
  { item, count, pos }: DepositToChestParams,
): Promise<SkillResult> {
  return depositManyToChest(bot, {
    items: [count !== undefined ? { item, count } : { item }],
    pos,
  });
}

export interface DepositManyToChestParams {
  items: Array<{ item: string; count?: number }>;
  pos?: Coords;
}

/**
 * Walk to a chest once, open once, deposit each item in sequence, close
 * once. One LLM round-trip stashes a whole post-mining haul. The container
 * auto-capture hook in `mineflayer-glue/event-hooks.ts` snapshots final
 * contents on close — closing once also means storage memory updates once
 * per batch rather than once per item.
 *
 * Pre-resolves every item and verifies inventory has stock before walking,
 * so a typo or empty-stack fails fast. Per-item `count` omitted = "deposit
 * every matching stack" (same semantics as unary).
 *
 * Failure model: stops at first deposit failure, returns `state.deposited[]`
 * (what landed) + `state.failedIndex` + `state.failedItem`. Chest is always
 * closed via finally so auto-capture still fires.
 */
export async function depositManyToChest(
  bot: Bot,
  { items, pos }: DepositManyToChestParams,
): Promise<SkillResult> {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: "items must be a non-empty array" };
  }

  type Resolved = { name: string; itemId: number; want: number };
  const resolved: Resolved[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]!;
    const r = resolveItem(bot, entry.item);
    if (!r.ok) return { ok: false, message: `items[${i}] ${r.message}` };
    if (entry.count !== undefined && entry.count < 1) {
      return { ok: false, message: `items[${i}] count must be >= 1, got ${entry.count}` };
    }
    const available = bot.inventory.count(r.data.id, null);
    if (available === 0) {
      return { ok: false, message: `items[${i}] no ${r.normalized} in inventory to deposit` };
    }
    const want = entry.count ?? available;
    if (want > available) {
      return {
        ok: false,
        message: `items[${i}] cannot deposit ${want} ${r.normalized}: only ${available} in inventory`,
      };
    }
    resolved.push({ name: r.normalized, itemId: r.data.id, want });
  }

  const chestResolved = await resolveChestBlock(bot, pos, "deposit");
  if (!chestResolved.ok) return chestResolved;
  const { block, source } = chestResolved;
  const posOut = { x: block.position.x, y: block.position.y, z: block.position.z };

  const walk = await walkToChest(bot, block);
  if (!walk.ok) return walk;

  noteContainerOpening(bot.username, block);
  let chest;
  try {
    chest = await bot.openChest(block);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `failed to open ${block.name} at ${fmt(block.position)}: ${message}` };
  }

  const deposited: Array<{ item: string; count: number }> = [];
  try {
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i]!;
      try {
        await chest.deposit(r.itemId, null, r.want);
        deposited.push({ item: r.name, count: r.want });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const message = /full/i.test(raw) ? `${block.name} is full — deposit into another chest (pass pos) or place a new chest` : raw;
        return {
          ok: false,
          message: `depositManyToChest failed at items[${i}] (${r.name}) after depositing ${deposited.length} of ${resolved.length}: ${message}`,
          state: { deposited, failedIndex: i, failedItem: r.name, container: block.name, pos: posOut },
        };
      }
    }
  } finally {
    chest.close();
  }

  const summary = deposited.map((d) => `${d.count} ${d.item}`).join(", ");
  return {
    ok: true,
    message: deposited.length === 1
      ? `deposited ${summary} into ${block.name} at ${fmt(block.position)} (${source})`
      : `deposited ${deposited.length} stacks (${summary}) into ${block.name} at ${fmt(block.position)} (${source})`,
    state: { deposited, container: block.name, pos: posOut },
  };
}

export interface WithdrawFromChestParams {
  item: string;
  count?: number;
  pos?: Coords;
}

/**
 * Single-item withdraw. Thin wrapper around `withdrawManyFromChest`.
 */
export async function withdrawFromChest(
  bot: Bot,
  { item, count = 1, pos }: WithdrawFromChestParams,
): Promise<SkillResult> {
  return withdrawManyFromChest(bot, { items: [{ item, count }], pos });
}

export interface WithdrawManyFromChestParams {
  items: Array<{ item: string; count?: number }>;
  pos?: Coords;
}

/**
 * Batch withdraw from a single chest. Walks + opens + closes once. When
 * `pos` is omitted, resolves the chest by the *first* item — multi-item
 * batches that span chests should be split into multiple calls by the
 * agent (the per-chest walk dominates the cost, so two calls for two
 * chests is still much cheaper than 2×N for N items each).
 *
 * Per-item: verifies the chest actually has the item (memory may be stale)
 * and clamps `want` to what's in the chest. Partial pulls are noted in
 * the success message; only a fully-empty slot fails the batch.
 */
export async function withdrawManyFromChest(
  bot: Bot,
  { items, pos }: WithdrawManyFromChestParams,
): Promise<SkillResult> {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: "items must be a non-empty array" };
  }

  type Resolved = { name: string; itemId: number; want: number };
  const resolved: Resolved[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]!;
    const r = resolveItem(bot, entry.item);
    if (!r.ok) return { ok: false, message: `items[${i}] ${r.message}` };
    const want = entry.count ?? 1;
    if (want < 1) {
      return { ok: false, message: `items[${i}] count must be >= 1, got ${want}` };
    }
    resolved.push({ name: r.normalized, itemId: r.data.id, want });
  }

  const chestResolved = pos
    ? await resolveChestBlock(bot, pos, "withdraw")
    : await resolveChestBlock(bot, undefined, "withdraw", resolved[0]!.name);
  if (!chestResolved.ok) return chestResolved;
  const { block, source } = chestResolved;
  const posOut = { x: block.position.x, y: block.position.y, z: block.position.z };

  const walk = await walkToChest(bot, block);
  if (!walk.ok) return walk;

  noteContainerOpening(bot.username, block);
  let chest;
  try {
    chest = await bot.openChest(block);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `failed to open ${block.name} at ${fmt(block.position)}: ${message}` };
  }

  const withdrawn: Array<{ item: string; count: number }> = [];
  const partialNotes: string[] = [];
  try {
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i]!;
      const inside = chest.containerItems().filter((it) => it.type === r.itemId);
      const insideCount = inside.reduce((sum, it) => sum + it.count, 0);
      if (insideCount === 0) {
        return {
          ok: false,
          message: `withdrawManyFromChest failed at items[${i}] (${r.name}) after withdrawing ${withdrawn.length} of ${resolved.length}: ${block.name} at ${fmt(block.position)} has no ${r.name}`,
          state: { withdrawn, failedIndex: i, failedItem: r.name, container: block.name, pos: posOut },
        };
      }
      const take = Math.min(r.want, insideCount);
      try {
        await chest.withdraw(r.itemId, null, take);
        withdrawn.push({ item: r.name, count: take });
        if (take < r.want) {
          partialNotes.push(`${r.name}: requested ${r.want}, got ${take}`);
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const message = /full/i.test(raw) ? "my inventory is full — deposit or drop something first" : raw;
        return {
          ok: false,
          message: `withdrawManyFromChest failed at items[${i}] (${r.name}) after withdrawing ${withdrawn.length} of ${resolved.length}: ${message}`,
          state: { withdrawn, failedIndex: i, failedItem: r.name, container: block.name, pos: posOut },
        };
      }
    }
  } finally {
    chest.close();
  }

  const summary = withdrawn.map((w) => `${w.count} ${w.item}`).join(", ");
  const partial = partialNotes.length > 0 ? ` (partial: ${partialNotes.join("; ")})` : "";
  return {
    ok: true,
    message: withdrawn.length === 1
      ? `withdrew ${summary} from ${block.name} at ${fmt(block.position)} (${source})${partial}`
      : `withdrew ${withdrawn.length} stacks (${summary}) from ${block.name} at ${fmt(block.position)} (${source})${partial}`,
    state: { withdrawn, container: block.name, pos: posOut },
  };
}

type ResolveResult =
  | { ok: true; block: Block; source: "caller" | "nearest known" | "known with item" | "nearby" | "nearby, contents unknown" }
  | { ok: false; message: string };

async function resolveChestBlock(
  bot: Bot,
  pos: Coords | undefined,
  intent: "deposit" | "withdraw",
  itemForWithdraw?: string,
): Promise<ResolveResult> {
  if (pos) {
    const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!block) {
      return { ok: false, message: `chunk at ${fmt(new Vec3(pos.x, pos.y, pos.z))} isn't loaded — walk closer first` };
    }
    if (!isContainerName(block.name)) {
      return {
        ok: false,
        message: `block at ${fmt(block.position)} is ${block.name}, not a container`,
      };
    }
    return { ok: true, block, source: "caller" };
  }

  const world = await readWorldKnowledge(bot.username);
  const nearby = findNearbyContainer(bot);
  const isKnown = (b: Block): boolean =>
    world.containers.some((c) => c.position.x === b.position.x && c.position.y === b.position.y && c.position.z === b.position.z);

  if (world.containers.length === 0) {
    // Nothing remembered yet — use a chest in plain sight, like a player would.
    if (nearby) return { ok: true, block: nearby, source: intent === "withdraw" ? "nearby, contents unknown" : "nearby" };
    return {
      ok: false,
      message: `no chest within ${CHEST_SEARCH_RADIUS} blocks and none remembered; walk to one or pass an explicit pos${intent === "deposit" ? " (or craft + place a chest: 8 planks)" : ""}`,
    };
  }

  let candidates: Array<{ c: Container; dist: number }> = world.containers.map((c) => ({
    c,
    dist: bot.entity.position.distanceTo(new Vec3(c.position.x, c.position.y, c.position.z)),
  }));

  if (intent === "withdraw" && itemForWithdraw) {
    candidates = candidates.filter((entry) =>
      (entry.c.contents ?? []).some((row) => row.item === itemForWithdraw && row.count > 0),
    );
    if (candidates.length === 0) {
      // An unopened chest nearby might have it — worth one look.
      if (nearby && !isKnown(nearby)) return { ok: true, block: nearby, source: "nearby, contents unknown" };
      return {
        ok: false,
        message: `no remembered container holds ${itemForWithdraw}; pass an explicit pos or gather fresh`,
      };
    }
  }

  candidates.sort((a, b) => a.dist - b.dist);
  const pick = candidates[0]!;
  // For deposits, a chest right here beats a remembered one across the base.
  if (intent === "deposit" && nearby && bot.entity.position.distanceTo(nearby.position) < pick.dist) {
    return { ok: true, block: nearby, source: "nearby" };
  }
  const block = bot.blockAt(new Vec3(pick.c.position.x, pick.c.position.y, pick.c.position.z));
  if (!block) {
    return {
      ok: false,
      message: `nearest known container is at ${fmt(new Vec3(pick.c.position.x, pick.c.position.y, pick.c.position.z))} (~${Math.round(pick.dist)} blocks) but the chunk isn't loaded — walk closer first`,
    };
  }
  if (!isContainerName(block.name)) {
    return {
      ok: false,
      message: `remembered ${pick.c.type} at ${fmt(block.position)} is now ${block.name} — chest may have been broken; refresh memory by passing an explicit pos`,
    };
  }
  return {
    ok: true,
    block,
    source: intent === "withdraw" && itemForWithdraw ? "known with item" : "nearest known",
  };
}

function findNearbyContainer(bot: Bot): Block | null {
  return findNearbyContainers(bot, CHEST_SEARCH_RADIUS, 1)[0]?.block ?? null;
}

async function walkToChest(bot: Bot, block: Block): Promise<SkillResult> {
  const { x, y, z } = block.position;
  return navigate(bot, new goals.GoalNear(x, y, z, CHEST_REACH), {
    label: `${block.name} at ${fmt(block.position)}`,
    target: block.position,
  });
}

function fmt(v: { x: number; y: number; z: number }): string {
  return `(${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.z)})`;
}
