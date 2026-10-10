/**
 * Hand-over (v2 slice 3): give the goal items of a finished job to a player and
 * verify it. Creative takes the items with `getItems` first. The postcondition
 * is read from the world, not from the toss succeeding: the bot's inventory
 * dropped by the goal counts AND the item entities THIS toss created (tracked by
 * entity id, so the bot's own leftovers lying nearby never count) were picked up.
 * mineflayer cannot read another player's inventory, so "picked up" is, in order
 * of strength: a `playerCollect` event naming the player; the entity vanishing
 * near the player within {@link PICKUP_WAIT_MS}; (extra) the item showing in the
 * player's visible equipment. The message reports which of these actually happened.
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
export const PICKUP_WAIT_MS = 10_000;
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

/** What happened to one dropped item entity created by the hand-over toss. */
export type DropStatus = "ground" | "player" | "bot" | "other" | "gone";
export interface TrackedDrop {
  id: string;
  /** Item name once the metadata packet arrived; null while unknown (treated as one of ours). */
  item: string | null;
  count: number | null;
  status: DropStatus;
}

export interface HandoverEvidence {
  /** The requested player's visible equipment gained one of the items (best-effort extra signal). */
  seenInHand: boolean;
  /** How many of each goal item left the bot's inventory. */
  gone: Record<string, number>;
}

const total = (ds: TrackedDrop[]): string => {
  const known = ds.every((d) => d.count !== null);
  return known ? `${ds.reduce((a, d) => a + (d.count ?? 0), 0)} item(s)` : `${ds.length} dropped stack(s)`;
};

/** Pure verdict over the tracked drops of one hand-over (unit-tested). */
export function judgeHandover(player: string, goals: Goal[], drops: TrackedDrop[], ev: HandoverEvidence): StepResult {
  const wanted = goals.map((g) => `${g.count} ${g.item}`).join(", ");
  const by = (s: DropStatus): TrackedDrop[] => drops.filter((d) => d.status === s);
  const ground = by("ground");
  const back = by("bot");
  const took = by("player");
  const gone = by("gone");
  const other = by("other");
  if (ground.length > 0) {
    return failed("unreachable", `dropped ${wanted} next to ${player} but ${total(ground)} are still on the ground after ${Math.round(PICKUP_WAIT_MS / 1000)}s (${player} did not pick ${took.length + gone.length > 0 ? "all of it" : "it"} up)${took.length > 0 ? `; ${player} took ${total(took)}` : ""}`);
  }
  if (back.length > 0) {
    return failed("unreachable", `the dropped items came back to me (I collected ${total(back)} again)${took.length > 0 ? `; ${player} took ${total(took)}` : `; ${player} didn't take them`}`);
  }
  for (const g of goals) {
    const n = ev.gone[g.item] ?? 0;
    if (n < g.count) return failed("internal", `only ${n}/${g.count} ${g.item} actually left my inventory (the rest came back to me)`);
  }
  if (drops.length === 0) {
    // No item entity was ever seen (events missed or merged): inventory fell, nothing else is known.
    return { ok: true, detail: `tossed ${wanted} next to ${player}; couldn't observe the pickup, so it is unconfirmed` };
  }
  if (took.length > 0 && gone.length === 0 && other.length === 0) {
    return { ok: true, detail: `gave ${wanted} to ${player} (${player} picked it up)` };
  }
  if (took.length > 0 || ev.seenInHand) {
    return { ok: true, detail: `gave ${wanted} to ${player} (${player} picked up ${total(took)}${gone.length + other.length > 0 ? `; ${total([...gone, ...other])} vanished next to them` : ""}${ev.seenInHand ? "; seen in their hand" : ""})` };
  }
  return { ok: true, detail: `dropped ${wanted} next to ${player}; the items disappeared within ${Math.round(PICKUP_WAIT_MS / 1000)}s, so they were probably picked up (not directly confirmed)` };
}

type ItemEntity = { id: string; position: { distanceTo(o: unknown): number }; getDroppedItem?: () => { name: string; count: number } | null };

function itemEntities(bot: Bot): ItemEntity[] {
  const out: ItemEntity[] = [];
  for (const k of Object.keys(bot.entities)) {
    const e = bot.entities[k];
    if (e && e.name === "item") out.push({ ...(e as unknown as ItemEntity), id: String(e.id ?? k), position: e.position, getDroppedItem: () => (e as unknown as ItemEntity).getDroppedItem?.() ?? null });
  }
  return out;
}

/** Visible equipment of `player` (hands, armor) counted by item name; null when the view isn't available. */
export function equipmentView(bot: Bot, player: string, names: ReadonlySet<string>): Record<string, number> | null {
  const eq = (bot.players[player]?.entity as { equipment?: Array<{ name: string; count: number } | null | undefined> } | undefined)?.equipment;
  if (!Array.isArray(eq)) return null;
  const out: Record<string, number> = {};
  for (const it of eq) if (it && names.has(it.name)) out[it.name] = (out[it.name] ?? 0) + it.count;
  return out;
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
    const handBefore = equipmentView(bot, player, names);

    // Track only item entities this toss creates: ids not present before it.
    const preexisting = new Set(itemEntities(bot).map((e) => e.id));
    const drops = new Map<string, TrackedDrop>();
    const track = (e: ItemEntity): void => {
      if (preexisting.has(e.id) || drops.has(e.id)) return;
      if (e.position.distanceTo(bot.entity.position) > NEAR) return;
      const it = e.getDroppedItem?.() ?? null;
      if (it && !names.has(it.name)) return; // a known, different item (not ours)
      drops.set(e.id, { id: e.id, item: it?.name ?? null, count: it?.count ?? null, status: "ground" });
    };
    const onSpawn = (e: { id: number; name?: string; position: ItemEntity["position"]; getDroppedItem?: ItemEntity["getDroppedItem"] }): void => {
      if (e.name === "item") track({ id: String(e.id), position: e.position, getDroppedItem: () => e.getDroppedItem?.() ?? null });
    };
    const onGone = (e: { id: number }): void => {
      const d = drops.get(String(e.id));
      if (d && d.status === "ground") d.status = "gone";
    };
    const onCollect = (collector: { username?: string; id?: number }, collected: { id: number }): void => {
      const d = drops.get(String(collected.id));
      if (!d || (d.status !== "ground" && d.status !== "gone")) return;
      d.status = collector.username === bot.username || collector.id === bot.entity?.id ? "bot" : collector.username === player ? "player" : "other";
    };
    const emitter = bot as unknown as { on?: (ev: string, fn: (...a: never[]) => void) => void; removeListener?: (ev: string, fn: (...a: never[]) => void) => void };
    const listen = typeof emitter.on === "function" && typeof emitter.removeListener === "function";
    if (listen) {
      emitter.on!("entitySpawn", onSpawn as never);
      emitter.on!("entityGone", onGone as never);
      emitter.on!("playerCollect", onCollect as never);
    }
    try {
      const r = await tracked(bot, "giveItemsTo", { player, items: goals.map((g) => ({ item: g.item, count: g.count })) }, (p) => giveItemsTo(bot, p));
      if (ctx.signal.aborted) return failed("cancelled", "job cancelled");
      if (!r.ok) return failed("unreachable", `couldn't hand over to ${player}: ${r.message}`);
      for (const e of itemEntities(bot)) track(e); // spawn events we may have missed (or no event support)

      // the toss must have left the inventory ...
      const gone = (): Record<string, number> => Object.fromEntries(goals.map((g) => [g.item, (before.get(g.item) ?? 0) - itemCount(bot, g.item)]));
      // ... and the tracked drops must leave the ground, picked up by the player
      const t0 = Date.now();
      const settle = (): void => {
        for (const d of drops.values()) {
          if (d.status === "ground" && !bot.entities[d.id]) d.status = "gone";
          const e = bot.entities[d.id] as { getDroppedItem?: () => { name: string; count: number } | null } | undefined;
          const it = e?.getDroppedItem?.();
          if (it) {
            d.item = it.name;
            d.count = it.count;
          }
        }
      };
      settle();
      while ([...drops.values()].some((d) => d.status === "ground") && Date.now() - t0 < PICKUP_WAIT_MS) {
        if (ctx.signal.aborted) return failed("cancelled", "job cancelled");
        await new Promise((res) => setTimeout(res, 250));
        settle();
      }
      settle();
      const handAfter = equipmentView(bot, player, names);
      const seenInHand = !!handBefore && !!handAfter && Object.keys(handAfter).some((k) => (handAfter[k] ?? 0) > (handBefore[k] ?? 0));
      return judgeHandover(player, goals, [...drops.values()], { seenInHand, gone: gone() });
    } finally {
      if (listen) {
        emitter.removeListener!("entitySpawn", onSpawn as never);
        emitter.removeListener!("entityGone", onGone as never);
        emitter.removeListener!("playerCollect", onCollect as never);
      }
    }
  };
}
