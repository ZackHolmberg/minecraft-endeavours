import type { ModelHint } from "../types.js";

/**
 * Map a config-level `model_hint` (sonnet / haiku / opus) to the actual
 * Claude model identifier the Agent SDK expects.
 *
 * ARCHITECTURE.md "Default model selection":
 *   sonnet — main NPC reasoning loop
 *   haiku  — cheap background summarization (reserved for future use)
 *   opus   — opt-in for genuinely complex multi-step plans
 */
export function modelIdFor(hint: ModelHint): string {
  switch (hint) {
    case "sonnet":
      return "claude-sonnet-4-6";
    case "haiku":
      return "claude-haiku-4-5-20251001";
    case "opus":
      return "claude-opus-4-7";
  }
}

/**
 * Per-bot rate-limit cooldown. Driven by `SDKRateLimitEvent` messages with
 * `status === "rejected"`. While active, the orchestrator drops new chats
 * rather than queueing them — per ARCHITECTURE.md "Resilience": "No retry
 * loop — would burn more quota."
 *
 * `resetsAt` is the Unix-seconds timestamp from the SDK's rate-limit info.
 */
export class RateLimitCooldown {
  private resetsAt: number | null = null;

  start(resetsAtUnixSeconds: number): void {
    this.resetsAt = resetsAtUnixSeconds;
  }

  isActive(): boolean {
    if (this.resetsAt === null) return false;
    if (this.nowUnixSeconds() >= this.resetsAt) {
      this.resetsAt = null;
      return false;
    }
    return true;
  }

  remainingMinutes(): number {
    if (this.resetsAt === null) return 0;
    return Math.max(1, Math.ceil((this.resetsAt - this.nowUnixSeconds()) / 60));
  }

  private nowUnixSeconds(): number {
    return Date.now() / 1000;
  }
}
