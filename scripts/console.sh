#!/bin/bash
# Attach to the server console. Type commands directly, Ctrl+C to detach.
cd "$(dirname "$0")/.."
docker compose exec minecraft rcon-cli
