/**
 * Shared pathfinder Movements config for every skill that uses mineflayer-
 * pathfinder. Replaces the eight identical copies of `ensureMovements` that
 * used to live in world / movement / combat / inventory / storage / crafting /
 * interaction / survival.
 *
 * Key policy choice — **A\* may only break NATURAL terrain, at a high price,
 * and never places blocks.** By default mineflayer-pathfinder may break
 * anything to clear a path; that is how the bot was tearing holes in
 * player-built walls to reach a closer interior point instead of walking
 * around to the door. v2 first forbade breaking entirely (`canDig=false`), but
 * with no digging at all A* exhausts its think budget on ordinary terrain
 * ("Took to long to decide path to goal!": jungle canopy, hills, ore under a
 * dirt layer). So the BASE Movements now has `canDig = true` with:
 *  - `blocksCantBreak` = complement of the natural-terrain allowlist
 *    (`isNaturalTerrain` + foliage `isCheapBreak`): no logs, planks, cobblestone,
 *    glass, doors, containers, stations, crops, beds ... ever;
 *  - the player-built structure guard on (`builtStructureReason` via
 *    `exclusionAreasBreak`): natural blocks set into a built wall stay put;
 *  - `digCost = BASE_DIG_COST` so walking (and doors) stay strongly preferred;
 *  - no towers / bridges / scaffolding (placing is a deliberate act).
 * Explicit `bot.dig` in `mineBlock` is unaffected by any of this.
 *
 * `withDiggingMovements` remains as the "tunnel toward this natural target"
 * scope: same allowlist, cheap `digCost = 1`, and the guard can be lifted with
 * `allowStructures`.
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
import { builtStructureReason, isCheapBreak, isFallingBlockName, isNaturalTerrain } from "./structure-guard.js";
import { isCreative } from "./game-mode.js";

const { Movements } = pathfinderPkg;

/** Walking costs ~1 per block; breaking a dirt block by hand then costs ~13 at 4, so A* digs only when it saves a long detour. */
export const BASE_DIG_COST = 4;
/** The scoped digging variant (retry toward a buried/blocked natural target). */
export const SCOPED_DIG_COST = 1;
/** Extra cost per swim step (see buildMovements). */
export const LIQUID_COST = 8;
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
  /** Active (nested / overlapping) digging scopes. Base is restored only at 0. */
  depth: number;
  /** Active scopes that want the player-built structure guard on. */
  strict: number;
  /** Bumped by `resetMovementsToBase`; scopes from an older generation no longer own the counters. */
  generation: number;
  /** When the most recent scope was entered; safety net for abandoned scopes. */
  digSince: number;
}

/**
 * An abandoned (watchdogged) skill can leave a digging scope open. The harness
 * watchdog resets explicitly; this is the backstop if it doesn't (longest
 * legitimate scope is one navigate, <= 5 min).
 */
export const DIG_SCOPE_MAX_MS = 6 * 60_000;

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
    st = { base: buildMovements(bot), depth: 0, strict: 0, generation: 0, digSince: 0 };
    // Base always keeps the player-built structure guard (a scope may lift it for its own variant only).
    const guard = st.base.exclusionAreasBreak as unknown as Array<(b: Block) => number>;
    guard.length = 0;
    guard.push((b) => (builtStructureReason(bot, b) ? 100 : 0));
    states.set(bot, st);
    bot.pathfinder.setMovements(st.base);
  } else {
    if (st.depth > 0 && Date.now() - st.digSince > DIG_SCOPE_MAX_MS) {
      console.warn(`[${bot.username}] digging Movements scope open > ${DIG_SCOPE_MAX_MS / 60_000} min (abandoned skill?); resetting to base`);
      resetMovementsToBase(bot);
    }
    // Anyone else calling setMovements with a foreign instance is a bug; heal it.
    // The digging variant is only legitimate while a scope is open.
    const cur = bot.pathfinder.movements;
    if (cur !== st.base && !(st.depth > 0 && cur === st.digging)) bot.pathfinder.setMovements(st.base);
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

/** Open digging scopes for this bot (0 = base policy; for the harness, checks and tests). */
export function diggingDepth(bot: object): number {
  return states.get(bot)?.depth ?? 0;
}

/**
 * Force the no-dig policy back, dropping every open scope. Called by the
 * harness watchdog when it abandons a skill, so a zombie `mineBlocks` can't
 * leave digging installed (its own `finally` is then a no-op: stale generation).
 */
export function resetMovementsToBase(bot: BotWithPathfinder): void {
  const st = states.get(bot);
  if (!st) return;
  st.depth = 0;
  st.strict = 0;
  st.generation += 1;
  bot.pathfinder.setMovements(st.base);
}

/**
 * Run `fn` with the cheap-digging Movements installed (digCost 1 instead of the
 * base's BASE_DIG_COST), then restore base in `finally`. Use it around a single
 * navigate/getPathTo call toward a natural block the bot is about to mine anyway
 * (e.g. ore buried under dirt). Like base, the variant may only break NATURAL
 * terrain (allowlist via `blocksCantBreak`) and never places blocks; it differs
 * in price and in that `allowStructures` lifts the built-structure guard.
 *
 * Re-entrant: scopes are counted per bot, and base is restored only when the
 * outermost scope exits (a nested or overlapping scope can't restore early).
 * The structure guard stays on while any open scope asked for it.
 */
export async function withDiggingMovements<T>(
  bot: BotWithPathfinder,
  opts: { allowStructures?: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  ensureMovements(bot);
  const st = states.get(bot)!;
  if (!st.digging) {
    const dig = buildMovements(bot, true);
    // exclusionBreak >= 100 makes pathfinder treat a block as unbreakable.
    const guard = dig.exclusionAreasBreak as unknown as Array<(b: Block) => number>;
    guard.length = 0;
    guard.push((b) => (st.strict > 0 && builtStructureReason(bot, b) ? 100 : 0));
    st.digging = dig;
  }
  const strict = !opts.allowStructures;
  const gen = st.generation;
  st.depth += 1;
  if (strict) st.strict += 1;
  st.digSince = Date.now();
  st.digging.maxDropDown = st.base.maxDropDown;
  bot.pathfinder.setMovements(st.digging);
  try {
    return await fn();
  } finally {
    if (st.generation === gen) {
      st.depth = Math.max(0, st.depth - 1);
      if (strict) st.strict = Math.max(0, st.strict - 1);
      if (st.depth === 0) bot.pathfinder.setMovements(st.base);
    }
  }
}

/** Block ids the dig variant may NOT break: everything outside the natural-terrain allowlist. */
export function naturalOnlyCantBreak(registry: { blocksArray: Array<{ id: number; name: string; diggable?: boolean }> }): Set<number> {
  const out = new Set<number>();
  for (const b of registry.blocksArray) {
    if (!b.diggable || !(isNaturalTerrain(b.name) || isCheapBreak(b.name))) out.add(b.id);
  }
  return out;
}

function buildMovements(bot: BotWithPathfinder, digging = false): MovementsT {
  const m = new Movements(bot);
  // See the file header: natural terrain only (allowlist), structure-guarded, priced
  // so walking wins. Logs, planks, cobblestone, builds and containers are never
  // breakable to A* in either variant.
  m.canDig = true;
  m.digCost = digging ? SCOPED_DIG_COST : BASE_DIG_COST;
  (m as unknown as { blocksCantBreak: Set<number> }).blocksCantBreak = naturalOnlyCantBreak(bot.registry as never);
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
  // v2 R6: raised from 3 to 8. At 3 a swim costs 4/block, cheaper than digging through rock (~7), so the
  // planner swam a flooded tunnel under a sealed roof and the bot drowned. At 9/block a 5-block swim
  // already costs 45 and digging or walking around wins; a real crossing is still possible when it is the
  // only way. The breath reflex (auto-behaviors.ts) is the safety net, this just avoids planning them.
  (m as unknown as { liquidCost: number }).liquidCost = LIQUID_COST; // not in the .d.ts
  // Free motion (straight-line moves through open water/air, skipping A* node-to-node) lets a path cut
  // across a flooded cave, so keep it off (it is also the default).
  (m as unknown as { allowFreeMotion: boolean }).allowFreeMotion = false;
  // pathfinder 2.4.5 supports this (default true; made explicit so a lib change can't silently drop it):
  // safeToBreak() refuses a block whose upper neighbour is a gravityBlocks member or has an entity on it.
  (m as unknown as { dontMineUnderFallingBlock: boolean }).dontMineUnderFallingBlock = true;
  // ...but the lib's gravity list is only sand + gravel; add the other blocks that fall.
  const gravity = (m as unknown as { gravityBlocks: Set<number> }).gravityBlocks;
  for (const b of bot.registry.blocksArray) if (isFallingBlockName(b.name)) gravity.add(b.id);
  return m;
}
