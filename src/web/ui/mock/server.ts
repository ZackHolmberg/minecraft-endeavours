/**
 * Mock panel server for UI development — serves `src/web/ui/dist` plus every
 * route in `src/web/shared/api.ts` with realistic fake data. Telemetry is
 * synthetic but aggregated and flagged by the real `aggregate()` /
 * `computeFlags()` so the Bot page shows what the real report would.
 *
 *   npm run ui:build && npm run ui:mock      → http://127.0.0.1:5180
 *   PANEL_URL=http://127.0.0.1:5180 npm run ui:dev   (HMR against the mock)
 *
 * Login: password "hunter2", TOTP "123456". Five bad attempts → 429 lockout.
 * MOCK_BOT=down starts with the bot stopped; MOCK_SERVER=down with the server stopped.
 * Not part of the UI bundle and never used in production.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ActionDef, ActionId, AuditEntry, BackupInfo, ConsoleResponse, GameMode, JobDetail, JobSummary, MeResponse,
  PlayersResponse, ReportResponse, StatusResponse, WsChannel, WsClientMessage, WsServerMessage,
} from "../../shared/api.js";
import type { BotSnapshot } from "../../../observability/snapshot.js";
import type { TelemetryEvent } from "../../../observability/telemetry-types.js";
import { aggregate } from "../../../observability/aggregate.js";
import { computeFlags, STUCK_RADIUS_BLOCKS } from "../../../report/flags.js";
import { buildTaskRows, clusterProblemSpots } from "../../../report/tasks.js";
import { generateEvents } from "./gen-events.js";

const PORT = Number(process.env.PORT ?? 5180);
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const BOT = "Steve_AI";
const PASSWORD = "hunter2";
const TOTP = "123456";
const START = Date.now();

// ── State ──────────────────────────────────────────────────────────────
const events: TelemetryEvent[] = generateEvents();
const RUN_ID = "run-cur";
const runStart = events.find((e) => e.runId === RUN_ID)?.at ?? START - 100 * 60_000;

const state = {
  server: { state: (process.env.MOCK_SERVER === "down" ? "stopped" : "running") as StatusResponse["server"]["state"], since: START - 5.2 * 3600_000 },
  bot: { running: process.env.MOCK_BOT !== "down", since: runStart, pid: 48213 },
  players: { online: ["Zack", "Alex"], whitelist: ["Zack", "Alex", "Steve_AI", "Notch_Jr"], ops: ["Zack"] } as PlayersResponse,
  gameModes: { Zack: "creative", Alex: "survival", Steve_AI: "survival" } as Record<string, GameMode>,
  pos: { x: 112.4, y: 64, z: -40.2 },
  health: 17, food: 15,
};
const sessions = new Map<string, { csrf: string; expiresAt: number }>();
let failed = 0;
let lockedUntil = 0;
const jobs: JobDetail[] = [];
const consoleHist: ConsoleResponse[] = [
  { command: "list", output: "There are 2 of a max of 20 players online: Zack, Alex", at: START - 3600_000 },
  { command: "time set day", output: "Set the time to 1000", at: START - 3000_000 },
];
const audit: AuditEntry[] = ([
  { at: START - 7200_000, ip: "203.0.113.50", user: null, kind: "login_fail", detail: "bad totp", ok: false },
  { at: START - 7190_000, ip: "203.0.113.50", user: null, kind: "login_fail", detail: "bad password", ok: false },
  { at: START - 7000_000, ip: "198.51.100.7", user: "admin", kind: "login_ok", detail: "password+totp", ok: true },
  { at: START - 3600_000, ip: "198.51.100.7", user: "admin", kind: "console", detail: "list", ok: true },
  { at: START - 3000_000, ip: "198.51.100.7", user: "admin", kind: "action", detail: "backup.run → succeeded", ok: true },
  { at: START - 900_000, ip: "45.33.12.9", user: null, kind: "lockout", detail: "5 failures in 10m — locked 15m", ok: false },
] satisfies AuditEntry[]).reverse();
const backups: BackupInfo[] = Array.from({ length: 7 }, (_, i) => ({
  file: `world-${new Date(START - i * 86400_000 - 3 * 3600_000).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.tar.gz`,
  sizeBytes: Math.round((412 - i * 9.5) * 1024 * 1024 + i * 12345),
  createdAt: START - i * 86400_000 - 3 * 3600_000,
}));
const logs: Record<"bot" | "server", string[]> = {
  bot: [
    "[orchestrator] loading config/bots.yml (1 bot)",
    "[Steve_AI] connecting to localhost:25565 (1.21.9)",
    "[Steve_AI] spawned at 112, 64, -40",
    "[Steve_AI] agent ready · model haiku · session per_task",
    "[chat-router] Zack → Steve_AI (name-mention): steve can you get some wood",
    "[Steve_AI] tool goTo {\"target\":\"oak_log\"} ✓ 4.2s",
    "[Steve_AI] tool mineBlock {\"block\":\"oak_log\",\"count\":8} ✓ 18.9s",
    "WARN [Steve_AI] placeBlock failed: no reference block to place against",
    "[Steve_AI] task finished · 9 turns · first reply 2.1s · $0.0084",
  ],
  server: [
    "[11:02:11 INFO]: Starting minecraft server version 1.21.9",
    "[11:02:14 INFO]: Preparing level \"world\"",
    "[11:02:21 INFO]: Done (7.312s)! For help, type \"help\"",
    "[11:14:40 INFO]: Zack joined the game",
    "[11:15:02 INFO]: Steve_AI joined the game",
    "[11:20:13 WARN]: Can't keep up! Is the server overloaded? Running 2043ms or 40 ticks behind",
    "[11:21:44 INFO]: Alex joined the game",
  ],
};
for (let i = 0; i < 120; i++) logs.bot.push(`[Steve_AI] tick ${i} · observeSurroundings ok · ${10 + (i % 7)} entities nearby`);

// ── Helpers ────────────────────────────────────────────────────────────
function json(res: ServerResponse, code: number, body?: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
function err(res: ServerResponse, code: number, error: string, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ error, message }));
}
function cookie(req: IncomingMessage, name: string): string | null {
  const m = new RegExp(`(?:^|; )${name}=([^;]+)`).exec(req.headers.cookie ?? "");
  return m ? m[1]! : null;
}
function session(req: IncomingMessage) {
  const id = cookie(req, "sid");
  const s = id ? sessions.get(id) : undefined;
  if (!s || s.expiresAt < Date.now()) return null;
  return { id: id!, ...s };
}
async function body(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) s += c;
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}
const ip = (req: IncomingMessage) => (req.socket.remoteAddress ?? "?").replace("::ffff:", "");
function addAudit(req: IncomingMessage, kind: AuditEntry["kind"], detail: string, ok = true, user: string | null = "admin"): void {
  audit.unshift({ at: Date.now(), ip: ip(req), user, kind, detail, ok });
}

function sinceToFrom(since: string, now: number): { from: number; label: string } {
  switch (since) {
    case "30m": return { from: now - 30 * 60_000, label: "last 30 minutes" };
    case "2h": return { from: now - 2 * 3600_000, label: "last 2 hours" };
    case "today": { const d = new Date(now); d.setHours(0, 0, 0, 0); return { from: d.getTime(), label: "today" }; }
    case "all": return { from: events[0]?.at ?? now, label: "all retained telemetry" };
    default: return { from: runStart, label: `this run (${RUN_ID})` };
  }
}

function report(since: string): ReportResponse {
  const now = Date.now();
  const { from, label } = sinceToFrom(since, now);
  const win = events.filter((e) => e.at >= from && e.at <= now);
  const agg = aggregate(win, from, now);
  const flags = computeFlags(agg, { tasks: buildTaskRows(win), clusters: clusterProblemSpots(win, STUCK_RADIUS_BLOCKS) });
  return { bot: BOT, window: { from, to: now, label }, aggregate: agg, flags };
}

const ACTIONS: Array<Omit<ActionDef, "available" | "unavailableReason">> = [
  { id: "server.start", label: "Start", description: "Start the Minecraft server container (scripts/start.sh).", confirm: false, group: "server" },
  { id: "server.stop", label: "Stop", description: "Save the world and stop the server. Everyone online is disconnected.", confirm: true, group: "server" },
  { id: "server.restart", label: "Restart", description: "Stop, then start the server. Players are disconnected for ~30s.", confirm: true, group: "server" },
  { id: "bot.start", label: "Start", description: "Start the AI orchestrator (scripts/botStart.sh).", confirm: false, group: "bot" },
  { id: "bot.stop", label: "Stop", description: "Gracefully disconnect the bot. Its conversation memory is dropped.", confirm: true, group: "bot" },
  { id: "bot.restart", label: "Restart", description: "Stop and start the orchestrator.", confirm: true, group: "bot" },
  { id: "world.save", label: "Save world", description: "Run save-all over RCON.", confirm: false, group: "world" },
  { id: "backup.run", label: "Backup", description: "save-all, then archive the world to ./backups (keeps the last 10).", confirm: false, group: "world" },
  { id: "world.new", label: "New world", description: "Back up, stop the bot and server, move the world folders to backups/worlds/ and the bot's memory to memory-archive/, then start the server on a fresh world. Nothing is deleted; everyone is disconnected; takes a few minutes.", confirm: true, group: "world" },
];
const groupOf = (id: ActionId) => ACTIONS.find((a) => a.id === id)!.group;
const running = () => jobs.filter((j) => j.state === "running");

function actionDefs(): ActionDef[] {
  const busy = new Set(running().map((j) => groupOf(j.action)));
  const exclusive = running().some((j) => j.action === "world.new");
  const up = state.server.state === "running";
  return ACTIONS.map((a) => {
    let reason: string | null = null;
    if (exclusive) reason = "A new world is being generated";
    else if (a.id === "world.new") reason = running().length > 0 ? "Another job is running — a new world needs the panel to itself" : state.server.state === "starting" ? "Server is starting — wait until it is reachable (the backup needs RCON)" : null;
    else if (busy.has(a.group)) reason = "Another job in this group is running";
    else if (a.id === "server.start" && state.server.state !== "stopped") reason = "Server is already running";
    else if ((a.id === "server.stop" || a.id === "server.restart") && state.server.state === "stopped") reason = "Server is stopped";
    else if (a.id === "bot.start" && state.bot.running) reason = "Bot is already running";
    else if ((a.id === "bot.stop" || a.id === "bot.restart") && !state.bot.running) reason = "Bot is stopped";
    else if (a.id === "bot.start" && !up) reason = "Start the server first";
    else if (a.group === "world" && !up) reason = "Server must be running";
    return { ...a, available: reason === null, unavailableReason: reason };
  });
}

const SCRIPTS: Record<ActionId, string[]> = {
  "server.start": ["$ docker compose up -d", "Container minecraft-endeavours-minecraft-1  Starting", "Container minecraft-endeavours-minecraft-1  Started", "waiting for :25565…", "server accepting connections ✓"],
  "server.stop": ["$ rcon save-all", "Saving the game (this may take a moment!)", "Saved the game", "$ docker compose stop", "Container minecraft-endeavours-minecraft-1  Stopping", "Container minecraft-endeavours-minecraft-1  Stopped"],
  "server.restart": ["$ rcon save-all", "Saved the game", "$ docker compose stop", "Container minecraft-endeavours-minecraft-1  Stopped", "$ docker compose up -d", "Container minecraft-endeavours-minecraft-1  Started", "server accepting connections ✓"],
  "bot.start": ["$ scripts/botStart.sh", "starting orchestrator (detached)…", "pid 50112 · log → .bot-runtime/bot.log", "[Steve_AI] connected ✓"],
  "bot.stop": ["$ scripts/botStop.sh", "SIGTERM → pid 48213", "[Steve_AI] disconnecting gracefully", "orchestrator exited (0)"],
  "bot.restart": ["$ scripts/botStop.sh", "orchestrator exited (0)", "$ scripts/botStart.sh", "[Steve_AI] connected ✓"],
  "world.save": ["$ rcon save-all", "Saving the game (this may take a moment!)", "Saved the game"],
  "world.new": [
    "── Step 1/8: back up the current world", "$ scripts/backup.sh", "Saving world before backup...", "Backup complete: ./backups/world_2026-10-09_14-03-22.tar.gz",
    "── Step 2/8: stop the bot", "$ scripts/botStop.sh", "  bot stopped (will restart it at the end)",
    "── Step 3/8: stop the server", "$ scripts/stop.sh", "Stopping Minecraft server (world will be saved)...", "Server stopped.",
    "── Step 4/8: archive the world folders", "  moved data/world → backups/worlds/2026-10-09_14-03-22/world", "  moved data/world_nether → backups/worlds/2026-10-09_14-03-22/world_nether", "  moved data/world_the_end → backups/worlds/2026-10-09_14-03-22/world_the_end",
    "── Step 5/8: archive the bot's memory", "  moved data/orchestrator/memory/Steve_AI → data/orchestrator/memory-archive/2026-10-09_14-03-22/Steve_AI",
    "── Step 6/8: start the server with the new seed", "$ scripts/start.sh", "Starting Minecraft server...",
    "── Step 7/8: wait for the server to finish generating the world", "  still generating… 30s", "  still generating… 60s", "  server is reachable",
    "── Step 8/8: restart the bot", "$ scripts/botStart.sh", "", "Archived worlds are kept in backups/worlds/ — delete old ones by hand on the host if disk space matters.", "", "Done. Old world: backups/worlds/2026-10-09_14-03-22",
  ],
  "backup.run": ["$ rcon save-all", "Saved the game", "$ tar -czf backups/world-….tar.gz data/world", "WARN: file changed as we read it: data/world/session.lock", "archive 418 MB", "pruning: keeping last 10 ✓"],
};

function startJob(id: ActionId, user: string, seed: string | null = null): JobDetail {
  const job: JobDetail = { id: randomBytes(6).toString("hex"), action: id, state: "running", startedAt: Date.now(), endedAt: null, exitCode: null, startedBy: user, output: [] };
  jobs.unshift(job);
  if (jobs.length > 50) jobs.pop();
  if (id === "server.start" || id === "server.restart") state.server.state = "starting";
  const lines = id === "world.new" ? [`New world — seed: ${seed === null ? "(random)" : JSON.stringify(seed)}`, ...SCRIPTS[id]] : SCRIPTS[id];
  if (id === "world.new") setTimeout(() => { state.server.state = "starting"; pushStatus(); }, 700 * 10);
  lines.forEach((l, i) =>
    setTimeout(() => {
      job.output.push(l);
      broadcast(`job:${job.id}`, { type: "job_output", jobId: job.id, lines: [l] });
    }, 700 * (i + 1)),
  );
  setTimeout(() => {
    job.state = "succeeded";
    job.exitCode = 0;
    job.endedAt = Date.now();
    if (id === "server.stop") state.server.state = "stopped";
    if (id === "server.start" || id === "server.restart" || id === "world.new") { state.server.state = "running"; state.server.since = Date.now(); }
    if (id === "bot.stop") state.bot.running = false;
    if (id === "bot.start" || id === "bot.restart") { state.bot.running = true; state.bot.since = Date.now(); }
    if (id === "backup.run") backups.unshift({ file: `world-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.tar.gz`, sizeBytes: 438_000_000, createdAt: Date.now() });
    broadcast(`job:${job.id}`, { type: "job_state", job: summary(job) });
    pushStatus();
  }, 700 * (lines.length + 1) + 300);
  return job;
}
const summary = ({ output: _o, ...s }: JobDetail): JobSummary => s;

function status(): StatusResponse {
  const up = state.server.state === "running";
  const snap = state.bot.running ? snapshot() : null;
  return {
    at: Date.now(),
    server: {
      state: state.server.state,
      since: state.server.state === "stopped" ? null : state.server.since,
      reachable: up,
      players: up ? { online: state.players.online.length + (state.bot.running ? 1 : 0), max: 20, names: [...state.players.online, ...(state.bot.running ? [BOT] : [])] } : null,
      version: up ? "1.21.9" : null,
    },
    duckdns: { state: "running" },
    bot: {
      running: state.bot.running,
      pid: state.bot.running ? state.bot.pid : null,
      since: state.bot.running ? state.bot.since : null,
      bots: snap ? [{ username: BOT, connection: snap.connection.state, health: state.health, food: state.food, currentTool: snap.state.currentTool?.name ?? null, currentTask: snap.state.currentTask }] : null,
    },
    host: { loadAvg1m: 1.2 + Math.sin(Date.now() / 20_000) * 0.6 + Math.random() * 0.2, freeMemMb: 6200 + Math.round(Math.random() * 300), totalMemMb: 24576, diskFreeGb: 182.4 },
    panel: { version: "0.1.0-mock", startedAt: START },
    activeJobs: running().map(summary),
  };
}

function snapshot(): BotSnapshot {
  const now = Date.now();
  const run = events.filter((e) => e.runId === RUN_ID && e.at <= now);
  const ends = run.filter((e) => e.kind === "task_end").reverse().slice(0, 15) as Array<Extract<TelemetryEvent, { kind: "task_end" }>>;
  const starts = new Map(run.filter((e) => e.kind === "task_start").map((e) => [e.taskId, e as Extract<TelemetryEvent, { kind: "task_start" }>]));
  const notable = run.filter((e) => !(e.kind === "chat_in" || e.kind === "chat_out" || (e.kind === "skill" && e.ok) || (e.kind === "reflex" && e.reflex === "look"))).reverse().slice(0, 30);
  const toolPhase = Math.floor(now / 7000) % 3;
  const tool = toolPhase === 2 ? null : { name: toolPhase === 0 ? "goTo" : "smeltItem", since: now - (now % 7000), runningMs: now % 7000 };
  return {
    username: BOT,
    capturedAt: now,
    connection: { state: "connected", connectedSince: state.bot.since, uptimeMs: now - state.bot.since },
    bot: {
      position: { ...state.pos }, facing: "north", dimension: "overworld", gameMode: state.gameModes[BOT] ?? "unknown", health: state.health, food: state.food, saturation: 3.2, experience: 7,
      heldItem: { name: "iron_pickaxe", count: 1 },
      inventory: [
        { name: "oak_log", count: 64 }, { name: "oak_log", count: 12 }, { name: "cobblestone", count: 41 }, { name: "iron_ingot", count: 6 },
        { name: "raw_iron", count: 3 }, { name: "bread", count: 5 }, { name: "torch", count: 23 }, { name: "iron_pickaxe", count: 1 }, { name: "crafting_table", count: 1 },
      ],
      time: { timeOfDay: 4200, phase: "day" }, weather: "clear", onlinePlayers: [BOT, ...state.players.online],
    },
    state: {
      currentTool: tool,
      recentActions: ["goTo chest → arrived (6.1s)", "depositToChest oak_log×32 ✓", "craftItem iron_pickaxe ✓", "placeBlock furnace ✗ no reference block", "placeBlock furnace ✓", "smeltItem raw_iron×3 (running)"],
      recentlySeenPlayers: [{ name: "Zack", lastSeen: now - 3000, lastPos: { x: 110, y: 64, z: -38 } }],
      currentTask: "smelt the iron, then make Zack a pickaxe",
      remainingTasks: ["bring Zack the pickaxe", "put the extra logs in the chest"],
    },
    agent: {
      rateLimited: false, cooldownRemainingMinutes: 0, rateLimitInfo: null,
      lastTurnUsage: { input_tokens: 412, output_tokens: 188, cache_creation_input_tokens: 1200, cache_read_input_tokens: 31_000, total_cost_usd: 0.0061 },
      sessionUsage: { input_tokens: 41_200, output_tokens: 38_100, cache_creation_input_tokens: 162_000, cache_read_input_tokens: 1_840_000, total_cost_usd: 0.7731, turns: 412 },
      lastTurnError: { subtype: "error_max_turns", at: now - 22 * 60_000 },
      windowStats: { botBillableLast5h: 210_000, latestAnchor: { at: now - 40 * 60_000, utilization: 0.31 }, botBillableSinceLastAnchor: 32_000, estimatedBudget: 900_000, estimatedCurrentUtilization: 0.34, anchorCount: 3 },
    },
    chat: { currentPartner: "Zack" },
    telemetry: {
      runId: RUN_ID, runStartedAt: runStart,
      last30m: aggregate(run, now - 1800_000, now), run: aggregate(run, runStart, now), runTruncated: false,
      currentTask: { taskId: "run-cur-live", startedAt: now - 41_000, runningMs: 41_000, request: "smelt the iron, then make Zack a pickaxe", toolCalls: 6, toolFailures: 1, firstReplyMs: 1900 },
      recentTasks: ends.map((end) => ({ start: starts.get(end.taskId) ?? null, end })),
      notable,
    },
    memory: {
      refreshedAt: now - 2000,
      pois: { count: 9, latest: [
        { type: "base", name: "main base", position: { x: 112, y: 64, z: -40 }, timestamp: now - 3600_000, source: "claude" },
        { type: "crafting_table", position: { x: 114, y: 64, z: -41 }, timestamp: now - 1800_000, source: "auto" },
        { type: "furnace", position: { x: 115, y: 64, z: -41 }, timestamp: now - 600_000, source: "auto" },
        { type: "bed", position: { x: 109, y: 64, z: -44 }, timestamp: now - 5 * 3600_000, source: "auto" },
        { type: "portal", name: "nether portal", position: { x: 210, y: 70, z: 18 }, timestamp: now - 26 * 3600_000, source: "claude" },
      ] },
      containers: { count: 3, latest: [
        { type: "chest", position: { x: 111, y: 64, z: -39 }, last_opened: now - 300_000, last_opened_by: BOT, contents: [{ item: "oak_log", count: 96 }, { item: "cobblestone", count: 128 }, { item: "wheat_seeds", count: 14 }, { item: "string", count: 3 }] },
        { type: "barrel", position: { x: 113, y: 64, z: -44 }, last_opened: now - 7200_000, last_opened_by: "Zack" },
      ] },
      deaths: { count: 1, latest: [{ position: { x: -12, y: 11, z: 40 }, cause: "Steve_AI tried to swim in lava", timestamp: now - 20 * 3600_000 }] },
      conversation: { count: 214, tail: [
        { at: now - 300_000, kind: "player", who: "Zack", channel: "chat", text: "steve can you smelt the iron and make me a pickaxe" },
        { at: now - 297_000, kind: "bot", who: BOT, channel: "chat", text: "On it! Heading to the furnace now." },
        { at: now - 200_000, kind: "player", who: "Alex", channel: "whisper", to: BOT, text: "where's the base?" },
        { at: now - 198_000, kind: "bot", who: BOT, channel: "whisper", to: "Alex", text: "Main base is at 112, 64, -40 — follow the torches." },
        { at: now - 120_000, kind: "outcome", text: "task finished · 9 turns" },
      ] as any },
      tasks: { currentTask: "smelt the iron, then make Zack a pickaxe", queued: ["bring Zack the pickaxe", "put the extra logs in the chest"] },
      error: null,
    },
  };
}

// ── WebSocket ──────────────────────────────────────────────────────────
const subs = new Map<WebSocket, Set<WsChannel>>();
function broadcast(ch: WsChannel, msg: WsServerMessage): void {
  for (const [ws, set] of subs) if (set.has(ch)) ws.send(JSON.stringify(msg));
}
function pushStatus(): void {
  broadcast("status", { type: "status", data: status() });
}
setInterval(pushStatus, 2000);
setInterval(() => {
  if (!state.bot.running) return;
  state.pos.x += (Math.random() - 0.5) * 2;
  state.pos.z += (Math.random() - 0.5) * 2;
  broadcast("snapshot", { type: "snapshot", data: [snapshot()] });
}, 1000);
let tick = 0;
setInterval(() => {
  tick++;
  if (state.bot.running) {
    const now = Date.now();
    const base = { at: now, bot: BOT, runId: RUN_ID, taskId: "run-cur-live" };
    const pool: TelemetryEvent[] = [
      { ...base, kind: "skill", skill: "placeBlock", args: "{\"block\":\"furnace\"}", ok: false, durationMs: 610, message: "no reference block to place against", cancelled: false, timedOut: false },
      { ...base, kind: "nav", label: "furnace", result: "stuck", distance: 14, durationMs: 9100, from: { x: 112, y: 64, z: -40 }, to: { x: 115, y: 64, z: -41 } },
      { ...base, kind: "door", action: "open", block: "oak_door", pos: { x: 110, y: 64, z: -38 } },
      { ...base, kind: "reflex", reflex: "eat", detail: "ate bread (food 14 → 19)" },
      { ...base, kind: "hurt", health: 13, by: "zombie" },
    ];
    const ev = pool[tick % pool.length]!;
    events.push(ev);
    broadcast("events", { type: "event", data: ev });
    const line = `[Steve_AI] ${new Date().toLocaleTimeString()} ${ev.kind}${ev.kind === "skill" ? ` ${ev.skill} ✗ ${ev.message}` : ""}`;
    logs.bot.push(line);
    broadcast("logs:bot", { type: "log", source: "bot", lines: [ev.kind === "skill" ? `WARN ${line}` : line] });
  }
  if (state.server.state === "running" && tick % 2 === 0) {
    const l = `[${new Date().toLocaleTimeString()} INFO]: ${tick % 6 === 0 ? "Zack issued server command: /time query daytime" : "Autosave: saved 1 chunk"}`;
    logs.server.push(l);
    broadcast("logs:server", { type: "log", source: "server", lines: [l] });
  }
}, 6000);

// ── HTTP ───────────────────────────────────────────────────────────────
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };
const SEC_HEADERS = {
  // Same strict policy the real panel will send — the UI must work under it.
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://x");
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (p === "/" || !extname(p)) p = "/index.html";
  const file = join(DIST, p);
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, SEC_HEADERS);
    res.end(existsSync(DIST) ? "not found" : "UI not built — run `npm run ui:build` first");
    return;
  }
  res.writeHead(200, { ...SEC_HEADERS, "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": p.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
  res.end(readFileSync(file));
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  if (!path.startsWith("/api/")) return serveStatic(req, res);
  await delay(80 + Math.random() * 200); // realistic latency

  if (path === "/api/auth/login" && req.method === "POST") {
    if (Date.now() < lockedUntil) {
      const secs = Math.ceil((lockedUntil - Date.now()) / 1000);
      return err(res, 429, "rate_limited", `Too many failed attempts from this address.`, { "Retry-After": String(secs) });
    }
    const b = await body(req);
    if (b.password !== PASSWORD || b.totp !== TOTP) {
      failed++;
      addAudit(req, "login_fail", b.password !== PASSWORD ? "bad password" : "bad totp", false, null);
      if (failed >= 5) {
        failed = 0;
        lockedUntil = Date.now() + 60_000;
        addAudit(req, "lockout", "5 failures — locked 60s", false, null);
        return err(res, 429, "locked_out", "Sign-in locked after repeated failures.", { "Retry-After": "60" });
      }
      return err(res, 401, "unauthorized", "Invalid password or code.");
    }
    failed = 0;
    const id = randomBytes(16).toString("hex");
    const s = { csrf: randomBytes(16).toString("hex"), expiresAt: Date.now() + 12 * 3600_000 };
    sessions.set(id, s);
    addAudit(req, "login_ok", "password+totp");
    res.setHeader("Set-Cookie", `sid=${id}; HttpOnly; SameSite=Strict; Path=/`);
    return json(res, 200, { user: "admin", csrfToken: s.csrf, sessionExpiresAt: s.expiresAt } satisfies MeResponse);
  }

  const sess = session(req);
  if (!sess) return err(res, 401, "unauthorized", "Not signed in.");
  if (req.method !== "GET" && req.headers["x-csrf-token"] !== sess.csrf) return err(res, 403, "csrf", "Missing or invalid CSRF token.");

  if (path === "/api/auth/me") return json(res, 200, { user: "admin", csrfToken: sess.csrf, sessionExpiresAt: sess.expiresAt } satisfies MeResponse);
  if (path === "/api/auth/logout") { sessions.delete(sess.id); addAudit(req, "logout", "logout"); res.setHeader("Set-Cookie", "sid=; Max-Age=0; Path=/"); return json(res, 204); }
  if (path === "/api/auth/logout-all") { sessions.clear(); addAudit(req, "session_revoked", "all sessions"); return json(res, 204); }
  if (path === "/api/status") return json(res, 200, status());
  if (path === "/api/actions" && req.method === "GET") return json(res, 200, actionDefs());
  const am = /^\/api\/actions\/([\w.]+)$/.exec(path);
  if (am && req.method === "POST") {
    const def = actionDefs().find((a) => a.id === am[1]);
    if (!def) return err(res, 404, "not_found", "Unknown action.");
    const b = await body(req);
    let seed: string | null = null;
    if (def.id === "world.new") {
      if (b.confirm !== "NEW WORLD") return err(res, 400, "bad_request", 'confirm must be exactly "NEW WORLD"');
      const raw = typeof b.seed === "string" ? b.seed.trim() : b.seed == null ? "" : null;
      if (raw === null || (raw !== "" && !/^-?[A-Za-z0-9_ ]{1,32}$/.test(raw))) return err(res, 400, "bad_request", "seed must be 1–32 letters, digits, underscores or spaces (optional leading '-')");
      seed = raw || null;
    }
    if (!def.available) return err(res, 409, "busy", def.unavailableReason ?? "Unavailable.");
    const job = startJob(def.id, "admin", seed);
    addAudit(req, "action", def.id === "world.new" ? `world.new seed=${seed === null ? "(random)" : JSON.stringify(seed)} started (job ${job.id})` : def.id);
    pushStatus();
    return json(res, 202, summary(job));
  }
  if (path === "/api/jobs") return json(res, 200, jobs.map(summary));
  const jm = /^\/api\/jobs\/(\w+)$/.exec(path);
  if (jm) { const j = jobs.find((x) => x.id === jm[1]); return j ? json(res, 200, j) : err(res, 404, "not_found", "No such job."); }
  if (path === "/api/console" && req.method === "POST") {
    const b = await body(req);
    const command = String(b.command ?? "");
    if (!command || command.length > 256 || /[\r\n]/.test(command)) return err(res, 400, "bad_request", "One command, ≤256 chars, no newlines.");
    if (state.server.state !== "running") return err(res, 503, "server_down", "Server isn't running (RCON unavailable).");
    const out =
      command === "list" ? `There are ${state.players.online.length + 1} of a max of 20 players online: ${[...state.players.online, BOT].join(", ")}`
      : command.startsWith("time set") ? `Set the time to ${command.endsWith("day") ? 1000 : 13000}`
      : command.startsWith("weather") ? "Set the weather to clear"
      : command === "save-all" ? "Saving the game (this may take a moment!)\nSaved the game"
      : command === "seed" ? "Seed: [-4172144997902289642]"
      : command === "tps" ? "TPS from last 1m, 5m, 15m: 20.0, 19.98, 19.97"
      : command.startsWith("say ") ? ""
      : `Unknown or incomplete command, see below for error\n${command}<--[HERE]`;
    const r: ConsoleResponse = { command, output: out, at: Date.now() };
    consoleHist.unshift(r);
    addAudit(req, "console", command);
    return json(res, 200, r);
  }
  if (path === "/api/console/history") return json(res, 200, consoleHist.slice(0, 100));
  const playersResp = (): PlayersResponse => {
    const online = state.server.state === "running" ? state.players.online : [];
    const names = [...online, ...(state.bot.running ? [BOT] : [])];
    return { ...state.players, online, gameModes: Object.fromEntries(names.filter((n) => state.gameModes[n]).map((n) => [n, state.gameModes[n]!])) };
  };
  if (path === "/api/players" && req.method === "GET") return json(res, 200, playersResp());
  if (path.startsWith("/api/players/") && req.method === "POST") {
    const b = await body(req);
    const op = path.split("/").pop();
    if (op === "say") { addAudit(req, "players", `say ${b.message}`); return json(res, 204); }
    const name = String(b.name ?? "");
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return err(res, 400, "bad_request", "Invalid player name.");
    const P = state.players;
    if (op === "gamemode") {
      if (!["survival", "creative", "adventure", "spectator"].includes(b.mode)) return err(res, 400, "bad_request", "mode must be one of survival, creative, adventure, spectator");
      if (state.server.state !== "running") return err(res, 503, "server_down", "Minecraft server is not running");
      if (!P.online.includes(name) && !(name === BOT && state.bot.running)) return err(res, 409, "player_offline", `${name} is not online`);
      state.gameModes[name] = b.mode;
      addAudit(req, "players", `gamemode ${b.mode} ${name}`);
      return json(res, 200, playersResp());
    }
    if (op === "whitelist") P.whitelist = b.add ? [...new Set([...P.whitelist, name])] : P.whitelist.filter((n) => n !== name);
    else if (op === "op") P.ops = b.op ? [...new Set([...P.ops, name])] : P.ops.filter((n) => n !== name);
    else if (op === "kick") P.online = P.online.filter((n) => n !== name);
    addAudit(req, "players", `${op} ${name} ${JSON.stringify(b)}`);
    return json(res, 200, playersResp());
  }
  if (path === "/api/bot/snapshot") return json(res, 200, state.bot.running ? [snapshot()] : []);
  if (path === "/api/bot/report") return json(res, 200, report(url.searchParams.get("since") ?? "run"));
  if (path === "/api/bot/events") {
    const since = Number(url.searchParams.get("since") ?? 0);
    const kinds = url.searchParams.get("kinds")?.split(",");
    const limit = Number(url.searchParams.get("limit") ?? 500);
    const out = events.filter((e) => e.at >= since && e.at <= Date.now() && (!kinds || kinds.includes(e.kind)));
    return json(res, 200, out.slice(-limit));
  }
  const lm = /^\/api\/logs\/(bot|server)$/.exec(path);
  if (lm) return json(res, 200, { lines: logs[lm[1] as "bot" | "server"].slice(-Number(url.searchParams.get("lines") ?? 500)) });
  if (path === "/api/backups") return json(res, 200, backups);
  if (path === "/api/audit") return json(res, 200, audit.slice(0, Number(url.searchParams.get("limit") ?? 200)));
  return err(res, 404, "not_found", `No route ${req.method} ${path}`);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://x").pathname !== "/api/ws" || !session(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    subs.set(ws, new Set());
    ws.on("message", (raw) => {
      let m: WsClientMessage;
      try { m = JSON.parse(String(raw)); } catch { return; }
      const set = subs.get(ws)!;
      if (m.type === "subscribe") {
        set.add(m.channel);
        if (m.channel === "status") ws.send(JSON.stringify({ type: "status", data: status() } satisfies WsServerMessage));
        if (m.channel === "snapshot" && state.bot.running) ws.send(JSON.stringify({ type: "snapshot", data: [snapshot()] } satisfies WsServerMessage));
      } else set.delete(m.channel);
    });
    ws.on("close", () => subs.delete(ws));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock panel on http://127.0.0.1:${PORT}  (password "${PASSWORD}", TOTP "${TOTP}")`);
});
