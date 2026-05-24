/**
 * Per-bot Claude Agent SDK loop.
 *
 * Architecture, per spikes/SDK_NOTES.md:
 *  - One long-lived `query()` per bot in streaming-input mode.
 *  - An async queue of SDKUserMessage feeds the SDK; chat events push,
 *    SDK consumes one user turn at a time.
 *  - Conversation lives in SDK process memory; no disk persistence.
 *    Bot reconnect = new agent = conversation reset (intended).
 *  - Tool execution runs inside the SDK MCP server (`skill-tools.ts`),
 *    not in our for-await loop. The loop is for observability (logging
 *    thinking / tool_use), rate-limit handling, and end-of-turn marking.
 *
 * Rate limits (per `SDKRateLimitEvent` with status='rejected', or assistant
 * `error: 'rate_limit'`): whisper warning to the last conversation partner,
 * drop subsequent pushes until cooldown expires. No retry loop — would burn
 * more quota per ARCHITECTURE.md "Resilience".
 */

import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "mineflayer";
import {
  getCurrentConversationPartner,
  type ChatEvent,
  type RouteMatch,
} from "../orchestrator/chat-router.js";
import type { BotConfig } from "../types.js";
import { modelIdFor, RateLimitCooldown } from "./behavior.js";
import { ALLOWED_TOOL_NAMES, MCP_SERVER_NAME, buildSkillsServer } from "./skill-tools.js";
import { buildSystemPrompt } from "./system-prompt.js";

// Max assistant turns the SDK will take per player message before terminating
// with `error_max_turns`. Bumped from the spike-era 8 once we saw real builds
// (gather → craft → place loops) routinely exceed it; the 5-hour rate window
// remains the real safeguard against runaway loops.
const MAX_TURNS_PER_EVENT = 100;
// When per-event turn count crosses this fraction of the cap, the loop emits
// a one-shot warn line so we notice approaching termination before the SDK
// kills the turn silently.
const TURN_WARN_FRACTION = 0.8;
const DEFAULT_COOLDOWN_SECONDS = 5 * 60;
// Pro plan's rolling 5h window. We never assume the bot starts the window at
// 0% — other Claude usage on this account counts too. We only show absolute
// utilization when the SDK reports it via rate_limit_event (which only fires
// at ~80%+ thresholds). Between events, we display the bot's contribution
// and, once we have ≥2 anchors, an extrapolated estimate of current util.
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
// Need a non-trivial utilization delta between two anchors before we trust
// the derived budget — small deltas amplify noise. ~1 percentage point.
const MIN_UTILIZATION_DELTA_FOR_BUDGET = 0.01;

/**
 * Token usage shape we accumulate from `SDKResultSuccess.usage`. Names match
 * the SDK field names (snake_case) for direct mapping.
 */
export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number | null;
}

export interface SessionUsage extends TurnUsage {
  turns: number;
}

/**
 * Whatever the SDK puts on `SDKRateLimitEvent.rate_limit_info`. Retained
 * verbatim so the dashboard can render whichever fields actually populate
 * (per ROADMAP "Pro window precision" risk — utilization/surpassedThreshold
 * may only show up under allowed_warning / rejected).
 */
export type RateLimitInfo = Record<string, unknown>;

/**
 * Most recent non-success terminal result. Retained until a successful turn
 * arrives so the dashboard can surface "last turn errored" without polling
 * the log stream. `error_during_execution` / `error_max_turns` / `error_max_budget_usd`
 * are the SDK's known subtypes; we store whatever string the SDK gives us.
 */
export interface LastTurnError {
  subtype: string;
  at: number;
}

/**
 * One bot-billable sample (input + output tokens per the user's chosen
 * weighting — cache reads excluded). Buffered in a rolling 5h window so we
 * can answer "how much has this bot contributed since the SDK's most recent
 * rate-limit signal".
 */
interface WindowSample {
  at: number;
  billable: number;
}

/**
 * Snapshot of (a) what the SDK told us about Pro-window utilization and
 * (b) the bot's billable-token cumulative count at the same moment. Two
 * anchors let us derive a token-per-utilization budget by linear fit.
 */
interface CalibrationAnchor {
  at: number;
  utilization: number;
  botBillableInWindow: number;
}

/**
 * Window stats surfaced to the dashboard. All bot-only fields are labeled
 * as such — `botBillableLast5h` is *this bot's* contribution to the shared
 * 5h window, not the total. `latestAnchor` and `estimatedCurrentUtilization`
 * are the only fields that speak to the *actual* window state.
 */
export interface WindowStats {
  botBillableLast5h: number;
  latestAnchor: { at: number; utilization: number } | null;
  botBillableSinceLastAnchor: number;
  estimatedBudget: number | null;
  estimatedCurrentUtilization: number | null;
  anchorCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Async queue feeding the SDK's streaming-input prompt.
// Single-producer / single-consumer (the SDK iterates).
// ─────────────────────────────────────────────────────────────────────────────

class UserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private resolver: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ value: msg, done: false });
      return;
    }
    this.pending.push(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const next = this.pending.shift();
        if (next !== undefined) {
          return Promise.resolve({ value: next, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.resolver = resolve;
        });
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NpcAgent — owns one bot's SDK session
// ─────────────────────────────────────────────────────────────────────────────

export interface NpcAgentOptions {
  bot: Bot;
  botConfig: BotConfig;
}

export class NpcAgent {
  private readonly queue = new UserMessageQueue();
  private readonly cooldown = new RateLimitCooldown();
  private session: Query | null = null;
  private stopped = false;

  private sessionUsage: SessionUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0,
    turns: 0,
  };
  private lastTurnUsage: TurnUsage | null = null;
  private latestRateLimitInfo: RateLimitInfo | null = null;
  private lastTurnError: LastTurnError | null = null;
  private turnsThisEvent = 0;
  private warnedThisEvent = false;
  private windowSamples: WindowSample[] = [];
  private anchors: CalibrationAnchor[] = [];

  constructor(private readonly opts: NpcAgentOptions) {
    this.start();
  }

  private start(): void {
    const { bot, botConfig } = this.opts;
    const skillsServer = buildSkillsServer(bot);

    this.session = query({
      prompt: this.queue,
      options: {
        model: modelIdFor(botConfig.model_hint),
        systemPrompt: buildSystemPrompt(bot.username),
        mcpServers: { [MCP_SERVER_NAME]: skillsServer },
        // Disable Claude Code's built-in tools — the NPC's surface is the skill layer only.
        tools: [],
        allowedTools: [...ALLOWED_TOOL_NAMES],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        maxTurns: MAX_TURNS_PER_EVENT,
      },
    });

    this.run().catch((err) => {
      if (!this.stopped) {
        console.error(`[${bot.username}] agent loop crashed:`, err);
      }
    });
  }

  private async run(): Promise<void> {
    if (!this.session) return;
    for await (const msg of this.session) {
      try {
        this.handleMessage(msg);
      } catch (err) {
        console.warn(`[${this.opts.bot.username}] message-handler error:`, err);
      }
    }
  }

  private handleMessage(msg: SDKMessage): void {
    const { bot } = this.opts;
    const tag = `[${bot.username}]`;

    switch (msg.type) {
      case "assistant": {
        this.turnsThisEvent += 1;
        const turnLabel = `[turn ${this.turnsThisEvent}/${MAX_TURNS_PER_EVENT}]`;
        const content = (msg.message?.content ?? []) as Array<{
          type: string;
          text?: string;
          name?: string;
          input?: unknown;
        }>;
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
            console.log(
              `${tag} ${turnLabel} thinking: ${block.text.slice(0, 240).replace(/\s+/g, " ")}`,
            );
          }
          if (block.type === "tool_use") {
            console.log(`${tag} ${turnLabel} → ${shortToolName(block.name)}(${shortJson(block.input)})`);
          }
        }
        if (
          !this.warnedThisEvent &&
          this.turnsThisEvent >= Math.floor(MAX_TURNS_PER_EVENT * TURN_WARN_FRACTION)
        ) {
          this.warnedThisEvent = true;
          console.warn(
            `${tag} approaching max_turns (${this.turnsThisEvent}/${MAX_TURNS_PER_EVENT}); SDK will terminate this event soon`,
          );
        }
        if (msg.error === "rate_limit") {
          this.startCooldown(null);
        }
        return;
      }

      case "rate_limit_event": {
        const info = (msg.rate_limit_info ?? null) as RateLimitInfo | null;
        this.latestRateLimitInfo = info;
        // Log the full payload so we learn which fields actually populate
        // (per ROADMAP "Pro window precision" — utilization may only appear
        // under allowed_warning / rejected).
        console.log(`${tag} rate-limit event: ${JSON.stringify(info)}`);
        const util = info && typeof info.utilization === "number" ? info.utilization : null;
        if (util !== null) {
          this.recordAnchor(util);
        }
        if ((info?.status as string | undefined) === "rejected") {
          const resetsAt = info && typeof info.resetsAt === "number" ? info.resetsAt : null;
          this.startCooldown(resetsAt);
        }
        return;
      }

      case "result": {
        const turnsForEvent = this.turnsThisEvent;
        this.turnsThisEvent = 0;
        this.warnedThisEvent = false;
        if (msg.subtype === "success") {
          const usage = msg.usage as Partial<TurnUsage> | undefined;
          const totalCost = (msg as { total_cost_usd?: number | null }).total_cost_usd ?? null;
          const turn: TurnUsage = {
            input_tokens: usage?.input_tokens ?? 0,
            output_tokens: usage?.output_tokens ?? 0,
            cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
            total_cost_usd: totalCost,
          };
          this.lastTurnUsage = turn;
          this.sessionUsage.input_tokens += turn.input_tokens;
          this.sessionUsage.output_tokens += turn.output_tokens;
          this.sessionUsage.cache_creation_input_tokens += turn.cache_creation_input_tokens;
          this.sessionUsage.cache_read_input_tokens += turn.cache_read_input_tokens;
          if (turn.total_cost_usd !== null && this.sessionUsage.total_cost_usd !== null) {
            this.sessionUsage.total_cost_usd += turn.total_cost_usd;
          }
          this.sessionUsage.turns += 1;
          this.lastTurnError = null;
          const billable = turn.input_tokens + turn.output_tokens;
          this.windowSamples.push({ at: Date.now(), billable });
          this.pruneWindow();
          const costStr = turn.total_cost_usd !== null ? ` $${turn.total_cost_usd.toFixed(4)}` : "";
          console.log(
            `${tag} event complete after ${turnsForEvent} turn(s) — in=${turn.input_tokens} out=${turn.output_tokens} cache_create=${turn.cache_creation_input_tokens} cache_read=${turn.cache_read_input_tokens} billable=${billable}${costStr}`,
          );
        } else {
          this.lastTurnError = { subtype: msg.subtype, at: Date.now() };
          console.warn(`${tag} event ended after ${turnsForEvent} turn(s): ${msg.subtype}`);
        }
        return;
      }

      default:
        return;
    }
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - FIVE_HOURS_MS;
    while (this.windowSamples.length > 0 && this.windowSamples[0]!.at < cutoff) {
      this.windowSamples.shift();
    }
  }

  private sumWindow(): number {
    let total = 0;
    for (const s of this.windowSamples) total += s.billable;
    return total;
  }

  /**
   * Capture an SDK-reported utilization sample. Pairs with the bot's current
   * 5h-rolling billable count so two anchors can derive a tokens-per-util
   * budget. We retain the most recent few anchors; only the two latest feed
   * the budget calc, but keeping a small tail makes future debugging easier.
   */
  private recordAnchor(utilization: number): void {
    this.pruneWindow();
    this.anchors.push({
      at: Date.now(),
      utilization,
      botBillableInWindow: this.sumWindow(),
    });
    while (this.anchors.length > 5) this.anchors.shift();
  }

  private startCooldown(resetsAtUnixSeconds: number | null): void {
    const resetsAt =
      resetsAtUnixSeconds ?? Math.ceil(Date.now() / 1000) + DEFAULT_COOLDOWN_SECONDS;
    this.cooldown.start(resetsAt);
    const mins = this.cooldown.remainingMinutes();
    const partner = getCurrentConversationPartner(this.opts.bot.username);
    console.warn(
      `[${this.opts.bot.username}] rate-limited; cooldown ~${mins} min; notifying ${partner ?? "(no recent partner)"}`,
    );
    if (partner) {
      try {
        this.opts.bot.whisper(partner, `I'm rate-limited, try again in ~${mins} min.`);
      } catch (err) {
        console.warn(`[${this.opts.bot.username}] rate-limit whisper failed:`, err);
      }
    }
  }

  pushChat(event: ChatEvent, decision: RouteMatch): void {
    if (this.stopped) return;
    if (this.cooldown.isActive()) {
      console.log(
        `[${this.opts.bot.username}] cooldown active (~${this.cooldown.remainingMinutes()} min); dropping chat from ${event.sender}`,
      );
      return;
    }
    this.queue.push({
      type: "user",
      message: { role: "user", content: formatUserMessage(event, decision) },
      parent_tool_use_id: null,
    });
  }

  isRateLimited(): boolean {
    return this.cooldown.isActive();
  }

  getSessionUsage(): SessionUsage {
    return { ...this.sessionUsage };
  }

  getLastTurnUsage(): TurnUsage | null {
    return this.lastTurnUsage ? { ...this.lastTurnUsage } : null;
  }

  getRateLimitInfo(): RateLimitInfo | null {
    return this.latestRateLimitInfo ? { ...this.latestRateLimitInfo } : null;
  }

  getCooldownRemainingMinutes(): number {
    return this.cooldown.remainingMinutes();
  }

  getLastTurnError(): LastTurnError | null {
    return this.lastTurnError ? { ...this.lastTurnError } : null;
  }

  /**
   * Snapshot the 5h-window picture for the dashboard. Bot-only totals are
   * always exact; absolute utilization is only available once the SDK has
   * emitted at least one `rate_limit_event` with `utilization` populated.
   * Extrapolated current utilization requires two such anchors with a
   * non-trivial delta (and assumes no other heavy Claude usage between them).
   */
  getWindowStats(): WindowStats {
    this.pruneWindow();
    const botBillableLast5h = this.sumWindow();
    const latest = this.anchors[this.anchors.length - 1] ?? null;

    let botBillableSinceLastAnchor = 0;
    if (latest) {
      botBillableSinceLastAnchor = Math.max(0, botBillableLast5h - latest.botBillableInWindow);
    }

    let estimatedBudget: number | null = null;
    let estimatedCurrentUtilization: number | null = null;
    if (this.anchors.length >= 2) {
      const a = this.anchors[this.anchors.length - 2]!;
      const b = this.anchors[this.anchors.length - 1]!;
      const dUtil = b.utilization - a.utilization;
      const dTokens = b.botBillableInWindow - a.botBillableInWindow;
      if (dUtil >= MIN_UTILIZATION_DELTA_FOR_BUDGET && dTokens > 0) {
        estimatedBudget = dTokens / dUtil;
        estimatedCurrentUtilization = b.utilization + botBillableSinceLastAnchor / estimatedBudget;
      }
    }

    return {
      botBillableLast5h,
      latestAnchor: latest ? { at: latest.at, utilization: latest.utilization } : null,
      botBillableSinceLastAnchor,
      estimatedBudget,
      estimatedCurrentUtilization,
      anchorCount: this.anchors.length,
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.close();
    // Let the SDK session drain naturally. Any in-flight tool call finishes.
  }
}

function formatUserMessage(event: ChatEvent, decision: RouteMatch): string {
  const channelLabel = decision.channel === "whisper" ? "whisper" : "public chat";
  const replyTool = decision.channel === "whisper" ? "whisper" : "say";
  return `[${channelLabel} from ${event.sender}] ${event.message}

(routed because: ${decision.reason}. reply via the ${replyTool} tool on the same channel.)`;
}

/**
 * Strip the MCP server prefix so log lines read `mineBlock(...)` instead of
 * `mcp__minecraft-skills__mineBlock(...)`. The full name still goes through
 * the SDK; this only affects the human-facing log.
 */
function shortToolName(name: string | undefined): string {
  if (!name) return "<unknown>";
  const m = /^mcp__[^_]+(?:__[^_]+)*?__([^_].*)$/.exec(name);
  if (m && m[1]) return m[1];
  // Fallback: strip up to and including the last "__".
  const idx = name.lastIndexOf("__");
  return idx >= 0 ? name.slice(idx + 2) : name;
}

function shortJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return String(value);
  }
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
