/**
 * Filesystem locations shared between the orchestrator (writer) and the
 * dashboard client (reader). All paths sit under `.bot-runtime/` at the
 * repo root and are scrubbed when the bot stops. The shell scripts in
 * `scripts/` use the same layout — keep them in sync if anything moves.
 */
import { resolve } from "node:path";

export const RUNTIME_DIR = resolve(process.cwd(), ".bot-runtime");
export const SNAPSHOT_PATH = resolve(RUNTIME_DIR, "snapshot.json");
export const LOG_PATH = resolve(RUNTIME_DIR, "bot.log");
export const PID_PATH = resolve(RUNTIME_DIR, "bot.pid");

// Local model server (mlx_lm.server) supervisor — started/stopped independently
// of the orchestrator via scripts/llmStart.sh / llmStop.sh.
export const MLX_SERVER_PID_PATH = resolve(RUNTIME_DIR, "mlx-server.pid");
export const MLX_SERVER_LOG_PATH = resolve(RUNTIME_DIR, "mlx-server.log");
