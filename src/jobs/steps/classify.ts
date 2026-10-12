/**
 * Map a skill's free-text failure message to a typed FailureKind. Skill
 * messages are written for the LLM, so this is regex-based; every pattern
 * below is a message the v1 skills actually emit (see classify.test.ts).
 * Order matters: specific causes before generic ones.
 */
import type { FailureKind } from "../../planner/types.js";

export function classifyFailure(message: string, state?: unknown, fallback: FailureKind = "internal"): FailureKind {
  const m = message ?? "";
  const st = (state ?? {}) as { cancelled?: unknown };
  if (st.cancelled === true || /\bcancell?ed\b|\bstopped (smelting|following)\b/i.test(m)) return "cancelled";
  if (/inventory is full|inventory full|inventory's full/i.test(m)) return "inventory_full";
  if (/\bcrashed\b|\bthrew\b/i.test(m)) return "internal";
  if (/in inventory to mine|lost the tool needed|cannot mine any requested type|wrong tool/i.test(m) && !/within \d+ blocks/i.test(m)) {
    return "missing_tool";
  }
  if (
    /\bno (crafting_table|furnace|blast_furnace|smoker)\b|not a furnace|failed to open furnace|couldn't place|no clear spot|have one in inventory but|can't smelt .* use a/i.test(
      m,
    )
  ) {
    return "station_unavailable";
  }
  if (/timed out|timeout/i.test(m)) return "timeout";
  // gather: "no oak_log within 64 blocks", "no mineable blocks within 64 blocks (skipped: …)"
  if (/^no (minable |mineable )?[\w ]+ within \d+ blocks/i.test(m) || /no more within \d+ blocks/i.test(m)) return "no_source";
  if (/no path|could not reach|couldn't reach|unreachable|\bstuck\b|out of reach|retargeting same block|dig failed/i.test(m)) return "unreachable";
  if (/\bhas no \w+|none remembered|no chest|not found within/i.test(m)) return "no_source";
  if (/cannot craft|cannot smelt|missing|not enough|only \d+ in inventory|no fuel|out of fuel|ran out of fuel|don't have/i.test(m)) {
    return "missing_input";
  }
  if (/dropped nothing|could not be picked up/i.test(m)) return "unreachable";
  return fallback;
}
