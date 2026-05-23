import type { Bot } from "mineflayer";
import pathfinderPkg, { type Pathfinder } from "mineflayer-pathfinder";

const { goals, Movements } = pathfinderPkg;
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { pickUpNearby } from "./inventory.js";
import type { Coords, SkillResult } from "./types.js";

const SEARCH_RADIUS = 64;
const POST_DIG_PICKUP_RADIUS = 4;
const PATH_CHECK_TIMEOUT_MS = 5_000;

const FACE_OFFSETS: ReadonlyArray<{ vec: Vec3; label: string }> = [
  { vec: new Vec3(0, -1, 0), label: "bottom" },
  { vec: new Vec3(0, 1, 0), label: "top" },
  { vec: new Vec3(0, 0, -1), label: "north" },
  { vec: new Vec3(0, 0, 1), label: "south" },
  { vec: new Vec3(-1, 0, 0), label: "west" },
  { vec: new Vec3(1, 0, 0), label: "east" },
];

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

    // Explicit pickup sweep — replaces the unreliable post-dig wait that
    // missed drops for blocks like sand in the slice-3 smoke test.
    await pickUpNearby(bot, { maxDist: POST_DIG_PICKUP_RADIUS });
    mined += 1;
  }

  return {
    ok: true,
    message: `mined ${mined} ${type}`,
    state: { mined },
  };
}

export interface PlaceBlockParams {
  type: string;
  position: Coords;
}

/**
 * Place a block of `type` at `position`. mineflayer's `bot.placeBlock` wants
 * a reference block + face vector (the block we click *on*, plus which face),
 * not a target coordinate — so we probe the 6 adjacent positions, pick the
 * first solid neighbor, and derive the face vector from there. Fails fast if
 * the bot isn't holding the item and doesn't have one to equip, or if there
 * is no solid neighbor to place against.
 */
export async function placeBlock(
  bot: Bot,
  { type, position }: PlaceBlockParams,
): Promise<SkillResult> {
  if (!type) return { ok: false, message: "type is required" };
  if (!position) return { ok: false, message: "position is required" };

  const itemData = bot.registry.itemsByName[type];
  if (!itemData) return { ok: false, message: `unknown block item "${type}"` };

  const stack = bot.inventory.items().find((i) => i.type === itemData.id);
  if (!stack) {
    return { ok: false, message: `no ${type} in inventory to place` };
  }

  const target = new Vec3(position.x, position.y, position.z);
  const targetBlock = bot.blockAt(target);
  if (targetBlock && targetBlock.boundingBox === "block") {
    return {
      ok: false,
      message: `${target.x}, ${target.y}, ${target.z} is already occupied by ${targetBlock.name}`,
    };
  }

  // Pick a solid neighbor to click on. Prefer bottom (most natural for
  // standing-on-ground placement); fall through to sides; top last.
  let reference: { block: Block; face: Vec3; label: string } | null = null;
  for (const offset of FACE_OFFSETS) {
    const neighborPos = target.plus(offset.vec);
    const neighbor = bot.blockAt(neighborPos);
    if (!neighbor || neighbor.boundingBox !== "block") continue;
    // Face vector points from the reference block toward the target — the
    // opposite of the offset we used to find the neighbor.
    reference = {
      block: neighbor,
      face: offset.vec.scaled(-1),
      label: offset.label,
    };
    break;
  }
  if (!reference) {
    return {
      ok: false,
      message: `no solid neighbor at ${fmt(target.x, target.y, target.z)} to place ${type} against`,
    };
  }

  // Walk close enough to click on the reference block (~3 blocks reach).
  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);
  const refPos = reference.block.position;
  try {
    await pBot.pathfinder.goto(new goals.GoalNear(refPos.x, refPos.y, refPos.z, 3));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `couldn't reach a placing position for ${type} at ${fmt(target.x, target.y, target.z)}: ${message}`,
    };
  }

  if (bot.heldItem?.type !== stack.type) {
    try {
      await bot.equip(stack, "hand");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `failed to equip ${type}: ${message}` };
    }
  }

  try {
    await bot.placeBlock(reference.block, reference.face);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `place failed at ${fmt(target.x, target.y, target.z)} (against ${reference.block.name} ${reference.label}): ${message}`,
    };
  }

  return {
    ok: true,
    message: `placed ${type} at ${fmt(target.x, target.y, target.z)}`,
    state: { position: { x: target.x, y: target.y, z: target.z }, against: reference.block.name },
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
