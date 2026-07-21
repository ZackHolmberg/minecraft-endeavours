/**
 * The `AgentBackend` interface — wraps an entire tool-calling conversation for
 * one bot, behind a single seam so the LLM driving the skill layer is
 * swappable. Implementations:
 *  - `ClaudeBackend`  — today's Claude Agent SDK loop (src/agent/backend/claude-backend.ts).
 *  - `LocalBackend`   — hand-rolled loop vs `mlx_lm.server` (Phase B).
 *  - `HybridBackend`  — Claude-plans / Qwen-executes coordinator (Phase C).
 *
 * The usage / rate-limit types live here (moved out of npc-agent.ts) so every
 * backend and the snapshot import them from one place. `BackendObservability`
 * is exactly the 7 methods the dashboard snapshot reads
 * (src/observability/snapshot.ts) — preserving that contract verbatim is what
 * lets non-Claude backends slot in without touching the dashboard.
 */

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

/**
 * The exact 7 methods the snapshot reads today
 * (src/observability/snapshot.ts). Every backend implements these; non-Claude
 * backends return local-appropriate values (token counts real; cost /
 * rate-limit / window null/empty) so the dashboard keeps rendering unedited.
 */
export interface BackendObservability {
  isRateLimited(): boolean;
  getCooldownRemainingMinutes(): number;
  getRateLimitInfo(): RateLimitInfo | null;
  getLastTurnUsage(): TurnUsage | null;
  getSessionUsage(): SessionUsage;
  getLastTurnError(): LastTurnError | null;
  getWindowStats(): WindowStats;
}

export interface AgentBackend extends BackendObservability {
  /** Enqueue a fully-formatted user message for the backend's conversation. */
  pushUserMessage(content: string): void;
  /** Graceful shutdown; let any in-flight tool call finish. */
  stop(): Promise<void>;
}
