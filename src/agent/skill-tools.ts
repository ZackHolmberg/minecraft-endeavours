/**
 * Claude-facing view of the skill layer.
 *
 * The skill definitions (name / description / zod shape / dispatch) now live in
 * the neutral registry (`src/skills/registry.ts`). This module is the thin
 * Claude adapter over that registry: it filters to the `claude` surface (all 36
 * today, preserving the current behavior), builds the per-bot MCP server via
 * `toClaudeMcpServer`, and exposes the fully-qualified allowed-tool names.
 *
 * Two Claude-side wrappers sit between the SDK and `spec.run`:
 *  - **Repeat-failure guard.** Weaker models (Haiku) will happily re-issue the
 *    exact same failing call over and over. Per player message, an identical
 *    call (same tool + same args) that already failed `MAX_IDENTICAL_FAILURES`
 *    times is refused without executing, with a message steering the model to
 *    change approach or tell the player. Once total failures cross
 *    `FAILURE_NUDGE_THRESHOLD`, every further failure carries a "consider
 *    stopping" nudge. The backend resets the guard at each event boundary
 *    (`resetFailureGuard`). Deterministic middleware — no LLM judgment needed
 *    to notice a loop.
 *  - **Follow-up routing + conversation log.** Every successful `say` /
 *    `whisper` opens the chat router's short follow-up window for the player
 *    spoken to, so "thanks" / "now make planks" route back without a name
 *    mention, and is appended to the disk-backed conversation log that each
 *    fresh per-task session reads back.
 *
 * The SDK auto-namespaces these names to `mcp__minecraft-skills__<tool>`;
 * the agent's `allowedTools` list uses that fully-qualified form.
 */

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "mineflayer";
import { recordConversation } from "../memory/conversation-log.js";
import { markReply, recordEvent, summarizeArgs } from "../observability/telemetry.js";
import {
  getCurrentConversationPartner,
  noteBotRepliedTo,
} from "../orchestrator/chat-router.js";
import { SKILL_SPECS, type SkillSpec } from "../skills/registry.js";
import type { SkillResult } from "../skills/types.js";
import { toClaudeMcpServer } from "./backend/adapters.js";

export const MCP_SERVER_NAME = "minecraft-skills";

const CLAUDE_SPECS = SKILL_SPECS.filter((s) => s.surfaces.claude);

/** Identical failing calls allowed per event before the guard refuses them. */
const MAX_IDENTICAL_FAILURES = 2;
/** Total failures per event after which each failure carries a stop-and-report nudge. */
const FAILURE_NUDGE_THRESHOLD = 6;
/** Read-only / conversational skills — never worth refusing. */
const GUARD_EXEMPT = new Set([
  "say",
  "whisper",
  "observeSurroundings",
  "checkInventory",
  "stop",
  "setTaskQueue",
  "advanceTaskQueue",
]);

interface FailureRecord {
  count: number;
  lastMessage: string;
}

class FailureGuard {
  private readonly byCall = new Map<string, FailureRecord>();
  private totalFailures = 0;

  reset(): void {
    this.byCall.clear();
    this.totalFailures = 0;
  }

  /** Non-null when this exact call has already failed too often this event. */
  refusal(name: string, key: string): string | null {
    const rec = this.byCall.get(key);
    if (!rec || rec.count < MAX_IDENTICAL_FAILURES) return null;
    return `not retried: this exact ${name} call already failed ${rec.count} times for this request (last error: ${rec.lastMessage}). Retrying it unchanged won't work — change the target / position / approach, or tell the player what's blocking you.`;
  }

  /** Record the outcome; returns the (possibly nudged) result to hand back. */
  record(key: string, result: SkillResult): SkillResult {
    if (result.ok) {
      this.byCall.delete(key);
      return result;
    }
    const rec = this.byCall.get(key) ?? { count: 0, lastMessage: "" };
    rec.count += 1;
    rec.lastMessage = result.message;
    this.byCall.set(key, rec);
    this.totalFailures += 1;
    if (this.totalFailures < FAILURE_NUDGE_THRESHOLD) return result;
    return {
      ...result,
      message: `${result.message} (${this.totalFailures} failed actions on this request so far — if you aren't making progress, stop and tell the player what's wrong.)`,
    };
  }
}

const guards = new Map<string, FailureGuard>();

function guardFor(botUsername: string): FailureGuard {
  let g = guards.get(botUsername);
  if (!g) {
    g = new FailureGuard();
    guards.set(botUsername, g);
  }
  return g;
}

/** Called by the backend at each event boundary (one player message = one event). */
export function resetFailureGuard(botUsername: string): void {
  guards.get(botUsername)?.reset();
}

/** JSON with sorted object keys, so `{a,b}` and `{b,a}` key identically. */
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  }) ?? "";
}

function wrapSpec(spec: SkillSpec): SkillSpec {
  return {
    ...spec,
    run: async (bot, args) => {
      if (spec.name === "say" || spec.name === "whisper") {
        const result = await spec.run(bot, args);
        if (result.ok) {
          markReply(bot.username);
          const target =
            spec.name === "whisper"
              ? (args as { player?: string } | undefined)?.player
              : getCurrentConversationPartner(bot.username);
          if (target) noteBotRepliedTo(bot.username, target);
          const st = result.state as { sent?: string; duplicate?: boolean } | undefined;
          const sent = st?.duplicate ? undefined : st?.sent;
          if (sent) {
            void recordConversation(bot.username, {
              kind: "bot",
              who: bot.username,
              channel: spec.name === "whisper" ? "whisper" : "chat",
              ...(spec.name === "whisper" && target ? { to: target } : {}),
              text: sent,
            });
          }
        }
        return result;
      }
      if (GUARD_EXEMPT.has(spec.name)) return spec.run(bot, args);

      const guard = guardFor(bot.username);
      const key = `${spec.name}:${stableKey(args)}`;
      const refusal = guard.refusal(spec.name, key);
      if (refusal) {
        console.log(`[${bot.username}] ✗ ${spec.name}: repeat-failure guard refused identical retry`);
        recordEvent(bot.username, { kind: "guard_refusal", tool: spec.name, args: summarizeArgs(args) });
        return { ok: false, message: refusal };
      }
      return guard.record(key, await spec.run(bot, args));
    },
  };
}

/** Fully-qualified allowed-tool names for an arbitrary spec subset. */
export function allowedToolNamesFor(specs: SkillSpec[]): string[] {
  return specs.map((s) => `mcp__${MCP_SERVER_NAME}__${s.name}`);
}

/** Build the per-bot MCP server exposing an arbitrary spec subset. */
export function buildSkillsServerFor(
  bot: Bot,
  specs: SkillSpec[],
): McpSdkServerConfigWithInstance {
  return toClaudeMcpServer(MCP_SERVER_NAME, bot, specs.map(wrapSpec));
}

// Defaults: the full Claude surface (all 36), preserving today's behavior.
export const ALLOWED_TOOL_NAMES: readonly string[] = allowedToolNamesFor(CLAUDE_SPECS);

export function buildSkillsServer(bot: Bot): McpSdkServerConfigWithInstance {
  return buildSkillsServerFor(bot, CLAUDE_SPECS);
}
