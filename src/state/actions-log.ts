/**
 * Rolling log of skill results. `recent()` surfaces the last 5 minutes to
 * `observeSurroundings` as `recentActions` so Claude doesn't have to
 * reconstruct what the bot just did from chat history when a player asks
 * "what have you been doing?".
 *
 * Entries are short phrases — the success message from each skill (e.g.
 * "mined 7 oak_log", "arrived near coords at (100, 64, -200)").
 *
 * Persisted to `data/orchestrator/memory/<bot>/actions.json` once
 * {@link ActionsLog.attachPersistence} is called (by `registerBotState`), so
 * a fresh agent session or an orchestrator restart can still see the last
 * {@link MAX_ENTRIES} things the bot did via {@link ActionsLog.history}.
 */

import { loadJson, saveJsonAtomic } from "./persist.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 50;

interface Entry {
  message: string;
  at: number;
}

export class ActionsLog {
  private entries: Entry[] = [];
  private path: string | null = null;

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  /** Load prior entries from `path` and write every subsequent change there. */
  attachPersistence(path: string): void {
    this.path = path;
    const loaded = loadJson<Entry[]>(path);
    if (Array.isArray(loaded)) {
      this.entries = loaded
        .filter((e) => typeof e?.message === "string" && typeof e?.at === "number")
        .slice(-MAX_ENTRIES);
    }
  }

  record(message: string): void {
    this.entries.push({ message, at: Date.now() });
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    if (this.path) saveJsonAtomic(this.path, this.entries);
  }

  /** Messages from the last TTL window (5 min), oldest first. */
  recent(): string[] {
    const cutoff = Date.now() - this.ttlMs;
    return this.entries.filter((e) => e.at >= cutoff).map((e) => e.message);
  }

  /** Last `limit` entries regardless of age, oldest first, with timestamps. */
  history(limit: number = MAX_ENTRIES): Array<{ message: string; at: number }> {
    return this.entries.slice(-limit).map((e) => ({ ...e }));
  }
}
