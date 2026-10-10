import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import type { FailureKind, Goal, Plan, Step, WorldView } from "../planner/types.js";
import type { TelemetryInput } from "../observability/telemetry.js";
import { formatJobEvent, jobContextLines } from "./describe.js";
import { JobRunner, type BuildDeps, type DeliverFn, type RunnerDeps } from "./runner.js";
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
  prepares: Array<{ existing: unknown }>;
  runs: number;
  delivered: Array<{ to: string; goals: Goal[] }>;
}

function harness(o: {
  plans?: Plan[];
  prepare?: (n: number) => BuildPrep;
  run?: (n: number) => BuildOutcome | Promise<BuildOutcome>;
  deliver?: (to: string, goals: Goal[]) => StepResult | Promise<StepResult>;
  step?: () => StepResult;
}): H {
  const h: H = { events: [], ended: [], prepares: [], runs: 0, delivered: [], runner: null as never };
  const plans = [...(o.plans ?? [mkPlan([])])];
  const build: BuildDeps = {
    prepare: async (_spec, existing) => {
      h.prepares.push({ existing });
      return o.prepare ? o.prepare(h.prepares.length - 1) : prepOk();
    },
    run: async () => {
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
    build,
    deliver,
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
      await vi.advanceTimersByTimeAsync(9_000);
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
