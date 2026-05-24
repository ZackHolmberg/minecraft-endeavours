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
} from "../agent/npc-agent.js";
import {
  getSupervisor,
  listSupervisors,
  type BotConnectionState,
} from "../mineflayer-glue/bot-factory.js";
import { getCurrentConversationPartner } from "../orchestrator/chat-router.js";
import { getBotState, type RecentlySeenPlayer } from "../state/index.js";

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
}

export interface BotFields {
  position: { x: number; y: number; z: number };
  facing: string;
  dimension: string;
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
  };
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
