#!/usr/bin/env bash
# nginx, Apache and Caddy in front of eigen-static, with the snippets ./eigen setup writes for them. Installs static,mail
# from a docker:cli container that has no Bun, then runs each web server on the install's network, pointed at
# eigen-static:8080 instead of the host port, with a self-signed certificate where certbot's would be.
#
# Usage:  ./docker/test-host-proxies.sh
# Needs:  docker, curl, nc, openssl, git.

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

# run_proxy <name> <image> <snippet> <path in the image> [extra docker run args…]: one throwaway web server on the
# install's network, serving the snippet ./eigen setup wrote with eigen-static as its target.
run_proxy() {
    local name="$1" image="$2" snippet="$SCRATCH/$3" path="$4"
    sed "s/127\.0\.0\.1:$PORT_STATIC/eigen-static:8080/g" "$INSTALL/$3" >"$snippet"
    shift 4
    free_port PROXY_PORT
    docker run -d --rm --name "eigentest-proxy-$name-$RUN" --label eigen.harness=1 --label "eigen.harness.run=$RUN" \
        --network "${PROJECT}_eigen" -p "127.0.0.1:$PROXY_PORT:443" \
        -v "$snippet:$path:ro" -v "$SCRATCH/letsencrypt:/etc/letsencrypt:ro" "$@" "$image" >/dev/null
    for _ in $(seq 1 30); do
        if curl -sk -o /dev/null "https://localhost:$PROXY_PORT/"; then break; fi
        sleep 1
    done
    probe_site "https://localhost:$PROXY_PORT"
    docker rm -f "eigentest-proxy-$name-$RUN" >/dev/null 2>&1
}

scratch_init proxies
new_install "eigentestproxies$$"
write_override

header "Installing static,mail, with eigen-static as the upstream"
run_setup "$SCRATCH/setup.log" --user "$(id -u):$(id -g)" --yes --domain localhost --mail --mail-domain eigen.test \
    --contact-email admin@eigen.test --proxy "127.0.0.1:$PORT_STATIC" --no-relay

# Where certbot would have put the certificate for the web address.
mkdir -p "$SCRATCH/letsencrypt/live/localhost"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -keyout "$SCRATCH/letsencrypt/live/localhost/privkey.pem" \
    -out "$SCRATCH/letsencrypt/live/localhost/fullchain.pem" 2>/dev/null

# The mail ports do not go through the web server, so once is enough.
header "Mail (postfix and dovecot, whichever web server is in front)"
probe_smtp postfix "$PORT_SMTP"
probe_imaps dovecot "$PORT_IMAPS"

##############################################################################
header "Scenario E — static,mail behind nginx"
##############################################################################
run_proxy nginx nginx:alpine eigen.nginx.conf /etc/nginx/conf.d/default.conf

##############################################################################
header "Scenario F — static,mail behind Caddy"
##############################################################################
run_proxy caddy caddy:2-alpine eigen.Caddyfile /etc/caddy/Caddyfile

##############################################################################
header "Scenario G — static,mail behind Apache"
##############################################################################
run_proxy apache httpd:2.4 eigen.apache.conf /usr/local/apache2/conf/eigen.conf \
    -v "$INSTALL/docker/test-proxies/httpd.conf:/usr/local/apache2/conf/httpd.conf:ro"

##############################################################################
header "Result"
##############################################################################
probe_summary
