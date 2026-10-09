/**
 * Cooperative cancellation flag for long-running, tick-loop skills
 * (`followPlayer`, `attack`, `flee`).
 *
 * Two paths set it:
 *  - Claude calls the `stop` skill explicitly.
 *  - The chat-event side-channel in `mineflayer-glue/event-hooks.ts` detects
 *    a "stop"-style message from the current conversation partner while a
 *    cancellable tool is in flight, and flips the flag before the message is
 *    queued through the agent. This is what makes player-side preempt work
 *    despite chat being queued — see ARCHITECTURE.md "Interruption while a
 *    skill runs".
 *
 * Skills check {@link isRequested} between iterations and exit cleanly with
 * `ok: true, message: "cancelled"` (or similar). The flag auto-clears on
 * `begin()` so a fresh long-running skill never inherits a stale request.
 */
export class CancellationFlag {
  private requested = false;
  private readonly listeners = new Set<() => void>();

  /**
   * Observe every `request()` (stop skill, chat preempt, death, watchdog).
   * The v2 job runner uses this: `runSkill` clears the flag at each skill
   * start, so a job polling `isRequested()` between steps could miss a stop.
   * Returns an unsubscribe function.
   */
  onRequest(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called by stop skill / side-channel. Idempotent. */
  request(): void {
    this.requested = true;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // observers must never break the stop path
      }
    }
  }

  /** Called at the start of a cancellable skill. Resets any prior request. */
  begin(): void {
    this.requested = false;
  }

  isRequested(): boolean {
    return this.requested;
  }
}
