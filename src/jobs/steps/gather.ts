/** gather: the slice-1 counting `mineBlocks` path, driven by a list of acceptable blocks, verified by inventory delta. */
import { mineBlocks } from "../../skills/world.js";
import type { Step } from "../../planner/types.js";
import type { StepResult } from "../types.js";
import { classifyFailure } from "./classify.js";
import { cancelled, fail, itemCount, ok, tracked, type StepEnv } from "./util.js";

type Gather = Extract<Step, { op: "gather" }>;

const MAX_ATTEMPTS = 4;
const MINE_BLOCKS_CAP = 128;
/** Placed-looking source blocks: only used when nothing else is listed. */
const PLACED_LOOKING = new Set(["cobblestone", "cobbled_deepslate"]);

/** Natural source blocks first: `stone` rather than a player's `cobblestone`. */
export function naturalBlocks(blocks: string[]): string[] {
  const natural = blocks.filter((b) => !PLACED_LOOKING.has(b));
  return natural.length > 0 ? natural : blocks;
}

export async function gatherStep({ bot, ctx }: StepEnv, step: Gather): Promise<StepResult> {
  const target = ctx.baseline + step.count;
  const blocks = naturalBlocks(step.blocks);
  const have = (): number => itemCount(bot, step.item);
  let last = { message: "", state: undefined as unknown, ok: false };

  for (let attempt = 0; attempt < MAX_ATTEMPTS && have() < target; attempt++) {
    if (ctx.signal.aborted) return cancelled(step);
    const before = have();
    const params = { types: blocks, maxCount: Math.min(MINE_BLOCKS_CAP, target - before), maxDistance: ctx.radius };
    const r = await tracked(bot, "mineBlocks", params, (p) => mineBlocks(bot, p));
    last = { message: r.message, state: r.state, ok: r.ok };
    if (ctx.signal.aborted) return cancelled(step);
    if (have() >= target) break;
    const gained = have() - before;
    if (gained <= 0 || !r.ok) {
      const kind = classifyFailure(r.message, r.state, "unreachable");
      return fail(step, kind, `${r.message} (have ${have() - ctx.baseline}/${step.count} ${step.item})`);
    }
    // progress but short ("no more within N blocks"): loop; the next call reports no_source cleanly if empty
  }
  if (have() >= target) return ok(`gathered ${have() - ctx.baseline} ${step.item}`);
  return fail(
    step,
    classifyFailure(last.message, last.state, "no_source"),
    `${last.message || "gather made no progress"} (have ${have() - ctx.baseline}/${step.count} ${step.item})`,
  );
}
