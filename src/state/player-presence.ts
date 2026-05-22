/**
 * Per-bot view of who's been on the server lately.
 *
 * Currently-online players are visible via mineflayer (`bot.players` and
 * `nearbyEntities` in `observeSurroundings`). This store covers the inverse:
 * who *used* to be online and where they were last seen. Surfaced by
 * `observeSurroundings` as `recentlySeenPlayers` so Claude can answer
 * "has Zack been on today?" without guessing.
 */

const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface Pos {
  x: number;
  y: number;
  z: number;
}

interface Entry {
  name: string;
  status: "online" | "offline";
  lastSeen: number;
  lastPos: Pos | null;
}

export interface RecentlySeenPlayer {
  name: string;
  lastSeen: number;
  lastPos: Pos | null;
}

export class PlayerPresence {
  private players = new Map<string, Entry>();

  constructor(private readonly recentWindowMs: number = DEFAULT_RECENT_WINDOW_MS) {}

  onJoin(name: string, pos: Pos | null = null): void {
    this.players.set(name, {
      name,
      status: "online",
      lastSeen: Date.now(),
      lastPos: pos,
    });
  }

  onLeave(name: string, pos: Pos | null = null): void {
    const existing = this.players.get(name);
    this.players.set(name, {
      name,
      status: "offline",
      lastSeen: Date.now(),
      lastPos: pos ?? existing?.lastPos ?? null,
    });
  }

  recentlySeen(): RecentlySeenPlayer[] {
    const cutoff = Date.now() - this.recentWindowMs;
    const out: RecentlySeenPlayer[] = [];
    for (const entry of this.players.values()) {
      if (entry.status !== "offline") continue;
      if (entry.lastSeen < cutoff) continue;
      out.push({ name: entry.name, lastSeen: entry.lastSeen, lastPos: entry.lastPos });
    }
    out.sort((a, b) => b.lastSeen - a.lastSeen);
    return out;
  }

  isOnline(name: string): boolean {
    return this.players.get(name)?.status === "online";
  }
}
