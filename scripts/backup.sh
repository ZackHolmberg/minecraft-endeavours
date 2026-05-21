#!/bin/bash
set -e
cd "$(dirname "$0")/.."

BACKUP_DIR="./backups"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="$BACKUP_DIR/world_$TIMESTAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

echo "Saving world before backup..."
docker compose exec minecraft rcon-cli save-all
sleep 3

echo "Creating backup: $BACKUP_FILE"
tar -czf "$BACKUP_FILE" -C ./data world world_nether world_the_end 2>/dev/null || \
  tar -czf "$BACKUP_FILE" -C ./data world 2>/dev/null

echo "Backup complete: $BACKUP_FILE"

# Keep only the 10 most recent backups
ls -t "$BACKUP_DIR"/world_*.tar.gz 2>/dev/null | tail -n +11 | xargs rm -f
echo "Old backups pruned (keeping last 10)."
