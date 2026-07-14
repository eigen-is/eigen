#!/bin/bash
set -e
cd "$(dirname "$0")/.."

OUTPUT="${1:-./backups/eigen-snapshot-$(date +%Y%m%d-%H%M%S).tar.gz}"
mkdir -p "$(dirname "$OUTPUT")"

echo "Stopping eigen-api for a consistent snapshot..."
docker compose --env-file .env.production stop eigen-api
# Always bring the API back, even if tar fails — a backup must never leave the box down.
trap 'docker compose --env-file .env.production start eigen-api' EXIT

# Tar the quiesced tree: -wal/-shm files are captured intact, so the two server-level DBs
# (users3.db / eigen.db — never checkpointed on exit) restore crash-consistent, not torn.
echo "Archiving data/ + .env.production -> ${OUTPUT} ..."
tar -czf "$OUTPUT" data/ .env.production

echo "Snapshot complete: ${OUTPUT}"
