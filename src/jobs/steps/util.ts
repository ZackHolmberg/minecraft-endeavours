import type { Bot } from "mineflayer";
import type { Step, StepFailure, FailureKind } from "../../planner/types.js";
import { runSkill } from "../../skills/harness.js";
import type { SkillResult } from "../../skills/types.js";
import type { StepResult } from "../types.js";
import type { StepRunContext } from "../runner.js";

export interface StepEnv {
  bot: Bot;
  ctx: StepRunContext;
}

export function itemCount(bot: Bot, item: string): number {
  const id = bot.registry.itemsByName[item]?.id;
  return id === undefined ? 0 : bot.inventory.count(id, null);
}

export function ok(detail: string): StepResult {
  return { ok: true, detail };
}

export function fail(step: Step, kind: FailureKind, detail: string, attempts = 1, avoid?: string[], positions?: string[]): StepResult {
  const failure: StepFailure & { positions?: string[] } = {
    kind,
    step,
    detail: detail.slice(0, 240),
    attempts,
    ...(avoid && avoid.length > 0 ? { avoid } : {}),
    ...(positions && positions.length > 0 ? { positions } : {}),
  };
  return { ok: false, failure };
}

export function cancelled(step: Step): StepResult {
  return fail(step, "cancelled", "job cancelled");
}

/**
 * Run a skill function through `runSkill` (telemetry, cancellation reset, current-tool, action log).
 * No skill watchdog: the job runner owns step timeouts (and reports them), so a
 * long gather/smelt step is never silently stopped by the 10-min watchdog.
 */
export function tracked<P>(bot: Bot, name: string, params: P, fn: (p: P) => Promise<SkillResult>): Promise<SkillResult> {
  return runSkill(bot, name, params, fn, { watchdogMs: null });
}

/**
 * Wait (bounded) for the client inventory to reach `target` of `item`. Server
 * slot updates trail `bot.craft` / `furnace.takeOutput` / `chest.withdraw` by a
 * few ticks, so a postcondition read right after the skill returns can be stale.
 */
export async function settleCount(bot: Bot, item: string, target: number, maxMs = 3000): Promise<number> {
  const t0 = Date.now();
  let n = itemCount(bot, item);
  while (n < target && Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 100));
    n = itemCount(bot, item);
  }
  return n;
}

/** Debug line: what the client inventory holds right now (slot index -> item), for failed postconditions. */
export function slotDump(bot: Bot): string {
  return bot.inventory.slots
    .map((it, i) => (it ? `${i}:${it.name}x${it.count}` : null))
    .filter(Boolean)
    .join(" ");
}
