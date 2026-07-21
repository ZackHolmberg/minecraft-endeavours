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
  private rev = 0;

  set(tasks: string[]): void {
    const normalized = tasks.map((t) => t.trim()).filter((t) => t.length > 0);
    if (normalized.length === 0) {
      this.clear();
      return;
    }
    this.currentTask = normalized[0]!;
    this.queued = normalized.slice(1);
    this.rev += 1;
  }

  /** Marks the current task done. Returns the new current task or null if the queue emptied. */
  advance(): string | null {
    this.rev += 1;
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
  }
}
