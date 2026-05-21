#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Stopping Minecraft server (world will be saved)..."
docker compose stop
echo "Server stopped."
