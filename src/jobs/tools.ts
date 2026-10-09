/**
 * The `achieve` / `cancelJob` skills (registered in skills/registry.ts), and
 * the pure policy for which Haiku tool calls auto-cancel a running job.
 */
import type { Bot } from "mineflayer";
import { getCurrentConversationPartner } from "../orchestrator/chat-router.js";
import type { Goal } from "../planner/types.js";
import { resolveItem } from "../skills/item-naming.js";
import type { SkillResult } from "../skills/types.js";
import { isCreative } from "../skills/game-mode.js";
import { goalsText } from "./describe.js";
import { getJobRunner } from "./registry.js";
import type { AchieveResult } from "./types.js";

/** Tools that never disturb a running job: reads, talk, notes, job control. Everything else is a new instruction. */
export const JOB_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "say",
  "whisper",
  "observeSurroundings",
  "checkInventory",
  "remember",
  "setTaskQueue",
  "advanceTaskQueue",
  "achieve",
  "cancelJob",
]);

/** True when calling `tool` should cancel the running job first (and tell the model so). */
export function shouldCancelJobFor(tool: string, jobRunning: boolean): boolean {
  return jobRunning && !JOB_EXEMPT_TOOLS.has(tool);
}

export interface AchieveParams {
  goals: Array<{ item: string; count: number }>;
}

/** Validate names (with did-you-mean), merge duplicates, start the job, return at once. */
export async function achieve(bot: Bot, { goals }: AchieveParams): Promise<SkillResult> {
  const runner = getJobRunner(bot.username);
  if (!runner) return { ok: false, message: "the job runner isn't available right now" };
  if (isCreative(bot)) {
    return { ok: false, message: "creative mode: don't gather or craft — take what you need with getItems", state: { ok: false, jobId: null } };
  }
  const merged = new Map<string, number>();
  const errors: string[] = [];
  for (const g of goals) {
    const r = resolveItem(bot, g.item);
    if (!r.ok) {
      errors.push(`goals item ${r.message}`);
      continue;
    }
    merged.set(r.normalized, (merged.get(r.normalized) ?? 0) + Math.max(1, Math.floor(g.count)));
  }
  if (errors.length > 0) {
    const res: AchieveResult = { ok: false, jobId: null, message: errors.join("; ") };
    return { ok: false, message: res.message, state: res };
  }
  const list: Goal[] = [...merged.entries()].map(([item, count]) => ({ item, count }));
  const res = await runner.start(list, getCurrentConversationPartner(bot.username) ?? null);
  return {
    ok: res.ok,
    message: res.ok
      ? `job started: ${goalsText(list)}. Plan: ${res.message}. It runs in the background; reply briefly and end your turn — you'll get a [job finished]/[job failed] message.`
      : res.message,
    state: res,
  };
}

export async function cancelJob(bot: Bot): Promise<SkillResult> {
  const runner = getJobRunner(bot.username);
  const job = runner?.current();
  if (!runner || !job || job.status !== "running") return { ok: true, message: "no job is running" };
  await runner.cancel("cancelJob");
  return { ok: true, message: `cancelled the job (${goalsText(job.goals)})` };
}
