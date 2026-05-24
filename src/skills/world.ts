import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { pickUpNearby } from "./inventory.js";
import { resolveBlock, resolveItem } from "./item-naming.js";
import { ensureMovements, type BotWithPathfinder } from "./pathfinder-config.js";
import { getBotState } from "../state/index.js";
import type { Coords, SkillResult } from "./types.js";

const PLACE_BLOCKS_MAX_BATCH = 64;

const SEARCH_RADIUS = 64;
const POST_DIG_PICKUP_RADIUS = 4;
const PATH_CHECK_TIMEOUT_MS = 5_000;
// Hard ceiling on a single dig. mineflayer resolves dig via a local
// blockUpdate event; if the server rejects the dig (out of reach, wrong face)
// no blockUpdate ever arrives and the promise hangs forever. Cap it so the
// skill returns instead of locking the agent loop.
const DIG_TIMEOUT_MS = 30_000;
// If two consecutive iterations target the exact same block position, the
// dig likely "succeeded" locally but the server didn't break the block.
// Bail with a diagnostic message instead of looping forever.
const SAME_BLOCK_RETRY_LIMIT = 2;

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

export async function mineBlock(
  bot: Bot,
  { type, count = 1 }: MineBlockParams,
): Promise<SkillResult> {
  if (count < 1) return { ok: false, message: `count must be >= 1, got ${count}` };

  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);

  const r = resolveBlock(bot, type);
  if (!r.ok) return { ok: false, message: `type ${r.message}` };
  const blockId = r.data.id;
  const name = r.normalized;

  // Probe a sample block to check tool feasibility before any movement.
  const sample = bot.findBlock({
    point: bot.entity.position,
    matching: blockId,
    maxDistance: SEARCH_RADIUS,
  });
  if (!sample) return { ok: false, message: `no ${name} within ${SEARCH_RADIUS} blocks` };

  const toolCheck = checkHarvestability(bot, sample);
  if (!toolCheck.ok) return toolCheck;

  let mined = 0;
  let lastTargetKey: string | null = null;
  let sameBlockRetries = 0;
  while (mined < count) {
    const block = bot.findBlock({
      point: bot.entity.position,
      matching: blockId,
      maxDistance: SEARCH_RADIUS,
    });
    if (!block) {
      return {
        ok: false,
        message: `mined ${mined} of ${count} ${name}; no more within ${SEARCH_RADIUS} blocks`,
        state: { mined },
      };
    }

    // Repro guard for the "starts mining, never finishes" bug — see DIG_TIMEOUT_MS.
    const targetKey = `${block.position.x},${block.position.y},${block.position.z}`;
    if (targetKey === lastTargetKey) {
      sameBlockRetries += 1;
      if (sameBlockRetries >= SAME_BLOCK_RETRY_LIMIT) {
        return {
          ok: false,
          message: `mined ${mined} of ${count} ${name}; stuck retargeting same block at ${fmt(block.position.x, block.position.y, block.position.z)} (server likely rejecting dig — wrong face, out of reach, or wrong tool)`,
          state: { mined, stuckAt: { x: block.position.x, y: block.position.y, z: block.position.z } },
        };
      }
    } else {
      sameBlockRetries = 0;
      lastTargetKey = targetKey;
    }

    const moveResult = await pathToBlock(pBot, block);
    if (!moveResult.ok) return { ...moveResult, state: { mined } };

    // Avoid the vanilla 5× mid-air dig penalty (prismarine-block applies
    // /5 when !bot.entity.onGround). First wait briefly in case pathfinder
    // just landed; if still airborne, try to pillar up from a filler block
    // so the dig runs at normal speed.
    if (!bot.entity.onGround) {
      await waitForGrounded(bot, 800);
      if (!bot.entity.onGround) {
        const pillar = await tryPillarUp(bot);
        if (pillar.ok) {
          console.log(`[${bot.username}] pillared before dig: ${pillar.message}`);
        } else {
          console.warn(
            `[${bot.username}] dig will run at 5× slow (mid-air, no pillar): ${pillar.message}`,
          );
        }
      }
    }

    const equipResult = await equipBestHarvestTool(bot, block);
    if (!equipResult.ok) return { ...equipResult, state: { mined } };

    const digDiag = describeDigSetup(bot, block);
    const digStart = Date.now();
    try {
      await digWithTimeout(bot, block);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - digStart;
      console.warn(
        `[${bot.username}] dig FAILED at ${digDiag.targetPos} after ${elapsed}ms — ${message} | ${digDiag.summary}`,
      );
      return {
        ok: false,
        message: `dig failed at ${fmt(block.position.x, block.position.y, block.position.z)} after ${elapsed}ms: ${message}`,
        state: { mined },
      };
    }
    const elapsed = Date.now() - digStart;
    // Log every dig at debug level so a live repro of the "stuck" bug shows
    // its symptom (very-short or very-long durations) right in bot.log.
    console.log(
      `[${bot.username}] dig OK ${name} at ${digDiag.targetPos} in ${elapsed}ms | ${digDiag.summary}`,
    );

    // Explicit pickup sweep — replaces the unreliable post-dig wait that
    // missed drops for blocks like sand in the slice-3 smoke test.
    await pickUpNearby(bot, { maxDist: POST_DIG_PICKUP_RADIUS });
    mined += 1;
  }

  return {
    ok: true,
    message: `mined ${mined} ${name}`,
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
  if (!position) return { ok: false, message: "position is required" };
  return placeSingleBlock(bot, type, position);
}

export interface PlaceBlocksParams {
  blocks: Array<{ type: string; position: Coords }>;
}

/**
 * Batch placement. Loops `placeSingleBlock` over the array, pausing briefly
 * between blocks to stay under server-side rate limits and checking the
 * cancellation flag so a player "stop" preempt drops the rest of the batch.
 * The big win is avoiding one LLM round-trip per block — the model emits
 * one tool call for the whole wall and the skill does the placements in
 * sequence at mineflayer's natural pace.
 *
 * Returns ok:true if at least one block placed; on the first failure the
 * skill exits with ok:false and `state.placed` so the caller can re-plan.
 */
export async function placeBlocks(
  bot: Bot,
  { blocks }: PlaceBlocksParams,
): Promise<SkillResult> {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { ok: false, message: "blocks must be a non-empty array" };
  }
  if (blocks.length > PLACE_BLOCKS_MAX_BATCH) {
    return {
      ok: false,
      message: `blocks length ${blocks.length} exceeds max batch size ${PLACE_BLOCKS_MAX_BATCH}; split into multiple calls`,
    };
  }

  const state = getBotState(bot.username);
  state?.cancellation.begin();

  let placed = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (state?.cancellation.isRequested()) {
      return {
        ok: placed > 0,
        message: `placeBlocks cancelled after ${placed}/${blocks.length} blocks`,
        state: { placed, cancelled: true },
      };
    }

    const entry = blocks[i]!;
    const result = await placeSingleBlock(bot, entry.type, entry.position);
    if (!result.ok) {
      return {
        ok: false,
        message: `placeBlocks failed at index ${i} (${entry.type} @ ${fmt(entry.position.x, entry.position.y, entry.position.z)}): ${result.message}`,
        state: { placed, failedIndex: i, failedAt: entry.position },
      };
    }
    placed += 1;

    // Light throttle so we don't blast 64 packets in one tick — Paper's anti-
    // cheat tolerates this pace and mineflayer's place loop wants a tick or
    // two to settle before the next click.
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    ok: true,
    message: `placed ${placed} block${placed === 1 ? "" : "s"}`,
    state: { placed },
  };
}

async function placeSingleBlock(
  bot: Bot,
  type: string,
  position: Coords,
): Promise<SkillResult> {
  const r = resolveItem(bot, type);
  if (!r.ok) return { ok: false, message: `type ${r.message}` };
  const itemData = r.data;
  const name = r.normalized;

  const stack = bot.inventory.items().find((i) => i.type === itemData.id);
  if (!stack) {
    return { ok: false, message: `no ${name} in inventory to place` };
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
      message: `no solid neighbor at ${fmt(target.x, target.y, target.z)} to place ${name} against`,
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
      message: `couldn't reach a placing position for ${name} at ${fmt(target.x, target.y, target.z)}: ${message}`,
    };
  }

  if (bot.heldItem?.type !== stack.type) {
    try {
      await bot.equip(stack, "hand");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `failed to equip ${name}: ${message}` };
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
    message: `placed ${name} at ${fmt(target.x, target.y, target.z)}`,
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

/**
 * Pick the *fastest* tool in inventory for the block (using prismarine-block's
 * digTime as the scorer) and equip it. Falls back to bare hand only when no
 * inventory item beats hand-speed. Replaces the prior "first tool that can
 * harvest" logic, which left axes sitting in inventory while the bot punched
 * wood by hand (canHarvest(null) is true for logs, so the old code returned
 * "no equip needed" before considering the axe).
 *
 * Returns `ok: false` only when nothing in inventory can harvest a block that
 * *requires* a tool (the prior necessity check). For optional-tool blocks
 * (wood, dirt, etc.), this never fails — it just picks the best speed.
 */
async function equipBestHarvestTool(bot: Bot, block: Block): Promise<SkillResult> {
  const items = bot.inventory.items();
  const harvestable = items.filter((item) => block.canHarvest(item.type));
  const canHandHarvest = block.canHarvest(null);

  if (!canHandHarvest && harvestable.length === 0) {
    return { ok: false, message: `lost the tool needed for ${block.name} mid-task` };
  }

  // Score: lower digTime = better. Hand-time is the floor when allowed.
  let bestItem: Item | null = null;
  let bestTime = canHandHarvest ? safeDigTime(block, null) : Number.POSITIVE_INFINITY;
  for (const item of harvestable) {
    const t = safeDigTime(block, item.type);
    if (t < bestTime) {
      bestTime = t;
      bestItem = item;
    }
  }

  if (!bestItem) {
    // Hand is best (or only) option — nothing to equip.
    return { ok: true, message: "no equip needed (hand is fastest)" };
  }

  if (bot.heldItem?.type === bestItem.type) {
    return { ok: true, message: `already holding ${bestItem.name}` };
  }

  try {
    await bot.equip(bestItem, "hand");
    return { ok: true, message: `equipped ${bestItem.name}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `failed to equip ${bestItem.name}: ${message}` };
  }
}

/**
 * Wrapper around block.digTime that tolerates missing material data —
 * returns +Infinity instead of throwing so the scorer can ignore that tool.
 */
function safeDigTime(block: Block, toolType: number | null): number {
  try {
    return block.digTime(toolType, false, false, false, [], []);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function fmt(x: number, y: number, z: number): string {
  return `(${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})`;
}

interface DigDiagnostics {
  targetPos: string;
  summary: string;
}

/**
 * Capture a one-line snapshot of the bot's state right before a dig: bot
 * position + facing, distance to target, pathfinder still moving?, held
 * item, expected dig time. Each value is a candidate root cause for the
 * "starts mining, never finishes" symptom — we log all of them once per
 * dig so a live repro pinpoints which.
 */
function describeDigSetup(bot: Bot, block: Block): DigDiagnostics {
  const bp = bot.entity.position;
  const tp = block.position;
  const dx = bp.x - (tp.x + 0.5);
  const dy = bp.y + (bot.entity.height ?? 1.62) - (tp.y + 0.5);
  const dz = bp.z - (tp.z + 0.5);
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  let expectedDigMs: number | null = null;
  try {
    expectedDigMs = Math.round(bot.digTime(block));
  } catch {
    // bot.digTime can throw if material data is missing; fine to skip.
  }

  const pf = (bot as BotWithPathfinder).pathfinder;
  const moving = pf && typeof pf.isMoving === "function" ? pf.isMoving() : false;

  const held = bot.heldItem?.name ?? "(empty hand)";

  const targetPos = fmt(tp.x, tp.y, tp.z);
  const summary = `bot=${fmt(bp.x, bp.y, bp.z)} dist=${dist.toFixed(2)} moving=${moving} held=${held} expectedMs=${expectedDigMs ?? "?"}`;
  return { targetPos, summary };
}

/**
 * Wrap `bot.dig` in a timeout so a server-rejected dig (which leaves the
 * mineflayer promise hanging forever, since it waits on a blockUpdate event
 * the server never sends) becomes a normal skill failure instead of locking
 * the agent loop. Also calls bot.stopDigging so we don't leak the in-flight
 * dig into the next attempt.
 */
/**
 * Poll `bot.entity.onGround` until true or timeout elapses. Useful right
 * after pathfinder returns — for a tick or three the bot may still be
 * mid-jump even though it's done moving, and any dig in that window incurs
 * the vanilla 5× speed penalty.
 */
async function waitForGrounded(bot: Bot, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (bot.entity.onGround) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return bot.entity.onGround;
}

const PILLAR_FILLER_PRIORITY = [
  "cobblestone",
  "cobbled_deepslate",
  "dirt",
  "netherrack",
  "stone",
  "sand",
  "gravel",
] as const;

/**
 * Place a single filler block under the bot's feet so it stops being mid-air.
 * Standard pillar trick: look down, hold jump, place against the block one
 * level below the bot while at the apex. Best-effort — returns `ok: false`
 * (with a reason) when no filler is in inventory, no solid block sits within
 * reach below, or mineflayer's place call rejects. Caller proceeds either way.
 */
async function tryPillarUp(bot: Bot): Promise<SkillResult> {
  const items = bot.inventory.items();
  let filler: Item | null = null;
  for (const name of PILLAR_FILLER_PRIORITY) {
    const found = items.find((i) => i.name === name);
    if (found) {
      filler = found;
      break;
    }
  }
  if (!filler) {
    return { ok: false, message: "no filler block (cobblestone/dirt/etc.) in inventory" };
  }

  const feet = bot.entity.position;
  const fx = Math.floor(feet.x);
  const fz = Math.floor(feet.z);
  // Find the nearest solid block within 3 below the bot's feet to click on.
  let refBlock: Block | null = null;
  for (let dy = 1; dy <= 3; dy++) {
    const candidate = bot.blockAt(new Vec3(fx, Math.floor(feet.y) - dy, fz));
    if (candidate && candidate.boundingBox === "block") {
      refBlock = candidate;
      break;
    }
  }
  if (!refBlock) {
    return { ok: false, message: "no solid block within 3 below feet to pillar from" };
  }

  if (bot.heldItem?.type !== filler.type) {
    try {
      await bot.equip(filler, "hand");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `couldn't equip ${filler.name}: ${message}` };
    }
  }

  try {
    await bot.lookAt(refBlock.position.offset(0.5, 1.0, 0.5), true);
  } catch {
    // lookAt rarely throws; if it does, fall through to place attempt.
  }

  bot.setControlState("jump", true);
  try {
    // Give the bot a tick to leave the ground so the place lands above feet
    // rather than rejecting as "occupied".
    await new Promise((r) => setTimeout(r, 120));
    await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
  } catch (err) {
    bot.setControlState("jump", false);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `pillar place failed: ${message}` };
  }
  bot.setControlState("jump", false);

  await waitForGrounded(bot, 600);
  return { ok: true, message: `placed ${filler.name} under feet` };
}

async function digWithTimeout(bot: Bot, block: Block): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      bot.dig(block),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            bot.stopDigging?.();
          } catch {
            // best-effort
          }
          reject(new Error(`dig timeout after ${DIG_TIMEOUT_MS}ms`));
        }, DIG_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
