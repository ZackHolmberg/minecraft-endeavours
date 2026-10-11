/**
 * Deterministic planning-context pre-loader for the hybrid backend.
 *
 * The planner (Claude) shouldn't spend turns gathering world state, so the
 * orchestrator assembles it for free and injects it into each planner message.
 * This reuses `observeSurroundings` (position / status / nearby / known
 * storage+utilities+waypoints / recent actions / task queue) and adds a full
 * inventory summary — all straight from the bot + world memory, no LLM
 * (per the "push deterministic work to middleware" rule).
 *
 * `buildAgentContext` is the standalone Claude bot's per-task variant: the same
 * world lines plus recent deaths (world.json) and the disk-backed recent
 * conversation log. Disk + live state is the source of truth; the model is
 * told to trust this block over anything it remembers.
 */

import type { Bot } from "mineflayer";
import {
  formatConversation,
  readRecentConversation,
} from "../memory/conversation-log.js";
import { jobContextLines } from "../jobs/describe.js";
import { getJobRunner } from "../jobs/registry.js";
import { getBotState } from "../state/index.js";
import { CONTAINER_SCAN_RADIUS, findNearbyContainers } from "../skills/containers.js";
import { observeSurroundings, type ObserveSurroundingsState } from "../skills/perception.js";

const MAX_BLOCKS = 8;
const MAX_ENTITIES = 6;
const MAX_STORAGE = 5;
/** Extra remembered (seen, beyond the live scan) containers listed in the context block. */
const MAX_REMEMBERED_FAR = 3;
const MAX_UTILITIES = 5;
const MAX_WAYPOINTS = 5;
const MAX_ACTIONS = 5;
const MAX_ACTION_HISTORY = 8;

export const AGENT_CONTEXT_HEADER =
  "# World context (auto-generated from disk + live game state; this is ground truth — trust it over anything you remember)";

/** Build a compact, literal world-context block for the planner prompt. */
export async function buildPlanningContext(bot: Bot): Promise<string> {
  return ["# World context (auto-generated — read literally, do not embellish)", ...(await worldLines(bot))].join(
    "\n",
  );
}

/**
 * Per-task context for the standalone Claude bot: world lines, recent deaths,
 * and the recent conversation (which includes the message(s) being answered).
 */
export async function buildAgentContext(bot: Bot, opts: { midTask?: boolean } = {}): Promise<string> {
  const [world, convo] = await Promise.all([
    worldLines(bot, true),
    readRecentConversation(bot.username),
  ]);
  const L = [AGENT_CONTEXT_HEADER, ...world];
  const tool = opts.midTask ? getBotState(bot.username)?.currentTool.current() : null;
  if (tool) {
    L.push("");
    L.push("# Right now (a task of yours is still running; the inventory above is live)");
    L.push(`running: ${tool.name}${tool.detail ? ` ${tool.detail}` : ""} for ${Math.round((Date.now() - tool.since) / 1000)}s — it has not returned yet`);
  }
  const job = jobContextLines(getJobRunner(bot.username)?.current() ?? null);
  if (job.length > 0) {
    L.push("");
    L.push("# Current job");
    L.push(...job);
  }
  L.push("");
  L.push("# Recent conversation (oldest first, from disk; includes the message you're answering)");
  const lines = formatConversation(convo, bot.username);
  L.push(...(lines.length > 0 ? lines : ["(nothing recent)"]));
  return L.join("\n");
}

function ageLabel(at: number): string {
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/**
 * The shared world lines. `actionHistory` swaps the 5-minute recentActions
 * window for the disk-persisted ActionsLog history with ages — what the
 * per-task agent needs, since it has no memory of what it did last session.
 */
async function worldLines(bot: Bot, actionHistory = false): Promise<string[]> {
  const { state: s } = await observeSurroundings(bot);
  const L: string[] = [];

  // First line on purpose: the mode changes what every other line means.
  L.push(gameModeLine(s.gameMode));
  L.push(
    `position: ${s.position.x} ${s.position.y} ${s.position.z} (${s.dimension}), facing ${s.facing}`,
  );
  L.push(
    `status: health ${s.status.health}/20, food ${s.status.food}/20, ${s.time.phase}, ${s.weather}` +
      `${s.status.isInWater ? ", in water" : ""}${s.status.isOnFire ? ", ON FIRE" : ""}`,
  );
  L.push(`held: ${s.heldItem ? `${s.heldItem.name} x${s.heldItem.count}` : "nothing"}`);
  L.push(`inventory: ${inventorySummary(bot)}`);

  if (s.nearbyBlocks.length > 0) {
    L.push(
      `nearby blocks: ${s.nearbyBlocks
        .slice(0, MAX_BLOCKS)
        .map((b) => `${b.type} x${b.count} @${fmt(b.nearest)} (${b.nearest.dist}m)${b.note ? ` [${b.note}]` : ""}`)
        .join(", ")}`,
    );
  }

  const notableEntities = s.nearbyEntities.filter(
    (e) => e.type === "player" || e.type === "hostile" || e.type === "passive",
  );
  if (notableEntities.length > 0) {
    L.push(
      `nearby entities: ${notableEntities
        .slice(0, MAX_ENTITIES)
        .map((e) => `${e.name} (${e.type}, ${e.dist}m)`)
        .join(", ")}`,
    );
  }
  if (s.nearbyDroppedItems.length > 0) {
    L.push(
      `dropped items: ${s.nearbyDroppedItems.map((d) => `${d.item} x${d.count} (${d.dist}m)`).join(", ")}`,
    );
  }

  const openedStorage = s.knownStorage.filter((c) => !c.seen);
  if (openedStorage.length > 0) {
    L.push(
      `known storage: ${openedStorage
        .slice(0, MAX_STORAGE)
        .map((c) => `${c.type} @${fmt(c.pos)}${storageContents(c)}`)
        .join(", ")}`,
    );
  }
  // Chests in plain sight, opened or not (world memory only learns a chest once it was opened).
  const containers = findNearbyContainers(bot);
  if (containers.length > 0) {
    L.push(`nearby containers: ${containers.slice(0, MAX_STORAGE).map((c) => `${c.name} @${fmt(c.pos)} (${c.dist}m)`).join(", ")}`);
  }
  // Containers seen earlier but beyond the live scan: the bot walked off, the chest is still there.
  const farLine = rememberedContainersLine(s.knownStorage);
  if (farLine) L.push(farLine);
  if (s.knownUtilities.length > 0) {
    L.push(
      `known utilities: ${s.knownUtilities
        .slice(0, MAX_UTILITIES)
        .map((u) => `${u.name ? `${u.name} ` : ""}${u.type} @${fmt(u.pos)}`)
        .join(", ")}`,
    );
  }
  if (s.knownWaypoints.length > 0) {
    L.push(
      `known waypoints: ${s.knownWaypoints
        .slice(0, MAX_WAYPOINTS)
        .map((w) => `${w.name ? `${w.name} ` : ""}${w.type} @${fmt(w.pos)}`)
        .join(", ")}`,
    );
  }

  if (s.lastDeath) {
    L.push(
      `last death: ${s.lastDeath.cause} @${fmt(s.lastDeath.pos)} (${s.lastDeath.minutesAgo}m ago)`,
    );
  }

  const history = actionHistory
    ? (getBotState(bot.username)?.actions.history(MAX_ACTION_HISTORY) ?? [])
    : null;
  if (history && history.length > 0) {
    L.push(
      `recent actions (oldest first): ${history
        .map((a) => `${clip(a.message, 120)} (${ageLabel(a.at)})`)
        .join(" | ")}`,
    );
  } else if (!history && s.recentActions.length > 0) {
    L.push(`recent actions: ${s.recentActions.slice(-MAX_ACTIONS).join(" | ")}`);
  }

  L.push(`current task: ${s.currentTask ?? "(none)"}`);
  if (s.remainingTasks.length > 0) {
    L.push(`remaining tasks: ${s.remainingTasks.join(" | ")}`);
  }

  return L;
}

/**
 * Compact execution context for the EXECUTOR kickoff — a small fraction of the
 * planner context. The planner already precomputed coords into the task text,
 * so the executor mainly needs its inventory, the current/remaining tasks, and a
 * short list of nearby blocks. Injecting this up front means the executor rarely
 * needs to call the full `observeSurroundings` (whose ~4k-token result is the
 * main driver of local prompt-processing latency and GPU OOM).
 */
export async function buildExecutorContext(bot: Bot): Promise<string> {
  const { state: s } = await observeSurroundings(bot);
  const L: string[] = [];
  L.push("# Current situation (you already have this — only observe if you need fresh info after moving)");
  L.push(`position: ${s.position.x} ${s.position.y} ${s.position.z}`);
  L.push(`inventory: ${inventorySummary(bot)}`);
  L.push(`current task: ${s.currentTask ?? "(none)"}`);
  if (s.remainingTasks.length > 0) {
    L.push(`remaining tasks: ${s.remainingTasks.join(" | ")}`);
  }
  if (s.nearbyBlocks.length > 0) {
    L.push(
      `nearby: ${s.nearbyBlocks
        .slice(0, MAX_BLOCKS)
        .map((b) => `${b.type} x${b.count} @${fmt(b.nearest)} (${b.nearest.dist}m)${b.note ? ` [${b.note}]` : ""}`)
        .join(", ")}`,
    );
  }
  return L.join("\n");
}

function gameModeLine(mode: ObserveSurroundingsState["gameMode"]): string {
  if (mode === "creative") {
    return "game mode: CREATIVE — take materials with getItems (never gather, craft or smelt); mined blocks drop nothing; no hunger, can't be hurt";
  }
  return `game mode: ${mode}`;
}

function inventorySummary(bot: Bot): string {
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  if (counts.size === 0) return "empty";
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} x${count}`)
    .join(", ");
}

/** "remembered containers beyond 16m …" (≤3 nearest seen-only ones outside the live scan), or null. */
export function rememberedContainersLine(storage: ObserveSurroundingsState["knownStorage"]): string | null {
  const far = storage.filter((c) => c.seen && c.dist > CONTAINER_SCAN_RADIUS).sort((a, b) => a.dist - b.dist).slice(0, MAX_REMEMBERED_FAR);
  if (far.length === 0) return null;
  return `remembered containers beyond ${CONTAINER_SCAN_RADIUS}m (seen, not opened): ${far.map((c) => `${c.type} @${fmt(c.pos)} (${Math.round(c.dist)}m)`).join(", ")}`;
}

function storageContents(c: ObserveSurroundingsState["knownStorage"][number]): string {
  if (!c.contents || c.contents.length === 0) return "";
  const top = c.contents
    .slice(0, 4)
    .map((i) => `${i.item} x${i.count}`)
    .join(", ");
  return ` [${top}${c.contents.length > 4 ? ", …" : ""}]`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function fmt(p: { x: number; y: number; z: number }): string {
  return `${p.x} ${p.y} ${p.z}`;
}
