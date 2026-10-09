// Synthetic telemetry for the UI mock server (seeded, deterministic shape).
// Adapted from the telemetry smoke-test generator; not part of the UI bundle.
import type { TelemetryEvent, Vec } from "../../../observability/telemetry-types.js";

const bot = "Steve_AI";
let seed = 42;
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const int = (a: number, b: number): number => Math.floor(a + rnd() * (b - a + 1));
const v = (x: number, y: number, z: number): Vec => ({ x, y, z });

const REQUESTS = [
  "come here", "mine 10 iron ore", "make me an iron pickaxe", "put the logs in the chest",
  "follow me", "build a 5x5 shelter", "what do you have?", "go get some wood", "stop",
  "kill that zombie", "smelt the iron", "where is the base?", "fish for a bit",
];
const SKILLS: Array<[string, number, number]> = [
  // name, success prob, median ms
  ["say", 0.99, 40], ["observeSurroundings", 1, 120], ["goTo", 0.78, 9000],
  ["mineBlock", 0.7, 6000], ["craftItem", 0.85, 800], ["depositToChest", 0.9, 1500],
  ["placeBlock", 0.45, 600], ["followPlayer", 0.95, 20000], ["attack", 0.8, 4000],
  ["smeltItem", 0.88, 12000], ["listInventory", 1, 30],
];
const FAILS: Record<string, string[]> = {
  goTo: ["no path to target", "stuck near target"],
  mineBlock: ["no oak_log within 32 blocks", "can't reach block"],
  placeBlock: ["no reference block to place against", "position occupied", "no reference block to place against"],
  craftItem: ["missing materials: 3 iron_ingot"],
  depositToChest: ["no chest within 6 blocks"],
  attack: ["target out of range"],
  smeltItem: ["no furnace nearby"],
  followPlayer: ["player not visible"],
};

function genRun(runId: string, start: number, nTasks: number, opts: { slow: boolean }): TelemetryEvent[] {
  const ev: TelemetryEvent[] = [];
  const base = (at: number, taskId: string | null) => ({ at, bot, runId, taskId });
  let t = start;
  ev.push({ ...base(t, null), kind: "connection", state: "connected", reason: null, inWorldMs: null });
  for (let i = 0; i < nTasks; i++) {
    t += int(20_000, 180_000);
    const taskId = `${runId}-t${i}`;
    const req = pick(REQUESTS);
    const player = pick(["Zack", "Alex"]);
    const isStop = req === "stop";
    ev.push({ ...base(t - 50, null), kind: "chat_in", player, routed: true, route: "name-mention", isStop });
    if (rnd() < 0.3) ev.push({ ...base(t - 300, null), kind: "chat_in", player: "Alex", routed: false, route: null, isStop: false });
    const ctxTimeout = rnd() < 0.06;
    ev.push({
      ...base(t, taskId), kind: "task_start", request: req, player, route: pick(["name-mention", "whisper", "continuation"]),
      sessionMode: "per_task", coalesced: rnd() < 0.15 ? 2 : 1, queueWaitMs: int(5, opts.slow ? 4000 : 600),
      contextBuildMs: ctxTimeout ? null : int(40, 900), contextChars: ctxTimeout ? null : int(3000, 9000),
    });
    let tt = t + int(500, 2000);
    const nSkills = isStop ? 1 : int(2, 14);
    let fails = 0;
    let firstReply: number | null = null;
    for (let k = 0; k < nSkills; k++) {
      const [skill, p, med] = k === 0 ? SKILLS[0]! : pick(SKILLS);
      const dur = Math.max(5, Math.round(med * (0.3 + rnd() * 1.8)));
      const cancelled = skill === "followPlayer" && rnd() < 0.2;
      const timedOut = !cancelled && rnd() < 0.02;
      const ok = !cancelled && !timedOut && rnd() < p;
      if (!ok) fails++;
      const msg = ok ? "ok" : cancelled ? "cancelled by stop" : timedOut ? "harness watchdog timeout" : pick(FAILS[skill] ?? ["failed"]);
      if (skill === "say" && ok && firstReply === null) {
        firstReply = tt - t + (opts.slow ? int(4000, 9000) : int(1200, 4500));
        tt = t + firstReply;
        ev.push({ ...base(tt, taskId), kind: "chat_out", channel: "say", chars: int(10, 120) });
      }
      ev.push({ ...base(tt + dur, taskId), kind: "skill", skill, args: `{"target":"${req.slice(0, 20)}"}`, ok, durationMs: dur, message: msg, cancelled, timedOut });
      if (skill === "goTo" || skill === "followPlayer") {
        const result = ok ? "arrived" : cancelled ? "cancelled" : pick(["no_path", "stuck", "timeout", "stuck"] as const);
        const from = rnd() < 0.5 ? v(112 + int(0, 1), 64, -40 + int(0, 1)) : v(int(-200, 200), int(60, 80), int(-200, 200));
        ev.push({ ...base(tt + dur, taskId), kind: "nav", label: pick(["chest", "player Zack", "oak_log", "base"]), result, distance: int(3, 80), durationMs: dur, from, to: v(int(-200, 200), 64, int(-200, 200)) });
        if (rnd() < 0.3) ev.push({ ...base(tt + dur / 2, taskId), kind: "door", action: "open", block: "oak_door", pos: v(110, 64, -38) }, { ...base(tt + dur / 2 + 800, taskId), kind: "door", action: "close", block: "oak_door", pos: v(110, 64, -38) });
      }
      if (skill === "placeBlock" && rnd() < 0.3) ev.push({ ...base(tt + dur, taskId), kind: "pillar", requested: 4, placed: ok ? 4 : int(0, 3), attempts: int(4, 9), ok, reason: ok ? null : "no scaffold block" });
      if (skill === "mineBlock" && rnd() < 0.2) ev.push({ ...base(tt + dur, taskId), kind: "structure_skip", block: "oak_planks", skipped: int(1, 6) });
      if (!ok && rnd() < 0.25) ev.push({ ...base(tt + dur + 10, taskId), kind: "guard_refusal", tool: skill, args: "{}" });
      tt += dur + int(300, 3000);
    }
    if (rnd() < 0.1) ev.push({ ...base(tt, null), kind: "hurt", health: int(4, 18), by: "zombie" });
    if (rnd() < 0.05) ev.push({ ...base(tt + 5, null), kind: "death", pos: v(int(-50, 50), 12, int(-50, 50)), cause: "lava" });
    for (const r of ["look", "eat", "armor", "defend"] as const) if (rnd() < 0.15) ev.push({ ...base(tt, null), kind: "reflex", reflex: r, detail: r });
    const maxTurns = rnd() < 0.05;
    const turns = maxTurns ? 50 : isStop ? 2 : Math.min(49, nSkills * 2 + int(1, 4) + (rnd() < 0.08 ? 25 : 0));
    const outcome = isStop ? "stopped" : maxTurns ? "max_turns" : rnd() < 0.05 ? "failed" : rnd() < 0.03 ? "rate_limited" : "finished";
    const input = int(200, 3000);
    const cacheRead = opts.slow ? int(1000, 8000) : int(20_000, 60_000);
    const cacheCreate = opts.slow ? int(10_000, 25_000) : int(2_000, 9_000);
    const output = int(200, 2500);
    ev.push({
      ...base(tt, taskId), kind: "task_end", outcome, subtype: outcome === "max_turns" ? "error_max_turns" : outcome === "finished" ? "success" : "error_during_execution",
      turns, durationMs: tt - t, firstReplyMs: firstReply, toolCalls: nSkills, toolFailures: fails,
      inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreateTokens: cacheCreate,
      costUsd: Math.round(((input + cacheCreate * 1.25) * 1e-6 + cacheRead * 0.1e-6 + output * 5e-6) * 1e5) / 1e5,
    });
    if (outcome === "rate_limited") ev.push({ ...base(tt, null), kind: "rate_limit", status: "rejected", resetsAt: tt + 3600_000 });
    if (rnd() < 0.04) ev.push({ ...base(tt + 1000, null), kind: "loop_lag", lagMs: int(250, 2500) });
    if (rnd() < 0.04) {
      ev.push({ ...base(tt + 2000, null), kind: "connection", state: "disconnected", reason: "socketClosed", inWorldMs: tt - start });
      ev.push({ ...base(tt + 7000, null), kind: "connection", state: "connected", reason: null, inWorldMs: null });
    }
    t = tt;
  }
  return ev.sort((a, b) => a.at - b.at);
}

/** An older (slow, per-task cold) run ~26h ago plus the current run over the last ~100 min. */
export function generateEvents(now = Date.now()): TelemetryEvent[] {
  return [
    ...genRun("run-old", now - 26 * 3600_000, 25, { slow: true }),
    ...genRun("run-cur", now - 100 * 60_000, 40, { slow: false }),
  ].filter((e) => e.at <= now);
}

export { genRun };
