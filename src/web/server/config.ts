/**
 * Panel configuration. Everything is resolved from the repo root (derived from
 * this file's location, not process.cwd(), so launchd's working directory
 * can't redirect file access) plus a small set of PANEL_* env overrides.
 *
 * Secrets never live here: the admin password hash + TOTP secret are in
 * `secretsFile` (mode 600), and DUCKDNS_TOKEN is read from `.env` only by the
 * TLS / DNS code paths that need it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface PanelConfig {
  dev: boolean;
  version: string;
  port: number;
  bind: string;
  /** Public hostname the cert is issued for and the only Host/Origin accepted (plus extras). */
  hostname: string;
  /** Accepted `Host` header values (lowercase, with port where relevant). */
  allowedHosts: Set<string>;
  /** Accepted `Origin` header values (exact match). */
  allowedOrigins: Set<string>;
  dataDir: string;
  secretsFile: string;
  auditFile: string;
  tlsDir: string;
  pidFile: string;
  uiDir: string;
  runtimeDir: string;
  botPidFile: string;
  botLogFile: string;
  snapshotFile: string;
  telemetryDir: string;
  backupsDir: string;
  mcDataDir: string;
  scriptsDir: string;
  acme: { staging: boolean; email: string | null; enabled: boolean };
  /** Panel updates the DuckDNS A record itself so it stays reachable while the compose sidecar is stopped. */
  duckdnsUpdater: boolean;
}

/** Minimal .env parser (KEY=VALUE, # comments, optional quotes). Values are never logged. */
export function readDotEnv(): Record<string, string> {
  const path = resolve(REPO_ROOT, ".env");
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function intEnv(name: string, fallback: number): number {
  // Process env wins; `.env` lets launchd-started panels pick up e.g. PANEL_PORT.
  const v = process.env[name] ?? readDotEnv()[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number`);
  return n;
}

export function loadConfig(argv: string[]): PanelConfig {
  const dev = argv.includes("--dev") || process.env.PANEL_DEV === "1";
  const env = readDotEnv();
  const port = intEnv("PANEL_PORT", 8443);
  const bind = process.env.PANEL_BIND || (dev ? "127.0.0.1" : "0.0.0.0");
  if (dev && bind !== "127.0.0.1" && bind !== "::1") {
    throw new Error("--dev mode uses a self-signed cert and must bind to loopback (127.0.0.1 / ::1)");
  }

  const sub = env.DUCKDNS_SUBDOMAIN?.split(",")[0]?.trim();
  const hostname = (
    process.env.PANEL_HOSTNAME || (dev ? "localhost" : sub ? `${sub}.duckdns.org` : "minecraft-with-friends.duckdns.org")
  ).toLowerCase();

  const hostNames = [hostname];
  if (dev) hostNames.push("localhost", "127.0.0.1");
  for (const extra of (process.env.PANEL_EXTRA_HOSTS ?? "").split(",")) {
    const h = extra.trim().toLowerCase();
    if (h) hostNames.push(h);
  }
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set<string>();
  for (const h of hostNames) {
    // Router forwards external 443 → `port`, so the browser sees no port; LAN
    // access straight to `port` shows it explicitly.
    allowedHosts.add(h);
    allowedHosts.add(`${h}:443`);
    allowedHosts.add(`${h}:${port}`);
    allowedOrigins.add(`https://${h}`);
    allowedOrigins.add(`https://${h}:${port}`);
  }

  const dataDir = resolve(process.env.PANEL_DATA_DIR || resolve(REPO_ROOT, "data/panel"));
  const runtimeDir = resolve(REPO_ROOT, ".bot-runtime");
  let version = "0.0.0";
  try {
    version = (JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? version;
  } catch {
    /* ignore */
  }

  return {
    dev,
    version,
    port,
    bind,
    hostname,
    allowedHosts,
    allowedOrigins,
    dataDir,
    secretsFile: resolve(process.env.PANEL_SECRETS_FILE || resolve(dataDir, "secrets.json")),
    auditFile: resolve(dataDir, "audit.jsonl"),
    tlsDir: resolve(dataDir, dev ? "tls-dev" : "tls"),
    pidFile: resolve(dataDir, dev ? "panel-dev.pid" : "panel.pid"),
    uiDir: resolve(process.env.PANEL_UI_DIR || resolve(REPO_ROOT, "src/web/ui/dist")),
    runtimeDir,
    botPidFile: resolve(runtimeDir, "bot.pid"),
    botLogFile: resolve(runtimeDir, "bot.log"),
    snapshotFile: resolve(runtimeDir, "snapshot.json"),
    telemetryDir: resolve(REPO_ROOT, "data/orchestrator/telemetry"),
    backupsDir: resolve(REPO_ROOT, "backups"),
    mcDataDir: resolve(REPO_ROOT, "data"),
    scriptsDir: resolve(REPO_ROOT, "scripts"),
    acme: {
      enabled: !dev && process.env.PANEL_ACME !== "0",
      staging: process.env.PANEL_ACME_STAGING === "1",
      email: process.env.PANEL_ACME_EMAIL || null,
    },
    duckdnsUpdater: !dev && process.env.PANEL_DUCKDNS_UPDATE !== "0",
  };
}
