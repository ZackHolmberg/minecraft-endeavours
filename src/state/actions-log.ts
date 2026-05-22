/**
 * Rolling 5-minute log of skill results. Surfaced by `observeSurroundings`
 * as `recentActions` so Claude doesn't have to reconstruct what the bot just
 * did from chat history when a player asks "what have you been doing?".
 *
 * Entries are short phrases — the success message from each skill (e.g.
 * "mined 7 oak_log", "arrived near coords at (100, 64, -200)"). Older
 * entries fall off the end of the window automatically.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface Entry {
  message: string;
  at: number;
}

export class ActionsLog {
  private entries: Entry[] = [];

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  record(message: string): void {
    this.entries.push({ message, at: Date.now() });
    this.purgeExpired();
  }

  recent(): string[] {
    this.purgeExpired();
    return this.entries.map((e) => e.message);
  }

  private purgeExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    while (this.entries.length > 0 && this.entries[0]!.at < cutoff) {
      this.entries.shift();
    }
  }
}
