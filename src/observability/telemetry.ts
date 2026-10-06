/**
 * Telemetry writer + reader. The producer side of the contract in
 * `telemetry-types.ts`.
 *
 *  - `recordEvent(bot, partial)` fills `at` / `bot` / `runId` / `taskId`,
 *    appends to an in-memory ring (last {@link RING_SIZE} per bot, for live
 *    aggregates in the snapshot) and to a write buffer flushed to
 *    `data/orchestrator/telemetry/<bot>/events.jsonl` every second or every
 *    {@link FLUSH_EVERY_EVENTS} events. Size-rotated to `events.1.jsonl`
 *    (one old file kept). Never throws, never blocks: callers on hot paths
 *    pay one object spread and an array push.
 *  - A per-bot "current task" holder (`beginTask` / `endTask`), set by the
 *    agent backend, stamps `taskId` on everything recorded in between and
 *    counts that task's tool calls / failures / first reply.
 *  - `readEvents(bot, { since })` streams both files back (oldest first),
 *    skipping partial or malformed lines — for the report CLI.
 *
 * This module imports nothing from the bot / orchestrator layers so the
 * report CLI can use the readers standalone.
 */

import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import type { TelemetryEvent } from "./telemetry-types.js";

/** Default on-disk root; overridable (tests / smoke scripts) via `setTelemetryDir` or `BOT_TELEMETRY_DIR`. */
export const DEFAULT_TELEMETRY_DIR = resolve(process.cwd(), "data/orchestrator/telemetry");
export const EVENTS_FILE = "events.jsonl";
export const ROTATED_FILE = "events.1.jsonl";

/**
 * In-memory ring per bot. Larger than the ~2000 needed for the 30-min view so
 * the snapshot's whole-run aggregate covers a long session too (~6MB/bot
 * worst case); `getRingInfo` says when it has wrapped.
 */
const RING_SIZE = 20_000;
const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_EVERY_EVENTS = 50;
const ROTATE_BYTES = 5 * 1024 * 1024;
/** If the disk is wedged, drop the oldest unflushed lines rather than grow forever. */
const MAX_BUFFERED_LINES = 5_000;
const MAX_STRING_CHARS = 200;

/** One id per orchestrator process (`npm run start`). */
export const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Distributive Omit so each union member keeps its own fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What callers pass: the event minus the fields the writer fills in. */
export type TelemetryInput = DistributiveOmit<TelemetryEvent, "at" | "bot" | "runId" | "taskId"> & {
  at?: number;
  taskId?: string | null;
};

interface TaskHolder {
  taskId: string;
  startedAt: number;
  firstReplyAt: number | null;
  toolCalls: number;
  toolFailures: number;
}

interface BotSink {
  ring: TelemetryEvent[];
  buffer: string[];
  /** Bytes in events.jsonl; null until first stat. */
  size: number | null;
  chain: Promise<void>;
  task: TaskHolder | null;
  /** Bumped on every recorded event (cheap change detection for caches). */
  version: number;
  /** True once the ring has dropped its oldest event. */
  wrapped: boolean;
}

/** Same env var the report CLI honours (`src/report/read-events.ts`). */
export const TELEMETRY_DIR_ENV = "BOT_TELEMETRY_DIR";
let baseDir = process.env[TELEMETRY_DIR_ENV] ? resolve(process.env[TELEMETRY_DIR_ENV]!) : DEFAULT_TELEMETRY_DIR;
const sinks = new Map<string, BotSink>();
let flushTimer: NodeJS.Timeout | null = null;
let taskSeq = 0;

export function setTelemetryDir(dir: string): void {
  baseDir = resolve(dir);
  for (const s of sinks.values()) s.size = null;
}

export function telemetryDir(): string {
  return baseDir;
}

export function eventFilesFor(bot: string, dir: string = baseDir): { current: string; rotated: string } {
  return { current: join(dir, bot, EVENTS_FILE), rotated: join(dir, bot, ROTATED_FILE) };
}

function sinkFor(bot: string): BotSink {
  let s = sinks.get(bot);
  if (!s) {
    s = { ring: [], buffer: [], size: null, chain: Promise.resolve(), task: null, version: 0, wrapped: false };
    sinks.set(bot, s);
  }
  return s;
}

function ensureTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    for (const bot of sinks.keys()) scheduleFlush(bot);
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

/** Clip a string to the contract's 200-char limit. */
export function clip(text: string, max: number = MAX_STRING_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Short JSON summary of skill params (≤200 chars, never throws). */
export function summarizeArgs(value: unknown): string {
  if (value === undefined) return "";
  try {
    return clip(JSON.stringify(value) ?? "");
  } catch {
    return clip(String(value));
  }
}

/**
 * Record one event. Safe on any path: every failure is swallowed (and the
 * event dropped) rather than surfaced to gameplay code.
 */
export function recordEvent(bot: string, partial: TelemetryInput): void {
  try {
    const s = sinkFor(bot);
    const taskId = partial.taskId !== undefined ? partial.taskId : (s.task?.taskId ?? null);
    const event = {
      ...partial,
      at: partial.at ?? Date.now(),
      bot,
      runId: RUN_ID,
      taskId,
    } as TelemetryEvent;

    // Per-task counters for task_end.
    if (s.task && taskId === s.task.taskId) {
      if (event.kind === "skill") {
        s.task.toolCalls += 1;
        if (!event.ok) s.task.toolFailures += 1;
      } else if (event.kind === "guard_refusal") {
        s.task.toolCalls += 1;
        s.task.toolFailures += 1;
      }
    }

    s.ring.push(event);
    if (s.ring.length > RING_SIZE) {
      s.ring.splice(0, s.ring.length - RING_SIZE);
      s.wrapped = true;
    }
    s.version += 1;

    s.buffer.push(JSON.stringify(event));
    if (s.buffer.length > MAX_BUFFERED_LINES) s.buffer.splice(0, s.buffer.length - MAX_BUFFERED_LINES);
    ensureTimer();
    if (s.buffer.length >= FLUSH_EVERY_EVENTS) scheduleFlush(bot);
  } catch {
    // Telemetry is observe-only; never let it reach the caller.
  }
}

/** Record the same event for every bot that has telemetry (process-wide signals, e.g. loop lag). */
export function recordEventAll(bots: readonly string[], partial: TelemetryInput): void {
  for (const bot of bots) recordEvent(bot, partial);
}

function scheduleFlush(bot: string): Promise<void> {
  const s = sinks.get(bot);
  if (!s) return Promise.resolve();
  s.chain = s.chain.then(() => flushSink(bot, s)).catch(() => {});
  return s.chain;
}

async function flushSink(bot: string, s: BotSink): Promise<void> {
  if (s.buffer.length === 0) return;
  const lines = s.buffer.splice(0);
  const chunk = `${lines.join("\n")}\n`;
  const { current, rotated } = eventFilesFor(bot);
  try {
    await mkdir(join(baseDir, bot), { recursive: true });
    if (s.size === null) {
      try {
        s.size = (await stat(current)).size;
      } catch {
        s.size = 0;
      }
    }
    const bytes = Buffer.byteLength(chunk);
    if (s.size > 0 && s.size + bytes > ROTATE_BYTES) {
      await rename(current, rotated);
      s.size = 0;
    }
    await appendFile(current, chunk, "utf8");
    s.size += bytes;
  } catch (err) {
    s.size = null;
    // Put the lines back for the next attempt (bounded by MAX_BUFFERED_LINES).
    s.buffer.unshift(...lines);
    if (s.buffer.length > MAX_BUFFERED_LINES) s.buffer.splice(0, s.buffer.length - MAX_BUFFERED_LINES);
    try {
      console.warn(`[telemetry] write failed for ${bot}: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      // ignore
    }
  }
}

/** Flush every bot's buffer now. Resolves when on disk (or failed). */
export async function flushTelemetry(): Promise<void> {
  await Promise.all([...sinks.keys()].map((b) => scheduleFlush(b)));
}

/** Final flush + stop the interval. For the shutdown path. */
export async function stopTelemetry(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushTelemetry();
}

/** Read-only view of the ring (no copy) — for the snapshot's per-tick work. Don't mutate. */
export function viewRecentEvents(bot: string): readonly TelemetryEvent[] {
  return sinks.get(bot)?.ring ?? [];
}

/** In-memory ring for one bot (oldest first). Returned array is a copy. */
export function getRecentEvents(bot: string): TelemetryEvent[] {
  return [...(sinks.get(bot)?.ring ?? [])];
}

/** Ring bookkeeping for cache invalidation and "run aggregate is partial". */
export function getRingInfo(bot: string): { version: number; wrapped: boolean; size: number } {
  const s = sinks.get(bot);
  return { version: s?.version ?? 0, wrapped: s?.wrapped ?? false, size: s?.ring.length ?? 0 };
}

/** Process start, for the whole-run aggregate window. */
export const RUN_STARTED_AT = Date.now();

/** The in-flight task for `bot`, if any (snapshot view). */
export function getCurrentTask(bot: string): { taskId: string; startedAt: number; toolCalls: number; toolFailures: number; firstReplyAt: number | null } | null {
  const t = sinks.get(bot)?.task;
  return t ? { ...t } : null;
}

// ── Current-task holder ─────────────────────────────────────────────────────

export interface TaskCounters {
  taskId: string;
  startedAt: number;
  firstReplyMs: number | null;
  toolCalls: number;
  toolFailures: number;
}

/** Start a task: every event recorded for `bot` until `endTask` carries its id. */
export function beginTask(bot: string, startedAt: number = Date.now()): string {
  taskSeq += 1;
  const taskId = `${RUN_ID}-${taskSeq}`;
  try {
    sinkFor(bot).task = { taskId, startedAt, firstReplyAt: null, toolCalls: 0, toolFailures: 0 };
  } catch {
    // ignore
  }
  return taskId;
}

/** Clear the current task (if it's `taskId`) and return its counters. */
export function endTask(bot: string, taskId: string): TaskCounters | null {
  const s = sinks.get(bot);
  const t = s?.task;
  if (!s || !t || t.taskId !== taskId) return null;
  s.task = null;
  return {
    taskId: t.taskId,
    startedAt: t.startedAt,
    firstReplyMs: t.firstReplyAt !== null ? t.firstReplyAt - t.startedAt : null,
    toolCalls: t.toolCalls,
    toolFailures: t.toolFailures,
  };
}

export function currentTaskId(bot: string): string | null {
  return sinks.get(bot)?.task?.taskId ?? null;
}

/** A say/whisper succeeded: stamps the current task's first-reply time once. */
export function markReply(bot: string): void {
  const t = sinks.get(bot)?.task;
  if (t && t.firstReplyAt === null) t.firstReplyAt = Date.now();
}

// ── Routed-chat handoff (event-hooks → backend, same tick) ──────────────────

export interface RoutedChatMeta {
  player: string;
  route: string;
  at: number;
}

const routedChats = new Map<string, RoutedChatMeta>();
/** The handoff is synchronous; anything older is a dropped chat, not ours. */
const ROUTED_CHAT_TTL_MS = 1_000;

/** Called by the chat hook just before it hands a routed chat to the agent. */
export function noteRoutedChat(bot: string, meta: RoutedChatMeta): void {
  routedChats.set(bot, meta);
}

/** Called by the backend when it queues a message; consumes the note. */
export function takeRoutedChat(bot: string): RoutedChatMeta | null {
  const m = routedChats.get(bot);
  routedChats.delete(bot);
  if (!m || Date.now() - m.at > ROUTED_CHAT_TTL_MS) return null;
  return m;
}

// ── Readers (report CLI) ────────────────────────────────────────────────────

export interface ReadEventsOptions {
  /** Only events with `at >= since` (Unix ms). */
  since?: number;
  /** Telemetry root; defaults to the writer's directory. */
  dir?: string;
}

/**
 * Stream a bot's events, oldest first (rotated file, then current).
 * Partial / malformed lines (e.g. a half-written tail) are skipped.
 */
export async function* readEvents(bot: string, opts: ReadEventsOptions = {}): AsyncGenerator<TelemetryEvent> {
  const { current, rotated } = eventFilesFor(bot, opts.dir ? resolve(opts.dir) : baseDir);
  for (const path of [rotated, current]) {
    if (!existsSync(path)) continue;
    const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (line.length === 0) continue;
        let ev: TelemetryEvent;
        try {
          ev = JSON.parse(line) as TelemetryEvent;
        } catch {
          continue;
        }
        if (!ev || typeof ev !== "object" || typeof ev.kind !== "string" || typeof ev.at !== "number") continue;
        if (opts.since !== undefined && ev.at < opts.since) continue;
        yield ev;
      }
    } catch {
      // Unreadable file mid-stream: return what we have.
    } finally {
      rl.close();
    }
  }
}

/** Convenience: collect `readEvents` into an array. */
export async function readAllEvents(bot: string, opts: ReadEventsOptions = {}): Promise<TelemetryEvent[]> {
  const out: TelemetryEvent[] = [];
  for await (const ev of readEvents(bot, opts)) out.push(ev);
  return out;
}

/** Bots that have a telemetry directory under `dir`. */
export async function listTelemetryBots(dir: string = baseDir): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
