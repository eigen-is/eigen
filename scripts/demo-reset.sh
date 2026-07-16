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

echo "[demo-reset] Stopping eigen-api..."
docker compose --env-file .env.production stop eigen-api
# Bring the API back on exit — but never onto an un-setup data root: a failed seed would
# otherwise serve the public first-run setup wizard to strangers. Left stopped, the next
# hourly run (or an operator) retries.
restart_api() {
    if [ -f data/server/.demo-seeded ]; then
        docker compose --env-file .env.production start eigen-api
    else
        echo "[demo-reset] Seed did not complete (no data/server/.demo-seeded); leaving eigen-api STOPPED." >&2
        exit 1
    fi
}
trap restart_api EXIT

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
