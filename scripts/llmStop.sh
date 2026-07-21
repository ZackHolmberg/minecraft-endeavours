#!/bin/bash
# Stop the local model server supervisor started by ./scripts/llmStart.sh.
# Sends SIGTERM to the PID in .bot-runtime/mlx-server.pid; the supervisor's
# shutdown handler stops mlx_lm.server cleanly and removes the PID file.
set -e
cd "$(dirname "$0")/.."

PID_FILE=".bot-runtime/mlx-server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "llmStop: no PID file at $PID_FILE — nothing to stop."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "llmStop: stale PID file (process $PID is gone). Cleaning up."
  rm -f "$PID_FILE"
  exit 0
fi

echo "llmStop: sending SIGTERM to PID $PID..."
kill -TERM "$PID"

# Wait up to ~15s for graceful shutdown (supervisor stops the child server).
for i in $(seq 1 75); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "llmStop: model server stopped."
    rm -f "$PID_FILE"
    exit 0
  fi
  sleep 0.2
done

echo "llmStop: SIGTERM didn't take after 15s — escalating to SIGKILL."
kill -KILL "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
