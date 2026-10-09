/**
 * Recovery ladder policy (pure). Given a step failure and the per-step
 * "episode" state, decide the next rung. The runner executes the rung.
 *
 *   1. retry once          (transient: unreachable / timeout / station / internal)
 *   2. rebuild view + re-plan   (max MAX_REPLANS per job; plan drifted or nothing in view)
 *   3. no_source: widen the scan 64 → 96 → 160
 *   4. explore             (gather steps with a searchHint: surface spiral / underground stair + branch)
 *   5. fail the job with the failure + the remaining plan
 */
import type { FailureKind, Step, StepFailure } from "../planner/types.js";
import { stepOutputItem } from "./describe.js";

export const MAX_REPLANS = 5;
/** Scan radii used by the gather step (blocks); the first is mineBlocks' own default. */
export const SCAN_RADII = [64, 96, 160] as const;
/** Max exploration runs per failing step (each run is itself bounded). */
export const MAX_EXPLORES = 2;

export interface Episode {
  /** Failures seen for this exact step. */
  fails: number;
  radiusIdx: number;
  retried: boolean;
  replanned: boolean;
  explores: number;
  /** Inventory count of the step's output item when the episode began (postcondition baseline). */
  baseline: number | null;
}

export function newEpisode(): Episode {
  return { fails: 0, radiusIdx: 0, retried: false, replanned: false, explores: 0, baseline: null };
}

export type Rung =
  | { rung: "retry"; detail: string }
  | { rung: "replan"; detail: string }
  | { rung: "widen"; detail: string; radius: number }
  | { rung: "explore"; detail: string }
  | { rung: "fail"; detail: string }
  | { rung: "cancel"; detail: string };

/** Identity of a step across retries and replans (count included so shrinking remainders start fresh). */
export function stepKey(s: Step): string {
  const blocks = s.op === "gather" ? s.blocks.join(",") : "";
  const n = s.op === "place_station" ? 1 : s.count;
  return `${s.op}|${stepOutputItem(s)}|${n}|${blocks}`;
}

const NO_RECOVERY: ReadonlySet<FailureKind> = new Set(["unknown_item", "not_obtainable", "inventory_full"]);
const TRANSIENT: ReadonlySet<FailureKind> = new Set(["unreachable", "timeout", "internal", "hostile", "station_unavailable"]);

/** Mutates `ep` to record the rung taken. */
export function decideRecovery(
  failure: StepFailure,
  step: Step,
  ep: Episode,
  replansLeft: number,
): Rung {
  const kind = failure.kind;
  ep.fails += 1;
  if (kind === "cancelled" || kind === "died") return { rung: "cancel", detail: kind };
  if (NO_RECOVERY.has(kind)) return { rung: "fail", detail: failure.detail };

  const canReplan = replansLeft > 0 && !ep.replanned;
  const replan = (why: string): Rung => {
    ep.replanned = true;
    return { rung: "replan", detail: why };
  };

  if (kind === "no_source") {
    // Nothing in view when the plan was made would have produced a searchHint; a stale view won't have one.
    if (step.op === "gather" && !step.searchHint && canReplan) return replan("no_source with no search hint: rebuild view");
    if (step.op === "gather") {
      if (ep.radiusIdx + 1 < SCAN_RADII.length) {
        ep.radiusIdx += 1;
        const radius = SCAN_RADII[ep.radiusIdx]!;
        return { rung: "widen", radius, detail: `no ${step.item} in range; widening scan to ${radius} blocks` };
      }
      if (step.searchHint && ep.explores < MAX_EXPLORES) {
        ep.explores += 1;
        return { rung: "explore", detail: `searching (${step.searchHint.kind}) for ${step.item}` };
      }
      return { rung: "fail", detail: `no ${step.item} within ${SCAN_RADII[ep.radiusIdx]} blocks after exploring` };
    }
    if (canReplan) return replan("source missing: rebuild view");
    return { rung: "fail", detail: failure.detail };
  }

  if (TRANSIENT.has(kind) && !ep.retried) {
    ep.retried = true;
    return { rung: "retry", detail: `retry after ${kind}` };
  }
  if (kind === "unreachable" && step.op === "gather" && step.searchHint && ep.explores < MAX_EXPLORES && ep.replanned) {
    ep.explores += 1;
    return { rung: "explore", detail: `moving on to find a reachable ${step.item}` };
  }
  if ((kind === "unreachable" || kind === "missing_tool" || kind === "missing_input" || kind === "station_unavailable") && canReplan) {
    return replan(`${kind}: re-plan from current inventory`);
  }
  return { rung: "fail", detail: failure.detail };
}

/** Map a planner `unresolved[].reason` tag (`no_source: …`) to a FailureKind. */
export function kindFromUnresolved(reason: string): FailureKind {
  const m = /^([a-z_]+):/.exec(reason);
  const tag = m?.[1];
  const known: FailureKind[] = ["unknown_item", "not_obtainable", "no_source", "missing_tool", "station_unavailable"];
  return (known as string[]).includes(tag ?? "") ? (tag as FailureKind) : "not_obtainable";
}
