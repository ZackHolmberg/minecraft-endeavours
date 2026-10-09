/**
 * Append-only JSONL audit log (`data/panel/audit.jsonl`, mode 600). One line
 * per auth event, action, console command and player change. Size-rotated to
 * `audit.1.jsonl` at 20 MB so a flood can't fill the disk; noisy rejection
 * events (lockout hits) are coalesced per IP by the caller.
 */
import { appendFileSync, closeSync, existsSync, openSync, readSync, renameSync, statSync } from "node:fs";

import type { AuditEntry } from "../shared/api.js";

const ROTATE_BYTES = 20 * 1024 * 1024;
const TAIL_READ_BYTES = 512 * 1024;
const DETAIL_MAX = 300;

let auditPath = "";

export function initAudit(path: string): void {
  auditPath = path;
}

/** Strip control chars and clip, so attacker-supplied text can't forge lines or blow up entries. */
export function clean(s: string, max = DETAIL_MAX): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function audit(e: Omit<AuditEntry, "at">): void {
  const entry: AuditEntry = { at: Date.now(), ip: clean(e.ip, 64), user: e.user, kind: e.kind, detail: clean(e.detail), ok: e.ok };
  try {
    if (existsSync(auditPath) && statSync(auditPath).size > ROTATE_BYTES) {
      renameSync(auditPath, auditPath.replace(/\.jsonl$/, ".1.jsonl"));
    }
    appendFileSync(auditPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch (err) {
    console.error("panel: audit write failed:", (err as Error).message);
  }
}

/** Newest first. Reads only the tail of the file. */
export function readAudit(limit: number): AuditEntry[] {
  if (!existsSync(auditPath)) return [];
  const size = statSync(auditPath).size;
  const start = Math.max(0, size - TAIL_READ_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(auditPath, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // partial first line
  const out: AuditEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lines[i];
    if (!l) continue;
    try {
      out.push(JSON.parse(l) as AuditEntry);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}
