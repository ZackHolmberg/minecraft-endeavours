import mineflayer, { type Bot } from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import type { BotConfig } from "../types.js";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export interface BotSupervisor {
  readonly username: string;
  stop(): Promise<void>;
}

export interface BotSupervisorOptions {
  botConfig: BotConfig;
  host: string;
  port: number;
  /**
   * Called every time a new mineflayer Bot instance is created, before its
   * `spawn` event. Wire chat listeners and other per-connection hooks here —
   * the Bot is discarded on disconnect and a fresh one is built for reconnect,
   * so the hooks are registered anew each lifetime.
   */
  onConnect: (bot: Bot) => void;
}

export function startBotSupervisor(opts: BotSupervisorOptions): BotSupervisor {
  const { botConfig, host, port, onConnect } = opts;
  const tag = `[${botConfig.username}]`;

  let stopped = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let currentBot: Bot | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const connect = (): void => {
    if (stopped) return;
    console.log(`${tag} connecting to ${host}:${port} as ${botConfig.username}`);

    const bot = mineflayer.createBot({
      host,
      port,
      username: botConfig.username,
      auth: "offline",
    });
    currentBot = bot;
    bot.loadPlugin(pathfinder);

    onConnect(bot);

    bot.once("spawn", () => {
      console.log(`${tag} spawned in world (pos=${formatPos(bot)})`);
      backoffMs = INITIAL_BACKOFF_MS;
    });

    bot.on("kicked", (reason) => {
      console.warn(`${tag} kicked: ${reason}`);
    });

    bot.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      console.warn(`${tag} error: ${code ?? err.message ?? err.name}`);
    });

    bot.once("end", (reason) => {
      console.warn(`${tag} disconnected: ${reason}`);
      currentBot = null;
      if (stopped) return;
      scheduleReconnect();
    });
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const delay = backoffMs;
    console.log(`${tag} reconnecting in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      connect();
    }, delay);
  };

  connect();

  return {
    username: botConfig.username,
    async stop() {
      stopped = true;
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
    },
  };
}

function formatPos(bot: Bot): string {
  const p = bot.entity?.position;
  if (!p) return "unknown";
  return `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
}
