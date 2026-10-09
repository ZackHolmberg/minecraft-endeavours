/**
 * Login: password (scrypt) AND TOTP, both checked on every attempt so timing
 * doesn't reveal which factor failed; the client only ever sees a generic
 * 401. Per-IP exponential lockout + a global slowdown; scrypt runs
 * serialized behind a bounded queue. Accepted TOTP steps can't be replayed.
 */
import { statSync } from "node:fs";

import { audit } from "./audit.js";
import type { PanelConfig } from "./config.js";
import { HttpError, ipBucket } from "./http-util.js";
import { LOGIN_POLICY, LoginGuard, Mutex } from "./ratelimit.js";
import { readSecrets, verifyPassword, verifyTotp, type PanelSecrets } from "./secrets.js";
import type { Session, SessionStore } from "./sessions.js";

const SECRETS_RECHECK_MS = 5_000;
const LOCKOUT_AUDIT_EVERY_MS = 60_000;

export class Auth {
  private secrets: PanelSecrets | null = null;
  private secretsMtime = 0;
  private lastCheck = 0;
  private lastTotpStep = -1;
  readonly guard = new LoginGuard();
  private scryptQueue = new Mutex(4);
  private lockoutAudited = new Map<string, number>();

  constructor(
    private readonly cfg: PanelConfig,
    private readonly sessions: SessionStore,
  ) {}

  /** Throws if secrets are missing/malformed. Reloads when the file changes; a new rev revokes all sessions. */
  current(): PanelSecrets {
    const now = Date.now();
    if (this.secrets && now - this.lastCheck < SECRETS_RECHECK_MS) return this.secrets;
    this.lastCheck = now;
    const mtime = statSync(this.cfg.secretsFile).mtimeMs;
    if (!this.secrets || mtime !== this.secretsMtime) {
      const next = readSecrets(this.cfg.secretsFile);
      if (this.secrets && next.rev !== this.secrets.rev) {
        const n = this.sessions.revokeAll();
        this.lastTotpStep = -1;
        if (n) audit({ ip: "local", user: null, kind: "session_revoked", detail: `credentials changed; revoked ${n} session(s)`, ok: true });
      }
      this.secrets = next;
      this.secretsMtime = mtime;
    }
    return this.secrets;
  }

  rev(): string {
    return this.current().rev;
  }

  async login(ip: string, body: Record<string, unknown>): Promise<{ id: string; session: Session }> {
    // Lockout state is keyed per IPv4 address / IPv6 /64; the audit keeps the full address.
    const bucket = ipBucket(ip);
    const wait = this.guard.retryAfter(bucket);
    if (wait > 0) {
      const last = this.lockoutAudited.get(bucket) ?? 0;
      if (Date.now() - last > LOCKOUT_AUDIT_EVERY_MS) {
        this.lockoutAudited.set(bucket, Date.now());
        if (this.lockoutAudited.size > 10_000) this.lockoutAudited.clear();
        audit({ ip, user: null, kind: "lockout", detail: `login refused while ${this.guard.isSlowdown() ? "global slowdown / " : ""}locked out (${Math.ceil(wait / 1000)}s left)`, ok: false });
      }
      throw new HttpError(429, "rate_limited", "Too many failed attempts. Try again later.", { "Retry-After": String(Math.ceil(wait / 1000)) });
    }
    // During the global slowdown this claims the one-per-interval slot before any work.
    this.guard.admit(bucket);

    const password = body.password;
    const totp = body.totp;
    if (typeof password !== "string" || typeof totp !== "string" || password.length === 0 || password.length > 1024 || totp.length > 16) {
      this.fail(ip, "malformed request");
      throw new HttpError(401, "unauthorized", "Invalid password or code");
    }

    let secrets: PanelSecrets;
    try {
      secrets = this.current();
    } catch {
      throw new HttpError(503, "not_configured", "Panel credentials are not configured. Run ./scripts/panelSetup.sh on the host.");
    }

    const result = await this.scryptQueue.run(async () => {
      const pwOk = await verifyPassword(password, secrets.password);
      const step = verifyTotp(secrets.totp.secret, totp.replace(/\s+/g, ""));
      return { pwOk, step };
    });
    if (result === Mutex.FULL) throw new HttpError(429, "rate_limited", "Too many login attempts in progress. Try again shortly.", { "Retry-After": "5" });

    const { pwOk, step } = result;
    const replay = step !== null && step <= this.lastTotpStep;
    if (!pwOk || step === null || replay) {
      // Audit says which factor failed (useful signal that the password leaked); the client never learns it.
      this.fail(ip, !pwOk ? "bad password" : step === null ? "password ok, bad TOTP" : "password ok, replayed TOTP");
      throw new HttpError(401, "unauthorized", "Invalid password or code");
    }

    this.lastTotpStep = step;
    this.guard.succeed(bucket);
    const created = this.sessions.create(secrets.user, ip, secrets.rev);
    audit({ ip, user: secrets.user, kind: "login_ok", detail: "password + TOTP", ok: true });
    return created;
  }

  private fail(ip: string, why: string): void {
    const { ipLockMs, slowdownStarted } = this.guard.fail(ipBucket(ip));
    audit({ ip, user: null, kind: "login_fail", detail: why, ok: false });
    if (ipLockMs) audit({ ip, user: null, kind: "lockout", detail: `ip locked for ${Math.round(ipLockMs / 1000)}s`, ok: false });
    if (slowdownStarted) audit({ ip, user: null, kind: "lockout", detail: `GLOBAL login slowdown started (1 attempt / ${LOGIN_POLICY.globalSlowdownIntervalMs / 1000}s for IPs without a prior login)`, ok: false });
  }
}
