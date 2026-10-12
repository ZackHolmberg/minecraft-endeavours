/** Spawns / stops the bot under test as a separate process (black-box). */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

export const LIVE_CHECKOUT = "/Users/zackholmberg/dev/minecraft-endeavours";

export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export interface BotDirInfo {
  dir: string;
  env: Record<string, string>;
  username: string;
}

/** Validate the bot checkout and read its env + bot username. Refuses the live checkout / live port. */
export function inspectBotDir(botDir: string): BotDirInfo {
  const dir = resolve(botDir);
  if (dir === LIVE_CHECKOUT) throw new Error("refusing to run against the live checkout");
  const env = parseEnvFile(join(dir, ".env"));
  const port = env.MC_PORT ?? process.env.MC_PORT;
  if (!port || port === "25565") throw new Error(`bot dir .env must set MC_PORT to the test server (got ${port})`);
  if (!existsSync(join(dir, "src/index.ts"))) throw new Error(`${dir}/src/index.ts not found`);
  const raw = yaml.load(readFileSync(join(dir, "config/bots.yml"), "utf8")) as { bots?: Array<{ username?: string }> };
  const username = raw.bots?.[0]?.username;
  if (!username) throw new Error("no bot username in config/bots.yml");
  return { dir, env, username };
}

/** Wipe per-bot persistent state so scenarios are independent. */
export function wipeBotState(info: BotDirInfo): void {
  rmSync(join(info.dir, "data/orchestrator/memory"), { recursive: true, force: true });
  rmSync(join(info.dir, ".bot-runtime"), { recursive: true, force: true });
}

/** Bot process groups still running; killed if the harness exits (Ctrl+C, crash). */
const live = new Set<number>();
process.on("exit", () => {
  for (const pid of live) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

export class BotProcess {
  private child: ChildProcess | null = null;
  private exited = false;

  constructor(
    private readonly info: BotDirInfo,
    private readonly telemetryDir: string,
    private readonly logPath: string,
  ) {}

  /** Path of this bot's events.jsonl. */
  get eventsPath(): string {
    return join(this.telemetryDir, this.info.username, "events.jsonl");
  }

  start(): void {
    mkdirSync(this.telemetryDir, { recursive: true });
    mkdirSync(join(this.logPath, ".."), { recursive: true });
    const log = createWriteStream(this.logPath);
    const tsx = join(this.info.dir, "node_modules/.bin/tsx");
    const child = spawn(tsx, ["src/index.ts"], {
      cwd: this.info.dir,
      env: { ...process.env, ...this.info.env, BOT_TELEMETRY_DIR: this.telemetryDir },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    if (child.pid) live.add(child.pid);
    child.on("exit", () => {
      if (child.pid) live.delete(child.pid);
      this.exited = true;
      log.end();
    });
    this.child = child;
  }

  get running(): boolean {
    return !!this.child && !this.exited;
  }

  /** SIGTERM the process group; SIGKILL after 10s. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exited || !child.pid) return;
    const pid = child.pid;
    const done = new Promise<void>((res) => child.once("exit", () => res()));
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    const timer = new Promise<boolean>((res) => setTimeout(() => res(false), 10_000));
    const ok = await Promise.race([done.then(() => true), timer]);
    if (!ok) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* ignore */
      }
      await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
    } else {
      // Make sure no stragglers from the group survive.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* none left */
      }
    }
  }
}
