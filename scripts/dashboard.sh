#!/bin/bash
# Mount the read-only TUI dashboard against the running bot. Does not start
# the MC server or the bot — use `./scripts/start.sh` and
# `./scripts/botStart.sh` for that. Quitting the dashboard (q / Esc / Ctrl+C)
# only kills this viewer; the bot keeps running.
set -e
cd "$(dirname "$0")/.."

if [ -f .env ]; then set -a; . ./.env; set +a; fi

PID_FILE=".bot-runtime/bot.pid"
SNAPSHOT_FILE=".bot-runtime/snapshot.json"

if ! nc -z "${MC_HOST:-localhost}" "${MC_PORT:-25565}" 2>/dev/null; then
  echo "dashboard: Minecraft server is not running on ${MC_HOST:-localhost}:${MC_PORT:-25565} — start it with ./scripts/start.sh."
  exit 1
fi

if [ ! -f "$PID_FILE" ]; then
  echo "dashboard: no bot is running — start one with ./scripts/botStart.sh."
  exit 1
fi

BOT_PID="$(cat "$PID_FILE")"
if [ -z "$BOT_PID" ] || ! kill -0 "$BOT_PID" 2>/dev/null; then
  echo "dashboard: stale PID file (process $BOT_PID is gone) — restart with ./scripts/botStart.sh."
  exit 1
fi

# Wait briefly for the first snapshot. The dashboard itself also tolerates a
# missing snapshot file, but exiting here gives a clearer error message if
# the orchestrator never gets that far.
for i in $(seq 1 25); do
  [ -f "$SNAPSHOT_FILE" ] && break
  if [ "$i" -eq 25 ]; then
    echo "dashboard: no snapshot at $SNAPSHOT_FILE after 5s — check ./scripts/botLogs.sh."
    exit 1
  fi
  sleep 0.2
done

exec npm run dashboard
