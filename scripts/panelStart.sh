#!/bin/bash
# Start the web control panel.
#
#   ./scripts/panelStart.sh         production (HTTPS on PANEL_PORT, default 8443, Let's Encrypt cert)
#   ./scripts/panelStart.sh --dev   local testing (self-signed cert, 127.0.0.1 only)
#   ./scripts/panelStart.sh --launchd   (used by the LaunchAgent) build UI if needed, run in the foreground
#
# src/web/ui/dist is gitignored, so every start path rebuilds it (npm run ui:build)
# when it's missing or older than the UI sources.
#
# If the LaunchAgent is installed (panelSetup.sh --install-launchd), production
# mode defers to launchd. Otherwise the panel is detached with nohup; logs go to
# data/panel/panel.log (panel-dev.log for --dev).
set -e
cd "$(dirname "$0")/.."

LABEL="com.minecraft-endeavours.panel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MODE="prod"
[ "${1:-}" = "--dev" ] && MODE="dev"

UI_DIST="src/web/ui/dist/index.html"
# Build the UI when dist is missing or any UI source / the shared API contract is newer.
# A failed build is not fatal: the panel then serves the previous build or its placeholder page.
ensure_ui() {
  local stale=""
  if [ ! -f "$UI_DIST" ]; then
    stale="missing"
  elif [ -n "$(find src/web/ui/src src/web/ui/public src/web/ui/index.html src/web/ui/vite.config.ts src/web/shared \
                 -newer "$UI_DIST" -print -quit 2>/dev/null)" ]; then
    stale="out of date"
  fi
  [ -z "$stale" ] && return 0
  echo "panelStart: web UI build $stale — running npm run ui:build..."
  if ! npm run --silent ui:build; then
    echo "panelStart: WARNING: UI build failed; continuing with the existing build (if any)." >&2
  fi
}

if [ "${1:-}" = "--launchd" ]; then
  ensure_ui || true
  exec ./node_modules/.bin/tsx src/web/server/index.ts
fi

if [ "$MODE" = "prod" ] && [ -f "$PLIST" ]; then
  ensure_ui   # launchd's --launchd entry also does this; building here surfaces errors in the terminal
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart "gui/$(id -u)/$LABEL"
  else
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi
  echo "panelStart: started via launchd ($LABEL). Logs: data/panel/panel.log"
  exit 0
fi

mkdir -p data/panel
chmod 700 data/panel
if [ "$MODE" = "dev" ]; then
  PID_FILE="data/panel/panel-dev.pid"; LOG_FILE="data/panel/panel-dev.log"; ARGS=(--dev)
else
  PID_FILE="data/panel/panel.pid"; LOG_FILE="data/panel/panel.log"; ARGS=()
fi

if [ -f "$PID_FILE" ]; then
  EXISTING="$(cat "$PID_FILE")"
  if [ -n "$EXISTING" ] && kill -0 "$EXISTING" 2>/dev/null; then
    echo "panelStart: panel already running (PID $EXISTING). Use ./scripts/panelStop.sh."
    exit 1
  fi
  rm -f "$PID_FILE"
fi

if [ ! -f data/panel/secrets.json ] && [ -z "${PANEL_SECRETS_FILE:-}" ]; then
  echo "panelStart: no credentials yet — run ./scripts/panelSetup.sh first."
  exit 1
fi

ensure_ui

echo "panelStart: starting panel ($MODE) detached (logs → $LOG_FILE)..."
( umask 077; nohup ./node_modules/.bin/tsx src/web/server/index.ts "${ARGS[@]}" >>"$LOG_FILE" 2>&1 </dev/null & )

for i in $(seq 1 50); do
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "panelStart: panel is up (PID $(cat "$PID_FILE"))."
    exit 0
  fi
  sleep 0.2
done
echo "panelStart: panel didn't come up within 10s — check $LOG_FILE."
exit 1
