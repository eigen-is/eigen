#!/usr/bin/env bash
# Smoke-test nginx, Apache, and Caddy in front of the bundled `eigen-static` container —
# the host-webserver path that scripts/setup.ts generates snippets for. Brings up
# `static,mail`, then for each webserver runs a containerised instance attached to the
# eigen network with an adapted version of the snippet (plain HTTP, eigen-static:8080
# instead of 127.0.0.1:8080). Probes the same set of URLs as test-deployments.sh.
#
# Usage:  ./docker/test-host-proxies.sh
#         PROXY_PORT=9081 ./docker/test-host-proxies.sh   # when 8081-8083 are taken on this host
# Needs:  docker, .env.production, dist/ already built (or run test-deployments.sh first).

set -euo pipefail

# Counters, log/probe helpers, the dc() compose wrapper and the Result summary.
. "$(dirname "$0")/probe-lib.sh"

cd "$(dirname "$0")/.."

# Compose names the network <project>_eigen and derives the project from this directory's
# name (lowercased, invalid chars stripped) — assume neither, or every worktree attaches
# the proxies to a network without eigen-static and all scenarios fail.
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')}"
NETWORK="${PROJECT}_eigen"
CONTAINERS=(test-proxy-nginx test-proxy-apache test-proxy-caddy)
# Host port for the first throwaway proxy; the other two take the next two ports.
PROXY_PORT="${PROXY_PORT:-8081}"

cleanup() {
    docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true
    COMPOSE_PROFILES=edge,static,mail dc down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Probe a set of URLs through whichever proxy port is currently exposed.
run_probes() {
    local base="$1"
    probe "/eigen/health"  "$base/eigen/health"  200 "OK"
    probe "/ (landing)"    "$base/"              200
    probe "/mail/"         "$base/mail/"         200 '"/mail/assets/'
    probe "/sheets/"       "$base/sheets/"       200 '"/sheets/assets/'
    probe "/admin/"        "$base/admin/"        200 '"/admin/assets/'
    probe_ws "WS /eigen/ws/collab/..." "$base/eigen/ws/collab/x/y/z"
}

# --- ensure prerequisites ---

if [ ! -f .env.production ]; then
    log "Generating .env.production for localhost..."
    ./scripts/generate-env.sh localhost > .env.production
fi

for app in mail sheets admin index; do
    if [ ! -f "dist/$app/index.html" ]; then
        echo "dist/ missing — run test-deployments.sh first (or build manually)" >&2
        exit 1
    fi
done

cleanup  # start clean
log "Building eigen-static image..."
dc build eigen-static >/dev/null 2>&1

log "Bringing up static,mail (eigen-static will be the upstream)..."
COMPOSE_PROFILES=static,mail dc up -d --wait >/dev/null 2>&1 || {
    log "× compose failed; recent logs:"
    dc logs --tail=30
    exit 1
}

# Mail ports are bound on the host directly by postfix/dovecot regardless of which proxy
# sits in front, so probe them once before iterating through the webservers.
header "Mail trio (postfix + dovecot, behind any host webserver)"
probe_smtp  "SMTP banner :25"   25
probe_imaps "IMAPS banner :993" 993

##############################################################################
header "Scenario E — static,mail behind nginx"
##############################################################################
docker run -d --rm --name test-proxy-nginx \
    --network "$NETWORK" \
    -p "$PROXY_PORT:80" \
    -v "$PWD/docker/test-proxies/nginx-test.conf:/etc/nginx/conf.d/default.conf:ro" \
    nginx:alpine >/dev/null
# Give nginx a moment to start listening.
sleep 1
run_probes "http://localhost:$PROXY_PORT"
docker rm -f test-proxy-nginx >/dev/null 2>&1

##############################################################################
header "Scenario F — static,mail behind Caddy"
##############################################################################
docker run -d --rm --name test-proxy-caddy \
    --network "$NETWORK" \
    -p "$((PROXY_PORT + 1)):80" \
    -v "$PWD/docker/test-proxies/caddy-test.Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2-alpine >/dev/null
sleep 1
run_probes "http://localhost:$((PROXY_PORT + 1))"
docker rm -f test-proxy-caddy >/dev/null 2>&1

##############################################################################
header "Scenario G — static,mail behind Apache"
##############################################################################
docker run -d --rm --name test-proxy-apache \
    --network "$NETWORK" \
    -p "$((PROXY_PORT + 2)):80" \
    -v "$PWD/docker/test-proxies/apache-test.conf:/usr/local/apache2/conf/httpd.conf:ro" \
    httpd:2.4 >/dev/null
sleep 2
run_probes "http://localhost:$((PROXY_PORT + 2))"
docker rm -f test-proxy-apache >/dev/null 2>&1

##############################################################################
header "Result"
##############################################################################
probe_summary
