/**
 * Server-side sessions. The cookie carries a random 256-bit id; the store is
 * keyed by SHA-256(id) so lookups never compare raw secrets and a heap dump
 * doesn't yield usable cookies. In memory only: a panel restart logs everyone
 * out, which is the safe default.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "__Host-mcpanel";
export const IDLE_MS = 12 * 60 * 60_000;
export const ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
const MAX_SESSIONS = 20;

export interface Session {
  key: string; // sha256(id) hex
  user: string;
  csrf: string;
  createdAt: number;
  lastSeen: number;
  ip: string;
  secretsRev: string;
}

const ID_RE = /^[A-Za-z0-9_-]{43}$/;

function keyOf(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export class SessionStore {
  private byKey = new Map<string, Session>();
  private listeners = new Set<(keys: string[]) => void>();

  /** Called with revoked session keys (used to close WebSockets). */
  onRevoke(fn: (keys: string[]) => void): void {
    this.listeners.add(fn);
  }

  create(user: string, ip: string, secretsRev: string, now = Date.now()): { id: string; session: Session } {
    this.sweep(now);
    if (this.byKey.size >= MAX_SESSIONS) {
      // Evict the least-recently-used session rather than refuse the owner.
      const oldest = [...this.byKey.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) this.revoke(oldest.key);
    }
    const id = randomBytes(32).toString("base64url");
    const session: Session = {
      key: keyOf(id),
      user,
      csrf: randomBytes(32).toString("base64url"),
      createdAt: now,
      lastSeen: now,
      ip,
      secretsRev,
    };
    this.byKey.set(session.key, session);
    return { id, session };
  }

  /** Validates expiry; touches lastSeen when `touch`. */
  get(id: string | undefined, currentRev: string, touch: boolean, now = Date.now()): Session | null {
    if (!id || !ID_RE.test(id)) return null;
    const s = this.byKey.get(keyOf(id));
    if (!s) return null;
    if (!this.valid(s, currentRev, now)) {
      this.revoke(s.key);
      return null;
    }
    if (touch) s.lastSeen = now;
    return s;
  }

  valid(s: Session, currentRev: string, now = Date.now()): boolean {
    return (
      this.byKey.get(s.key) === s &&
      now - s.lastSeen <= IDLE_MS &&
      now - s.createdAt <= ABSOLUTE_MS &&
      s.secretsRev === currentRev
    );
  }

  expiresAt(s: Session): number {
    return Math.min(s.lastSeen + IDLE_MS, s.createdAt + ABSOLUTE_MS);
  }

  revoke(key: string): void {
    if (this.byKey.delete(key)) for (const l of this.listeners) l([key]);
  }

  revokeAll(): number {
    const keys = [...this.byKey.keys()];
    this.byKey.clear();
    if (keys.length) for (const l of this.listeners) l(keys);
    return keys.length;
  }

  sweep(now = Date.now()): void {
    for (const s of [...this.byKey.values()]) {
      if (now - s.lastSeen > IDLE_MS || now - s.createdAt > ABSOLUTE_MS) this.revoke(s.key);
    }
  }
}

export function csrfOk(s: Session, header: string | string[] | undefined): boolean {
  if (typeof header !== "string") return false;
  const a = Buffer.from(header);
  const b = Buffer.from(s.csrf);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header || header.length > 8192) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (!out.has(k)) out.set(k, part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookie(id: string): string {
  return `${COOKIE_NAME}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ABSOLUTE_MS / 1000)}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
