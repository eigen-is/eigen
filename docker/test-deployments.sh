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

# A share notification sent through the Mailpit relay: From "<admin> via <organization>" <system sender>, Reply-To
# the admin. The admin comes from the link the last ./eigen setup printed, the second user from the admin API.
probe_share_mail() {
    local base="$1/eigen" token link path admin_id folder_id code id message=''
    local jar="$SCRATCH/share-session" password="probe-share-$$"
    rm -f "$jar"
    token=$(grep -o 'setup=[A-Za-z0-9_-]*' "$SCRATCH/setup.log" | tail -n 1 | cut -d= -f2 || true)
    if [ -z "$token" ]; then
        fail "./eigen setup printed no setup link"
        return
    fi
    # The browser asks for the link without its fragment; the web server must serve it, not redirect it.
    link=$(grep -o 'https://[^ ]*#setup=[A-Za-z0-9_-]*' "$SCRATCH/setup.log" | tail -n 1 || true)
    path=${link#https://*/}
    path=${path%%#*}
    code=$(curl -sk -o /dev/null -w '%{http_code}' "$1/$path" || echo 000)
    if [ "$code" = 200 ]; then ok "the setup link's page /$path answers 200"; else fail "the setup link's page /$path → $code, expected 200"; fi
    admin_id=$(curl -sk -X POST -H 'Content-Type: application/json' \
        -d "{\"setupToken\":\"$token\",\"orgName\":\"Probe Org\",\"storageType\":\"local-id\",\"adminUsername\":\"ada\",\"adminPassword\":\"$password\",\"adminName\":\"Ada Admin\"}" \
        "$base/setup/complete" | grep -o '"id":"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)
    if [ -z "$admin_id" ]; then
        fail "creating the admin through the setup link failed"
        return
    fi
    # api <method> <path> [json]: the HTTP status of a call as the signed-in admin.
    api() {
        curl -sk -o "$SCRATCH/share-body" -w '%{http_code}' -b "$jar" -c "$jar" -X "$1" \
            -H 'Content-Type: application/json' -H 'Origin: https://localhost' ${3:+-d "$3"} "$base$2" || echo 000
    }
    code=$(api POST /auth/sign-in/email "{\"email\":\"ada@eigen.test\",\"password\":\"$password\"}")
    if [ "$code" != 200 ]; then fail "the admin cannot sign in → $code"; return; fi
    code=$(api POST /auth/admin/create-user \
        "{\"name\":\"Bea User\",\"email\":\"bea@eigen.test\",\"password\":\"$password\",\"role\":\"user\"}")
    if [ "$code" != 200 ]; then fail "creating bea@eigen.test through the admin API → $code"; return; fi
    code=$(api PUT /settings/server '{"notifications":{"email":{"userOnAclAdd":true}}}')
    if [ "$code" != 200 ]; then fail "turning on share mail for users → $code"; return; fi
    api GET "/drive/$admin_id/default/root" >/dev/null
    folder_id=$(grep -o '"id":"[^"]*"' "$SCRATCH/share-body" | head -n 1 | cut -d'"' -f4 || true)
    code=$(api POST "/drive/$admin_id/default/folder/$folder_id" '{"folderName":"For Bea"}')
    folder_id=$(grep -o '"id":"[^"]*"' "$SCRATCH/share-body" | head -n 1 | cut -d'"' -f4 || true)
    if [ "$code" != 200 ]; then fail "creating a folder to share → $code"; return; fi
    code=$(api PUT "/drive/$admin_id/default/path/$folder_id/acl" '{"add":[{"id":"bea@eigen.test","read":true,"write":false}]}')
    if [ "$code" != 200 ]; then fail "sharing the folder with bea@eigen.test → $code"; return; fi
    ok "the admin from the setup link shares a folder with a user made through the admin API"

    # The notification leaves after the share answers.
    for _ in $(seq 1 30); do
        id=$(curl -s "http://127.0.0.1:$PORT_MAILPIT/api/v1/search?query=to:bea@eigen.test" |
            grep -o '"ID":"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)
        if [ -n "$id" ]; then
            message=$(curl -s "http://127.0.0.1:$PORT_MAILPIT/api/v1/message/$id" || true)
            break
        fi
        sleep 1
    done
    if [ -z "$message" ]; then
        fail "Mailpit received no share notification for bea@eigen.test"
    elif printf '%s' "$message" | grep -q '"From":{"Name":"Ada Admin via Probe Org","Address":"noreply@eigen.test"}' &&
        printf '%s' "$message" | grep -q '"ReplyTo":\[{"Name":"Ada Admin","Address":"ada@eigen.test"}\]'; then
        ok "the share mail is From \"Ada Admin via Probe Org\" <noreply@eigen.test>, Reply-To ada@eigen.test"
    else
        fail "share mail sender: $(printf '%s' "$message" | grep -o '"From":{[^}]*}') $(printf '%s' "$message" | grep -o '"ReplyTo":\[[^]]*\]')"
    fi
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
probe_share_mail "$BASE_HTTPS"
tear_down
# D creates its admin through a fresh setup link too, which only a server that is not set up prints.
docker run --rm -v "$INSTALL/data:/data" "$CLI_IMAGE" find /data -mindepth 1 -delete

##############################################################################
header "Scenario D — static     (bundled static, no mail, Mailpit relay)"
##############################################################################
bring_up --no-mail --proxy "127.0.0.1:$PORT_STATIC" --relay mailpit:1025
probe "/eigen/health"        "$BASE_HTTP/eigen/health"         200 "OK"
probe "/ (landing)"          "$BASE_HTTP/"                     200
probe "/mail/"               "$BASE_HTTP/mail/"                200 '"/mail/assets/'
probe_ws "WS /eigen/ws/collab/..." "$BASE_HTTP/eigen/ws/collab/x/y/z"
probe_relay
probe_share_mail "http://localhost:$PORT_STATIC"
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
