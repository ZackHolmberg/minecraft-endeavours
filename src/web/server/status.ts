/**
 * Status probes. Results are cached and computed single-flight so request or
 * WebSocket volume can never multiply the number of docker/RCON processes.
 * Every probe fails soft — the panel must work with docker, the server or the
 * bot down.
 */
import { existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { freemem, loadavg, totalmem } from "node:os";

import type { BotSnapshot } from "../../observability/snapshot.js";
import type { JobSummary, StatusResponse } from "../shared/api.js";
import { REPO_ROOT, type PanelConfig } from "./config.js";
import { CONTAINER_NAME, COMPOSE_SERVICE, rcon, run } from "./exec.js";

const SNAPSHOT_STALE_MS = 5_000;
const CACHE_MS = 1_500;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

type ServerState = StatusResponse["server"]["state"];

interface ComposeService {
  Service?: string;
  State?: string;
  Health?: string;
}

export async function composePs(): Promise<Map<string, ComposeService> | null> {
  const r = await run(["docker", "compose", "ps", "-a", "--format", "json"], 8_000);
  if (r.code !== 0) return null;
  const out = new Map<string, ComposeService>();
  const text = r.stdout.trim();
  if (!text) return out;
  try {
    // Newer compose: NDJSON; older: a JSON array.
    const items: ComposeService[] = text.startsWith("[")
      ? (JSON.parse(text) as ComposeService[])
      : text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ComposeService);
    for (const it of items) if (it.Service) out.set(it.Service, it);
  } catch {
    return null;
  }
  return out;
}

function mapState(s: ComposeService | undefined): ServerState {
  if (!s) return "stopped";
  const state = (s.State ?? "").toLowerCase();
  const health = (s.Health ?? "").toLowerCase();
  if (state === "running") {
    if (health === "starting") return "starting";
    if (health === "unhealthy") return "unhealthy";
    return "running";
  }
  if (state === "restarting") return "starting";
  if (["exited", "created", "dead", "paused", "removing"].includes(state)) return "stopped";
  return "unknown";
}

export function tcpReachable(port: number, host = "127.0.0.1", timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** "There are 1 of a max of 10 players online: a, b" */
export function parseList(output: string): { online: number; max: number | null; names: string[] } | null {
  const m = /There are (\d+)\s*(?:of a max of|\/)\s*(\d+) players online:?\s*(.*)$/s.exec(output);
  if (!m) return null;
  const names = (m[3] ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => /^[A-Za-z0-9_]{1,16}$/.test(n));
  return { online: Number(m[1]), max: Number(m[2]), names };
}

export function botProcess(cfg: PanelConfig): { running: boolean; pid: number | null; since: number | null } {
  try {
    if (!existsSync(cfg.botPidFile)) return { running: false, pid: null, since: null };
    const pid = Number(readFileSync(cfg.botPidFile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 1) return { running: false, pid: null, since: null };
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") return { running: false, pid: null, since: null };
    }
    return { running: true, pid, since: statSync(cfg.botPidFile).mtimeMs };
  } catch {
    return { running: false, pid: null, since: null };
  }
}

/** Fresh snapshots, or [] when the file is missing / stale / unreadable. */
export function readSnapshots(cfg: PanelConfig): BotSnapshot[] {
  try {
    const st = statSync(cfg.snapshotFile);
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return [];
    const payload = JSON.parse(readFileSync(cfg.snapshotFile, "utf8")) as { capturedAt?: number; snapshots?: BotSnapshot[] };
    if (typeof payload.capturedAt !== "number" || Date.now() - payload.capturedAt > SNAPSHOT_STALE_MS) return [];
    return Array.isArray(payload.snapshots) ? payload.snapshots : [];
  } catch {
    return [];
  }
}

function mcVersion(cfg: PanelConfig): string | null {
  try {
    const v = JSON.parse(readFileSync(`${cfg.mcDataDir}/version_history.json`, "utf8")) as { currentVersion?: string };
    const m = /\(MC: ([^)]+)\)/.exec(v.currentVersion ?? "");
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Parse `vm_stat`: free + inactive + speculative + purgeable pages, in bytes. */
export function parseVmStat(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  let pages = 0;
  for (const k of ["free", "inactive", "speculative", "purgeable"]) {
    const m = new RegExp(`^Pages ${k}:\\s+(\\d+)\\.?$`, "m").exec(text);
    if (!m) return null;
    pages += Number(m[1]);
  }
  return pages * pageSize;
}

const VM_STAT_CACHE_MS = 10_000;
let vmStatCache: { at: number; bytes: number } | null = null;

/**
 * Host memory that's actually available. On macOS `os.freemem()` only counts
 * truly free pages, so it reads near zero once the file cache fills; use
 * vm_stat's reclaimable pages instead (cached). Falls back to os.freemem().
 */
async function availableMemBytes(): Promise<number> {
  if (process.platform !== "darwin") return freemem();
  if (vmStatCache && Date.now() - vmStatCache.at < VM_STAT_CACHE_MS) return vmStatCache.bytes;
  const r = await run(["/usr/bin/vm_stat"], 3_000);
  const bytes = r.code === 0 ? parseVmStat(r.stdout) : null;
  if (bytes === null) return freemem();
  vmStatCache = { at: Date.now(), bytes };
  return bytes;
}

async function containerStartedAt(): Promise<number | null> {
  const r = await run(["docker", "inspect", "--format", "{{.State.StartedAt}}", CONTAINER_NAME], 5_000);
  if (r.code !== 0) return null;
  const t = Date.parse(r.stdout.trim());
  return Number.isFinite(t) ? t : null;
}

export class StatusService {
  private cached: StatusResponse | null = null;
  private inflight: Promise<StatusResponse> | null = null;
  readonly startedAt = Date.now();

  constructor(
    private readonly cfg: PanelConfig,
    private readonly activeJobs: () => JobSummary[],
  ) {}

  async get(maxAgeMs = CACHE_MS): Promise<StatusResponse> {
    if (this.cached && Date.now() - this.cached.at < maxAgeMs) {
      return { ...this.cached, activeJobs: this.activeJobs() };
    }
    if (!this.inflight) {
      this.inflight = this.compute().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Last computed value without probing (for availability checks between polls). */
  peek(): StatusResponse | null {
    return this.cached;
  }

  private async compute(): Promise<StatusResponse> {
    const [ps, reachable] = await Promise.all([composePs(), tcpReachable(this.cfg.mcPort)]);
    const mc = ps?.get(COMPOSE_SERVICE);
    const state: ServerState = ps === null ? "unknown" : mapState(mc);
    const dd = ps?.get("duckdns");
    const duckState: StatusResponse["duckdns"]["state"] =
      ps === null ? "unknown" : dd && (dd.State ?? "").toLowerCase() === "running" ? "running" : "stopped";

    const containerUp = state === "running" || state === "starting" || state === "unhealthy";
    const [since, players, availMem] = await Promise.all([
      containerUp ? containerStartedAt() : Promise.resolve(null),
      reachable && containerUp ? rcon("list", 5_000).then((r) => (r.ok ? parseList(r.output) : null)) : Promise.resolve(null),
      availableMemBytes(),
    ]);

    const proc = botProcess(this.cfg);
    const snaps = proc.running ? readSnapshots(this.cfg) : [];
    let diskFreeGb: number | null = null;
    try {
      const fs = statfsSync(REPO_ROOT);
      diskFreeGb = Math.round(((fs.bavail * fs.bsize) / 1e9) * 10) / 10;
    } catch {
      /* ignore */
    }

    const status: StatusResponse = {
      at: Date.now(),
      server: { state, since, reachable, players, version: mcVersion(this.cfg) },
      duckdns: { state: duckState },
      bot: {
        running: proc.running,
        pid: proc.pid,
        since: proc.since,
        bots:
          proc.running && snaps.length > 0
            ? snaps.map((s) => ({
                username: s.username,
                connection: String(s.connection?.state ?? "unknown"),
                health: s.bot?.health ?? null,
                food: s.bot?.food ?? null,
                currentTool: s.state?.currentTool?.name ?? null,
                currentTask: s.state?.currentTask ?? null,
              }))
            : null,
      },
      host: {
        loadAvg1m: Math.round((loadavg()[0] ?? 0) * 100) / 100,
        freeMemMb: Math.round(availMem / 1048576),
        totalMemMb: Math.round(totalmem() / 1048576),
        diskFreeGb,
      },
      panel: { version: this.cfg.version, startedAt: this.startedAt },
      activeJobs: this.activeJobs(),
    };
    this.cached = status;
    return status;
  }
}
