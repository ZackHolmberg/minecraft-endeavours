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
import { installDoorAssist, patchMovementsForDoors } from "./doors.js";

const { Movements } = pathfinderPkg;

export interface BotWithPathfinder extends Bot {
  pathfinder: Pathfinder;
}

export function ensureMovements(bot: BotWithPathfinder): void {
  if (!bot.pathfinder.movements || bot.pathfinder.movements.bot !== bot) {
    bot.pathfinder.setMovements(buildMovements(bot));
  }
  installDoorAssist(bot);
}

function buildMovements(bot: BotWithPathfinder): InstanceType<typeof Movements> {
  const m = new Movements(bot);
  // Pathfinder must never break blocks to clear a path. The bot tearing
  // through player-built walls instead of walking around to a door was the
  // motivating regression — see docstring above for why this is safe.
  m.canDig = false;
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
  // Default 4 costs half a heart per drop (fall damage starts past 3).
  // Players hop down 3 freely; 4+ they look for another way. Water landings
  // are unaffected (infiniteLiquidDropdownDistance stays on).
  m.maxDropDown = 3;
  // Default 1 makes a swim as cheap as a walk, so the planner happily routes
  // across lakes and through flooded caves (slow, drowning risk, and the
  // bot bobs along looking lost). 3 still swims when it's the only way.
  (m as unknown as { liquidCost: number }).liquidCost = 3; // not in the .d.ts
  return m;
}
