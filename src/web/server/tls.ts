/**
 * TLS material.
 *
 *  - --dev: a self-signed cert for localhost/127.0.0.1, generated once with the
 *    system `openssl` (argv, no shell) into data/panel/tls-dev/.
 *  - prod: a Let's Encrypt certificate for the DuckDNS hostname via ACME
 *    DNS-01, publishing the TXT record through DuckDNS's update API with
 *    DUCKDNS_TOKEN from .env (so only the HTTPS port needs forwarding).
 *    Checked every 12h; renewed when < 30 days remain; hot-swapped into the
 *    running server with setSecureContext. Until the first cert lands the
 *    panel serves a temporary self-signed cert (browser warning, still TLS).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import * as acme from "acme-client";

import { readDotEnv, type PanelConfig } from "./config.js";
import { run } from "./exec.js";

const RENEW_BEFORE_MS = 30 * 24 * 60 * 60_000;
const CHECK_EVERY_MS = 12 * 60 * 60_000;
const RETRY_AFTER_FAIL_MS = 60 * 60_000;
const DNS_PROPAGATION_WAIT_MS = 30_000;
/** acme-client's HTTP layer has no overall timeout; a hung attempt must not stall renewal forever. */
const ACME_ATTEMPT_TIMEOUT_MS = 15 * 60_000;

export interface TlsMaterial {
  key: string;
  cert: string;
}

function writePrivate(path: string, data: string | Buffer): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export async function selfSigned(dir: string, cn: string, names: string[]): Promise<TlsMaterial> {
  ensureDir(dir);
  const keyPath = resolve(dir, "selfsigned.key");
  const certPath = resolve(dir, "selfsigned.crt");
  if (existsSync(keyPath) && existsSync(certPath)) {
    const cert = readFileSync(certPath, "utf8");
    if (new X509Certificate(cert).validToDate.getTime() - Date.now() > 7 * 24 * 60 * 60_000) {
      return { key: readFileSync(keyPath, "utf8"), cert };
    }
  }
  const san = names.map((n) => (/^[\d.]+$/.test(n) ? `IP:${n}` : `DNS:${n}`)).join(",");
  const r = await run(
    ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "365", "-subj", `/CN=${cn}`, "-addext", `subjectAltName=${san}`],
    30_000,
  );
  if (r.code !== 0) throw new Error(`openssl failed to create a self-signed cert: ${r.stderr.slice(0, 200)}`);
  chmodSync(keyPath, 0o600);
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}

// ── ACME / DuckDNS ──────────────────────────────────────────────────────

function duckdnsCreds(cfg: PanelConfig): { sub: string; token: string } {
  const env = readDotEnv();
  const token = env.DUCKDNS_TOKEN;
  const suffix = ".duckdns.org";
  if (!cfg.hostname.endsWith(suffix)) throw new Error("ACME DNS-01 via DuckDNS requires a *.duckdns.org PANEL_HOSTNAME");
  const sub = cfg.hostname.slice(0, -suffix.length);
  if (!token || !/^[A-Za-z0-9-]{20,64}$/.test(token)) throw new Error("DUCKDNS_TOKEN missing or malformed in .env");
  if (!/^[a-z0-9-]{1,63}$/.test(sub)) throw new Error("unexpected DuckDNS subdomain");
  return { sub, token };
}

async function duckdnsRequest(params: Record<string, string>): Promise<void> {
  const url = new URL("https://www.duckdns.org/update");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = (await res.text()).trim();
  if (!res.ok || !body.startsWith("OK")) throw new Error(`DuckDNS update failed (HTTP ${res.status}: ${body.slice(0, 20)})`);
}

/** Keep the A record current from the panel itself (the compose sidecar stops with `docker compose stop`). */
export function startDuckdnsUpdater(cfg: PanelConfig): () => void {
  const tick = async (): Promise<void> => {
    try {
      const { sub, token } = duckdnsCreds(cfg);
      await duckdnsRequest({ domains: sub, token, ip: "" });
    } catch (err) {
      console.error("panel: DuckDNS IP update failed:", (err as Error).message);
    }
  };
  void tick();
  const t = setInterval(() => void tick(), 5 * 60_000);
  return () => clearInterval(t);
}

function certExpiry(certPem: string): number {
  return new X509Certificate(certPem).validToDate.getTime();
}

function loadExisting(dir: string, hostname: string): TlsMaterial | null {
  const keyPath = resolve(dir, "cert.key");
  const certPath = resolve(dir, "cert.pem");
  if (!existsSync(keyPath) || !existsSync(certPath)) return null;
  try {
    const cert = readFileSync(certPath, "utf8");
    const x = new X509Certificate(cert);
    if (!x.checkHost(hostname) || x.validToDate.getTime() <= Date.now()) return null;
    return { key: readFileSync(keyPath, "utf8"), cert };
  } catch {
    return null;
  }
}

async function obtain(cfg: PanelConfig): Promise<TlsMaterial> {
  const { sub, token } = duckdnsCreds(cfg);
  ensureDir(cfg.tlsDir);
  const accountKeyPath = resolve(cfg.tlsDir, cfg.acme.staging ? "account-staging.key" : "account.key");
  let accountKey: Buffer;
  if (existsSync(accountKeyPath)) accountKey = readFileSync(accountKeyPath);
  else {
    accountKey = await acme.crypto.createPrivateEcdsaKey();
    writePrivate(accountKeyPath, accountKey);
  }
  const client = new acme.Client({
    directoryUrl: cfg.acme.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
    accountKey,
  });
  const [key, csr] = await acme.crypto.createCsr({ commonName: cfg.hostname, altNames: [cfg.hostname] }, await acme.crypto.createPrivateEcdsaKey());
  const cert = await client.auto({
    csr,
    ...(cfg.acme.email ? { email: cfg.acme.email } : {}),
    termsOfServiceAgreed: true,
    challengePriority: ["dns-01"],
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      if (challenge.type !== "dns-01") throw new Error("only dns-01 is supported");
      await duckdnsRequest({ domains: sub, token, txt: keyAuthorization, verbose: "true" });
      await sleep(DNS_PROPAGATION_WAIT_MS);
    },
    challengeRemoveFn: async () => {
      await duckdnsRequest({ domains: sub, token, txt: "removed", clear: "true" }).catch(() => undefined);
    },
  });
  if (cfg.acme.staging) {
    console.log("panel: obtained a STAGING certificate (not browser-trusted); not installing it");
    return loadExisting(cfg.tlsDir, cfg.hostname) ?? (await selfSigned(cfg.tlsDir, cfg.hostname, [cfg.hostname]));
  }
  writePrivate(resolve(cfg.tlsDir, "cert.key"), key);
  writePrivate(resolve(cfg.tlsDir, "cert.pem"), cert);
  return { key: key.toString(), cert };
}

/**
 * Returns the material to start with, and (prod) schedules issuance/renewal,
 * calling `apply` with new material when a cert is obtained.
 */
export async function initTls(cfg: PanelConfig, apply: (m: TlsMaterial) => void): Promise<{ initial: TlsMaterial; stop: () => void }> {
  if (cfg.dev) {
    return { initial: await selfSigned(cfg.tlsDir, "localhost", ["localhost", "127.0.0.1"]), stop: () => undefined };
  }
  const existing = loadExisting(cfg.tlsDir, cfg.hostname);
  const initial = existing ?? (await selfSigned(cfg.tlsDir, cfg.hostname, [cfg.hostname]));
  if (!cfg.acme.enabled) return { initial, stop: () => undefined };

  let current = existing;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const check = async (): Promise<void> => {
    let next = CHECK_EVERY_MS;
    try {
      if (!current || certExpiry(current.cert) - Date.now() < RENEW_BEFORE_MS) {
        console.log(`panel: requesting certificate for ${cfg.hostname} (${cfg.acme.staging ? "staging" : "production"})`);
        let timeout: NodeJS.Timeout | undefined;
        const m = await Promise.race([
          obtain(cfg),
          new Promise<never>((_, rej) => {
            timeout = setTimeout(() => rej(new Error("ACME attempt timed out")), ACME_ATTEMPT_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timeout));
        if (!cfg.acme.staging) {
          current = m;
          apply(m);
          console.log(`panel: certificate installed, expires ${new Date(certExpiry(m.cert)).toISOString()}`);
        }
      }
    } catch (err) {
      // Any failure (including a throw outside obtain) must still reschedule, or renewal silently stops.
      console.error("panel: ACME failed:", (err as Error).message);
      next = RETRY_AFTER_FAIL_MS;
    }
    if (!stopped) timer = setTimeout(() => void check(), next);
  };
  void check();
  return {
    initial,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
