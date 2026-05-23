/**
 * Ring-buffer logger. Monkey-patches `console.log/info/warn/error` so every
 * line the orchestrator writes to stdout/stderr also lands in a fixed-size
 * in-memory buffer. The dashboard's log pane (phase 3) reads from this
 * buffer; the original console output keeps flowing for non-dashboard runs
 * and for redirected logs (e.g. `npm run dev | tee`).
 *
 * Scope (MVP per ROADMAP "stdout capture" risk):
 *  - Captures everything routed through the four console methods, including
 *    mineflayer's own warnings.
 *  - Does NOT capture stdout/stderr from the Claude Agent SDK subprocess —
 *    those go straight to the terminal. That's the documented MVP gap.
 *
 * Install exactly once, before anything else logs. `index.ts` calls
 * {@link installLogBuffer} as its very first line.
 */

import util from "node:util";

export type LogLevel = "log" | "info" | "warn" | "error";

export interface LogEntry {
  at: number;
  level: LogLevel;
  text: string;
}

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];
let installed = false;

export function installLogBuffer(): void {
  if (installed) return;
  installed = true;

  const original: Record<LogLevel, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  for (const level of ["log", "info", "warn", "error"] as const) {
    console[level] = (...args: unknown[]): void => {
      pushEntry(level, util.format(...args));
      original[level](...args);
    };
  }
}

function pushEntry(level: LogLevel, text: string): void {
  buffer.push({ at: Date.now(), level, text });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

/**
 * Snapshot of recent entries (oldest → newest). Returns a copy so the caller
 * can sort / filter without mutating the buffer.
 */
export function getRecentLogs(limit = MAX_ENTRIES): LogEntry[] {
  if (limit >= buffer.length) return buffer.slice();
  return buffer.slice(-limit);
}

/** Test helper — wipe the buffer (does NOT un-patch console). */
export function _resetLogBuffer(): void {
  buffer.length = 0;
}
