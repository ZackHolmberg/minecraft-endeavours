/**
 * WebSocket hub at /api/ws. The upgrade is authenticated exactly like an API
 * request (Host + Origin + session cookie) before the handshake completes.
 * Producers (status poll, snapshot poll, telemetry tail, log tails) only run
 * while someone is subscribed. Slow consumers are dropped, not buffered.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import type { JobSummary, LogSource, WsChannel, WsServerMessage } from "../shared/api.js";
import type { Auth } from "./auth.js";
import type { PanelConfig } from "./config.js";
import { clientIp, hostAllowed, ipBucket, originAllowed } from "./http-util.js";
import type { JobManager } from "./jobs.js";
import { SlidingLimiter } from "./ratelimit.js";
import { isNotable } from "./report.js";
import { COOKIE_NAME, parseCookies, type Session, type SessionStore } from "./sessions.js";
import { botProcess, readSnapshots, type StatusService } from "./status.js";
import { DockerLogFollower, FileTailer, TelemetryTailer } from "./tail.js";

const MAX_CONN_PER_SESSION = 6;
const MAX_CONN_TOTAL = 40;
const MAX_SUBS = 16;
const SOFT_BUFFER = 1024 * 1024;
const HARD_BUFFER = 4 * 1024 * 1024;
const LOG_FLUSH_MS = 250;
const LOG_LINES_PER_FLUSH = 500;

interface Client {
  ws: WebSocket;
  session: Session;
  subs: Set<WsChannel>;
  alive: boolean;
  strikes: number;
}

const JOB_CH = /^job:[A-Za-z0-9_-]{1,32}$/;

function validChannel(c: unknown): c is WsChannel {
  return typeof c === "string" && (c === "status" || c === "snapshot" || c === "events" || c === "logs:bot" || c === "logs:server" || JOB_CH.test(c));
}

export class WsHub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  private clients = new Set<Client>();
  private msgLimiter = new SlidingLimiter(40, 10_000);
  private timers: NodeJS.Timeout[] = [];
  private statusTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private telemetry: TelemetryTailer;
  private botLog: FileTailer;
  private serverLog: DockerLogFollower;
  private logBuf: Record<LogSource, string[]> = { bot: [], server: [] };
  private logDropped: Record<LogSource, number> = { bot: 0, server: 0 };

  constructor(
    private readonly cfg: PanelConfig,
    private readonly sessions: SessionStore,
    private readonly auth: Auth,
    private readonly status: StatusService,
    private readonly jobs: () => JobManager,
    private readonly ipLimiter: SlidingLimiter,
  ) {
    this.telemetry = new TelemetryTailer(cfg.telemetryDir, (ev) => {
      if (ev && typeof ev === "object" && isNotable(ev as { kind?: unknown })) this.broadcast("events", { type: "event", data: ev });
    });
    this.botLog = new FileTailer(cfg.botLogFile, (lines) => this.queueLog("bot", lines));
    this.serverLog = new DockerLogFollower((lines) => this.queueLog("server", lines));

    sessions.onRevoke((keys) => {
      const set = new Set(keys);
      for (const c of this.clients) if (set.has(c.session.key)) c.ws.close(4401, "session ended");
    });
    this.timers.push(
      setInterval(() => this.heartbeat(), 30_000),
      setInterval(() => this.flushLogs(), LOG_FLUSH_MS),
    );
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Node removes its own socket error handler before emitting 'upgrade'; without
    // one, a client RST before the handshake completes is an uncaught 'error'.
    socket.on("error", () => socket.destroy());
    const reject = (code: number, text: string): void => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    try {
      if (!this.ipLimiter.take(ipBucket(clientIp(req)))) return reject(429, "Too Many Requests");
      const url = new URL(req.url ?? "/", "https://panel.invalid");
      if (url.pathname !== "/api/ws") return reject(404, "Not Found");
      if (!hostAllowed(this.cfg, req.headers.host)) return reject(421, "Misdirected Request");
      if (!originAllowed(this.cfg, req.headers.origin)) return reject(403, "Forbidden");
      let rev: string;
      try {
        rev = this.auth.rev();
      } catch {
        return reject(503, "Service Unavailable");
      }
      const session = this.sessions.get(parseCookies(req.headers.cookie).get(COOKIE_NAME), rev, true);
      if (!session) return reject(401, "Unauthorized");
      let perSession = 0;
      for (const c of this.clients) if (c.session.key === session.key) perSession++;
      if (perSession >= MAX_CONN_PER_SESSION || this.clients.size >= MAX_CONN_TOTAL) return reject(429, "Too Many Requests");
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, session));
    } catch {
      reject(400, "Bad Request");
    }
  }

  private attach(ws: WebSocket, session: Session): void {
    const client: Client = { ws, session, subs: new Set(), alive: true, strikes: 0 };
    this.clients.add(client);
    ws.on("pong", () => (client.alive = true));
    ws.on("message", (data, isBinary) => this.onMessage(client, data.toString(), isBinary));
    ws.on("close", () => {
      this.clients.delete(client);
      this.reconcile();
    });
    ws.on("error", () => ws.terminate());
  }

  private onMessage(c: Client, raw: string, isBinary: boolean): void {
    if (!this.sessions.valid(c.session, this.safeRev())) return void c.ws.close(4401, "session ended");
    if (!this.msgLimiter.take(c.session.key)) return this.strike(c, "rate_limited", "Too many messages");
    if (isBinary) return this.strike(c, "bad_request", "Binary frames not accepted");
    let msg: { type?: unknown; channel?: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return this.strike(c, "bad_request", "Malformed JSON");
    }
    // `null` / numbers / strings parse fine but aren't objects; reading `.channel`
    // off `null` used to throw inside the 'message' handler and crash the panel
    // (which, under launchd, also reset every lockout counter).
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return this.strike(c, "bad_request", "Message must be a JSON object");
    if (!validChannel(msg.channel)) return this.strike(c, "bad_request", "Unknown channel");
    if (msg.type === "subscribe") {
      if (!c.subs.has(msg.channel) && c.subs.size >= MAX_SUBS) return this.strike(c, "bad_request", "Too many subscriptions");
      c.subs.add(msg.channel);
      this.reconcile();
      void this.prime(c, msg.channel);
    } else if (msg.type === "unsubscribe") {
      c.subs.delete(msg.channel);
      this.reconcile();
    } else {
      this.strike(c, "bad_request", "Unknown message type");
    }
  }

  private strike(c: Client, error: string, message: string): void {
    this.send(c, { type: "error", error: { error, message } });
    if (++c.strikes >= 10) c.ws.close(1008, "too many bad messages");
  }

  /** Immediate first frame so the UI doesn't wait a full interval. */
  private async prime(c: Client, ch: WsChannel): Promise<void> {
    if (ch === "status") this.send(c, { type: "status", data: await this.status.get() });
    else if (ch === "snapshot") this.send(c, { type: "snapshot", data: this.snapshots() });
    else if (ch.startsWith("job:")) {
      const j = this.jobs().get(ch.slice(4));
      if (j) {
        const { output, ...summary } = j;
        this.send(c, { type: "job_state", job: summary });
        void output;
      }
    }
  }

  private safeRev(): string {
    try {
      return this.auth.rev();
    } catch {
      return "";
    }
  }

  private snapshots() {
    return botProcess(this.cfg).running ? readSnapshots(this.cfg) : [];
  }

  private wanted(ch: WsChannel): boolean {
    for (const c of this.clients) if (c.subs.has(ch)) return true;
    return false;
  }

  /** Start/stop producers to match current subscriptions. */
  private reconcile(): void {
    if (this.wanted("status")) {
      this.statusTimer ??= setInterval(() => {
        void this.status.get().then((s) => this.broadcast("status", { type: "status", data: s }));
      }, 2_000);
    } else if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.wanted("snapshot")) {
      this.snapshotTimer ??= setInterval(() => this.broadcast("snapshot", { type: "snapshot", data: this.snapshots() }), 1_000);
    } else if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.wanted("events")) this.telemetry.start();
    else this.telemetry.stop();
    if (this.wanted("logs:bot")) this.botLog.start();
    else this.botLog.stop();
    if (this.wanted("logs:server")) this.serverLog.start();
    else this.serverLog.stop();
  }

  // ── Producers ─────────────────────────────────────────────────────────

  jobOutput(jobId: string, lines: string[]): void {
    this.broadcast(`job:${jobId}`, { type: "job_output", jobId, lines });
  }

  jobState(job: JobSummary): void {
    this.broadcast(`job:${job.id}`, { type: "job_state", job });
  }

  private queueLog(source: LogSource, lines: string[]): void {
    const buf = this.logBuf[source];
    buf.push(...lines);
    if (buf.length > LOG_LINES_PER_FLUSH) {
      this.logDropped[source] += buf.length - LOG_LINES_PER_FLUSH;
      buf.splice(0, buf.length - LOG_LINES_PER_FLUSH);
    }
  }

  private flushLogs(): void {
    for (const source of ["bot", "server"] as const) {
      const lines = this.logBuf[source];
      if (lines.length === 0) continue;
      const dropped = this.logDropped[source];
      const out = dropped ? [`… ${dropped} line(s) skipped (output too fast)`, ...lines] : lines;
      this.logBuf[source] = [];
      this.logDropped[source] = 0;
      this.broadcast(`logs:${source}`, { type: "log", source, lines: out });
    }
  }

  private broadcast(ch: WsChannel, msg: WsServerMessage): void {
    let payload: string | null = null;
    const rev = this.safeRev();
    for (const c of this.clients) {
      if (!c.subs.has(ch)) continue;
      if (!this.sessions.valid(c.session, rev)) {
        c.ws.close(4401, "session ended");
        continue;
      }
      payload ??= JSON.stringify(msg);
      this.sendRaw(c, payload);
    }
  }

  private send(c: Client, msg: WsServerMessage): void {
    this.sendRaw(c, JSON.stringify(msg));
  }

  private sendRaw(c: Client, payload: string): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount > HARD_BUFFER) return void c.ws.terminate();
    if (c.ws.bufferedAmount > SOFT_BUFFER) return; // drop for slow consumer
    c.ws.send(payload);
  }

  private heartbeat(): void {
    const rev = this.safeRev();
    for (const c of this.clients) {
      if (!c.alive || !this.sessions.valid(c.session, rev)) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  closeAll(): void {
    for (const c of this.clients) c.ws.close(1001, "panel shutting down");
    for (const t of this.timers) clearInterval(t);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.telemetry.stop();
    this.botLog.stop();
    this.serverLog.stop();
  }
}
