/**
 * HTTP request pipeline:
 *   security headers → per-IP limit → Host allowlist → (static | API)
 *   API: Origin check on state changes → session (except login) → CSRF on
 *   state changes → per-session limit → route.
 * Errors never include stack traces or filesystem paths.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  ActionId,
  AuditEntry,
  BackupInfo,
  ConsoleResponse,
  GameMode,
  LogSource,
  MeResponse,
  PlayersResponse,
} from "../shared/api.js";
import { audit, readAudit } from "./audit.js";
import type { Auth } from "./auth.js";
import type { PanelConfig } from "./config.js";
import { COMPOSE_SERVICE, rcon, run, sanitizeDockerError, stripAnsi } from "./exec.js";
import {
  clientIp,
  hostAllowed,
  HttpError,
  ipBucket,
  originAllowed,
  readJsonBody,
  securityHeaders,
  sendError,
  sendJson,
  sendNoContent,
} from "./http-util.js";
import { isActionId, type JobManager } from "./jobs.js";
import { SlidingLimiter } from "./ratelimit.js";
import { buildReport, queryEvents } from "./report.js";
import { clearCookie, COOKIE_NAME, csrfOk, parseCookies, sessionCookie, type Session, type SessionStore } from "./sessions.js";
import { GameModeCache } from "./gamemodes.js";
import { botProcess, readSnapshots, type StatusService } from "./status.js";
import { serveStatic } from "./static.js";
import { validateWorldNew } from "./world-new.js";
import { readTailLines } from "./tail.js";
import {
  intParam,
  PLAYER_NAME_RE,
  validateBool,
  validateConsoleCommand,
  validateGameMode,
  validateMessage,
  validatePlayerName,
  ValidationError,
} from "./validate.js";

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  ip: string;
  url: URL;
  method: string;
  session: Session | null;
}

export class PanelApp {
  readonly ipLimiter = new SlidingLimiter(600, 60_000);
  private apiLimiter = new SlidingLimiter(600, 60_000);
  private consoleLimiter = new SlidingLimiter(30, 60_000);
  private actionLimiter = new SlidingLimiter(12, 60_000);
  private playerLimiter = new SlidingLimiter(30, 60_000);
  /** world.new is destructive and slow: at most 3 submissions per hour panel-wide (one key, so new sessions can't reset it; on top of actionLimiter). */
  private worldNewLimiter = new SlidingLimiter(3, 60 * 60_000);
  private gameModes = new GameModeCache();
  private consoleHistory: ConsoleResponse[] = [];

  constructor(
    private readonly cfg: PanelConfig,
    private readonly auth: Auth,
    private readonly sessions: SessionStore,
    private readonly status: StatusService,
    private readonly jobs: JobManager,
  ) {}

  handle = (req: IncomingMessage, res: ServerResponse): void => {
    securityHeaders(this.cfg, res);
    void this.dispatch(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message, err.headers);
      if (err instanceof ValidationError) return sendError(res, 400, "bad_request", err.message);
      const code = (err as { code?: string }).code;
      if (code === "busy" || code === "unavailable") return sendError(res, 409, code, (err as Error).message);
      if (code === "not_found") return sendError(res, 404, "not_found", (err as Error).message);
      console.error("panel: unhandled error:", (err as Error)?.message ?? err);
      sendError(res, 500, "internal", "Internal error");
    });
  };

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req);
    if (!this.ipLimiter.take(ipBucket(ip))) throw new HttpError(429, "rate_limited", "Slow down", { "Retry-After": "60" });
    if (!hostAllowed(this.cfg, req.headers.host)) throw new HttpError(421, "bad_host", "Unknown host");
    const rawUrl = req.url ?? "/";
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.length > 2048) throw new HttpError(400, "bad_request", "Bad URL");
    const url = new URL(rawUrl, "https://panel.invalid");
    const method = (req.method ?? "GET").toUpperCase();

    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed", { Allow: "GET, HEAD" });
      const r = serveStatic(this.cfg.uiDir, req, res, url.pathname, method === "HEAD");
      if (r === "bad_request") throw new HttpError(400, "bad_request", "Bad path");
      if (r === "not_found") throw new HttpError(404, "not_found", "Not found");
      return;
    }

    const ctx: Ctx = { req, res, ip, url, method, session: null };
    const changing = STATE_CHANGING.has(method);
    if (changing && !originAllowed(this.cfg, req.headers.origin)) {
      throw new HttpError(403, "origin", "Cross-origin request refused");
    }

    if (method === "POST" && url.pathname === "/api/auth/login") return this.login(ctx);

    let rev: string;
    try {
      rev = this.auth.rev();
    } catch {
      throw new HttpError(503, "not_configured", "Panel credentials are not configured");
    }
    const session = this.sessions.get(parseCookies(req.headers.cookie).get(COOKIE_NAME), rev, true);
    if (!session) throw new HttpError(401, "unauthorized", "Login required");
    ctx.session = session;
    if (changing && !csrfOk(session, req.headers["x-csrf-token"])) throw new HttpError(403, "csrf", "Missing or invalid CSRF token");
    if (!this.apiLimiter.take(session.key)) throw new HttpError(429, "rate_limited", "Too many requests", { "Retry-After": "30" });

    return this.route(ctx);
  }

  private async route(ctx: Ctx): Promise<void> {
    const { method, url, res } = ctx;
    const p = url.pathname;
    const q = url.searchParams;
    const get = method === "GET" || method === "HEAD";

    if (get && p === "/api/auth/me") return sendJson(res, 200, this.me(ctx.session!));
    if (method === "POST" && p === "/api/auth/logout") return this.logout(ctx);
    if (method === "POST" && p === "/api/auth/logout-all") return this.logoutAll(ctx);

    if (get && p === "/api/status") return sendJson(res, 200, await this.status.get());
    if (get && p === "/api/actions") return sendJson(res, 200, this.jobs.defs(await this.status.get()));
    if (method === "POST" && p.startsWith("/api/actions/")) return this.runAction(ctx, p.slice("/api/actions/".length));
    if (get && p === "/api/jobs") return sendJson(res, 200, this.jobs.list());
    if (get && p.startsWith("/api/jobs/")) {
      const id = p.slice("/api/jobs/".length);
      const j = /^[A-Za-z0-9_-]{1,32}$/.test(id) ? this.jobs.get(id) : null;
      if (!j) throw new HttpError(404, "not_found", "No such job");
      return sendJson(res, 200, j);
    }

    if (method === "POST" && p === "/api/console") return this.console(ctx);
    if (get && p === "/api/console/history") return sendJson(res, 200, this.consoleHistory);

    if (get && p === "/api/players") return sendJson(res, 200, await this.players());
    if (method === "POST" && p.startsWith("/api/players/")) return this.playerChange(ctx, p.slice("/api/players/".length));

    if (get && p === "/api/bot/snapshot") return sendJson(res, 200, botProcess(this.cfg).running ? readSnapshots(this.cfg) : []);
    if (get && p === "/api/bot/report") return sendJson(res, 200, buildReport(this.cfg.telemetryDir, q.get("bot"), q.get("since")));
    if (get && p === "/api/bot/events") {
      return sendJson(res, 200, queryEvents(this.cfg.telemetryDir, q.get("bot"), q.get("since"), q.get("kinds"), intParam(q.get("limit"), 500, 1, 2000)));
    }

    if (get && p.startsWith("/api/logs/")) return this.logs(ctx, p.slice("/api/logs/".length));
    if (get && p === "/api/backups") return sendJson(res, 200, this.backups());
    if (get && p === "/api/audit") return sendJson(res, 200, readAudit(intParam(q.get("limit"), 200, 1, 1000)) satisfies AuditEntry[]);

    throw new HttpError(404, "not_found", "No such endpoint");
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  private me(s: Session): MeResponse {
    return { user: s.user, csrfToken: s.csrf, sessionExpiresAt: this.sessions.expiresAt(s) };
  }

  private async login(ctx: Ctx): Promise<void> {
    const body = await readJsonBody(ctx.req);
    const { id, session } = await this.auth.login(ctx.ip, body);
    // Session fixation defence: whatever session the browser presented is destroyed; the new id is fresh.
    let oldRev = "";
    try {
      oldRev = this.auth.rev();
    } catch {
      /* unreachable after a successful login */
    }
    const old = this.sessions.get(parseCookies(ctx.req.headers.cookie).get(COOKIE_NAME), oldRev, false);
    if (old && old.key !== session.key) this.sessions.revoke(old.key);
    sendJson(ctx.res, 200, this.me(session), { "Set-Cookie": sessionCookie(id) });
  }

  private logout(ctx: Ctx): void {
    this.sessions.revoke(ctx.session!.key);
    audit({ ip: ctx.ip, user: ctx.session!.user, kind: "logout", detail: "logout", ok: true });
    sendNoContent(ctx.res, { "Set-Cookie": clearCookie() });
  }

  private logoutAll(ctx: Ctx): void {
    const n = this.sessions.revokeAll();
    audit({ ip: ctx.ip, user: ctx.session!.user, kind: "session_revoked", detail: `logout-all revoked ${n} session(s)`, ok: true });
    sendNoContent(ctx.res, { "Set-Cookie": clearCookie() });
  }

  // ── Actions ───────────────────────────────────────────────────────────

  private async runAction(ctx: Ctx, rawId: string): Promise<void> {
    const user = ctx.session!.user;
    if (!isActionId(rawId)) {
      audit({ ip: ctx.ip, user, kind: "action", detail: `rejected unknown action ${JSON.stringify(rawId.slice(0, 64))}`, ok: false });
      throw new HttpError(404, "not_found", "Unknown action");
    }
    const id: ActionId = rawId;
    if (!this.actionLimiter.take(ctx.session!.key)) throw new HttpError(429, "rate_limited", "Too many actions", { "Retry-After": "60" });
    const body = await readJsonBody(ctx.req); // ignored except for world.new
    let seed: string | null = null;
    let label: string = id;
    if (id === "world.new") {
      try {
        seed = validateWorldNew(body).seed;
      } catch (err) {
        audit({ ip: ctx.ip, user, kind: "action", detail: `world.new rejected: ${(err as Error).message}`, ok: false });
        throw err;
      }
      label = `world.new seed=${seed === null ? "(random)" : JSON.stringify(seed)}`;
      // Counted after validation (a typo'd confirm shouldn't burn an attempt), before any precondition/exec.
      if (!this.worldNewLimiter.take("world.new")) {
        audit({ ip: ctx.ip, user, kind: "action", detail: `${label} refused: rate limited`, ok: false });
        throw new HttpError(429, "rate_limited", "Too many new-world attempts — try again later", { "Retry-After": "3600" });
      }
    }
    try {
      const job = this.jobs.start(id, user, await this.status.get(0), { seed });
      audit({ ip: ctx.ip, user, kind: "action", detail: `${label} started (job ${job.id})`, ok: true });
      sendJson(ctx.res, 202, job);
    } catch (err) {
      // A precondition/busy refusal ran nothing, so it shouldn't spend a world.new attempt.
      if (id === "world.new") this.worldNewLimiter.refund("world.new");
      audit({ ip: ctx.ip, user, kind: "action", detail: `${label} refused: ${(err as Error).message}`, ok: false });
      throw err;
    }
  }

  // ── Console ───────────────────────────────────────────────────────────

  private async console(ctx: Ctx): Promise<void> {
    const user = ctx.session!.user;
    if (!this.consoleLimiter.take(ctx.session!.key)) throw new HttpError(429, "rate_limited", "Too many console commands", { "Retry-After": "60" });
    const body = await readJsonBody(ctx.req);
    let command: string;
    try {
      command = validateConsoleCommand(body.command);
    } catch (err) {
      audit({ ip: ctx.ip, user, kind: "console", detail: `rejected: ${(err as Error).message}`, ok: false });
      throw err;
    }
    await this.requireServer(() => audit({ ip: ctx.ip, user, kind: "console", detail: `${command} (refused: server down)`, ok: false }));
    const r = await rcon(command);
    audit({ ip: ctx.ip, user, kind: "console", detail: command, ok: r.ok });
    const entry: ConsoleResponse = { command, output: r.output.slice(0, 64 * 1024), at: Date.now() };
    this.consoleHistory.unshift(entry);
    this.consoleHistory.length = Math.min(this.consoleHistory.length, 100);
    if (!r.ok) throw new HttpError(502, "rcon_failed", r.output || "RCON command failed");
    sendJson(ctx.res, 200, entry);
  }

  private async requireServer(onDown: () => void): Promise<void> {
    const s = await this.status.get();
    if (!s.server.reachable) onDown();
    if (!s.server.reachable) throw new HttpError(503, "server_down", "Minecraft server is not running");
  }

  // ── Players ───────────────────────────────────────────────────────────

  private readNameList(file: string): string[] {
    try {
      const path = resolve(this.cfg.mcDataDir, file);
      if (!existsSync(path) || statSync(path).size > 1024 * 1024) return [];
      const arr = JSON.parse(readFileSync(path, "utf8")) as Array<{ name?: unknown }>;
      return Array.isArray(arr) ? arr.map((e) => e?.name).filter((n): n is string => typeof n === "string" && PLAYER_NAME_RE.test(n)) : [];
    } catch {
      return [];
    }
  }

  private async players(): Promise<PlayersResponse> {
    const s = await this.status.get();
    const online = s.server.players?.names ?? [];
    return {
      online,
      whitelist: this.readNameList("whitelist.json"),
      ops: this.readNameList("ops.json"),
      gameModes: s.server.reachable ? await this.gameModes.get(online.filter((n) => PLAYER_NAME_RE.test(n))) : {},
    };
  }

  private async playerChange(ctx: Ctx, sub: string): Promise<void> {
    const user = ctx.session!.user;
    if (!["whitelist", "op", "kick", "say", "gamemode"].includes(sub)) throw new HttpError(404, "not_found", "No such endpoint");
    if (!this.playerLimiter.take(ctx.session!.key)) throw new HttpError(429, "rate_limited", "Too many player changes", { "Retry-After": "60" });
    const body = await readJsonBody(ctx.req);
    let command: string;
    let detail: string;
    try {
      if (sub === "say") {
        const msg = validateMessage(body.message, "message")!;
        command = `say ${msg}`;
        detail = `say ${msg}`;
      } else {
        const name = validatePlayerName(body.name);
        if (sub === "gamemode") command = `gamemode ${validateGameMode(body.mode)} ${name}`;
        else if (sub === "whitelist") command = `whitelist ${validateBool(body.add, "add") ? "add" : "remove"} ${name}`;
        else if (sub === "op") command = `${validateBool(body.op, "op") ? "op" : "deop"} ${name}`;
        else {
          const reason = validateMessage(body.reason, "reason", true);
          command = reason ? `kick ${name} ${reason}` : `kick ${name}`;
        }
        detail = command;
      }
    } catch (err) {
      audit({ ip: ctx.ip, user, kind: "players", detail: `rejected ${sub}: ${(err as Error).message}`, ok: false });
      throw err;
    }
    await this.requireServer(() => audit({ ip: ctx.ip, user, kind: "players", detail: `${detail} (refused: server down)`, ok: false }));
    const r = await rcon(command);
    // rcon-cli exits 0 even when the command itself was refused (e.g. target offline).
    const refused = sub === "gamemode" && r.ok && /no player was found|unknown or incomplete|incorrect argument/i.test(r.output);
    audit({ ip: ctx.ip, user, kind: "players", detail: refused ? `${detail} (refused: ${r.output.slice(0, 80)})` : detail, ok: r.ok && !refused });
    if (!r.ok) throw new HttpError(502, "rcon_failed", r.output || "RCON command failed");
    if (sub === "say") return sendNoContent(ctx.res);
    if (sub === "gamemode") {
      const name = body.name as string;
      this.gameModes.invalidate(name);
      if (refused) throw new HttpError(409, "player_offline", `${name} is not online`);
      this.gameModes.set(name, body.mode as GameMode);
    }
    await sleep(300); // server persists whitelist.json / ops.json right after the command
    sendJson(ctx.res, 200, await this.players());
  }

  // ── Logs / backups ────────────────────────────────────────────────────

  private async logs(ctx: Ctx, source: string): Promise<void> {
    if (source !== "bot" && source !== "server") throw new HttpError(404, "not_found", "Unknown log source");
    const lines = intParam(ctx.url.searchParams.get("lines"), 500, 1, 5000);
    const src: LogSource = source;
    if (src === "bot") return sendJson(ctx.res, 200, { lines: readTailLines(this.cfg.botLogFile, lines) });
    const r = await run(["docker", "compose", "logs", "--tail", String(lines), "--no-color", "--no-log-prefix", COMPOSE_SERVICE], 15_000);
    if (r.code !== 0) throw new HttpError(503, "unavailable", `Server logs unavailable: ${sanitizeDockerError(r.error ?? r.stderr)}`);
    const out = r.stdout.split(/\r?\n/);
    if (out[out.length - 1] === "") out.pop();
    sendJson(ctx.res, 200, { lines: out.slice(-lines).map((l) => stripAnsi(l).slice(0, 4096)) });
  }

  private backups(): BackupInfo[] {
    if (!existsSync(this.cfg.backupsDir)) return [];
    const out: BackupInfo[] = [];
    for (const name of readdirSync(this.cfg.backupsDir)) {
      if (!/^world_[0-9_-]+\.tar\.gz$/.test(name)) continue;
      try {
        const st = statSync(resolve(this.cfg.backupsDir, name));
        if (st.isFile()) out.push({ file: name, sizeBytes: st.size, createdAt: st.mtimeMs });
      } catch {
        /* raced with prune */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}
