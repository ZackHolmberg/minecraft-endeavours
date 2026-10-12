/** craft: `craft` skill (finds / places / crafts its own table when a 3x3 recipe needs one); verified by inventory delta. */
import { craft } from "../../skills/crafting.js";
import type { Step } from "../../planner/types.js";
import type { StepResult } from "../types.js";
import { classifyFailure } from "./classify.js";
import { cancelled, fail, itemCount, ok, settleCount, slotDump, tracked, type StepEnv } from "./util.js";

type Craft = Extract<Step, { op: "craft" }>;

export async function craftStep({ bot, ctx }: StepEnv, step: Craft): Promise<StepResult> {
  const target = ctx.baseline + step.count;
  if (itemCount(bot, step.item) >= target) return ok(`already have ${step.item}`);
  if (ctx.signal.aborted) return cancelled(step);
  const need = target - itemCount(bot, step.item);
  const r = await tracked(bot, "craft", { item: step.item, count: need }, (p) => craft(bot, p));
  if (ctx.signal.aborted) return cancelled(step);
  if ((await settleCount(bot, step.item, target)) >= target) return ok(r.message);
  console.warn(`[${bot.username}] craft postcondition failed for ${step.item} (target ${target}); slots: ${slotDump(bot)}`);
  return fail(step, classifyFailure(r.message, r.state, "missing_input"), r.ok ? `craft reported ok but ${step.item} did not increase: ${r.message}` : r.message);
}
