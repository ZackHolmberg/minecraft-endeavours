/**
 * Web control panel entry point: `npm run panel` (prod, ACME cert, binds
 * PANEL_BIND or 0.0.0.0:8443) or `npm run panel -- --dev` (self-signed,
 * 127.0.0.1 only). HTTPS only — there is no plain-HTTP listener.
 *
 * Env overrides: PANEL_PORT, PANEL_BIND, PANEL_HOSTNAME, PANEL_EXTRA_HOSTS,
 * PANEL_DATA_DIR, PANEL_SECRETS_FILE, PANEL_UI_DIR, PANEL_ACME=0,
 * PANEL_ACME_STAGING=1, PANEL_ACME_EMAIL, PANEL_DUCKDNS_UPDATE=0.
 * --dev only (tests): PANEL_REPO_ROOT (relocate every repo path), PANEL_MC_PORT.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";

import { audit, initAudit } from "./audit.js";
import { Auth } from "./auth.js";
import { loadConfig } from "./config.js";
import { PanelApp } from "./app.js";
import { JobManager } from "./jobs.js";
import { SessionStore } from "./sessions.js";
import { StatusService } from "./status.js";
import { ipBucket } from "./http-util.js";
import { initTls, startDuckdnsUpdater } from "./tls.js";
import { WsHub } from "./ws.js";

/** Browsers open ~6 connections per origin plus a few WebSockets; leave headroom. */
const MAX_CONN_PER_IP = 32;

async function main(): Promise<void> {
  const cfg = loadConfig(process.argv.slice(2));
  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(cfg.dataDir, 0o700);
  initAudit(cfg.auditFile);

  const sessions = new SessionStore();
  const auth = new Auth(cfg, sessions);
  try {
    auth.current();
  } catch (err) {
    console.error(`panel: ${(err as Error).message}`);
    process.exit(78); // EX_CONFIG
  }

  // Refuse to double-start on the same pid file.
  if (existsSync(cfg.pidFile)) {
    const pid = Number(readFileSync(cfg.pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        console.error(`panel: already running (PID ${pid})`);
        process.exit(1);
      } catch {
        /* stale */
      }
    }
  }

  // Late-bound so the hub and job manager can reference each other.
  let hub: WsHub | null = null;
  let status: StatusService | null = null;
  const jobs = new JobManager(
    cfg,
    { output: (id, lines) => hub?.jobOutput(id, lines), state: (j) => hub?.jobState(j) },
    (job) => {
      if (job.action === "world.new") {
        audit({ ip: "local", user: job.startedBy, kind: "action", detail: `world.new job ${job.id} ${job.state} (exit ${job.exitCode ?? "none"})`, ok: job.state === "succeeded" });
      }
      void status?.get(0).catch(() => undefined);
    },
  );
  status = new StatusService(cfg, () => jobs.active());
  const app = new PanelApp(cfg, auth, sessions, status, jobs);
  hub = new WsHub(cfg, sessions, auth, status, () => jobs, app.ipLimiter);

  let server: ReturnType<typeof createServer> | null = null;
  const tls = await initTls(cfg, (m) => server?.setSecureContext({ key: m.key, cert: m.cert }));
  server = createServer(
    {
      key: tls.initial.key,
      cert: tls.initial.cert,
      minVersion: "TLSv1.2",
      honorCipherOrder: true,
      // Default is 120s: idle never-handshaking sockets would hold maxConnections slots for 2 minutes each.
      handshakeTimeout: 10_000,
      requestTimeout: 30_000,
      headersTimeout: 15_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 16 * 1024,
    },
    app.handle,
  );
  server.on("upgrade", (req, socket, head) => hub!.handleUpgrade(req, socket, head));
  server.on("clientError", (_err, socket) => socket.destroy());
  server.on("tlsClientError", () => undefined);
  server.maxConnections = 200;
  // Per-source cap so a single address (or IPv6 /64) can't take every slot of
  // maxConnections with idle sockets and lock the owner out. Counted on the raw
  // TCP socket, before TLS.
  const perIp = new Map<string, number>();
  server.on("connection", (sock: import("node:net").Socket) => {
    const a = sock.remoteAddress ?? "unknown";
    const key = ipBucket(a.startsWith("::ffff:") ? a.slice(7) : a);
    const n = (perIp.get(key) ?? 0) + 1;
    if (n > MAX_CONN_PER_IP) return void sock.destroy();
    perIp.set(key, n);
    sock.once("close", () => {
      const left = (perIp.get(key) ?? 1) - 1;
      if (left <= 0) perIp.delete(key);
      else perIp.set(key, left);
    });
  });

  const stopDuck = cfg.duckdnsUpdater ? startDuckdnsUpdater(cfg) : () => undefined;
  const sweep = setInterval(() => sessions.sweep(), 60_000);

  server.listen(cfg.port, cfg.bind, () => {
    writeFileSync(cfg.pidFile, String(process.pid), { mode: 0o600 });
    console.log(`panel: listening on https://${cfg.bind}:${cfg.port} (${cfg.dev ? "dev, self-signed" : `host ${cfg.hostname}`})`);
    audit({ ip: "local", user: null, kind: "session_revoked", detail: `panel started (v${cfg.version}${cfg.dev ? ", dev" : ""}); all prior sessions invalid`, ok: true });
  });
  server.on("error", (err) => {
    console.error(`panel: server error: ${err.message}`);
    process.exit(1);
  });

  let stopping = false;
  const shutdown = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`panel: ${sig} — shutting down`);
    clearInterval(sweep);
    stopDuck();
    tls.stop();
    hub?.closeAll();
    server?.close();
    server?.closeAllConnections();
    try {
      if (existsSync(cfg.pidFile) && readFileSync(cfg.pidFile, "utf8").trim() === String(process.pid)) rmSync(cfg.pidFile);
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // Keep running on stray async errors; launchd restarts us on real crashes.
  process.on("unhandledRejection", (err) => console.error("panel: unhandled rejection:", (err as Error)?.message ?? err));
}

void main();
