/**
 * Per-player game mode via RCON `data get entity <name> playerGameType`.
 * Cached per name and single-flight so polling /api/players can't fan out
 * into a docker exec per player per request. Fails soft: unknown → omitted.
 */
import type { GameMode } from "../shared/api.js";
import { rcon } from "./exec.js";
import { PLAYER_NAME_RE } from "./validate.js";

const TTL_MS = 15_000;
const MAX_PLAYERS = 20;
const CONCURRENCY = 4;
const MODES: readonly GameMode[] = ["survival", "creative", "adventure", "spectator"];

/** "Steve has the following entity data: 1" → "creative"; anything else → null. */
export function parseGameType(output: string): GameMode | null {
  const m = /has the following entity data:\s*(-?\d+)[bsil]?\s*$/i.exec(output.trim());
  if (!m) return null;
  return MODES[Number(m[1])] ?? null;
}

export class GameModeCache {
  private cache = new Map<string, { at: number; mode: GameMode | null }>();
  private inflight = new Map<string, Promise<GameMode | null>>();

  constructor(private readonly query: (cmd: string) => Promise<{ ok: boolean; output: string }> = (c) => rcon(c, 5_000)) {}

  set(name: string, mode: GameMode): void {
    this.cache.set(name, { at: Date.now(), mode });
  }

  invalidate(name: string): void {
    this.cache.delete(name);
  }

  async get(names: string[]): Promise<Record<string, GameMode>> {
    const wanted = [...new Set(names)].filter((n) => PLAYER_NAME_RE.test(n)).slice(0, MAX_PLAYERS);
    // Drop entries for players who left so the map stays bounded.
    for (const k of this.cache.keys()) if (!wanted.includes(k)) this.cache.delete(k);
    const out: Record<string, GameMode> = {};
    const queue = [...wanted];
    const worker = async (): Promise<void> => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        const mode = await this.one(n);
        if (mode) out[n] = mode;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    return out;
  }

  private one(name: string): Promise<GameMode | null> {
    const hit = this.cache.get(name);
    if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.mode);
    let p = this.inflight.get(name);
    if (!p) {
      p = this.query(`data get entity ${name} playerGameType`)
        .then((r) => (r.ok ? parseGameType(r.output) : null))
        .catch(() => null)
        .then((mode) => {
          this.cache.set(name, { at: Date.now(), mode });
          return mode;
        })
        .finally(() => this.inflight.delete(name));
      this.inflight.set(name, p);
    }
    return p;
  }
}
