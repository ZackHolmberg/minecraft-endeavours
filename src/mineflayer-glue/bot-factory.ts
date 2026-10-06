import mineflayer, { type Bot } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { recordEvent, recordEventAll } from "../observability/telemetry.js";
import type { BotConfig } from "../types.js";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/**
 * A connection must stay up this long before the backoff resets. Resetting
 * on `spawn` alone meant a server that accepts logins but then stalls (the
 * observed spawn → 30s keepAliveError loop) got hammered at a fixed 1s
 * backoff forever.
 */
const STABLE_CONNECTION_MS = 60_000;
/** Log when the event loop was blocked this long — keepalive dies at 30s. */
const LOOP_LAG_WARN_MS = 2_000;
const LOOP_LAG_SAMPLE_MS = 1_000;
/** Record a telemetry `loop_lag` event for stalls at least this long. */
const LOOP_LAG_TELEMETRY_MS = 500;

let lagMonitorStarted = false;
/** Bots that get the process-wide loop_lag events. */
const lagTelemetryBots = new Set<string>();

/**
 * Process-wide event-loop stall detector. mineflayer answers keepalives from
 * the event loop; if something synchronous blocks it for >30s the client
 * times itself out with `keepAliveError` even though the server is fine.
 * A logged stall right before a disconnect points at us; no stall points at
 * the server / host (e.g. Paper "Can't keep up!" or host memory pressure).
 */
function startLoopLagMonitor(): void {
  if (lagMonitorStarted) return;
  lagMonitorStarted = true;
  let expected = Date.now() + LOOP_LAG_SAMPLE_MS;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + LOOP_LAG_SAMPLE_MS;
    if (lag >= LOOP_LAG_WARN_MS) {
      console.warn(`orchestrator: event loop was blocked for ~${Math.round(lag / 1000)}s`);
    }
    if (lag >= LOOP_LAG_TELEMETRY_MS) {
      recordEventAll([...lagTelemetryBots], { kind: "loop_lag", lagMs: lag });
    }
  }, LOOP_LAG_SAMPLE_MS);
  timer.unref();
}

/**
 * Connection state surfaced through the supervisor so the dashboard (phase 3)
 * can render the NET row without polling mineflayer internals.
 *  - connecting: bot built, awaiting the first `spawn` event
 *  - connected:  spawn fired, bot is in-world
 *  - reconnecting: disconnected, backoff timer scheduled
 *  - stopped: supervisor shut down (final state)
 */
export type BotConnectionState = "connecting" | "connected" | "reconnecting" | "stopped";

export interface BotSupervisor {
  readonly username: string;
  readonly state: BotConnectionState;
  /** Unix-ms timestamp of the most recent successful `spawn`, or null. */
  readonly connectedSince: number | null;
  /** The current mineflayer Bot instance, or null while disconnected. */
  readonly bot: Bot | null;
  stop(): Promise<void>;
}

export interface BotSupervisorOptions {
  botConfig: BotConfig;
  host: string;
  port: number;
  version: string;
  /**
   * Called every time a new mineflayer Bot instance is created, before its
   * `spawn` event. Wire chat listeners and other per-connection hooks here —
   * the Bot is discarded on disconnect and a fresh one is built for reconnect,
   * so the hooks are registered anew each lifetime.
   */
  onConnect: (bot: Bot) => void;
}

export function startBotSupervisor(opts: BotSupervisorOptions): BotSupervisor {
  const { botConfig, host, port, version, onConnect } = opts;
  const tag = `[${botConfig.username}]`;

  let stopped = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let currentBot: Bot | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let spawned = false;
  let connectedSince: number | null = null;
  let stableTimer: NodeJS.Timeout | null = null;

  startLoopLagMonitor();
  lagTelemetryBots.add(botConfig.username);

  const connect = (): void => {
    if (stopped) return;
    console.log(`${tag} connecting to ${host}:${port} as ${botConfig.username}`);

    const bot = mineflayer.createBot({
      host,
      port,
      username: botConfig.username,
      auth: "offline",
      version,
    });
    currentBot = bot;
    bot.loadPlugin(pathfinder);

    onConnect(bot);

    bot.once("spawn", () => {
      console.log(`${tag} spawned in world (pos=${formatPos(bot)})`);
      stableTimer = setTimeout(() => {
        stableTimer = null;
        backoffMs = INITIAL_BACKOFF_MS;
      }, STABLE_CONNECTION_MS);
      spawned = true;
      connectedSince = Date.now();
      recordEvent(botConfig.username, { kind: "connection", state: "connected", reason: null, inWorldMs: null });
    });

    bot.on("kicked", (reason) => {
      console.warn(`${tag} kicked: ${reason}`);
    });

    bot.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      console.warn(`${tag} error: ${code ?? err.message ?? err.name}`);
    });

    bot.once("end", (reason) => {
      const upFor = connectedSince ? ` after ${Math.round((Date.now() - connectedSince) / 1000)}s in-world` : " before spawning";
      console.warn(`${tag} disconnected: ${reason}${upFor}`);
      if (currentBot === bot) {
        recordEvent(botConfig.username, {
          kind: "connection",
          state: "disconnected",
          reason: String(reason ?? "").slice(0, 200) || null,
          inWorldMs: connectedSince ? Date.now() - connectedSince : null,
        });
      }
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      // Don't null out a newer bot if this is a stale instance's late `end`.
      if (currentBot !== bot) return;
      currentBot = null;
      spawned = false;
      connectedSince = null;
      if (stopped) return;
      scheduleReconnect();
    });
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const delay = backoffMs;
    console.log(`${tag} reconnecting in ${delay}ms`);
    recordEvent(botConfig.username, { kind: "connection", state: "reconnecting", reason: `retry in ${delay}ms`, inWorldMs: null });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      connect();
    }, delay);
  };

  connect();

  return {
    username: botConfig.username,
    get state(): BotConnectionState {
      if (stopped) return "stopped";
      if (spawned) return "connected";
      if (reconnectTimer !== null) return "reconnecting";
      return "connecting";
    },
    get connectedSince(): number | null {
      return connectedSince;
    },
    get bot(): Bot | null {
      return currentBot;
    },
    async stop() {
      stopped = true;
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentBot) {
        try {
          currentBot.quit("orchestrator shutting down");
        } catch {
          // best-effort; the socket may already be closing
        }
        currentBot = null;
      }
      spawned = false;
      connectedSince = null;
    },
  };
}

function formatPos(bot: Bot): string {
  const p = bot.entity?.position;
  if (!p) return "unknown";
  return `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-bot supervisor registry. Matches the agent + state registry pattern so
// observability helpers (snapshot, dashboard) can look up by username without
// holding the supervisor array from index.ts.
// ─────────────────────────────────────────────────────────────────────────────

const supervisors = new Map<string, BotSupervisor>();

export function registerSupervisor(supervisor: BotSupervisor): void {
  supervisors.set(supervisor.username, supervisor);
}

export function unregisterSupervisor(username: string): void {
  supervisors.delete(username);
}

export function getSupervisor(username: string): BotSupervisor | null {
  return supervisors.get(username) ?? null;
}

export function listSupervisors(): BotSupervisor[] {
  return [...supervisors.values()];
}
