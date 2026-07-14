#!/bin/bash
set -e
cd "$(dirname "$0")/.."

ARCHIVE="$1"
if [ -z "$ARCHIVE" ]; then
    echo "Usage: $(basename "$0") <archive.tar.gz>" >&2
    exit 1
fi
if [ ! -f "$ARCHIVE" ]; then
    echo "Archive not found: ${ARCHIVE}" >&2
    exit 1
fi

echo "Stopping eigen-api..."
docker compose --env-file .env.production stop eigen-api

# Never delete the current tree blind — move it aside so a bad archive stays recoverable.
ASIDE="data.pre-restore-$(date +%Y%m%d-%H%M%S)"
if [ -e data ]; then
    echo "Moving current data/ aside to ${ASIDE} ..."
    mv data "$ASIDE"
fi

# Archive carries data/ + .env.production (mirror of snapshot.sh/backup.sh), so this is a full restore.
echo "Restoring from ${ARCHIVE} ..."
tar -xzf "$ARCHIVE"

echo "Starting eigen-api..."
docker compose --env-file .env.production start eigen-api

echo "Restore complete. Previous tree preserved at ${ASIDE}."
