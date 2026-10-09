/**
 * Process execution. Every child is spawned from a fixed argv with
 * `shell: false`; nothing user-controlled is ever interpolated into a shell
 * string. Children get a minimal environment (no PANEL_* settings) and run
 * from the repo root. Jobs run `detached` (own process group) so launchd
 * restarting the panel never takes the bot or a half-finished stop with it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";

import { REPO_ROOT } from "./config.js";

const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/Applications/Docker.app/Contents/Resources/bin"];

export function childEnv(): NodeJS.ProcessEnv {
  // Absolute entries only: a relative PATH entry ("", ".", "bin") would resolve
  // against cwd (the repo root) and let a file dropped there shadow `docker`.
  const path = [...new Set([...(process.env.PATH ?? "").split(":").filter((p) => p.startsWith("/")), ...EXTRA_PATH])].join(":");
  const env: NodeJS.ProcessEnv = { PATH: path, HOME: process.env.HOME ?? homedir(), LANG: process.env.LANG ?? "en_US.UTF-8" };
  for (const k of ["USER", "LOGNAME", "TMPDIR", "SHELL", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  env.NO_COLOR = "1";
  return env;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}

const MAX_CAPTURE = 2 * 1024 * 1024;

/** Run to completion with a timeout and capped capture. Never throws. */
export function run(argv: readonly string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd: REPO_ROOT, env: childEnv(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, error: null });
    });
  });
}

/** Long-running / streaming child (jobs, `logs -f`). Caller wires stdout/stderr. */
export function spawnStreaming(argv: readonly string[], opts: { detached: boolean }): ChildProcess {
  return spawn(argv[0]!, argv.slice(1), {
    cwd: REPO_ROOT,
    env: childEnv(),
    shell: false,
    detached: opts.detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Splits a byte stream into lines, capping line length. */
export class LineSplitter {
  private buf = "";
  constructor(
    private readonly onLines: (lines: string[]) => void,
    private readonly maxLine = 4096,
  ) {}
  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop() ?? "";
    if (this.buf.length > this.maxLine) {
      parts.push(this.buf);
      this.buf = "";
    }
    if (parts.length) this.onLines(parts.map((l) => stripAnsi(l).slice(0, this.maxLine)));
  }
  flush(): void {
    if (this.buf) this.onLines([stripAnsi(this.buf).slice(0, this.maxLine)]);
    this.buf = "";
  }
}

// eslint-disable-next-line no-control-regex
// OSC body excludes ESC so an unterminated "ESC ] ESC ] …" run can't make each
// match scan to end of input (that was O(n²) on a long hostile line).
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(ANSI_RE, "").replace(/§[0-9a-fk-orx]/gi, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

// ── Docker / RCON helpers ───────────────────────────────────────────────

export const COMPOSE_SERVICE = "minecraft";
export const CONTAINER_NAME = "minecraft-server";

/**
 * One RCON command via the container's rcon-cli. The command is a single argv
 * element (no shell); callers must have validated it (`validateConsoleCommand`).
 */
export async function rcon(command: string, timeoutMs = 10_000): Promise<{ ok: boolean; output: string }> {
  const r = await run(["docker", "compose", "exec", "-T", COMPOSE_SERVICE, "rcon-cli", command], timeoutMs);
  const output = stripAnsi((r.stdout + (r.code === 0 ? "" : r.stderr)).trim());
  if (r.timedOut) return { ok: false, output: "RCON timed out" };
  if (r.error) return { ok: false, output: "docker is not available" };
  return { ok: r.code === 0, output: r.code === 0 ? output : sanitizeDockerError(output) };
}

/** Keep error text useful without leaking host paths. */
export function sanitizeDockerError(s: string): string {
  const firstLines = s.split("\n").slice(0, 3).join(" ").slice(0, 300);
  return firstLines.replaceAll(REPO_ROOT, "<repo>").replace(/\/Users\/[^\s/]+/g, "~") || "command failed";
}
