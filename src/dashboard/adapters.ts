/**
 * Adapters between the snapshot file and the dashboard's telemetry / memory
 * pages. Every access to the snapshot's `telemetry` and `memory` sections
 * goes through here, so the panels render one stable view shape no matter
 * which snapshot version the orchestrator writes.
 *
 * Fallbacks: when an (older) snapshot has no `telemetry` / `memory` section,
 * the views are rebuilt from disk instead — telemetry JSONL via
 * `aggregate()`, memory from `data/orchestrator/memory/<bot>/*.json` — on a
 * slower cadence than the 500ms poll. Both paths are read-only.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { aggregate } from "../observability/aggregate.js";
import type { BotSnapshot, MemoryFields, TelemetryFields } from "../observability/snapshot.js";
import type { TelemetryAggregate, TelemetryEvent, Vec } from "../observability/telemetry-types.js";
import { readBotEvents, resolveTelemetryDir } from "../report/read-events.js";
import { buildTaskRows } from "../report/tasks.js";

export const WINDOW_MS = 30 * 60 * 1000;
const TASK_ROWS = 40;
const NOTABLE_ROWS = 60;
const DISK_TELEMETRY_REFRESH_MS = 5_000;
const DISK_MEMORY_REFRESH_MS = 2_000;
const CONVERSATION_TAIL = 30;
const MEMORY_DIR = "data/orchestrator/memory";

// ─────────────────────────────────────────────────────────────────────────────
// View shapes (what the panels consume)
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskRowView {
  at: number;
  request: string;
  /** null = still running. */
  outcome: string | null;
  turns: number | null;
  durationMs: number | null;
  firstReplyMs: number | null;
  cacheHitRate: number | null;
  costUsd: number | null;
}

export interface NotableView {
  at: number;
  kind: string;
  /** "red" | "yellow" | "magenta" | "cyan" | "gray" — blessed tag color. */
  color: string;
  text: string;
}

export interface TelemetryView {
  source: "snapshot" | "disk";
  window: TelemetryAggregate | null;
  run: TelemetryAggregate | null;
  /** The in-memory ring wrapped; `run` covers only its retained tail. */
  runTruncated: boolean;
  /** Newest first. */
  recentTasks: TaskRowView[];
  /** Newest first. */
  notable: NotableView[];
}

export interface MemoryView {
  source: "snapshot" | "disk";
  pois: Array<{ type: string; name: string | null; pos: Vec | null; at: number | null; source: string | null }>;
  containers: Array<{ type: string; pos: Vec | null; lastOpened: number | null; by: string | null; stacks: number | null; items: number | null }>;
  deaths: Array<{ pos: Vec | null; cause: string; at: number | null }>;
  currentTask: string | null;
  queued: string[];
  /** Oldest first. */
  conversation: Array<{ at: number; kind: string; who: string | null; to: string | null; channel: string | null; text: string }>;
  /** Totals on disk (the lists above may be the newest slice only). */
  counts: { pois: number | null; containers: number | null; deaths: number | null; conversation: number | null };
  error: string | null;
  refreshedAt: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compile-time tripwire: the loose mappers below read these exact field
// names. If snapshot.ts renames one, this stops typechecking — update the
// mapper alongside it. Never called.
// ─────────────────────────────────────────────────────────────────────────────

export function _snapshotFieldsUsed(t: TelemetryFields, m: MemoryFields): unknown[] {
  const task = t.recentTasks[0];
  return [
    t.last30m, t.run, t.runTruncated, t.notable,
    t.currentTask?.startedAt, t.currentTask?.runningMs, t.currentTask?.request, t.currentTask?.firstReplyMs,
    task?.start?.at, task?.start?.request, task?.end.outcome, task?.end.turns, task?.end.durationMs,
    task?.end.firstReplyMs, task?.end.cacheReadTokens, task?.end.cacheCreateTokens, task?.end.inputTokens, task?.end.costUsd,
    m.refreshedAt, m.error, m.pois.count, m.pois.latest[0]?.position, m.pois.latest[0]?.timestamp,
    m.containers.count, m.containers.latest[0]?.last_opened, m.containers.latest[0]?.last_opened_by, m.containers.latest[0]?.contents,
    m.deaths.count, m.deaths.latest[0]?.cause, m.conversation.count, m.conversation.tail[0]?.text,
    m.tasks?.currentTask, m.tasks?.queued,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry
// ─────────────────────────────────────────────────────────────────────────────

const diskTelemetryCache = new Map<string, { at: number; view: TelemetryView | null }>();

export function getTelemetryView(snap: BotSnapshot): TelemetryView | null {
  const raw = (snap as unknown as { telemetry?: unknown }).telemetry;
  if (isObj(raw)) return fromSnapshotTelemetry(raw);
  return telemetryFromDisk(snap.username, snap.capturedAt ?? Date.now());
}

/**
 * Maps the snapshot's `telemetry` section (see SNAPSHOT_FIELDS.md:
 * `last30m`, `run`, `recentTasks` as {start,end} pairs and `notable`, both
 * newest first). Each lookup is defensive so an older/partial snapshot
 * renders "—" instead of throwing.
 */
function fromSnapshotTelemetry(t: Record<string, unknown>): TelemetryView {
  const window = asAggregate(t.last30m);
  const run = asAggregate(t.run);
  const tasks = arr(t.recentTasks).map(asTaskRow).filter((r): r is TaskRowView => r !== null);
  const cur = isObj(t.currentTask) ? t.currentTask : null;
  if (cur) {
    tasks.push({
      at: num(cur.startedAt) ?? 0,
      request: str(cur.request) ?? "?",
      outcome: null,
      turns: null,
      durationMs: num(cur.runningMs),
      firstReplyMs: num(cur.firstReplyMs),
      cacheHitRate: null,
      costUsd: null,
    });
  }
  const notable = arr(t.notable)
    .map((e) => (isObj(e) && typeof e.kind === "string" && typeof e.at === "number" ? describeEvent(e as unknown as TelemetryEvent) : null))
    .filter((n): n is NotableView => n !== null);
  return {
    source: "snapshot",
    window,
    run,
    runTruncated: t.runTruncated === true,
    recentTasks: sortNewest(tasks).slice(0, TASK_ROWS),
    notable: sortNewest(notable).slice(0, NOTABLE_ROWS),
  };
}

function telemetryFromDisk(bot: string, now: number): TelemetryView | null {
  const cached = diskTelemetryCache.get(bot);
  if (cached && Date.now() - cached.at < DISK_TELEMETRY_REFRESH_MS) return cached.view;
  let view: TelemetryView | null = null;
  try {
    const { events } = readBotEvents(resolveTelemetryDir(), bot);
    if (events.length > 0) {
      const runId = events[events.length - 1]!.runId;
      const runEvents = events.filter((e) => e.runId === runId);
      const winEvents = runEvents.filter((e) => e.at >= now - WINDOW_MS);
      const rows = buildTaskRows(runEvents).map<TaskRowView>((r) => ({
        at: r.at,
        request: r.request,
        outcome: r.outcome,
        turns: r.turns,
        durationMs: r.durationMs,
        firstReplyMs: r.firstReplyMs,
        cacheHitRate: r.cacheHitRate,
        costUsd: r.costUsd,
      }));
      const notable = runEvents
        .map(describeEvent)
        .filter((n): n is NotableView => n !== null);
      view = {
        source: "disk",
        window: aggregate(winEvents, now - WINDOW_MS, now),
        run: aggregate(runEvents, runEvents[0]!.at, now),
        runTruncated: false,
        recentTasks: sortNewest(rows).slice(0, TASK_ROWS),
        notable: sortNewest(notable).slice(0, NOTABLE_ROWS),
      };
    }
  } catch {
    view = null;
  }
  diskTelemetryCache.set(bot, { at: Date.now(), view });
  return view;
}

/**
 * One-line feed description, or null for routine noise (successful skills,
 * plain chat, look reflexes — the same exclusions the snapshot's `notable`
 * list applies). Problems are colored; routine-but-interesting events
 * (doors, arrivals, reflexes, finished tasks) render gray.
 */
export function describeEvent(e: TelemetryEvent): NotableView | null {
  // A malformed / older-version event shows as its bare kind, never "undefined".
  const n = (color: string, text: string): NotableView =>
    /undefined|NaN/.test(text) ? { at: e.at, kind: e.kind, color: "gray", text: e.kind } : { at: e.at, kind: e.kind, color, text };
  try {
    switch (e.kind) {
      case "death":
        return n("red", `DEATH ${e.cause} @ ${fmtVec(e.pos)}`);
      case "hurt":
        return e.health <= 6 ? n("red", `low health ${e.health}/20${e.by ? ` (by ${e.by})` : e.cause ? ` (${e.cause})` : ""}`) : n("gray", `hurt → ${e.health}/20${e.by ? ` by ${e.by}` : e.cause ? ` (${e.cause})` : ""}`);
      case "chat_in":
        return e.isStop ? n("yellow", `stop from ${e.player}`) : null;
      case "chat_out":
        return null;
      case "nav":
        if (e.result === "arrived") return n("gray", `nav arrived ${e.label} (${fmtMs(e.durationMs)}, ${Math.round(e.distance)}b)`);
        if (e.result === "cancelled") return n("gray", `nav cancelled → ${e.label}`);
        return n("yellow", `nav ${e.result} → ${e.label} from ${fmtVec(e.from)} (${fmtMs(e.durationMs)})`);
      case "door":
        return n("gray", `door ${e.action} ${e.block} @ ${fmtVec(e.pos)}`);
      case "pillar":
        return e.ok ? n("gray", `pillar ok ${e.placed}/${e.requested}`) : n("yellow", `pillar failed ${e.placed}/${e.requested}${e.reason ? `: ${e.reason}` : ""}`);
      case "structure_skip":
        return n("gray", `structure guard skipped ${e.skipped} ${e.block}`);
      case "reflex":
        return e.reflex === "look" ? null : n(e.reflex === "defend" ? "yellow" : "gray", `reflex ${e.reflex}${e.detail ? `: ${e.detail}` : ""}`);
      case "guard_refusal":
        return n("magenta", `guard refused repeat ${e.tool} ${truncate(e.args, 40)}`);
      case "skill":
        if (e.ok) return null;
        if (e.timedOut) return n("red", `watchdog: ${e.skill} after ${fmtMs(e.durationMs)}`);
        if (e.cancelled) return n("gray", `${e.skill} cancelled`);
        return n("yellow", `${e.skill} failed: ${truncate(e.message, 60)}`);
      case "task_start":
        return e.contextBuildMs === null && e.contextInjected !== false
          ? n("yellow", `task start (context build timed out): "${truncate(e.request, 40)}"`)
          : n("gray", `task start: "${truncate(e.request, 50)}"`);
      case "task_end":
        if (e.outcome === "finished") return n("green", `task finished ${e.turns}t / ${fmtMs(e.durationMs)}`);
        if (e.outcome === "stopped") return n("yellow", `task stopped after ${e.turns}t / ${fmtMs(e.durationMs)}`);
        return n(e.outcome === "rate_limited" ? "magenta" : "red", `task ${e.outcome} (${e.subtype}) after ${e.turns}t / ${fmtMs(e.durationMs)}`);
      case "connection":
        return e.state === "connected" ? n("cyan", "connected") : n("red", `${e.state}${e.reason ? `: ${e.reason}` : ""}`);
      case "loop_lag":
        return n("yellow", `event-loop lag ${fmtMs(e.lagMs)}`);
      case "rate_limit":
        return n("magenta", `rate limit ${e.status}${e.resetsAt ? ` (resets ${clock(e.resetsAt)})` : ""}`);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function asAggregate(v: unknown): TelemetryAggregate | null {
  // Must at least have the tasks block; panels guard individual fields.
  return isObj(v) && isObj(v.tasks) ? (v as unknown as TelemetryAggregate) : null;
}

function asTaskRow(v: unknown): TaskRowView | null {
  if (!isObj(v) || !isObj(v.end)) return null;
  const start = isObj(v.start) ? v.start : {};
  const end = v.end;
  const cacheRead = num(end.cacheReadTokens) ?? 0;
  const denom = cacheRead + (num(end.cacheCreateTokens) ?? 0) + (num(end.inputTokens) ?? 0);
  const durationMs = num(end.durationMs);
  return {
    at: num(start.at) ?? (num(end.at) ?? 0) - (durationMs ?? 0),
    request: str(start.request) ?? "?",
    outcome: str(end.outcome),
    turns: num(end.turns),
    durationMs,
    firstReplyMs: num(end.firstReplyMs),
    cacheHitRate: denom > 0 ? cacheRead / denom : null,
    costUsd: num(end.costUsd),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory
// ─────────────────────────────────────────────────────────────────────────────

const diskMemoryCache = new Map<string, { at: number; view: MemoryView }>();

export function getMemoryView(snap: BotSnapshot): MemoryView {
  const raw = (snap as unknown as { memory?: unknown }).memory;
  const view = isObj(raw) && hasMemoryLists(raw) ? fromSnapshotMemory(raw) : memoryFromDisk(snap.username);
  // The live task queue in `state` is always freshest.
  const st = snap.state;
  if (st && (st.currentTask !== undefined || Array.isArray(st.remainingTasks))) {
    return { ...view, currentTask: st.currentTask ?? null, queued: Array.isArray(st.remainingTasks) ? st.remainingTasks : view.queued };
  }
  return view;
}

function hasMemoryLists(m: Record<string, unknown>): boolean {
  return isObj(m.pois) || isObj(m.containers) || isObj(m.conversation);
}

/** Maps `memory` (SNAPSHOT_FIELDS.md): `{count, latest[]}` lists, `conversation.tail`, `tasks`. */
function fromSnapshotMemory(m: Record<string, unknown>): MemoryView {
  const latest = (v: unknown): unknown[] => (isObj(v) ? arr(v.latest) : arr(v));
  const count = (v: unknown): number | null => (isObj(v) ? num(v.count) : null);
  const tasks = isObj(m.tasks) ? m.tasks : {};
  return {
    source: "snapshot",
    ...mapWorld({ pois: latest(m.pois), containers: latest(m.containers), deaths: latest(m.deaths) }),
    counts: {
      pois: count(m.pois),
      containers: count(m.containers),
      deaths: count(m.deaths),
      conversation: count(m.conversation),
    },
    error: str(m.error),
    refreshedAt: num(m.refreshedAt),
    currentTask: str(tasks.currentTask),
    queued: arr(tasks.queued).filter((x): x is string => typeof x === "string"),
    conversation: mapConversation(isObj(m.conversation) ? arr(m.conversation.tail) : []),
  };
}

function memoryFromDisk(bot: string): MemoryView {
  const cached = diskMemoryCache.get(bot);
  if (cached && Date.now() - cached.at < DISK_MEMORY_REFRESH_MS) return cached.view;
  const dir = resolve(process.cwd(), MEMORY_DIR, bot);
  const world = readJson(resolve(dir, "world.json"));
  const conv = readJson(resolve(dir, "conversation.json"));
  const tasks = readJson(resolve(dir, "tasks.json"));
  const view: MemoryView = {
    source: "disk",
    ...mapWorld(isObj(world) ? world : {}),
    currentTask: isObj(tasks) && typeof tasks.currentTask === "string" ? tasks.currentTask : null,
    queued: isObj(tasks) ? arr(tasks.queued).filter((x): x is string => typeof x === "string") : [],
    conversation: mapConversation(isObj(conv) ? arr(conv.entries) : []),
    counts: {
      pois: isObj(world) ? arr(world.pois).length : null,
      containers: isObj(world) ? arr(world.containers).length : null,
      deaths: isObj(world) ? arr(world.deaths).length : null,
      conversation: isObj(conv) ? arr(conv.entries).length : null,
    },
    error: null,
    refreshedAt: Date.now(),
  };
  diskMemoryCache.set(bot, { at: Date.now(), view });
  return view;
}

function mapWorld(w: Record<string, unknown>): Pick<MemoryView, "pois" | "containers" | "deaths"> {
  return {
    pois: arr(w.pois).filter(isObj).map((p) => ({
      type: str(p.type) ?? "?",
      name: str(p.name),
      pos: vec(p.position ?? p.pos),
      at: num(p.timestamp ?? p.at),
      source: str(p.source),
    })),
    containers: arr(w.containers).filter(isObj).map((c) => {
      const contents = arr(c.contents).filter(isObj);
      return {
        type: str(c.type) ?? "?",
        pos: vec(c.position ?? c.pos),
        lastOpened: num(c.last_opened ?? c.lastOpened),
        by: str(c.last_opened_by ?? c.lastOpenedBy),
        stacks: Array.isArray(c.contents) ? contents.length : num(c.stacks),
        items: Array.isArray(c.contents) ? contents.reduce((s, x) => s + (num(x.count) ?? 0), 0) : num(c.items),
      };
    }),
    deaths: arr(w.deaths).filter(isObj).map((d) => ({
      pos: vec(d.position ?? d.pos),
      cause: str(d.cause) ?? "?",
      at: num(d.timestamp ?? d.at),
    })),
  };
}

function mapConversation(entries: unknown[]): MemoryView["conversation"] {
  return entries
    .filter(isObj)
    .map((e) => ({
      at: num(e.at) ?? 0,
      kind: str(e.kind) ?? "?",
      who: str(e.who),
      to: str(e.to),
      channel: str(e.channel),
      text: str(e.text) ?? "",
    }))
    .slice(-CONVERSATION_TAIL);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function vec(v: unknown): Vec | null {
  return isObj(v) && typeof v.x === "number" && typeof v.y === "number" && typeof v.z === "number"
    ? { x: v.x, y: v.y, z: v.z }
    : null;
}
function sortNewest<T extends { at: number }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => b.at - a.at);
}

export function fmtVec(v: Vec | null | undefined): string {
  if (!v) return "—";
  return `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;
}
function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
