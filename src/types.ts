export type ModelHint = "sonnet" | "haiku" | "opus";

/**
 * Which LLM drives a bot: `"claude"` (Agent SDK), `"local"` (a locally-served
 * model via `mlx_lm.server`), or `"hybrid"` (Claude plans / Qwen executes).
 */
export type BackendKind = "claude" | "local" | "hybrid";

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
  /** Claude model tier for the claude backend. */
  model_hint: ModelHint;
  /** Which backend drives this bot. Defaults to `"claude"` (unchanged behavior). */
  backend: BackendKind;
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
