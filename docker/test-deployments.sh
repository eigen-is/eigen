#!/usr/bin/env bash
# Smoke-test the deployment shapes (Caddy/static × mail on/off, plus a custom subnet) end to end.
#
# What it does: installs a scratch copy of this working tree with ./eigen setup from the no-Bun docker:cli
# container, then reruns setup with each shape's flags on the same install, so every image is built in
# Docker and every switch between shapes goes through the launcher. Per shape it curls the important URLs
# (landing, per-app SPAs, /eigen/health, WebSocket upgrade) on the harness ports, asserts each app serves its
# OWN bundle (not the landing page's), and probes the mail ports. Without mail, Mailpit is the outgoing relay.
#
# Usage:  ./docker/test-deployments.sh
# Needs:  docker, curl, nc, openssl, git.

set -euo pipefail

# Counters, log/probe helpers, the scratch installs and the Result summary.
. "$(dirname "$0")/probe-lib.sh"

bring_up() {
    local started=$SECONDS
    log "→ ./eigen setup $*"
    if run_setup --user "$(id -u):$(id -g)" --yes --domain localhost --mail-domain eigen.test \
        --contact-email admin@eigen.test "$@" >"$SCRATCH/setup.log" 2>&1; then
        log "  up in $((SECONDS - started))s"
    else
        log "× setup failed after $((SECONDS - started))s:"
        sed 's/^/    /' "$SCRATCH/setup.log"
        dc logs --tail=30 || true
        exit 1
    fi
}

tear_down() {
    # Every profile, so down also removes the containers of a shape the next one does not use.
    COMPOSE_PROFILES=edge,static,mail dc down -v --remove-orphans >/dev/null 2>&1 || true
}

# The API relays through Mailpit when Eigen hosts no mail.
probe_relay() {
    local host
    host=$(dc exec -T eigen-api printenv SMTP_HOST | tr -d '\r' || true)
    if [ "$host" = mailpit ]; then
        ok "eigen-api relays through mailpit"
    else
        fail "eigen-api SMTP_HOST is '$host', expected mailpit"
    fi
}

# A share notification sent through the Mailpit relay: From "<admin> via …" <system sender>, Reply-To the
# admin. Needs the admin created through the setup link, which U6 adds.
probe_share_mail() {
    skip "share notification through Mailpit (needs the setup link)"
}

scratch_init deploy
new_install "eigentestdeploy$$"
write_override --mailpit
BASE_HTTPS="https://localhost:$PORT_HTTPS"
BASE_HTTP="http://127.0.0.1:$PORT_STATIC"

##############################################################################
header "Scenario A — edge,mail   (bundled Caddy + mail trio)"
##############################################################################
bring_up --mail --no-proxy --no-relay
probe "/eigen/health"        "$BASE_HTTPS/eigen/health"        200 "OK"
probe "/ (landing)"          "$BASE_HTTPS/"                    200
probe "/mail/"               "$BASE_HTTPS/mail/"               200 '"/mail/assets/'
probe "/sheets/"             "$BASE_HTTPS/sheets/"             200 '"/sheets/assets/'
probe "/admin/"              "$BASE_HTTPS/admin/"              200 '"/admin/assets/'
probe_ws "WS /eigen/ws/collab/..." "$BASE_HTTPS/eigen/ws/collab/x/y/z"
probe_smtp  "SMTP banner :25"   "$PORT_SMTP"
probe_imaps "IMAPS banner :993" "$PORT_IMAPS"
# No tear-down: B reruns setup on the running stack, which must switch from Caddy to eigen-static.

##############################################################################
header "Scenario B — static,mail (bundled static container + mail trio)"
##############################################################################
bring_up --mail --proxy "127.0.0.1:$PORT_STATIC" --no-relay
if [ -z "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=caddy)" ]; then
    ok "the rerun removed the edge Caddy"
else
    fail "the edge Caddy still runs after switching to static"
fi
probe "/eigen/health"        "$BASE_HTTP/eigen/health"         200 "OK"
probe "/ (landing)"          "$BASE_HTTP/"                     200
probe "/mail/"               "$BASE_HTTP/mail/"                200 '"/mail/assets/'
probe "/sheets/"             "$BASE_HTTP/sheets/"              200 '"/sheets/assets/'
probe "/admin/"              "$BASE_HTTP/admin/"               200 '"/admin/assets/'
probe_ws "WS /eigen/ws/collab/..." "$BASE_HTTP/eigen/ws/collab/x/y/z"
probe_smtp  "SMTP banner :25"   "$PORT_SMTP"
probe_imaps "IMAPS banner :993" "$PORT_IMAPS"
tear_down

##############################################################################
header "Scenario C — edge       (bundled Caddy, no mail, Mailpit relay)"
##############################################################################
bring_up --no-mail --no-proxy --relay mailpit:1025
probe "/eigen/health"        "$BASE_HTTPS/eigen/health"        200 "OK"
probe "/ (landing)"          "$BASE_HTTPS/"                    200
probe "/mail/"               "$BASE_HTTPS/mail/"               200 '"/mail/assets/'
probe_ws "WS /eigen/ws/collab/..." "$BASE_HTTPS/eigen/ws/collab/x/y/z"
probe_relay
probe_share_mail
tear_down

##############################################################################
header "Scenario D — static     (bundled static, no mail, Mailpit relay)"
##############################################################################
bring_up --no-mail --proxy "127.0.0.1:$PORT_STATIC" --relay mailpit:1025
probe "/eigen/health"        "$BASE_HTTP/eigen/health"         200 "OK"
probe "/ (landing)"          "$BASE_HTTP/"                     200
probe "/mail/"               "$BASE_HTTP/mail/"                200 '"/mail/assets/'
probe_ws "WS /eigen/ws/collab/..." "$BASE_HTTP/eigen/ws/collab/x/y/z"
probe_relay
probe_share_mail
tear_down

##############################################################################
header "Scenario H — edge,mail with custom subnet (172.29.0.0/24)"
##############################################################################
# Verifies EIGEN_SUBNET / EIGEN_UNBOUND_IP can be overridden in lockstep — the failure mode
# we care about is postfix being unable to reach unbound for DNS, which would manifest as
# either compose-up timing out or the SMTP banner probe failing. configure keeps both keys.
sed -i.bak '/^EIGEN_SUBNET=/d; /^EIGEN_UNBOUND_IP=/d' "$INSTALL/.env.production"
rm "$INSTALL/.env.production.bak"
printf 'EIGEN_SUBNET=172.29.0.0/24\nEIGEN_UNBOUND_IP=172.29.0.254\n' >>"$INSTALL/.env.production"
bring_up --mail --no-proxy --no-relay
subnet=$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "${PROJECT}_eigen" || true)
if [ "$subnet" = 172.29.0.0/24 ]; then
    ok "network ${PROJECT}_eigen uses 172.29.0.0/24"
else
    fail "network ${PROJECT}_eigen uses '$subnet', expected 172.29.0.0/24"
fi
probe "/eigen/health"        "$BASE_HTTPS/eigen/health"        200 "OK"
probe_smtp  "SMTP banner :25"   "$PORT_SMTP"
probe_imaps "IMAPS banner :993" "$PORT_IMAPS"
tear_down

##############################################################################
header "Result"
##############################################################################
probe_summary
