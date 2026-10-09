/** Tier 2: multi-step / environment-aware tasks. */
import { blockOf, buildHouse, inBox } from "../helpers.js";
import type { Scenario } from "../types.js";

export const doorHouse: Scenario = {
  id: "t2.door_house",
  tier: 2,
  category: "doors",
  title: "Walk into a closed house through its door (no breaking)",
  timeoutMs: 3 * 60_000,
  site: "plains2",
  async setup(ctx) {
    const house = await buildHouse(ctx, ctx.at(0, 0, 0));
    ctx.protect(house.outer, "house");
    await ctx.tp(ctx.tester, house.center);
    // Bot ~10 blocks beyond the door, on the same ground level.
    const z = house.door.z + 10;
    await ctx.tp(ctx.bot, { x: house.center.x, y: await ctx.surface(house.center.x, z), z });
    // Stash for check(): re-derive from site rather than closing over mutable state.
    await ctx.sleep(1500);
  },
  async run(ctx) {
    await ctx.say("steve, come inside the house to me");
    await ctx.waitForDone();
  },
  async check(ctx) {
    const c = ctx.at(0, 0, 0);
    const interior = { min: { x: c.x - 2, y: c.y, z: c.z - 2 }, max: { x: c.x + 2, y: c.y + 2, z: c.z + 2 } };
    const p = await ctx.position(ctx.bot);
    const inside = inBox(blockOf(p), interior);
    return {
      ok: inside,
      detail: `bot at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} ${inside ? "inside" : "outside"} the house interior`,
    };
  },
};
