/**
 * Local model backend — a hand-rolled tool-calling loop against a
 * `mlx_lm.server` (OpenAI-compatible) endpoint, behind the same `AgentBackend`
 * seam as the Claude path. Validated in `spikes/mlx-exec-spike.ts`.
 *
 * Shape (per spikes/MLX_NOTES.md):
 *  - Curated executor tool surface (~16 tools) — the full 35 OOM'd the GPU.
 *  - `/no_think` is mandatory (system prompt + per-message suffix): thinking
 *    mode is ~30s/turn vs ~1.8s.
 *  - Per user message: loop `chat -> parse tool_calls -> validate -> run ->
 *    append results -> repeat` until no tool_calls or a step cap.
 *  - Tool-call ids come back `null`; we synthesize stable ids and echo them
 *    onto the assistant turn so `tool_call_id` on the results stays consistent.
 *  - `<think>...</think>` and chat-template special tokens can leak into text;
 *    strip both before logging.
 *  - The Metal-OOM abort kills the server process (recoverable). On any fetch
 *    failure we surface a `lastTurnError` + short "backend unavailable" cooldown
 *    (dropping new chats) rather than crashing the loop — the model server is
 *    supervised/restarted out-of-band by scripts/llmStart.sh.
 *
 * Dashboard contract: token counts are real (from the server's `usage`);
 * cost / rate-limit / 5h-window are null/empty (no Pro plan involved), so the
 * dashboard renders without edits.
 */

import type { Bot } from "mineflayer";
import { z } from "zod";
import { getBotState } from "../../state/index.js";
import type { BotConfig, LocalModelConfig } from "../../types.js";
import { SKILL_SPECS, type SkillSpec } from "../../skills/registry.js";
import { buildLocalSystemPrompt } from "../system-prompt.js";
import { RateLimitCooldown } from "../behavior.js";
import { toOpenAITools, type OpenAITool } from "./adapters.js";
import type {
  AgentBackend,
  LastTurnError,
  RateLimitInfo,
  SessionUsage,
  TurnUsage,
  WindowStats,
} from "./types.js";

// Max tool-calling steps the loop will take per player message before giving
// up. A step is one server round-trip (which may carry several tool_calls).
const MAX_STEPS_PER_MESSAGE = 24;
// Keep the running transcript bounded so context (and prompt-processing cost)
// doesn't grow without limit across a long session. System message is always
// retained; the most recent N non-system messages are kept.
const MAX_TRANSCRIPT_MESSAGES = 60;
// Per-request wall-clock ceiling. Cold prompt-processing on 14B can take tens
// of seconds; a hung server should abort rather than wedge the loop forever.
const REQUEST_TIMEOUT_MS = 120_000;
// When the server is unreachable (ECONNREFUSED / Metal-OOM abort), drop new
// chats for this long so we don't hammer a dead endpoint. The supervisor
// restarts the server in the background.
const BACKEND_UNAVAILABLE_COOLDOWN_SECONDS = 30;
const DEFAULT_TEMPERATURE = 0.3;
const MAX_TOKENS_PER_STEP = 1024;
// Cap any single tool result fed into the transcript. observeSurroundings can
// return ~4k tokens of JSON, which balloons cold prompt-processing time and GPU
// memory; the (hybrid) executor gets a compact context up front, so a truncated
// observe is an acceptable fallback.
const MAX_TOOL_RESULT_CHARS = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI chat wire shapes (only the fields we touch).
// ─────────────────────────────────────────────────────────────────────────────

interface ChatToolCall {
  id?: string | null;
  type?: string;
  function?: { name?: string; arguments?: string };
}
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}
interface ChatResponseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}
interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: ChatToolCall[] } }>;
  usage?: ChatResponseUsage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Curated executor surface, precomputed once (bot-independent).
// ─────────────────────────────────────────────────────────────────────────────

const EXECUTOR_SPECS: SkillSpec[] = SKILL_SPECS.filter((s) => s.surfaces.executor);
const EXECUTOR_TOOLS: OpenAITool[] = toOpenAITools(EXECUTOR_SPECS);
const EXECUTOR_BY_NAME: ReadonlyMap<string, { spec: SkillSpec; validator: z.ZodTypeAny }> = new Map(
  EXECUTOR_SPECS.map((s) => [s.name, { spec: s, validator: z.object(s.schema) }]),
);

export interface LocalBackendOptions {
  bot: Bot;
  botConfig: BotConfig;
  /**
   * Connection to use instead of `botConfig.local`. The hybrid backend passes
   * its executor sub-config here (its own `botConfig.backend` is "hybrid", not
   * "local", so `botConfig.local` is unset).
   */
  local?: LocalModelConfig;
  /** System prompt override (the hybrid executor prompt). Defaults to the standalone agent prompt. */
  systemPrompt?: string;
  /**
   * Max tool-calling steps per turn. The hybrid coordinator passes a small
   * value so it checkpoints progress frequently (and can catch a runaway
   * before it does too much); standalone use keeps the larger default.
   */
  maxSteps?: number;
}

/** Outcome of one executor turn, for the hybrid coordinator. */
export interface ExecutorOutcome {
  /** The model server couldn't be reached (ECONNREFUSED / Metal-OOM abort). */
  serverUnreachable: boolean;
  /** Tool-calling steps taken this turn. */
  steps: number;
}

export class LocalBackend implements AgentBackend {
  private readonly local: LocalModelConfig;
  private readonly maxSteps: number;
  private readonly cooldown = new RateLimitCooldown();
  private readonly transcript: ChatMessage[];
  private readonly pending: string[] = [];
  private draining = false;
  private stopped = false;

  private sessionUsage: SessionUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: null,
    turns: 0,
  };
  private lastTurnUsage: TurnUsage | null = null;
  private lastTurnError: LastTurnError | null = null;

  constructor(private readonly opts: LocalBackendOptions) {
    const local = opts.local ?? opts.botConfig.local;
    if (!local) {
      throw new Error(
        `[${opts.bot.username}] LocalBackend requires a local model config — check config parsing`,
      );
    }
    this.local = local;
    this.maxSteps = opts.maxSteps ?? MAX_STEPS_PER_MESSAGE;
    const systemPrompt = opts.systemPrompt ?? buildLocalSystemPrompt(opts.bot.username);
    this.transcript = [{ role: "system", content: systemPrompt }];
    console.log(
      `[${opts.bot.username}] local backend → ${this.local.baseUrl} (${this.local.model}), ${EXECUTOR_TOOLS.length} tools`,
    );
  }

  // ── AgentBackend entry point ────────────────────────────────────────────

  pushUserMessage(content: string): void {
    if (this.stopped) return;
    this.pending.push(content);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.pending.length > 0) {
        const content = this.pending.shift()!;
        try {
          await this.handleUserMessage(content);
        } catch (err) {
          console.error(`[${this.opts.bot.username}] local loop error:`, err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Run one executor turn to completion (drive the tool loop for `content`).
   * The hybrid coordinator awaits this and inspects task-queue/world deltas to
   * decide whether to continue, replan, or finish. Standalone use goes through
   * `pushUserMessage` → `drain`, which ignores the outcome.
   */
  async runTurn(content: string): Promise<ExecutorOutcome> {
    if (this.stopped) return { serverUnreachable: false, steps: 0 };
    return this.handleUserMessage(content);
  }

  private async handleUserMessage(content: string): Promise<ExecutorOutcome> {
    const { bot } = this.opts;
    const tag = `[${bot.username}]`;
    // A fresh user message is a fresh intent. Clear any stale stop request left
    // set by a previously-cancelled skill (the flag only auto-clears on a
    // cancellable skill's begin()), so the between-steps check below doesn't
    // abort this turn before it starts.
    getBotState(bot.username)?.cancellation.begin();
    // `/no_think` suffix per spike — mandatory to avoid ~30s thinking latency.
    this.transcript.push({ role: "user", content: `${content} /no_think` });

    let stepInTokens = 0;
    let stepOutTokens = 0;
    let steps = 0;

    for (let step = 1; step <= this.maxSteps; step++) {
      steps = step;

      if (this.isCancellationRequested()) {
        console.log(`${tag} [local] cancellation requested — stopping this event`);
        break;
      }

      let resp: ChatResponse;
      try {
        resp = await this.chat();
      } catch (err) {
        this.onBackendUnavailable(err);
        return { serverUnreachable: true, steps };
      }

      const usage = resp.usage;
      stepInTokens += usage?.prompt_tokens ?? 0;
      stepOutTokens += usage?.completion_tokens ?? 0;

      const message = resp.choices?.[0]?.message ?? {};
      const rawContent = message.content ?? "";
      const toolCalls = message.tool_calls ?? [];

      if (toolCalls.length === 0) {
        // Terminal turn: the model produced plain text instead of a tool call.
        // Players only hear `say`/`whisper`, so this text isn't shown — log it
        // (stripped of think/special tokens) so the operator can see it.
        const visible = stripModelArtifacts(rawContent);
        if (visible) {
          console.log(`${tag} [local] [turn ${step}] (not spoken) ${visible.slice(0, 240)}`);
        } else {
          console.log(`${tag} [local] [turn ${step}] no tool call, no text — ending event`);
        }
        break;
      }

      // Synthesize stable ids and echo the assistant turn so the subsequent
      // `role:"tool"` messages reference a matching `tool_call_id`.
      const echoedCalls: ChatToolCall[] = toolCalls.map((tc, i) => ({
        ...tc,
        id: tc.id ?? `c${step}_${i}`,
      }));
      this.transcript.push({ role: "assistant", content: rawContent, tool_calls: echoedCalls });

      const logParts: string[] = [];
      for (const tc of echoedCalls) {
        const name = tc.function?.name ?? "<unknown>";
        const result = await this.dispatch(name, tc.function?.arguments ?? "{}");
        logParts.push(`${name}(${(tc.function?.arguments ?? "").slice(0, 90)})`);
        this.transcript.push({
          role: "tool",
          tool_call_id: tc.id ?? `c${step}_0`,
          name,
          content: capResult(JSON.stringify(result)),
        });
      }
      console.log(`${tag} [local] [turn ${step}] → ${logParts.join(" | ")}`);

      this.pruneTranscript();
    }

    // Record usage for this whole event (summed across its steps).
    const turn: TurnUsage = {
      input_tokens: stepInTokens,
      output_tokens: stepOutTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_cost_usd: null,
    };
    this.lastTurnUsage = turn;
    this.sessionUsage.input_tokens += turn.input_tokens;
    this.sessionUsage.output_tokens += turn.output_tokens;
    this.sessionUsage.turns += 1;
    this.lastTurnError = null;
    console.log(
      `${tag} [local] event complete after ${steps} step(s) — in=${turn.input_tokens} out=${turn.output_tokens}`,
    );
    this.pruneTranscript();
    return { serverUnreachable: false, steps };
  }

  /** Validate args against the spec's zod shape, then run through `runSkill`. */
  private async dispatch(name: string, rawArgs: string): Promise<object> {
    const entry = EXECUTOR_BY_NAME.get(name);
    if (!entry) {
      return { ok: false, message: `unknown tool "${name}"` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs || "{}");
    } catch {
      return { ok: false, message: `invalid JSON arguments for ${name}` };
    }
    const check = entry.validator.safeParse(parsed);
    if (!check.success) {
      return {
        ok: false,
        message: `invalid arguments for ${name}: ${check.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      };
    }
    const result = await entry.spec.run(this.opts.bot, check.data);
    return {
      ok: result.ok,
      message: result.message,
      ...(result.state ? { state: result.state } : {}),
    };
  }

  private async chat(): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.local.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.local.model,
          messages: this.transcript,
          temperature: DEFAULT_TEMPERATURE,
          max_tokens: MAX_TOKENS_PER_STEP,
          tools: EXECUTOR_TOOLS,
          tool_choice: "auto",
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`${res.status} ${res.statusText}: ${body}`);
      }
      return (await res.json()) as ChatResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  private onBackendUnavailable(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.lastTurnError = { subtype: "local_backend_unreachable", at: Date.now() };
    this.cooldown.start(Math.ceil(Date.now() / 1000) + BACKEND_UNAVAILABLE_COOLDOWN_SECONDS);
    console.warn(
      `[${this.opts.bot.username}] local backend unreachable (${message}); dropping chats ~${BACKEND_UNAVAILABLE_COOLDOWN_SECONDS}s. Is mlx_lm.server up? (scripts/llmStart.sh)`,
    );
  }

  private isCancellationRequested(): boolean {
    return getBotState(this.opts.bot.username)?.cancellation.isRequested() ?? false;
  }

  private pruneTranscript(): void {
    const overflow = this.transcript.length - MAX_TRANSCRIPT_MESSAGES;
    if (overflow > 0) {
      // Drop the oldest non-system messages; keep the system prompt at index 0.
      this.transcript.splice(1, overflow);
    }
  }

  // ── Dashboard observability (BackendObservability) ──────────────────────

  isRateLimited(): boolean {
    return this.cooldown.isActive();
  }

  getCooldownRemainingMinutes(): number {
    return this.cooldown.remainingMinutes();
  }

  getRateLimitInfo(): RateLimitInfo | null {
    return null;
  }

  getLastTurnUsage(): TurnUsage | null {
    return this.lastTurnUsage ? { ...this.lastTurnUsage } : null;
  }

  getSessionUsage(): SessionUsage {
    return { ...this.sessionUsage };
  }

  getLastTurnError(): LastTurnError | null {
    return this.lastTurnError ? { ...this.lastTurnError } : null;
  }

  getWindowStats(): WindowStats {
    return {
      botBillableLast5h: 0,
      latestAnchor: null,
      botBillableSinceLastAnchor: 0,
      estimatedBudget: null,
      estimatedCurrentUtilization: null,
      anchorCount: 0,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending.length = 0;
  }
}

/** Truncate an oversized tool-result string before it enters the transcript. */
function capResult(s: string): string {
  return s.length > MAX_TOOL_RESULT_CHARS ? `${s.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)` : s;
}

/** Strip Qwen thinking blocks and chat-template special tokens from text. */
function stripModelArtifacts(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/g, "")
    .trim();
}
