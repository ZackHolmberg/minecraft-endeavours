/**
 * Hand-over (v2 slice 3): give the goal items of a finished job to a player and
 * verify it. Creative takes the items with `getItems` first. The postcondition
 * is read from the world, not from the toss succeeding: the bot's inventory
 * dropped by the goal counts AND the dropped item entities were picked up
 * (they vanish from the ground and the bot did not re-collect them).
 */
import type { Bot } from "mineflayer";
import type { Goal, Step } from "../../planner/types.js";
import { getItems } from "../../skills/creative.js";
import { isCreative } from "../../skills/game-mode.js";
import { giveItemsTo } from "../../skills/inventory.js";
import type { DeliverFn } from "../runner.js";
import type { StepResult } from "../types.js";
import { itemCount, tracked } from "./util.js";

const PHASE: Step = { op: "place_station", block: "crafting_table" };
const PICKUP_WAIT_MS = 8_000;
const NEAR = 12;

function failed(kind: Extract<StepResult, { ok: false }>["failure"]["kind"], detail: string): StepResult {
  return { ok: false, failure: { kind, step: PHASE, detail: detail.slice(0, 240), attempts: 1 } };
}

/** Case-insensitive player lookup among the players the bot can see. */
export function findPlayer(bot: Bot, name: string): string | null {
  if (bot.players[name]?.entity) return name;
  const lower = name.toLowerCase();
  for (const [k, p] of Object.entries(bot.players)) if (k.toLowerCase() === lower && p.entity) return k;
  return null;
}

/** Dropped-item entities near the bot whose item is one of `names`. */
export function groundItems(bot: Bot, names: ReadonlySet<string>): number {
  let n = 0;
  const me = bot.entity.position;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || e.name !== "item" || e.position.distanceTo(me) > NEAR) continue;
    const it = e.getDroppedItem?.();
    if (it && names.has(it.name)) n += it.count;
  }
  return n;
}

export function createDeliver(bot: Bot): DeliverFn {
  return async (to: string, goals: Goal[], ctx): Promise<StepResult> => {
    const player = findPlayer(bot, to);
    if (!player) return failed("unreachable", `${to} isn't within sight, so I can't hand it over (I'm holding the items)`);
    if (isCreative(bot)) {
      const r = await getItems(bot, { items: goals.map((g) => ({ name: g.item, count: g.count })) });
      if (!r.ok) return failed("inventory_full", r.message);
    }
    for (const g of goals) {
      if (itemCount(bot, g.item) < g.count) return failed("missing_input", `only ${itemCount(bot, g.item)} ${g.item} on hand, need ${g.count} for ${to}`);
    }
    if (ctx.signal.aborted) return failed("cancelled", "job cancelled");

    const before = new Map(goals.map((g) => [g.item, itemCount(bot, g.item)]));
    const names = new Set(goals.map((g) => g.item));
    const r = await tracked(bot, "giveItemsTo", { player, items: goals.map((g) => ({ item: g.item, count: g.count })) }, (p) => giveItemsTo(bot, p));
    if (ctx.signal.aborted) return failed("cancelled", "job cancelled");
    if (!r.ok) return failed("unreachable", `couldn't hand over to ${player}: ${r.message}`);

    // the toss must have left the inventory ...
    for (const g of goals) {
      const gone = (before.get(g.item) ?? 0) - itemCount(bot, g.item);
      if (gone < g.count) return failed("internal", `handed over but ${g.item} left my inventory ${gone}/${g.count}`);
    }
    // ... and the player must have picked it up (drops vanish from the ground)
    const t0 = Date.now();
    while (groundItems(bot, names) > 0 && Date.now() - t0 < PICKUP_WAIT_MS) {
      if (ctx.signal.aborted) return failed("cancelled", "job cancelled");
      await new Promise((res) => setTimeout(res, 250));
    }
    const left = groundItems(bot, names);
    if (left > 0) return failed("unreachable", `dropped the items next to ${player} but ${left} are still on the ground (not picked up)`);
    for (const g of goals) {
      const gone = (before.get(g.item) ?? 0) - itemCount(bot, g.item);
      if (gone < g.count) return failed("internal", `${g.item} came back into my inventory (${player} didn't take it)`);
    }
    return { ok: true, detail: `gave ${goals.map((g) => `${g.count} ${g.item}`).join(", ")} to ${player}` };
  };
}
