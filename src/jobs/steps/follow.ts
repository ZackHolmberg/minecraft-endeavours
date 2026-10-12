/**
 * Bot-bound half of the `follow` job: keeps a dynamic `GoalFollow` on the player while
 * they are in view, and runs the lost-sight search (src/jobs/follow.ts) when they are not.
 *
 * Movement is the same stack `goTo` / the old blocking `followPlayer` use: the shared
 * Movements (doors and gates open, natural-terrain-only digging, never places) and
 * `navigate` for the search legs (stuck detection, timeout, cancellation). The reflexes keep
 * working because this runs outside `runSkill` (no current-tool slot): auto-eat, the defensive
 * swing and the idle look all see an idle bot. The surfacing reflex drops the pathfinder goal
 * when it takes the controls; the loop re-issues the follow goal once it is done.
 */
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { isSurfacing } from "../../skills/auto-behaviors.js";
import { flyFollowTick, isFlying, land, stopFlyingNow } from "../../skills/flight.js";
import { isCreative } from "../../skills/game-mode.js";
import { navigate } from "../../skills/navigation.js";
import { ensureMovements, type BotWithPathfinder } from "../../skills/pathfinder-config.js";
import { getBotState } from "../../state/index.js";
import { FlightGate, FollowTracker, followProgress, playerAirborne, type FollowAction, type FollowObs, type Waypoint } from "../follow.js";
import type { FollowDeps, FollowRunContext } from "../runner.js";
import type { FollowOutcome, FollowState } from "../types.js";

const { goals } = pathfinderPkg;

const TICK_MS = 250;
/** While flying after a player the position is stepped every 50 ms (0.5 blocks per step = creative fly speed). */
const FLY_TICK_MS = 50;
/** Not moving for this long while flying after a player who is not next to us (a wall of terrain between us) => land and let the pathfinder try. */
const FLY_BLOCKED_LAND_MS = 6_000;
/** Glance at the followed player while parked next to them. */
const LOOK_RANGE = 8;
/** One search leg's hard cap (navigate's own stuck detection usually ends it sooner). */
const SEARCH_LEG_TIMEOUT_MS = 20_000;
const SEARCH_REACH = 2;

export function createFollowDeps(bot: Bot): FollowDeps {
  return { run: (spec, ctx) => runFollow(bot, spec, ctx) };
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function runFollow(bot: Bot, spec: FollowState, ctx: FollowRunContext): Promise<FollowOutcome> {
  const pBot = bot as BotWithPathfinder;
  const state = getBotState(bot.username);
  const tag = `[${bot.username}] job follow`;
  // A fresh job starts with a clean stop flag (a read-only starter tool does not clear it).
  state?.cancellation.begin();
  ensureMovements(pBot);

  const tracker = new FollowTracker({ dist: spec.dist });
  const gate = new FlightGate();
  /** Flight stuck watch: where the bot was when it last moved >= 1.5 blocks (or hovered next to the player), and when. Still there after FLY_BLOCKED_LAND_MS => land. */
  let flyAnchor: Vec3 | null = null;
  let flyAnchorAt = 0;
  /** After landing because the air route was blocked, walk for a while before taking off again (no hover/land ping-pong). */
  let noFlyUntil = 0;
  let flightNoted = false;
  let goal: InstanceType<typeof goals.GoalFollow> | null = null;
  let goalFor = -1;
  let lastProgress = "";
  const stopped = (): boolean => ctx.signal.aborted || state?.cancellation.isRequested() === true;
  const progress = (text: string): void => {
    if (text === lastProgress) return;
    lastProgress = text;
    ctx.progress(text);
  };

  const observe = (): FollowObs => {
    const info = bot.players[spec.player];
    const e = info?.entity;
    const p = bot.entity.position;
    return {
      now: Date.now(),
      online: !!info,
      target: e ? { x: e.position.x, y: e.position.y, z: e.position.z } : null,
      self: { x: p.x, y: p.y, z: p.z },
    };
  };

  const dropGoal = (): void => {
    goal = null;
    goalFor = -1;
    try {
      pBot.pathfinder.setGoal(null);
    } catch {
      // best-effort
    }
  };

  /** Keep a dynamic follow goal on the entity; re-issue it if something (a reflex, a search leg) dropped it. */
  const keepFollowing = (): void => {
    const e = bot.players[spec.player]?.entity;
    if (!e || isSurfacing(bot)) return;
    if (goal === null || goalFor !== e.id || pBot.pathfinder.goal !== goal) {
      goal = new goals.GoalFollow(e, spec.dist);
      goalFor = e.id;
      pBot.pathfinder.setGoal(goal, true);
    }
    // Pathfinder only steers while walking; parked next to them, face them like a person waiting would.
    if (!pBot.pathfinder.isMoving() && e.position.distanceTo(bot.entity.position) <= LOOK_RANGE) {
      bot.lookAt(e.position.offset(0, e.height ?? 1.62, 0)).catch(() => {});
    }
  };

  /** Creative only: is the followed player in the air (flying)? null = can't tell. */
  const airborneNow = (): boolean | null => {
    if (!isCreative(bot)) return false;
    const e = bot.players[spec.player]?.entity;
    if (!e) return null;
    const fx = Math.floor(e.position.x);
    const fz = Math.floor(e.position.z);
    const fy = Math.floor(e.position.y - 0.05);
    // NB: other players' `entity.onGround` is never updated by mineflayer (prismarine-entity initialises it to true): blocks only
    return playerAirborne(undefined, (dy) => {
      const b = bot.blockAt(new Vec3(fx, fy - dy + 1, fz));
      if (!b) return null;
      if (b.name === "water" || b.name === "lava") return "liquid";
      return b.boundingBox === "block" ? "solid" : "free";
    });
  };

  const landNow = async (why: string): Promise<void> => {
    if (!isFlying(bot)) return;
    console.log(`${tag} landing (${why})`);
    gate.reset();
    flyAnchor = null;
    if (why.startsWith("blocked")) noFlyUntil = Date.now() + 20_000;
    await land(bot);
  };

  /** One search leg: walk to a waypoint, abandoning it the moment the player is back, gone, or the budget is spent. */
  const searchLeg = async (wp: Waypoint): Promise<void> => {
    dropGoal();
    const { x, y, z } = wp.pos;
    const g = wp.exact ? new goals.GoalNear(x, y, z, SEARCH_REACH) : new goals.GoalNearXZ(x, z, SEARCH_REACH);
    let interrupted = false;
    const watcher = setInterval(() => {
      if (stopped() || tracker.interrupts(observe())) {
        interrupted = true;
        try {
          pBot.pathfinder.setGoal(null); // makes the goto reject at once
        } catch {
          // best-effort
        }
      }
    }, TICK_MS);
    try {
      const res = await navigate(bot, g, {
        label: `${spec.player}: ${wp.label}`,
        target: new Vec3(x, y, z),
        timeoutMs: SEARCH_LEG_TIMEOUT_MS,
        escape: "none",
      });
      if (!res.ok) console.log(`${tag} search leg (${wp.label}) failed: ${res.message}`);
    } finally {
      clearInterval(watcher);
    }
    if (!interrupted) tracker.waypointDone();
  };

  console.log(`${tag} start: ${spec.player} at ~${spec.dist} blocks`);
  try {
    while (!stopped()) {
      if (Date.now() >= ctx.deadline) {
        return { ok: true, detail: `followed ${spec.player} for the full time limit` };
      }
      if (!bot.entity) {
        await sleepAbortable(TICK_MS, ctx.signal);
        continue;
      }
      // Creative: follow a flying player through the air; land when they land (or the controls are taken away).
      const fly = isCreative(bot) && Date.now() >= noFlyUntil ? gate.update(Date.now(), airborneNow()) : false;
      if (!fly && isFlying(bot)) await landNow("player is on the ground");
      if (!isCreative(bot) && isFlying(bot)) stopFlyingNow(bot);
      const obs = observe();
      const act: FollowAction = tracker.step(obs);
      if (isFlying(bot) && (act.kind === "search" || act.kind === "fail")) await landNow("lost sight of the player");
      if (fly && act.kind === "follow" && obs.target) {
        if (!flightNoted) {
          flightNoted = true;
          console.log(`${tag} ${spec.player} is flying: following through the air`);
          ctx.record({ kind: "recovery", jobId: ctx.jobId, rung: "fly", detail: `${spec.player} is airborne; flying after them` });
        }
        if (pBot.pathfinder.goal) dropGoal();
        const r = flyFollowTick(bot, new Vec3(obs.target.x, obs.target.y, obs.target.z), spec.dist);
        progress(r.arrived ? `flying with ${spec.player}` : `flying after ${spec.player}`);
        if (r.arrived || !flyAnchor || bot.entity.position.distanceTo(flyAnchor) >= 1.5) {
          flyAnchor = bot.entity.position.clone();
          flyAnchorAt = Date.now();
        } else if (Date.now() - flyAnchorAt >= FLY_BLOCKED_LAND_MS) {
          await landNow("blocked in the air");
        }
        await sleepAbortable(FLY_TICK_MS, ctx.signal);
        continue;
      }
      const lostS = Math.round(tracker.lostForMs(Date.now()) / 1000);
      switch (act.kind) {
        case "fail":
          console.log(`${tag} ended: ${act.why} — ${act.reason}`);
          return { ok: false, kind: "unreachable", detail: act.reason };
        case "follow":
          if (act.reacquired) {
            console.log(`${tag} re-acquired ${spec.player}`);
            ctx.record({ kind: "recovery", jobId: ctx.jobId, rung: "reacquired", detail: `found ${spec.player} again after ${lostS}s` });
          }
          progress(followProgress(spec.player, act, lostS));
          keepFollowing();
          break;
        case "search": {
          if (act.index === 0) {
            const at = tracker.lastKnown();
            console.log(`${tag} lost sight of ${spec.player}${at ? ` (last seen ${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)})` : ""}: searching`);
            ctx.record({ kind: "recovery", jobId: ctx.jobId, rung: "search", detail: `lost sight of ${spec.player}; walking to the last known position` });
          }
          progress(followProgress(spec.player, act, lostS));
          await searchLeg(act.waypoint);
          continue; // re-evaluate at once (they may be back)
        }
        case "wait":
          if (act.why === "waiting") {
            if (pBot.pathfinder.goal) dropGoal();
            progress(followProgress(spec.player, act, lostS));
          } else if (act.why === "offline") {
            progress(`${spec.player} is no longer in the player list`);
          }
          break;
      }
      await sleepAbortable(TICK_MS, ctx.signal);
    }
    return { ok: true, detail: "stopped" };
  } finally {
    dropGoal();
    // stopped, replaced or failed while airborne: come down (a cancelled job's next skill lands first anyway; this covers `say`-only turns)
    if (isFlying(bot)) stopFlyingNow(bot);
  }
}
