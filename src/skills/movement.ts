import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { goals } = pathfinderPkg;
import { Vec3 } from "vec3";
import { getBotState } from "../state/index.js";
import { resolveBlock } from "./item-naming.js";
import { ensureMovements, type BotWithPathfinder } from "./pathfinder-config.js";
import type { GoToTarget, SkillResult } from "./types.js";

const DEFAULT_REACH = 1;
const SEARCH_RADIUS_FOR_BLOCK = 64;
const PATH_CHECK_TIMEOUT_MS = 5_000;
const FOLLOW_DEFAULT_DIST = 2;
const FOLLOW_MAX_DIST = 16;
const FOLLOW_TICK_MS = 250;

export interface GoToParams {
  target: GoToTarget;
  /** Stop when within this many blocks of the target. Defaults to 1. */
  reach?: number;
}

export async function goTo(bot: Bot, { target, reach = DEFAULT_REACH }: GoToParams): Promise<SkillResult> {
  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);

  const resolved = resolveTarget(bot, target);
  if (!resolved.ok) return { ok: false, message: resolved.message };

  const { destination, label } = resolved;
  const goal = new goals.GoalNear(destination.x, destination.y, destination.z, reach);

  const path = pBot.pathfinder.getPathTo(pBot.pathfinder.movements, goal, PATH_CHECK_TIMEOUT_MS);
  if (path.status === "noPath") {
    return { ok: false, message: `no path to ${label} at ${fmt(destination)}` };
  }

  try {
    await pBot.pathfinder.goto(goal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `pathfinding to ${label} failed: ${message}` };
  }

  const arrived = bot.entity.position;
  return {
    ok: true,
    message: `arrived near ${label} at ${fmt(destination)}`,
    state: { position: { x: round2(arrived.x), y: round2(arrived.y), z: round2(arrived.z) } },
  };
}

/**
 * The full `stop` skill from the catalogue: flips the per-bot cancellation
 * flag (so tick-loop skills like `followPlayer` / `attack` / `flee` exit
 * promptly) and cancels any active pathfinder goal. Safe to call when nothing
 * is in flight — the flag is reset by each cancellable skill on entry.
 */
export async function stop(bot: Bot): Promise<SkillResult> {
  const state = getBotState(bot.username);
  state?.cancellation.request();
  const pBot = bot as BotWithPathfinder;
  pBot.pathfinder?.stop();
  return { ok: true, message: "stopped" };
}

export interface FollowPlayerParams {
  player: string;
  dist?: number;
}

/**
 * Sustained follow. Sets a dynamic pathfinder GoalFollow and parks in a tick
 * loop until cancellation is requested (player says "stop" → side-channel in
 * event-hooks, or Claude calls the `stop` skill) or the player leaves the
 * server. The skill returns only when one of those conditions fires —
 * blocking the agent loop is intentional, matching `mineBlock`'s shape.
 */
export async function followPlayer(
  bot: Bot,
  { player, dist = FOLLOW_DEFAULT_DIST }: FollowPlayerParams,
): Promise<SkillResult> {
  if (!player) return { ok: false, message: "player name required" };
  if (dist < 1 || dist > FOLLOW_MAX_DIST) {
    return { ok: false, message: `dist must be between 1 and ${FOLLOW_MAX_DIST}, got ${dist}` };
  }

  const playerInfo = bot.players[player];
  if (!playerInfo?.entity) {
    return { ok: false, message: `player "${player}" is not visible to the bot` };
  }

  const pBot = bot as BotWithPathfinder;
  ensureMovements(pBot);

  const state = getBotState(bot.username);
  state?.cancellation.begin();

  pBot.pathfinder.setGoal(new goals.GoalFollow(playerInfo.entity, dist), true);

  try {
    while (true) {
      if (state?.cancellation.isRequested()) {
        return { ok: true, message: `stopped following ${player}` };
      }
      const current = bot.players[player]?.entity;
      if (!current) {
        return { ok: false, message: `lost sight of ${player} (left server or moved out of range)` };
      }
      await sleep(FOLLOW_TICK_MS);
    }
  } finally {
    pBot.pathfinder.setGoal(null);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Resolved = { ok: true; destination: Vec3; label: string } | { ok: false; message: string };

function resolveTarget(bot: Bot, target: GoToTarget): Resolved {
  switch (target.kind) {
    case "coords": {
      const { x, y, z } = target.coords;
      return { ok: true, destination: new Vec3(x, y, z), label: "coords" };
    }
    case "entity": {
      const entity = findEntityByName(bot, target.entity);
      if (!entity) return { ok: false, message: `entity "${target.entity}" not visible to the bot` };
      return { ok: true, destination: entity.position.clone(), label: target.entity };
    }
    case "block": {
      const r = resolveBlock(bot, target.block);
      if (!r.ok) return { ok: false, message: `block ${r.message}` };
      const found = bot.findBlock({
        point: bot.entity.position,
        matching: r.data.id,
        maxDistance: SEARCH_RADIUS_FOR_BLOCK,
      });
      if (!found) {
        return { ok: false, message: `no ${r.normalized} within ${SEARCH_RADIUS_FOR_BLOCK} blocks` };
      }
      return { ok: true, destination: found.position.clone(), label: r.normalized };
    }
  }
}

function findEntityByName(bot: Bot, name: string) {
  const player = bot.players[name];
  if (player?.entity) return player.entity;

  const lower = name.toLowerCase();
  let best: { entity: NonNullable<ReturnType<Bot["nearestEntity"]>>; dist: number } | null = null;
  const me = bot.entity.position;
  for (const id of Object.keys(bot.entities)) {
    const entity = bot.entities[id];
    if (!entity || entity.id === bot.entity.id) continue;
    if (entity.name?.toLowerCase() !== lower && entity.username?.toLowerCase() !== lower) continue;
    const dist = me.distanceTo(entity.position);
    if (!best || dist < best.dist) best = { entity, dist };
  }
  return best?.entity ?? null;
}

function fmt(v: Vec3): string {
  return `(${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.z)})`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
