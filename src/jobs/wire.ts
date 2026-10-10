/**
 * Wires a JobRunner to a live bot: world view, step executors, explorer,
 * persistence (`job.json`), telemetry, the stop-flag subscription and the
 * agent hand-off on job end. Imported only from src/index.ts (it depends on
 * the agent module, which the rest of src/jobs must not).
 */
import type { Bot } from "mineflayer";
import { getAgent } from "../agent/npc-agent.js";
import { recordEvent, type TelemetryInput } from "../observability/telemetry.js";
import { plan } from "../planner/plan.js";
import type { BotState } from "../state/index.js";
import { loadJson, memoryFileFor, saveJsonAtomic } from "../state/persist.js";
import { clearReserved, reservedSnapshot, setReserved } from "../state/reservations.js";
import { formatJobEvent } from "./describe.js";
import { createExplorer } from "./explore.js";
import { buildLedgerFor, ledgerFor } from "./ledger.js";
import { registerJobRunner, unregisterJobRunner } from "./registry.js";
import { JobRunner } from "./runner.js";
import { createBuildDeps } from "./steps/build.js";
import { createDeliver } from "./steps/deliver.js";
import { createStepExecutor } from "./steps/index.js";
import { itemCount, slotDump } from "./steps/util.js";
import type { Facing } from "../build/types.js";
import type { Job } from "./types.js";
import { buildWorldView, DEFAULT_SCAN_RADIUS } from "./world-view.js";

/** One bot.log line per job milestone, so a run can be followed with grep "job". */
function logJobEvent(username: string, e: TelemetryInput): void {
  const tag = `[${username}] job`;
  switch (e.kind) {
    case "job_start":
      console.log(`${tag} ${e.jobId} start: ${e.goals.map((g) => `${g.item} x${g.count}`).join(", ")} (${e.steps} steps)`);
      break;
    case "step":
      console.log(`${tag} step ${e.op} ${e.item}: ${e.ok ? "ok" : `FAILED ${e.failureKind}`} (${Math.round(e.durationMs / 1000)}s)`);
      break;
    case "recovery":
      console.log(`${tag} recovery ${e.rung}: ${e.detail}`);
      break;
    case "job_end":
      console.log(`${tag} ${e.jobId} end: ${e.status}${e.failureKind ? ` (${e.failureKind})` : ""} in ${Math.round(e.durationMs / 1000)}s, ${e.replans} replans${e.total ? `, placed ${e.placed ?? 0}/${e.total}` : ""}`);
      break;
    default:
      break;
  }
}

export async function attachJobRunner(bot: Bot, username: string, state: BotState): Promise<JobRunner> {
  // Dispose the previous connection's runner first: it ends its job as interrupted
  // before the new runner reads job.json.
  await unregisterJobRunner(username);
  const path = memoryFileFor(username, "job.json");
  let off: () => void = () => {};
  const runner = new JobRunner({
    username,
    plan,
    // the ladder's first radius (64) is the gather default; the view scan itself starts at 48
    buildView: async (goals, radius) => {
      const t0 = Date.now();
      const view = await buildWorldView(bot, goals, radius <= 64 ? DEFAULT_SCAN_RADIUS : radius);
      const near = Object.entries(view.nearbyBlocks).map(([k, v]) => `${k}:${v.nearest}`).join(",");
      console.log(`[${username}] job view (${Date.now() - t0}ms, r=${radius}): inv=${JSON.stringify(view.inventory)} near=${near} stations=${JSON.stringify(view.stations)} slots=[${slotDump(bot)}]`);
      return view;
    },
    execute: createStepExecutor(bot),
    explore: createExplorer(bot),
    build: createBuildDeps(bot),
    deliver: createDeliver(bot),
    countItem: (item) => itemCount(bot, item),
    reserve: (items) => {
      if (items) {
        setReserved(username, items);
        console.log(`[${username}] [reserve] job needs: ${Object.keys(items).join(", ")}`);
      } else if (Object.keys(reservedSnapshot(username)).length > 0) {
        clearReserved(username);
        console.log(`[${username}] [reserve] cleared (job ended)`);
      }
    },
    requestStop: () => {
      state.cancellation.request();
      const pf = (bot as Bot & { pathfinder?: { isMoving(): boolean; stop(): void } }).pathfinder;
      if (pf?.isMoving()) pf.stop();
    },
    record: (e) => {
      recordEvent(username, e);
      logJobEvent(username, e);
    },
    load: () => loadJson<Job>(path),
    save: (job) => saveJsonAtomic(path, job),
    // Slice 3 review M3: remember what every build left behind (also cancelled / interrupted), so a re-build resumes onto it.
    buildHistory: {
      refusal: (spec) => buildLedgerFor(username).refusal(spec.blueprint, spec.anchor),
      partial: (spec) => {
        const r = buildLedgerFor(username).partial(spec.blueprint, spec.anchor);
        return r && r.origin && r.facing ? { origin: r.origin, facing: r.facing as Facing, params: r.params, placed: r.placed, total: r.total } : null;
      },
    },
    onBuildEnd: (job) => {
      const b = job.build;
      if (!b) return;
      const led = buildLedgerFor(username);
      if (job.status === "done") {
        led.success(b.blueprint, b.anchor);
        return;
      }
      led.record({
        jobId: job.id,
        at: Date.now(),
        blueprint: b.blueprint,
        anchor: b.anchor,
        origin: b.origin,
        facing: b.facing,
        params: b.params,
        placed: b.placed,
        total: b.total,
        kind: job.failure?.kind ?? "cancelled",
        // a player's stop or a restart is not "the build keeps failing"
        failure: job.status === "failed" && job.failure?.kind !== "died",
      });
    },
    onEnd: (job) => {
      // Loop guard (H2): remember failures so `achieve` can refuse a goal that keeps failing.
      if (job.kind === "build") {
        // builds are not goal-keyed: the build ledger (onBuildEnd) and the synthetic-event cap are their loop guards
      } else if (job.status === "failed") {
        // A player who walked away makes the hand-over fail even though the bot holds the items: not a goal failure.
        if (!(job.handoverFailed && job.failure?.kind === "unreachable")) ledgerFor(username).recordFailure(job.generic ?? job.goals, job.failure?.kind ?? "internal");
      } else if (job.status === "done") ledgerFor(username).recordSuccess(job.generic ?? job.goals);
      const text = formatJobEvent(job);
      if (text) getAgent(username)?.pushJobEvent(text);
    },
    onDispose: () => off(),
  });
  off = state.cancellation.onRequest((reason) => runner.notifyStop(reason));
  // The connection is gone: end the job as interrupted now (no failing steps on a
  // dead bot, no [job failed] event to Haiku). The reconnect builds a fresh runner.
  bot.once("end", () => {
    void runner.dispose().catch((err) => console.warn(`[${username}] job runner dispose failed:`, err));
  });
  await registerJobRunner(username, runner);
  // Scaffold blocks a previous run left standing (crash / restart / stop): take them down once the bot is in the world.
  const reclaim = (): void => {
    setTimeout(() => void runner.reclaimOrphans().catch(() => undefined), 5_000);
  };
  if (bot.entity) reclaim();
  else bot.once("spawn", reclaim);
  return runner;
}
