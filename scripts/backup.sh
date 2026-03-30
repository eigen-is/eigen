#!/bin/bash
set -e
cd "$(dirname "$0")/.."

BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"

echo "Creating backup..."
tar -czf "${BACKUP_DIR}/eigen-${TIMESTAMP}.tar.gz" \
    data/ .env.production 2>/dev/null || \
tar -czf "${BACKUP_DIR}/eigen-${TIMESTAMP}.tar.gz" data/

echo "Backup complete: ${BACKUP_DIR}/eigen-${TIMESTAMP}.tar.gz"
