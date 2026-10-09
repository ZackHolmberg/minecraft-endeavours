/**
 * Action allowlist + job runner. Each ActionId maps to a fixed list of argv
 * steps (no user input reaches argv). One job per group at a time; the
 * server and bot groups additionally block each other's restarts implicitly
 * via preconditions re-checked at submit time. `world.new` is the exception:
 * a scripted multi-step job (world-new.ts) that is exclusive across every
 * group and whose only input (a validated seed) reaches a child env var.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import type { ActionDef, ActionId, JobDetail, JobSummary, StatusResponse } from "../shared/api.js";
import type { PanelConfig } from "./config.js";
import { COMPOSE_SERVICE, LineSplitter, spawnStreaming } from "./exec.js";
import { runWorldNew, type WorldNewTimings } from "./world-new.js";

const OUTPUT_CAP = 2000;
const JOB_HISTORY = 50;
const STEP_TIMEOUT_MS = 15 * 60_000;

type Group = ActionDef["group"];

interface ActionSpec {
  label: string;
  description: string;
  confirm: boolean;
  group: Group;
  /** Blocks, and is blocked by, jobs in every group. */
  exclusive?: boolean;
  steps: (cfg: PanelConfig) => string[][];
  /** null = available, else the reason. */
  precondition: (s: StatusResponse) => string | null;
}

const script = (cfg: PanelConfig, name: string): string[] => ["/bin/bash", resolve(cfg.scriptsDir, name)];
const serverUp = (s: StatusResponse): boolean => s.server.state === "running" || s.server.state === "starting" || s.server.state === "unhealthy";
const dockerDown = (s: StatusResponse): string | null => (s.server.state === "unknown" ? "Docker is not reachable" : null);

const ACTIONS: ReadonlyMap<ActionId, ActionSpec> = new Map<ActionId, ActionSpec>([
  ["server.start", {
    label: "Start server", description: "docker compose up -d (Minecraft + DuckDNS)", confirm: false, group: "server",
    steps: (c) => [script(c, "start.sh")],
    precondition: (s) => dockerDown(s) ?? (serverUp(s) ? "Server is already running" : null),
  }],
  ["server.stop", {
    label: "Stop server", description: "Save the world and stop the containers", confirm: true, group: "server",
    steps: (c) => [script(c, "stop.sh")],
    precondition: (s) => dockerDown(s) ?? (serverUp(s) ? null : "Server is not running"),
  }],
  ["server.restart", {
    label: "Restart server", description: "Stop, then start the containers", confirm: true, group: "server",
    steps: (c) => [script(c, "stop.sh"), script(c, "start.sh")],
    precondition: (s) => dockerDown(s) ?? (serverUp(s) ? null : "Server is not running — use Start"),
  }],
  ["bot.start", {
    label: "Start bot", description: "Launch the AI bot orchestrator", confirm: false, group: "bot",
    steps: (c) => [script(c, "botStart.sh")],
    precondition: (s) =>
      s.bot.running ? "Bot is already running" : s.server.reachable ? null : "Minecraft server is not reachable on :25565 — start the server first",
  }],
  ["bot.stop", {
    label: "Stop bot", description: "Gracefully stop the bot orchestrator", confirm: true, group: "bot",
    steps: (c) => [script(c, "botStop.sh")],
    precondition: (s) => (s.bot.running ? null : "Bot is not running"),
  }],
  ["bot.restart", {
    label: "Restart bot", description: "Stop, then start the bot orchestrator", confirm: true, group: "bot",
    steps: (c) => [script(c, "botStop.sh"), script(c, "botStart.sh")],
    precondition: (s) =>
      !s.bot.running ? "Bot is not running — use Start" : s.server.reachable ? null : "Minecraft server is not reachable on :25565",
  }],
  ["world.save", {
    label: "Save world", description: "RCON save-all", confirm: false, group: "world",
    steps: () => [["docker", "compose", "exec", "-T", COMPOSE_SERVICE, "rcon-cli", "save-all"]],
    precondition: (s) => (serverUp(s) && s.server.reachable ? null : "Server is not running"),
  }],
  ["backup.run", {
    label: "Back up world", description: "save-all, then archive the world to ./backups (keeps last 10)", confirm: false, group: "world",
    steps: (c) => [script(c, "backup.sh")],
    precondition: (s) => (serverUp(s) && s.server.reachable ? null : "Server is not running (backup needs RCON save-all)"),
  }],
  ["world.new", {
    label: "New world",
    description:
      "Back up, stop the bot and server, move the world folders to backups/worlds/ and the bot's memory to memory-archive/, then start the server on a fresh world. Nothing is deleted; everyone is disconnected; takes a few minutes.",
    confirm: true, group: "world", exclusive: true,
    steps: () => [], // scripted: see runWorldNew
    precondition: (s) =>
      dockerDown(s) ??
      (serverUp(s) && !s.server.reachable ? "Server is starting — wait until it is reachable (the backup needs RCON)" : null),
  }],
]);

export const EXCLUSIVE_BUSY = "Another job is running — a new world needs the panel to itself";

export function isActionId(id: string): id is ActionId {
  return ACTIONS.has(id as ActionId);
}

interface Job extends JobDetail {
  group: Group;
}

export interface JobEvents {
  output(jobId: string, lines: string[]): void;
  state(job: JobSummary): void;
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private order: string[] = [];
  private running = new Map<Group, string>();
  /** Id of the running exclusive job (world.new), which blocks every group. */
  private exclusive: string | null = null;
  /** Test hook: shorter waits for world.new. */
  worldNewTimings: WorldNewTimings | undefined;

  constructor(
    private readonly cfg: PanelConfig,
    private readonly events: JobEvents,
    private readonly onFinish: (job: JobSummary) => void,
  ) {}

  defs(status: StatusResponse): ActionDef[] {
    return [...ACTIONS].map(([id, a]) => {
      const reason = this.busyReason(a) ?? a.precondition(status);
      return { id, label: a.label, description: a.description, confirm: a.confirm, group: a.group, available: reason === null, unavailableReason: reason };
    });
  }

  private busyReason(a: ActionSpec): string | null {
    if (this.exclusive) return "A new world is being generated";
    if (a.exclusive && this.running.size > 0) return EXCLUSIVE_BUSY;
    return this.running.has(a.group) ? "Another job in this group is running" : null;
  }

  active(): JobSummary[] {
    const ids = [...this.running.values()];
    if (this.exclusive) ids.push(this.exclusive);
    return ids.map((id) => summary(this.jobs.get(id)!));
  }

  list(): JobSummary[] {
    return [...this.order].reverse().map((id) => summary(this.jobs.get(id)!));
  }

  get(id: string): JobDetail | null {
    const j = this.jobs.get(id);
    return j ? { ...summary(j), output: [...j.output] } : null;
  }

  /** Throws `{code}` errors the router maps to HTTP. */
  start(id: ActionId, user: string, status: StatusResponse, input: { seed?: string | null } = {}): JobSummary {
    const spec = ACTIONS.get(id)!;
    const busy = this.busyReason(spec);
    if (busy) throw Object.assign(new Error(busy), { code: "busy" });
    const reason = spec.precondition(status);
    if (reason) throw Object.assign(new Error(reason), { code: "unavailable" });

    const job: Job = {
      id: randomBytes(9).toString("base64url"),
      action: id,
      state: "running",
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      startedBy: user,
      output: [],
      group: spec.group,
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    while (this.order.length > JOB_HISTORY) {
      const old = this.order[0]!;
      if (this.jobs.get(old)?.state === "running") break;
      this.order.shift();
      this.jobs.delete(old);
    }
    if (spec.exclusive) this.exclusive = job.id;
    else this.running.set(spec.group, job.id);
    this.events.state(summary(job));
    if (id === "world.new") void this.runWorldNew(job, status, input.seed ?? null);
    else void this.runSteps(job, spec.steps(this.cfg));
    return summary(job);
  }

  private append(job: Job, lines: string[]): void {
    job.output.push(...lines);
    if (job.output.length > OUTPUT_CAP) job.output.splice(0, job.output.length - OUTPUT_CAP);
    this.events.output(job.id, lines);
  }

  private async runSteps(job: Job, steps: string[][]): Promise<void> {
    let code: number | null = 0;
    for (const argv of steps) {
      this.append(job, [`$ ${displayArgv(argv, this.cfg)}`]);
      code = await this.runStep(job, argv);
      if (code !== 0) break;
    }
    this.finish(job, code);
  }

  private async runWorldNew(job: Job, status: StatusResponse, seed: string | null): Promise<void> {
    let code: number | null = 1;
    try {
      code = await runWorldNew({
        cfg: this.cfg,
        status,
        seed,
        timings: this.worldNewTimings,
        log: (...lines) => this.append(job, lines),
        script: (name, env) => {
          const argv = script(this.cfg, name);
          this.append(job, [`$ ${displayArgv(argv, this.cfg)}`]);
          return this.runStep(job, argv, env);
        },
      });
    } catch (err) {
      this.append(job, [`panel: world.new crashed: ${(err as Error).message}`]); // runWorldNew catches; belt and braces
    }
    this.finish(job, code);
  }

  private finish(job: Job, code: number | null): void {
    job.exitCode = code;
    job.state = code === 0 ? "succeeded" : "failed";
    job.endedAt = Date.now();
    if (this.exclusive === job.id) this.exclusive = null;
    else this.running.delete(job.group);
    this.events.state(summary(job));
    this.onFinish(summary(job));
  }

  private runStep(job: Job, argv: string[], env?: Record<string, string>): Promise<number | null> {
    return new Promise((resolveStep) => {
      let settled = false;
      const split = new LineSplitter((lines) => this.append(job, lines));
      let child;
      try {
        child = spawnStreaming(argv, { detached: true, env });
      } catch (err) {
        this.append(job, [`failed to start: ${(err as Error).message}`]);
        resolveStep(null);
        return;
      }
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        split.flush();
        resolveStep(code);
      };
      const timer = setTimeout(() => {
        this.append(job, ["panel: step timed out — killing"]);
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }, STEP_TIMEOUT_MS);
      child.stdout!.on("data", (d: Buffer) => split.push(d));
      child.stderr!.on("data", (d: Buffer) => split.push(d));
      child.on("error", (err) => {
        this.append(job, [`failed to start: ${err.message}`]);
        finish(null);
      });
      // A detached grandchild (e.g. the bot) might keep a pipe open; don't wait on 'close' forever.
      child.on("exit", (code) => setTimeout(() => finish(code), 1_000));
      child.on("close", (code) => finish(code));
    });
  }
}

function summary(j: Job): JobSummary {
  return { id: j.id, action: j.action, state: j.state, startedAt: j.startedAt, endedAt: j.endedAt, exitCode: j.exitCode, startedBy: j.startedBy };
}

function displayArgv(argv: string[], cfg: PanelConfig): string {
  return argv.map((a) => (a.startsWith(cfg.scriptsDir) ? `scripts${a.slice(cfg.scriptsDir.length)}` : a)).filter((a) => a !== "/bin/bash").join(" ");
}
