/**
 * Per-bot multi-task queue. When a player chains requests ("get wood, then
 * iron, then come back"), the agent calls `setTaskQueue([...])` to declare
 * the plan and `advanceTaskQueue()` between items. The orchestrator persists
 * the queue across turns and surfaces it in every `observeSurroundings`, so
 * Claude doesn't have to remember the chain from conversation memory.
 *
 * State stores the plan; the actual `setTaskQueue` / `advanceTaskQueue`
 * skills land in phase 2 as plain wrappers around these methods.
 */

export class TaskQueue {
  private currentTask: string | null = null;
  private queued: string[] = [];

  set(tasks: string[]): void {
    const normalized = tasks.map((t) => t.trim()).filter((t) => t.length > 0);
    if (normalized.length === 0) {
      this.clear();
      return;
    }
    this.currentTask = normalized[0]!;
    this.queued = normalized.slice(1);
  }

  /** Marks the current task done. Returns the new current task or null if the queue emptied. */
  advance(): string | null {
    if (this.queued.length === 0) {
      this.currentTask = null;
      return null;
    }
    this.currentTask = this.queued.shift()!;
    return this.currentTask;
  }

  current(): string | null {
    return this.currentTask;
  }

  remaining(): string[] {
    return [...this.queued];
  }

  clear(): void {
    this.currentTask = null;
    this.queued = [];
  }
}
