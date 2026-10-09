import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { pickUpNearby } from "./inventory.js";
import { resolveBlock, resolveItem } from "./item-naming.js";
import { navigate } from "./navigation.js";
import { ensureMovements, type BotWithPathfinder } from "./pathfinder-config.js";
import { PILLAR_MAX_HEIGHT, pickFiller, pillarUpBy, waitForGrounded } from "./pillar.js";
import { builtStructureReason } from "./structure-guard.js";
import { creativeGive } from "./creative.js";
import { findPlaceHoverSpot, flyTo, isFlying } from "./flight.js";
import { isCreative } from "./game-mode.js";
import { recordEvent } from "../observability/telemetry.js";
import { getBotState } from "../state/index.js";
import type { Coords, SkillResult } from "./types.js";

const PLACE_BLOCKS_MAX_BATCH = 64;

const SEARCH_RADIUS = 64;
const MINE_BLOCKS_DEFAULT_MAX_COUNT = 32;
const MINE_BLOCKS_MAX_COUNT_CAP = 128;
const POST_DIG_PICKUP_RADIUS = 4;
const PATH_CHECK_TIMEOUT_MS = 5_000;
// How many nearest matches to pull per scan so a protected (player-built)
// nearest block doesn't hide an unprotected one just behind it.
const CANDIDATE_SCAN_COUNT = 48;
// Hard ceiling on a single dig. mineflayer resolves dig via a local
// blockUpdate event; if the server rejects the dig (out of reach, wrong face)
// no blockUpdate ever arrives and the promise hangs forever. Cap it so the
// skill returns instead of locking the agent loop.
const DIG_TIMEOUT_MS = 30_000;
// If two consecutive iterations target the exact same block position, the
// dig likely "succeeded" locally but the server didn't break the block.
// Bail with a diagnostic message instead of looping forever.
const SAME_BLOCK_RETRY_LIMIT = 2;

const PLACE_REACH = 4.5;
// Right-clicking these opens a UI / toggles state instead of placing on them.
const INTERACTIVE_RE =
  /chest|barrel|table|furnace|smoker|anvil|door|gate|bed|button|lever|shulker|hopper|dispenser|dropper|crafter|loom|stonecutter|grindstone|lectern|bell|note_block|jukebox|beacon|brewing|composter|cauldron|respawn_anchor|repeater|comparator|daylight|sign/;

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
  /** Also mine blocks that look like part of a player-built structure. Only when a player asked for demolition. */
  allowStructures?: boolean;
}

/**
 * Single-type mine. Thin wrapper around `mineBlocks` so size-1 calls share
 * exactly the batch code path.
 */
export async function mineBlock(
  bot: Bot,
  { type, count = 1, allowStructures = false }: MineBlockParams,
): Promise<SkillResult> {
  return mineBlocks(bot, { types: [type], maxCount: count, allowStructures });
}

export interface MineBlocksParams {
  /** Block IDs to look for. The bot mines whichever instance of any of these is nearest, repeating until maxCount or no candidates remain. */
  types: string[];
  /** Total blocks to mine across all types. Defaults to 32, capped at 128. */
  maxCount?: number;
  /** Search radius for any one block. Defaults to the 64-block standard. */
  maxDistance?: number;
  /** Also mine blocks that look like part of a player-built structure. Only when a player asked for demolition. */
  allowStructures?: boolean;
}

/**
 * Multi-type mine. The natural use case is *"go to the mine and grab any
 * ores you find"* — the bot scans for any block matching any of `types`,
 * walks to the nearest, mines it, and repeats. One LLM round-trip covers
 * a whole prospecting run; the unary `mineBlock` is a wrapper around this.
 *
 * Tool-tier preflight: for each requested type, probe a sample block (if
 * any are visible right now) and check we have a tool that can harvest it.
 * Types the bot can't mine are *skipped*, not fatal — a request for
 * `[iron_ore, coal_ore, diamond_ore]` with only a stone pickaxe still
 * mines iron + coal, and the skipped diamond is reported in the result.
 * Types with no visible sample are kept in the search (we may walk into
 * range mid-batch); `equipBestHarvestTool` is the safety net if a tool
 * mismatch surfaces at dig time.
 *
 * Built-structure guard: candidates that look like part of a player build
 * (see structure-guard.ts) are skipped unless `allowStructures` is set —
 * this is what stops "can't path in → mine the wall" re-plans.
 *
 * Cancellable: checks the cancellation flag between blocks (and the walk to
 * each block aborts on it too).
 *
 * Failure model: a fatal mid-batch error (path failure, dig timeout, same-
 * block retry exhaustion) returns ok:false with `state.mined` (total) +
 * `state.byType` so the agent can re-plan. Running out of candidates is
 * ok:true if anything landed.
 */
export async function mineBlocks(bot: Bot, params: MineBlocksParams): Promise<SkillResult> {
  // Creative: blocks break instantly and drop nothing, so this is clearing,
  // not gathering. Reword the result so the agent never reports "gathered".
  const creative = isCreative(bot);
  const r = await mineBlocksInner(bot, params, creative);
  if (!creative) return r;
  return {
    ...r,
    message: `${r.message.replace(/\bmined\b/g, "cleared")} (creative mode: broken blocks drop nothing)`,
    state: { ...(r.state ?? {}), drops: false },
  };
}

async function mineBlocksInner(
  bot: Bot,
  {
    types,
    maxCount = MINE_BLOCKS_DEFAULT_MAX_COUNT,
    maxDistance = SEARCH_RADIUS,
    allowStructures = false,
  }: MineBlocksParams,
  creative: boolean,
): Promise<SkillResult> {
  if (!Array.isArray(types) || types.length === 0) {
    return { ok: false, message: "types must be a non-empty array" };
  }
  if (maxCount < 1 || maxCount > MINE_BLOCKS_MAX_COUNT_CAP) {
    return {
      ok: false,
      message: `maxCount must be between 1 and ${MINE_BLOCKS_MAX_COUNT_CAP}, got ${maxCount}`,
    };
  }
  if (maxDistance < 1) {
    return { ok: false, message: `maxDistance must be >= 1, got ${maxDistance}` };
  }

  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);

  type Resolved = { name: string; id: number };
  const mineable: Resolved[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (let i = 0; i < types.length; i++) {
    const r = resolveBlock(bot, types[i]!);
    if (!r.ok) {
      skipped.push({ name: types[i]!, reason: r.message });
      continue;
    }
    const sample = bot.findBlock({
      point: bot.entity.position,
      matching: r.data.id,
      maxDistance,
    });
    // Creative breaks anything instantly with any (non-weapon) hand.
    if (sample && !creative) {
      const toolCheck = checkHarvestability(bot, sample);
      if (!toolCheck.ok) {
        skipped.push({ name: r.normalized, reason: toolCheck.message });
        continue;
      }
    }
    // Either a mineable sample exists, or no sample is in range right now
    // (kept in the search; equipBestHarvestTool will catch a tool mismatch
    // if we walk into one later).
    mineable.push({ name: r.normalized, id: r.data.id });
  }

  if (mineable.length === 0) {
    const reasons = skipped.map((s) => `${s.name}: ${s.reason}`).join("; ");
    return {
      ok: false,
      message: types.length === 1
        ? skipped[0]!.reason
        : `cannot mine any requested type — ${reasons}`,
      state: { mined: 0, byType: {}, skipped },
    };
  }

  const idList = mineable.map((m) => m.id);
  const nameById = new Map(mineable.map((m) => [m.id, m.name]));
  const minedByType: Record<string, number> = {};
  for (const m of mineable) minedByType[m.name] = 0;

  const formatByType = (): string =>
    mineable
      .map((m) => `${minedByType[m.name] ?? 0} ${m.name}`)
      .filter((s) => !s.startsWith("0 ") || mineable.length === 1)
      .join(", ");

  const cancellation = getBotState(bot.username)?.cancellation;
  cancellation?.begin();

  let mined = 0;
  let lastTargetKey: string | null = null;
  let sameBlockRetries = 0;
  // Positions refused by the structure guard, reported so the agent knows
  // why "there's planks right there" didn't get mined.
  const protectedSeen = new Map<string, { name: string; reason: string }>();
  const protectedNote = (): string => {
    if (protectedSeen.size === 0) return "";
    const [pos, first] = protectedSeen.entries().next().value!;
    return ` — left ${protectedSeen.size} block(s) alone because they look player-built (e.g. ${first.reason} at (${pos})); don't break into buildings, use the door. Pass allowStructures:true only if a player explicitly asked you to demolish them`;
  };

  while (mined < maxCount) {
    if (cancellation?.isRequested()) {
      return {
        ok: mined > 0,
        message: `mining cancelled after ${mined} block(s)${mined > 0 ? ` (${formatByType()})` : ""}`,
        state: { mined, byType: minedByType, cancelled: true, position: posOf(bot) },
      };
    }

    const block = findMineCandidate(bot, idList, maxDistance, allowStructures, protectedSeen);
    if (!block) {
      const summary = formatByType();
      const skippedNote = skipped.length > 0
        ? ` (skipped: ${skipped.map((s) => s.name).join(", ")})`
        : "";
      if (mined === 0) {
        return {
          ok: false,
          message: (types.length === 1
            ? `no ${protectedSeen.size > 0 ? "minable " : ""}${mineable[0]!.name} within ${maxDistance} blocks`
            : `no mineable blocks within ${maxDistance} blocks${skippedNote}`) + protectedNote(),
          state: { mined, byType: minedByType, skipped, protectedSkipped: protectedSeen.size, position: posOf(bot) },
        };
      }
      return {
        ok: true,
        message: (types.length === 1
          ? `mined ${mined} ${mineable[0]!.name}; no more within ${maxDistance} blocks`
          : `mined ${mined} blocks (${summary}); no more within ${maxDistance} blocks${skippedNote}`) + protectedNote(),
        state: { mined, byType: minedByType, skipped, protectedSkipped: protectedSeen.size, position: posOf(bot) },
      };
    }

    // Repro guard for the "starts mining, never finishes" bug — see DIG_TIMEOUT_MS.
    const targetKey = `${block.position.x},${block.position.y},${block.position.z}`;
    if (targetKey === lastTargetKey) {
      sameBlockRetries += 1;
      if (sameBlockRetries >= SAME_BLOCK_RETRY_LIMIT) {
        const summary = formatByType();
        return {
          ok: false,
          message: types.length === 1
            ? `mined ${mined} of ${maxCount} ${mineable[0]!.name}; stuck retargeting same block at ${fmt(block.position.x, block.position.y, block.position.z)} (server likely rejecting dig — wrong face, out of reach, or wrong tool)`
            : `mined ${mined} blocks (${summary}); stuck retargeting same block at ${fmt(block.position.x, block.position.y, block.position.z)} (server likely rejecting dig — wrong face, out of reach, or wrong tool)`,
          state: {
            mined,
            byType: minedByType,
            stuckAt: { x: block.position.x, y: block.position.y, z: block.position.z },
          },
        };
      }
    } else {
      sameBlockRetries = 0;
      lastTargetKey = targetKey;
    }

    const thisName = nameById.get(block.type) ?? block.name;
    const oneResult = await mineOneBlock(pBot, block, thisName);
    if (!oneResult.ok) {
      if (cancellation?.isRequested()) continue; // loop top reports the cancel
      const summary = formatByType();
      return {
        ok: false,
        message: types.length === 1
          ? `${oneResult.message} (mined ${mined} of ${maxCount} so far)`
          : `${oneResult.message} (after ${mined} mined: ${summary})`,
        state: { mined, byType: minedByType, position: posOf(bot) },
      };
    }

    minedByType[thisName] = (minedByType[thisName] ?? 0) + 1;
    mined += 1;
  }

  const summary = formatByType();
  const skippedNote = skipped.length > 0
    ? ` (skipped: ${skipped.map((s) => `${s.name} — ${s.reason}`).join("; ")})`
    : "";
  return {
    ok: true,
    message: types.length === 1
      ? `mined ${mined} ${mineable[0]!.name}`
      : `mined ${mined} blocks (${summary})${skippedNote}`,
    state: { mined, byType: minedByType, skipped, position: posOf(bot) },
  };
}

/**
 * Nearest block of any `ids` that passes the built-structure guard (or the
 * nearest outright when `allowStructures`). Refused positions are recorded in
 * `protectedSeen` for the result message.
 */
function findMineCandidate(
  bot: Bot,
  ids: number[],
  maxDistance: number,
  allowStructures: boolean,
  protectedSeen: Map<string, { name: string; reason: string }>,
): Block | null {
  if (allowStructures) {
    return bot.findBlock({ point: bot.entity.position, matching: ids, maxDistance });
  }
  const positions = bot.findBlocks({
    point: bot.entity.position,
    matching: ids,
    maxDistance,
    count: CANDIDATE_SCAN_COUNT,
  });
  // Telemetry: count positions newly refused by this scan (repeat scans re-see them).
  const seenBefore = protectedSeen.size;
  let firstNew: string | null = null;
  const reportSkips = (): void => {
    const added = protectedSeen.size - seenBefore;
    if (added > 0) recordEvent(bot.username, { kind: "structure_skip", block: firstNew ?? "unknown", skipped: added });
  };
  for (const pos of positions) {
    const block = bot.blockAt(pos);
    if (!block) continue;
    const reason = builtStructureReason(bot, block);
    if (!reason) {
      reportSkips();
      return block;
    }
    const k = `${pos.x}, ${pos.y}, ${pos.z}`;
    if (firstNew === null && !protectedSeen.has(k)) firstNew = block.name;
    protectedSeen.set(k, { name: block.name, reason });
  }
  reportSkips();
  return null;
}

function posOf(bot: Bot): { x: number; y: number; z: number } {
  const p = bot.entity.position;
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

/**
 * Mine a single, already-targeted block: path → grounded check (with
 * optional pillar) → equip best tool → dig → pickup sweep. Extracted so
 * both the single-target and multi-target search loops share the dig
 * sequence verbatim.
 */
async function mineOneBlock(
  pBot: BotWithPathfinder,
  block: Block,
  blockNameForMsg: string,
): Promise<SkillResult> {
  const bot = pBot as Bot;

  const moveResult = await pathToBlock(pBot, block);
  if (!moveResult.ok) return moveResult;

  if (isCreative(bot)) return digCreative(bot, block, blockNameForMsg);

  // Avoid the vanilla 5× mid-air dig penalty (prismarine-block applies
  // /5 when !bot.entity.onGround). First wait briefly in case pathfinder
  // just landed. If still not grounded it's almost always because the bot
  // is wading/swimming; pillaring one filler block out of the water fixes
  // the penalty. (On a ladder or mid-fall pillarUpBy refuses cleanly.)
  if (!bot.entity.onGround) {
    await waitForGrounded(bot, 800);
    const feet = bot.entity.position.floored();
    const targetBelowFeet = block.position.x === feet.x && block.position.z === feet.z && block.position.y < feet.y;
    if (!bot.entity.onGround && !targetBelowFeet) {
      const pillar = await pillarUpBy(bot, 1);
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
  if (!equipResult.ok) return equipResult;

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
    };
  }
  const elapsed = Date.now() - digStart;
  console.log(
    `[${bot.username}] dig OK ${blockNameForMsg} at ${digDiag.targetPos} in ${elapsed}ms | ${digDiag.summary}`,
  );

  // Explicit pickup sweep — replaces the unreliable post-dig wait that
  // missed drops for blocks like sand in the slice-3 smoke test.
  await pickUpNearby(bot, { maxDist: POST_DIG_PICKUP_RADIUS });
  return { ok: true, message: `mined ${blockNameForMsg}` };
}

/** Creative players can't break blocks while holding these. */
const CREATIVE_NO_BREAK_RE = /_sword$|^trident$|^mace$|^debug_stick$/;

/**
 * Creative dig: instant break (digTime is 0), no tool choice, no mid-air
 * penalty, and no pickup sweep — nothing drops. The one trap: the server
 * refuses creative breaks with a sword/trident/mace in hand, which would
 * surface as a 30s dig timeout, so switch to a harmless hotbar slot first.
 */
async function digCreative(bot: Bot, block: Block, blockNameForMsg: string): Promise<SkillResult> {
  if (bot.heldItem && CREATIVE_NO_BREAK_RE.test(bot.heldItem.name)) {
    const slots = bot.inventory.slots;
    const free = Array.from({ length: 9 }, (_, i) => i).find((i) => {
      const it = slots[bot.inventory.hotbarStart + i];
      return !it || !CREATIVE_NO_BREAK_RE.test(it.name);
    });
    try {
      if (free !== undefined) bot.setQuickBarSlot(free);
      else await bot.unequip("hand");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `can't break blocks holding ${bot.heldItem?.name} in creative and couldn't switch: ${message}` };
    }
  }
  try {
    await digWithTimeout(bot, block);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `dig failed at ${fmt(block.position.x, block.position.y, block.position.z)}: ${message}`,
    };
  }
  return { ok: true, message: `cleared ${blockNameForMsg}` };
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
        message: `placeBlocks cancelled after ${placed}/${blocks.length} blocks (next unplaced: index ${i})`,
        state: { placed, cancelled: true, nextIndex: i },
      };
    }

    const entry = blocks[i]!;
    const result = await placeSingleBlock(bot, entry.type, entry.position);
    if (!result.ok) {
      if (state?.cancellation.isRequested()) continue; // loop top reports the cancel
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

  let stack = bot.inventory.items().find((i) => i.type === itemData.id);
  let supplied = false;
  if (!stack && isCreative(bot)) {
    // Creative: grab a stack from the creative inventory, like a builder
    // picking the block from the menu mid-build. (Creative placement never
    // consumes the stack, so this only fires when the type is missing.)
    try {
      await creativeGive(bot, itemData.id, bot.registry.items[itemData.id]?.stackSize ?? 64);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `couldn't get ${name} from the creative inventory: ${message}` };
    }
    stack = bot.inventory.items().find((i) => i.type === itemData.id);
    supplied = stack !== undefined;
    if (!stack) {
      return { ok: false, message: `no free inventory slot to take ${name} from the creative inventory — drop or deposit something` };
    }
  }
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
  // Interactive neighbours (chest, door, table…) are a last resort: right-
  // clicking them opens/toggles instead of placing, so we sneak for those.
  type Ref = { block: Block; face: Vec3; label: string };
  let reference: Ref | null = null;
  let fallback: Ref | null = null;
  for (const offset of FACE_OFFSETS) {
    const neighborPos = target.plus(offset.vec);
    const neighbor = bot.blockAt(neighborPos);
    if (!neighbor || neighbor.boundingBox !== "block") continue;
    // Face vector points from the reference block toward the target — the
    // opposite of the offset we used to find the neighbor.
    const candidate = { block: neighbor, face: offset.vec.scaled(-1), label: offset.label };
    if (INTERACTIVE_RE.test(neighbor.name)) {
      fallback ??= candidate;
      continue;
    }
    reference = candidate;
    break;
  }
  const sneakToPlace = !reference && fallback !== null;
  reference ??= fallback;
  if (!reference) {
    return {
      ok: false,
      message: `no solid neighbor at ${fmt(target.x, target.y, target.z)} to place ${name} against`,
    };
  }

  // Walk close enough to click on the reference block (~3 blocks reach).
  // Skip the walk when already in reach — avoids a pointless re-path (and the
  // shuffle it causes) between every block of a placeBlocks batch.
  const refPos = reference.block.position;
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
  const outOfReach = eye.distanceTo(refPos.offset(0.5, 0.5, 0.5)) > PLACE_REACH;
  if (isCreative(bot) && (outOfReach || overlapsBot(bot, target))) {
    // Creative: fly to a hover spot when already airborne, when the spot is
    // well above our feet (walls/roofs out of reach from the ground), or when
    // we're standing in the target cell. Otherwise walk like in survival,
    // with flight as the fallback if walking fails.
    const high = refPos.y > Math.floor(bot.entity.position.y) + 2;
    const preferFlight = isFlying(bot) || high || !outOfReach;
    let nav: SkillResult | null = null;
    if (!preferFlight) {
      nav = await navigate(bot, new goals.GoalNear(refPos.x, refPos.y, refPos.z, 3), {
        label: `a spot to place ${name} at ${fmt(target.x, target.y, target.z)}`,
        target: refPos,
      });
    }
    if (nav && !nav.ok && (nav.state as { cancelled?: boolean } | undefined)?.cancelled) return nav;
    if (!nav?.ok) {
      const spot = findPlaceHoverSpot(bot, target, refPos);
      if (!spot) {
        return nav ?? {
          ok: false,
          message: `no clear spot to fly to for placing ${name} at ${fmt(target.x, target.y, target.z)}`,
        };
      }
      const flight = await flyTo(bot, spot, `a spot to place ${name} at ${fmt(target.x, target.y, target.z)}`);
      if (!flight.ok) return flight;
    }
  } else if (outOfReach) {
    const nav = await navigate(bot, new goals.GoalNear(refPos.x, refPos.y, refPos.z, 3), {
      label: `a spot to place ${name} at ${fmt(target.x, target.y, target.z)}`,
      target: refPos,
    });
    if (!nav.ok) return nav;
  }

  // Don't place a block into our own body (server rejects it anyway).
  if (overlapsBot(bot, target)) {
    return {
      ok: false,
      message: `can't place ${name} at ${fmt(target.x, target.y, target.z)}: the bot is standing in that cell — move first (or use pillarUp to place under yourself)`,
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
    if (sneakToPlace) bot.setControlState("sneak", true);
    await bot.placeBlock(reference.block, reference.face);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `place failed at ${fmt(target.x, target.y, target.z)} (against ${reference.block.name} ${reference.label}): ${message}`,
    };
  } finally {
    if (sneakToPlace) bot.setControlState("sneak", false);
  }

  return {
    ok: true,
    message: `placed ${name} at ${fmt(target.x, target.y, target.z)}${supplied ? ` (took ${name} from the creative inventory)` : ""}`,
    state: { position: { x: target.x, y: target.y, z: target.z }, against: reference.block.name },
  };
}

export interface PillarUpParams {
  /** Blocks to climb (1–32). */
  height: number;
}

/**
 * Climb straight up by jump-placing filler blocks (cobblestone, dirt, stone,
 * …) under the bot — how a player gets out of a hole, onto a ledge, or up to
 * a tree canopy. Cancellable between blocks. Leaves the pillar in place; the
 * agent can mine it back down afterwards if it should be tidied up.
 */
export async function pillarUp(bot: Bot, { height }: PillarUpParams): Promise<SkillResult> {
  if (!Number.isInteger(height) || height < 1 || height > PILLAR_MAX_HEIGHT) {
    return { ok: false, message: `height must be an integer between 1 and ${PILLAR_MAX_HEIGHT}, got ${height}` };
  }
  const pBot = bot as BotWithPathfinder;
  pBot.pathfinder?.setGoal(null); // pathfinder would fight the jump controls
  getBotState(bot.username)?.cancellation.begin();
  if (isCreative(bot) && !pickFiller(bot)) {
    try {
      await creativeGive(bot, bot.registry.itemsByName.cobblestone!.id, height);
    } catch {
      // pillarUpBy reports the missing filler itself
    }
  }
  return pillarUpBy(bot, height);
}

/** True if the bot's hitbox (0.6 × 1.8) intersects the cell at `cell`. */
function overlapsBot(bot: Bot, cell: Vec3): boolean {
  const p = bot.entity.position;
  const half = 0.3;
  return (
    p.x + half > cell.x && p.x - half < cell.x + 1 &&
    p.z + half > cell.z && p.z - half < cell.z + 1 &&
    p.y + 1.8 > cell.y && p.y < cell.y + 1
  );
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

/**
 * Walk to where `block` is visible and in reach. Never digs (canDig=false in
 * pathfinder-config), so an enclosed target reports no-path rather than the
 * bot tunnelling through whatever is in the way.
 */
async function pathToBlock(bot: BotWithPathfinder, block: Block): Promise<SkillResult> {
  const { x, y, z } = block.position;
  const goal = new goals.GoalLookAtBlock(block.position, bot.world);
  const path = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal, PATH_CHECK_TIMEOUT_MS);
  if (path.status === "noPath") {
    return { ok: false, message: `no path to ${block.name} at ${fmt(x, y, z)}` };
  }
  return navigate(bot, goal, { label: `${block.name} at ${fmt(x, y, z)}`, target: block.position.offset(0.5, 0.5, 0.5) });
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
