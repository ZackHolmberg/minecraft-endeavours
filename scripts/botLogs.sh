#!/bin/bash
# Stream the running bot's log output. Read-only — does not start the MC
# server or the bot. Use `./scripts/start.sh` and `./scripts/botStart.sh`
# for that.
set -e
cd "$(dirname "$0")/.."

if [ -f .env ]; then set -a; . ./.env; set +a; fi

PID_FILE=".bot-runtime/bot.pid"
LOG_FILE=".bot-runtime/bot.log"

if ! nc -z "${MC_HOST:-localhost}" "${MC_PORT:-25565}" 2>/dev/null; then
  echo "botLogs: Minecraft server is not running on ${MC_HOST:-localhost}:${MC_PORT:-25565} — start it with ./scripts/start.sh."
  exit 1
fi

if [ ! -f "$PID_FILE" ]; then
  echo "botLogs: no bot is running — start one with ./scripts/botStart.sh."
  exit 1
fi

BOT_PID="$(cat "$PID_FILE")"
if [ -z "$BOT_PID" ] || ! kill -0 "$BOT_PID" 2>/dev/null; then
  echo "botLogs: stale PID file (process $BOT_PID is gone) — restart with ./scripts/botStart.sh."
  exit 1
fi

if [ ! -f "$LOG_FILE" ]; then
  echo "botLogs: log file $LOG_FILE doesn't exist yet — wait a moment after botStart and retry."
  exit 1
fi

echo "botLogs: tailing $LOG_FILE (Ctrl-C to detach; bot keeps running)."
exec tail -F "$LOG_FILE"
