/**
 * Web control panel — API contract shared by the server (`src/web/server/`)
 * and the browser UI (`src/web/ui/`). Both sides build against this file; the
 * server must not grow endpoints the UI can't type, and vice versa.
 *
 * Deployment: a standalone, always-on panel process on the host (not inside
 * the orchestrator), reachable publicly over HTTPS at the DuckDNS hostname.
 * Because it can run arbitrary server-console commands from the internet,
 * every route except `POST /api/auth/login` and static assets requires an
 * authenticated session, and every state-changing route requires the CSRF
 * header. See ARCHITECTURE.md "Web control panel" for the security model.
 *
 * Transport conventions:
 *  - JSON over HTTPS. Errors: non-2xx with `ApiError` body.
 *  - Session: HttpOnly + Secure + SameSite=Strict cookie set by login.
 *  - CSRF: state-changing requests (POST/PUT/DELETE) send header
 *    `X-CSRF-Token: <MeResponse.csrfToken>`.
 *  - Live data: one WebSocket at `/api/ws` (same cookie auth), carrying
 *    `WsServerMessage` frames; the client subscribes to channels.
 */

import type { BotSnapshot } from "../../observability/snapshot.js";
import type { TelemetryAggregate } from "../../observability/telemetry-types.js";

export interface ApiError {
  error: string; // machine code, e.g. "unauthorized", "csrf", "rate_limited", "busy"
  message: string; // human readable
}

// ── Auth ────────────────────────────────────────────────────────────────
// Single admin account. Password + TOTP (6-digit authenticator code) are
// both required — the panel exposes a raw console to the internet.

/** POST /api/auth/login */
export interface LoginRequest {
  password: string;
  totp: string;
}
/** 200 → MeResponse (and session cookie). 401 bad creds; 429 locked out. */

/** GET /api/auth/me — 200 when logged in, 401 otherwise. */
export interface MeResponse {
  user: string;
  csrfToken: string;
  sessionExpiresAt: number; // unix ms
}

/** POST /api/auth/logout — 204. Also POST /api/auth/logout-all — 204 (kills every session). */

// ── Status ──────────────────────────────────────────────────────────────

/** GET /api/status — cheap, polled/pushed often. */
export interface StatusResponse {
  at: number;
  server: {
    /** Docker container state of the `minecraft` service. */
    state: "running" | "starting" | "stopped" | "unhealthy" | "unknown";
    since: number | null; // unix ms container started
    reachable: boolean; // TCP :25565 accepting
    players: { online: number; max: number | null; names: string[] } | null; // via RCON `list`
    version: string | null;
  };
  duckdns: { state: "running" | "stopped" | "unknown" };
  bot: {
    /** Orchestrator process (scripts/botStart.sh). */
    running: boolean;
    pid: number | null;
    since: number | null;
    /** From snapshot.json; null when the bot is down or the snapshot is stale (>5s). */
    bots: Array<{
      username: string;
      connection: string;
      health: number | null;
      food: number | null;
      currentTool: string | null;
      currentTask: string | null;
    }> | null;
  };
  host: { loadAvg1m: number; freeMemMb: number; totalMemMb: number; diskFreeGb: number | null };
  panel: { version: string; startedAt: number };
  /** Jobs currently running (server/bot lifecycle actions are mutually exclusive). */
  activeJobs: JobSummary[];
}

// ── Actions & jobs ──────────────────────────────────────────────────────
// A fixed allowlist of named actions. The server maps each id to a concrete
// argv (never a shell string, never user-supplied arguments).

export type ActionId =
  | "server.start" // scripts/start.sh
  | "server.stop" // scripts/stop.sh
  | "server.restart" // stop then start
  | "bot.start" // scripts/botStart.sh
  | "bot.stop" // scripts/botStop.sh
  | "bot.restart" // stop then start
  | "world.save" // rcon save-all
  | "backup.run" // scripts/backup.sh
  | "world.new"; // destructive: archive world + bot memory, regenerate (takes WorldNewRequest)

/**
 * POST /api/actions/world.new body. The only action that takes input.
 *  - `seed`: optional. Empty/absent = random. Validated server-side against
 *    /^-?[A-Za-z0-9_ ]{1,32}$/ (Minecraft accepts numbers or text). Never
 *    written to `.env` or a shell; passed as LEVEL_SEED in the child env only.
 *  - `confirm`: must equal exactly "NEW WORLD" (typed by the user in the UI).
 * The job: backup.run → stop bot (if running) → stop server → move world,
 * world_nether, world_the_end to backups/worlds/<timestamp>/ → move the bot
 * memory dir(s) to data/orchestrator/memory-archive/<timestamp>/ → start
 * server with the seed → wait until reachable → restart bot if it was running.
 * Nothing is deleted. Exclusive across ALL action groups while running.
 */
export interface WorldNewRequest {
  seed?: string;
  confirm: "NEW WORLD";
}

export interface ActionDef {
  id: ActionId;
  label: string;
  description: string;
  /** UI must confirm before running (stop/restart). */
  confirm: boolean;
  /** Group for mutual exclusion; only one job per group runs at a time (409 "busy"). */
  group: "server" | "bot" | "world";
  /** Server-side precondition result, so the UI can disable buttons. */
  available: boolean;
  unavailableReason: string | null;
}

/** GET /api/actions → ActionDef[] */
/** POST /api/actions/:id → 202 JobSummary; 409 { error: "busy" } if group busy. */

export type JobState = "running" | "succeeded" | "failed";

export interface JobSummary {
  id: string;
  action: ActionId;
  state: JobState;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  startedBy: string; // session user
}

/** GET /api/jobs → JobSummary[] (newest first, last 50). GET /api/jobs/:id → JobDetail */
export interface JobDetail extends JobSummary {
  /** Combined stdout/stderr, capped (last ~2000 lines). Live tail via WS `job` channel. */
  output: string[];
}

// ── Console (raw RCON) ──────────────────────────────────────────────────

/** POST /api/console */
export interface ConsoleRequest {
  /** One Minecraft server command, without leading "/". ≤ 256 chars, no newlines. */
  command: string;
}
export interface ConsoleResponse {
  command: string;
  output: string; // RCON response text (color codes stripped)
  at: number;
}
/** GET /api/console/history → ConsoleResponse[] (this panel's recent commands, newest first, last 100). */

// ── Players / whitelist (curated wrappers over RCON) ────────────────────

/** GET /api/players */
export interface PlayersResponse {
  online: string[];
  whitelist: string[];
  ops: string[];
  /** Game mode per online player (from RCON `data get entity <name> playerGameType`); missing = unknown. */
  gameModes?: Record<string, GameMode>;
}
export type GameMode = "survival" | "creative" | "adventure" | "spectator";
/** POST /api/players/gamemode    { name, mode: GameMode } → PlayersResponse (rcon `gamemode <mode> <name>`) */
export interface GameModeRequest {
  name: string; // same name regex as PlayerNameRequest
  mode: GameMode;
}
/** POST /api/players/whitelist   { name, add: boolean } → PlayersResponse */
/** POST /api/players/op          { name, op: boolean }  → PlayersResponse */
/** POST /api/players/kick        { name, reason? }      → PlayersResponse */
/** POST /api/players/say         { message }            → 204  (rcon `say`) */
export interface PlayerNameRequest {
  name: string; // validated: /^[A-Za-z0-9_]{3,16}$/
}

// ── Bot insight (read-only) ─────────────────────────────────────────────

/** GET /api/bot/snapshot → BotSnapshot[] (from .bot-runtime/snapshot.json; [] if bot down). */
export type SnapshotResponse = BotSnapshot[];

/** GET /api/bot/report?bot=Steve_AI&since=run|30m|2h|today|all */
export interface ReportResponse {
  bot: string;
  window: { from: number; to: number; label: string };
  aggregate: TelemetryAggregate;
  flags: Array<{ level: "warn" | "info"; code: string; message: string }>;
}

/** GET /api/bot/events?bot=Steve_AI&since=<unix ms>&kinds=task_end,death&limit=500 → TelemetryEvent[] */

// ── Logs ────────────────────────────────────────────────────────────────

export type LogSource = "bot" | "server";
/** GET /api/logs/:source?lines=500 → { lines: string[] } ; live tail via WS `logs:<source>`. */

// ── Backups ─────────────────────────────────────────────────────────────

/** GET /api/backups → BackupInfo[] (newest first). No download/delete in v1. */
export interface BackupInfo {
  file: string; // basename only
  sizeBytes: number;
  createdAt: number;
}

// ── Audit ───────────────────────────────────────────────────────────────

/** GET /api/audit?limit=200 → AuditEntry[] (newest first). Every auth event, action, console command and player change is audited. */
export interface AuditEntry {
  at: number;
  ip: string;
  user: string | null;
  kind: "login_ok" | "login_fail" | "lockout" | "logout" | "action" | "console" | "players" | "session_revoked";
  detail: string;
  ok: boolean;
}

// ── WebSocket /api/ws ───────────────────────────────────────────────────

export type WsChannel =
  | "status" // StatusResponse, pushed every ~2s
  | "snapshot" // SnapshotResponse, pushed every ~1s while subscribed
  | "events" // TelemetryEvent (notable only), pushed as they're written
  | `job:${string}` // job output lines + state changes
  | `logs:${LogSource}`; // new log lines

export type WsClientMessage =
  | { type: "subscribe"; channel: WsChannel }
  | { type: "unsubscribe"; channel: WsChannel };

export type WsServerMessage =
  | { type: "status"; data: StatusResponse }
  | { type: "snapshot"; data: SnapshotResponse }
  | { type: "event"; data: unknown /* TelemetryEvent */ }
  | { type: "job_output"; jobId: string; lines: string[] }
  | { type: "job_state"; job: JobSummary }
  | { type: "log"; source: LogSource; lines: string[] }
  | { type: "error"; error: ApiError };
