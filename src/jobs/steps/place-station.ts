/** place_station: put a crafting table / furnace from inventory near the work area; verified by the placed block. */
import { Vec3 } from "vec3";
import { placeFromInventoryNearby } from "../../skills/place-helper.js";
import type { Step } from "../../planner/types.js";
import type { StepResult } from "../types.js";
import { cancelled, fail, itemCount, ok, tracked, type StepEnv } from "./util.js";

type Place = Extract<Step, { op: "place_station" }>;
const NEARBY = 6;

export async function placeStationStep({ bot, ctx }: StepEnv, step: Place): Promise<StepResult> {
  const id = bot.registry.blocksByName[step.block]?.id;
  if (id !== undefined) {
    const existing = bot.findBlock({ point: bot.entity.position, matching: id, maxDistance: NEARBY });
    if (existing) return ok(`${step.block} already at ${fmt(existing.position)}`);
  }
  if (ctx.signal.aborted) return cancelled(step);
  if (itemCount(bot, step.block) < 1) {
    return fail(step, "missing_input", `no ${step.block} in inventory to place`);
  }
  const before = itemCount(bot, step.block);
  const r = await tracked(bot, "placeStation", { block: step.block }, async (p) => {
    const placed = await placeFromInventoryNearby(bot, p.block);
    return placed.ok
      ? { ok: true, message: `placed ${p.block} at ${fmt(placed.block.position)}`, state: { pos: { x: placed.block.position.x, y: placed.block.position.y, z: placed.block.position.z } } }
      : { ok: false, message: placed.message };
  });
  if (ctx.signal.aborted) return cancelled(step);
  if (r.ok) {
    // postcondition: the block is in the world (item-count updates trail the placement by a few ticks)
    const pos = (r.state as { pos?: { x: number; y: number; z: number } } | undefined)?.pos;
    for (let i = 0; i < 15; i++) {
      if (pos && bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === step.block) return ok(r.message);
      if (itemCount(bot, step.block) < before) return ok(r.message);
      await new Promise((res) => setTimeout(res, 100));
    }
    return fail(step, "station_unavailable", `${step.block} placement did not show up in the world`);
  }
  return fail(step, "station_unavailable", r.message);
}

function fmt(v: Vec3): string {
  return `(${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.z)})`;
}
