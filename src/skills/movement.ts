import type { Bot } from "mineflayer";
import pathfinderPkg, { type Pathfinder } from "mineflayer-pathfinder";

const { goals, Movements } = pathfinderPkg;
import { Vec3 } from "vec3";
import type { GoToTarget, SkillResult } from "./types.js";

const DEFAULT_REACH = 1;
const SEARCH_RADIUS_FOR_BLOCK = 64;
const PATH_CHECK_TIMEOUT_MS = 5_000;

export interface GoToParams {
  target: GoToTarget;
  /** Stop when within this many blocks of the target. Defaults to 1. */
  reach?: number;
}

interface BotWithPathfinder extends Bot {
  pathfinder: Pathfinder;
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

export function stopMovement(bot: Bot): SkillResult {
  const pBot = bot as BotWithPathfinder;
  pBot.pathfinder?.stop();
  return { ok: true, message: "stopped" };
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
      const id = bot.registry.blocksByName[target.block]?.id;
      if (id === undefined) return { ok: false, message: `unknown block type "${target.block}"` };
      const found = bot.findBlock({
        point: bot.entity.position,
        matching: id,
        maxDistance: SEARCH_RADIUS_FOR_BLOCK,
      });
      if (!found) {
        return { ok: false, message: `no ${target.block} within ${SEARCH_RADIUS_FOR_BLOCK} blocks` };
      }
      return { ok: true, destination: found.position.clone(), label: target.block };
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

function ensureMovements(bot: BotWithPathfinder): void {
  if (!bot.pathfinder.movements || bot.pathfinder.movements.bot !== bot) {
    bot.pathfinder.setMovements(new Movements(bot));
  }
}

function fmt(v: Vec3): string {
  return `(${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.z)})`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
