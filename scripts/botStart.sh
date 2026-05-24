#!/bin/bash
# Bot launcher (only entry point for starting the orchestrator).
#
# Gates on the MC server being reachable, refuses to double-start, then
# detaches the orchestrator into the background with stdout/stderr captured
# in `.bot-runtime/bot.log`. The orchestrator writes its own PID on boot.
#
# View what's happening with `./scripts/botLogs.sh` or `./scripts/dashboard.sh`.
# Stop it with `./scripts/botStop.sh`.
set -e
cd "$(dirname "$0")/.."

RUNTIME_DIR=".bot-runtime"
PID_FILE="$RUNTIME_DIR/bot.pid"
LOG_FILE="$RUNTIME_DIR/bot.log"
SNAPSHOT_FILE="$RUNTIME_DIR/snapshot.json"

# Source .env so the orchestrator inherits MC_VERSION (and friends) from the
# same file docker-compose uses — keeps server and bot client in lockstep.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Refuse to start if the MC server isn't reachable — the bot would just spin
# in its reconnect loop and dump confusing errors into the log.
if ! nc -z localhost 25565 2>/dev/null; then
  echo "botStart: Minecraft server is not reachable on localhost:25565."
  echo "botStart: Start it first with ./scripts/start.sh, then re-run this."
  exit 1
fi

# Refuse to start if an orchestrator is already running.
if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(cat "$PID_FILE")"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "botStart: bot already running (PID $EXISTING_PID). Use ./scripts/botStop.sh to stop it."
    exit 1
  fi
  # Stale PID file from a crash — clear it so we can boot fresh.
  rm -f "$PID_FILE"
fi

mkdir -p "$RUNTIME_DIR"
# Fresh log + snapshot per session so viewers don't get stale content.
: > "$LOG_FILE"
rm -f "$SNAPSHOT_FILE"

echo "botStart: starting orchestrator detached (logs → $LOG_FILE)..."
nohup npm run start >"$LOG_FILE" 2>&1 </dev/null &
# `$!` is npm's PID; the orchestrator writes its own PID to $PID_FILE on boot.

# Wait up to ~10s for the orchestrator to come up.
for i in $(seq 1 50); do
  if [ -f "$PID_FILE" ]; then
    BOT_PID="$(cat "$PID_FILE")"
    if kill -0 "$BOT_PID" 2>/dev/null; then
      echo "botStart: bot is up (PID $BOT_PID)."
      echo "botStart: tail logs: ./scripts/botLogs.sh"
      echo "botStart: dashboard: ./scripts/dashboard.sh"
      exit 0
    fi
  fi
  if [ "$i" -eq 50 ]; then
    echo "botStart: orchestrator never wrote its PID — check $LOG_FILE for the failure."
    exit 1
  fi
  sleep 0.2
done
