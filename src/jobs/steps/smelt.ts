/** smelt: `smelt` skill in <=64 chunks with the planner's fuel; verified by output delta. */
import { smelt } from "../../skills/crafting.js";
import type { Step } from "../../planner/types.js";
import type { StepResult } from "../types.js";
import { classifyFailure } from "./classify.js";
import { cancelled, fail, itemCount, ok, settleCount, tracked, type StepEnv } from "./util.js";

type Smelt = Extract<Step, { op: "smelt" }>;
const CHUNK = 64;

export async function smeltStep({ bot, ctx }: StepEnv, step: Smelt): Promise<StepResult> {
  const target = ctx.baseline + step.count;
  let last = { message: "", state: undefined as unknown };
  while (itemCount(bot, step.output) < target) {
    if (ctx.signal.aborted) return cancelled(step);
    const before = itemCount(bot, step.output);
    const count = Math.min(CHUNK, target - before, itemCount(bot, step.input));
    if (count <= 0) {
      return fail(step, "missing_input", `no ${step.input} left to smelt (have ${before - ctx.baseline}/${step.count} ${step.output})`);
    }
    const r = await tracked(bot, "smelt", { input: step.input, fuel: step.fuel, count }, (p) => smelt(bot, p));
    last = { message: r.message, state: r.state };
    if (ctx.signal.aborted) return cancelled(step);
    if ((await settleCount(bot, step.output, before + 1)) <= before) {
      return fail(step, classifyFailure(r.message, r.state, "missing_input"), r.message);
    }
  }
  if (itemCount(bot, step.output) >= target) return ok(`smelted ${itemCount(bot, step.output) - ctx.baseline} ${step.output}`);
  return fail(step, classifyFailure(last.message, last.state, "missing_input"), last.message);
}
