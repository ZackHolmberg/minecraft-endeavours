/**
 * Shared pathfinder Movements config for every skill that uses mineflayer-
 * pathfinder. Replaces the eight identical copies of `ensureMovements` that
 * used to live in world / movement / combat / inventory / storage / crafting /
 * interaction / survival.
 *
 * Key policy choice — **`canDig = false`**. By default mineflayer-pathfinder
 * is allowed to break blocks to clear a path; that's how the bot was tearing
 * holes in player-built walls to reach a closer interior point instead of
 * walking around to the door. The bot can still mine explicitly via
 * `bot.dig` (e.g. inside the `mineBlock` skill), which is unaffected by this
 * flag — `canDig` only governs whether the path-search algorithm itself
 * counts breaking blocks as a valid traversal step.
 *
 * Trade-off: this also blocks legitimate "mine through stone to reach buried
 * ore" pathing. In practice the agent handles that case by calling
 * `mineBlock("stone", N)` on the obstructing blocks first, so we don't lose
 * anything important by forbidding implicit destruction.
 *
 * The other half of "don't break walls" is **doors**: with digging off, a
 * building is only reachable if the planner knows doors and gates can be
 * walked through. Pathfinder's own `canOpenDoors` doesn't handle doors at
 * all, so `doors.ts` patches the planner and installs an executor-side
 * door opener / closer. See that file for details.
 */

import type { Bot } from "mineflayer";
import pathfinderPkg, { type Pathfinder } from "mineflayer-pathfinder";
import type { Block } from "prismarine-block";
import { installDoorAssist, patchMovementsForDoors } from "./doors.js";
import { builtStructureReason } from "./structure-guard.js";
import { isCreative } from "./game-mode.js";

const { Movements } = pathfinderPkg;

const SURVIVAL_MAX_DROP = 3;
/** No fall damage in creative; players hop off ledges freely. */
const CREATIVE_MAX_DROP = 8;

export interface BotWithPathfinder extends Bot {
  pathfinder: Pathfinder;
}

type MovementsT = InstanceType<typeof Movements>;

interface MovementsState {
  /** The never-digs, never-places policy instance. */
  base: MovementsT;
  /** Lazily built digging variant, used only inside `withDiggingMovements`. */
  digging?: MovementsT;
}

/**
 * Per-Bot-object configured state. Keyed by the Bot instance (not by
 * `movements.bot`): mineflayer-pathfinder pre-creates a default Movements bound
 * to the bot at plugin inject, so a `.bot === bot` test is always true and the
 * configured instance would never be installed. A reconnect creates a new Bot
 * object, which is simply a new key here.
 */
const states = new WeakMap<object, MovementsState>();

export function ensureMovements(bot: BotWithPathfinder): void {
  let st = states.get(bot);
  if (!st) {
    st = { base: buildMovements(bot) };
    states.set(bot, st);
    bot.pathfinder.setMovements(st.base);
  } else {
    // Anyone else calling setMovements with a foreign instance is a bug; heal it.
    const cur = bot.pathfinder.movements;
    if (cur !== st.base && cur !== st.digging) bot.pathfinder.setMovements(st.base);
  }
  // The instances are cached for the bot's lifetime but the game mode can
  // change at runtime, so the mode-dependent knob is re-read every call.
  const drop = isCreative(bot) ? CREATIVE_MAX_DROP : SURVIVAL_MAX_DROP;
  st.base.maxDropDown = drop;
  if (st.digging) st.digging.maxDropDown = drop;
  installDoorAssist(bot);
}

/** True if this bot's Movements has been installed (for checks/tests). */
export function hasConfiguredMovements(bot: object): boolean {
  return states.has(bot);
}

/**
 * Run `fn` with a digging-enabled Movements installed, then restore the
 * no-dig policy in `finally`. Digging is NEVER on globally; use this only
 * around a single navigate/getPathTo call whose target is a natural block the
 * bot is about to mine anyway (e.g. ore buried under dirt). Even then it will
 * not tunnel through anything `builtStructureReason` calls player-built
 * (unless `allowStructures`), and never places blocks.
 */
export async function withDiggingMovements<T>(
  bot: BotWithPathfinder,
  opts: { allowStructures?: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  ensureMovements(bot);
  const st = states.get(bot)!;
  if (!st.digging) st.digging = buildMovements(bot, true);
  // exclusionBreak >= 100 makes pathfinder treat a block as unbreakable.
  const guard = st.digging.exclusionAreasBreak as unknown as Array<(b: Block) => number>;
  guard.length = 0;
  if (!opts.allowStructures) guard.push((b) => (builtStructureReason(bot, b) ? 100 : 0));
  st.digging.maxDropDown = st.base.maxDropDown;
  bot.pathfinder.setMovements(st.digging);
  try {
    return await fn();
  } finally {
    bot.pathfinder.setMovements(st.base);
  }
}

function buildMovements(bot: BotWithPathfinder, digging = false): MovementsT {
  const m = new Movements(bot);
  // Pathfinder must never break blocks to clear a path. The bot tearing
  // through player-built walls instead of walking around to a door was the
  // motivating regression — see docstring above for why this is safe.
  m.canDig = digging;
  // Leave pathfinder's built-in door handling OFF (it's gate-only and its
  // executor branch throws after the first use); ours replaces it.
  m.canOpenDoors = false;
  patchMovementsForDoors(bot, m);
  // Don't pillar-place blocks below the bot to climb. The vanilla pillar
  // pattern (jump + place) takes ~5s per block under mineflayer's tick
  // cadence and looks robotic; bots that rely on it appear to "build
  // staircases of dirt out of nowhere" while pathing. Pathfinder will
  // instead navigate via walkable terrain (hills, stairs) or report
  // no-path, which lets the agent build a real staircase via `placeBlocks`
  // (or climb deliberately with `pillarUp`) if it really needs to.
  m.allow1by1towers = false;
  // Never let A* place blocks either (bridging gaps, stepping up onto thin
  // air). pathfinder's scaffolding list defaults to dirt + cobblestone, so
  // with those in the inventory it would silently spend them and leave stray
  // blocks around. (Lib property name is misspelled upstream: "scafolding".)
  // Placing is a deliberate act: placeBlock(s) / pillarUp.
  (m as unknown as { scafoldingBlocks: number[] }).scafoldingBlocks = [];
  // Default 4 costs half a heart per drop (fall damage starts past 3).
  // Players hop down 3 freely; 4+ they look for another way. Water landings
  // are unaffected (infiniteLiquidDropdownDistance stays on).
  m.maxDropDown = SURVIVAL_MAX_DROP;
  // Default 1 makes a swim as cheap as a walk, so the planner happily routes
  // across lakes and through flooded caves (slow, drowning risk, and the
  // bot bobs along looking lost). 3 still swims when it's the only way.
  (m as unknown as { liquidCost: number }).liquidCost = 3; // not in the .d.ts
  return m;
}
