#!/bin/bash
# Stop the web control panel. Does not touch the Minecraft server or the bot.
#
#   ./scripts/panelStop.sh         production instance (unloads the LaunchAgent if installed,
#                                  so launchd stops restarting it until panelStart.sh / next login)
#   ./scripts/panelStop.sh --dev   the --dev instance
set -e
cd "$(dirname "$0")/.."

LABEL="com.minecraft-endeavours.panel"
if [ "${1:-}" = "--dev" ]; then
  PID_FILE="data/panel/panel-dev.pid"
else
  PID_FILE="data/panel/panel.pid"
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$LABEL"
    # bootout returns before launchd finishes tearing the service down; wait so
    # an immediate panelStart.sh can bootstrap it again (else it fails quietly).
    for _ in $(seq 1 50); do
      launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
      sleep 0.2
    done
    echo "panelStop: LaunchAgent stopped (will start again at next login, or run ./scripts/panelStart.sh)."
    exit 0
  fi
fi

if [ ! -f "$PID_FILE" ]; then
  echo "panelStop: no panel PID file — nothing to stop."
  exit 0
fi
PID="$(cat "$PID_FILE")"
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "panelStop: stale PID file. Cleaning up."
  rm -f "$PID_FILE"
  exit 0
fi
kill -TERM "$PID"
for i in $(seq 1 50); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "panelStop: panel stopped."
    exit 0
  fi
  sleep 0.2
done
kill -KILL "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "panelStop: panel killed after 10s."
