/**
 * Per-bot multi-task queue. When a player chains requests ("get wood, then
 * iron, then come back"), the agent calls `setTaskQueue([...])` to declare
 * the plan and `advanceTaskQueue()` between items. The orchestrator persists
 * the queue across turns and surfaces it in every `observeSurroundings`, so
 * Claude doesn't have to remember the chain from conversation memory.
 *
 * State stores the plan; `setTaskQueue` / `advanceTaskQueue` are plain
 * wrappers around these methods.
 *
 * Persisted to `data/orchestrator/memory/<bot>/tasks.json` once
 * {@link TaskQueue.attachPersistence} is called (by `registerBotState`), so a
 * plan survives orchestrator restarts and fresh agent sessions.
 */

import { loadJson, saveJsonAtomic } from "./persist.js";

interface Persisted {
  currentTask: string | null;
  queued: string[];
}

export class TaskQueue {
  private currentTask: string | null = null;
  private queued: string[] = [];
  private rev = 0;
  private path: string | null = null;

  /** Load a previously saved plan from `path` and write every change there. */
  attachPersistence(path: string): void {
    this.path = path;
    const loaded = loadJson<Persisted>(path);
    if (loaded && (typeof loaded.currentTask === "string" || loaded.currentTask === null)) {
      this.currentTask = loaded.currentTask;
      this.queued = Array.isArray(loaded.queued) ? loaded.queued.filter((t) => typeof t === "string") : [];
    }
  }

  private persist(): void {
    if (this.path) saveJsonAtomic(this.path, { currentTask: this.currentTask, queued: this.queued });
  }

  set(tasks: string[]): void {
    const normalized = tasks.map((t) => t.trim()).filter((t) => t.length > 0);
    if (normalized.length === 0) {
      this.clear();
      return;
    }
    this.currentTask = normalized[0]!;
    this.queued = normalized.slice(1);
    this.rev += 1;
    this.persist();
  }

  /** Marks the current task done. Returns the new current task or null if the queue emptied. */
  advance(): string | null {
    this.rev += 1;
    if (this.queued.length === 0) {
      this.currentTask = null;
      this.persist();
      return null;
    }
    this.currentTask = this.queued.shift()!;
    this.persist();
    return this.currentTask;
  }

  current(): string | null {
    return this.currentTask;
  }

  remaining(): string[] {
    return [...this.queued];
  }

  isEmpty(): boolean {
    return this.currentTask === null;
  }

  /**
   * Monotonic mutation counter, bumped on every `set` / `advance` / `clear`.
   * The hybrid coordinator uses it as a deterministic signal: a bump after a
   * planner turn means a plan was (re)declared (handoff); a bump during an
   * executor turn means a task was advanced (progress).
   */
  revision(): number {
    return this.rev;
  }

  clear(): void {
    this.currentTask = null;
    this.queued = [];
    this.rev += 1;
    this.persist();
  }
}
