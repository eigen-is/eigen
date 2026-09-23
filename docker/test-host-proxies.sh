#!/usr/bin/env bash
# Smoke-test nginx, Apache, and Caddy in front of the bundled `eigen-static` container —
# the host-webserver path that `eigen setup` writes snippets for. Installs `static,mail` in a
# scratch copy of this working tree with ./eigen setup from the no-Bun docker:cli container, then
# for each webserver runs a containerised instance attached to the install's network with an
# adapted version of the snippet (plain HTTP, eigen-static:8080 instead of 127.0.0.1:8080).
# Probes the same set of URLs as test-deployments.sh.
#
# Usage:  ./docker/test-host-proxies.sh
# Needs:  docker, curl, nc, openssl, git.

set -euo pipefail

# Counters, log/probe helpers, the scratch installs and the Result summary.
. "$(dirname "$0")/probe-lib.sh"

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

# run_proxy <name> <image> <config> <path in the image>: one throwaway webserver on the install's network.
run_proxy() {
    free_port PROXY_PORT
    docker run -d --rm --name "eigentest-proxy-$1-$RUN" --label eigen.harness=1 --label "eigen.harness.run=$RUN" \
        --network "${PROJECT}_eigen" -p "127.0.0.1:$PROXY_PORT:80" \
        -v "$INSTALL/docker/test-proxies/$3:$4:ro" "$2" >/dev/null
    # Give the webserver a moment to start listening.
    sleep 2
    run_probes "http://127.0.0.1:$PROXY_PORT"
    docker rm -f "eigentest-proxy-$1-$RUN" >/dev/null 2>&1
}

scratch_init proxies
new_install "eigentestproxies$$"
write_override

log "Installing static,mail (eigen-static will be the upstream)..."
if ! run_setup --user "$(id -u):$(id -g)" --yes --domain localhost --mail --mail-domain eigen.test \
    --contact-email admin@eigen.test --proxy "127.0.0.1:$PORT_STATIC" --no-relay >"$SCRATCH/setup.log" 2>&1; then
    log "× setup failed:"
    sed 's/^/    /' "$SCRATCH/setup.log"
    dc logs --tail=30 || true
    exit 1
fi

# Mail ports are bound on the host directly by postfix/dovecot regardless of which proxy
# sits in front, so probe them once before iterating through the webservers.
header "Mail trio (postfix + dovecot, behind any host webserver)"
probe_smtp  "SMTP banner :25"   "$PORT_SMTP"
probe_imaps "IMAPS banner :993" "$PORT_IMAPS"

##############################################################################
header "Scenario E — static,mail behind nginx"
##############################################################################
run_proxy nginx nginx:alpine nginx-test.conf /etc/nginx/conf.d/default.conf

##############################################################################
header "Scenario F — static,mail behind Caddy"
##############################################################################
run_proxy caddy caddy:2-alpine caddy-test.Caddyfile /etc/caddy/Caddyfile

##############################################################################
header "Scenario G — static,mail behind Apache"
##############################################################################
run_proxy apache httpd:2.4 apache-test.conf /usr/local/apache2/conf/httpd.conf

##############################################################################
header "Result"
##############################################################################
probe_summary
