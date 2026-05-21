#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Starting Minecraft server..."
docker compose up -d
echo "Server starting. Check status with: docker compose logs -f"
echo "It may take a few minutes to download Paper and generate the world on first run."
