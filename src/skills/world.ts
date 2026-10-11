import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { surfaceInterrupted } from "./auto-behaviors.js";
import { inventoryCounts, inventoryGain, pickUpNearby, snapshotItemIds, waitForDropNear } from "./inventory.js";
import { resolveBlock, resolveItem } from "./item-naming.js";
import { navFailureOf, navigate } from "./navigation.js";
import { ensureMovements, withDiggingMovements, type BotWithPathfinder } from "./pathfinder-config.js";
import { PILLAR_MAX_HEIGHT, pickFiller, pillarUpBy, waitForGrounded } from "./pillar.js";
import { builtStructureReason, fallsOnBot, isNaturalTerrain } from "./structure-guard.js";
import { fellInfo, isTreeLogName, posKey, rankLogs, type BlockAt } from "./tree-felling.js";
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
// End-of-run sweep for drops that were dug but not yet collected.
const FINAL_SWEEP_RADIUS = 8;
// Give up the batch after this many candidates we could not get at.
const MAX_UNREACHABLE_SKIPS = 12;
// A tree whose drops could not be picked up is abandoned for the next one; give up after this many.
const MAX_ABANDONED_TREES = 6;
// ...or after this many consecutive digs that put nothing in the inventory.
const MAX_FRUITLESS_DIGS = 3;
const PATH_CHECK_TIMEOUT_MS = 5_000;
/** A* think budget for mining approaches (pathfinder default 5 s is too short in jungles / hills). */
const GATHER_THINK_TIMEOUT_MS = 10_000;
// How many nearest matches to pull per scan so a protected (player-built)
// nearest block doesn't hide an unprotected one just behind it.
const CANDIDATE_SCAN_COUNT = 48;
/** Wider scan when felling trees: a tall tree's canopy would otherwise fill the nearest-N. */
const LOG_SCAN_COUNT = 160;

/** Per-batch tree-felling state (see tree-felling.ts). */
interface FellCtx {
  /** Log keys of the tree chopped last (stickiness + the per-trunk drop sweep). */
  lastTree: Set<string> | null;
  /** Tree of the candidate just returned by findMineCandidate. */
  next: Set<string> | null;
  /** Most logs seen in one scan that are above reach from the ground / not column-bottom. */
  tooHigh: number;
  underLog: number;
}
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
  /** Positions the caller already knows are unreachable (a job's exhausted area): never chosen as candidates. */
  exclude?: (x: number, y: number, z: number) => boolean;
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
    exclude,
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

  // Progress is measured in what actually lands in the inventory: the expected
  // drop item(s) of each requested block (minecraft-data `drops`), by delta.
  // Blocks with no tracked drop (creative, leaves, ...) fall back to counting
  // digs, since there is nothing to verify.
  const dropNames = new Set<string>();
  const dropsByBlock = new Map<number, string[]>();
  for (const m of mineable) {
    const names = creative ? [] : expectedDropNames(bot, m.id);
    dropsByBlock.set(m.id, names);
    for (const n of names) dropNames.add(n);
  }
  const formatByType = (): string =>
    mineable
      .map((m) => `${minedByType[m.name] ?? 0} ${m.name}`)
      .filter((s) => !s.startsWith("0 ") || mineable.length === 1)
      .join(", ");
  const baseline = inventoryCounts(bot);
  /** Log gathering (tree felling): the only mode allowed to free items stuck on tree blocks. */
  const felling = mineable.some((m) => isTreeLogName(m.name));
  let untrackedDug = 0;
  const collectedNow = (): number => {
    const gained = inventoryGain(baseline, inventoryCounts(bot));
    let n = untrackedDug;
    for (const name of dropNames) n += gained[name] ?? 0;
    return n;
  };
  const gainedText = (): string => {
    const gained = inventoryGain(baseline, inventoryCounts(bot));
    const parts = [...dropNames].filter((n) => (gained[n] ?? 0) > 0).map((n) => `${gained[n]} ${n}`);
    if (untrackedDug > 0) parts.push(`${untrackedDug} ${mineable.length === 1 ? mineable[0]!.name : "other"}`);
    return parts.join(", ");
  };

  // NB: no cancellation.begin() here. runSkill already cleared the flag when
  // the skill started; clearing it again would erase a stop that landed
  // during the preflight above.
  const cancellation = getBotState(bot.username)?.cancellation;

  let mined = 0;
  let lastTargetKey: string | null = null;
  let sameBlockRetries = 0;
  // Blocks we couldn't reach/dig: skipped so one bad candidate doesn't end the batch.
  const unreachable = new Map<string, string>();
  /** Block type of each unreachable position: lets the job runner avoid that species when re-planning. */
  const unreachableTypes: Record<string, number> = {};
  let lastFailure = "";
  let fruitlessStreak = 0;
  /** Trees (log keys) whose drops we could not collect: skipped from then on so the batch moves to another tree. */
  const abandoned = new Set<string>();
  let abandonedTrees = 0;
  /** Tree felling state: the tree just chopped (for stickiness + the per-trunk sweep) and logs refused as out of reach. */
  const fell: FellCtx = { lastTree: null, next: null, tooHigh: 0, underLog: 0 };
  // Positions refused by the structure guard, reported so the agent knows
  // why "there's planks right there" didn't get mined.
  const protectedSeen = new Map<string, { name: string; reason: string }>();
  const reachNote = (): string =>
    fell.tooHigh > 0
      ? ` (the rest of the logs here are too high to reach from the ground; I don't tower up trees. Try a shorter tree${types.length === 1 ? " or another species" : ""})`
      : "";
  const protectedNote = (): string => {
    if (protectedSeen.size === 0) return "";
    const [pos, first] = protectedSeen.entries().next().value!;
    return ` — left ${protectedSeen.size} block(s) alone because they look player-built (e.g. ${first.reason} at (${pos})); don't break into buildings, use the door. Pass allowStructures:true only if a player explicitly asked you to demolish them`;
  };

  /** Final pass: pick up anything dug but not yet collected, then build the result. */
  const finish = async (
    ok: boolean | null,
    headline: string,
    extra: Record<string, unknown> = {},
  ): Promise<SkillResult> => {
    // Felling leaves litter (leaf drops: saplings, sticks, apples) near the trunk even when every log landed: tidy up.
    if (mined > 0 && !creative && !cancellation?.isRequested() && (collectedNow() < mined || felling)) {
      await pickUpNearby(bot, { maxDist: FINAL_SWEEP_RADIUS }, { freeStuck: felling });
    }
    const collected = collectedNow();
    const target = types.length === 1 ? mineable[0]!.name : "blocks";
    let summary: string;
    if (creative) {
      summary = types.length === 1 ? `mined ${mined} ${mineable[0]!.name}` : `mined ${mined} blocks (${formatByType()})`;
    } else if (mined === 0) {
      summary = "";
    } else {
      const g = gainedText();
      const left = mined - collected;
      summary = `collected ${g || `0 ${target}`}${left > 0 || collected !== mined ? ` (mined ${mined})` : ""}`;
      if (collected < mined && collected < maxCount) {
        summary += bot.inventory.emptySlotCount() === 0 ? "; inventory is full" : "; some drops could not be picked up";
      }
    }
    const message = headline.replace("{summary}", summary);
    return {
      ok: ok ?? collected > 0,
      message,
      state: {
        mined,
        collected,
        byType: minedByType,
        gained: inventoryGain(baseline, inventoryCounts(bot)),
        unreachable: unreachable.size,
        unreachableTypes,
        /** "x,y,z" of every block this call gave up on (a job remembers them so the next gather skips them). */
        unreachablePositions: [...unreachable.keys()],
        position: posOf(bot),
        ...extra,
      },
    };
  };

  while (collectedNow() < maxCount) {
    if (cancellation?.isRequested()) {
      return finish(mined > 0, `mining cancelled${mined > 0 ? ": {summary}" : ""}`, { cancelled: true });
    }

    const skipKeys = abandoned.size > 0 ? new Map<string, unknown>([...unreachable, ...[...abandoned].map((k): [string, unknown] => [k, 1])]) : unreachable;
    const block = findMineCandidate(bot, idList, maxDistance, allowStructures, protectedSeen, skipKeys, fell, exclude);
    // Done with a trunk (the next target is another tree, or none): sweep its drops before moving on.
    if (fell.lastTree && !creative && (!block || !fell.lastTree.has(posKey(block.position)))) {
      if (mined > 0 && collectedNow() < mined && !cancellation?.isRequested()) await pickUpNearby(bot, { maxDist: FINAL_SWEEP_RADIUS }, { freeStuck: felling });
    }
    fell.lastTree = fell.next;
    fell.next = null;
    if (!block) {
      const skippedNote = skipped.length > 0
        ? ` (skipped: ${skipped.map((s) => s.name).join(", ")})`
        : "";
      const unreachNote = unreachable.size > 0
        ? ` — ${unreachable.size} more could not be reached without climbing or digging${lastFailure ? ` (${lastFailure})` : ""}`
        : "";
      if (mined === 0 && unreachable.size > 0) {
        return {
          ok: false,
          message: `could not reach any ${types.length === 1 ? mineable[0]!.name : "of those blocks"} (${unreachable.size} tried; ${lastFailure}). Walk somewhere with open access to them or pick another spot.${protectedNote()}${reachNote()}`,
          state: { mined, collected: 0, byType: minedByType, skipped, unreachable: unreachable.size, unreachableTypes, unreachablePositions: [...unreachable.keys()], position: posOf(bot) },
        };
      }
      if (mined === 0) {
        return {
          ok: false,
          message: (types.length === 1
            ? `no ${protectedSeen.size > 0 ? "minable " : ""}${mineable[0]!.name} within ${maxDistance} blocks`
            : `no mineable blocks within ${maxDistance} blocks${skippedNote}`) + unreachNote + protectedNote() + reachNote(),
          state: { mined, collected: 0, byType: minedByType, skipped, protectedSkipped: protectedSeen.size, unreachable: unreachable.size, unreachableTypes, position: posOf(bot) },
        };
      }
      return finish(
        null,
        `{summary}; no more within ${maxDistance} blocks${types.length === 1 ? "" : skippedNote}${unreachNote}${protectedNote()}${reachNote()}`,
        { skipped, protectedSkipped: protectedSeen.size },
      );
    }

    // Repro guard for the "starts mining, never finishes" bug — see DIG_TIMEOUT_MS.
    const targetKey = `${block.position.x},${block.position.y},${block.position.z}`;
    if (targetKey === lastTargetKey) {
      sameBlockRetries += 1;
      if (sameBlockRetries >= SAME_BLOCK_RETRY_LIMIT) {
        return finish(
          false,
          `{summary}; stuck retargeting same block at ${fmt(block.position.x, block.position.y, block.position.z)} (server likely rejecting dig — wrong face, out of reach, or wrong tool)`,
          { stuckAt: { x: block.position.x, y: block.position.y, z: block.position.z } },
        );
      }
    } else {
      sameBlockRetries = 0;
      lastTargetKey = targetKey;
    }

    const thisName = nameById.get(block.type) ?? block.name;
    const before = collectedNow();
    const oneResult = await mineOneBlock(pBot, block, thisName, allowStructures);
    if (!oneResult.ok) {
      if (cancellation?.isRequested()) continue; // loop top reports the cancel
      if ((oneResult.state as { unreachable?: boolean } | undefined)?.unreachable === true) {
        // Couldn't get at THIS block (e.g. a log above reach) — try the next one.
        unreachable.set(targetKey, oneResult.message);
        unreachableTypes[thisName] = (unreachableTypes[thisName] ?? 0) + 1;
        lastFailure = oneResult.message;
        if (unreachable.size >= MAX_UNREACHABLE_SKIPS) {
          return finish(mined > 0, `{summary}${mined > 0 ? "; " : ""}gave up after ${unreachable.size} unreachable ${thisName} blocks (${oneResult.message})`);
        }
        continue;
      }
      return finish(false, `${oneResult.message}${mined > 0 ? " — {summary}" : ""}`);
    }

    minedByType[thisName] = (minedByType[thisName] ?? 0) + 1;
    mined += 1;
    if (!(dropsByBlock.get(block.type)?.length)) untrackedDug += 1;

    // Nothing landed in the inventory for this block: a few of those in a row
    // means full inventory / wrong tool / drops nobody can reach. Stop.
    if (collectedNow() <= before && (dropsByBlock.get(block.type)?.length ?? 0) > 0) {
      fruitlessStreak += 1;
      if (fruitlessStreak >= MAX_FRUITLESS_DIGS) {
        if (bot.inventory.emptySlotCount() === 0) {
          return finish(false, `stopped after ${fruitlessStreak} blocks dropped nothing I could pick up — {summary}`);
        }
        // Not a reason to quit: sweep wider for the drops; if they are out of reach, give up on THIS tree and go on to the next.
        const beforeSweep = collectedNow();
        if (!creative) await pickUpNearby(bot, { maxDist: FINAL_SWEEP_RADIUS }, { freeStuck: felling });
        if (cancellation?.isRequested()) continue;
        if (collectedNow() > beforeSweep) {
          fruitlessStreak = 0;
        } else if (felling && fell.lastTree && abandonedTrees < MAX_ABANDONED_TREES) {
          for (const k of fell.lastTree) abandoned.add(k);
          abandonedTrees += 1;
          fruitlessStreak = 0;
          console.log(`[${bot.username}] [mine] drops of this tree can't be collected; moving on to another tree (${abandonedTrees}/${MAX_ABANDONED_TREES})`);
        } else {
          return finish(false, `stopped after ${fruitlessStreak} blocks dropped nothing I could pick up — {summary}`);
        }
      }
    } else {
      fruitlessStreak = 0;
    }
  }

  return finish(true, `{summary}${skipped.length > 0 ? ` (skipped: ${skipped.map((s) => `${s.name} — ${s.reason}`).join("; ")})` : ""}`, { skipped });
}

/** Item names a block drops with a bare/ordinary tool, per minecraft-data. */
function expectedDropNames(bot: Bot, blockId: number): string[] {
  type DropEntry = number | { drop: number | { id: number } };
  const b = bot.registry.blocks[blockId] as { drops?: DropEntry[] } | undefined;
  const names: string[] = [];
  for (const d of b?.drops ?? []) {
    const raw = typeof d === "number" ? d : d.drop;
    const id = typeof raw === "number" ? raw : raw.id;
    const n = bot.registry.items[id]?.name;
    if (n) names.push(n);
  }
  return names;
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
  skip: ReadonlyMap<string, unknown> = new Map(),
  fell?: FellCtx,
  exclude?: (x: number, y: number, z: number) => boolean,
): Block | null {
  const positions = bot.findBlocks({
    point: bot.entity.position,
    matching: ids,
    maxDistance,
    // an excluded area can hold many matches: look further down the nearest-first list
    count: (exclude ? CANDIDATE_SCAN_COUNT * 4 : CANDIDATE_SCAN_COUNT) + skip.size,
  }).filter((p) => !skip.has(`${p.x},${p.y},${p.z}`) && !exclude?.(p.x, p.y, p.z));
  // Tall trees fill the nearest-N with canopy logs; scan more when logs are wanted so a short tree beyond it is seen.
  if (fell && !allowStructures && ids.some((id) => isTreeLogName(bot.registry.blocks[id]?.name ?? ""))) {
    const more = bot.findBlocks({
      point: bot.entity.position,
      matching: ids,
      maxDistance,
      count: LOG_SCAN_COUNT + skip.size,
    }).filter((p) => !skip.has(`${p.x},${p.y},${p.z}`) && !exclude?.(p.x, p.y, p.z));
    if (more.length > positions.length) positions.splice(0, positions.length, ...more);
  }
  rankAvoidingPits(bot, positions);
  if (allowStructures) {
    const first = positions[0];
    return first ? bot.blockAt(first) : null;
  }
  const blockAt: BlockAt = (p) => bot.blockAt(p);
  const fellKeys = new Map<string, Set<string> | null>();
  if (fell) {
    const logs = positions.filter((p) => isTreeLogName(bot.blockAt(p)?.name ?? ""));
    if (logs.length > 0) {
      // Felling order replaces plain nearest-first for trees: column-bottom logs of short, near trees first.
      const r = rankLogs(blockAt, logs, bot.entity.position, fell.lastTree);
      fell.tooHigh = Math.max(fell.tooHigh, r.tooHigh);
      fell.underLog = Math.max(fell.underLog, r.underLog);
      const logKeys = new Set(logs.map(posKey));
      const others = positions.filter((p) => !logKeys.has(posKey(p)));
      const order: Array<{ pos: Vec3; score: number; keys?: Set<string> }> = [
        ...r.ranked.map((x) => ({ pos: x.pos, score: x.score, keys: x.tree.keys })),
        ...others.map((p) => ({ pos: p, score: p.distanceTo(bot.entity.position) })),
      ];
      order.sort((a, b) => a.score - b.score);
      positions.splice(0, positions.length, ...order.map((o) => o.pos));
      for (const o of order) fellKeys.set(posKey(o.pos), o.keys ?? null);
    }
  }
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
      if (fell) fell.next = fellKeys.get(posKey(pos)) ?? null;
      return block;
    }
    const k = `${pos.x}, ${pos.y}, ${pos.z}`;
    if (firstNew === null && !protectedSeen.has(k)) firstNew = block.name;
    protectedSeen.set(k, { name: block.name, reason });
  }
  reportSkips();
  return null;
}

/**
 * Virtual extra distance for a candidate that can only be reached by digging
 * straight down from the surface (below the bot's feet and covered by a solid
 * block). Players don't dig themselves into a pit to get stone: a candidate on
 * a hillside, cave floor or ledge within this many blocks beats it. 8 means a
 * stone 5 blocks down loses to an exposed one up to ~13 blocks away.
 */
export const PIT_DIG_PENALTY = 8;

/** True if reaching `pos` means digging down into a hole: >1 below the feet and a solid block on top. */
export function isPitCandidate(bot: Bot, pos: Vec3): boolean {
  if (pos.y >= Math.floor(bot.entity.position.y) - 1) return false;
  const above = bot.blockAt(pos.offset(0, 1, 0));
  return !!above && above.boundingBox === "block";
}

/** Stable re-sort of nearest-first `positions` by distance + pit penalty (in place). */
function rankAvoidingPits(bot: Bot, positions: Vec3[]): void {
  if (positions.length < 2) return;
  const me = bot.entity.position;
  const pits = new Set<Vec3>();
  const key = (p: Vec3): number => {
    const pit = isPitCandidate(bot, p);
    if (pit) pits.add(p);
    return p.distanceTo(me) + (pit ? PIT_DIG_PENALTY : 0);
  };
  const first = positions[0]!;
  const keyed = positions.map((p, i) => ({ p, i, k: key(p) }));
  keyed.sort((a, b) => a.k - b.k || a.i - b.i);
  for (let i = 0; i < positions.length; i++) positions[i] = keyed[i]!.p;
  if (positions[0] !== first && pits.has(first)) {
    const f = positions[0]!;
    console.log(`[${bot.username}] [mine] pit-avoid: preferring (${f.x}, ${f.y}, ${f.z}) over nearest (${first.x}, ${first.y}, ${first.z}) which needs digging straight down`);
  }
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
  allowStructures = false,
  retriedAbort = false,
): Promise<SkillResult> {
  const bot = pBot as Bot;

  const moveResult = await pathToBlock(pBot, block, allowStructures);
  if (!moveResult.ok) {
    // Flag per-block reachability failures (not a stop) so the batch can skip this block.
    const cancelled = (moveResult.state as { cancelled?: boolean } | undefined)?.cancelled === true;
    return cancelled ? moveResult : { ...moveResult, state: { ...(moveResult.state ?? {}), unreachable: true } };
  }

  if (isCreative(bot)) return digCreative(bot, block, blockNameForMsg);

  // Gravel/sand directly above the target while we stand in its column would land on our head
  // (or bury us in the hole). Skip this block; one beside the column is fine (it just refills).
  if (fallsOnBot((p) => bot.blockAt(p), block.position, bot.entity.position)) {
    return {
      ok: false,
      message: `not digging ${blockNameForMsg} at ${fmt(block.position.x, block.position.y, block.position.z)}: a falling block (sand/gravel) is right above it and I'm standing under it`,
      state: { unreachable: true },
    };
  }

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
      const pillar = await pillarUpBy(bot, 1, "escape");
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

  // A log whose drop would land on leaves/vines under it: cut those first (they are natural).
  if (isTreeLogName(block.name) && !allowStructures) await clearLeavesBelow(bot, block);

  const digDiag = describeDigSetup(bot, block);
  const itemsBeforeDig = snapshotItemIds(bot);
  const digStart = Date.now();
  try {
    await digWithTimeout(bot, block);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const elapsed = Date.now() - digStart;
    console.warn(
      `[${bot.username}] dig FAILED at ${digDiag.targetPos} after ${elapsed}ms — ${message} | ${digDiag.summary}`,
    );
    // "Digging aborted" = something called bot.stopDigging mid-dig. The only thing that does that
    // while a skill runs is the survival reflex (drowning / suffocation), which is right to take
    // over. Once it is done the bot is somewhere safe: retry the block once from scratch (re-path,
    // re-equip) instead of reporting it unreachable. A second abort skips just this block.
    if (/digging aborted/i.test(message) && !getBotState(bot.username)?.cancellation.isRequested()) {
      await surfaceInterrupted(bot);
      await new Promise((r) => setTimeout(r, 300));
      const fresh = bot.blockAt(block.position);
      if (!fresh || fresh.type !== block.type) return { ok: true, message: `${blockNameForMsg} at ${fmt(block.position.x, block.position.y, block.position.z)} is already gone` };
      if (!retriedAbort) {
        console.log(`[${bot.username}] [mine] dig was interrupted (survival reflex); retrying ${blockNameForMsg} once`);
        return mineOneBlock(pBot, fresh, blockNameForMsg, allowStructures, true);
      }
      return {
        ok: false,
        message: `dig of ${blockNameForMsg} at ${fmt(block.position.x, block.position.y, block.position.z)} was interrupted twice (underwater / suffocation reflex)`,
        state: { unreachable: true },
      };
    }
    return {
      ok: false,
      message: `dig failed at ${fmt(block.position.x, block.position.y, block.position.z)} after ${elapsed}ms: ${message}`,
    };
  }
  const elapsed = Date.now() - digStart;
  console.log(
    `[${bot.username}] dig OK ${blockNameForMsg} at ${digDiag.targetPos} in ${elapsed}ms | ${digDiag.summary}`,
  );

  // The drop entity spawns a few ticks AFTER bot.dig resolves; scanning right
  // away sees nothing. Wait for it to appear, then collect. The caller counts
  // success by inventory delta, so this result is advisory.
  await waitForDropNear(bot, block.position.offset(0.5, 0.5, 0.5), undefined, itemsBeforeDig);
  await pickUpNearby(bot, { maxDist: POST_DIG_PICKUP_RADIUS }, { freeStuck: isTreeLogName(block.name) });
  return { ok: true, message: `mined ${blockNameForMsg}` };
}

const LEAF_DIG_TIMEOUT_MS = 6_000;

/** Break the leaves/vines between a log and the floor so its drop reaches the ground. Best effort. */
async function clearLeavesBelow(bot: Bot, log: Block): Promise<void> {
  const below = fellInfo((p) => bot.blockAt(p), log.position).leavesBelow;
  for (const p of below) {
    const leaf = bot.blockAt(p);
    if (!leaf || !bot.canDigBlock(leaf)) continue;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        bot.dig(leaf),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => {
            try { bot.stopDigging?.(); } catch { /* best-effort */ }
            rej(new Error("leaf dig timeout"));
          }, LEAF_DIG_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      console.log(`[${bot.username}] [mine] could not clear ${leaf.name} under ${log.name}: ${err instanceof Error ? err.message : err}`);
      return;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
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
  /** Reference-face labels (bottom/top/north/south/west/east) to try last: a retry after the server refused a click on them. */
  avoidFaces?: string[];
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
  { type, position, avoidFaces }: PlaceBlockParams,
): Promise<SkillResult> {
  if (!position) return { ok: false, message: "position is required" };
  return placeSingleBlock(bot, type, position, avoidFaces);
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
  avoidFaces: readonly string[] = [],
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
  let avoided: Ref | null = null; // faces a retry was asked to skip: used only when nothing else is left
  for (const offset of FACE_OFFSETS) {
    const neighborPos = target.plus(offset.vec);
    const neighbor = bot.blockAt(neighborPos);
    if (!neighbor || neighbor.boundingBox !== "block") continue;
    // Face vector points from the reference block toward the target — the
    // opposite of the offset we used to find the neighbor.
    const candidate = { block: neighbor, face: offset.vec.scaled(-1), label: offset.label };
    if (avoidFaces.includes(offset.label)) {
      avoided ??= candidate;
      continue;
    }
    if (INTERACTIVE_RE.test(neighbor.name)) {
      fallback ??= candidate;
      continue;
    }
    reference = candidate;
    break;
  }
  const sneakToPlace = !reference && fallback !== null;
  reference ??= fallback;
  if (!reference && avoided) {
    reference = avoided;
  }
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
      state: { face: reference.label },
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
  return pillarUpBy(bot, height, "requested");
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
 * Walk to where `block` is visible and in reach. The default Movements never
 * digs or places, so an enclosed or too-high target fails with no-path (or
 * times out / gets stuck) rather than the bot tunnelling/towering on its own.
 * When the no-dig navigate fails (no_path / stuck / timeout) toward a NATURAL
 * mine target, we retry ONCE (per call, i.e. per target) under the scoped
 * digging Movements: it may only break natural terrain (allowlist, see
 * `isNaturalTerrain`), honours the structure guard unless allowStructures, and
 * never places; the no-dig policy is restored in `finally`. We can't gate on
 * the cheap `getPathTo` probe alone: it only runs the first ~40ms A* slice, so
 * on open terrain it answers "partial", not "noPath", even for buried ore.
 * A high log still fails (digging can't lift the bot) and the caller skips to
 * the next candidate.
 */
async function pathToBlock(bot: BotWithPathfinder, block: Block, allowStructures = false): Promise<SkillResult> {
  const { x, y, z } = block.position;
  const goal = new goals.GoalLookAtBlock(block.position, bot.world);
  const opts = { label: `${block.name} at ${fmt(x, y, z)}`, target: block.position.offset(0.5, 0.5, 0.5), thinkTimeoutMs: GATHER_THINK_TIMEOUT_MS };
  // Natural target only: never dig toward something that is itself player-made
  // (unless the caller was explicitly asked to demolish).
  const digEligible = allowStructures || isNaturalTarget(block.name);

  let first: SkillResult | null = null;
  const probe = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal, PATH_CHECK_TIMEOUT_MS);
  if (probe.status !== "noPath") {
    // Pillar-only escape here: the dig retry below covers the dig-out.
    first = await navigate(bot, goal, { ...opts, escape: digEligible ? "pillar" : "full" });
    if (first.ok) return first;
    const failure = navFailureOf(first);
    const cancelled = (first.state as { cancelled?: boolean } | undefined)?.cancelled === true;
    if (cancelled || !digEligible || (failure !== "no_path" && failure !== "stuck" && failure !== "timeout")) return first;
  } else if (!digEligible) {
    return { ok: false, message: `no path to ${block.name} at ${fmt(x, y, z)} (out of reach without climbing or breaking player-built blocks)` };
  }

  if (getBotState(bot.username)?.cancellation.isRequested()) {
    return first ?? { ok: false, message: `movement to ${opts.label} cancelled`, state: { cancelled: true } };
  }
  // One scoped digging attempt. If a definite-noPath probe says even digging
  // can't help, skip the walk.
  const digPath = await withDiggingMovements(bot, { allowStructures }, async () =>
    bot.pathfinder.getPathTo(bot.pathfinder.movements, goal, PATH_CHECK_TIMEOUT_MS),
  );
  if (digPath.status === "noPath") {
    return first ?? { ok: false, message: `no path to ${block.name} at ${fmt(x, y, z)} (out of reach without climbing or breaking player-built blocks)` };
  }
  return withDiggingMovements(bot, { allowStructures }, () => navigate(bot, goal, { ...opts, escape: "none" }));
}

/** Terrain, ores and trees: things a miner may legitimately tunnel toward. */
function isNaturalTarget(name: string): boolean {
  return isNaturalTerrain(name) || /_log$|_wood$|^stripped_/.test(name);
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
