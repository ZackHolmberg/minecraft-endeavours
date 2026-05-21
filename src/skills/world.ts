import type { Bot } from "mineflayer";
import { goals, Movements, type Pathfinder } from "mineflayer-pathfinder";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import type { SkillResult } from "./types.js";

const SEARCH_RADIUS = 64;
const POST_DIG_PICKUP_WAIT_MS = 500;
const PATH_CHECK_TIMEOUT_MS = 5_000;

export interface MineBlockParams {
  type: string;
  count?: number;
}

interface BotWithPathfinder extends Bot {
  pathfinder: Pathfinder;
}

export async function mineBlock(
  bot: Bot,
  { type, count = 1 }: MineBlockParams,
): Promise<SkillResult> {
  if (count < 1) return { ok: false, message: `count must be >= 1, got ${count}` };

  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);

  const blockData = bot.registry.blocksByName[type];
  if (!blockData) return { ok: false, message: `unknown block type "${type}"` };
  const blockId = blockData.id;

  // Probe a sample block to check tool feasibility before any movement.
  const sample = bot.findBlock({
    point: bot.entity.position,
    matching: blockId,
    maxDistance: SEARCH_RADIUS,
  });
  if (!sample) return { ok: false, message: `no ${type} within ${SEARCH_RADIUS} blocks` };

  const toolCheck = checkHarvestability(bot, sample);
  if (!toolCheck.ok) return toolCheck;

  let mined = 0;
  while (mined < count) {
    const block = bot.findBlock({
      point: bot.entity.position,
      matching: blockId,
      maxDistance: SEARCH_RADIUS,
    });
    if (!block) {
      return {
        ok: false,
        message: `mined ${mined} of ${count} ${type}; no more within ${SEARCH_RADIUS} blocks`,
        state: { mined },
      };
    }

    const moveResult = await pathToBlock(pBot, block);
    if (!moveResult.ok) return { ...moveResult, state: { mined } };

    const equipResult = await equipBestHarvestTool(bot, block);
    if (!equipResult.ok) return { ...equipResult, state: { mined } };

    try {
      await bot.dig(block);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `dig failed at ${fmt(block.position.x, block.position.y, block.position.z)}: ${message}`,
        state: { mined },
      };
    }

    await sleep(POST_DIG_PICKUP_WAIT_MS);
    mined += 1;
  }

  return {
    ok: true,
    message: `mined ${mined} ${type}`,
    state: { mined },
  };
}

function checkHarvestability(bot: Bot, sample: Block): SkillResult {
  if (sample.canHarvest(null)) return { ok: true, message: "no tool required" };
  const items = bot.inventory.items();
  const heldType = bot.heldItem?.type ?? null;
  if (heldType !== null && sample.canHarvest(heldType)) {
    return { ok: true, message: "tool ok (held)" };
  }
  const hasTool = items.some((item) => sample.canHarvest(item.type));
  if (hasTool) return { ok: true, message: "tool ok" };

  const needed = describeRequiredTool(sample);
  return { ok: false, message: `no ${needed} in inventory to mine ${sample.name}` };
}

function describeRequiredTool(block: Block): string {
  // Heuristic: pull the tool family out of the material string if we have one
  // (e.g. "mineable/pickaxe" → "pickaxe"). Falls back to a generic phrase.
  const material = block.material ?? "";
  const m = /mineable\/(\w+)/.exec(material);
  if (m && m[1]) return m[1];
  if (material === "rock") return "pickaxe";
  if (material === "dirt") return "shovel";
  return "appropriate tool";
}

async function pathToBlock(bot: BotWithPathfinder, block: Block): Promise<SkillResult> {
  const { x, y, z } = block.position;
  const goal = new goals.GoalLookAtBlock(block.position, bot.world);
  const path = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal, PATH_CHECK_TIMEOUT_MS);
  if (path.status === "noPath") {
    return { ok: false, message: `no path to ${block.name} at ${fmt(x, y, z)}` };
  }
  try {
    await bot.pathfinder.goto(goal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `pathfinding to ${block.name} at ${fmt(x, y, z)} failed: ${message}` };
  }
  return { ok: true, message: "arrived" };
}

async function equipBestHarvestTool(bot: Bot, block: Block): Promise<SkillResult> {
  if (block.canHarvest(null)) return { ok: true, message: "no equip needed" };
  const heldType = bot.heldItem?.type ?? null;
  if (heldType !== null && block.canHarvest(heldType)) {
    return { ok: true, message: "already holding tool" };
  }
  const candidates: Item[] = bot.inventory.items().filter((item) => block.canHarvest(item.type));
  if (candidates.length === 0) {
    return { ok: false, message: `lost the tool needed for ${block.name} mid-task` };
  }
  // Prefer the candidate the registry says digs fastest (rough proxy: pick the
  // last one, which tends to be a better tier in PrismarineJS's ordering).
  const choice = candidates[candidates.length - 1]!;
  try {
    await bot.equip(choice, "hand");
    return { ok: true, message: `equipped ${choice.name}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `failed to equip ${choice.name}: ${message}` };
  }
}

function ensureMovements(bot: BotWithPathfinder): void {
  if (!bot.pathfinder.movements || bot.pathfinder.movements.bot !== bot) {
    bot.pathfinder.setMovements(new Movements(bot));
  }
}

function fmt(x: number, y: number, z: number): string {
  return `(${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
