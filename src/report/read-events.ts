/**
 * Direct JSONL reader for the report CLI. Reads
 * `<dir>/<bot>/events.1.jsonl` (rotated, older) then `events.jsonl` (live),
 * skipping blank / corrupt / half-written lines, so it works whether or not
 * the orchestrator is running.
 *
 * Deliberately independent of `observability/telemetry.ts`'s `readEvents` so
 * the data dir can be pointed elsewhere (`--dir` / `BOT_TELEMETRY_DIR`) for
 * testing against synthetic data without touching the writer's module state.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { TelemetryEvent } from "../observability/telemetry-types.js";

export const DEFAULT_TELEMETRY_DIR = "data/orchestrator/telemetry";
export const TELEMETRY_DIR_ENV = "BOT_TELEMETRY_DIR";

/** Older first, so concatenation is chronological. */
const FILES = ["events.1.jsonl", "events.jsonl"];

export function resolveTelemetryDir(override?: string | null): string {
  const raw = override ?? process.env[TELEMETRY_DIR_ENV] ?? DEFAULT_TELEMETRY_DIR;
  return resolve(process.cwd(), raw);
}

/** Bot usernames that have a telemetry directory. */
export function listTelemetryBots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export interface ReadResult {
  events: TelemetryEvent[];
  files: string[];
  skippedLines: number;
}

export function readBotEvents(dir: string, bot: string): ReadResult {
  const events: TelemetryEvent[] = [];
  const files: string[] = [];
  let skippedLines = 0;
  for (const name of FILES) {
    const path = join(dir, bot, name);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    files.push(path);
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const ev = JSON.parse(line) as TelemetryEvent;
        if (ev && typeof ev.at === "number" && typeof ev.kind === "string") events.push(ev);
        else skippedLines++;
      } catch {
        skippedLines++;
      }
    }
  }
  // Rotation boundaries and concurrent writers can interleave slightly.
  events.sort((a, b) => a.at - b.at);
  return { events, files, skippedLines };
}
