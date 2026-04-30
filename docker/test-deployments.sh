#!/usr/bin/env bash
# Smoke-test the four deployment shapes (Caddy/static × mail-on/off) end-to-end.
#
# What it does: spins up each profile combination via the dev compose, curls the
# important URLs (landing, per-app SPAs, /eigen/health, WebSocket upgrade), asserts
# response codes + that each app serves its OWN bundle (not the landing page's), and
# tears down. Run before merging anything that touches setup.ts / docker-compose /
# Caddyfile / scripts/generate-env.sh.
#
# Usage:  ./docker/test-deployments.sh
# Needs:  docker, bun, the repo's dist/ already built (or we'll build it).

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0
FAIL_LINES=()

log()    { printf '  %s\n' "$*"; }
header() { printf '\n=== %s ===\n' "$*"; }

probe() {
    local desc="$1" url="$2" expected_code="$3" expected_pattern="${4:-}"
    local body=/tmp/eigen-smoke-body-$$
    local got_code
    got_code=$(curl -sk -o "$body" -w '%{http_code}' --max-time 10 "$url" || echo 000)
    if [ "$got_code" != "$expected_code" ]; then
        log "✗ $desc → $got_code (expected $expected_code)"
        FAIL=$((FAIL+1)); FAIL_LINES+=("$desc → $got_code, expected $expected_code")
    elif [ -n "$expected_pattern" ] && ! grep -q "$expected_pattern" "$body"; then
        log "✗ $desc → $got_code but body missing '$expected_pattern' (likely landing page served instead of app)"
        FAIL=$((FAIL+1)); FAIL_LINES+=("$desc body missing $expected_pattern")
    else
        log "✓ $desc → $got_code${expected_pattern:+ with $expected_pattern}"
        PASS=$((PASS+1))
    fi
    rm -f "$body"
}

probe_ws() {
    local desc="$1" url="$2"
    local got_code
    got_code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 \
        --http1.1 \
        -H 'Upgrade: websocket' \
        -H 'Connection: Upgrade' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
        -H 'Sec-WebSocket-Version: 13' \
        "$url" || echo 000)
    # 401 = auth gate reached → upgrade was correctly forwarded to the app.
    # 404 = upgrade headers got stripped, request landed as plain GET on a non-existent route.
    if [ "$got_code" = "401" ]; then
        log "✓ $desc → 401 (auth, upgrade pass-through OK)"
        PASS=$((PASS+1))
    else
        log "✗ $desc → $got_code (expected 401; 404 means upgrade headers were stripped)"
        FAIL=$((FAIL+1)); FAIL_LINES+=("WS at $url → $got_code, expected 401")
    fi
}

dc() {
    docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production "$@"
}

bring_up() {
    local profiles="$1"
    log "→ COMPOSE_PROFILES=$profiles up -d --wait"
    COMPOSE_PROFILES="$profiles" dc up -d --wait >/dev/null 2>&1 || {
        log "× compose failed; printing recent logs"
        dc logs --tail=30
        exit 1
    }
}

tear_down() {
    dc down --remove-orphans >/dev/null 2>&1 || true
}

ensure_env() {
    if [ ! -f .env.production ]; then
        log "Generating .env.production for localhost..."
        ./scripts/generate-env.sh localhost > .env.production
    fi
}

ensure_dist() {
    for app in mail sheets admin index; do
        if [ ! -f "dist/$app/index.html" ]; then
            log "dist/$app/index.html missing — building all apps (one-off, takes a few minutes)"
            set -a; source .env.production; set +a
            bun install >/dev/null
            bun run --sequential --filter './apps/*' build >/dev/null
            return
        fi
    done
}

ensure_static_image() {
    log "Building eigen-static image (idempotent)..."
    dc build eigen-static >/dev/null 2>&1
}

# --- main ---

ensure_env
ensure_dist
ensure_static_image
tear_down  # start clean

##############################################################################
header "Scenario A — edge,mail   (bundled Caddy + mail trio)"
##############################################################################
bring_up edge,mail
BASE_HTTPS=https://localhost
probe "/eigen/health"        "$BASE_HTTPS/eigen/health"        200 "OK"
probe "/ (landing)"          "$BASE_HTTPS/"                    200
probe "/mail/"               "$BASE_HTTPS/mail/"               200 '"/mail/assets/'
probe "/sheets/"             "$BASE_HTTPS/sheets/"             200 '"/sheets/assets/'
probe "/admin/"              "$BASE_HTTPS/admin/"              200 '"/admin/assets/'
probe_ws "WS /eigen/ws/collab/..." "$BASE_HTTPS/eigen/ws/collab/x/y/z"
tear_down

##############################################################################
header "Scenario B — static,mail (bundled static container + mail trio)"
##############################################################################
bring_up static,mail
BASE_HTTP=http://localhost:8080
probe "/eigen/health"        "$BASE_HTTP/eigen/health"         200 "OK"
probe "/ (landing)"          "$BASE_HTTP/"                     200
probe "/mail/"               "$BASE_HTTP/mail/"                200 '"/mail/assets/'
probe "/sheets/"             "$BASE_HTTP/sheets/"              200 '"/sheets/assets/'
probe "/admin/"              "$BASE_HTTP/admin/"               200 '"/admin/assets/'
probe_ws "WS /eigen/ws/collab/..." "$BASE_HTTP/eigen/ws/collab/x/y/z"
tear_down

##############################################################################
header "Scenario C — edge       (bundled Caddy, no mail)"
##############################################################################
bring_up edge
probe "/eigen/health"        "$BASE_HTTPS/eigen/health"        200 "OK"
probe "/ (landing)"          "$BASE_HTTPS/"                    200
probe "/mail/"               "$BASE_HTTPS/mail/"               200 '"/mail/assets/'
probe_ws "WS /eigen/ws/collab/..." "$BASE_HTTPS/eigen/ws/collab/x/y/z"
tear_down

##############################################################################
header "Scenario D — static     (bundled static, no mail)"
##############################################################################
bring_up static
probe "/eigen/health"        "$BASE_HTTP/eigen/health"         200 "OK"
probe "/ (landing)"          "$BASE_HTTP/"                     200
probe "/mail/"               "$BASE_HTTP/mail/"                200 '"/mail/assets/'
probe_ws "WS /eigen/ws/collab/..." "$BASE_HTTP/eigen/ws/collab/x/y/z"
tear_down

##############################################################################
header "Result"
##############################################################################
if [ "$FAIL" -eq 0 ]; then
    printf '✓ ALL OK (%d checks passed)\n' "$PASS"
    exit 0
else
    printf '✗ %d FAILURES (%d passed)\n' "$FAIL" "$PASS"
    for line in "${FAIL_LINES[@]}"; do printf '  - %s\n' "$line"; done
    exit 1
fi
