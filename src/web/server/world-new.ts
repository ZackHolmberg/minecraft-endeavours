/**
 * `world.new`: archive the current world + bot memory and generate a fresh
 * world. The only destructive panel action, so it is written fail-safe:
 *
 *  - Every path is fixed and derived from config; user input (the seed) only
 *    ever reaches the start step's child env as LEVEL_SEED.
 *  - Nothing is deleted. World folders and bot memory are *moved* (rename,
 *    or copy → verify → remove-source when rename crosses devices).
 *  - The first failing step stops the job with a clear message saying where
 *    things are; later steps never run.
 *  - No automatic pruning: archived worlds stay until removed by hand on the
 *    host. `pruneWorldArchives` is kept (tested) but not called from the job.
 */
import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { StatusResponse } from "../shared/api.js";
import { REPO_ROOT, type PanelConfig } from "./config.js";
import { botProcess, tcpReachable } from "./status.js";
import { ValidationError } from "./validate.js";

export const WORLD_DIRS = ["world", "world_nether", "world_the_end"] as const;
export const ARCHIVE_KEEP = 3;
export const ARCHIVE_NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
export const SEED_RE = /^-?[A-Za-z0-9_ ]{1,32}$/;
export const CONFIRM_PHRASE = "NEW WORLD";

export interface WorldNewTimings {
  /** World generation can take minutes on first start. */
  reachTimeoutMs: number;
  pollMs: number;
  /** After stop.sh / botStop.sh: how long to wait for the port / PID to go away. */
  settleTimeoutMs: number;
}
export const DEFAULT_TIMINGS: WorldNewTimings = { reachTimeoutMs: 20 * 60_000, pollMs: 5_000, settleTimeoutMs: 30_000 };

/** Validates a POST /api/actions/world.new body. Returns the seed, or null for random. */
export function validateWorldNew(body: Record<string, unknown>): { seed: string | null } {
  if (body.confirm !== CONFIRM_PHRASE) throw new ValidationError(`confirm must be exactly "${CONFIRM_PHRASE}"`);
  const raw = body.seed;
  if (raw === undefined || raw === null) return { seed: null };
  if (typeof raw !== "string") throw new ValidationError("seed must be a string");
  const seed = raw.trim();
  if (seed === "") return { seed: null };
  if (!SEED_RE.test(seed)) throw new ValidationError("seed must be 1–32 letters, digits, underscores or spaces (optional leading '-')");
  return { seed };
}

export interface WorldNewContext {
  cfg: PanelConfig;
  /** Status at submit time. */
  status: StatusResponse;
  seed: string | null;
  log(...lines: string[]): void;
  /** Run a script from cfg.scriptsDir; resolves to the exit code. */
  script(name: string, env?: Record<string, string>): Promise<number | null>;
  timings?: WorldNewTimings;
}

class StepFailed extends Error {}

/** Local time, same shape as backup.sh: 2026-10-09_14-03-22. */
export function archiveTimestamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const rel = (p: string): string => relative(REPO_ROOT, p) || ".";

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** File count + total bytes of a tree (symlinks counted, not followed). */
async function treeStats(p: string): Promise<{ files: number; bytes: number }> {
  const st = await lstat(p);
  if (!st.isDirectory()) return { files: 1, bytes: st.isFile() ? st.size : 0 };
  let files = 0;
  let bytes = 0;
  for (const e of await readdir(p)) {
    const s = await treeStats(join(p, e));
    files += s.files;
    bytes += s.bytes;
  }
  return { files, bytes };
}

/** rename; on EXDEV copy → verify → remove source. Throws on anything else (source left in place). */
async function moveEntry(src: string, dst: string, log: (l: string) => void): Promise<void> {
  try {
    await rename(src, dst);
    log(`  moved ${rel(src)} → ${rel(dst)}`);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  log(`  ${rel(src)} is on another filesystem — copying, then verifying before removing the original`);
  await cp(src, dst, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
  const [a, b] = await Promise.all([treeStats(src), treeStats(dst)]);
  if (a.files !== b.files || a.bytes !== b.bytes) {
    throw new Error(`copy of ${rel(src)} did not verify (${a.files} files/${a.bytes} B vs ${b.files}/${b.bytes}); original left in place`);
  }
  await rm(src, { recursive: true });
  log(`  copied ${rel(src)} → ${rel(dst)} (${a.files} files, verified) and removed the original`);
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, pollMs: number, onTick?: (elapsedMs: number) => void): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return true;
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) return false;
    onTick?.(elapsed);
    await sleep(Math.min(pollMs, timeoutMs - elapsed));
  }
}

/**
 * Keep the newest `keep` timestamp-named dirs in `dir`; returns names removed. Only exact-match names are ever considered.
 * `protect` (the archive just made) is never removed even if it sorts oldest — a clock set back (or a DST fall-back) gives it an older-looking name.
 */
export async function pruneWorldArchives(dir: string, keep: number, log: (l: string) => void, protect?: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const all = (await readdir(dir)).filter((n) => ARCHIVE_NAME_RE.test(n));
  const names = all.filter((n) => n !== protect).sort().reverse();
  if (names.length < all.length) keep = Math.max(0, keep - 1); // the protected one counts toward `keep`
  const removed: string[] = [];
  for (const name of names.slice(keep)) {
    const p = resolve(dir, name);
    if (relative(dir, p) !== name) continue; // paranoia: must be a direct child
    const st = await lstat(p);
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    await rm(p, { recursive: true });
    removed.push(name);
    log(`  pruned old archive ${rel(p)}`);
  }
  return removed;
}

const serverUp = (s: StatusResponse): boolean => s.server.state === "running" || s.server.state === "starting" || s.server.state === "unhealthy";

/** Runs the job. Resolves to an exit code (0 = success); never throws. */
export async function runWorldNew(ctx: WorldNewContext): Promise<number> {
  const { cfg, log } = ctx;
  const t = ctx.timings ?? DEFAULT_TIMINGS;
  const reachable = (): Promise<boolean> => tcpReachable(cfg.mcPort);
  const step = (n: number, what: string): void => log("", `── Step ${n}/8: ${what}`);
  const mustScript = async (name: string, what: string, env?: Record<string, string>): Promise<void> => {
    const code = await ctx.script(name, env);
    if (code !== 0) throw new StepFailed(`${what} failed (${name} exit ${code ?? "signal/timeout"})`);
  };

  const ts = archiveTimestamp();
  const worldDest = join(cfg.worldArchiveDir, ts);
  const memDest = join(cfg.botMemoryArchiveDir, ts);
  let worldsMoved = false;
  let serverStopped = false;

  log(`New world — seed: ${ctx.seed === null ? "(random)" : JSON.stringify(ctx.seed)}`, `Archive name: ${ts}`);
  try {
    const serverWasUp = serverUp(ctx.status);

    step(1, "back up the current world");
    if (serverWasUp) await mustScript("backup.sh", "Backup");
    else log("  server is not running — skipping backup.sh (it needs RCON save-all). The world folders are still archived intact in step 4.");

    step(2, "stop the bot");
    const botWasRunning = botProcess(cfg).running;
    if (botWasRunning) {
      await mustScript("botStop.sh", "Stopping the bot");
      if (!(await waitFor(() => !botProcess(cfg).running, t.settleTimeoutMs, 500))) throw new StepFailed("bot is still running after botStop.sh");
      log("  bot stopped (will restart it at the end)");
    } else log("  bot is not running — nothing to stop");

    step(3, "stop the server");
    if (serverWasUp) await mustScript("stop.sh", "Stopping the server");
    else log("  server is not running — skipping stop");
    serverStopped = true;
    // Never move a world out from under a live server, whatever the status said.
    if (!(await waitFor(async () => !(await reachable()), t.settleTimeoutMs, 1_000))) {
      throw new StepFailed(`something is still accepting connections on :${cfg.mcPort} — refusing to move the world`);
    }

    step(4, "archive the world folders");
    await mkdir(cfg.worldArchiveDir, { recursive: true });
    await mkdir(worldDest); // not recursive: an existing dir with this name is an error, never merged into
    let moved = 0;
    for (const d of WORLD_DIRS) {
      const src = join(cfg.mcDataDir, d);
      if (!(await exists(src))) {
        log(`  ${rel(src)} not present — skipping`);
        continue;
      }
      await moveEntry(src, join(worldDest, d), (l) => log(l));
      moved++;
      worldsMoved = true;
    }
    if (moved === 0) log("  no world folders found — the server will simply generate one");

    step(5, "archive the bot's memory");
    const memEntries = (await exists(cfg.botMemoryDir)) ? await readdir(cfg.botMemoryDir) : [];
    if (memEntries.length === 0) log(`  ${rel(cfg.botMemoryDir)} is empty or missing — nothing to archive`);
    else {
      await mkdir(cfg.botMemoryArchiveDir, { recursive: true });
      await mkdir(memDest);
      for (const e of memEntries) await moveEntry(join(cfg.botMemoryDir, e), join(memDest, e), (l) => log(l));
    }

    step(6, "start the server with the new seed");
    log(`  LEVEL_SEED=${ctx.seed === null ? "(empty → random)" : ctx.seed} (this run only; .env is not changed)`);
    await mustScript("start.sh", "Starting the server", { LEVEL_SEED: ctx.seed ?? "" });

    step(7, "wait for the server to finish generating the world");
    let lastTick = 0;
    const up = await waitFor(reachable, t.reachTimeoutMs, t.pollMs, (ms) => {
      if (ms - lastTick >= 30_000) {
        lastTick = ms;
        log(`  still generating… ${Math.round(ms / 1000)}s`);
      }
    });
    if (!up) throw new StepFailed(`server did not accept connections on :${cfg.mcPort} within ${Math.round(t.reachTimeoutMs / 60_000)} min — check the server logs`);
    log("  server is reachable");

    step(8, "restart the bot");
    if (botWasRunning) await mustScript("botStart.sh", "Restarting the bot");
    else log("  bot was not running before — leaving it stopped");

    // No automatic pruning: archived worlds are never deleted by the panel, so a
    // stolen session can't destroy the original world by repeating world.new.
    // Old archives are removed by hand on the host (security review, Oct 2026).
    log("", `Archived worlds are kept in ${rel(cfg.worldArchiveDir)}/ — delete old ones by hand on the host if disk space matters.`);
    log("", `Done. Old world: ${rel(worldDest)}${memEntries.length ? ` · old bot memory: ${rel(memDest)}` : ""}`);
    return 0;
  } catch (err) {
    const msg = err instanceof StepFailed ? err.message : `unexpected error: ${(err as Error).message.replaceAll(REPO_ROOT, "<repo>")}`;
    log("", `FAILED: ${msg}`, "Nothing was deleted. The job stopped here; no further steps ran.");
    if (worldsMoved) log(`The previous world is in ${rel(worldDest)}/ (move it back into data/ to restore it).`);
    if (serverStopped) log("The server may be stopped — start it from the Overview page once resolved.");
    return 1;
  }
}
