import type { Bot } from "mineflayer";
import { addPoi } from "../memory/world-knowledge.js";
import { getBotState } from "../state/index.js";
import type { Coords, SkillResult } from "./types.js";

/**
 * Record a point of interest into the bot's `world.json`. Called when a
 * player names a location ("this is our base", "call this spot the wheat
 * farm"). `pos` defaults to the bot's current position so Claude doesn't
 * have to call `observeSurroundings` first just to fetch coords.
 *
 * Idempotent on (type, position) — a duplicate `remember` succeeds with an
 * "already remembered" message instead of writing twice.
 */
export interface RememberParams {
  type: string;
  name?: string;
  pos?: Coords;
}

export async function remember(
  bot: Bot,
  { type, name, pos }: RememberParams,
): Promise<SkillResult> {
  const trimmedType = type?.trim();
  if (!trimmedType) {
    return { ok: false, message: "type is required (e.g. base, portal, bed)" };
  }

  const fallback = bot.entity?.position;
  const position: Coords | null = pos
    ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) }
    : fallback
      ? { x: Math.round(fallback.x), y: Math.round(fallback.y), z: Math.round(fallback.z) }
      : null;
  if (!position) {
    return { ok: false, message: "no position available — bot has no entity yet" };
  }

  const trimmedName = name?.trim();
  const result = await addPoi(bot.username, {
    type: trimmedType,
    ...(trimmedName ? { name: trimmedName } : {}),
    position,
    source: "claude",
  });
  const label = `${trimmedType}${trimmedName ? ` "${trimmedName}"` : ""} at (${position.x}, ${position.y}, ${position.z})`;
  if (!result.added) {
    return { ok: true, message: `already remembered: ${label}`, state: { added: false } };
  }
  return { ok: true, message: `remembered: ${label}`, state: { added: true } };
}

/**
 * Declare a multi-task plan. The orchestrator carries the queue across
 * turns and surfaces it in every `observeSurroundings` so Claude reads
 * `currentTask` / `remainingTasks` straight from the world, not from
 * conversation memory.
 */
export interface SetTaskQueueParams {
  tasks: string[];
}

export async function setTaskQueue(
  bot: Bot,
  { tasks }: SetTaskQueueParams,
): Promise<SkillResult> {
  const state = getBotState(bot.username);
  if (!state) return { ok: false, message: "no state registered for this bot" };
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, message: "tasks must be a non-empty array of strings" };
  }
  state.tasks.set(tasks);
  const current = state.tasks.current();
  const remaining = state.tasks.remaining();
  if (current === null) {
    return { ok: false, message: "all tasks were empty after trimming" };
  }
  return {
    ok: true,
    message: `task queue set (${1 + remaining.length} tasks); current: "${current}"`,
    state: { current, remaining },
  };
}

/**
 * Mark the current task done. Returns the new current task or signals an
 * empty queue. Claude calls this between items in a chained request like
 * "get wood, then iron, then come back".
 */
export async function advanceTaskQueue(bot: Bot): Promise<SkillResult> {
  const state = getBotState(bot.username);
  if (!state) return { ok: false, message: "no state registered for this bot" };
  const next = state.tasks.advance();
  if (next === null) {
    return {
      ok: true,
      message: "task queue drained",
      state: { current: null, remaining: [] },
    };
  }
  return {
    ok: true,
    message: `advanced; current: "${next}"`,
    state: { current: next, remaining: state.tasks.remaining() },
  };
}
