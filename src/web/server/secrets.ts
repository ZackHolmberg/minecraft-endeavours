/**
 * Admin credentials: scrypt password hash + TOTP (RFC 6238) secret, stored in
 * one JSON file with mode 600 inside a mode-700 directory. Written only by
 * `scripts/panelSetup.sh` (→ setup.ts); read by the panel.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";

export interface ScryptHash {
  algo: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string; // base64
  hash: string; // base64
}

export interface PanelSecrets {
  version: 1;
  /** Random per-write id; a change revokes all live sessions. */
  rev: string;
  user: string;
  password: ScryptHash;
  totp: { secret: string; digits: 6; period: 30; algorithm: "SHA1" };
  createdAt: number;
}

// ── Password (scrypt) ───────────────────────────────────────────────────

const SCRYPT_N = 1 << 16; // 64 MiB with r=8
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

function scryptAsync(pw: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    scrypt(pw.normalize("NFKC"), salt, KEYLEN, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? rej(err) : res(key),
    );
  });
}

export async function hashPassword(pw: string): Promise<ScryptHash> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return { algo: "scrypt", N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString("base64"), hash: key.toString("base64") };
}

export async function verifyPassword(pw: string, h: ScryptHash): Promise<boolean> {
  const expected = Buffer.from(h.hash, "base64");
  const key = await scryptAsync(pw, Buffer.from(h.salt, "base64"), h.N, h.r, h.p);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ── TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30s) ───────────────────────────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret: Buffer, step: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const off = mac[mac.length - 1]! & 0xf;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function currentStep(now = Date.now(), period = 30): number {
  return Math.floor(now / 1000 / period);
}

/**
 * Returns the matched time step (±1 window) or null. Compares every candidate
 * in constant time and doesn't short-circuit, so timing doesn't reveal which
 * step matched.
 */
export function verifyTotp(secretB32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const step = currentStep(now);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (const s of [step - 1, step, step + 1]) {
    const ok = timingSafeEqual(Buffer.from(totpAt(secret, s)), given);
    if (ok && matched === null) matched = s;
  }
  return matched;
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ── File I/O ────────────────────────────────────────────────────────────

export function writeSecrets(path: string, s: PanelSecrets): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Load + validate; tightens permissions if they drifted; throws on anything odd. */
export function readSecrets(path: string): PanelSecrets {
  if (!existsSync(path)) throw new Error("panel secrets file missing — run ./scripts/panelSetup.sh");
  const st = statSync(path);
  if (!st.isFile()) throw new Error("panel secrets path is not a regular file");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error("panel secrets file is not owned by the panel user");
  }
  if ((st.mode & 0o077) !== 0) chmodSync(path, 0o600);
  const s = JSON.parse(readFileSync(path, "utf8")) as PanelSecrets;
  if (
    s?.version !== 1 ||
    typeof s.rev !== "string" ||
    typeof s.user !== "string" ||
    s.password?.algo !== "scrypt" ||
    typeof s.password.salt !== "string" ||
    typeof s.password.hash !== "string" ||
    ![s.password.N, s.password.r, s.password.p].every((n) => Number.isInteger(n) && n > 0) ||
    s.password.N > 1 << 20 ||
    typeof s.totp?.secret !== "string" ||
    base32Decode(s.totp.secret).length < 16
  ) {
    throw new Error("panel secrets file is malformed — re-run ./scripts/panelSetup.sh");
  }
  return s;
}

export function newRev(): string {
  return randomBytes(12).toString("hex");
}
