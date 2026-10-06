/**
 * Tiny synchronous JSON persistence for per-bot state stores (task queue,
 * actions log). Files live next to `world.json` under
 * `data/orchestrator/memory/<username>/` so everything durable about a bot
 * is in one directory and survives orchestrator restarts.
 *
 * Synchronous on purpose: the payloads are a few KB, writes happen at most
 * once per skill call, and sync write-temp-then-rename keeps the "what's on
 * disk is the latest state" guarantee trivially crash-safe without any
 * debounce bookkeeping.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const BASE_DIR = "data/orchestrator/memory";

export function memoryFileFor(username: string, file: string): string {
  return resolve(process.cwd(), BASE_DIR, username, file);
}

/** Returns null when the file is missing or unreadable — callers start empty. */
export function loadJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[state] couldn't load ${path}; starting empty:`, err);
    }
    return null;
  }
}

export function saveJsonAtomic(path: string, data: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    // Persistence is best-effort — never take down a skill over a disk hiccup.
    console.warn(`[state] couldn't write ${path}:`, err);
  }
}
