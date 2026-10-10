/** gather: the slice-1 counting `mineBlocks` path, driven by a list of acceptable blocks, verified by inventory delta. */
import { mineBlocks } from "../../skills/world.js";
import type { Step } from "../../planner/types.js";
import type { StepResult } from "../types.js";
import { Vec3 } from "vec3";
import { withDryOres } from "../exhausted.js";
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

/** Block types `mineBlocks` reported it could not reach (state.unreachableTypes), limited to this step's blocks. */
export function unreachableBlocksOf(state: unknown, blocks: readonly string[]): string[] {
  const t = (state as { unreachableTypes?: Record<string, number> } | undefined)?.unreachableTypes;
  if (!t) return [];
  return Object.keys(t).filter((b) => (t[b] ?? 0) > 0 && blocks.includes(b));
}

/** "x,y,z" of the blocks `mineBlocks` gave up on (or got stuck at), for the job's exhausted-area memory. */
export function unreachablePositionsOf(state: unknown): string[] {
  const st = state as { unreachablePositions?: string[]; stuckAt?: { x: number; y: number; z: number } } | undefined;
  const out = [...(st?.unreachablePositions ?? [])];
  if (st?.stuckAt) out.push(`${st.stuckAt.x},${st.stuckAt.y},${st.stuckAt.z}`);
  return out;
}

export async function gatherStep({ bot, ctx }: StepEnv, step: Gather): Promise<StepResult> {
  const target = ctx.baseline + step.count;
  const blocks = naturalBlocks(step.blocks);
  // after an area was written off, also shun ore that touches water / lava (only for ores: logs and stone are fine on a shore)
  const oreStep = blocks.some((b) => b.endsWith("_ore"));
  const exclude = oreStep ? withDryOres(ctx.exclude, (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name ?? null) : ctx.exclude;
  const have = (): number => itemCount(bot, step.item);
  let last = { message: "", state: undefined as unknown, ok: false };

  for (let attempt = 0; attempt < MAX_ATTEMPTS && have() < target; attempt++) {
    if (ctx.signal.aborted) return cancelled(step);
    const before = have();
    const params = { types: blocks, maxCount: Math.min(MINE_BLOCKS_CAP, target - before), maxDistance: ctx.radius, ...(exclude ? { exclude } : {}) };
    const r = await tracked(bot, "mineBlocks", params, (p) => mineBlocks(bot, p));
    last = { message: r.message, state: r.state, ok: r.ok };
    if (ctx.signal.aborted) return cancelled(step);
    if (have() >= target) break;
    const gained = have() - before;
    // Progress beats a soft failure ("drops of this tree couldn't be collected", one unreachable block): go again
    // until the count is met or a call makes none; only a call that gained nothing fails the step.
    if (gained <= 0) {
      const kind = classifyFailure(r.message, r.state, "unreachable");
      return fail(step, kind, `${r.message} (have ${have() - ctx.baseline}/${step.count} ${step.item})`, 1, kind === "unreachable" ? unreachableBlocksOf(r.state, step.blocks) : undefined, kind === "unreachable" ? unreachablePositionsOf(r.state) : undefined);
    }
    // progress but short ("no more within N blocks"): loop; the next call reports no_source cleanly if empty
  }
  if (have() >= target) return ok(`gathered ${have() - ctx.baseline} ${step.item}`);
  const lastKind = classifyFailure(last.message, last.state, "no_source");
  return fail(
    step,
    lastKind,
    `${last.message || "gather made no progress"} (have ${have() - ctx.baseline}/${step.count} ${step.item})`,
    1,
    lastKind === "unreachable" ? unreachableBlocksOf(last.state, step.blocks) : undefined,
    lastKind === "unreachable" ? unreachablePositionsOf(last.state) : undefined,
  );
}
