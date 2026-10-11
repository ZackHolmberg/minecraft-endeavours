import { describe, expect, it, vi } from "vitest";
import { plan as realPlan } from "../planner/plan.js";
import type { FailureKind, Goal, Plan, Step, WorldView } from "../planner/types.js";
import type { TelemetryInput } from "../observability/telemetry.js";
import { JobRunner, STEP_GRACE_MS, type ExploreOutcome, type RelocateOutcome, type RunnerDeps, type StepRunContext } from "./runner.js";
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
  relocate?: (step: Step) => RelocateOutcome | Promise<RelocateOutcome>;
  load?: Job | null;
  buildView?: RunnerDeps["buildView"];
  onPlan?: (view: WorldView) => void;
}): Harness {
  const h: Harness = { events: [], ended: [], saved: [], stops: 0, plans: [...opts.plans], calls: [], inv: {}, runner: null as never };
  let n = 0;
  const deps: RunnerDeps = {
    username: "bot",
    plan: (_g, view) => {
      opts.onPlan?.(view);
      return h.plans.length > 1 ? h.plans.shift()! : h.plans[0]!;
    },
    buildView: opts.buildView ?? (async () => VIEW),
    execute: async (step, ctx) => {
      h.calls.push({ step, ctx });
      return opts.script(step, n++, ctx);
    },
    explore: async (step) => (opts.explore ? opts.explore(step) : { found: false, detail: "nothing" }),
    ...(opts.relocate ? { relocate: async (step: Step) => opts.relocate!(step) } : {}),
    position: () => ({ x: 10, y: 64, z: 20 }),
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
const failRes = (step: Step, kind: FailureKind, detail: string = kind, extra: { avoid?: string[]; positions?: string[] } = {}): StepResult => ({ ok: false, failure: { kind, step, detail, attempts: 1, ...extra } });
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

  it("death ends the job as failed/died and DOES notify the agent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ plans: [mkPlan([gatherStep("oak_log", 3)])], script: async (s) => (await gate, failRes(s, "cancelled")) });
    await h.runner.start([{ item: "oak_log", count: 3 }], "Alex");
    await until(() => h.calls.length === 1);
    h.runner.notifyStop("death");
    expect(h.runner.current()!.status).toBe("failed");
    expect(h.runner.current()!.failure!.kind).toBe("died");
    expect(h.ended).toHaveLength(1);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.ended).toHaveLength(1); // the aborted loop adds nothing
    expect(h.events.filter((e) => e.kind === "job_end")).toMatchObject([{ status: "failed", failureKind: "died" }]);
  });

  it("a watchdog stop also notifies the agent (failed/timeout), never a silent cancel", async () => {
    const h = harness({ plans: [mkPlan([gatherStep("oak_log", 3)])], script: () => new Promise<StepResult>(() => {}) });
    await h.runner.start([{ item: "oak_log", count: 3 }], null);
    await until(() => h.calls.length === 1);
    h.runner.notifyStop("watchdog");
    expect(h.runner.current()!.failure!.kind).toBe("timeout");
    expect(h.ended).toHaveLength(1);
  });

  it("dispose (disconnect / shutdown) ends the job interrupted, persisted, with no agent event", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ plans: [mkPlan([gatherStep("oak_log", 3), craftStep("oak_planks", 4)])], script: async (s) => (await gate, failRes(s, "internal", "bot disconnected")) });
    await h.runner.start([{ item: "oak_planks", count: 4 }], "Alex");
    await until(() => h.calls.length === 1);
    const d = h.runner.dispose();
    release(); // the step now fails "internal" on the dead bot: must not turn into a failed job
    await d;
    await new Promise((r) => setTimeout(r, 20));
    expect(h.runner.current()!.status).toBe("interrupted");
    expect(h.saved.at(-1)!.status).toBe("interrupted");
    expect(h.ended).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
    expect(h.events.filter((e) => e.kind === "job_end")).toMatchObject([{ status: "interrupted" }]);
    expect((await h.runner.start([{ item: "x", count: 1 }], null)).ok).toBe(false);
  });

  it("a stop that lands while the job is being planned prevents it from starting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ plans: [mkPlan([gatherStep("oak_log", 3)])], script: () => okRes(), buildView: async () => (await gate, VIEW) });
    const p = h.runner.start([{ item: "oak_log", count: 3 }], null);
    await new Promise((r) => setTimeout(r, 10));
    h.runner.notifyStop(); // no job yet, but the player said stop
    release();
    const res = await p;
    expect(res.ok).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.runner.isRunning()).toBe(false);
  });

  it("the runner owns step timeouts: a skill that ignores the stop is abandoned after the grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({
        plans: [mkPlan([craftStep("oak_planks", 4)]), mkPlan([craftStep("oak_planks", 4)])],
        script: () => new Promise<StepResult>(() => {}), // hangs forever
      });
      await h.runner.start([{ item: "oak_planks", count: 4 }], null);
      await vi.advanceTimersByTimeAsync(121_000); // craft limit 120s: cooperative stop
      expect(h.stops).toBeGreaterThan(0);
      expect(h.events.filter((e) => e.kind === "step")).toHaveLength(0); // still hanging
      await vi.advanceTimersByTimeAsync(STEP_GRACE_MS + 1_000);
      const step = h.events.find((e) => e.kind === "step") as { ok: boolean; failureKind: string };
      expect(step).toMatchObject({ ok: false, failureKind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
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

  it("boot: an unfinished night pocket job triggers leavePocket (review M3); a finished one does not", async () => {
    const plan = { kind: "down", stand: { x: 0, y: 64, z: 0 }, dig: [], rest: { x: 0, y: 61, z: 0 }, seal: [], cost: 1, yields: 1, summary: "x" };
    const mk = (status: Job["status"]): Job => ({
      id: "jp",
      kind: "build",
      goals: [],
      requestedBy: "A",
      status,
      startedAt: 1,
      endedAt: status === "running" ? null : 2,
      plan: mkPlan([]),
      stepIndex: 0,
      replans: 0,
      progress: "digging in for the night",
      failure: null,
      build: { phase: "holding", holdMode: "pocket", pocket: plan } as never,
    });
    const run = async (status: Job["status"]): Promise<number> => {
      const h = harness({ plans: [mkPlan([])], script: () => okRes(), load: mk(status) });
      let calls = 0;
      const deps = (h.runner as unknown as { deps: RunnerDeps }).deps;
      deps.night = { timeOfDay: () => null, findBed: () => null, sleepThrough: async () => okRes(), holdInShelter: async () => okRes(), leavePocket: async () => { calls++; return true; } };
      await h.runner.reclaimOrphans();
      return calls;
    };
    expect(await run("running")).toBe(1); // restart while dug in -> interrupted -> climb out
    expect(await run("cancelled")).toBe(1); // cancelled but the exit never finished
    expect(await run("done")).toBe(0);
  });

  it("works with the real planner on a trivially satisfied goal", async () => {
    const h = harness({ plans: [realPlan([{ item: "oak_planks", count: 1 }], { inventory: { oak_planks: 5 }, gameMode: "survival", nearbyBlocks: {}, stations: { crafting_table: false, furnace: false }, containers: [], position: { x: 0, y: 64, z: 0 }, dimension: "overworld" })], script: () => okRes() });
    const r = await h.runner.start([{ item: "oak_planks", count: 1 }], null);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("already have");
  });
});

describe("unreachable gather feeds the planner (avoidBlocks) and reserves the plan's items", () => {
  const view0: WorldView = {
    inventory: {},
    gameMode: "survival",
    nearbyBlocks: { jungle_log: { count: 5, nearest: 3.8 }, oak_log: { count: 5, nearest: 7.1 } },
    stations: { crafting_table: false, furnace: false },
    containers: [],
    position: { x: 0, y: 64, z: 0 },
    dimension: "overworld",
  };

  it("replans at once (no same-step retry) with the unreachable species avoided, and clears reservations at the end", async () => {
    const views: Array<string[] | undefined> = [];
    const reserved: Array<Record<string, number> | null> = [];
    const events: TelemetryInput[] = [];
    const ended: Job[] = [];
    const runner = new JobRunner({
      username: "bot",
      plan: (goals, view) => {
        views.push(view.avoidBlocks);
        return realPlan(goals, view);
      },
      buildView: async () => view0,
      execute: async (step) => {
        if (step.op === "gather" && step.blocks.includes("jungle_log")) {
          return { ok: false, failure: { kind: "unreachable", step, detail: "gave up after 6 unreachable jungle_log blocks", attempts: 1, avoid: ["jungle_log"] } };
        }
        return okRes();
      },
      explore: async () => ({ found: false, detail: "" }),
      countItem: () => 0,
      requestStop: () => {},
      record: (e) => events.push(e),
      load: () => null,
      save: () => {},
      reserve: (items) => reserved.push(items),
      onEnd: (j) => ended.push(j),
    });
    const r = await runner.start([{ item: "wooden_pickaxe", count: 1 }], null);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("jungle_log");
    await until(() => ended.length > 0 || !runner.isRunning(), 3000);
    const rec = events.filter((e) => e.kind === "recovery").map((e) => (e as { rung: string }).rung);
    expect(rec[0]).toBe("replan"); // not "retry"
    expect(views[0]).toBeUndefined();
    expect(views[1]).toEqual(["jungle_log"]);
    expect(runner.current()!.plan.steps.some((s) => s.op === "gather" && s.blocks.includes("oak_log"))).toBe(true);
    // reservations: set at start (plan items), refreshed on replan, cleared at job end
    expect(reserved[0]).toMatchObject({ jungle_log: Infinity, wooden_pickaxe: Infinity });
    expect(reserved.some((x) => x && "oak_log" in x)).toBe(true);
    expect(reserved.at(-1)).toBeNull();
  });
});

describe("generic (tag) goals", () => {
  it("keeps the tag goals for re-plans and stores the latest concrete resolution as job.goals", async () => {
    const seen: Goal[][] = [];
    const concrete = (item: string, count: number): Plan => mkPlan([gatherStep(item, count)], [{ item, count }]);
    const queue = [concrete("birch_log", 5), mkPlan([], [{ item: "birch_log", count: 5 }])];
    const h = harness({ plans: queue, script: () => okRes() });
    // wrap the harness planner to record the goals it is asked for
    const deps = (h.runner as unknown as { deps: RunnerDeps }).deps;
    const inner = deps.plan;
    deps.plan = (goals, view, o) => {
      seen.push(goals.map((g) => ({ ...g })));
      return inner(goals, view, o);
    };
    const res = await h.runner.start([{ item: "#log", count: 5 }], "Alex");
    expect(res.ok).toBe(true);
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("done");
    expect(job.generic).toEqual([{ item: "#log", count: 5 }]);
    expect(job.goals).toEqual([{ item: "birch_log", count: 5 }]);
    // the verify re-plan after the steps re-resolves from the tag, not from the concrete species
    expect(seen).toEqual([[{ item: "#log", count: 5 }], [{ item: "#log", count: 5 }]]);
  });

  it("plain goals leave job.generic unset", async () => {
    const h = harness({ plans: [mkPlan([gatherStep("oak_log", 1)]), mkPlan([])], script: () => okRes() });
    await h.runner.start([{ item: "oak_log", count: 1 }], null);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.generic).toBeUndefined();
  });
});

describe("explore-elsewhere recovery (relocate)", () => {
  const POS = ["-313,53,-581", "-312,53,-580", "-312,52,-579", "-310,54,-577"];
  const coal = (): Step => gatherStep("coal", 8, { blocks: ["coal_ore", "deepslate_coal_ore"] });

  it("unreachable ore area: remembers the positions, relocates, rescans (no avoid), and gathers there", async () => {
    const views: Array<{ exclude: boolean }> = [];
    const avoidSeen: Array<string[] | undefined> = [];
    const h = harness({
      plans: [mkPlan([coal()]), mkPlan([coal()]), mkPlan([])],
      script: (s, n, ctx) => (n === 0 ? failRes(s, "unreachable", "gave up after 6 unreachable coal_ore blocks", { avoid: ["coal_ore"], positions: POS }) : (expect(ctx.exclude?.(-313, 53, -581)).toBe(true), okRes())),
      relocate: () => ({ moved: true, detail: "relocated 60 blocks" }),
      onPlan: (v) => avoidSeen.push(v.avoidBlocks),
      buildView: async (_g, _r, exclude) => {
        views.push({ exclude: !!exclude });
        return VIEW;
      },
    });
    await h.runner.start([{ item: "coal", count: 8 }], null);
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("done");
    expect(rungs(h).slice(0, 3)).toEqual(["relocate", "relocate", "replan"]); // decision, outcome, rescan
    expect(job.relocations).toBe(1);
    expect(job.exhausted!.positions).toEqual(POS);
    expect(job.exhausted!.regions).toHaveLength(1);
    expect(views.some((v) => v.exclude)).toBe(true);
    expect(avoidSeen.every((a) => !a || !a.includes("coal_ore"))).toBe(true); // coal_ore was NOT put on the avoid list
    // the retry after the move carries the exclusion
    expect(h.calls.at(-1)!.ctx.exclude?.(-312, 52, -579)).toBe(true);
    expect(h.calls.at(-1)!.ctx.exclude?.(0, 60, 0)).toBe(false);
  });

  it("is bounded: after MAX_RELOCATIONS the old avoid-and-replan rung takes over", async () => {
    const h = harness({
      plans: [mkPlan([coal()])],
      script: (s) => failRes(s, "unreachable", "unreachable", { avoid: ["coal_ore"], positions: POS }),
      relocate: () => ({ moved: true, detail: "moved" }),
    });
    await h.runner.start([{ item: "coal", count: 8 }], null);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.relocations).toBe(2);
    expect(rungs(h).filter((r) => r === "relocate")).toHaveLength(4); // 2 x (decision + outcome)
    expect(rungs(h)).toContain("replan");
  });

  it("a single unreachable block does not relocate (keeps the old ladder)", async () => {
    const h = harness({
      plans: [mkPlan([coal()]), mkPlan([])],
      script: (s, n) => (n === 0 ? failRes(s, "unreachable", "no path", { positions: ["1,2,3"] }) : okRes()),
      relocate: () => ({ moved: true, detail: "moved" }),
    });
    await h.runner.start([{ item: "coal", count: 8 }], null);
    await until(() => h.ended.length === 1);
    expect(rungs(h)).toEqual(["retry"]);
    expect(h.runner.current()!.relocations).toBeUndefined();
  });

  it("a relocation that cannot move falls through to the avoid-and-replan rung", async () => {
    const h = harness({
      plans: [mkPlan([coal()]), mkPlan([gatherStep("coal", 8, { blocks: ["deepslate_coal_ore"] })]), mkPlan([])],
      script: (s, n) => (n === 0 ? failRes(s, "unreachable", "unreachable", { avoid: ["coal_ore"], positions: POS }) : okRes()),
      relocate: () => ({ moved: false, detail: "no dry land" }),
    });
    await h.runner.start([{ item: "coal", count: 8 }], null);
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.status).toBe("done");
    expect(rungs(h)[0]).toBe("relocate");
  });
});
