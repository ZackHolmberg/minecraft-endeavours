/**
 * Per-bot in-process state. Holds the three middleware stores
 * (recent actions, player presence, task queue) that `observeSurroundings`
 * surfaces to the agent.
 *
 * State lives for the orchestrator's lifetime — survives bot reconnects (a
 * dropped TCP doesn't erase what was happening 30 seconds ago). The task
 * queue and actions log are also persisted next to `world.json` (see
 * `registerBotState`) so they survive restarts and fresh agent sessions;
 * presence / current-tool / cancellation are deliberately ephemeral.
 *
 * Skills look up state via {@link getBotState} keyed by `bot.username` so the
 * `(bot, params) => Promise<SkillResult>` skill signature stays pure.
 */

import { ActionsLog } from "./actions-log.js";
import { CancellationFlag } from "./cancellation.js";
import { CurrentToolTracker } from "./current-tool.js";
import { memoryFileFor } from "./persist.js";
import { PlayerPresence } from "./player-presence.js";
import { TaskQueue } from "./task-queue.js";

export { ActionsLog } from "./actions-log.js";
export { CancellationFlag } from "./cancellation.js";
export { CurrentToolTracker } from "./current-tool.js";
export { PlayerPresence, type RecentlySeenPlayer } from "./player-presence.js";
export { TaskQueue } from "./task-queue.js";

export interface BotState {
  actions: ActionsLog;
  presence: PlayerPresence;
  tasks: TaskQueue;
  currentTool: CurrentToolTracker;
  cancellation: CancellationFlag;
}

export function createBotState(): BotState {
  return {
    actions: new ActionsLog(),
    presence: new PlayerPresence(),
    tasks: new TaskQueue(),
    currentTool: new CurrentToolTracker(),
    cancellation: new CancellationFlag(),
  };
}

const registry = new Map<string, BotState>();

/**
 * Register and hydrate: the task queue and actions log load their on-disk
 * copies (next to world.json) and persist every change from here on. Done
 * here rather than in `createBotState` so the constructor stays username-free.
 */
export function registerBotState(username: string, state: BotState): void {
  state.tasks.attachPersistence(memoryFileFor(username, "tasks.json"));
  state.actions.attachPersistence(memoryFileFor(username, "actions.json"));
  registry.set(username, state);
}

export function unregisterBotState(username: string): void {
  registry.delete(username);
}

export function getBotState(username: string): BotState | null {
  return registry.get(username) ?? null;
}
