import type { ModelHint } from "../types.js";

/**
 * Map a config-level `model_hint` (sonnet / haiku / opus) to the actual
 * Claude model identifier the Agent SDK expects.
 *
 * Current standing choice (config/bots.yml, config.ts default): `haiku` drives
 * the main NPC loop — the system prompt and tool descriptions are tuned for it
 * (short, prioritized rules; see system-prompt.ts). `sonnet` / `opus` remain
 * available as opt-in tiers for heavier planning.
 */
export function modelIdFor(hint: ModelHint): string {
  switch (hint) {
    case "sonnet":
      return "claude-sonnet-5-5";
    case "haiku":
      // Claude Haiku 5.5 (released 2026-10-07). Dateless pinned ID — no alias
      // or date suffix. Requires adaptive thinking; see claude-backend.ts.
      return "claude-haiku-5-5";
    case "opus":
      return "claude-opus-5-5";
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
