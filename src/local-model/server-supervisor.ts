/**
 * Supervisor for the local `mlx_lm.server` process — spawn, health-check, and
 * auto-restart on death. Mirrors the mineflayer bot supervisor
 * (`src/mineflayer-glue/bot-factory.ts`): the model server can die under
 * sustained load with a *recoverable* Metal-OOM abort (SIGABRT, not a kernel
 * panic — see spikes/MLX_NOTES.md and memory `project-local-llm-hw-constraint`),
 * so restarting it is the recovery path.
 *
 * Started/stopped independently of the orchestrator via scripts/llmStart.sh /
 * llmStop.sh (this module's entry is `src/local-model/start.ts`). The
 * `LocalBackend` just connects to the endpoint and tolerates it being down.
 */

import { spawn, type ChildProcess } from "node:child_process";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;

export type ModelServerState = "starting" | "healthy" | "restarting" | "stopped";

export interface ModelServerSupervisorOptions {
  /** Absolute path to the `mlx_lm.server` executable (e.g. `.venv/bin/mlx_lm.server`). */
  serverBin: string;
  model: string;
  host: string;
  port: number;
}

export interface ModelServerSupervisor {
  readonly state: ModelServerState;
  /** Resolve true once `GET /v1/models` returns 200, or false on timeout. */
  waitUntilHealthy(timeoutMs: number): Promise<boolean>;
  stop(): Promise<void>;
}

export function startModelServerSupervisor(
  opts: ModelServerSupervisorOptions,
): ModelServerSupervisor {
  const { serverBin, model, host, port } = opts;
  const baseUrl = `http://${host}:${port}/v1`;
  const tag = "[mlx]";

  let stopped = false;
  let state: ModelServerState = "starting";
  let backoffMs = INITIAL_BACKOFF_MS;
  let child: ChildProcess | null = null;
  let restartTimer: NodeJS.Timeout | null = null;

  const spawnServer = (): void => {
    if (stopped) return;
    console.log(`${tag} starting mlx_lm.server → ${host}:${port} (${model})`);
    const proc = spawn(serverBin, ["--model", model, "--host", host, "--port", String(port)], {
      stdio: "inherit",
    });
    child = proc;

    proc.on("error", (err) => {
      console.error(`${tag} spawn error: ${err.message}`);
    });

    proc.once("exit", (code, signal) => {
      child = null;
      if (stopped) return;
      console.warn(`${tag} server exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
      scheduleRestart();
    });

    // Flip to healthy once the endpoint answers; harmless if it never does
    // before the next exit (state just stays "starting"/"restarting").
    void pollHealthy();
  };

  const pollHealthy = async (): Promise<void> => {
    while (!stopped && child) {
      if (await probe(baseUrl)) {
        if (state !== "healthy") {
          state = "healthy";
          backoffMs = INITIAL_BACKOFF_MS;
          console.log(`${tag} healthy at ${baseUrl}`);
        }
        return;
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
  };

  const scheduleRestart = (): void => {
    if (stopped || restartTimer) return;
    state = "restarting";
    const delay = backoffMs;
    console.log(`${tag} restarting in ${delay}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      spawnServer();
    }, delay);
  };

  spawnServer();

  return {
    get state() {
      return state;
    },
    async waitUntilHealthy(timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stopped) return false;
        if (state === "healthy" && (await probe(baseUrl))) return true;
        await sleep(HEALTH_POLL_INTERVAL_MS);
      }
      return false;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      state = "stopped";
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      const proc = child;
      child = null;
      if (!proc) return;
      proc.kill("SIGTERM");
      // Give it a moment to exit, then escalate.
      const exited = await waitForExit(proc, 5_000);
      if (!exited) proc.kill("SIGKILL");
    },
  };
}

async function probe(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
