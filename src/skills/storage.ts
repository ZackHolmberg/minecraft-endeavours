import type { Bot } from "mineflayer";
import pathfinderPkg, { type Pathfinder } from "mineflayer-pathfinder";

const { goals, Movements } = pathfinderPkg;
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { noteContainerOpening } from "../mineflayer-glue/event-hooks.js";
import { readWorldKnowledge, type Container } from "../memory/world-knowledge.js";
import type { Coords, SkillResult } from "./types.js";

const CONTAINER_BLOCK_TYPES = new Set([
  "chest",
  "trapped_chest",
  "barrel",
  "shulker_box",
]);

const CHEST_REACH = 2;

interface BotWithPathfinder extends Bot {
  pathfinder: Pathfinder;
}

export interface DepositToChestParams {
  item: string;
  count?: number;
  pos?: Coords;
}

/**
 * Walk to a chest and deposit `count` of `item` (or every matching stack
 * when `count` is omitted). When `pos` is provided, opens that exact chest;
 * otherwise picks the nearest known container from `world.json` as a
 * best-effort default. The container auto-capture hook in
 * `mineflayer-glue/event-hooks.ts` snapshots contents on close — this skill
 * is the primary path through which storage memory gets populated.
 */
export async function depositToChest(
  bot: Bot,
  { item, count, pos }: DepositToChestParams,
): Promise<SkillResult> {
  if (!item) return { ok: false, message: "item is required" };
  if (count !== undefined && count < 1) {
    return { ok: false, message: `count must be >= 1, got ${count}` };
  }

  const itemData = bot.registry.itemsByName[item];
  if (!itemData) return { ok: false, message: `unknown item "${item}"` };

  const available = bot.inventory.count(itemData.id, null);
  if (available === 0) {
    return { ok: false, message: `no ${item} in inventory to deposit` };
  }
  const want = count ?? available;
  if (want > available) {
    return {
      ok: false,
      message: `cannot deposit ${want} ${item}: only ${available} in inventory`,
    };
  }

  const resolved = await resolveChestBlock(bot, pos, "deposit");
  if (!resolved.ok) return resolved;
  const { block, source } = resolved;

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

  try {
    await chest.deposit(itemData.id, null, want);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `deposit of ${want} ${item} into ${block.name} at ${fmt(block.position)} failed: ${message}`,
    };
  } finally {
    chest.close();
  }

  return {
    ok: true,
    message: `deposited ${want} ${item} into ${block.name} at ${fmt(block.position)} (${source})`,
    state: { deposited: want, container: block.name, pos: { x: block.position.x, y: block.position.y, z: block.position.z } },
  };
}

export interface WithdrawFromChestParams {
  item: string;
  count?: number;
  pos?: Coords;
}

/**
 * Walk to a chest and withdraw `count` of `item` (default 1). When `pos` is
 * omitted, picks the nearest known container in `world.json` whose last
 * snapshot recorded the requested item — so Claude can ask the bot to
 * "fetch 4 iron_ingots" without knowing which chest they're in, as long as
 * the bot has opened that chest at least once.
 */
export async function withdrawFromChest(
  bot: Bot,
  { item, count = 1, pos }: WithdrawFromChestParams,
): Promise<SkillResult> {
  if (!item) return { ok: false, message: "item is required" };
  if (count < 1) return { ok: false, message: `count must be >= 1, got ${count}` };

  const itemData = bot.registry.itemsByName[item];
  if (!itemData) return { ok: false, message: `unknown item "${item}"` };

  const resolved = await resolveChestBlock(bot, pos, "withdraw", item);
  if (!resolved.ok) return resolved;
  const { block, source } = resolved;

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

  // Verify the chest actually has the item now (memory might be stale).
  const inside = chest.containerItems().filter((i) => i.type === itemData.id);
  const insideCount = inside.reduce((sum, i) => sum + i.count, 0);
  if (insideCount === 0) {
    chest.close();
    return {
      ok: false,
      message: `${block.name} at ${fmt(block.position)} has no ${item} (stored memory was stale)`,
    };
  }
  const take = Math.min(count, insideCount);

  try {
    await chest.withdraw(itemData.id, null, take);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `withdraw of ${take} ${item} from ${block.name} at ${fmt(block.position)} failed: ${message}`,
    };
  } finally {
    chest.close();
  }

  return {
    ok: true,
    message: take < count
      ? `withdrew ${take} ${item} from ${block.name} at ${fmt(block.position)} (${source}); chest only had ${insideCount}`
      : `withdrew ${take} ${item} from ${block.name} at ${fmt(block.position)} (${source})`,
    state: { withdrawn: take, container: block.name, pos: { x: block.position.x, y: block.position.y, z: block.position.z } },
  };
}

type ResolveResult =
  | { ok: true; block: Block; source: "caller" | "nearest known" | "known with item" }
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
    if (!CONTAINER_BLOCK_TYPES.has(block.name) && !block.name.endsWith("_shulker_box")) {
      return {
        ok: false,
        message: `block at ${fmt(block.position)} is ${block.name}, not a container`,
      };
    }
    return { ok: true, block, source: "caller" };
  }

  const world = await readWorldKnowledge(bot.username);
  if (world.containers.length === 0) {
    return {
      ok: false,
      message: intent === "withdraw"
        ? `no known containers; open a chest at least once so I can remember its contents, or pass an explicit pos`
        : `no known containers; pass an explicit pos for the chest to deposit into`,
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
      return {
        ok: false,
        message: `no remembered container holds ${itemForWithdraw}; pass an explicit pos or gather fresh`,
      };
    }
  }

  candidates.sort((a, b) => a.dist - b.dist);
  const pick = candidates[0]!;
  const block = bot.blockAt(new Vec3(pick.c.position.x, pick.c.position.y, pick.c.position.z));
  if (!block) {
    return {
      ok: false,
      message: `nearest known container is at ${fmt(new Vec3(pick.c.position.x, pick.c.position.y, pick.c.position.z))} (~${Math.round(pick.dist)} blocks) but the chunk isn't loaded — walk closer first`,
    };
  }
  if (!CONTAINER_BLOCK_TYPES.has(block.name) && !block.name.endsWith("_shulker_box")) {
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

async function walkToChest(bot: Bot, block: Block): Promise<SkillResult> {
  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);
  const { x, y, z } = block.position;
  try {
    await pBot.pathfinder.goto(new goals.GoalNear(x, y, z, CHEST_REACH));
    return { ok: true, message: "arrived" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `couldn't reach ${block.name} at ${fmt(block.position)}: ${message}` };
  }
}

function ensureMovements(bot: BotWithPathfinder): void {
  if (!bot.pathfinder.movements || bot.pathfinder.movements.bot !== bot) {
    bot.pathfinder.setMovements(new Movements(bot));
  }
}

function fmt(v: { x: number; y: number; z: number }): string {
  return `(${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.z)})`;
}
