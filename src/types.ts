export type ModelHint = "sonnet" | "haiku" | "opus";

/**
 * Which LLM drives a bot. Phase B adds `"local"` (a locally-served model via
 * `mlx_lm.server`); `"hybrid"` (Claude-plans / Qwen-executes) lands in Phase C.
 */
export type BackendKind = "claude" | "local";

/** Connection details for a local `mlx_lm.server`-hosted model. */
export interface LocalModelConfig {
  /** OpenAI-compatible base URL, e.g. `http://127.0.0.1:8080/v1`. */
  baseUrl: string;
  /** Model id the server reports, e.g. `mlx-community/Qwen3-14B-4bit`. */
  model: string;
}

export interface BotConfig {
  username: string;
  /** Claude model tier for the claude backend (and, later, the hybrid planner). */
  model_hint: ModelHint;
  /** Which backend drives this bot. Defaults to `"claude"` (unchanged behavior). */
  backend: BackendKind;
  /** Present when `backend === "local"`. */
  local?: LocalModelConfig;
}

export interface AppConfig {
  bots: BotConfig[];
  mcHost: string;
  mcPort: number;
  mcVersion: string;
}
