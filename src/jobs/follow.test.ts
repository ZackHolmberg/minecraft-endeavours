import { describe, expect, it } from "vitest";
import type { TelemetryInput } from "../observability/telemetry.js";
import { formatJobEvent, jobContextLines, jobLabel } from "./describe.js";
import {
  FOLLOW_LEFT_GRACE_MS,
  FOLLOW_LOST_MS,
  FOLLOW_STUCK_MS,
  FollowTracker,
  movementDir,
  searchWaypoints,
  type FollowObs,
  type P3,
} from "./follow.js";
import { JobRunner, type FollowRunContext, type RunnerDeps } from "./runner.js";
import { shouldCancelJobFor } from "./tools.js";
import type { FollowOutcome, FollowState, Job } from "./types.js";

const P = (x: number, y: number, z: number): P3 => ({ x, y, z });
const obs = (now: number, target: P3 | null, o: Partial<FollowObs> = {}): FollowObs => ({ now, online: true, target, self: P(0, 64, 0), ...o });

describe("movementDir / searchWaypoints", () => {
  it("reads the walk direction from the last 3s of samples, null when standing", () => {
    expect(movementDir([{ t: 0, pos: P(0, 64, 0) }])).toBeNull();
    const d = movementDir([
      { t: 0, pos: P(0, 64, 0) },
      { t: 1000, pos: P(3, 64, 0) },
      { t: 2000, pos: P(6, 64, 0) },
    ])!;
    expect(d.x).toBeCloseTo(1);
    expect(d.z).toBeCloseTo(0);
    expect(movementDir([{ t: 0, pos: P(0, 64, 0) }, { t: 2000, pos: P(0.5, 64, 0.5) }])).toBeNull();
    // old samples outside the window are ignored: they walked +x long ago, then +z
    const turned = movementDir([
      { t: 0, pos: P(0, 64, 0) },
      { t: 5000, pos: P(30, 64, 0) },
      { t: 6000, pos: P(30, 64, 3) },
      { t: 7000, pos: P(30, 64, 6) },
    ])!;
    expect(turned.z).toBeCloseTo(1);
  });

  it("searches the last position first, then ahead along the heading; standing players get only the first", () => {
    const wps = searchWaypoints(P(10, 70, 10), { x: 0, z: 1 });
    expect(wps.map((w) => [w.pos.x, w.pos.z, w.exact])).toEqual([[10, 10, true], [10, 18, false], [10, 30, false]]);
    expect(searchWaypoints(P(1, 2, 3), null)).toHaveLength(1);
  });
});

describe("FollowTracker", () => {
  it("follows while the player is in view", () => {
    const t = new FollowTracker();
    expect(t.step(obs(0, P(5, 64, 0)))).toEqual({ kind: "follow", reacquired: false });
    expect(t.step(obs(250, P(5, 64, 1)))).toEqual({ kind: "follow", reacquired: false });
  });

  it("debounces a flicker, then searches last position -> ahead -> waits, and re-acquires", () => {
    const t = new FollowTracker();
    t.step(obs(0, P(0, 64, 0)));
    t.step(obs(1000, P(3, 64, 0)));
    t.step(obs(2000, P(6, 64, 0)));
    expect(t.step(obs(2100, null))).toEqual({ kind: "wait", why: "debounce" });
    const a = t.step(obs(3200, null));
    expect(a).toMatchObject({ kind: "search", index: 0, waypoint: { exact: true, pos: P(6, 64, 0) } });
    // same leg until the executor reports it done
    expect(t.step(obs(3500, null))).toMatchObject({ kind: "search", index: 0 });
    t.waypointDone();
    const b = t.step(obs(8000, null));
    expect(b).toMatchObject({ kind: "search", index: 1, waypoint: { exact: false } });
    if (b.kind === "search") expect(b.waypoint.pos.x).toBeCloseTo(14);
    t.waypointDone();
    t.waypointDone();
    expect(t.step(obs(20_000, null))).toEqual({ kind: "wait", why: "waiting" });
    expect(t.searching).toBe(true);
    expect(t.step(obs(21_000, P(30, 64, 0)))).toEqual({ kind: "follow", reacquired: true });
    expect(t.searching).toBe(false);
    // a second loss starts a fresh search from the new last position
    t.step(obs(22_000, null));
    expect(t.step(obs(23_500, null))).toMatchObject({ kind: "search", index: 0, waypoint: { pos: P(30, 64, 0) } });
  });

  it("a flicker shorter than the debounce is not a search and not a re-acquisition event", () => {
    const t = new FollowTracker();
    t.step(obs(0, P(5, 64, 0)));
    expect(t.step(obs(250, null))).toEqual({ kind: "wait", why: "debounce" });
    expect(t.step(obs(500, P(5, 64, 0)))).toEqual({ kind: "follow", reacquired: false });
  });

  it("fails only after the 45s budget with the player still online, naming the last seen spot", () => {
    const t = new FollowTracker();
    t.step(obs(0, P(10, 64, 20)));
    t.step(obs(1000, null)); // lost from here
    expect(t.step(obs(1000 + FOLLOW_LOST_MS - 1000, null)).kind).not.toBe("fail");
    const f = t.step(obs(1000 + FOLLOW_LOST_MS + 10, null));
    expect(f).toMatchObject({ kind: "fail", why: "lost" });
    if (f.kind === "fail") expect(f.reason).toContain("10, 64, 20");
  });

  it("fails as 'left' once the player is gone from the list past the grace period (not before)", () => {
    const t = new FollowTracker();
    t.step(obs(0, P(5, 64, 0)));
    expect(t.step(obs(100, null, { online: false }))).toEqual({ kind: "wait", why: "offline" });
    expect(t.step(obs(100 + FOLLOW_LEFT_GRACE_MS - 1, null, { online: false })).kind).toBe("wait");
    expect(t.step(obs(100 + FOLLOW_LEFT_GRACE_MS, null, { online: false }))).toMatchObject({ kind: "fail", why: "left" });
    // coming back inside the grace resets it
    const t2 = new FollowTracker();
    t2.step(obs(0, P(5, 64, 0)));
    t2.step(obs(100, null, { online: false }));
    t2.step(obs(200, P(5, 64, 0)));
    expect(t2.step(obs(100 + FOLLOW_LEFT_GRACE_MS + 10, null, { online: false })).kind).toBe("wait");
  });

  it("interrupts a search walk when they are back, gone, or the budget is spent", () => {
    const t = new FollowTracker();
    t.step(obs(0, P(0, 64, 0)));
    t.step(obs(2000, null));
    expect(t.interrupts(obs(3000, null))).toBe(false);
    expect(t.interrupts(obs(3000, P(1, 64, 1)))).toBe(true);
    expect(t.interrupts(obs(3000, null, { online: false }))).toBe(true);
    expect(t.interrupts(obs(2000 + FOLLOW_LOST_MS, null))).toBe(true);
  });

  it("fails as stuck when visible but never getting closer; moving or arriving resets it", () => {
    const t = new FollowTracker({ dist: 3 });
    const far = P(30, 64, 0);
    expect(t.step(obs(0, far)).kind).toBe("follow");
    expect(t.step(obs(FOLLOW_STUCK_MS - 100, far)).kind).toBe("follow");
    expect(t.step(obs(FOLLOW_STUCK_MS + 100, far))).toMatchObject({ kind: "fail", why: "stuck" });

    const t2 = new FollowTracker({ dist: 3 });
    t2.step(obs(0, far));
    // the bot is walking: anchor keeps resetting
    for (let i = 1; i <= 30; i++) expect(t2.step(obs(i * 5000, far, { self: P(i * 2, 64, 0) })).kind).toBe("follow");
    // parked right next to them for a long time is fine
    const t3 = new FollowTracker({ dist: 3 });
    for (let i = 0; i < 40; i++) expect(t3.step(obs(i * 5000, P(2, 64, 0))).kind).toBe("follow");
  });

  it("a re-acquisition starts the stuck clock fresh", () => {
    const t = new FollowTracker();
    const far = P(30, 64, 0);
    t.step(obs(0, far));
    t.step(obs(2000, null));
    t.step(obs(3500, null));
    expect(t.step(obs(60_000 - 1000, far)).kind).toBe("follow");
  });
});

// ── runner state transitions with a fake follow executor ─────────────────────

interface H {
  runner: JobRunner;
  events: TelemetryInput[];
  ended: Job[];
  saved: Job[];
  stops: number;
  ctxs: FollowRunContext[];
  specs: FollowState[];
  resolve: (o: FollowOutcome) => void;
}

function harness(opts: { follow?: boolean } = {}): H {
  const h: H = { events: [], ended: [], saved: [], stops: 0, ctxs: [], specs: [], resolve: () => {}, runner: null as never };
  const deps: RunnerDeps = {
    username: "bot",
    plan: () => ({ goals: [], steps: [], rawNeeds: {}, unresolved: [], summary: "" }),
    buildView: async () => ({}) as never,
    execute: async () => ({ ok: true, detail: "ok" }),
    explore: async () => ({ found: false, detail: "" }),
    countItem: () => 0,
    requestStop: () => {
      h.stops++;
    },
    record: (e) => h.events.push(e),
    load: () => null,
    save: (job) => h.saved.push(JSON.parse(JSON.stringify(job)) as Job),
    onEnd: (job) => h.ended.push(job),
    ...(opts.follow === false
      ? {}
      : {
          follow: {
            run: (spec, ctx) => {
              h.specs.push(spec);
              h.ctxs.push(ctx);
              return new Promise<FollowOutcome>((resolve) => {
                h.resolve = resolve;
                // like the real executor: resolve quietly when aborted
                ctx.signal.addEventListener("abort", () => resolve({ ok: true, detail: "stopped" }), { once: true });
              });
            },
          },
        }),
  };
  h.runner = new JobRunner(deps);
  return h;
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 2));
  }
};
const kinds = (h: H) => h.events.map((e) => e.kind);

describe("follow job in the runner", () => {
  it("starts at once, persists, emits job_start, shows 'following <player> (Ns)' in the context", async () => {
    const h = harness();
    const res = await h.runner.startFollow({ player: "Alex", dist: 3 }, "Alex");
    expect(res.ok).toBe(true);
    const job = h.runner.current()!;
    expect(job).toMatchObject({ kind: "follow", status: "running", requestedBy: "Alex" });
    expect(kinds(h)).toEqual(["job_start"]);
    expect(h.events[0]).toMatchObject({ goals: [{ item: "follow:Alex", count: 1 }] });
    expect(h.saved.at(-1)!.follow).toEqual({ player: "Alex", dist: 3 });
    expect(h.ctxs[0]!.deadline - job.startedAt).toBe(30 * 60_000);
    const lines = jobContextLines(job, job.startedAt + 42_000);
    expect(lines[0]).toBe("following Alex (42s)");
    expect(lines.join("\n")).toContain("keeps going while you chat");
    expect(jobLabel(job)).toBe("follow Alex");
  });

  it("progress from the executor lands in the job", async () => {
    const h = harness();
    await h.runner.startFollow({ player: "Alex", dist: 3 }, null);
    h.ctxs[0]!.progress("lost sight of Alex (5s): heading to where I last saw them");
    expect(h.runner.current()!.progress).toContain("lost sight of Alex");
  });

  it("a player stop cancels it quietly: job_end cancelled, no [job ...] event", async () => {
    const h = harness();
    await h.runner.startFollow({ player: "Alex", dist: 3 }, "Alex");
    h.runner.notifyStop("player");
    await until(() => h.runner.current()!.status === "cancelled");
    await until(() => kinds(h).includes("job_end"));
    expect(h.events.at(-1)).toMatchObject({ kind: "job_end", status: "cancelled" });
    expect(h.ended).toHaveLength(0);
    expect(h.stops).toBeGreaterThan(0);
  });

  it("cancel() (a movement tool / cancelJob) ends it cancelled, no event", async () => {
    const h = harness();
    await h.runner.startFollow({ player: "Alex", dist: 3 }, null);
    await h.runner.cancel("superseded by goTo");
    expect(h.runner.current()!.status).toBe("cancelled");
    expect(h.ended).toHaveLength(0);
  });

  it("lost-sight failure ends failed/unreachable with the reason and DOES notify the agent", async () => {
    const h = harness();
    await h.runner.startFollow({ player: "Alex", dist: 3 }, "Alex");
    h.resolve({ ok: false, kind: "unreachable", detail: "lost sight of the player and couldn't find them again in 45s" });
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("failed");
    expect(job.failure).toMatchObject({ kind: "unreachable" });
    expect(h.events.at(-1)).toMatchObject({ kind: "job_end", status: "failed", failureKind: "unreachable" });
    const text = formatJobEvent(job)!;
    expect(text).toContain("[job failed]");
    expect(text).toContain("following Alex");
    expect(text).toContain("couldn't find them again in 45s");
    expect(text).not.toContain("remaining plan");
  });

  it("the time cap ends it done with a [job finished] event", async () => {
    const h = harness();
    await h.runner.startFollow({ player: "Alex", dist: 3 }, "Alex");
    h.resolve({ ok: true, detail: "followed for the full time limit" });
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.status).toBe("done");
    expect(formatJobEvent(h.runner.current()!)).toContain("[job finished] stopped following Alex");
  });

  it("a new job replaces a running follow (cancelled, no event); a death ends it failed/died", async () => {
    const h = harness();
    await h.runner.startFollow({ player: "Alex", dist: 3 }, null);
    const first = h.runner.current()!;
    await h.runner.startFollow({ player: "Sam", dist: 2 }, null);
    expect(first.status).toBe("cancelled");
    expect(h.runner.current()).toMatchObject({ status: "running", follow: { player: "Sam", dist: 2 } });
    expect(h.ended).toHaveLength(0);
    h.runner.notifyStop("death");
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.failure).toMatchObject({ kind: "died" });
    expect(h.runner.current()!.failure!.detail).toContain("following Sam");
  });

  it("dispose (reconnect) interrupts it with no event; a missing executor refuses", async () => {
    const h = harness();
    await h.runner.startFollow({ player: "Alex", dist: 3 }, null);
    await h.runner.dispose();
    expect(h.runner.current()!.status).toBe("interrupted");
    expect(h.ended).toHaveLength(0);
    const none = harness({ follow: false });
    const res = await none.runner.startFollow({ player: "Alex", dist: 3 }, null);
    expect(res.ok).toBe(false);
  });

  it("chat does not end it: say/whisper never auto-cancel a running job, movement tools do", () => {
    expect(shouldCancelJobFor("say", true)).toBe(false);
    expect(shouldCancelJobFor("whisper", true)).toBe(false);
    expect(shouldCancelJobFor("observeSurroundings", true)).toBe(false);
    expect(shouldCancelJobFor("goTo", true)).toBe(true);
  });
});
