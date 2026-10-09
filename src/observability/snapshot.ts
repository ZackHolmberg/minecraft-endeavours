/**
 * `getBotSnapshot(username)` — single plain-object aggregator the dashboard
 * (phase 3) polls every ~500ms. Pulls across layers (supervisor / bot /
 * state / agent / chat-router) and presents a stable, JSON-serializable
 * view. Reusable for a future HTTP/WebSocket API.
 *
 * Design notes:
 *  - All timestamps are Unix-ms; durations are computed from the snapshot's
 *    own `capturedAt` so the consumer can render "alive for N seconds"
 *    consistently regardless of clock drift.
 *  - When the bot isn't connected, `bot` and `agent` are null — the dashboard
 *    renders a "connecting/reconnecting" placeholder.
 *  - No mineflayer types leak through: positions are plain {x,y,z}, the
 *    online-players list is just usernames. This is deliberate so the
 *    snapshot is safe to JSON-serialize over a socket later.
 */

import type { Bot } from "mineflayer";
import {
  getAgent,
  type LastTurnError,
  type RateLimitInfo,
  type SessionUsage,
  type TurnUsage,
  type WindowStats,
} from "../agent/npc-agent.js";
import {
  getSupervisor,
  listSupervisors,
  type BotConnectionState,
} from "../mineflayer-glue/bot-factory.js";
import type { ConversationEntry } from "../memory/conversation-log.js";
import {
  readWorldKnowledge,
  type Container,
  type Death,
  type POI,
} from "../memory/world-knowledge.js";
import { getCurrentConversationPartner } from "../orchestrator/chat-router.js";
import { getBotState, type RecentlySeenPlayer } from "../state/index.js";
import { loadJson, memoryFileFor } from "../state/persist.js";
import { aggregate } from "./aggregate.js";
import {
  getCurrentTask,
  getRingInfo,
  RUN_ID,
  RUN_STARTED_AT,
  viewRecentEvents,
} from "./telemetry.js";
import type { TelemetryAggregate, TelemetryEvent } from "./telemetry-types.js";

export interface BotSnapshot {
  username: string;
  capturedAt: number;
  connection: {
    state: BotConnectionState;
    connectedSince: number | null;
    uptimeMs: number | null;
  };
  bot: BotFields | null;
  state: StateFields;
  agent: AgentFields | null;
  chat: { currentPartner: string | null };
  /** Live telemetry from the in-memory event ring. */
  telemetry: TelemetryFields;
  /** Durable per-bot memory read from disk (refreshed at most every ~5s); null until the first read lands. */
  memory: MemoryFields | null;
}

export type TaskStartEvent = Extract<TelemetryEvent, { kind: "task_start" }>;
export type TaskEndEvent = Extract<TelemetryEvent, { kind: "task_end" }>;

export interface TelemetryFields {
  runId: string;
  runStartedAt: number;
  /** Aggregate over the last 30 minutes. */
  last30m: TelemetryAggregate;
  /** Aggregate over the whole run (windowStart = process start). */
  run: TelemetryAggregate;
  /** True when the in-memory ring wrapped, so `run` covers only the retained tail. */
  runTruncated: boolean;
  /** The task in flight right now, if any. */
  currentTask: {
    taskId: string;
    startedAt: number;
    runningMs: number;
    /** From its task_start event (null if not found in the ring). */
    request: string | null;
    toolCalls: number;
    toolFailures: number;
    firstReplyMs: number | null;
  } | null;
  /** Last ~15 finished tasks, newest first, joined with their task_start (null if it fell out of the ring). */
  recentTasks: Array<{ start: TaskStartEvent | null; end: TaskEndEvent }>;
  /** Last ~30 notable events, newest first: everything except look reflexes, successful skills, and chat_in/chat_out. */
  notable: TelemetryEvent[];
}

export interface MemoryFields {
  /** Unix ms of the disk read this reflects. */
  refreshedAt: number;
  /** Newest-first `latest` lists (by timestamp / last_opened). */
  pois: { count: number; latest: POI[] };
  containers: { count: number; latest: Container[] };
  deaths: { count: number; latest: Death[] };
  /** conversation.json: total entries on disk + the last ~8 (oldest first). */
  conversation: { count: number; tail: ConversationEntry[] };
  /** tasks.json as persisted (null when the file doesn't exist). */
  tasks: { currentTask: string | null; queued: string[] } | null;
  /** Read error for world.json, if any (other files fail soft to empty). */
  error: string | null;
}

export interface BotFields {
  position: { x: number; y: number; z: number };
  facing: string;
  dimension: string;
  /** Bot's own game mode (mineflayer `bot.game.gameMode`); drives creative-aware skills. */
  gameMode: "survival" | "creative" | "adventure" | "spectator" | "unknown";
  health: number;
  food: number;
  saturation: number;
  experience: number;
  heldItem: { name: string; count: number } | null;
  /**
   * Snapshot of every stack in main inventory + hotbar (one entry per stack).
   * Same stack appearing in multiple slots stays as multiple entries — the
   * dashboard groups by name at render time, so consumers can present
   * "diamond × 3" or "diamond × 64 + 12" however they want.
   */
  inventory: Array<{ name: string; count: number }>;
  time: { timeOfDay: number; phase: "day" | "night" | "dusk" | "dawn" };
  weather: "clear" | "rain" | "thunder";
  onlinePlayers: string[];
}

export interface StateFields {
  currentTool: { name: string; since: number; runningMs: number } | null;
  recentActions: string[];
  recentlySeenPlayers: RecentlySeenPlayer[];
  currentTask: string | null;
  remainingTasks: string[];
}

export interface AgentFields {
  rateLimited: boolean;
  cooldownRemainingMinutes: number;
  rateLimitInfo: RateLimitInfo | null;
  lastTurnUsage: TurnUsage | null;
  sessionUsage: SessionUsage;
  lastTurnError: LastTurnError | null;
  windowStats: WindowStats;
}

/**
 * Returns `null` only when the supervisor itself isn't registered — i.e.
 * the username doesn't belong to a configured bot. All other "not yet
 * ready" states (no bot, no agent) are represented by null sub-fields.
 */
export function getBotSnapshot(username: string): BotSnapshot | null {
  const supervisor = getSupervisor(username);
  if (!supervisor) return null;

  const capturedAt = Date.now();
  const connectedSince = supervisor.connectedSince;

  const snapshot: BotSnapshot = {
    username,
    capturedAt,
    connection: {
      state: supervisor.state,
      connectedSince,
      uptimeMs: connectedSince !== null ? capturedAt - connectedSince : null,
    },
    bot: snapshotBotFields(supervisor.bot),
    state: snapshotStateFields(username, capturedAt),
    agent: snapshotAgentFields(username),
    chat: { currentPartner: getCurrentConversationPartner(username) },
    telemetry: snapshotTelemetryFields(username, capturedAt),
    memory: snapshotMemoryFields(username, capturedAt),
  };
  return snapshot;
}

/** Convenience for the multi-bot dashboard view (phase 4). */
export function getAllBotSnapshots(): BotSnapshot[] {
  return listSupervisors().map((s) => getBotSnapshot(s.username)!);
}

// ─────────────────────────────────────────────────────────────────────────────
// Field extractors. Kept private so the snapshot shape stays the only
// public surface — keeps churn contained when the dashboard layout evolves.
// ─────────────────────────────────────────────────────────────────────────────

function snapshotBotFields(bot: Bot | null): BotFields | null {
  if (!bot || !bot.entity) return null;
  const p = bot.entity.position;
  const held = bot.heldItem;
  return {
    position: { x: round2(p.x), y: round2(p.y), z: round2(p.z) },
    facing: yawToCardinal(bot.entity.yaw),
    dimension: bot.game?.dimension ?? "unknown",
    gameMode: normalizeGameMode(bot.game?.gameMode),
    health: round2(bot.health ?? 0),
    food: bot.food ?? 0,
    saturation: round2(bot.foodSaturation ?? 0),
    experience: bot.experience?.level ?? 0,
    heldItem: held ? { name: held.name, count: held.count } : null,
    inventory: bot.inventory
      ? bot.inventory.items().map((i) => ({ name: i.name, count: i.count }))
      : [],
    time: {
      timeOfDay: bot.time?.timeOfDay ?? 0,
      phase: timePhase(bot.time?.timeOfDay ?? 0),
    },
    weather: weather(bot),
    onlinePlayers: Object.keys(bot.players ?? {}),
  };
}

function snapshotStateFields(username: string, now: number): StateFields {
  const state = getBotState(username);
  if (!state) {
    return {
      currentTool: null,
      recentActions: [],
      recentlySeenPlayers: [],
      currentTask: null,
      remainingTasks: [],
    };
  }
  const tool = state.currentTool.current();
  return {
    currentTool: tool
      ? { name: tool.name, since: tool.since, runningMs: now - tool.since }
      : null,
    recentActions: state.actions.recent(),
    recentlySeenPlayers: state.presence.recentlySeen(),
    currentTask: state.tasks.current(),
    remainingTasks: state.tasks.remaining(),
  };
}

function snapshotAgentFields(username: string): AgentFields | null {
  const agent = getAgent(username);
  if (!agent) return null;
  return {
    rateLimited: agent.isRateLimited(),
    cooldownRemainingMinutes: agent.getCooldownRemainingMinutes(),
    rateLimitInfo: agent.getRateLimitInfo(),
    lastTurnUsage: agent.getLastTurnUsage(),
    sessionUsage: agent.getSessionUsage(),
    lastTurnError: agent.getLastTurnError(),
    windowStats: agent.getWindowStats(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry + memory. Both are cached: aggregates recompute only when the
// ring changed (and at most every AGG_MIN_INTERVAL_MS), memory is re-read
// from disk at most every MEMORY_REFRESH_MS, asynchronously — the 500ms tick
// only ever returns the last cached value.
// ─────────────────────────────────────────────────────────────────────────────

const LAST_WINDOW_MS = 30 * 60 * 1000;
const AGG_MIN_INTERVAL_MS = 2_000;
const RECENT_TASKS = 15;
const NOTABLE_EVENTS = 30;
const MEMORY_REFRESH_MS = 5_000;
const MEMORY_LATEST = 5;
const CONVERSATION_TAIL = 8;

interface TelemetryCache {
  version: number;
  computedAt: number;
  fields: Omit<TelemetryFields, "currentTask">;
  /** task_start events by taskId for the current-task lookup. */
  starts: Map<string, TaskStartEvent>;
}
const telemetryCache = new Map<string, TelemetryCache>();

function snapshotTelemetryFields(username: string, now: number): TelemetryFields {
  let cached = telemetryCache.get(username);
  try {
    const info = getRingInfo(username);
    const stale = !cached || (cached.version !== info.version && now - cached.computedAt >= AGG_MIN_INTERVAL_MS)
      || now - cached.computedAt >= LAST_WINDOW_MS / 30; // let the 30m window slide even when idle
    if (stale) {
      const events = viewRecentEvents(username);
      cached = {
        version: info.version,
        computedAt: now,
        fields: {
          runId: RUN_ID,
          runStartedAt: RUN_STARTED_AT,
          last30m: aggregate(events, now - LAST_WINDOW_MS, now),
          run: aggregate(events, RUN_STARTED_AT, now),
          runTruncated: info.wrapped,
          ...recentTasksAndNotable(events),
        },
        starts: startsById(events),
      };
      telemetryCache.set(username, cached);
    }
  } catch (err) {
    console.warn(`[${username}] snapshot telemetry failed:`, err);
  }
  const fields = cached?.fields ?? {
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    last30m: aggregate([], now - LAST_WINDOW_MS, now),
    run: aggregate([], RUN_STARTED_AT, now),
    runTruncated: false,
    recentTasks: [],
    notable: [],
  };
  const t = getCurrentTask(username);
  return {
    ...fields,
    currentTask: t
      ? {
          taskId: t.taskId,
          startedAt: t.startedAt,
          runningMs: now - t.startedAt,
          request: cached?.starts.get(t.taskId)?.request ?? null,
          toolCalls: t.toolCalls,
          toolFailures: t.toolFailures,
          firstReplyMs: t.firstReplyAt !== null ? t.firstReplyAt - t.startedAt : null,
        }
      : null,
  };
}

function startsById(events: readonly TelemetryEvent[]): Map<string, TaskStartEvent> {
  // Only the tail matters (current task / last 15); scan backwards a bounded amount.
  const out = new Map<string, TaskStartEvent>();
  for (let i = events.length - 1; i >= 0 && out.size < RECENT_TASKS + 2; i--) {
    const e = events[i]!;
    if (e.kind === "task_start" && e.taskId) out.set(e.taskId, e);
  }
  return out;
}

function isNotable(e: TelemetryEvent): boolean {
  switch (e.kind) {
    case "reflex":
      return e.reflex !== "look";
    case "skill":
      return !e.ok;
    case "chat_in":
    case "chat_out":
      return false;
    default:
      return true;
  }
}

function recentTasksAndNotable(
  events: readonly TelemetryEvent[],
): Pick<TelemetryFields, "recentTasks" | "notable"> {
  const ends: TaskEndEvent[] = [];
  const notable: TelemetryEvent[] = [];
  const starts = new Map<string, TaskStartEvent>();
  // Newest first; stop once both lists are full and every wanted start found.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "task_start" && e.taskId) starts.set(e.taskId, e);
    if (e.kind === "task_end" && ends.length < RECENT_TASKS) ends.push(e);
    if (notable.length < NOTABLE_EVENTS && isNotable(e)) notable.push(e);
    if (
      ends.length >= RECENT_TASKS &&
      notable.length >= NOTABLE_EVENTS &&
      ends.every((end) => !end.taskId || starts.has(end.taskId))
    ) {
      break;
    }
  }
  return {
    recentTasks: ends.map((end) => ({ start: (end.taskId && starts.get(end.taskId)) || null, end })),
    notable,
  };
}

interface MemoryCache {
  value: MemoryFields | null;
  refreshedAt: number;
  inFlight: boolean;
}
const memoryCache = new Map<string, MemoryCache>();

function snapshotMemoryFields(username: string, now: number): MemoryFields | null {
  let c = memoryCache.get(username);
  if (!c) {
    c = { value: null, refreshedAt: 0, inFlight: false };
    memoryCache.set(username, c);
  }
  if (!c.inFlight && now - c.refreshedAt >= MEMORY_REFRESH_MS) {
    const entry = c;
    entry.inFlight = true;
    void readMemory(username)
      .then((v) => {
        entry.value = v;
      })
      .catch((err) => {
        console.warn(`[${username}] snapshot memory read failed:`, err);
      })
      .finally(() => {
        entry.refreshedAt = Date.now();
        entry.inFlight = false;
      });
  }
  return c.value;
}

async function readMemory(username: string): Promise<MemoryFields> {
  let error: string | null = null;
  let world: { pois: POI[]; containers: Container[]; deaths: Death[] } = { pois: [], containers: [], deaths: [] };
  try {
    world = await readWorldKnowledge(username);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  // Same tolerant loader the state stores use; missing / unreadable → null.
  const convo = loadJson<{ entries?: ConversationEntry[] }>(memoryFileFor(username, "conversation.json"));
  const entries = Array.isArray(convo?.entries) ? convo.entries : [];
  const tasksRaw = loadJson<{ currentTask?: unknown; queued?: unknown }>(memoryFileFor(username, "tasks.json"));
  const tasks = tasksRaw
    ? {
        currentTask: typeof tasksRaw.currentTask === "string" ? tasksRaw.currentTask : null,
        queued: Array.isArray(tasksRaw.queued) ? tasksRaw.queued.filter((t): t is string => typeof t === "string") : [],
      }
    : null;
  return {
    refreshedAt: Date.now(),
    pois: { count: world.pois.length, latest: newest(world.pois, (p) => p.timestamp) },
    containers: { count: world.containers.length, latest: newest(world.containers, (c) => c.last_opened) },
    deaths: { count: world.deaths.length, latest: newest(world.deaths, (d) => d.timestamp) },
    conversation: { count: entries.length, tail: entries.slice(-CONVERSATION_TAIL) },
    tasks,
    error,
  };
}

function newest<T>(items: T[], at: (t: T) => number): T[] {
  return [...items].sort((a, b) => (at(b) ?? 0) - (at(a) ?? 0)).slice(0, MEMORY_LATEST);
}

// ─────────────────────────────────────────────────────────────────────────────
// Small derivations (mirror what observeSurroundings does for Claude's view).
// ─────────────────────────────────────────────────────────────────────────────

function yawToCardinal(yawRad: number): string {
  const deg = ((yawRad * 180) / Math.PI + 360) % 360;
  // Minecraft yaw: 0=south, +90=west, 180=north, 270=east.
  if (deg < 22.5 || deg >= 337.5) return "south";
  if (deg < 67.5) return "south-west";
  if (deg < 112.5) return "west";
  if (deg < 157.5) return "north-west";
  if (deg < 202.5) return "north";
  if (deg < 247.5) return "north-east";
  if (deg < 292.5) return "east";
  return "south-east";
}

function timePhase(timeOfDay: number): "day" | "night" | "dusk" | "dawn" {
  const t = timeOfDay % 24000;
  if (t < 1000 || t >= 23000) return "dawn";
  if (t < 12000) return "day";
  if (t < 13000) return "dusk";
  return "night";
}

function weather(bot: Bot): "clear" | "rain" | "thunder" {
  if (bot.thunderState > 0) return "thunder";
  if (bot.isRaining) return "rain";
  return "clear";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalizeGameMode(m: unknown): BotFields["gameMode"] {
  return m === "survival" || m === "creative" || m === "adventure" || m === "spectator" ? m : "unknown";
}
