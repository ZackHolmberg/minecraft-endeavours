/**
 * Per-bot agent shell.
 *
 * `NpcAgent` owns one `AgentBackend` (the swappable LLM seam) and is otherwise
 * a thin adapter between the chat layer and that backend:
 *  - `pushChat(event, decision)` formats the chat into a user message and hands
 *    it to the backend (dropping it while the backend is rate-limited). A bare
 *    "stop" command while the Claude backend is mid-event halts movement and
 *    interrupts the event first, so the player isn't ignored until a long
 *    build finishes (deterministic middleware, no LLM call needed to stop).
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
import { recordConversation } from "../memory/conversation-log.js";
import {
  isStopCommand,
  type ChatEvent,
  type RouteMatch,
} from "../orchestrator/chat-router.js";
import { runSkill } from "../skills/harness.js";
import { stop } from "../skills/index.js";
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
    // Disk-backed conversation log: the next fresh task session reads it back.
    void recordConversation(this.opts.bot.username, {
      kind: "player",
      who: event.sender,
      channel: event.channel,
      text: event.message,
    });
    const interrupted = this.maybeInterrupt(event);
    this.backend.pushUserMessage(formatUserMessage(event, decision, interrupted));
  }

  /**
   * Player said "stop" while the bot is mid-task: halt movement / cancellable
   * skills right now and abort the in-flight agent event. The stop message is
   * still pushed afterwards so the model acknowledges it. Only the Claude
   * backend supports interruption; others keep the event-hooks side-channel.
   */
  private maybeInterrupt(event: ChatEvent): boolean {
    const { bot } = this.opts;
    if (!(this.backend instanceof ClaudeBackend)) return false;
    if (!this.backend.isBusy() || !isStopCommand(bot.username, event.message)) return false;
    console.log(`[${bot.username}] stop command from ${event.sender} — halting and interrupting current event`);
    void runSkill(bot, "stop", undefined, () => stop(bot));
    void this.backend.interruptCurrentEvent();
    return true;
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

/**
 * Turn a routed chat into the model's user message. Kept short and literal —
 * the system prompt explains the format once. The routing note tells the model
 * *why* it's seeing this, which matters for un-named routes where silence is
 * a valid answer.
 */
function formatUserMessage(event: ChatEvent, decision: RouteMatch, interrupted: boolean): string {
  const header =
    decision.channel === "whisper"
      ? `[whisper from ${event.sender}] ${event.message}`
      : `[public chat] <${event.sender}> ${event.message}`;
  const reply =
    decision.channel === "whisper" ? `reply with whisper to ${event.sender}` : "reply with say";
  const notes: string[] = [];
  switch (decision.reason) {
    case "name-mention":
      notes.push(`they said your name; ${reply}`);
      break;
    case "all-mention":
      notes.push(`sent to @all (every bot); ${reply}`);
      break;
    case "whisper":
      notes.push(reply);
      break;
    case "continuation":
      notes.push(`not named, but you just asked them a question, so this is probably the answer; ${reply}`);
      break;
    case "follow-up":
      notes.push(
        `not named — you were just talking with them. If it's clearly not meant for you, end your turn without calling any tool; otherwise ${reply}`,
      );
      break;
  }
  if (interrupted) {
    notes.push("you were in the middle of a task and it has been stopped — confirm briefly, don't resume unless asked");
  }
  return `${header}\n(${notes.join(". ")}.)`;
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
