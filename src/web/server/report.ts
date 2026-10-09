/**
 * Bot report + events, built on the same modules the CLI uses
 * (`observability/aggregate`, `report/flags`, `report/tasks`,
 * `report/read-events`). Only the window parsing is restated here because
 * the CLI keeps it private to its entry point (which runs main() on import).
 */
import { aggregate } from "../../observability/aggregate.js";
import type { TelemetryEvent } from "../../observability/telemetry-types.js";
import { computeFlags, STUCK_RADIUS_BLOCKS } from "../../report/flags.js";
import { listTelemetryBots, readBotEvents } from "../../report/read-events.js";
import { buildTaskRows, clusterProblemSpots } from "../../report/tasks.js";
import type { ReportResponse } from "../shared/api.js";
import { BOT_NAME_RE, ValidationError } from "./validate.js";

const DEFAULT_BOT = "Steve_AI";

export function resolveBot(dir: string, raw: string | null): string {
  const bots = listTelemetryBots(dir);
  let bot = raw;
  if (!bot) bot = bots.length === 1 ? bots[0]! : bots.includes(DEFAULT_BOT) || bots.length === 0 ? DEFAULT_BOT : bots[0]!;
  if (!BOT_NAME_RE.test(bot)) throw new ValidationError("invalid bot name");
  if (!bots.includes(bot)) throw Object.assign(new Error(`no telemetry for ${bot}`), { code: "not_found" });
  return bot;
}

function selectWindow(all: TelemetryEvent[], since: string, now: number): { start: number; label: string; events: TelemetryEvent[] } {
  if (since === "all") return { start: all[0]?.at ?? now, label: "all events on disk", events: all };
  if (since === "run") {
    const runId = all[all.length - 1]?.runId;
    const events = runId ? all.filter((e) => e.runId === runId) : [];
    return { start: events[0]?.at ?? now, label: `latest run (${runId ?? "none"})`, events };
  }
  if (since === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const start = d.getTime();
    return { start, label: "today", events: all.filter((e) => e.at >= start) };
  }
  const m = /^(\d{1,4})([mhd])$/.exec(since);
  if (!m) throw new ValidationError("since must be run|today|all|<N>m|<N>h|<N>d");
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  const start = now - Number(m[1]) * unit;
  return { start, label: `last ${since}`, events: all.filter((e) => e.at >= start) };
}

export function buildReport(dir: string, botRaw: string | null, sinceRaw: string | null): ReportResponse {
  const bot = resolveBot(dir, botRaw);
  const now = Date.now();
  const all = readBotEvents(dir, bot).events;
  const win = selectWindow(all, sinceRaw || "run", now);
  const agg = aggregate(win.events, win.start, now);
  const flags = computeFlags(agg, { tasks: buildTaskRows(win.events), clusters: clusterProblemSpots(win.events, STUCK_RADIUS_BLOCKS) });
  return { bot, window: { from: win.start, to: now, label: win.label }, aggregate: agg, flags };
}

export function queryEvents(dir: string, botRaw: string | null, sinceRaw: string | null, kindsRaw: string | null, limit: number): TelemetryEvent[] {
  const bot = resolveBot(dir, botRaw);
  let since = 0;
  if (sinceRaw) {
    if (!/^\d{1,15}$/.test(sinceRaw)) throw new ValidationError("since must be unix ms");
    since = Number(sinceRaw);
  }
  let kinds: Set<string> | null = null;
  if (kindsRaw) {
    const list = kindsRaw.split(",").map((k) => k.trim()).filter(Boolean);
    if (list.length > 32 || list.some((k) => !/^[a-z_]{1,32}$/.test(k))) throw new ValidationError("invalid kinds");
    kinds = new Set(list);
  }
  const events = readBotEvents(dir, bot).events.filter((e) => e.at >= since && (!kinds || kinds.has(e.kind)));
  return events.slice(-limit).reverse();
}

export function isNotable(e: { kind?: unknown; reflex?: unknown; ok?: unknown }): boolean {
  switch (e.kind) {
    case "reflex":
      return e.reflex !== "look";
    case "skill":
      return e.ok === false;
    case "chat_in":
    case "chat_out":
      return false;
    default:
      return typeof e.kind === "string";
  }
}
