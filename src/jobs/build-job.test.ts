import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import type { FailureKind, Goal, Plan, Step, WorldView } from "../planner/types.js";
import type { TelemetryInput } from "../observability/telemetry.js";
import { formatJobEvent, jobContextLines } from "./describe.js";
import { JobRunner, type BuildDeps, type BuildHistory, type BuildRunContext, type DeliverFn, type NightDeps, type RunnerDeps } from "./runner.js";
import type { BuildOutcome, BuildPrep, BuildSpec, Job, StepResult } from "./types.js";

const gather = (item: string, count: number): Step => ({ op: "gather", item, count, blocks: [item], tool: null });
const mkPlan = (steps: Step[], goals: Goal[] = [{ item: "x", count: 1 }]): Plan => ({ goals, steps, rawNeeds: {}, unresolved: [], summary: steps.map((s) => s.op).join(" → ") || "nothing" });
const SPEC: BuildSpec = { blueprint: "house", params: { wall: "oak_planks" }, anchor: { x: 0, y: 64, z: 0 }, avoid: [{ x: 0, y: 64, z: 0 }] };
const prepOk = (missing: Goal[] = [], over: Partial<Extract<BuildPrep, { ok: true }>> = {}): BuildPrep => ({
  ok: true,
  origin: { x: 3, y: 64, z: 3 },
  facing: "south",
  params: { wall: "oak_planks" },
  summary: "5x5 oak_planks house at (3, 64, 3)",
  total: 55,
  missing,
  payload: null,
  ...over,
});
const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 2));
  }
};

interface H {
  runner: JobRunner;
  events: TelemetryInput[];
  ended: Job[];
  prepares: Array<{ existing: unknown; scaffolds?: unknown; spec?: BuildSpec }>;
  reserved: Array<Record<string, number> | null>;
  ctxs: BuildRunContext[];
  runs: number;
  delivered: Array<{ to: string; goals: Goal[] }>;
}

function harness(o: {
  plans?: Plan[];
  prepare?: (n: number) => BuildPrep;
  run?: (n: number) => BuildOutcome | Promise<BuildOutcome>;
  deliver?: (to: string, goals: Goal[]) => StepResult | Promise<StepResult>;
  step?: () => StepResult;
  history?: BuildHistory;
  onBuildEnd?: (j: Job) => void;
  night?: NightDeps;
}): H {
  const h: H = { events: [], ended: [], prepares: [], reserved: [], ctxs: [], runs: 0, delivered: [], runner: null as never };
  const plans = [...(o.plans ?? [mkPlan([])])];
  const build: BuildDeps = {
    prepare: async (spec, existing, scaffolds) => {
      h.prepares.push({ existing, scaffolds, spec });
      return o.prepare ? o.prepare(h.prepares.length - 1) : prepOk();
    },
    run: async (_prep, ctx) => {
      h.ctxs.push(ctx);
      const n = h.runs++;
      return o.run ? o.run(n) : { ok: true, placed: 55, total: 55, detail: "built" };
    },
  };
  const deliver: DeliverFn = async (to, goals) => {
    h.delivered.push({ to, goals });
    return o.deliver ? o.deliver(to, goals) : { ok: true, detail: "gave" };
  };
  const deps: RunnerDeps = {
    username: "bot",
    plan: () => (plans.length > 1 ? plans.shift()! : plans[0]!),
    buildView: async () => ({}) as WorldView,
    execute: async () => (o.step ? o.step() : { ok: true, detail: "ok" }),
    explore: async () => ({ found: false, detail: "" }),
    countItem: () => 0,
    requestStop: () => {},
    record: (e) => h.events.push(e),
    load: () => null,
    save: () => {},
    onEnd: (j) => h.ended.push(JSON.parse(JSON.stringify(j)) as Job),
    reserve: (items) => h.reserved.push(items),
    buildHistory: o.history,
    onBuildEnd: o.onBuildEnd,
    build,
    deliver,
    ...(o.night ? { night: o.night } : {}),
  };
  h.runner = new JobRunner(deps);
  return h;
}

describe("build job", () => {
  it("no materials gap: prepare → run → done, telemetry has a build step and placed/total on job_end", async () => {
    const h = harness({});
    const r = await h.runner.startBuild(SPEC, "Alex");
    expect(r.ok).toBe(true);
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.kind).toBe("build");
    expect(job.status).toBe("done");
    expect(job.build).toMatchObject({ blueprint: "house", total: 55, placed: 55, origin: { x: 3, y: 64, z: 3 }, facing: "south" });
    expect(h.events.map((e) => e.kind)).toEqual(["job_start", "step", "job_end"]);
    expect(h.events[1]).toMatchObject({ op: "build", item: "house", ok: true });
    expect(h.events[2]).toMatchObject({ status: "done", placed: 55, total: 55 });
    // the site is chosen once; later phases reuse it
    expect(h.prepares[0]!.existing).toBeNull();
    expect(h.prepares[1]!.existing).toMatchObject({ origin: { x: 3, y: 64, z: 3 }, facing: "south" });
    expect(h.prepares).toHaveLength(2);
    expect(formatJobEvent(h.ended[0]!)).toMatch(/^\[job finished\] build house .* 55\/55 blocks placed \(requested by Alex/);
  });

  it("materials gap: runs the planner steps inside the same job, then builds", async () => {
    const missing = [{ item: "oak_planks", count: 20 }];
    let prep = 0;
    const h = harness({
      plans: [mkPlan([gather("oak_log", 5)], missing), mkPlan([])],
      prepare: () => (prep++ < 1 ? prepOk(missing) : prepOk([])), // at start: short; after gathering: ok
    });
    const r = await h.runner.startBuild(SPEC, null);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/First get materials: gather/);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.status).toBe("done");
    const ops = h.events.filter((e) => e.kind === "step").map((e) => (e as { op: string }).op);
    expect(ops).toEqual(["gather", "build"]);
    expect(h.runs).toBe(1);
    // after gathering (nothing built yet) the site is picked afresh; it is fixed once placing starts
    expect(h.prepares.map((p) => p.existing === null)).toEqual([true, true]);
  });

  it("refuses to start when there is no site or the materials can't be planned", async () => {
    const h = harness({ prepare: () => ({ ok: false, kind: "no_site", detail: "no spot for the house: water" }) });
    const r = await h.runner.startBuild(SPEC, null);
    expect(r).toMatchObject({ ok: false, jobId: null });
    expect(r.message).toContain("no spot");
    expect(h.runner.isRunning()).toBe(false);

    const impossible = mkPlan([], [{ item: "water_bucket", count: 1 }]);
    impossible.unresolved = [{ item: "water_bucket", count: 1, reason: "not_obtainable: no known way" }];
    const h2 = harness({ plans: [impossible], prepare: () => prepOk([{ item: "water_bucket", count: 1 }]) });
    const r2 = await h2.runner.startBuild({ ...SPEC, blueprint: "farm" }, null);
    expect(r2.ok).toBe(false);
    expect(r2.message).toMatch(/missing materials I can't get: 1 water_bucket/);
  });

  it("a partial build is retried on the SAME site (resumes) and then succeeds; counts come from the last outcome", async () => {
    const h = harness({
      run: (n) => (n === 0 ? { ok: false, kind: "build_incomplete", detail: "placed 40/55 blocks", placed: 40, total: 55 } : { ok: true, placed: 55, total: 55, detail: "built" }),
    });
    await h.runner.startBuild(SPEC, null);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.status).toBe("done");
    expect(h.runs).toBe(2);
    expect(h.prepares.map((p) => p.existing === null)).toEqual([true, false, false]);
    expect(h.events.filter((e) => e.kind === "recovery")).toHaveLength(1);
  });

  it("gives up after repeated failures with a typed failure and the placed count; the event tells the model", async () => {
    const h = harness({ run: () => ({ ok: false, kind: "build_incomplete", detail: "door would not place", placed: 52, total: 55 }) });
    await h.runner.startBuild(SPEC, "Sam");
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("failed");
    expect(job.failure).toMatchObject({ kind: "build_incomplete" });
    expect(job.failure!.detail).toContain("52/55");
    expect(h.runs).toBe(3);
    const text = formatJobEvent(h.ended[0]!)!;
    expect(text).toMatch(/^\[job failed\] build house/);
    expect(text).toContain("build_incomplete");
    expect(text).not.toContain("remaining plan");
  });

  it("no retry for out-of-materials / no-site kinds; cancelled outcome cancels quietly", async () => {
    const kinds: FailureKind[] = ["no_site", "inventory_full"];
    for (const k of kinds) {
      const h = harness({ run: () => ({ ok: false, kind: k, detail: k, placed: 3, total: 55 }) });
      await h.runner.startBuild(SPEC, null);
      await until(() => h.ended.length === 1);
      expect(h.runs).toBe(1);
      expect(h.runner.current()!.failure!.kind).toBe(k);
    }
    const c = harness({ run: () => ({ ok: false, kind: "cancelled", detail: "stop", placed: 3, total: 55 }) });
    await c.runner.startBuild(SPEC, null);
    await until(() => c.runner.current()!.status === "cancelled");
    expect(c.ended).toHaveLength(0);
  });

  it("player stop mid-build cancels the job and aborts the signal", async () => {
    let signal: AbortSignal | undefined;
    const base = harness({});
    void base;
    const events: TelemetryInput[] = [];
    const deps: RunnerDeps = {
      username: "bot",
      plan: () => mkPlan([]),
      buildView: async () => ({}) as WorldView,
      execute: async () => ({ ok: true, detail: "" }),
      explore: async () => ({ found: false, detail: "" }),
      countItem: () => 0,
      requestStop: () => {},
      record: (e) => events.push(e),
      load: () => null,
      save: () => {},
      build: {
        prepare: async () => prepOk(),
        run: (_p, ctx) =>
          new Promise<BuildOutcome>((resolve) => {
            signal = ctx.signal;
            ctx.signal.addEventListener("abort", () => resolve({ ok: false, kind: "cancelled", detail: "stopped", placed: 5, total: 55 }));
          }),
      },
    };
    const runner = new JobRunner(deps);
    await runner.startBuild(SPEC, null);
    await until(() => signal !== undefined);
    runner.notifyStop("player");
    await until(() => runner.current()!.status === "cancelled");
    expect(signal!.aborted).toBe(true);
  });

  it("context lines describe a running build", async () => {
    let release: (o: BuildOutcome) => void = () => {};
    const h = harness({ run: () => new Promise<BuildOutcome>((r) => (release = r)) });
    await h.runner.startBuild(SPEC, "Alex");
    await until(() => h.runs === 1);
    const lines = jobContextLines(h.runner.current());
    expect(lines[0]).toMatch(/^running: build house \(5x5 oak_planks house/);
    release({ ok: true, placed: 55, total: 55, detail: "" });
    await until(() => h.ended.length === 1);
  });
});

describe("build job: reservations, resume, scaffolds, lifecycle (slice 3 review M2/M3/M7/H2)", () => {
  const PARTIAL = { origin: { x: 10, y: 64, z: 10 }, facing: "east" as const, params: { wall: "spruce_planks" }, placed: 30, total: 57 };

  it("M2: reserves the build's materials for the whole job (also across a materials replan) and releases at the end", async () => {
    const missing = [{ item: "oak_planks", count: 20 }];
    let prep = 0;
    const h = harness({
      plans: [mkPlan([gather("oak_log", 5)], missing), mkPlan([])],
      prepare: () => (prep++ < 1 ? prepOk(missing, { reserve: ["oak_planks", "glass", "oak_door"] }) : prepOk([], { reserve: ["oak_planks", "glass", "oak_door"] })),
    });
    await h.runner.startBuild(SPEC, null);
    await until(() => h.ended.length === 1);
    const nonNull = h.reserved.filter((r): r is Record<string, number> => r !== null);
    expect(nonNull.length).toBeGreaterThan(1);
    for (const r of nonNull) expect(Object.keys(r)).toEqual(expect.arrayContaining(["oak_planks", "glass", "oak_door"]));
    expect(nonNull[0]!["oak_planks"]).toBe(Number.POSITIVE_INFINITY);
    expect(h.reserved.at(-1)).toBeNull();
  });

  it("M2: reserves even when nothing is missing (stocked / creative)", async () => {
    const h = harness({ prepare: () => prepOk([], { reserve: ["cobblestone", "dirt"] }) });
    await h.runner.startBuild(SPEC, null);
    await until(() => h.ended.length === 1);
    expect(h.reserved.find((r) => r !== null)).toMatchObject({ cobblestone: Number.POSITIVE_INFINITY, dirt: Number.POSITIVE_INFINITY });
  });

  it("M3: a re-build near an unfinished one resumes at its stored origin/facing/params instead of siting a second house", async () => {
    const h = harness({
      history: { refusal: () => null, partial: () => PARTIAL },
      prepare: () => prepOk([], { origin: PARTIAL.origin, facing: "east", params: PARTIAL.params, summary: "7x6 spruce house" }),
    });
    const r = await h.runner.startBuild(SPEC, "Alex");
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/continuing the unfinished house at 10, 64, 10 \(30\/57/);
    await until(() => h.ended.length === 1);
    expect(h.prepares[0]!.existing).toEqual({ origin: PARTIAL.origin, facing: "east" });
    expect(h.prepares[0]!.spec!.params).toEqual(PARTIAL.params); // the old structure's blueprint params, not the new request's
    expect(h.runner.current()!.build).toMatchObject({ resumed: true, placed: 55 });
    expect(h.prepares.every((p) => p.existing !== null)).toBe(true); // never re-sited
  });

  it("M3: a resumed build is not re-sited after a materials round either", async () => {
    const missing = [{ item: "oak_planks", count: 5 }];
    let n = 0;
    const h = harness({
      history: { refusal: () => null, partial: () => PARTIAL },
      plans: [mkPlan([gather("oak_log", 2)], missing), mkPlan([])],
      prepare: () => (n++ < 1 ? prepOk(missing, { origin: PARTIAL.origin }) : prepOk([], { origin: PARTIAL.origin })),
    });
    await h.runner.startBuild(SPEC, null);
    await until(() => h.ended.length === 1);
    expect(h.prepares.filter((p) => p.existing === null)).toHaveLength(0);
  });

  it("M3: if the unfinished structure cannot be continued, refuses with a message (no second house)", async () => {
    const h = harness({
      history: { refusal: () => null, partial: () => PARTIAL },
      prepare: () => ({ ok: false, kind: "no_site", detail: "the player's wall is in the way" }),
    });
    const r = await h.runner.startBuild(SPEC, null);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/unfinished house \(30\/57\) at 10, 64, 10 and I can't continue it.*won't start a second one/);
    expect(h.runner.isRunning()).toBe(false);
  });

  it("M3: the ledger refusal stops a build that keeps failing at the same place", async () => {
    const h = harness({ history: { refusal: () => "not started: the house already failed 2 times near here", partial: () => null } });
    const r = await h.runner.startBuild(SPEC, null);
    expect(r).toMatchObject({ ok: false, jobId: null });
    expect(r.message).toMatch(/already failed 2 times/);
    expect(h.prepares).toHaveLength(0);
  });

  it("M3: onBuildEnd fires for failed, cancelled and done builds; a stop's final count updates the record", async () => {
    const seen: Array<{ status: string; placed: number }> = [];
    const f = harness({ run: () => ({ ok: false, kind: "build_incomplete", detail: "x", placed: 40, total: 55 }), onBuildEnd: (j) => seen.push({ status: j.status, placed: j.build!.placed }) });
    await f.runner.startBuild(SPEC, null);
    await until(() => f.ended.length === 1);
    expect(seen.at(-1)).toEqual({ status: "failed", placed: 40 });

    seen.length = 0;
    const ok = harness({ onBuildEnd: (j) => seen.push({ status: j.status, placed: j.build!.placed }) });
    await ok.runner.startBuild(SPEC, null);
    await until(() => ok.ended.length === 1);
    expect(seen.at(-1)).toMatchObject({ status: "done" });

    seen.length = 0;
    let release: (o: BuildOutcome) => void = () => {};
    const c = harness({ run: () => new Promise<BuildOutcome>((r) => (release = r)), onBuildEnd: (j) => seen.push({ status: j.status, placed: j.build!.placed }) });
    await c.runner.startBuild(SPEC, null);
    await until(() => c.runs === 1);
    c.runner.notifyStop("player");
    await until(() => seen.length > 0);
    expect(seen[0]).toEqual({ status: "cancelled", placed: 0 });
    release({ ok: false, kind: "cancelled", detail: "stopped", placed: 12, total: 55 });
    await until(() => seen.length > 1);
    expect(seen[1]).toEqual({ status: "cancelled", placed: 12 });
  });

  it("H2: scaffold positions the builder reports are persisted on the job, named in the failure, and handed to the next prepare/run", async () => {
    const cell = { x: 4, y: 65, z: 4, item: "dirt" };
    const h = harness({
      run: (n) => {
        if (n < 3) h.ctxs[n]!.setScaffolds([cell]);
        return { ok: false, kind: "build_incomplete", detail: "stuck", placed: 20, total: 55 };
      },
    });
    await h.runner.startBuild(SPEC, null);
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.scaffolds).toEqual([cell]);
    expect(job.failure!.detail).toMatch(/left 1 dirt at \(4, 65, 4\)/);
    expect(h.ctxs[1]!.scaffolds).toEqual([cell]); // retry attempt sees the leftover
    expect(h.prepares.at(-1)!.scaffolds).toEqual([cell]);

    // the next job (any kind) inherits what is still standing
    await h.runner.startBuild(SPEC, null);
    expect(h.prepares.at(-1)!.scaffolds).toEqual([cell]);
    await until(() => h.runner.current()!.status !== "running");
    expect(h.ctxs.at(-1)!.scaffolds).toEqual([cell]);
  });

  it("H2: an empty report clears the persisted list", async () => {
    const h = harness({
      run: () => {
        h.ctxs[0]!.setScaffolds([{ x: 1, y: 2, z: 3, item: "dirt" }]);
        h.ctxs[0]!.setScaffolds([]);
        return { ok: true, placed: 55, total: 55, detail: "built" };
      },
    });
    await h.runner.startBuild(SPEC, null);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.scaffolds).toBeUndefined();
  });

  it("H2: reclaimOrphans removes leftovers from job.json at boot and keeps those that could not be removed", async () => {
    const stored: Job = {
      id: "old", kind: "build", goals: [], requestedBy: null, status: "failed", startedAt: 1, endedAt: 2, plan: mkPlan([]), stepIndex: 0, replans: 0, progress: "", failure: null,
      scaffolds: [{ x: 1, y: 64, z: 1, item: "dirt" }, { x: 2, y: 64, z: 2, item: "dirt" }],
    };
    const saved: Job[] = [];
    const reclaim = vi.fn(async (cells: Array<{ x: number; y: number; z: number; item: string }>) => cells.slice(1));
    const runner = new JobRunner({
      username: "bot", plan: () => mkPlan([]), buildView: async () => ({}) as WorldView, execute: async () => ({ ok: true, detail: "" }),
      explore: async () => ({ found: false, detail: "" }), countItem: () => 0, requestStop: () => {}, record: () => {},
      load: () => stored, save: (j) => saved.push(JSON.parse(JSON.stringify(j)) as Job),
      build: { prepare: async () => prepOk(), run: async () => ({ ok: true, placed: 1, total: 1, detail: "" }), reclaim },
    });
    await runner.reclaimOrphans();
    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(runner.current()!.scaffolds).toEqual([{ x: 2, y: 64, z: 2, item: "dirt" }]);
    expect(saved.at(-1)!.scaffolds).toEqual([{ x: 2, y: 64, z: 2, item: "dirt" }]);
  });

  it("M7: an abandoned build attempt is aborted and finished before the next one starts; retries fit the job time cap", async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let maxActive = 0;
      const h = harness({
        run: (n) =>
          new Promise<BuildOutcome>((resolve) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            const ctx = h.ctxs[n]!;
            // ignores the cooperative stop; only the attempt's abort signal ends it (after a 3 s clean-up)
            ctx.signal.addEventListener("abort", () => {
              setTimeout(() => {
                active -= 1;
                resolve({ ok: false, kind: "cancelled", detail: "aborted", placed: 5, total: 55 });
              }, 3_000);
            });
          }),
      });
      await h.runner.startBuild(SPEC, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.runs).toBe(1);
      await vi.advanceTimersByTimeAsync(14 * 60_000 + 25_000); // limit + grace -> abandoned, then aborted
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.ctxs[0]!.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 60_000); // second attempt abandoned too
      await vi.advanceTimersByTimeAsync(60_000);
      expect(maxActive).toBe(1);
      const job = h.runner.current()!;
      expect(job.status).toBe("failed");
      expect(job.failure!.detail).toMatch(/no time left for another build attempt/);
      expect(h.runs).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("deliver", () => {
  const BREAD: Goal[] = [{ item: "bread", count: 3 }];

  it("already holding the items: a deliver-only job hands them over and finishes", async () => {
    const h = harness({ plans: [mkPlan([], BREAD)] });
    const r = await h.runner.start(BREAD, "Tester", { deliverTo: "Tester" });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("hand over bread x3");
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.status).toBe("done");
    expect(h.delivered).toEqual([{ to: "Tester", goals: BREAD }]);
    const step = h.events.find((e) => e.kind === "step") as { op: string; ok: boolean };
    expect(step).toMatchObject({ op: "deliver", ok: true });
    expect(formatJobEvent(h.ended[0]!)).toMatch(/handed over/);
  });

  it("without deliverTo an already-satisfied goal is still 'nothing to do'", async () => {
    const h = harness({ plans: [mkPlan([], BREAD)] });
    const r = await h.runner.start(BREAD, "Tester");
    expect(r.ok).toBe(false);
    expect(h.delivered).toHaveLength(0);
  });

  it("gathers first, then delivers once the goals are met", async () => {
    const h = harness({ plans: [mkPlan([gather("wheat", 3)], BREAD), mkPlan([])] });
    await h.runner.start(BREAD, "Alex", { deliverTo: "Alex" });
    await until(() => h.ended.length === 1);
    expect(h.events.filter((e) => e.kind === "step").map((e) => (e as { op: string }).op)).toEqual(["gather", "deliver"]);
    expect(h.runner.current()!.deliverTo).toBe("Alex");
  });

  it("a failed hand-over fails the job with the reason (items stay in the inventory)", async () => {
    const h = harness({
      plans: [mkPlan([], BREAD)],
      deliver: () => ({ ok: false, failure: { kind: "unreachable", step: gather("x", 1), detail: "Alex isn't within sight", attempts: 1 } }),
    });
    await h.runner.start(BREAD, "Alex", { deliverTo: "Alex" });
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("failed");
    expect(job.failure).toMatchObject({ kind: "unreachable", detail: "Alex isn't within sight" });
    expect(formatJobEvent(h.ended[0]!)).toMatch(/\[job failed\] achieve bread x3 → give to Alex .* unreachable/);
  });
});

// ── createDeliver against a fake bot ──────────────────────────────────────────

vi.mock("./steps/util.js", () => ({
  itemCount: (bot: { inv: Record<string, number> }, item: string) => bot.inv[item] ?? 0,
  tracked: (_bot: unknown, _name: string, params: unknown, fn: (p: unknown) => Promise<unknown>) => fn(params),
}));
const giveMock = vi.fn();
vi.mock("../skills/inventory.js", () => ({ giveItemsTo: (...a: unknown[]) => giveMock(...a) }));
vi.mock("../skills/creative.js", () => ({ getItems: vi.fn(async () => ({ ok: true, message: "got" })) }));
vi.mock("../skills/game-mode.js", () => ({ isCreative: (b: { creative?: boolean }) => b.creative === true }));

describe("createDeliver (fake bot)", () => {
  interface FakeBot {
    inv: Record<string, number>;
    creative?: boolean;
    players: Record<string, { entity: object | null }>;
    entities: Record<string, { name: string; position: { distanceTo(): number }; getDroppedItem(): { name: string; count: number } }>;
    entity: { position: object };
  }
  const mk = (inv: Record<string, number>, over: Partial<FakeBot> = {}): FakeBot => ({
    inv: { ...inv },
    players: { Tester: { entity: {} } },
    entities: {},
    entity: { position: {} },
    ...over,
  });
  const ctx = (aborted = false) => ({ signal: { aborted } as AbortSignal, radius: 64, baseline: 0, jobId: "j" });
  const drop = (bot: FakeBot, name: string, count: number, id = "e1"): void => {
    bot.entities[id] = { name: "item", position: { distanceTo: () => 2 }, getDroppedItem: () => ({ name, count }) };
  };

  it("tosses, sees the drops get picked up, and reports success", async () => {
    const { createDeliver } = await import("./steps/deliver.js");
    const bot = mk({ bread: 6 });
    giveMock.mockImplementationOnce(async () => {
      bot.inv["bread"] = 3;
      drop(bot, "bread", 3);
      setTimeout(() => delete bot.entities["e1"], 300); // the player walks over and picks it up
      return { ok: true, message: "gave 3 bread to Tester" };
    });
    const res = await createDeliver(bot as unknown as Bot)("tester", [{ item: "bread", count: 3 }], ctx());
    expect(res).toMatchObject({ ok: true });
    expect(giveMock).toHaveBeenCalledWith(bot, { player: "Tester", items: [{ item: "bread", count: 3 }] });
  });

  it("fails when the items stay on the ground, when the player is out of sight, and when the stock is short", async () => {
    const { createDeliver } = await import("./steps/deliver.js");
    vi.useFakeTimers();
    try {
      const bot = mk({ torch: 64 });
      giveMock.mockImplementationOnce(async () => {
        bot.inv["torch"] = 0;
        drop(bot, "torch", 64);
        return { ok: true, message: "gave" };
      });
      const p = createDeliver(bot as unknown as Bot)("Tester", [{ item: "torch", count: 64 }], ctx());
      await vi.advanceTimersByTimeAsync(11_000);
      const res = await p;
      expect(res).toMatchObject({ ok: false, failure: { kind: "unreachable" } });
      expect((res as { failure: { detail: string } }).failure.detail).toMatch(/still on the ground/);
    } finally {
      vi.useRealTimers();
    }
    const away = mk({ bread: 3 }, { players: { Tester: { entity: null } } });
    expect(await createDeliver(away as unknown as Bot)("Tester", [{ item: "bread", count: 3 }], ctx())).toMatchObject({ ok: false, failure: { kind: "unreachable" } });
    const short = mk({ bread: 1 });
    expect(await createDeliver(short as unknown as Bot)("Tester", [{ item: "bread", count: 3 }], ctx())).toMatchObject({ ok: false, failure: { kind: "missing_input" } });
  });

  it("creative: takes the items with getItems first", async () => {
    const { createDeliver } = await import("./steps/deliver.js");
    const creative = await import("../skills/creative.js");
    const bot = mk({ torch: 64 }, { creative: true });
    giveMock.mockImplementationOnce(async () => {
      bot.inv["torch"] = 0;
      return { ok: true, message: "gave" };
    });
    const res = await createDeliver(bot as unknown as Bot)("Tester", [{ item: "torch", count: 64 }], ctx());
    expect(res).toMatchObject({ ok: true });
    expect(creative.getItems).toHaveBeenCalledWith(bot, { items: [{ name: "torch", count: 64 }] });
  });
});


describe("survive the night job", () => {
  const NIGHT_SPEC: BuildSpec = { blueprint: "shelter", params: { wall: "dirt", door: false }, anchor: { x: 0, y: 64, z: 0 }, avoid: [], hold: "night" };
  const mkNight = (o: { time?: number | null; bed?: string | null; sleep?: () => Promise<StepResult>; hold?: (geo: unknown) => Promise<StepResult> } = {}) => {
    const calls: string[] = [];
    const geos: unknown[] = [];
    const night: NightDeps = {
      timeOfDay: () => (o.time === undefined ? 13_000 : o.time),
      findBed: () => (o.bed === undefined ? null : o.bed),
      sleepThrough: async () => {
        calls.push("sleep");
        return o.sleep ? o.sleep() : { ok: true, detail: "slept" };
      },
      holdInShelter: async (geo) => {
        calls.push("hold");
        geos.push(geo);
        return o.hold ? o.hold(geo) : { ok: true, detail: "waited out the night in a plugged shelter" };
      },
    };
    return { night, calls, geos };
  };
  const shelterPrep = (): BuildPrep => prepOk([], { params: { wall: "dirt", door: false }, summary: "5x5 dirt shelter at (3, 64, 3)", total: 57 });

  it("no bed: builds the shelter, then holds inside it until dawn, then ends done with the night's account", async () => {
    const n = mkNight();
    const h = harness({ night: n.night, prepare: shelterPrep, run: () => ({ ok: true, placed: 55, total: 55, detail: "built" }) });
    const r = await h.runner.startBuild(NIGHT_SPEC, "Tester");
    expect(r.ok).toBe(true);
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("done");
    expect(n.calls).toEqual(["hold"]);
    expect(job.build).toMatchObject({ blueprint: "shelter", hold: "night", phase: "holding", holdDetail: expect.stringContaining("night") });
    expect(h.events.filter((e) => e.kind === "step").map((e) => (e as { op: string }).op)).toEqual(["build", "hold"]);
    expect(formatJobEvent(h.ended[0]!)).toMatch(/^\[job finished\] survived the night/);
    // geometry handed to the executor comes from the stored site
    expect(n.geos[0]).toMatchObject({ hasDoor: false, wall: "dirt" });
  });

  it("a bed at hand: sleeps, never builds", async () => {
    const n = mkNight({ bed: "white_bed at (1, 64, 1)" });
    const h = harness({ night: n.night });
    const r = await h.runner.startBuild(NIGHT_SPEC, null);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/sleep in white_bed/);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.status).toBe("done");
    expect(n.calls).toEqual(["sleep"]);
    expect(h.runs).toBe(0);
    expect(h.prepares).toHaveLength(0);
  });

  it("useBed:false ignores the bed and builds", async () => {
    const n = mkNight({ bed: "white_bed at (1, 64, 1)" });
    const h = harness({ night: n.night, prepare: shelterPrep });
    await h.runner.startBuild({ ...NIGHT_SPEC, params: { ...NIGHT_SPEC.params, useBed: false } }, null);
    await until(() => h.ended.length === 1);
    expect(n.calls).toEqual(["hold"]);
    expect(h.runs).toBe(1);
  });

  it("refuses in daytime without touching anything", async () => {
    const n = mkNight({ time: 5_000, bed: "white_bed at (1, 64, 1)" });
    const h = harness({ night: n.night });
    const r = await h.runner.startBuild(NIGHT_SPEC, null);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/daytime/);
    expect(h.runner.isRunning()).toBe(false);
  });

  it("a shelter that cannot be entered fails the job with the reason (no silent pass)", async () => {
    const n = mkNight({ hold: async () => ({ ok: false, failure: { kind: "unreachable", step: { op: "place_station", block: "crafting_table" }, detail: "couldn't shelter: couldn't get inside", attempts: 1 } }) });
    const h = harness({ night: n.night, prepare: shelterPrep });
    await h.runner.startBuild(NIGHT_SPEC, null);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.status).toBe("failed");
    expect(h.runner.current()!.failure).toMatchObject({ kind: "unreachable" });
  });

  it("death while holding ends failed(died) even though the job has no plan steps", async () => {
    let release: (r: StepResult) => void = () => {};
    const n = mkNight({ bed: "white_bed at (1, 64, 1)", sleep: () => new Promise<StepResult>((r) => (release = r)) });
    const h = harness({ night: n.night });
    await h.runner.startBuild(NIGHT_SPEC, null);
    await until(() => n.calls.length === 1);
    h.runner.notifyStop("death");
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.failure!.kind).toBe("died");
    release({ ok: false, failure: { kind: "died", step: { op: "place_station", block: "crafting_table" }, detail: "x", attempts: 1 } });
  });
});
