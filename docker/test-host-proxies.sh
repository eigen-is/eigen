#!/usr/bin/env bash
# Smoke-test nginx, Apache, and Caddy in front of the bundled `eigen-static` container —
# the host-webserver path that scripts/setup.ts generates snippets for. Brings up
# `static,mail`, then for each webserver runs a containerised instance attached to the
# eigen network with an adapted version of the snippet (plain HTTP, eigen-static:8080
# instead of 127.0.0.1:8080). Probes the same set of URLs as test-deployments.sh.
#
# Usage:  ./docker/test-host-proxies.sh
# Needs:  docker, .env.production, dist/ already built (or run test-deployments.sh first).

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0
FAIL_LINES=()

log()    { printf '  %s\n' "$*"; }
header() { printf '\n=== %s ===\n' "$*"; }

probe() {
    local desc="$1" url="$2" expected_code="$3" expected_pattern="${4:-}"
    local body=/tmp/eigen-host-proxy-body-$$
    local got_code
    got_code=$(curl -sk -o "$body" -w '%{http_code}' --max-time 10 "$url" || echo 000)
    if [ "$got_code" != "$expected_code" ]; then
        log "✗ $desc → $got_code (expected $expected_code)"
        FAIL=$((FAIL+1)); FAIL_LINES+=("$desc → $got_code, expected $expected_code")
    elif [ -n "$expected_pattern" ] && ! grep -q "$expected_pattern" "$body"; then
        log "✗ $desc → $got_code but body missing '$expected_pattern'"
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
    # 401 = auth gate reached → upgrade was correctly forwarded.
    # 404 / 426 / etc = upgrade headers lost in translation.
    if [ "$got_code" = "401" ]; then
        log "✓ $desc → 401 (auth, upgrade pass-through OK)"
        PASS=$((PASS+1))
    else
        log "✗ $desc → $got_code (expected 401)"
        FAIL=$((FAIL+1)); FAIL_LINES+=("WS at $url → $got_code, expected 401")
    fi
}

probe_smtp() {
    local desc="$1" port="$2"
    local banner=""
    for _ in 1 2 3 4 5; do
        banner=$(printf 'QUIT\r\n' | nc -w 5 localhost "$port" 2>/dev/null | head -1 || true)
        echo "$banner" | grep -q '^220 ' && break
        sleep 1
    done
    if echo "$banner" | grep -q '^220 '; then
        log "✓ $desc → 220 banner"
        PASS=$((PASS+1))
    else
        log "✗ $desc → '$banner' (expected SMTP 220 banner)"
        FAIL=$((FAIL+1)); FAIL_LINES+=("SMTP banner on port $port: '$banner'")
    fi
}

probe_imaps() {
    local desc="$1" port="$2"
    local banner=""
    for _ in 1 2 3 4 5; do
        banner=$(echo 'a logout' | openssl s_client -connect "localhost:$port" -quiet 2>/dev/null | head -1 || true)
        echo "$banner" | grep -q '^\* OK ' && break
        sleep 1
    done
    if echo "$banner" | grep -q '^\* OK '; then
        log "✓ $desc → '* OK' greeting"
        PASS=$((PASS+1))
    else
        log "✗ $desc → '$banner' (expected '* OK ...')"
        FAIL=$((FAIL+1)); FAIL_LINES+=("IMAPS banner on port $port: '$banner'")
    fi
}

dc() {
    docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production "$@"
}

NETWORK=eigen_eigen
CONTAINERS=(test-proxy-nginx test-proxy-apache test-proxy-caddy)

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
    -p 8081:80 \
    -v "$PWD/docker/test-proxies/nginx-test.conf:/etc/nginx/conf.d/default.conf:ro" \
    nginx:alpine >/dev/null
# Give nginx a moment to start listening.
sleep 1
run_probes http://localhost:8081
docker rm -f test-proxy-nginx >/dev/null 2>&1

##############################################################################
header "Scenario F — static,mail behind Caddy"
##############################################################################
docker run -d --rm --name test-proxy-caddy \
    --network "$NETWORK" \
    -p 8082:80 \
    -v "$PWD/docker/test-proxies/caddy-test.Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2-alpine >/dev/null
sleep 1
run_probes http://localhost:8082
docker rm -f test-proxy-caddy >/dev/null 2>&1

##############################################################################
header "Scenario G — static,mail behind Apache"
##############################################################################
docker run -d --rm --name test-proxy-apache \
    --network "$NETWORK" \
    -p 8083:80 \
    -v "$PWD/docker/test-proxies/apache-test.conf:/usr/local/apache2/conf/httpd.conf:ro" \
    httpd:2.4 >/dev/null
sleep 2
run_probes http://localhost:8083
docker rm -f test-proxy-apache >/dev/null 2>&1

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
