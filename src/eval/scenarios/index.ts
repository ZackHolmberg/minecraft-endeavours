import type { Scenario } from "../types.js";
import { groups } from "./groups.js";
import { tier1 } from "./tier1.js";
import { tier2 } from "./tier2.js";
import { tier3 } from "./tier3.js";
import { tier4 } from "./tier4.js";

/** All scenarios, in run order. Add new groups here. */
export const scenarios: Scenario[] = [...tier1, ...tier2, ...tier3, ...groups, ...tier4];

const globToRe = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

/** Comma-separated globs over scenario ids ("t1.*,t2.door_house"), filtered by suite (default core; "all" = both). */
export function selectScenarios(only?: string, suite: "core" | "stretch" | "all" = "core"): Scenario[] {
  const inSuite = scenarios.filter((s) => suite === "all" || (s.suite ?? "core") === suite);
  if (!only) return inSuite;
  const res = only.split(",").map((s) => globToRe(s.trim()));
  return inSuite.filter((s) => res.some((r) => r.test(s.id)));
}
