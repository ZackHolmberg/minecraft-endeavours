/**
 * Pure text helpers for jobs: step/goal descriptions, the synthetic `[job …]`
 * event Haiku receives on job end, and the `# Current job` context section.
 * No bot, no I/O.
 */
import type { Goal, Step } from "../planner/types.js";
import type { Job } from "./types.js";

export function describeStep(s: Step): string {
  switch (s.op) {
    case "withdraw":
      return `withdraw ${s.count} ${s.item}`;
    case "gather":
      return `gather ${s.count} ${s.item}`;
    case "craft":
      return `craft ${s.count} ${s.item}`;
    case "smelt":
      return `smelt ${s.count} ${s.input}`;
    case "place_station":
      return `place ${s.block}`;
  }
}

/** The item a step is meant to add to the inventory (the postcondition item). */
export function stepOutputItem(s: Step): string {
  switch (s.op) {
    case "smelt":
      return s.output;
    case "place_station":
      return s.block;
    default:
      return s.item;
  }
}

export function goalsText(goals: readonly Goal[]): string {
  return goals.map((g) => `${g.item} x${g.count}`).join(", ");
}

/** Short name of what a job is doing: "achieve iron_pickaxe x1", "build house (...)", plus "→ deliver to X". */
export function jobLabel(job: Job): string {
  if (job.kind === "follow" && job.follow) return `follow ${job.follow.player}`;
  const base = job.kind === "build" && job.build ? `build ${job.build.blueprint}${job.build.summary ? ` (${job.build.summary})` : ""}` : `achieve ${goalsText(job.generic ?? job.goals)}`;
  return job.deliverTo ? `${base} → give to ${job.deliverTo}` : base;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** Steps from `from` on, as a short "a → b → c" string (capped). */
export function remainingPlanText(job: Job, max = 8): string {
  const rest = job.plan.steps.slice(job.stepIndex);
  if (rest.length === 0) return "(nothing left)";
  const shown = rest.slice(0, max).map(describeStep);
  return shown.join(" → ") + (rest.length > max ? ` → … (+${rest.length - max})` : "");
}

/**
 * The synthetic user message queued to the agent when a job ends (done or
 * failed). Cancelled / interrupted jobs produce none: the stop path already
 * acknowledged the player.
 */
export function formatJobEvent(job: Job): string | null {
  const who = job.requestedBy ? ` (requested by ${job.requestedBy} — tell them)` : "";
  const goals = jobLabel(job);
  const dur = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
  if (job.kind === "follow") {
    const who2 = job.follow?.player ?? "the player";
    if (job.status === "done") {
      return `[job finished] stopped following ${who2} after ${dur} (time limit)${who}. Reply with one short line; they can ask you to follow again.`;
    }
    if (job.status === "failed" && job.failure) {
      return (
        `[job failed] following ${who2} ended after ${dur} — ${job.failure.detail}${who}. ` +
        `Tell them in one short line what happened (don't claim you are still following). Offer to follow again once they're back in view; don't call followPlayer again right away unless they are visible.`
      );
    }
    return null;
  }
  if (job.status === "done") {
    if (job.kind === "build" && job.build) {
      const b = job.build;
      if (b.hold === "night") return `[job finished] survived the night — ${b.holdDetail || b.summary} (${dur})${who}. Reply with one short line (it's morning).`;
      return `[job finished] ${goals} — done in ${dur}, ${b.placed}/${b.total} blocks placed${who}. Reply with one short line saying it's built (and where, if useful).`;
    }
    if (job.deliverTo) return `[job finished] ${goals} — handed over in ${dur}${who}. Reply with one short line (they have it now).`;
    // Live test 2026-10-10: after "achieve furnace" Haiku said "furnace placed, cooking the beef next" and
    // stopped — the item was only crafted, and the announced next step never ran.
    return `[job finished] ${goals} — done in ${dur}${who}. The items are in your inventory (crafted, not placed). If this was a step toward something the player asked for (you said you'd do something next), do that next step now with a tool call; otherwise reply with one short line saying you've got it. Never claim something was placed or done unless a tool result says so.`;
  }
  if (job.status === "failed" && job.failure) {
    const f = job.failure;
    return (
      `[job failed] ${goals} — failure: ${f.kind} — ${f.detail}${job.kind === "build" ? "" : `; remaining plan: ${remainingPlanText(job)}`}${who}. ` +
      `Tell them in one short line what's blocking, and offer a realistic alternative. Don't just call ${job.kind === "build" ? "build" : "achieve"} again with the same arguments.`
    );
  }
  if (job.status === "failed") return `[job failed] ${goals} — ${job.progress}${who}.`;
  return null;
}

const RECENT_END_MS = 2 * 60_000;

/**
 * `# Current job` section for the context block (lines, no header). Empty
 * when there is nothing worth showing (no job, or it ended > 2 minutes ago).
 */
export function jobContextLines(job: Job | null, now = Date.now()): string[] {
  if (!job) return [];
  if (job.status === "running" && job.kind === "follow" && job.follow) {
    const L = [`following ${job.follow.player} (${formatDuration(now - job.startedAt)})`, `progress: ${job.progress}`];
    if (job.requestedBy) L.push(`requested by: ${job.requestedBy}`);
    L.push("it runs by itself and keeps going while you chat: answer with say/whisper and end your turn. Movement/mining/crafting tools you call cancel it. To stop following call cancelJob (or stop).");
    return L;
  }
  if (job.status === "running") {
    const total = job.plan.steps.length;
    const L = [
      `running: ${jobLabel(job)} (started ${formatDuration(now - job.startedAt)} ago, ${job.replans} replan(s))`,
      `progress: ${job.progress || `step ${Math.min(job.stepIndex + 1, total)}/${total}`}`,
    ];
    if (job.requestedBy) L.push(`requested by: ${job.requestedBy}`);
    L.push("it runs by itself; any movement/mining/crafting tool you call cancels it. To abandon it call cancelJob.");
    return L;
  }
  if (job.endedAt === null || now - job.endedAt > RECENT_END_MS) return [];
  const ago = formatDuration(now - job.endedAt);
  const base = `last job (${ago} ago): ${jobLabel(job)} — ${job.status}`;
  if (job.status === "failed" && job.failure) {
    return [`${base}: ${job.failure.kind} — ${job.failure.detail}${job.kind !== "achieve" ? "" : `; remaining plan: ${remainingPlanText(job, 5)}`}`];
  }
  if (job.status === "done") return [`${base} in ${formatDuration(job.endedAt - job.startedAt)}`];
  return [`${base}${job.progress ? ` (${job.progress})` : ""}`];
}
