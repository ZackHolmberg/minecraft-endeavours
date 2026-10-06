/**
 * Per-bot durable recent-conversation log — the "what was just said / done"
 * half of the disk-is-source-of-truth model. Stored next to world.json as
 * `data/orchestrator/memory/<bot-username>/conversation.json`.
 *
 * Why it exists: in `per_task` session mode every player request runs in a
 * fresh Claude session with no memory of earlier turns. Follow-ups like "now
 * put it in the chest" or "yes, do that" only resolve because this log is
 * rendered into each task's message (see `buildAgentContext`). The model is
 * told to treat it as authoritative instead of remembering.
 *
 * Three entry kinds, appended in arrival order:
 *  - `player`  — a routed chat/whisper to this bot (recorded by NpcAgent).
 *  - `bot`     — something the bot said/whispered (recorded by skill-tools).
 *  - `outcome` — one deterministic line per finished task (recorded by the
 *                Claude backend: request → finished / cut off / stopped).
 *
 * Bounded to `MAX_ENTRIES` on disk; rendering further trims by age and count.
 * Writes are serialized per bot and atomic (tmp-then-rename), matching
 * world-knowledge.ts, so a crash never leaves truncated JSON. The in-memory
 * copy is loaded once per bot and is the write-through cache; disk is what
 * survives restarts.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BASE_DIR = "data/orchestrator/memory";
/** Entries kept on disk. */
const MAX_ENTRIES = 60;
/** Entries rendered into a task's context. */
const RENDER_LIMIT = 14;
/** Older entries aren't rendered — yesterday's chat would mislead more than help. */
const RENDER_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_TEXT_CHARS = 200;

export type ConversationKind = "player" | "bot" | "outcome";

export interface ConversationEntry {
  /** Unix ms. */
  at: number;
  kind: ConversationKind;
  /** Speaker for player/bot lines; omitted for outcomes. */
  who?: string;
  /** Recipient of a whisper (player → bot or bot → player). */
  to?: string;
  channel?: "chat" | "whisper";
  text: string;
}

function fileFor(username: string): string {
  return resolve(process.cwd(), BASE_DIR, username, "conversation.json");
}

const cache = new Map<string, ConversationEntry[]>();
const chains = new Map<string, Promise<unknown>>();

/** Serialize every load/append/write for one bot. */
function withLock<T>(username: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(username) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(username, next.catch(() => undefined));
  return next;
}

async function load(username: string): Promise<ConversationEntry[]> {
  const cached = cache.get(username);
  if (cached) return cached;
  let entries: ConversationEntry[] = [];
  try {
    const parsed = JSON.parse(await readFile(fileFor(username), "utf8")) as {
      entries?: ConversationEntry[];
    };
    if (Array.isArray(parsed.entries)) entries = parsed.entries;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Malformed file: start fresh rather than wedging the bot; the next
      // write replaces it.
      console.warn(`[${username}] conversation.json unreadable, starting fresh:`, err);
    }
  }
  cache.set(username, entries);
  return entries;
}

async function persist(username: string, entries: ConversationEntry[]): Promise<void> {
  const target = fileFor(username);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify({ entries }, null, 2), "utf8");
  await rename(tmp, target);
}

/**
 * Append one entry and persist. Fire-and-forget safe: failures are logged,
 * never thrown into the chat / skill path.
 */
export function recordConversation(
  username: string,
  entry: Omit<ConversationEntry, "at"> & { at?: number },
): Promise<void> {
  const full: ConversationEntry = {
    ...entry,
    at: entry.at ?? Date.now(),
    text: truncate(entry.text.replace(/\s+/g, " ").trim(), MAX_TEXT_CHARS),
  };
  return withLock(username, async () => {
    const entries = await load(username);
    entries.push(full);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    await persist(username, entries);
  }).catch((err) => {
    console.warn(`[${username}] conversation log write failed:`, err);
  });
}

/** Most recent entries (oldest first), already age- and count-trimmed for rendering. */
export function readRecentConversation(username: string): Promise<ConversationEntry[]> {
  return withLock(username, async () => {
    const cutoff = Date.now() - RENDER_MAX_AGE_MS;
    return (await load(username)).filter((e) => e.at >= cutoff).slice(-RENDER_LIMIT);
  });
}

/** Render entries as compact chat-log lines for the task context. */
export function formatConversation(entries: ConversationEntry[], botUsername: string): string[] {
  const now = Date.now();
  return entries.map((e) => {
    const age = ago(now - e.at);
    switch (e.kind) {
      case "player":
        return e.channel === "whisper"
          ? `${age} ${e.who} → you (whisper): ${e.text}`
          : `${age} <${e.who}> ${e.text}`;
      case "bot":
        return e.channel === "whisper"
          ? `${age} you → ${e.to} (whisper): ${e.text}`
          : `${age} <${botUsername}> (you) ${e.text}`;
      case "outcome":
        return `${age} [task result] ${e.text}`;
    }
  });
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
