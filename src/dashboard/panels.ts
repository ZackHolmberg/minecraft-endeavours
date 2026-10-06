/**
 * Renderers for the telemetry / memory pages (2–4). Pure functions from the
 * adapter view shapes to blessed-tagged strings; every field may be missing
 * on an older snapshot, so each falls back to "—" rather than throwing.
 * Page 1 (overview) renderers stay in index.ts, unchanged from before.
 */

import type { Percentiles, SkillStats, TelemetryAggregate } from "../observability/telemetry-types.js";
import {
  CACHE_HIT_MIN,
  computeFlags,
  CONTEXT_BUILD_P95_MAX_MS,
  FIRST_REPLY_P50_MAX_MS,
  FIRST_REPLY_P95_MAX_MS,
  NEAR_CAP_TURNS,
  SKILL_MIN_CALLS,
  SKILL_SUCCESS_MIN,
} from "../report/flags.js";
import { fmtVec, type MemoryView, type NotableView, type TaskRowView, type TelemetryView } from "./adapters.js";

const DASH = "{gray-fg}—{/}";

// ─────────────────────────────────────────────────────────────────────────────
// Page 2 — performance
// ─────────────────────────────────────────────────────────────────────────────

/** Side-by-side 30-min window vs. whole run, cells colored against flag thresholds. */
export function renderPerfPanel(view: TelemetryView | null): string {
  if (!view) return `  ${DASH} {gray-fg}no telemetry yet{/}`;
  const w = view.window;
  const r = view.run;
  const lines: string[] = [];
  const COL = 18;
  const row = (label: string, f: (a: TelemetryAggregate) => string): void => {
    lines.push(`${pad(label, 17)} ${padTagged(w ? safe(() => f(w)) : DASH, COL)} ${r ? safe(() => f(r)) : DASH}`);
  };
  lines.push(`{bold}${pad("", 17)} ${pad("last 30m", COL)} run${view.runTruncated ? " {yellow-fg}(tail){/}" : ""}{/}`);
  row("tasks", (a) => `${a.tasks.count}`);
  row("  fin/stop/err", (a) => {
    const o = a.tasks.byOutcome;
    const err = (o.failed ?? 0) + (o.max_turns ?? 0) + (o.rate_limited ?? 0);
    return `${o.finished ?? 0}/${o.stopped ?? 0}/${err > 0 ? `{red-fg}${err}{/}` : "0"}`;
  });
  row("first reply p50", (a) => ms(a.tasks.firstReplyMs.p50, FIRST_REPLY_P50_MAX_MS));
  row("first reply p95", (a) => ms(a.tasks.firstReplyMs.p95, FIRST_REPLY_P95_MAX_MS));
  row("turns p50/p95", (a) => `${n(a.tasks.turns.p50)}/${turnsCell(a.tasks.turns.p95)}`);
  row("duration p50/p95", (a) => `${ms(a.tasks.durationMs.p50)}/${ms(a.tasks.durationMs.p95)}`);
  row("queue wait p95", (a) => ms(a.tasks.queueWaitMs.p95));
  row("cache hit", (a) => rate(a.tasks.cacheHitRate, CACHE_HIT_MIN));
  row("context p50/p95", (a) => `${ms(a.tasks.contextBuildMs.p50)}/${ms(a.tasks.contextBuildMs.p95, CONTEXT_BUILD_P95_MAX_MS)}`);
  row("ctx timeouts", (a) => warnIfPositive(a.tasks.contextTimeouts));
  row("guard refusals", (a) => warnIfPositive(a.tasks.guardRefusals));
  row("tokens in/out", (a) => `${tok(a.tasks.tokens.input)}/${tok(a.tasks.tokens.output)}`);
  row("cache read/write", (a) => `${tok(a.tasks.tokens.cacheRead)}/${tok(a.tasks.tokens.cacheCreate)}`);
  row("cost", (a) => (a.tasks.costUsd === null ? DASH : `$${a.tasks.costUsd.toFixed(3)}${a.tasks.count > 0 ? ` {gray-fg}${(a.tasks.costUsd / a.tasks.count).toFixed(3)}/t{/}` : ""}`));
  row("skill calls/fail", (a) => {
    const calls = a.skills.reduce((s, x) => s + x.calls, 0);
    const failed = a.skills.reduce((s, x) => s + x.failed, 0);
    return `${calls}/${failed > 0 ? `{yellow-fg}${failed}{/}` : "0"}`;
  });
  row("nav problems", (a) => warnIfPositive((a.nav.byResult.stuck ?? 0) + (a.nav.byResult.no_path ?? 0) + (a.nav.byResult.timeout ?? 0)));
  row("deaths/disconn", (a) => `${warnIfPositive(a.deaths)}/${warnIfPositive(a.health.disconnects)}`);
  return lines.join("\n");
}

/** Automatic flags (same rules as the report CLI), from the run aggregate. */
export function renderFlags(view: TelemetryView | null): string {
  const agg = view?.run ?? view?.window;
  if (!agg) return `  ${DASH}`;
  let flags;
  try {
    flags = computeFlags(agg);
  } catch {
    return `  ${DASH}`;
  }
  if (flags.length === 0) return "{green-fg}nothing over threshold{/}";
  return flags
    .map((f) => `${f.level === "warn" ? "{yellow-fg}WARN{/}" : "{cyan-fg}info{/}"} ${esc(f.message)}`)
    .join("\n");
}

/** Task history, newest first. `width` = usable inner columns. */
export function renderTaskTable(view: TelemetryView | null, width: number, now: number): string {
  const rows = view?.recentTasks ?? [];
  const head = `${pad("time", 6)} ${pad("outcome", 12)} ${lpad("turns", 5)} ${lpad("dur", 7)} ${lpad("reply", 6)} ${lpad("cache", 5)} ${lpad("cost", 6)}  request`;
  const lines = [`{bold}${head}{/}`];
  if (rows.length === 0) return `${lines[0]}\n${DASH}`;
  const reqWidth = Math.max(10, width - head.length + "request".length);
  for (const t of rows) lines.push(taskLine(t, reqWidth, now));
  return lines.join("\n");
}

function taskLine(t: TaskRowView, reqWidth: number, now: number): string {
  const oc = t.outcome ?? "running";
  const color =
    oc === "finished" ? "green" : oc === "stopped" ? "gray" : oc === "running" ? "cyan" : oc === "rate_limited" ? "magenta" : "red";
  const turns = t.turns === null ? "—" : String(t.turns);
  const turnsC = t.turns !== null && t.turns >= NEAR_CAP_TURNS ? `{red-fg}${lpad(turns, 5)}{/}` : lpad(turns, 5);
  const reply = t.firstReplyMs === null ? "—" : fmtMs(t.firstReplyMs);
  const replyC = t.firstReplyMs !== null && t.firstReplyMs > FIRST_REPLY_P50_MAX_MS ? `{yellow-fg}${lpad(reply, 6)}{/}` : lpad(reply, 6);
  const cache = t.cacheHitRate === null ? "—" : `${Math.round(t.cacheHitRate * 100)}%`;
  const cacheC = t.cacheHitRate !== null && t.cacheHitRate < CACHE_HIT_MIN ? `{yellow-fg}${lpad(cache, 5)}{/}` : lpad(cache, 5);
  const dur = t.durationMs === null ? "—" : fmtMs(t.durationMs);
  const cost = t.costUsd === null ? "—" : t.costUsd.toFixed(3);
  const when = t.at > 0 ? clock(t.at) : "—";
  void now;
  return `${pad(when, 6)} {${color}-fg}${pad(oc, 12)}{/} ${turnsC} ${lpad(dur, 7)} ${replyC} ${cacheC} ${lpad(cost, 6)}  ${esc(trunc(oneLine(t.request), reqWidth))}`;
}

/** Live notable-event feed, newest first. */
export function renderEventFeed(view: TelemetryView | null, width: number, now: number): string {
  const events = view?.notable ?? [];
  if (events.length === 0) return `${DASH} {gray-fg}no notable events{/}`;
  return events.map((e) => feedLine(e, width, now)).join("\n");
}

function feedLine(e: NotableView, width: number, now: number): string {
  const age = now - e.at;
  const ts = `{gray-fg}${clock(e.at, true)}{/}`;
  const ago = age >= 0 && age < 60 * 60 * 1000 ? ` {gray-fg}${fmtAge(age)}{/}` : "";
  return `${ts} {${e.color}-fg}${esc(trunc(oneLine(e.text), Math.max(20, width - 18)))}{/}${ago}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page 3 — skills / movement
// ─────────────────────────────────────────────────────────────────────────────

export function pickAggregate(view: TelemetryView | null, useWindow: boolean): TelemetryAggregate | null {
  if (!view) return null;
  return useWindow ? view.window : view.run;
}

/** Skill stats, judged-worst first; unreliable skills in red. */
export function renderSkillTable(agg: TelemetryAggregate | null, width: number): string {
  const head = `${pad("skill", 20)} ${lpad("calls", 5)} ${lpad("ok%", 5)} ${lpad("fail", 4)} ${lpad("cxl", 3)} ${lpad("wd", 3)} ${lpad("p50", 6)} ${lpad("p95", 6)}  top failure`;
  const lines = [`{bold}${head}{/}`];
  const skills = agg?.skills ?? [];
  if (skills.length === 0) return `${lines[0]}\n${DASH}`;
  const failWidth = Math.max(10, width - head.length + "top failure".length);
  const judged = (s: SkillStats): boolean => s.calls >= SKILL_MIN_CALLS && typeof s.successRate === "number";
  const sorted = [...skills].sort((a, b) => {
    const ja = judged(a), jb = judged(b);
    if (ja !== jb) return ja ? -1 : 1;
    return (a.successRate ?? 1) - (b.successRate ?? 1) || b.calls - a.calls;
  });
  for (const s of sorted) {
    const sr = typeof s.successRate === "number" && Number.isFinite(s.successRate) ? s.successRate : null;
    const okPct = sr === null ? "—" : `${Math.round(sr * 100)}%`;
    const bad = judged(s) && sr !== null && sr < SKILL_SUCCESS_MIN;
    const meh = sr !== null && sr < 0.85;
    const okC = bad ? `{red-fg}${lpad(okPct, 5)}{/}` : meh ? `{yellow-fg}${lpad(okPct, 5)}{/}` : lpad(okPct, 5);
    const name = bad ? `{red-fg}${pad(trunc(s.skill, 20), 20)}{/}` : pad(trunc(s.skill, 20), 20);
    const top = s.topFailures?.[0];
    const topText = top ? `${trunc(oneLine(top.message), failWidth - 5)} ×${top.count}` : "";
    const wd = s.timedOut > 0 ? `{red-fg}${lpad(String(s.timedOut), 3)}{/}` : lpad(String(s.timedOut ?? 0), 3);
    lines.push(
      `${name} ${lpad(String(s.calls ?? 0), 5)} ${okC} ${lpad(String(s.failed ?? 0), 4)} ${lpad(String(s.cancelled ?? 0), 3)} ${wd} ${lpad(pctlMs(s.durationMs, "p50"), 6)} ${lpad(pctlMs(s.durationMs, "p95"), 6)}  {gray-fg}${esc(topText)}{/}`,
    );
  }
  return lines.join("\n");
}

export function renderMovementPanel(agg: TelemetryAggregate | null, now: number): string {
  if (!agg) return `  ${DASH}`;
  const lines: string[] = [];
  const nav = agg.nav;
  lines.push(`{bold}NAV{/}     ${nav?.count ?? 0} runs  p50 ${ms(nav?.durationMs?.p50 ?? null)}  p95 ${ms(nav?.durationMs?.p95 ?? null)}`);
  const order = ["arrived", "cancelled", "stuck", "no_path", "timeout", "error"];
  const byResult = nav?.byResult ?? {};
  const keys = [...order.filter((k) => k in byResult), ...Object.keys(byResult).filter((k) => !order.includes(k))];
  for (const k of keys) {
    const v = byResult[k] ?? 0;
    const color = k === "arrived" ? "green" : k === "cancelled" ? "gray" : v > 0 ? "yellow" : "white";
    const share = nav.count > 0 ? ` {gray-fg}${Math.round((v / nav.count) * 100)}%{/}` : "";
    lines.push(`  {${color}-fg}${pad(k, 10)}{/} ${lpad(String(v), 4)}${share}`);
  }
  lines.push("");
  lines.push("{bold}PROBLEM SPOTS{/}");
  const spots = nav?.problemSpots ?? [];
  if (spots.length === 0) lines.push(`  ${DASH}`);
  for (const p of spots.slice(0, 6)) {
    lines.push(`  {yellow-fg}${pad(p.result, 8)}{/} ${pad(fmtVec(p.from), 14)} ${esc(trunc(oneLine(p.label), 16))} {gray-fg}${fmtAge(now - p.at)}{/}`);
  }
  lines.push("");
  lines.push(`{bold}DOORS{/}   opened ${agg.doors?.opened ?? 0} · closed ${agg.doors?.closed ?? 0}`);
  const pil = agg.pillar;
  const pilFail = pil ? pil.runs - pil.ok : 0;
  lines.push(`{bold}PILLAR{/}  ${pil?.runs ?? 0} runs · ${pil?.ok ?? 0} ok${pilFail > 0 ? ` · {yellow-fg}${pilFail} failed{/}` : ""} · ${pil?.placed ?? 0} placed`);
  lines.push(`{bold}STRUCT{/}  ${agg.structureSkips ?? 0} skip(s) of player-built blocks`);
  const rf = agg.reflexes ?? {};
  lines.push(`{bold}REFLEX{/}  ${Object.entries(rf).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`);
  lines.push(`{bold}HEALTH{/}  deaths ${warnIfPositive(agg.deaths ?? 0)} · disconn ${warnIfPositive(agg.health?.disconnects ?? 0)} · lag ${ms(agg.health?.maxLoopLagMs ?? null, 1000)}`);
  const ch = agg.chat;
  if (ch) lines.push(`{bold}CHAT{/}    in ${ch.inbound} (routed ${ch.routed}, stops ${ch.stops}) · out ${ch.outbound}`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Page 4 — memory (what the bot believes, from disk)
// ─────────────────────────────────────────────────────────────────────────────

export function renderPois(mem: MemoryView, now: number): string {
  const pois = [...mem.pois].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  if (pois.length === 0) return DASH;
  const lines = [`{bold}${pad("name / type", 26)} ${pad("pos", 14)} ${pad("src", 6)} age{/}`];
  for (const p of pois) {
    const lbl = pad(trunc(p.name ? `${p.name} (${p.type})` : p.type, 26), 26);
    const src = p.source === "claude" ? "{cyan-fg}claude{/}" : pad(p.source ?? "—", 6);
    lines.push(`${p.name ? esc(lbl) : `{gray-fg}${esc(lbl)}{/}`} ${pad(fmtVec(p.pos), 14)} ${src} {gray-fg}${p.at ? fmtAge(now - p.at) : "—"}{/}`);
  }
  return lines.join("\n");
}

export function renderContainers(mem: MemoryView, now: number): string {
  const cs = [...mem.containers].sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
  if (cs.length === 0) return DASH;
  const lines = [`{bold}${pad("type", 13)} ${pad("pos", 14)} ${lpad("items", 6)} ${lpad("stk", 3)}  opened{/}`];
  for (const c of cs) {
    const items = c.items === null ? "?" : String(c.items);
    const stacks = c.stacks === null ? "?" : String(c.stacks);
    const opened = c.lastOpened ? `${fmtAge(now - c.lastOpened)}${c.by ? ` by ${c.by}` : ""}` : "never";
    lines.push(`${pad(trunc(c.type, 13), 13)} ${pad(fmtVec(c.pos), 14)} ${lpad(items, 6)} ${lpad(stacks, 3)}  {gray-fg}${esc(opened)}{/}`);
  }
  return lines.join("\n");
}

export function renderDeathsAndQueue(mem: MemoryView, now: number): string {
  const lines: string[] = [];
  lines.push(`{bold}TASK{/}   ${mem.currentTask ? esc(mem.currentTask) : DASH}`);
  if (mem.queued.length === 0) lines.push(`{bold}QUEUE{/}  {gray-fg}empty{/}`);
  else {
    lines.push(`{bold}QUEUE{/}  ${mem.queued.length} remaining`);
    mem.queued.slice(0, 6).forEach((q, i) => lines.push(`  {gray-fg}${i + 1}.{/} ${esc(trunc(oneLine(q), 50))}`));
  }
  lines.push("");
  const total = mem.counts.deaths ?? mem.deaths.length;
  lines.push(`{bold}DEATHS{/} ${total > 0 ? `{red-fg}${total}{/}` : "0"}`);
  const deaths = [...mem.deaths].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  for (const d of deaths.slice(0, 5)) {
    lines.push(`  {red-fg}${esc(trunc(d.cause, 18))}{/} @ ${fmtVec(d.pos)} {gray-fg}${d.at ? fmtAge(now - d.at) : ""}{/}`);
  }
  if (mem.error) {
    lines.push("");
    lines.push(`{red-fg}world.json: ${esc(trunc(mem.error, 60))}{/}`);
  }
  return lines.join("\n");
}

export function renderConversation(mem: MemoryView, width: number, now: number, botName: string): string {
  const conv = mem.conversation;
  if (conv.length === 0) return DASH;
  return conv
    .map((e) => {
      const ts = `{gray-fg}${clock(e.at)} ${pad(fmtAge(now - e.at), 4)}{/}`;
      const room = Math.max(20, width - 12);
      switch (e.kind) {
        case "player": {
          const who = e.channel === "whisper" ? `${e.who ?? "?"} → ${botName}` : `<${e.who ?? "?"}>`;
          return `${ts} {white-fg}{bold}${esc(who)}{/} ${esc(trunc(oneLine(e.text), room - who.length - 1))}`;
        }
        case "bot": {
          const who = e.channel === "whisper" ? `${botName} → ${e.to ?? "?"}` : `<${botName}>`;
          return `${ts} {cyan-fg}${esc(who)} ${esc(trunc(oneLine(e.text), room - who.length - 1))}{/}`;
        }
        case "outcome":
          return `${ts} {gray-fg}[result] ${esc(trunc(oneLine(e.text), room - 9))}{/}`;
        default:
          return `${ts} ${esc(trunc(oneLine(e.text), room))}`;
      }
    })
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function safe(f: () => string): string {
  try {
    return f();
  } catch {
    return DASH;
  }
}

function fin(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function ms(v: number | null | undefined, warnAbove?: number): string {
  if (!fin(v)) return DASH;
  const s = fmtMs(v);
  return warnAbove !== undefined && v > warnAbove ? `{red-fg}${s}{/}` : s;
}

function n(v: number | null | undefined): string {
  return fin(v) ? String(Math.round(v)) : DASH;
}

function turnsCell(v: number | null): string {
  if (!fin(v)) return DASH;
  return v >= NEAR_CAP_TURNS ? `{red-fg}${Math.round(v)}{/}` : String(Math.round(v));
}

function rate(v: number | null, warnBelow: number): string {
  if (!fin(v)) return DASH;
  const s = `${Math.round(v * 100)}%`;
  return v < warnBelow ? `{red-fg}${s}{/}` : `{green-fg}${s}{/}`;
}

function warnIfPositive(v: number): string {
  if (!fin(v)) return DASH;
  return v > 0 ? `{yellow-fg}${v}{/}` : "0";
}

function pctlMs(p: Percentiles | undefined, k: "p50" | "p95"): string {
  const v = p?.[k];
  return fin(v) ? fmtMs(v) : "—";
}

export function fmtMs(v: number): string {
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function tok(v: number | null | undefined): string {
  if (!fin(v)) return "—";
  if (v < 1000) return `${v}`;
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(2)}M`;
}

function fmtAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function clock(at: number, seconds = false): string {
  const d = new Date(at);
  const p = (x: number): string => (x < 10 ? `0${x}` : `${x}`);
  return seconds ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Escape blessed tag braces in free text (requests, chat, failure messages). */
function esc(s: string): string {
  return s.replace(/[{}]/g, (c) => (c === "{" ? "{open}" : "{close}"));
}

function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ");
}

function trunc(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function lpad(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

/** Pad a tagged string by its visible width. */
function padTagged(s: string, w: number): string {
  const visible = s.replace(/\{[^}]*\}/g, "").length;
  return visible >= w ? s : s + " ".repeat(w - visible);
}
