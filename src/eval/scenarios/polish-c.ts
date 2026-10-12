/** Live-polish C scenarios: the `find` job in creative, and creative flight when following a flying player. */
import { ask, box } from "../helpers.js";
import type { CheckResult, Scenario, ScenarioCtx, Vec3 } from "../types.js";

const DIAMOND = /^(deepslate_)?diamond_ore$/;

/** Where the scenario hides its diamond ore: ~90 blocks below the site and 18 east, inside solid rock. */
const oreSpot = (ctx: ScenarioCtx): Vec3 => ({ x: ctx.site.x + 18, y: ctx.site.y - 90, z: ctx.site.z + 9 });

/** Is any diamond ore within `r` blocks (centre to the bot's feet) of the bot? Reads the Tester's loaded world, no RCON. */
async function diamondWithin(ctx: ScenarioCtx, r: number): Promise<{ near: number; at: Vec3 | null; d: number }> {
  const p = await ctx.position(ctx.bot);
  const c = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  let best = Infinity;
  let at: Vec3 | null = null;
  let near = 0;
  for (let dx = -r - 1; dx <= r + 1; dx++)
    for (let dy = -r - 1; dy <= r + 1; dy++)
      for (let dz = -r - 1; dz <= r + 1; dz++) {
        const pos = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        const d = Math.hypot(pos.x + 0.5 - p.x, pos.y + 0.5 - p.y, pos.z + 0.5 - p.z);
        if (d > r) continue;
        if (!DIAMOND.test(await ctx.blockAt(pos))) continue;
        near++;
        if (d < best) {
          best = d;
          at = pos;
        }
      }
  return { near, at, d: best };
}

export const crFindDiamonds: Scenario = {
  id: "cr.find_diamonds",
  tier: 3,
  category: "creative",
  title: "Creative: find diamond ore (don't mine it) and stand next to it",
  timeoutMs: 12 * 60_000,
  site: "plains",
  gameMode: "creative",
  async setup(ctx) {
    // a pocket of diamond ore sealed in solid rock deep under the site (the natural world may have none within reach)
    const o = oreSpot(ctx);
    await ctx.fill(box({ x: o.x - 2, y: o.y - 2, z: o.z - 2 }, { x: o.x + 2, y: o.y + 2, z: o.z + 2 }), "deepslate");
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as const) await ctx.setBlock({ x: o.x + dx, y: o.y + dy, z: o.z + dz }, "diamond_ore");
    ctx.scratch.ore = o;
  },
  run: (ctx) => ask(ctx, "steve, find diamond ore but don't mine it"),
  async check(ctx): Promise<CheckResult> {
    const r = await diamondWithin(ctx, 4);
    const placed = ctx.scratch.ore as Vec3 | undefined;
    const left = placed ? await ctx.blockAt(placed) : "?";
    return {
      ok: r.near > 0,
      score: r.near > 0 ? 1 : 0,
      detail: r.near > 0 ? `${r.near} diamond_ore within 4 blocks (nearest ${r.d.toFixed(1)} at ${r.at ? `${r.at.x},${r.at.y},${r.at.z}` : "?"}); planted ore is ${left}` : `no diamond_ore within 4 blocks of the bot; planted ore at ${placed ? `${placed.x},${placed.y},${placed.z}` : "?"} is ${left}`,
    };
  },
  dryWin: async (ctx) => {
    const o = oreSpot(ctx);
    await ctx.tp(ctx.bot, { x: o.x + 2.5, y: o.y, z: o.z + 0.5 });
  },
};

/** The Tester's flight: rises 3 blocks and moves 3 east per step (8 steps: ~34 blocks away, inside the 48-block player tracking range), then hovers at the end (teleports, re-issued so it never lands). */
async function flyAway(ctx: ScenarioCtx, from: Vec3): Promise<Vec3> {
  let p = from;
  for (let i = 1; i <= 8 && !ctx.signal.aborted; i++) {
    p = { x: from.x + 3 * i, y: from.y + 3 * i, z: from.z };
    await ctx.tp(ctx.tester, p);
    await ctx.sleep(800);
  }
  return p;
}

export const crFlyFollow: Scenario = {
  id: "cr.fly_follow",
  tier: 3,
  category: "creative",
  title: "Creative: follow the player as they fly up and away",
  timeoutMs: 3 * 60_000,
  site: "plains",
  gameMode: "creative",
  async setup() {},
  async run(ctx) {
    await ctx.say("steve, follow me");
    await ctx.sleep(4000);
    const from = await ctx.position(ctx.tester);
    const end = await flyAway(ctx, from);
    ctx.scratch.flightEnd = end;
    ctx.scratch.flownAt = Date.now();
    // hover up there while the bot catches up (re-teleported so the Tester client never falls)
    for (let i = 0; i < 80 && !ctx.signal.aborted; i++) {
      await ctx.tp(ctx.tester, end);
      await ctx.sleep(250);
    }
  },
  async check(ctx): Promise<CheckResult> {
    const at = ctx.scratch.flownAt as number | undefined;
    if (!at || Date.now() - at < 5_000) return { ok: false, detail: "waiting for the flight to finish + 5s" };
    const [b, t] = [await ctx.position(ctx.bot), await ctx.position(ctx.tester)];
    const d = Math.hypot(b.x - t.x, b.y - t.y, b.z - t.z);
    return { ok: d <= 6, score: d <= 6 ? 1 : Math.max(0, 1 - (d - 6) / 40), detail: `bot is ${d.toFixed(1)} blocks from the flying Tester (y ${b.y.toFixed(0)} vs ${t.y.toFixed(0)}; need <= 6)` };
  },
  dryWin: async (ctx) => {
    ctx.scratch.flownAt = Date.now() - 6_000;
    const t = await ctx.position(ctx.tester);
    await ctx.tp(ctx.bot, { x: t.x - 2, y: t.y, z: t.z });
  },
};

export const polishC = [crFindDiamonds, crFlyFollow];
