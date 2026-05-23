/**
 * Per-bot in-process state. Holds the three middleware stores
 * (recent actions, player presence, task queue) that `observeSurroundings`
 * surfaces to the agent.
 *
 * State lives for the orchestrator's lifetime — survives bot reconnects (a
 * dropped TCP doesn't erase what was happening 30 seconds ago) but does not
 * persist across orchestrator restarts. Durable knowledge belongs in
 * `world.json` (phase 2), not here.
 *
 * Skills look up state via {@link getBotState} keyed by `bot.username` so the
 * `(bot, params) => Promise<SkillResult>` skill signature stays pure.
 */

import { ActionsLog } from "./actions-log.js";
import { CurrentToolTracker } from "./current-tool.js";
import { PlayerPresence } from "./player-presence.js";
import { TaskQueue } from "./task-queue.js";

export { ActionsLog } from "./actions-log.js";
export { CurrentToolTracker } from "./current-tool.js";
export { PlayerPresence, type RecentlySeenPlayer } from "./player-presence.js";
export { TaskQueue } from "./task-queue.js";

export interface BotState {
  actions: ActionsLog;
  presence: PlayerPresence;
  tasks: TaskQueue;
  currentTool: CurrentToolTracker;
}

export function createBotState(): BotState {
  return {
    actions: new ActionsLog(),
    presence: new PlayerPresence(),
    tasks: new TaskQueue(),
    currentTool: new CurrentToolTracker(),
  };
}

const registry = new Map<string, BotState>();

export function registerBotState(username: string, state: BotState): void {
  registry.set(username, state);
}

export function unregisterBotState(username: string): void {
  registry.delete(username);
}

export function getBotState(username: string): BotState | null {
  return registry.get(username) ?? null;
}
