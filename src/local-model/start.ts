/**
 * Entry point for the local model server supervisor — launched detached by
 * scripts/llmStart.sh (`npm run llm:start`). Spawns and keeps `mlx_lm.server`
 * alive (restart-on-death), writes its own PID so llmStop.sh can find it, and
 * shuts the server down cleanly on SIGTERM/SIGINT.
 *
 * Config comes from the environment (with spike-validated defaults):
 *   MLX_SERVER_BIN  path to mlx_lm.server   (default .venv/bin/mlx_lm.server)
 *   MLX_MODEL       model id                (default mlx-community/Qwen3-14B-4bit)
 *   MLX_HOST        bind host               (default 127.0.0.1)
 *   MLX_PORT        bind port               (default 8080)
 */

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MLX_SERVER_PID_PATH } from "../runtime-paths.js";
import { startModelServerSupervisor } from "./server-supervisor.js";

const serverBin = process.env.MLX_SERVER_BIN
  ? resolve(process.cwd(), process.env.MLX_SERVER_BIN)
  : resolve(process.cwd(), ".venv/bin/mlx_lm.server");
const model = process.env.MLX_MODEL ?? "mlx-community/Qwen3-8B-4bit";
const host = process.env.MLX_HOST ?? "127.0.0.1";
const port = Number(process.env.MLX_PORT ?? 8080);

// Model load on 14B is slow (cold weights + first prompt-processing); give the
// health gate generous headroom before the launcher script gives up.
const HEALTHY_TIMEOUT_MS = 180_000;

mkdirSync(dirname(MLX_SERVER_PID_PATH), { recursive: true });
writeFileSync(MLX_SERVER_PID_PATH, String(process.pid));

const supervisor = startModelServerSupervisor({ serverBin, model, host, port });

void supervisor.waitUntilHealthy(HEALTHY_TIMEOUT_MS).then((ok) => {
  if (ok) {
    console.log(`[mlx] ready — LocalBackend can now reach http://${host}:${port}/v1`);
  } else {
    console.warn(
      `[mlx] not healthy after ${HEALTHY_TIMEOUT_MS / 1000}s — the server may still be loading; check the log above.`,
    );
  }
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mlx] received ${signal}, stopping model server`);
  await supervisor.stop();
  try {
    unlinkSync(MLX_SERVER_PID_PATH);
  } catch {
    // already gone — fine
  }
  console.log("[mlx] bye");
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
