/**
 * Which inventory items a job's plan still depends on (pure). The runner hands
 * this to `state/reservations` so filler consumers (pillar escapes) never spend
 * them. Deliberately a superset: every step's output, every ingredient of every
 * recipe variant of a crafted item, smelt input/fuel, raw needs and the goals.
 * All are reserved in full (`Infinity`), since the plan may need any of them.
 */
import { getRecipeBook } from "../planner/recipes.js";
import type { Plan } from "../planner/types.js";

export function planReservations(plan: Plan): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (item: string): void => {
    out[item] = Number.POSITIVE_INFINITY;
  };
  for (const g of plan.goals) add(g.item);
  for (const k of Object.keys(plan.rawNeeds)) add(k);
  let book: ReturnType<typeof getRecipeBook> | null = null;
  try {
    book = getRecipeBook();
  } catch {
    book = null; // reservations are best-effort
  }
  for (const s of plan.steps) {
    switch (s.op) {
      case "gather":
      case "withdraw":
        add(s.item);
        break;
      case "craft":
        add(s.item);
        for (const r of book?.recipes(s.item) ?? []) for (const ing of Object.keys(r.ingredients)) add(ing);
        break;
      case "smelt":
        add(s.input);
        add(s.output);
        add(s.fuel);
        break;
      case "place_station":
        add(s.block);
        break;
    }
  }
  return out;
}
