/**
 * Log / telemetry tailing. Polling (not fs.watch) so truncation by
 * botStart.sh and size-rotation of telemetry are handled uniformly. Reads are
 * capped per tick so a runaway writer can't balloon panel memory.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { COMPOSE_SERVICE, LineSplitter, spawnStreaming, stripAnsi } from "./exec.js";

const MAX_READ_PER_TICK = 1024 * 1024;

/** Last `n` lines of a file, reading at most `maxBytes` from its end. */
export function readTailLines(path: string, n: number, maxBytes = 2 * 1024 * 1024): string[] {
  if (!existsSync(path)) return [];
  const st = statSync(path);
  if (!st.isFile()) return [];
  const start = Math.max(0, st.size - maxBytes);
  const buf = Buffer.alloc(st.size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split(/\r?\n/);
  if (start > 0) lines.shift();
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).map((l) => stripAnsi(l).slice(0, 4096));
}

export class FileTailer {
  private offset = -1;
  private timer: NodeJS.Timeout | null = null;
  private split: LineSplitter;

  constructor(
    private readonly path: string,
    onLines: (lines: string[]) => void,
    private readonly intervalMs = 1_000,
  ) {
    this.split = new LineSplitter(onLines);
  }

  start(): void {
    if (this.timer) return;
    // Start at EOF: history comes from the GET endpoint.
    try {
      this.offset = existsSync(this.path) ? statSync(this.path).size : 0;
    } catch {
      this.offset = 0;
    }
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      this.offset = 0;
      return;
    }
    if (size < this.offset) this.offset = 0; // truncated / rotated
    if (size === this.offset) return;
    const len = Math.min(size - this.offset, MAX_READ_PER_TICK);
    const buf = Buffer.alloc(len);
    let fd: number | null = null;
    try {
      fd = openSync(this.path, "r");
      readSync(fd, buf, 0, len, this.offset);
      this.offset += len;
      this.split.push(buf);
    } catch {
      /* transient */
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
}

/** `docker compose logs -f` for the minecraft service, restarted with backoff while wanted. */
export class DockerLogFollower {
  private child: ChildProcess | null = null;
  private wanted = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly onLines: (lines: string[]) => void) {}

  start(): void {
    this.wanted = true;
    if (!this.child && !this.restartTimer) this.spawn();
  }

  stop(): void {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  private spawn(): void {
    const split = new LineSplitter(this.onLines);
    let child: ChildProcess;
    try {
      child = spawnStreaming(["docker", "compose", "logs", "-f", "--tail", "0", "--no-color", "--no-log-prefix", COMPOSE_SERVICE], { detached: false });
    } catch {
      this.scheduleRestart();
      return;
    }
    this.child = child;
    child.stdout!.on("data", (d: Buffer) => split.push(d));
    child.stderr!.on("data", () => {
      /* "no such service" etc. — swallowed; status shows docker state */
    });
    child.on("error", () => undefined);
    child.on("close", () => {
      split.flush();
      if (this.child === child) this.child = null;
      if (this.wanted) this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted && !this.child) this.spawn();
    }, 5_000);
  }
}

/** Tails every bot's telemetry `events.jsonl`, rescanning for new bots. */
export class TelemetryTailer {
  private tailers = new Map<string, FileTailer>();
  private scan: NodeJS.Timeout | null = null;

  constructor(
    private readonly dir: string,
    private readonly onEvent: (ev: unknown) => void,
  ) {}

  start(): void {
    if (this.scan) return;
    this.rescan();
    this.scan = setInterval(() => this.rescan(), 5_000);
  }

  stop(): void {
    if (this.scan) clearInterval(this.scan);
    this.scan = null;
    for (const t of this.tailers.values()) t.stop();
    this.tailers.clear();
  }

  private rescan(): void {
    let bots: string[] = [];
    try {
      bots = existsSync(this.dir) ? readdirSync(this.dir).filter((b) => /^[A-Za-z0-9_]{1,16}$/.test(b)) : [];
    } catch {
      return;
    }
    for (const bot of bots) {
      if (this.tailers.has(bot)) continue;
      const t = new FileTailer(join(this.dir, bot, "events.jsonl"), (lines) => {
        for (const l of lines) {
          if (!l.trim()) continue;
          try {
            this.onEvent(JSON.parse(l));
          } catch {
            /* partial / corrupt */
          }
        }
      });
      t.start();
      this.tailers.set(bot, t);
    }
  }
}
