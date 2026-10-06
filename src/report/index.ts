/**
 * Post-session performance report. Reads the telemetry JSONL directly
 * (`data/orchestrator/telemetry/<bot>/events*.jsonl`), so it works whether or
 * not the bot is running, aggregates the chosen window with the shared
 * `aggregate()`, and prints a concise plain-text report plus automatic flags.
 *
 *   ./scripts/botReport.sh [--bot Steve_AI] [--since run|today|all|2h|30m|1d] [--json] [--dir PATH]
 *
 * `--dir` (or env BOT_TELEMETRY_DIR) points at a different telemetry root —
 * used for testing against synthetic data. Read-only; starts nothing.
 */

import { aggregate } from "../observability/aggregate.js";
import type { TelemetryAggregate, TelemetryEvent } from "../observability/telemetry-types.js";
import { computeFlags, NEAR_CAP_TURNS, STUCK_RADIUS_BLOCKS, type Flag } from "./flags.js";
import { listTelemetryBots, readBotEvents, resolveTelemetryDir } from "./read-events.js";
import { buildTaskRows, clusterProblemSpots, type TaskRow } from "./tasks.js";

const DEFAULT_BOT = "Steve_AI";
const DEFAULT_SINCE = "run";
const SKILL_ROWS = 15;
const NOTABLE_TASK_ROWS = 8;

interface Args {
  bot: string | null;
  since: string;
  json: boolean;
  dir: string | null;
}

function usage(code: number): never {
  const out = code === 0 ? console.log : console.error;
  out(
    [
      "usage: botReport.sh [--bot NAME] [--since run|today|all|<N>m|<N>h|<N>d] [--json] [--dir PATH]",
      "",
      "  --bot    bot username (default: Steve_AI, or the only bot with telemetry)",
      "  --since  window: run = latest orchestrator run (default), today = since local midnight,",
      "           all = everything on disk, or a duration like 30m / 2h / 1d",
      "  --json   print the raw aggregate (plus window metadata) as JSON",
      "  --dir    telemetry root (default data/orchestrator/telemetry; env BOT_TELEMETRY_DIR)",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { bot: null, since: DEFAULT_SINCE, json: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined) {
        console.error(`botReport: ${flag} needs a value`);
        usage(2);
      }
      return v;
    };
    switch (flag) {
      case "--bot": args.bot = value(); break;
      case "--since": args.since = value(); break;
      case "--dir": args.dir = value(); break;
      case "--json": args.json = true; break;
      case "-h": case "--help": usage(0);
      // eslint-disable-next-line no-fallthrough
      default:
        console.error(`botReport: unknown argument ${a}`);
        usage(2);
    }
  }
  return args;
}

interface Window {
  start: number;
  end: number;
  label: string;
  events: TelemetryEvent[];
}

function selectWindow(all: TelemetryEvent[], since: string, now: number): Window {
  const end = now;
  if (since === "all") {
    return { start: all[0]?.at ?? now, end, label: "all events on disk", events: all };
  }
  if (since === "run") {
    const runId = all[all.length - 1]?.runId;
    const events = runId ? all.filter((e) => e.runId === runId) : [];
    return { start: events[0]?.at ?? now, end, label: `latest run (${runId ?? "none"})`, events };
  }
  if (since === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const start = d.getTime();
    return { start, end, label: "today", events: all.filter((e) => e.at >= start) };
  }
  const m = /^(\d+(?:\.\d+)?)\s*([mhd])$/.exec(since);
  if (!m) {
    console.error(`botReport: can't parse --since ${since}`);
    usage(2);
  }
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  const start = now - Number(m[1]) * unit;
  return { start, end, label: `last ${since}`, events: all.filter((e) => e.at >= start) };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolveTelemetryDir(args.dir);
  const bots = listTelemetryBots(dir);

  let bot = args.bot;
  if (!bot) bot = bots.length === 1 ? bots[0]! : bots.includes(DEFAULT_BOT) || bots.length === 0 ? DEFAULT_BOT : bots[0]!;
  if (!bots.includes(bot)) {
    console.error(`botReport: no telemetry for "${bot}" under ${dir}`);
    console.error(bots.length > 0 ? `  bots with telemetry: ${bots.join(", ")}` : "  (no telemetry recorded yet — run the bot with telemetry enabled first)");
    process.exit(1);
  }

  const read = readBotEvents(dir, bot);
  const now = Date.now();
  const win = selectWindow(read.events, args.since, now);
  const agg = aggregate(win.events, win.start, win.end);
  const tasks = buildTaskRows(win.events);
  const clusters = clusterProblemSpots(win.events, STUCK_RADIUS_BLOCKS);
  const flags = computeFlags(agg, { tasks, clusters });
  const runs = new Set(read.events.map((e) => e.runId)).size;

  if (args.json) {
    console.log(JSON.stringify({
      bot,
      window: { label: win.label, start: win.start, end: win.end, events: win.events.length },
      aggregate: agg,
      flags,
    }, null, 2));
    return;
  }

  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  console.log(renderReport({ bot, win, agg, tasks, clusters, flags, runs, skipped: read.skippedLines, color }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

interface RenderInput {
  bot: string;
  win: Window;
  agg: TelemetryAggregate;
  tasks: TaskRow[];
  clusters: ReturnType<typeof clusterProblemSpots>;
  flags: Flag[];
  runs: number;
  skipped: number;
  color: boolean;
}

export function renderReport(r: RenderInput): string {
  const c = colorizer(r.color);
  const { agg } = r;
  const t = agg.tasks;
  const out: string[] = [];
  const h = (s: string): void => {
    out.push("");
    out.push(c.bold(s));
  };

  out.push(c.bold(`Bot report · ${r.bot} · ${r.win.label}`));
  out.push(c.dim(`${fmtTime(r.win.start)} → ${fmtTime(r.win.end)}  (${fmtDur(r.win.end - r.win.start)}, ${r.win.events.length} events, ${r.runs} run(s) on disk${r.skipped ? `, ${r.skipped} unreadable line(s) skipped` : ""})`));

  // ── Flags first: the point of the report ──────────────────────────────
  h("Flags");
  if (r.flags.length === 0) out.push(`  ${c.green("none — nothing over threshold")}`);
  for (const f of r.flags) {
    out.push(`  ${f.level === "warn" ? c.yellow("WARN") : c.cyan("info")}  ${f.message}`);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────
  h("Tasks");
  const outcomes = Object.entries(t.byOutcome).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · ");
  out.push(`  ${t.count} tasks${outcomes ? `  (${outcomes})` : ""}`);
  out.push(`  first reply  ${pctl(t.firstReplyMs, fmtMs)}`);
  out.push(`  duration     ${pctl(t.durationMs, fmtMs)}`);
  out.push(`  turns        ${pctl(t.turns, (n) => String(Math.round(n)))}`);
  out.push(`  queue wait   ${pctl(t.queueWaitMs, fmtMs)}`);
  out.push(`  context      ${pctl(t.contextBuildMs, fmtMs)}   timeouts ${t.contextTimeouts}`);
  out.push(`  cache hit    ${t.cacheHitRate === null ? "—" : fmtPct(t.cacheHitRate)}   guard refusals ${t.guardRefusals}`);
  const tok = t.tokens;
  out.push(`  tokens       in ${fmtTok(tok.input)} · cache_r ${fmtTok(tok.cacheRead)} · cache_w ${fmtTok(tok.cacheCreate)} · out ${fmtTok(tok.output)}`);
  out.push(`  cost         ${t.costUsd === null ? "—" : `$${t.costUsd.toFixed(4)}${t.count > 0 ? `  ($${(t.costUsd / t.count).toFixed(4)}/task)` : ""}`}`);

  const notable = notableTasks(r.tasks);
  if (notable.length > 0) {
    out.push("");
    out.push(c.dim("  notable tasks (cap / failures / slowest first reply):"));
    for (const row of notable) {
      const oc = row.outcome ?? "running";
      const ocs = oc === "finished" ? c.green(oc) : oc === "stopped" ? c.dim(oc) : oc === "running" ? c.cyan(oc) : c.red(oc);
      out.push(`  ${fmtClock(row.at)}  ${pad(ocs, 12, oc.length)} ${padN(row.turns, 3)}t  reply ${padS(row.firstReplyMs === null ? "—" : fmtMs(row.firstReplyMs), 6)}  ${padS(row.durationMs === null ? "—" : fmtMs(row.durationMs), 7)}  "${trunc(row.request, 48)}"`);
    }
  }

  // ── Skills ────────────────────────────────────────────────────────────
  h("Skills (worst success first)");
  if (agg.skills.length === 0) out.push("  —");
  else {
    out.push(c.dim(`  ${padS("skill", 22)} ${padS("calls", 5, true)} ${padS("ok%", 5, true)} ${padS("p50", 7, true)} ${padS("p95", 7, true)}  top failure`));
    const sorted = [...agg.skills].sort((a, b) => (a.successRate ?? 1) - (b.successRate ?? 1) || b.calls - a.calls);
    for (const s of sorted.slice(0, SKILL_ROWS)) {
      const rate = s.successRate === null ? "—" : fmtPct(s.successRate);
      const rateC = s.successRate !== null && s.calls >= 5 && s.successRate < 0.6 ? c.red(rate) : s.successRate !== null && s.successRate < 0.85 ? c.yellow(rate) : rate;
      const top = s.topFailures[0];
      out.push(`  ${padS(trunc(s.skill, 22), 22)} ${padS(String(s.calls), 5, true)} ${pad(rateC, 5, rate.length, true)} ${padS(s.durationMs.p50 === null ? "—" : fmtMs(s.durationMs.p50), 7, true)} ${padS(s.durationMs.p95 === null ? "—" : fmtMs(s.durationMs.p95), 7, true)}  ${top ? `${trunc(top.message, 40)} ×${top.count}` : ""}${s.timedOut ? c.red(`  [${s.timedOut} watchdog]`) : ""}`);
    }
    if (sorted.length > SKILL_ROWS) out.push(c.dim(`  … ${sorted.length - SKILL_ROWS} more`));
  }

  // ── Movement / world ──────────────────────────────────────────────────
  h("Movement & world");
  const nav = agg.nav;
  const navBreak = Object.entries(nav.byResult).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ");
  out.push(`  nav          ${nav.count} runs${navBreak ? `  (${navBreak})` : ""}   p50 ${nav.durationMs.p50 === null ? "—" : fmtMs(nav.durationMs.p50)}`);
  const repeated = r.clusters.filter((cl) => cl.count >= 2);
  if (repeated.length > 0) {
    out.push(`  problem spots (≤${STUCK_RADIUS_BLOCKS} blocks):`);
    for (const cl of repeated.slice(0, 5)) {
      const kinds = Object.entries(cl.results).map(([k, n]) => `${k}×${n}`).join(" ");
      out.push(`    ${padS(fmtVec(cl.center), 16)} ${cl.count}×  ${kinds}  ${c.dim(cl.labels.slice(0, 3).join(", "))}`);
    }
  } else if (nav.problemSpots.length > 0) {
    out.push(`  recent problems: ${nav.problemSpots.slice(0, 4).map((p) => `${p.result}@${fmtVec(p.from)}`).join(", ")}`);
  }
  out.push(`  doors        opened ${agg.doors.opened} · closed ${agg.doors.closed}`);
  out.push(`  pillar       ${agg.pillar.runs} runs · ${agg.pillar.ok} ok · ${agg.pillar.placed} placed`);
  out.push(`  structure    ${agg.structureSkips} skip(s) of player-built blocks`);
  out.push(`  reflexes     ${Object.entries(agg.reflexes).map(([k, n]) => `${k} ${n}`).join(" · ")}`);

  // ── Health ────────────────────────────────────────────────────────────
  h("Health");
  const deathEvents = r.win.events.filter((e): e is Extract<TelemetryEvent, { kind: "death" }> => e.kind === "death");
  out.push(`  deaths       ${agg.deaths}${deathEvents.length ? `  (${deathEvents.slice(-3).map((d) => `${d.cause} @ ${fmtVec(d.pos)}`).join("; ")})` : ""}`);
  out.push(`  disconnects  ${agg.health.disconnects}   rate-limit events ${agg.health.rateLimitEvents}   max loop lag ${agg.health.maxLoopLagMs === null ? "—" : fmtMs(agg.health.maxLoopLagMs)}`);
  out.push(`  chat         in ${agg.chat.inbound} (routed ${agg.chat.routed}, stops ${agg.chat.stops}) · out ${agg.chat.outbound}`);

  return out.join("\n");
}

function notableTasks(rows: TaskRow[]): TaskRow[] {
  const picked = new Set<TaskRow>();
  for (const r of rows) if (r.outcome === "max_turns" || r.outcome === "failed" || r.outcome === "rate_limited") picked.add(r);
  for (const r of rows) if (r.turns !== null && r.turns >= NEAR_CAP_TURNS) picked.add(r);
  const slow = rows.filter((r) => r.firstReplyMs !== null).sort((a, b) => b.firstReplyMs! - a.firstReplyMs!).slice(0, 3);
  for (const r of slow) picked.add(r);
  return [...picked].sort((a, b) => a.at - b.at).slice(-NOTABLE_TASK_ROWS);
}

// ── Formatters ──────────────────────────────────────────────────────────────

function pctl(p: { count: number; p50: number | null; p95: number | null; max: number | null }, f: (n: number) => string): string {
  if (!p || p.count === 0) return "—";
  const g = (n: number | null): string => (n === null ? "—" : f(n));
  return `p50 ${padS(g(p.p50), 6)} p95 ${padS(g(p.p95), 6)} max ${padS(g(p.max), 6)}  (n=${p.count})`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtDur(ms);
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const hrs = Math.floor(m / 60);
  return `${hrs}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

function fmtTok(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtPct(r: number): string {
  return `${Math.round(r * 100)}%`;
}

function fmtVec(v: { x: number; y: number; z: number }): string {
  return `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${fmtClock(ms)}`;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function p2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function padS(s: string, n: number, right = false): string {
  return pad(s, n, s.length, right);
}

function padN(v: number | null, n: number): string {
  return padS(v === null ? "—" : String(v), n, true);
}

/** Pad by visible length (colored strings carry escape codes). */
function pad(s: string, n: number, visible: number, right = false): string {
  const fill = " ".repeat(Math.max(0, n - visible));
  return right ? fill + s : s + fill;
}

function colorizer(on: boolean) {
  const wrap = (code: string) => (s: string): string => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    cyan: wrap("36"),
  };
}

main();
