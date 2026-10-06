#!/bin/bash
# Print a post-session performance report from the bot's telemetry JSONL
# (data/orchestrator/telemetry/<bot>/events*.jsonl). Read-only — does not
# start the MC server or the bot, and unlike botLogs.sh / dashboard.sh it
# works while the bot is down, since it reads the files directly.
#
#   ./scripts/botReport.sh [--bot Steve_AI] [--since run|today|all|2h] [--json] [--dir PATH]
set -e
cd "$(dirname "$0")/.."

TELEMETRY_DIR="${BOT_TELEMETRY_DIR:-data/orchestrator/telemetry}"
for arg in "$@"; do
  case "$arg" in
    --dir|--dir=*) TELEMETRY_DIR="" ;;  # caller supplied a path; let the CLI validate it
  esac
done

if [ -n "$TELEMETRY_DIR" ] && [ ! -d "$TELEMETRY_DIR" ]; then
  echo "botReport: no telemetry at $TELEMETRY_DIR yet — run the bot (./scripts/botStart.sh) for a session first."
  exit 1
fi

# --silent keeps npm's script banner out of the report (and out of --json output).
exec npm run --silent report -- "$@"
