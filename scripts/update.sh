#!/bin/bash
set -e
SCRIPT="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SCRIPT")/.."

# Pull first, then re-exec under the (possibly newly-pulled) version of this script. This
# ensures any new migration logic added in a future update runs on that same update — not
# only on the next one.
if [ "$1" != "--post-pull" ]; then
    echo "Pulling latest changes..."
    git pull
    exec "$SCRIPT" --post-pull
fi

# --- migration: backfill env vars introduced since the user last ran update ---
add_var_if_missing() {
    local key="$1" default="$2"
    if ! grep -q "^${key}=" .env.production; then
        echo "${key}=${default}" >> .env.production
        echo "  Migrated: appended ${key}=${default}"
    fi
}

if [ -f .env.production ]; then
    echo "Checking .env.production for new variables..."
    add_var_if_missing COMPOSE_PROFILES "edge,mail"
    add_var_if_missing EIGEN_STATIC_BIND "127.0.0.1:8080"
    add_var_if_missing MAIL_DOMAIN "$(grep '^DOMAIN=' .env.production | cut -d= -f2-)"
fi

echo "Loading environment..."
set -a && source .env.production && set +a

echo "Installing dependencies..."
bun install

echo "Building frontend (sequential)..."
bun run --sequential --filter './apps/*' build

echo "Building API bundle..."
bun --filter '@apps/api' buildfordocker

echo "Setting data directory permissions..."
mkdir -p data
chown -R 1000:1000 data

echo "Rebuilding containers..."
docker compose --env-file .env.production up -d --build

echo "Done. Status:"
docker compose --env-file .env.production ps
