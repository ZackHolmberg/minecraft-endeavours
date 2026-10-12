export type ModelHint = "sonnet" | "haiku" | "opus";

/**
 * Which LLM drives a bot: `"claude"` (Agent SDK), `"local"` (a locally-served
 * model via `mlx_lm.server`), or `"hybrid"` (Claude plans / Qwen executes).
 */
export type BackendKind = "claude" | "local" | "hybrid";

/**
 * How the Claude backend scopes SDK sessions. `per_task` (default): a fresh
 * session per player request, with all context injected from disk + live
 * state. `persistent`: one long-lived streaming session per bot (the original
 * design; conversation lives in SDK memory).
 */
export type SessionMode = "per_task" | "persistent";

/** Connection details for a local `mlx_lm.server`-hosted model. */
export interface LocalModelConfig {
  /** OpenAI-compatible base URL, e.g. `http://127.0.0.1:8080/v1`. */
  baseUrl: string;
  /** Model id the server reports, e.g. `mlx-community/Qwen3-14B-4bit`. */
  model: string;
}

/** Sub-config for the hybrid backend: a Claude planner + a local executor. */
export interface HybridConfig {
  /** Claude tier the planner runs at. Defaults to sonnet. */
  plannerModelHint: ModelHint;
  /** Local model the executor drives. */
  executor: LocalModelConfig;
}

export interface BotConfig {
  username: string;
  /** Extra names players can use to address this bot ("steve" for Steve_v2). Validated in config.ts. */
  aliases?: string[];
  /** Claude model tier for the claude backend. */
  model_hint: ModelHint;
  /** Which backend drives this bot. Defaults to `"claude"` (unchanged behavior). */
  backend: BackendKind;
  /** Claude backend session scoping. Defaults to `"per_task"`. */
  session_mode: SessionMode;
  /** Present when `backend === "local"`. */
  local?: LocalModelConfig;
  /** Present when `backend === "hybrid"`. */
  hybrid?: HybridConfig;
}

export interface AppConfig {
  bots: BotConfig[];
  mcHost: string;
  mcPort: number;
  mcVersion: string;
}
