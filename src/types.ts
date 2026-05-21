export type ModelHint = "sonnet" | "haiku" | "opus";

export interface BotConfig {
  username: string;
  model_hint: ModelHint;
}

export interface AppConfig {
  bots: BotConfig[];
  mcHost: string;
  mcPort: number;
}
