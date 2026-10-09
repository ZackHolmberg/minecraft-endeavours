import { describe, expect, it } from "vitest";
import { plan as realPlan } from "../planner/plan.js";
import type { FailureKind, Goal, Plan, Step, WorldView } from "../planner/types.js";
import type { TelemetryInput } from "../observability/telemetry.js";
import { JobRunner, type ExploreOutcome, type RunnerDeps, type StepRunContext } from "./runner.js";
import type { Job, StepResult } from "./types.js";

const gatherStep = (item: string, count: number, extra: Partial<Extract<Step, { op: "gather" }>> = {}): Step => ({
  op: "gather",
  item,
  count,
  blocks: [item],
  tool: null,
  ...extra,
});
const craftStep = (item: string, count = 1): Step => ({ op: "craft", item, count, crafts: 1, table: false });

function mkPlan(steps: Step[], goals: Goal[] = [{ item: "x", count: 1 }]): Plan {
  return { goals, steps, rawNeeds: {}, unresolved: [], summary: steps.map((s) => s.op).join(" → ") };
}
const VIEW = {} as WorldView;

interface Harness {
  runner: JobRunner;
  events: TelemetryInput[];
  ended: Job[];
  saved: Job[];
  stops: number;
  plans: Plan[];
  calls: Array<{ step: Step; ctx: StepRunContext }>;
  inv: Record<string, number>;
}

/** Fake world: `script` decides each step's result; `plans` is the queue of plans the planner returns. */
function harness(opts: {
  plans: Plan[];
  script: (step: Step, n: number, ctx: StepRunContext) => StepResult | Promise<StepResult>;
  explore?: (step: Step) => ExploreOutcome | Promise<ExploreOutcome>;
  load?: Job | null;
}): Harness {
  const h: Harness = { events: [], ended: [], saved: [], stops: 0, plans: [...opts.plans], calls: [], inv: {}, runner: null as never };
  let n = 0;
  const deps: RunnerDeps = {
    username: "bot",
    plan: () => (h.plans.length > 1 ? h.plans.shift()! : h.plans[0]!),
    buildView: async () => VIEW,
    execute: async (step, ctx) => {
      h.calls.push({ step, ctx });
      return opts.script(step, n++, ctx);
    },
    explore: async (step) => (opts.explore ? opts.explore(step) : { found: false, detail: "nothing" }),
    countItem: (item) => h.inv[item] ?? 0,
    requestStop: () => {
      h.stops++;
    },
    record: (e) => h.events.push(e),
    load: () => opts.load ?? null,
    save: (job) => h.saved.push(JSON.parse(JSON.stringify(job)) as Job),
    onEnd: (job) => h.ended.push(job),
  };
  h.runner = new JobRunner(deps);
  return h;
}

const okRes = (d = "ok"): StepResult => ({ ok: true, detail: d });
const failRes = (step: Step, kind: FailureKind, detail: string = kind): StepResult => ({ ok: false, failure: { kind, step, detail, attempts: 1 } });
const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 2));
  }
};
const kinds = (h: Harness) => h.events.map((e) => e.kind);
const rungs = (h: Harness) => h.events.filter((e) => e.kind === "recovery").map((e) => (e as { rung: string }).rung);

describe("JobRunner state machine", () => {
  it("runs all steps, verifies with a final re-plan, ends done and notifies once", async () => {
    const steps = [gatherStep("oak_log", 3), craftStep("oak_planks", 4)];
    const h = harness({ plans: [mkPlan(steps), mkPlan([])], script: () => okRes() });
    const res = await h.runner.start([{ item: "oak_planks", count: 4 }], "Alex");
    expect(res.ok).toBe(true);
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("done");
    expect(job.requestedBy).toBe("Alex");
    expect(h.calls.map((c) => c.step.op)).toEqual(["gather", "craft"]);
    expect(kinds(h)).toEqual(["job_start", "step", "step", "job_end"]);
    expect(h.events.find((e) => e.kind === "job_end")).toMatchObject({ status: "done", steps: 2, replans: 0, failureKind: null });
    expect(h.saved.at(-1)!.status).toBe("done");
  });

  it("refuses to start on an empty or unresolved plan", async () => {
    const h = harness({ plans: [mkPlan([])], script: () => okRes() });
    expect((await h.runner.start([{ item: "x", count: 1 }], null)).ok).toBe(false);
    const p = mkPlan([]);
    p.unresolved = [{ item: "beef", count: 1, reason: "not_obtainable: mob drop" }];
    const h2 = harness({ plans: [p], script: () => okRes() });
    const r = await h2.runner.start([{ item: "beef", count: 1 }], null);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("mob drop");
    expect(h2.runner.isRunning()).toBe(false);
  });

  it("retries a transient failure once, then continues", async () => {
    const steps = [gatherStep("oak_log", 3)];
    const h = harness({
      plans: [mkPlan(steps), mkPlan([])],
      script: (s, n) => (n === 0 ? failRes(s, "unreachable") : okRes()),
    });
    await h.runner.start([{ item: "oak_log", count: 3 }], null);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.status).toBe("done");
    expect(rungs(h)).toEqual(["retry"]);
    expect(h.calls).toHaveLength(2);
    // postcondition baseline is stable across the retry
    expect(h.calls[0]!.ctx.baseline).toBe(h.calls[1]!.ctx.baseline);
  });

  it("no_source with a hint: widens 96 then 160, explores, then fails with the remaining plan", async () => {
    const hint = { kind: "underground" as const, yRange: [-16, 48] as [number, number] };
    const steps = [gatherStep("raw_iron", 3, { searchHint: hint }), craftStep("iron_pickaxe")];
    const h = harness({ plans: [mkPlan(steps)], script: (s) => failRes(s, "no_source", "no iron_ore within 64 blocks") });
    await h.runner.start([{ item: "iron_pickaxe", count: 1 }], "Sam");
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("failed");
    expect(job.failure!.kind).toBe("no_source");
    expect(rungs(h).slice(0, 3)).toEqual(["widen", "widen", "explore"]);
    expect(rungs(h).at(-1)).toBe("fail");
    // widened radii reach the executor
    expect(h.calls.map((c) => c.ctx.radius)).toEqual(expect.arrayContaining([64, 96, 160]));
    expect(job.failure!.detail).toContain("160");
    expect(h.ended[0]!.plan.steps.length).toBe(2); // remaining plan survives for the event
  });

  it("explore that finds the target lets the gather step succeed", async () => {
    const hint = { kind: "surface" as const };
    let found = false;
    const steps = [gatherStep("oak_log", 3, { searchHint: hint })];
    const h = harness({
      plans: [mkPlan(steps), mkPlan([])],
      script: (s) => (found ? okRes() : failRes(s, "no_source")),
      explore: () => {
        found = true;
        return { found: true, detail: "tree in range" };
      },
    });
    await h.runner.start([{ item: "oak_log", count: 3 }], null);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.status).toBe("done");
    expect(rungs(h)).toEqual(expect.arrayContaining(["widen", "widen", "explore"]));
  });

  it("missing_input re-plans from the current inventory (counts a replan), then escalates to fail on repeat", async () => {
    const a = [craftStep("stick", 4)];
    const h = harness({ plans: [mkPlan(a), mkPlan(a)], script: (s) => failRes(s, "missing_input", "no planks") });
    await h.runner.start([{ item: "stick", count: 4 }], null);
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("failed");
    expect(job.failure!.kind).toBe("missing_input");
    expect(job.replans).toBe(1);
  });

  it("caps replans at 5 per job", async () => {
    // every plan is a fresh step (different count) so each failure is a new episode and re-plans again
    const plans = Array.from({ length: 12 }, (_, i) => mkPlan([craftStep("stick", i + 1)]));
    const h = harness({ plans, script: (s) => failRes(s, "missing_input") });
    await h.runner.start([{ item: "stick", count: 1 }], null);
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("failed");
    expect(job.replans).toBeLessThanOrEqual(5);
  });

  it("verification re-plan: leftover work after the last step runs instead of reporting done", async () => {
    const h = harness({
      plans: [mkPlan([craftStep("stick", 2)]), mkPlan([craftStep("stick", 1)]), mkPlan([])],
      script: () => okRes(),
    });
    await h.runner.start([{ item: "stick", count: 3 }], null);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.status).toBe("done");
    expect(h.runner.current()!.replans).toBe(1);
    expect(h.calls).toHaveLength(2);
  });

  it("unrecoverable kinds fail immediately (unknown_item / inventory_full)", async () => {
    const h = harness({ plans: [mkPlan([gatherStep("oak_log", 3)])], script: (s) => failRes(s, "inventory_full") });
    await h.runner.start([{ item: "oak_log", count: 3 }], null);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.failure!.kind).toBe("inventory_full");
    expect(h.calls).toHaveLength(1);
  });

  it("cancel mid-step ends cancelled, emits no agent event, requests a stop, and waits for the step", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      plans: [mkPlan([gatherStep("oak_log", 3), craftStep("oak_planks", 4)])],
      script: async (s, _n, ctx) => {
        await gate;
        return ctx.signal.aborted ? failRes(s, "cancelled") : okRes();
      },
    });
    await h.runner.start([{ item: "oak_planks", count: 4 }], null);
    await until(() => h.calls.length === 1);
    let cancelDone = false;
    const p = h.runner.cancel("player stop").then(() => (cancelDone = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.runner.isRunning()).toBe(false); // flips immediately
    expect(cancelDone).toBe(false); // but waits for the in-flight step
    release();
    await p;
    expect(h.runner.current()!.status).toBe("cancelled");
    expect(h.ended).toHaveLength(0);
    expect(h.stops).toBeGreaterThan(0);
    expect(h.calls).toHaveLength(1); // second step never ran
    expect(h.events.filter((e) => e.kind === "job_end")).toHaveLength(1);
  });

  it("notifyStop (the bot's cancellation flag) cancels a running job but ignores the runner's own stops", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ plans: [mkPlan([gatherStep("oak_log", 3)])], script: async (s) => (await gate, failRes(s, "cancelled")) });
    await h.runner.start([{ item: "oak_log", count: 3 }], null);
    await until(() => h.calls.length === 1);
    h.runner.notifyStop();
    expect(h.runner.isRunning()).toBe(false);
    release();
    await until(() => h.runner.current()!.status === "cancelled");
    expect(h.ended).toHaveLength(0);
  });

  it("a new start replaces (cancels) the running job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      plans: [mkPlan([gatherStep("oak_log", 3)]), mkPlan([craftStep("stick", 4)]), mkPlan([])],
      script: async (s, _n, ctx) => {
        if (s.op === "gather") {
          await gate;
          return ctx.signal.aborted ? failRes(s, "cancelled") : okRes();
        }
        return okRes();
      },
    });
    const first = await h.runner.start([{ item: "oak_log", count: 3 }], null);
    await until(() => h.calls.length === 1);
    const second = h.runner.start([{ item: "stick", count: 4 }], null);
    release();
    const r2 = await second;
    expect(r2.ok).toBe(true);
    expect(r2.jobId).not.toBe(first.jobId);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.id).toBe(r2.jobId);
    const ends = h.events.filter((e) => e.kind === "job_end") as Array<{ status: string }>;
    expect(ends.map((e) => e.status)).toEqual(["cancelled", "done"]);
  });

  it("marks a leftover running job interrupted on boot (no agent event)", () => {
    const old: Job = {
      id: "jold",
      kind: "achieve",
      goals: [{ item: "x", count: 1 }],
      requestedBy: null,
      status: "running",
      startedAt: 1,
      endedAt: null,
      plan: mkPlan([craftStep("stick")]),
      stepIndex: 0,
      replans: 0,
      progress: "step 1/1",
      failure: null,
    };
    const h = harness({ plans: [mkPlan([])], script: () => okRes(), load: old });
    expect(h.runner.current()!.status).toBe("interrupted");
    expect(h.runner.isRunning()).toBe(false);
    expect(h.saved.at(-1)!.status).toBe("interrupted");
    expect(h.events.find((e) => e.kind === "job_end")).toMatchObject({ jobId: "jold", status: "interrupted" });
    expect(h.ended).toHaveLength(0);
  });

  it("works with the real planner on a trivially satisfied goal", async () => {
    const h = harness({ plans: [realPlan([{ item: "oak_planks", count: 1 }], { inventory: { oak_planks: 5 }, gameMode: "survival", nearbyBlocks: {}, stations: { crafting_table: false, furnace: false }, containers: [], position: { x: 0, y: 64, z: 0 }, dimension: "overworld" })], script: () => okRes() });
    const r = await h.runner.start([{ item: "oak_planks", count: 1 }], null);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("already have");
  });
});
