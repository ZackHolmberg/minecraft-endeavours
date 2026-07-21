#!/bin/bash
# Local model server launcher (only entry point for starting mlx_lm.server).
#
# Mirrors botStart.sh: refuses to double-start, then detaches a supervisor that
# spawns + restarts mlx_lm.server, capturing output in .bot-runtime/mlx-server.log.
# The supervisor writes its own PID to .bot-runtime/mlx-server.pid.
#
# Independent of the orchestrator — a bot with `backend: local` in config/bots.yml
# just connects to the endpoint. Stop it with ./scripts/llmStop.sh.
set -e
cd "$(dirname "$0")/.."

RUNTIME_DIR=".bot-runtime"
PID_FILE="$RUNTIME_DIR/mlx-server.pid"
LOG_FILE="$RUNTIME_DIR/mlx-server.log"

# Source .env so MLX_MODEL / MLX_HOST / MLX_PORT overrides (if any) are inherited.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

MLX_HOST="${MLX_HOST:-127.0.0.1}"
MLX_PORT="${MLX_PORT:-8080}"
SERVER_BIN="${MLX_SERVER_BIN:-.venv/bin/mlx_lm.server}"

if [ ! -x "$SERVER_BIN" ]; then
  echo "llmStart: mlx_lm.server not found/executable at $SERVER_BIN."
  echo "llmStart: create the venv and install mlx-lm first (see spikes/MLX_NOTES.md)."
  exit 1
fi

# Refuse to start if a supervisor is already running.
if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(cat "$PID_FILE")"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "llmStart: model server already running (PID $EXISTING_PID). Use ./scripts/llmStop.sh."
    exit 1
  fi
  rm -f "$PID_FILE"
fi

mkdir -p "$RUNTIME_DIR"
: > "$LOG_FILE"

echo "llmStart: starting model server supervisor detached (logs → $LOG_FILE)..."
nohup npm run llm:start >"$LOG_FILE" 2>&1 </dev/null &

# Wait for the supervisor to write its PID (fast).
for i in $(seq 1 50); do
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    break
  fi
  if [ "$i" -eq 50 ]; then
    echo "llmStart: supervisor never wrote its PID — check $LOG_FILE."
    exit 1
  fi
  sleep 0.2
done
echo "llmStart: supervisor up (PID $(cat "$PID_FILE")). Waiting for the model to load..."

# Poll the endpoint until it answers. Cold 14B load + first prompt-processing
# can take a while, so allow ~180s.
for i in $(seq 1 180); do
  if curl -s -m 2 "http://$MLX_HOST:$MLX_PORT/v1/models" >/dev/null 2>&1; then
    echo "llmStart: model server is ready at http://$MLX_HOST:$MLX_PORT/v1"
    exit 0
  fi
  sleep 1
done

echo "llmStart: model still not answering after 180s — it may still be loading."
echo "llmStart: check $LOG_FILE; the supervisor is running and will keep trying."
exit 0
