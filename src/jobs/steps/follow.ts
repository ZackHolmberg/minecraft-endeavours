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
import { navigate } from "../../skills/navigation.js";
import { ensureMovements, type BotWithPathfinder } from "../../skills/pathfinder-config.js";
import { getBotState } from "../../state/index.js";
import { FollowTracker, followProgress, type FollowAction, type FollowObs, type Waypoint } from "../follow.js";
import type { FollowDeps, FollowRunContext } from "../runner.js";
import type { FollowOutcome, FollowState } from "../types.js";

const { goals } = pathfinderPkg;

const TICK_MS = 250;
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
      const act: FollowAction = tracker.step(observe());
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
  }
}
