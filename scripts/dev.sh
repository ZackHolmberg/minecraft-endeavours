#!/bin/bash
# Dev launcher: brings up the MC server in the background, then runs the
# orchestrator in the foreground for live logs / quick restart.
set -e
cd "$(dirname "$0")/.."

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

echo "Starting orchestrator (Ctrl-C to stop; MC server keeps running)..."
exec npm run dev
