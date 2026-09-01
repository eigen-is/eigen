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

# Counters, log/probe helpers, the dc() compose wrapper and the Result summary.
. "$(dirname "$0")/probe-lib.sh"

cd "$(dirname "$0")/.."

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
    # Override COMPOSE_PROFILES so down kills containers from every profile, not just the
    # profile the active scenario brought up. Without this, switching scenarios leaves a
    # stranded container that blocks the network from being recreated with a new subnet.
    COMPOSE_PROFILES=edge,static,mail dc down --remove-orphans >/dev/null 2>&1 || true
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
            bun install --frozen-lockfile >/dev/null
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
probe_smtp  "SMTP banner :25"   25
probe_imaps "IMAPS banner :993" 993
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
probe_smtp  "SMTP banner :25"   25
probe_imaps "IMAPS banner :993" 993
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
header "Scenario H — edge,mail with custom subnet (172.30.0.0/24)"
##############################################################################
# Verifies EIGEN_SUBNET / EIGEN_UNBOUND_IP can be overridden in lockstep — the failure mode
# we care about is postfix being unable to reach unbound for DNS, which would manifest as
# either compose-up timing out or the SMTP banner probe failing.
EIGEN_SUBNET=172.30.0.0/24 EIGEN_UNBOUND_IP=172.30.0.254 bring_up edge,mail
probe "/eigen/health"        "$BASE_HTTPS/eigen/health"        200 "OK"
probe_smtp  "SMTP banner :25"   25
probe_imaps "IMAPS banner :993" 993
tear_down

##############################################################################
header "Result"
##############################################################################
probe_summary
