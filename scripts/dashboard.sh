#!/bin/bash
# Dashboard launcher: same as dev.sh but mounts the TUI dashboard alongside
# the orchestrator. No tsx watch (blessed and hot reload don't mix). Quit
# with q / Esc / Ctrl+C from the dashboard.
set -e
cd "$(dirname "$0")/.."

# Source .env so the orchestrator inherits MC_VERSION (and friends) from the
# same file docker-compose uses — keeps server and bot client in lockstep.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

echo "Ensuring Minecraft server is up..."
docker compose up -d minecraft

echo "Waiting for server to accept connections on :25565..."
for i in $(seq 1 60); do
  if nc -z localhost 25565 2>/dev/null; then
    echo "Server is reachable."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "Timed out waiting for server. Check 'docker compose logs minecraft'."
    exit 1
  fi
  sleep 2
done

echo "Starting orchestrator + dashboard (q / Esc / Ctrl+C to stop; MC server keeps running)..."
exec npm run dashboard
