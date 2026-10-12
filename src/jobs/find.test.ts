import { describe, expect, it } from "vitest";
import type { TelemetryInput } from "../observability/telemetry.js";
import { formatJobEvent, jobContextLines, jobLabel } from "./describe.js";
import { candKey, FIND_MAX_FROM_START, planFind, rankFindCandidates, resolveFindTarget } from "./find.js";
import { JobRunner, type FindRunContext, type RunnerDeps } from "./runner.js";
import { shouldCancelJobFor } from "./tools.js";
import type { FindOutcome, FindState, Job } from "./types.js";

const known = (b: string): boolean => /^(diamond_ore|deepslate_diamond_ore|iron_ore|deepslate_iron_ore|coal_ore|deepslate_coal_ore|oak_log|lapis_ore|deepslate_lapis_ore|sand)$/.test(b);

describe("resolveFindTarget / planFind", () => {
  it("expands ore words and either variant to both blocks; plain blocks stay as they are", () => {
    for (const w of ["diamond", "Diamonds", "diamond ore", "diamond_ore", "deepslate_diamond_ore", "minecraft:diamond_ore"]) {
      expect(resolveFindTarget(w, known), w).toEqual({ name: "diamond_ore", blocks: ["diamond_ore", "deepslate_diamond_ore"] });
    }
    expect(resolveFindTarget("iron", known)?.blocks).toEqual(["iron_ore", "deepslate_iron_ore"]);
    expect(resolveFindTarget("lapis", known)?.name).toBe("lapis_ore");
    expect(resolveFindTarget("oak_log", known)).toEqual({ name: "oak_log", blocks: ["oak_log"] });
    expect(resolveFindTarget("sand", known)?.blocks).toEqual(["sand"]);
    expect(resolveFindTarget("unobtainium", known)).toBeNull();
    expect(resolveFindTarget("  ", known)).toBeNull();
  });
  it("deep ores are dug for (with their Y band), coal / logs / sand are surface searches", () => {
    expect(planFind(["diamond_ore", "deepslate_diamond_ore"])).toEqual({ kind: "underground", yRange: [-64, -48] });
    expect(planFind(["iron_ore"]).kind).toBe("underground");
    expect(planFind(["coal_ore", "deepslate_coal_ore"]).kind).toBe("surface");
    expect(planFind(["oak_log"])).toEqual({ kind: "surface" });
  });
});

describe("rankFindCandidates", () => {
  const here = { x: 0, y: 64, z: 0 };
  it("cheapest first: digging 110 blocks down costs more than walking 100", () => {
    const r = rankFindCandidates([{ x: 100, y: 64, z: 0 }, { x: 10, y: -50, z: 0 }, { x: 0, y: 60, z: 30 }], here, here, new Set());
    expect(r.map((c) => [c.x, c.y])).toEqual([[0, 60], [100, 64], [10, -50]]);
  });
  it("drops dead candidates and anything beyond the 250-block cap from the start; remembered sightings get a small bonus", () => {
    const dead = new Set([candKey({ x: 5, y: 64, z: 0 })]);
    const r = rankFindCandidates(
      [{ x: 5, y: 64, z: 0 }, { x: FIND_MAX_FROM_START + 1, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, { x: 33, y: 64, z: 0 }, { x: 40, y: 64, z: 5, known: true }],
      here,
      here,
      dead,
    );
    expect(r.map((c) => [c.x, c.z])).toEqual([[40, 5], [33, 0], [40, 0]]);
    expect(r[0]!.known).toBe(true);
  });
  it("the cap is measured from where the find began, not from the bot", () => {
    const r = rankFindCandidates([{ x: 400, y: 64, z: 0 }], { x: 300, y: 64, z: 0 }, { x: 300, z: 0 }, new Set());
    expect(r).toHaveLength(1);
  });
});

interface H {
  runner: JobRunner;
  events: TelemetryInput[];
  ended: Job[];
  stops: number;
  ctxs: FindRunContext[];
  specs: FindState[];
  resolve: (o: FindOutcome) => void;
}

function harness(opts: { find?: boolean } = {}): H {
  const h: H = { events: [], ended: [], stops: 0, ctxs: [], specs: [], resolve: () => {}, runner: null as never };
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
    save: () => {},
    onEnd: (job) => h.ended.push(job),
    ...(opts.find === false
      ? {}
      : {
          find: {
            run: (spec, ctx) => {
              h.specs.push(spec);
              h.ctxs.push(ctx);
              return new Promise<FindOutcome>((resolve) => {
                h.resolve = resolve;
                ctx.signal.addEventListener("abort", () => resolve({ ok: false, kind: "cancelled", detail: "cancelled" }), { once: true });
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
const SPEC: FindState = { block: "diamond_ore", blocks: ["diamond_ore", "deepslate_diamond_ore"], action: "point", count: 1 };

describe("find job in the runner", () => {
  it("starts at once with a 10-minute cap, shows progress in the context, and stays out of the goal ledger path", async () => {
    const h = harness();
    const res = await h.runner.startFind({ ...SPEC }, "Alex");
    expect(res.ok).toBe(true);
    const job = h.runner.current()!;
    expect(job).toMatchObject({ kind: "find", status: "running", requestedBy: "Alex" });
    expect(h.events[0]).toMatchObject({ kind: "job_start", goals: [{ item: "find:diamond_ore", count: 1 }] });
    expect(h.ctxs[0]!.deadline - job.startedAt).toBe(10 * 60_000);
    h.ctxs[0]!.progress("digging down for diamond_ore (Y -64..-48)");
    const lines = jobContextLines(job, job.startedAt + 30_000);
    expect(lines[0]).toBe("looking for diamond_ore to point out (30s)");
    expect(lines.join("\n")).toContain("digging down");
    expect(jobLabel(job)).toBe("find diamond_ore (point)");
  });

  it("success: done, the position is stored, the event carries the coordinates and the action", async () => {
    const h = harness();
    await h.runner.startFind({ ...SPEC }, "Alex");
    h.resolve({ ok: true, detail: "standing next to diamond_ore at 20, -52, 10", found: { x: 20, y: -52, z: 10, block: "diamond_ore" } });
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("done");
    expect(job.find!.found).toEqual({ x: 20, y: -52, z: 10, block: "diamond_ore" });
    const text = formatJobEvent(job)!;
    expect(text).toContain("[job finished] found diamond_ore at 20, -52, 10");
    expect(text).toContain("did not mine it");
    expect(text).toContain("requested by Alex");
  });

  it("mine and report texts differ", async () => {
    const mk = async (action: FindState["action"], result: string) => {
      const h = harness();
      await h.runner.startFind({ ...SPEC, action }, null);
      h.resolve({ ok: true, detail: result, found: { x: 1, y: 2, z: 3, block: "diamond_ore" } });
      await until(() => h.ended.length === 1);
      return formatJobEvent(h.runner.current()!)!;
    };
    expect(await mk("mine", "mined 2 diamond_ore (collected 2 diamond)")).toContain("mined 2 diamond_ore (collected 2 diamond)");
    expect(await mk("report", "diamond_ore at 1, 2, 3")).toContain("only the location");
  });

  it("failure: failed with the kind, the event tells Haiku not to loop; a block it found but couldn't mine keeps the position", async () => {
    const h = harness();
    await h.runner.startFind({ ...SPEC, action: "mine" }, "Alex");
    h.resolve({ ok: false, kind: "missing_tool", detail: "found diamond_ore at 1, 2, 3 but couldn't mine it: no iron pickaxe", found: { x: 1, y: 2, z: 3, block: "diamond_ore" } });
    await until(() => h.ended.length === 1);
    const job = h.runner.current()!;
    expect(job.status).toBe("failed");
    expect(job.failure).toMatchObject({ kind: "missing_tool" });
    expect(job.failure!.detail).toContain("it is at 1, 2, 3");
    const text = formatJobEvent(job)!;
    expect(text).toContain("[job failed] find diamond_ore (mine)");
    expect(text).toContain("don't call find again");
    expect(text).not.toContain("remaining plan");
  });

  it("a player stop / cancelJob / replacement cancels it quietly; death fails it", async () => {
    const h = harness();
    await h.runner.startFind({ ...SPEC }, null);
    h.runner.notifyStop("player");
    await until(() => h.runner.current()!.status === "cancelled");
    expect(h.ended).toHaveLength(0);
    expect(h.stops).toBeGreaterThan(0);
    await h.runner.startFind({ ...SPEC }, null);
    const first = h.runner.current()!;
    await h.runner.startFind({ ...SPEC, block: "iron_ore" }, null);
    expect(first.status).toBe("cancelled");
    h.runner.notifyStop("death");
    await until(() => h.ended.length === 1);
    expect(h.runner.current()!.failure).toMatchObject({ kind: "died" });
    expect(h.runner.current()!.failure!.detail).toContain("finding iron_ore");
  });

  it("find itself never auto-cancels a running job (it replaces it); an executor-less runner refuses", async () => {
    expect(shouldCancelJobFor("find", true)).toBe(false);
    const none = harness({ find: false });
    expect((await none.runner.startFind({ ...SPEC }, null)).ok).toBe(false);
  });
});
