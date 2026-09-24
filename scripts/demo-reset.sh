#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# HARD SAFETY GATE: only ever run on a box explicitly flagged as a demo instance. Without this
# the script is physically unable to wipe a real box.
if [ ! -f .env.production ]; then
    echo "[demo-reset] Refusing: .env.production not found." >&2
    exit 1
fi
if ! grep -q '^EIGEN_DEMO=1$' .env.production; then
    echo "[demo-reset] Refusing: EIGEN_DEMO=1 not set in .env.production — this is not a demo box." >&2
    exit 1
fi

# The launcher's lock (see lock() in ./eigen), so a reset never wipes data/ under a backup or an update.
mkdir -p .eigen
if ! mkdir .eigen/lock 2>/dev/null; then
    pid=$(cat .eigen/lock/pid 2>/dev/null || :)
    # The lock of a process that is gone is taken over.
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "[demo-reset] Refusing: an ./eigen command holds .eigen/lock. The next hourly run retries." >&2
        exit 1
    fi
fi
echo $$ >.eigen/lock/pid

# Bring the API back on exit, but never onto an un-setup data root: a failed seed would otherwise
# leave strangers at the setup screen. Left stopped, the next hourly run (or an operator) retries.
finish() {
    code=$?
    if [ -f data/server/.demo-seeded ]; then
        docker compose --env-file .env.production start eigen-api || code=$?
    else
        echo "[demo-reset] Seed did not complete (no data/server/.demo-seeded); leaving eigen-api STOPPED." >&2
        code=1
    fi
    rm -rf .eigen/lock
    exit "$code"
}
trap finish EXIT

echo "[demo-reset] Stopping eigen-api..."
docker compose --env-file .env.production stop eigen-api

# Explicit list — never a wildcard. data/certs (Caddy) and data/dkim (mail) must survive.
echo "[demo-reset] Wiping per-home + server data..."
rm -rf data/server data/home data/team data/org data/guest

# Reseed in a throwaway container off the current image (--rm --no-deps). Absolute path: the
# image WORKDIR is /app/apps/api, so a repo-relative path would not resolve. The eigen-api
# service already provides EIGEN_DATA_ROOT / DOMAIN / MAIL_DOMAIN / EIGEN_DEMO to the container.
echo "[demo-reset] Seeding demo world..."
docker compose --env-file .env.production run --rm --no-deps eigen-api \
    bun run /app/apps/api/src/scripts/seed-demo.ts

echo "[demo-reset] Reseed complete; restarting eigen-api."
