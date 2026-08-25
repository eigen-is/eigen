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
    add_var_if_missing MAIL_DOMAIN "$(grep '^DOMAIN=' .env.production | cut -d= -f2-)"
    add_var_if_missing EIGEN_DEMO 0
    add_var_if_missing VITE_APP_VECTOR_URL "/vector"

    # Migrate EIGEN_STATIC_BIND (single "ip:port" value) → EIGEN_STATIC_HOST + EIGEN_STATIC_PORT.
    # The compose long-form ports binding needs them split. If the user customised BIND
    # (e.g. EIGEN_STATIC_BIND=0.0.0.0:9090) we preserve their values; otherwise defaults
    # match the previous behaviour.
    if ! grep -q '^EIGEN_STATIC_HOST=' .env.production && ! grep -q '^EIGEN_STATIC_PORT=' .env.production; then
        old_bind=$(grep '^EIGEN_STATIC_BIND=' .env.production | cut -d= -f2- | tr -d '"' | tr -d "'")
        host=$(echo "$old_bind" | cut -d: -f1)
        port=$(echo "$old_bind" | cut -d: -f2)
        : "${host:=127.0.0.1}"
        : "${port:=8080}"
        echo "EIGEN_STATIC_HOST=${host}" >> .env.production
        echo "EIGEN_STATIC_PORT=${port}" >> .env.production
        echo "  Migrated: split EIGEN_STATIC_BIND → EIGEN_STATIC_HOST=${host}, EIGEN_STATIC_PORT=${port}"
    fi
fi

echo "Loading environment..."
set -a && source .env.production && set +a

# Capture build metadata so the API can surface it in the About dialog
export EIGEN_COMMIT=$(git rev-parse --short HEAD)
export EIGEN_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "Installing dependencies..."
bun install --frozen-lockfile

echo "Building frontend (sequential)..."
bun run --sequential --filter './apps/*' build

echo "Rebuilding containers..."
docker compose --env-file .env.production up -d --build

# Edge caddy bind-mounts the Caddyfile; `up -d` won't apply a config-only change, so reload.
if docker compose --env-file .env.production ps --services --status running 2>/dev/null | grep -qx caddy; then
    echo "Reloading Caddy config..."
    docker compose --env-file .env.production exec -T caddy \
        caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
fi

echo "Pruning unused Docker build cache and images..."
docker builder prune -f --filter "until=168h"
docker image prune -f

echo "Done. Status:"
docker compose --env-file .env.production ps
