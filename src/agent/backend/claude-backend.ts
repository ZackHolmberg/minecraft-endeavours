/**
 * Claude Agent SDK backend — the bot's original "brain", now behind the
 * `AgentBackend` seam.
 *
 * Two session modes (`botConfig.session_mode`, default `per_task`):
 *
 *  - **per_task** — disk is the source of truth; the model keeps as little in
 *    its own context as possible. Each task (one routed player message, or
 *    every message that queued up while the previous task ran, coalesced)
 *    gets a FRESH `query()` whose single user message carries the full
 *    deterministic context (`buildAgentContext`: live state, world.json,
 *    task queue, recent actions, disk-backed recent conversation). When the
 *    task's `result` arrives the session is closed. Messages arriving
 *    mid-task are queued, not pushed into the live session: the old
 *    persistent session would also only have processed them after the
 *    current event, so latency is unchanged, but this way they start with
 *    fresh context and there's no push-after-result race. "stop" is
 *    handled by closing the session outright (`Query.close()`), which is
 *    stronger than `interrupt()`.
 *    Prompt caching survives across sessions because the cache keys on the
 *    byte-stable prefix (system prompt + tool defs), not on the session.
 *  - **persistent** — the original design: one long-lived streaming-input
 *    `query()` per bot, conversation in SDK process memory. Still used by
 *    the hybrid planner (`runTurn`), which overrides `systemPrompt`.
 *
 * Common to both, per spikes/SDK_NOTES.md: an async queue of SDKUserMessage
 * feeds each session; no SDK-side persistence (`persistSession: false`).
 *  - Tool execution runs inside the SDK MCP server (`skill-tools.ts`),
 *    not in our for-await loop. The loop is for observability (logging
 *    thinking / tool_use), rate-limit handling, and end-of-turn marking.
 *
 * Haiku-era loop hygiene (the bot runs on Haiku 5.5; see config/bots.yml):
 *  - Standalone bots get a fresh, deterministic world-context block prepended
 *    to every task message (`buildAgentContext`), so the model plans from
 *    real inventory / surroundings without spending a turn on observation.
 *    It lives in the user message, never the system prompt, so the cached
 *    prefix (system prompt + tool defs) stays byte-stable.
 *  - `MAX_TURNS_PER_EVENT` is a real cap (50), not a formality; hitting it
 *    queues one short follow-up so the player hears where things stand
 *    instead of silence. Identical-failing-call loops are cut earlier by the
 *    repeat-failure guard in `skill-tools.ts`, reset here per event.
 *  - `interruptCurrentEvent()` lets the chat layer abort an in-flight event
 *    when a player says "stop" (`Query.close()` per task, `interrupt()` when
 *    persistent).
 *  - Each finished task appends a deterministic outcome line to the
 *    conversation log, so the next (fresh) session knows how it went.
 *  - Thinking is set explicitly per tier rather than left to SDK defaults.
 *
 * Rate limits (per `SDKRateLimitEvent` with status='rejected', or assistant
 * `error: 'rate_limit'`): whisper warning to the last conversation partner,
 * drop subsequent pushes until cooldown expires. No retry loop — would burn
 * more quota per ARCHITECTURE.md "Resilience".
 */

import { coalesceMessages, isDirectAddress } from "../coalesce.js";
import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "mineflayer";
import { recordConversation } from "../../memory/conversation-log.js";
import {
  beginTask,
  clip,
  endTask,
  hasReplied,
  recordEvent,
  takeRoutedChat,
  type RoutedChatMeta,
} from "../../observability/telemetry.js";
import type { TaskOutcome } from "../../observability/telemetry-types.js";
import { getCurrentConversationPartner } from "../../orchestrator/chat-router.js";
import { getBotState } from "../../state/index.js";
import { buildAgentContext } from "../planning-context.js";
import type { SkillSpec } from "../../skills/registry.js";
import type { BotConfig, ModelHint, SessionMode } from "../../types.js";
import { modelIdFor, RateLimitCooldown } from "../behavior.js";
import {
  ALLOWED_TOOL_NAMES,
  MCP_SERVER_NAME,
  allowedToolNamesFor,
  buildSkillsServer,
  buildSkillsServerFor,
  resetFailureGuard,
} from "../skill-tools.js";
import { getJobRunner } from "../../jobs/registry.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { MAX_TURNS_PER_EVENT } from "../limits.js";
import type {
  AgentBackend,
  LastTurnError,
  RateLimitInfo,
  SessionUsage,
  TurnUsage,
  WindowStats,
} from "./types.js";

// Thinking depth for Haiku 5.5. It only accepts adaptive thinking (a fixed
// `budgetTokens` is a 400), so effort is the lever. `medium` is the API
// default, set explicitly so it's visible and tunable: enough to sequence
// gather → craft → place and compute placeBlocks coordinates; drop to `low`
// if first-reply latency in botReport.sh runs high.
const HAIKU_EFFORT = "medium" as const;
// Upper bound on building the per-message world context. If the bot is mid-
// reconnect or the block scan stalls, send the chat without context rather
// than holding the queue.
const CONTEXT_TIMEOUT_MS = 2_000;
// per_task: after a forced close (player stop), the abandoned tool call may
// still be running in-process. Wait this long for it to wind down before the
// next task's skills start driving the bot, so two skills never fight. Sized
// to outlast the slowest step that doesn't poll the stop flag (a 30s dig);
// the stop flag is re-asserted while waiting so the next task's
// `cancellation.begin()` can't race it.
const TOOL_IDLE_WAIT_MS = 35_000;
const TOOL_IDLE_POLL_MS = 200;
const MAX_LABEL_CHARS = 120;
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
// ClaudeBackend — owns one bot's SDK session
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaudeBackendOptions {
  bot: Bot;
  botConfig: BotConfig;
  /**
   * Overrides for composed use (the hybrid planner). When omitted, the backend
   * reproduces the standalone Claude bot exactly: full system prompt, all 36
   * tools, and the bot's configured model tier.
   */
  systemPrompt?: string;
  specs?: SkillSpec[];
  modelHint?: ModelHint;
  /**
   * Prepend a fresh world-context block to every task message. Defaults to
   * true for the standalone bot and false when `systemPrompt` is overridden
   * (the hybrid planner injects its own context).
   */
  injectWorldContext?: boolean;
  /**
   * Session scoping. Defaults to `botConfig.session_mode` for the standalone
   * bot and to `persistent` when `systemPrompt` is overridden (hybrid planner).
   */
  sessionMode?: SessionMode;
}

/** Telemetry-only: when a queued message arrived and which chat routed it. */
interface PendingMeta {
  at: number;
  chat: RoutedChatMeta | null;
}

/** Telemetry-only: one queued/running event, FIFO-aligned with `eventLabels`. */
interface TelemetryTask {
  request: string;
  metas: PendingMeta[];
  coalesced: number;
  contextBuildMs: number | null;
  contextChars: number | null;
  contextInjected: boolean;
  taskId: string | null;
  startedAt: number;
  rateLimited: boolean;
}

/** How an event ended, for its task_end telemetry. */
interface TaskEndInfo {
  outcome: TaskOutcome;
  subtype: string;
  numTurns: number | null;
  usage: TurnUsage | null;
}

/** One SDK `query()` plus the input queue feeding it. */
interface ActiveSession {
  query: Query;
  input: UserMessageQueue;
  /** A `result` arrived for this session's (per_task) message. */
  resulted: boolean;
  /** We closed it on purpose (task done, player stop, or shutdown). */
  closedByUs: boolean;
  /** Closed because a player said stop. */
  interrupted: boolean;
  /** The task answers a direct address (name mention, whisper, @all) or a job event: silence is a bug. */
  direct?: boolean;
}

export class ClaudeBackend implements AgentBackend {
  private readonly cooldown = new RateLimitCooldown();
  private readonly mode: SessionMode;
  /** persistent mode: the one long-lived session. */
  private persistent: ActiveSession | null = null;
  /** per_task mode: the running task's session, if any. */
  private task: ActiveSession | null = null;
  private taskStarting = false;
  /** A stop arrived while the next task was being prepared: don't open it. */
  private startAborted = false;
  /** per_task mode: messages waiting for the next task. */
  private pending: string[] = [];
  /** Telemetry-only, index-aligned with `pending`. */
  private pendingMeta: PendingMeta[] = [];
  /** Telemetry-only, index-aligned with `eventLabels`. */
  private telemetryTasks: TelemetryTask[] = [];
  /**
   * The SDK emits one assistant message per content block (thinking, text,
   * each tool_use) sharing the API message id; count a turn once per id so a
   * thinking-only block doesn't inflate the count.
   */
  private lastAssistantMessageId: string | null = null;
  /** Labels of in-flight events, FIFO, for outcome lines in the conversation log. */
  private eventLabels: string[] = [];
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
  // Haiku 5.5 runs safety classifiers with no server-side fallback; a refused
  // task would otherwise end silently.
  private refusedThisEvent = false;
  // Messages handed to the SDK whose `result` hasn't arrived yet.
  private eventsInFlight = 0;
  private interruptRequested = false;
  // True while the max-turns status follow-up is queued, so it can't recurse.
  private followUpQueued = false;
  // Serializes async context-building so messages keep their arrival order.
  private pushChain: Promise<void> = Promise.resolve();
  private windowSamples: WindowSample[] = [];
  private anchors: CalibrationAnchor[] = [];
  // Resolver for the in-flight `runTurn` (hybrid coordinator use). The
  // coordinator drives one turn at a time and awaits it, so at most one is
  // outstanding. Resolved when the event's `result` arrives, or on cooldown.
  private pendingTurn: (() => void) | null = null;

  constructor(private readonly opts: ClaudeBackendOptions) {
    this.mode =
      opts.sessionMode ??
      (opts.systemPrompt !== undefined ? "persistent" : opts.botConfig.session_mode);
    console.log(`[${opts.bot.username}] claude backend session mode: ${this.mode}`);
    if (this.mode === "persistent") this.persistent = this.openSession();
  }

  /**
   * Start one SDK session. The MCP server is rebuilt per session — an MCP
   * server instance binds to one transport, and it's cheap (in-process).
   */
  private openSession(): ActiveSession {
    const { bot, botConfig, systemPrompt, specs, modelHint } = this.opts;
    const skillsServer = specs ? buildSkillsServerFor(bot, specs) : buildSkillsServer(bot);
    const allowedTools = specs ? allowedToolNamesFor(specs) : [...ALLOWED_TOOL_NAMES];
    const input = new UserMessageQueue();

    const hint = modelHint ?? botConfig.model_hint;
    const q = query({
      prompt: input,
      options: {
        model: modelIdFor(hint),
        // Haiku 5.5: adaptive thinking steered by effort. No fallbackModel on
        // purpose — the bot runs on Haiku only, so a safety refusal is reported
        // to the player (see the "assistant" case) rather than retried elsewhere.
        ...(hint === "haiku" ? { thinking: { type: "adaptive" as const }, effort: HAIKU_EFFORT } : {}),
        systemPrompt: systemPrompt ?? buildSystemPrompt(bot.username),
        mcpServers: { [MCP_SERVER_NAME]: skillsServer },
        // Disable Claude Code's built-in tools — the NPC's surface is the skill layer only.
        tools: [],
        allowedTools,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        maxTurns: MAX_TURNS_PER_EVENT,
      },
    });

    const active: ActiveSession = {
      query: q,
      input,
      resulted: false,
      closedByUs: false,
      interrupted: false,
    };
    void this.runSession(active);
    return active;
  }

  private async runSession(active: ActiveSession): Promise<void> {
    const { bot } = this.opts;
    try {
      for await (const msg of active.query) {
        try {
          this.handleMessage(msg, active);
        } catch (err) {
          console.warn(`[${bot.username}] message-handler error:`, err);
        }
      }
    } catch (err) {
      if (!this.stopped && !active.closedByUs) {
        console.error(`[${bot.username}] agent loop crashed:`, err);
      }
    } finally {
      this.onSessionEnded(active);
    }
  }

  /**
   * A session's message stream ended. per_task: if it ended without a result
   * (player stop or crash), close out the task's bookkeeping here; then start
   * the next queued task. persistent: the bot's only session is gone.
   */
  private onSessionEnded(active: ActiveSession): void {
    if (this.mode === "persistent") {
      // Never leave the hybrid coordinator awaiting a turn on a dead session.
      this.resolvePendingTurn();
      return;
    }
    if (this.task !== active) return;
    this.task = null;
    if (!active.resulted && !this.stopped) {
      const status = active.interrupted ? "stopped by player" : "ended unexpectedly";
      if (!active.interrupted) {
        this.lastTurnError = { subtype: "session_ended_without_result", at: Date.now() };
      }
      console.log(
        `[${this.opts.bot.username}] task ${status} after ${this.turnsThisEvent} turn(s)`,
      );
      this.finishEvent(status, {
        outcome: active.interrupted ? "stopped" : "failed",
        subtype: active.interrupted ? "closed_by_player_stop" : "session_ended_without_result",
        numTurns: null,
        usage: null,
      });
    }
    void this.maybeStartTask();
  }

  /** Per-event bookkeeping shared by every way an event can end. */
  private finishEvent(status: string, end: TaskEndInfo): number {
    const turns = this.turnsThisEvent;
    this.turnsThisEvent = 0;
    this.lastAssistantMessageId = null;
    this.warnedThisEvent = false;
    if (this.refusedThisEvent) {
      this.refusedThisEvent = false;
      status = "declined by the model's safety check";
    }
    this.endTelemetryTask(turns, end);
    resetFailureGuard(this.opts.bot.username);
    const label = this.eventLabels.shift();
    if (label) {
      void recordConversation(this.opts.bot.username, {
        kind: "outcome",
        text: `${label} → ${status} (${turns} step${turns === 1 ? "" : "s"})`,
      });
    }
    this.resolvePendingTurn();
    return turns;
  }

  private handleMessage(msg: SDKMessage, active: ActiveSession): void {
    const { bot } = this.opts;
    const tag = `[${bot.username}]`;

    switch (msg.type) {
      case "assistant": {
        const messageId = (msg.message as { id?: string } | undefined)?.id ?? null;
        if (messageId === null || messageId !== this.lastAssistantMessageId) {
          this.turnsThisEvent += 1;
        }
        this.lastAssistantMessageId = messageId;
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
          this.recordRateLimit("assistant_error", null);
          this.startCooldown(null);
        }
        const apiMessage = msg.message as
          | { stop_reason?: string | null; stop_details?: { category?: string | null } | null }
          | undefined;
        if (apiMessage?.stop_reason === "refusal" && !this.refusedThisEvent) {
          this.refusedThisEvent = true;
          console.warn(`${tag} ${turnLabel} model declined (refusal, category=${apiMessage.stop_details?.category ?? "none"})`);
          this.notifyRefusal();
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
        const rlStatus = typeof info?.status === "string" ? info.status : "unknown";
        if (rlStatus !== "allowed") {
          const resetsAtSec = info && typeof info.resetsAt === "number" ? info.resetsAt : null;
          this.recordRateLimit(rlStatus, resetsAtSec);
        }
        if ((info?.status as string | undefined) === "rejected") {
          const resetsAt = info && typeof info.resetsAt === "number" ? info.resetsAt : null;
          this.startCooldown(resetsAt);
        }
        return;
      }

      case "result": {
        const turnsForEvent = this.turnsThisEvent;
        this.eventsInFlight = Math.max(0, this.eventsInFlight - 1);
        active.resulted = true;
        const wasInterrupted = this.interruptRequested;
        this.interruptRequested = false;
        const wasFollowUp = this.followUpQueued;
        this.followUpQueued = false;
        // v2: Haiku plans in plain text (invisible) and ends the turn without say. One nudge, never a loop.
        const silent = active.direct === true && !wasFollowUp && !wasInterrupted && msg.subtype === "success" && !hasReplied(this.opts.bot.username);
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
        } else if (wasInterrupted) {
          // We asked for this (player said "stop"); not an error worth a red banner.
          console.log(`${tag} event interrupted after ${turnsForEvent} turn(s) (player stop)`);
        } else {
          this.lastTurnError = { subtype: msg.subtype, at: Date.now() };
          console.warn(`${tag} event ended after ${turnsForEvent} turn(s): ${msg.subtype}`);
        }
        this.finishEvent(
          msg.subtype === "success"
            ? "finished"
            : wasInterrupted
              ? "stopped by player"
              : msg.subtype === "error_max_turns"
                ? "cut off at the step limit"
                : `failed (${msg.subtype})`,
          {
            outcome:
              msg.subtype === "success"
                ? "finished"
                : wasInterrupted
                  ? "stopped"
                  : msg.subtype === "error_max_turns"
                    ? "max_turns"
                    : "failed",
            subtype: msg.subtype,
            numTurns: typeof (msg as { num_turns?: unknown }).num_turns === "number"
              ? (msg as { num_turns: number }).num_turns
              : null,
            usage: usageOf(msg),
          },
        );
        if (msg.subtype === "error_max_turns" && !wasInterrupted && !wasFollowUp) {
          this.queueMaxTurnsFollowUp();
        } else if (silent) {
          this.queueSilentFollowUp();
        }
        if (this.mode === "per_task") {
          // Task done: tear the session down; onSessionEnded starts the next one.
          active.closedByUs = true;
          active.input.close();
          active.query.close();
        }
        return;
      }

      default:
        return;
    }
  }

  /**
   * After a max-turns cutoff the player would otherwise hear nothing. Queue one
   * short orchestrator note asking the model to report and offer to continue.
   */
  private queueMaxTurnsFollowUp(): void {
    if (this.stopped || this.cooldown.isActive()) return;
    const partner = getCurrentConversationPartner(this.opts.bot.username);
    const how = partner ? `say (or whisper to ${partner} if they whispered you)` : "say";
    this.followUpQueued = true;
    this.pushUserMessage(
      `[orchestrator note — not a player message] You ran out of steps on the last request and were cut off mid-task. Using only ${how}, tell the player in one short line what you got done and what's left, and ask if they want you to keep going. Don't call any other tool this turn.`,
    );
  }

  /** The model ended a directly-addressed task without calling say/whisper: ask once for the reply. */
  private queueSilentFollowUp(): void {
    if (this.stopped || this.cooldown.isActive()) return;
    const partner = getCurrentConversationPartner(this.opts.bot.username);
    const how = partner ? `say (or whisper to ${partner} if they whispered you)` : "say";
    console.log(`[${this.opts.bot.username}] task ended without say/whisper; nudging once`);
    this.followUpQueued = true;
    this.pushUserMessage(
      `[orchestrator note — not a player message] Nobody heard anything from you on the last message: plain text is invisible, only the say/whisper tools reach players. Using only ${how}, answer them now in one short line (what you're doing, or your proposal/question). Don't call any other tool this turn.`,
    );
  }

  /** True while an event is running (or, per_task, about to start). */
  isBusy(): boolean {
    if (this.mode === "per_task") return this.task !== null || this.taskStarting;
    return this.eventsInFlight > 0;
  }

  /**
   * Abort the in-flight event (player said "stop"). Queued messages —
   * including the stop message itself — are processed next.
   *  - per_task: close the task's session outright (synchronous, can't be
   *    ignored by a model mid-loop); `onSessionEnded` finishes bookkeeping.
   *  - persistent: SDK `interrupt()`; the session survives.
   * Returns false when idle or when the SDK rejects the interrupt.
   */
  async interruptCurrentEvent(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.mode === "per_task") {
      const active = this.task;
      if (!active) {
        // Mid-start (waiting for the old tool / building context): the batch
        // is already spliced out of `pending`, so without this the stop would
        // only be seen after that whole task ran.
        if (this.taskStarting) {
          this.startAborted = true;
          return true;
        }
        return false;
      }
      active.interrupted = true;
      active.closedByUs = true;
      active.input.close();
      active.query.close();
      console.log(`[${this.opts.bot.username}] closed in-flight task session (player stop)`);
      return true;
    }
    const session = this.persistent?.query;
    if (!session || this.eventsInFlight === 0) return false;
    this.interruptRequested = true;
    try {
      await session.interrupt();
      console.log(`[${this.opts.bot.username}] interrupted in-flight event`);
      return true;
    } catch (err) {
      this.interruptRequested = false;
      console.warn(`[${this.opts.bot.username}] interrupt failed:`, err);
      return false;
    }
  }

  private resolvePendingTurn(): void {
    if (this.pendingTurn) {
      const resolve = this.pendingTurn;
      this.pendingTurn = null;
      resolve();
    }
  }

  /**
   * Push one message and resolve when its event completes (a `result` message,
   * or a rate-limit cooldown). For the hybrid coordinator, which needs to await
   * a planning turn before inspecting the task queue. Not part of `AgentBackend`
   * — standalone use stays fire-and-forget via `pushUserMessage`.
   */
  runTurn(content: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingTurn = resolve;
      this.pushUserMessage(content);
    });
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

  /** Tell the conversation partner the request was declined, so the bot doesn't just go quiet. */
  private notifyRefusal(): void {
    const partner = getCurrentConversationPartner(this.opts.bot.username);
    if (!partner) return;
    try {
      this.opts.bot.whisper(partner, "sorry, I can't help with that one — try asking another way?");
    } catch (err) {
      console.warn(`[${this.opts.bot.username}] refusal whisper failed:`, err);
    }
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
        this.opts.bot.whisper(partner, `gotta take a break, I'm rate-limited — try me again in ~${mins} min`);
      } catch (err) {
        console.warn(`[${this.opts.bot.username}] rate-limit whisper failed:`, err);
      }
    }
    // Don't leave the hybrid coordinator awaiting a turn that won't complete.
    this.resolvePendingTurn();
  }

  pushUserMessage(content: string): void {
    if (this.stopped) return;
    if (this.mode === "per_task") {
      this.pending.push(content);
      this.pendingMeta.push({ at: Date.now(), chat: takeRoutedChat(this.opts.bot.username) });
      void this.maybeStartTask();
      return;
    }
    const meta: PendingMeta = { at: Date.now(), chat: takeRoutedChat(this.opts.bot.username) };
    this.pushChain = this.pushChain.then(async () => {
      const ctxStart = Date.now();
      const injected = this.injectsContext();
      const context = injected ? await this.worldContext() : null;
      const ctxMs = context !== null ? Date.now() - ctxStart : null;
      const session = this.persistent;
      if (this.stopped || !session) return;
      this.eventsInFlight += 1;
      this.eventLabels.push(labelFor([content]));
      this.queueTelemetryTask([content], [meta], ctxMs, context, injected);
      session.input.push(userMessage(context ? `${context}\n\n${content}` : content));
    });
  }

  private injectsContext(): boolean {
    return this.opts.injectWorldContext ?? this.opts.systemPrompt === undefined;
  }

  /**
   * per_task: if idle and messages are waiting, start a fresh session for all
   * of them (coalesced into one task). Context is built at start time, so it
   * reflects whatever the previous task left behind on disk.
   */
  private async maybeStartTask(): Promise<void> {
    if (this.mode !== "per_task" || this.stopped) return;
    if (this.task || this.taskStarting || this.pending.length === 0) return;
    if (this.cooldown.isActive()) {
      console.log(
        `[${this.opts.bot.username}] cooldown active; dropping ${this.pending.length} queued message(s)`,
      );
      this.pending = [];
      this.pendingMeta = [];
      return;
    }
    this.taskStarting = true;
    this.startAborted = false;
    let aborted = false;
    try {
      await this.waitForToolIdle();
      const batch = this.pending.splice(0);
      const metas = this.pendingMeta.splice(0);
      const ctxStart = Date.now();
      const injected = this.injectsContext();
      const context = injected ? await this.worldContext() : null;
      const ctxMs = context !== null ? Date.now() - ctxStart : null;
      if (this.stopped) return;
      if (this.startAborted) {
        console.log(
          `[${this.opts.bot.username}] stop arrived while starting a task; dropping ${batch.length} superseded message(s)`,
        );
        // The stop message is pushed right after the interrupt: it's either
        // already in `pending` or (if it beat the splice) the batch's last.
        if (this.pending.length === 0 && batch.length > 0) {
          this.pending.push(batch[batch.length - 1]!);
          this.pendingMeta.push(metas[metas.length - 1] ?? { at: Date.now(), chat: null });
        }
        aborted = true;
        return;
      }
      const body = coalesceMessages(batch);
      const active = this.openSession();
      this.eventLabels.push(labelFor(batch));
      this.queueTelemetryTask(batch, metas, ctxMs, context, injected);
      active.direct = batch.some(isDirectAddress);
      this.task = active;
      active.input.push(userMessage(context ? `${context}\n\n${body}` : body));
    } catch (err) {
      // Called fire-and-forget; a throw here (e.g. query() failing to spawn)
      // would otherwise be an unhandled rejection and kill the orchestrator.
      console.error(`[${this.opts.bot.username}] failed to start task:`, err);
    } finally {
      this.taskStarting = false;
      this.startAborted = false;
      // (inside finally: the abort path leaves the try via `return`)
      if (aborted) void this.maybeStartTask();
    }
  }

  /** Wait (bounded) until no skill is executing in-process. */
  private async waitForToolIdle(): Promise<void> {
    const state = getBotState(this.opts.bot.username);
    if (!state) return;
    // v2: a running job's steps own the current-tool slot. A new task must not
    // wait on them or flip the stop flag; its own non-read-only tool calls
    // cancel the job first (skill-tools.ts), and a player "stop" cancels it
    // before the message even reaches the queue (npc-agent.ts).
    if (getJobRunner(this.opts.bot.username)?.isRunning()) return;
    const deadline = Date.now() + TOOL_IDLE_WAIT_MS;
    while (state.currentTool.current() && Date.now() < deadline) {
      state.cancellation.request();
      await new Promise((r) => setTimeout(r, TOOL_IDLE_POLL_MS));
    }
    const still = state.currentTool.current();
    if (still) {
      console.warn(
        `[${this.opts.bot.username}] starting next task while ${still.name} is still winding down`,
      );
    }
  }

  /** Fresh deterministic world snapshot, or null if it fails / takes too long. */
  private async worldContext(): Promise<string | null> {
    const { bot } = this.opts;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        buildAgentContext(bot),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), CONTEXT_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      console.warn(`[${bot.username}] world-context build failed:`, err);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Telemetry (observe-only; every path swallows its own errors) ─────────

  /** Queue an event's telemetry (aligned with `eventLabels`); starts it if it's at the head. */
  private queueTelemetryTask(
    contents: string[],
    metas: PendingMeta[],
    contextBuildMs: number | null,
    context: string | null,
    injected: boolean,
  ): void {
    try {
      this.telemetryTasks.push({
        request: clip(labelFor(contents)),
        metas,
        coalesced: contents.length,
        contextBuildMs,
        contextChars: context !== null ? context.length : null,
        contextInjected: injected,
        taskId: null,
        startedAt: 0,
        rateLimited: false,
      });
      if (this.telemetryTasks.length === 1) this.startTelemetryTask(this.telemetryTasks[0]!);
    } catch {
      // ignore
    }
  }

  private startTelemetryTask(t: TelemetryTask): void {
    const bot = this.opts.bot.username;
    const now = Date.now();
    t.startedAt = now;
    t.taskId = beginTask(bot, now);
    const chats = t.metas.map((m) => m.chat).filter((c): c is RoutedChatMeta => c !== null);
    const latest = chats[chats.length - 1] ?? null;
    const arrived = t.metas.length > 0 ? Math.min(...t.metas.map((m) => m.chat?.at ?? m.at)) : now;
    recordEvent(bot, {
      kind: "task_start",
      request: t.request,
      player: latest?.player ?? null,
      route:
        latest?.route ??
        (t.request.startsWith("(status report)")
          ? "orchestrator-note"
          : t.request.startsWith("[job ")
            ? "job-event"
            : "unknown"),
      sessionMode: this.mode,
      coalesced: t.coalesced,
      queueWaitMs: Math.max(0, now - arrived),
      contextBuildMs: t.contextBuildMs,
      contextChars: t.contextChars,
      ...(t.contextInjected ? {} : { contextInjected: false }),
    });
  }

  /** Close the head event's telemetry and start the next queued one (persistent mode). */
  private endTelemetryTask(fallbackTurns: number, end: TaskEndInfo): void {
    try {
      const t = this.telemetryTasks.shift();
      if (!t || !t.taskId) return;
      const bot = this.opts.bot.username;
      const counters = endTask(bot, t.taskId);
      const u = end.usage;
      recordEvent(bot, {
        kind: "task_end",
        taskId: t.taskId,
        outcome: t.rateLimited && end.outcome !== "finished" && end.outcome !== "stopped" ? "rate_limited" : end.outcome,
        subtype: end.subtype,
        turns: end.numTurns ?? fallbackTurns,
        durationMs: Date.now() - t.startedAt,
        firstReplyMs: counters?.firstReplyMs ?? null,
        toolCalls: counters?.toolCalls ?? 0,
        toolFailures: counters?.toolFailures ?? 0,
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        cacheCreateTokens: u?.cache_creation_input_tokens ?? 0,
        costUsd: u?.total_cost_usd ?? null,
      });
      const next = this.telemetryTasks[0];
      if (next && !this.stopped) this.startTelemetryTask(next);
    } catch {
      // ignore
    }
  }

  private recordRateLimit(status: string, resetsAtUnixSeconds: number | null): void {
    const head = this.telemetryTasks[0];
    if (head) head.rateLimited = true;
    recordEvent(this.opts.bot.username, {
      kind: "rate_limit",
      status,
      resetsAt: resetsAtUnixSeconds !== null ? resetsAtUnixSeconds * 1000 : null,
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
    // In-flight events won't reach finishEvent once stopped; close their telemetry.
    while (this.telemetryTasks.length > 0) {
      this.endTelemetryTask(this.turnsThisEvent, {
        outcome: "stopped",
        subtype: "backend_stopped",
        numTurns: null,
        usage: null,
      });
      this.turnsThisEvent = 0;
    }
    this.pending = [];
    this.pendingMeta = [];
    this.resolvePendingTurn();
    // persistent: let the SDK session drain naturally. per_task: the task's
    // session would otherwise keep driving a bot that is being torn down.
    this.persistent?.input.close();
    const task = this.task;
    if (task) {
      task.closedByUs = true;
      task.input.close();
      task.query.close();
    }
  }
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

/** Token usage off any `result` message (success or error), for telemetry. */
function usageOf(msg: SDKMessage): TurnUsage | null {
  const m = msg as { usage?: Partial<TurnUsage>; total_cost_usd?: number | null };
  if (!m.usage) return null;
  return {
    input_tokens: m.usage.input_tokens ?? 0,
    output_tokens: m.usage.output_tokens ?? 0,
    cache_creation_input_tokens: m.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: m.usage.cache_read_input_tokens ?? 0,
    total_cost_usd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
  };
}

function userMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

/**
 * Short human-readable label for an event, used in its outcome line: the chat
 * line(s) without the routing note, e.g. `[public chat] <Alex> get wood`.
 */
function labelFor(contents: string[]): string {
  const label = contents
    .map((c) =>
      c.startsWith("[orchestrator note") ? "(status report)" : (c.split("\n")[0] ?? "").trim(),
    )
    .join(" + ");
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

function shortJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return String(value);
  }
}
