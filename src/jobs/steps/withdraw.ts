/** withdraw: take items from a known container; verified by inventory delta. */
import { withdrawFromChest } from "../../skills/storage.js";
import type { Step } from "../../planner/types.js";
import type { StepResult } from "../types.js";
import { classifyFailure } from "./classify.js";
import { cancelled, fail, itemCount, ok, settleCount, tracked, type StepEnv } from "./util.js";

type Withdraw = Extract<Step, { op: "withdraw" }>;

export async function withdrawStep({ bot, ctx }: StepEnv, step: Withdraw): Promise<StepResult> {
  const target = ctx.baseline + step.count;
  if (itemCount(bot, step.item) >= target) return ok(`already have ${step.item}`);
  if (ctx.signal.aborted) return cancelled(step);
  const need = target - itemCount(bot, step.item);
  const r = await tracked(bot, "withdrawFromChest", { item: step.item, count: need, pos: step.from }, (p) => withdrawFromChest(bot, p));
  if (ctx.signal.aborted) return cancelled(step);
  if ((await settleCount(bot, step.item, target)) >= target) return ok(r.message);
  // Partial withdraw: the chest had less than memory said (its contents were re-captured when it opened).
  return fail(step, classifyFailure(r.message, r.state, "no_source"), r.ok ? `chest had only part of it: ${r.message}` : r.message);
}
