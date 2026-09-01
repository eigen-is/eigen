# Shared scaffolding for the docker/test-*.sh probe scripts: the pass/fail bookkeeping, the log
# helpers, the compose wrapper they all drive the stack with, the HTTP/SMTP/IMAPS probes, and the
# Result summary. Sourced, never run:
#
#   . "$(dirname "$0")/probe-lib.sh"
#
# Source it before the `cd` to the repo root, or `dirname $0` no longer points here. Everything in
# here must stay bash 3.2 clean, because that is what macOS ships.

PASS=0
FAIL=0
SKIP=0
# Only ever expanded inside a `FAIL > 0` branch: bash 3.2 with `set -u` treats an empty array as
# unbound and would exit instead of printing the summary.
FAIL_LINES=()

log()    { printf '  %s\n' "$*"; }
header() { printf '\n=== %s ===\n' "$*"; }
ok()     { log "✓ $*"; PASS=$((PASS+1)); }
fail()   { log "✗ $*"; FAIL=$((FAIL+1)); FAIL_LINES+=("$*"); }
skip()   { log "– skipped: $*"; SKIP=$((SKIP+1)); }

# Every script drives the same stack: base compose plus the dev overlay, with the production env file.
dc() {
    docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production "$@"
}

probe() {
    local desc="$1" url="$2" expected_code="$3" expected_pattern="${4:-}"
    local body=/tmp/eigen-probe-body-$$
    local got_code
    got_code=$(curl -sk -o "$body" -w '%{http_code}' --max-time 10 "$url" || echo 000)
    if [ "$got_code" != "$expected_code" ]; then
        fail "$desc → $got_code, expected $expected_code"
    elif [ -n "$expected_pattern" ] && ! grep -q "$expected_pattern" "$body"; then
        fail "$desc → $got_code but body missing '$expected_pattern' (likely the landing page served instead of the app)"
    else
        ok "$desc → $got_code${expected_pattern:+ with $expected_pattern}"
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
    # 401 = auth gate reached → the upgrade was correctly forwarded to the app.
    # 404 (or 426, …) = the upgrade headers got lost in translation and the request landed as a
    # plain GET on a route that does not exist.
    if [ "$got_code" = "401" ]; then
        ok "$desc → 401 (auth, upgrade pass-through OK)"
    else
        fail "WS at $url → $got_code, expected 401"
    fi
}

# Postfix should send a 220 SMTP banner as soon as the TCP connection is open. Doubles as proof that
# postfix could resolve unbound's IP and start cleanly — the part that breaks when EIGEN_SUBNET /
# EIGEN_UNBOUND_IP get out of sync. Retries because postfix has no healthcheck, so `compose up
# --wait` returns before the listener is fully accepting.
probe_smtp() {
    local desc="$1" port="$2"
    local banner=""
    for _ in 1 2 3 4 5; do
        banner=$(printf 'QUIT\r\n' | nc -w 5 localhost "$port" 2>/dev/null | head -1 || true)
        echo "$banner" | grep -q '^220 ' && break
        sleep 1
    done
    if echo "$banner" | grep -q '^220 '; then
        ok "$desc → 220 banner"
    else
        fail "SMTP banner on port $port: '$banner'"
    fi
}

# Dovecot IMAPS speaks IMAP over TLS. Sending `a logout` keeps the connection open long enough for
# openssl to emit the `* OK ...` greeting before exiting.
probe_imaps() {
    local desc="$1" port="$2"
    local banner=""
    for _ in 1 2 3 4 5; do
        banner=$(echo 'a logout' | openssl s_client -connect "localhost:$port" -quiet 2>/dev/null | head -1 || true)
        echo "$banner" | grep -q '^\* OK ' && break
        sleep 1
    done
    if echo "$banner" | grep -q '^\* OK '; then
        ok "$desc → '* OK' greeting"
    else
        fail "IMAPS banner on port $port: '$banner'"
    fi
}

# The tally, and the script's exit: 0 when nothing failed, 1 otherwise. Callers print their own
# "Result" header first, so a script can put its own guard (see test-mail-hardening.sh) above this.
probe_summary() {
    local skipped=''
    if [ "$SKIP" -gt 0 ]; then skipped=", $SKIP skipped"; fi

    if [ "$FAIL" -eq 0 ]; then
        printf '✓ ALL OK (%d checks passed%s)\n' "$PASS" "$skipped"
        exit 0
    fi
    printf '✗ %d FAILURES (%d passed%s)\n' "$FAIL" "$PASS" "$skipped"
    for line in "${FAIL_LINES[@]}"; do printf '  - %s\n' "$line"; done
    exit 1
}
