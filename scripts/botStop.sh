#!/bin/bash
# Stop the orchestrator started by ./scripts/botInit.sh.
# Sends SIGTERM to the PID written in .bot-runtime/bot.pid; the orchestrator's
# shutdown handler disconnects bots cleanly and removes the PID file itself.
set -e
cd "$(dirname "$0")/.."

PID_FILE=".bot-runtime/bot.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "botStop: no bot PID file at $PID_FILE — nothing to stop."
  exit 0
fi

BOT_PID="$(cat "$PID_FILE")"
if [ -z "$BOT_PID" ] || ! kill -0 "$BOT_PID" 2>/dev/null; then
  echo "botStop: stale PID file (process $BOT_PID is gone). Cleaning up."
  rm -f "$PID_FILE"
  exit 0
fi

echo "botStop: sending SIGTERM to PID $BOT_PID..."
kill -TERM "$BOT_PID"

# Wait up to ~15s for graceful shutdown.
for i in $(seq 1 75); do
  if ! kill -0 "$BOT_PID" 2>/dev/null; then
    echo "botStop: bot stopped."
    rm -f "$PID_FILE"
    exit 0
  fi
  sleep 0.2
done

echo "botStop: SIGTERM didn't take after 15s — escalating to SIGKILL."
kill -KILL "$BOT_PID" 2>/dev/null || true
rm -f "$PID_FILE"
