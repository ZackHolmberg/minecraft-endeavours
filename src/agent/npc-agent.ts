/**
 * Per-bot agent shell.
 *
 * `NpcAgent` owns one `AgentBackend` (the swappable LLM seam) and is otherwise
 * a thin adapter between the chat layer and that backend:
 *  - `pushChat(event, decision)` formats the chat into a user message and hands
 *    it to the backend (dropping it while the backend is rate-limited).
 *  - The 7 dashboard getters delegate straight to the backend's
 *    `BackendObservability` surface.
 *
 * Which backend is constructed is decided here from `botConfig.backend`:
 * `"claude"` (default) → `ClaudeBackend`; `"local"` → `LocalBackend`;
 * `"hybrid"` → `HybridBackend` (Claude plans / Qwen executes). The per-bot
 * registry (`registerAgent` / `getAgent`) and the `pushChat` entry point are
 * unchanged from the previous SDK-only design.
 */

import type { Bot } from "mineflayer";
import type { ChatEvent, RouteMatch } from "../orchestrator/chat-router.js";
import type { BotConfig } from "../types.js";
import { ClaudeBackend } from "./backend/claude-backend.js";
import { HybridBackend } from "./backend/hybrid-backend.js";
import { LocalBackend } from "./backend/local-backend.js";
import type {
  AgentBackend,
  LastTurnError,
  RateLimitInfo,
  SessionUsage,
  TurnUsage,
  WindowStats,
} from "./backend/types.js";

// Re-export the usage / rate-limit types from their new home so existing
// importers (notably src/observability/snapshot.ts) keep resolving them here.
export type {
  LastTurnError,
  RateLimitInfo,
  SessionUsage,
  TurnUsage,
  WindowStats,
} from "./backend/types.js";

export interface NpcAgentOptions {
  bot: Bot;
  botConfig: BotConfig;
}

export class NpcAgent {
  private readonly backend: AgentBackend;

  constructor(private readonly opts: NpcAgentOptions) {
    const { bot, botConfig } = opts;
    switch (botConfig.backend) {
      case "local":
        this.backend = new LocalBackend({ bot, botConfig });
        break;
      case "hybrid":
        this.backend = new HybridBackend({ bot, botConfig });
        break;
      default:
        this.backend = new ClaudeBackend({ bot, botConfig });
    }
  }

  pushChat(event: ChatEvent, decision: RouteMatch): void {
    if (this.backend.isRateLimited()) {
      console.log(
        `[${this.opts.bot.username}] cooldown active (~${this.backend.getCooldownRemainingMinutes()} min); dropping chat from ${event.sender}`,
      );
      return;
    }
    this.backend.pushUserMessage(formatUserMessage(event, decision));
  }

  isRateLimited(): boolean {
    return this.backend.isRateLimited();
  }

  getSessionUsage(): SessionUsage {
    return this.backend.getSessionUsage();
  }

  getLastTurnUsage(): TurnUsage | null {
    return this.backend.getLastTurnUsage();
  }

  getRateLimitInfo(): RateLimitInfo | null {
    return this.backend.getRateLimitInfo();
  }

  getCooldownRemainingMinutes(): number {
    return this.backend.getCooldownRemainingMinutes();
  }

  getLastTurnError(): LastTurnError | null {
    return this.backend.getLastTurnError();
  }

  getWindowStats(): WindowStats {
    return this.backend.getWindowStats();
  }

  async stop(): Promise<void> {
    await this.backend.stop();
  }
}

function formatUserMessage(event: ChatEvent, decision: RouteMatch): string {
  const channelLabel = decision.channel === "whisper" ? "whisper" : "public chat";
  const replyTool = decision.channel === "whisper" ? "whisper" : "say";
  return `[${channelLabel} from ${event.sender}] ${event.message}

(routed because: ${decision.reason}. reply via the ${replyTool} tool on the same channel.)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-bot registry (same pattern as state + chat-router)
// ─────────────────────────────────────────────────────────────────────────────

const agents = new Map<string, NpcAgent>();

export function registerAgent(username: string, agent: NpcAgent): void {
  const existing = agents.get(username);
  if (existing) void existing.stop();
  agents.set(username, agent);
}

export async function unregisterAgent(username: string): Promise<void> {
  const existing = agents.get(username);
  if (!existing) return;
  agents.delete(username);
  await existing.stop();
}

export function getAgent(username: string): NpcAgent | null {
  return agents.get(username) ?? null;
}
