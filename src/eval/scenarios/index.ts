import type { Scenario } from "../types.js";
import { chopLogs, comeHere, giveBread } from "./tier1.js";
import { doorHouse } from "./tier2.js";

/** All scenarios, in run order. Add new ones here. */
export const scenarios: Scenario[] = [chopLogs, comeHere, giveBread, doorHouse];

const globToRe = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

/** Comma-separated globs over scenario ids ("t1.*,t2.door_house"). No filter = all. */
export function selectScenarios(only?: string): Scenario[] {
  if (!only) return scenarios;
  const res = only.split(",").map((s) => globToRe(s.trim()));
  return scenarios.filter((s) => res.some((r) => r.test(s.id)));
}
