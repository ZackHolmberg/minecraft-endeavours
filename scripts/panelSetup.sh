#!/bin/bash
# Web control panel setup.
#
#   ./scripts/panelSetup.sh                     set admin password + enroll TOTP (interactive)
#   ./scripts/panelSetup.sh --install-launchd   install/refresh the LaunchAgent (start at login, restart on crash)
#   ./scripts/panelSetup.sh --uninstall-launchd stop and remove the LaunchAgent
#
# Secrets go to data/panel/secrets.json (mode 600, gitignored via data/).
set -e
cd "$(dirname "$0")/.."

LABEL="com.minecraft-endeavours.panel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="scripts/launchd/$LABEL.plist.template"
REPO="$(pwd -P)"

case "${1:-}" in
  --install-launchd)
    if [ ! -f data/panel/secrets.json ]; then
      echo "panelSetup: set credentials first (run ./scripts/panelSetup.sh with no arguments)."
      exit 1
    fi
    case "$REPO" in *"&"*|*"<"*|*">"*|*"|"*) echo "panelSetup: repo path has characters unsafe for a plist: $REPO"; exit 1 ;; esac
    NODE_BIN="$(command -v node || true)"
    case "$NODE_BIN" in /*) ;; *) echo "panelSetup: node not found on PATH (as an absolute path)."; exit 1 ;; esac
    NODE_DIR="$(dirname "$NODE_BIN")"
    DOCKER_DIR="$(dirname "$(command -v docker 2>/dev/null || echo /usr/local/bin/docker)")"
    case "$DOCKER_DIR" in /*) ;; *) DOCKER_DIR="/usr/local/bin" ;; esac
    LAUNCH_PATH="$NODE_DIR:$DOCKER_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    # Every entry is absolute (a relative one would resolve against the repo); no sed/XML metacharacters.
    case "$LAUNCH_PATH" in *"&"*|*"<"*|*">"*|*"|"*|*"::"*) echo "panelSetup: unsafe PATH for the plist: $LAUNCH_PATH"; exit 1 ;; esac
    mkdir -p "$HOME/Library/LaunchAgents" data/panel
    chmod 700 data/panel
    sed -e "s|__REPO__|$REPO|g" -e "s|__PATH__|$LAUNCH_PATH|g" "$TEMPLATE" > "$PLIST.tmp"
    plutil -lint "$PLIST.tmp" >/dev/null
    mv "$PLIST.tmp" "$PLIST"
    chmod 644 "$PLIST"
    # Stop any script-started instance so launchd owns the process.
    [ -f data/panel/panel.pid ] && ./scripts/panelStop.sh >/dev/null 2>&1 || true
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "panelSetup: LaunchAgent installed at $PLIST and started."
    echo "panelSetup: logs → data/panel/panel.log ; status: launchctl print gui/$(id -u)/$LABEL | head"
    ;;
  --uninstall-launchd)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "panelSetup: LaunchAgent removed."
    ;;
  "")
    exec ./node_modules/.bin/tsx src/web/server/setup.ts
    ;;
  *)
    sed -n '2,9p' "$0"
    exit 2
    ;;
esac
