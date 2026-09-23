#!/usr/bin/env bash
# Installs each deployment shape (Caddy or eigen-static, with mail or without, a custom subnet) by rerunning ./eigen
# setup on one install, from a docker:cli container that has no Bun. Per shape: the landing page and each app's own
# bundle, /eigen/health, the WebSocket upgrade and the mail ports; without mail, a share notification through a
# Mailpit relay and a document that syncs over its collab WebSocket through the web server.
#
# Usage:  ./docker/test-deployments.sh
# Needs:  docker, curl, nc, openssl, git.

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

ADMIN_EMAIL=alice@eigen.test
PASSWORD="probe-$$"

bring_up() {
    log "→ ./eigen setup $*"
    run_setup "$SCRATCH/setup.log" --user "$(id -u):$(id -g)" --yes --domain localhost --mail-domain eigen.test \
        --contact-email admin@eigen.test "$@"
}

tear_down() {
    # Every profile, so down also removes the containers of a shape the next one does not use.
    COMPOSE_PROFILES=edge,static,mail dc down -v --remove-orphans >/dev/null 2>&1 || true
}

# The API relays through Mailpit when Eigen hosts no mail.
probe_relay() {
    local host
    host=$(dc exec -T eigen-api printenv SMTP_RELAY_HOST | tr -d '\r' || true)
    if [ "$host" = mailpit ]; then
        ok "eigen-api relays through mailpit"
    else
        fail "eigen-api SMTP_RELAY_HOST is '$host', expected mailpit"
    fi
}

# call <method> <path> [json]: the HTTP status of a call on $BASE as the signed-in admin, its body in $SCRATCH/body.
call() {
    curl -sk -o "$SCRATCH/body" -w '%{http_code}' -b "$JAR" -X "$1" -H 'Content-Type: application/json' \
        -H 'Origin: https://localhost' ${3:+-d "$3"} "$BASE$2" || echo 000
}

body_id() { grep -o '"id":"[^"]*"' "$SCRATCH/body" | head -n 1 | cut -d'"' -f4 || true; }

# admin <origin>: the admin from the link the last ./eigen setup printed, signed in on <origin>.
admin() {
    BASE="$1/eigen"
    JAR="$SCRATCH/session"
    rm -f "$JAR"
    probe_setup_link "$SCRATCH/setup.log" "$1"
    if create_admin "$SCRATCH/setup.log" "$PASSWORD"; then
        ok "the setup link made $ADMIN_EMAIL, who signs in"
    else
        fail "the setup link made no admin who signs in"
    fi
}

# A share notification through the Mailpit relay: From "<admin> via <organization>" <system sender>, Reply-To the
# admin.
probe_share_mail() {
    local code folder_id id message=''
    code=$(call POST /auth/admin/create-user \
        "{\"name\":\"Bea User\",\"email\":\"bea@eigen.test\",\"password\":\"$PASSWORD\",\"role\":\"user\"}")
    if [ "$code" != 200 ]; then fail "creating bea@eigen.test through the admin API → $code"; return; fi
    code=$(call PUT /settings/server '{"notifications":{"email":{"userOnAclAdd":true}}}')
    if [ "$code" != 200 ]; then fail "turning on share mail for users → $code"; return; fi
    call GET "/drive/$ADMIN_ID/default/root" >/dev/null
    code=$(call POST "/drive/$ADMIN_ID/default/folder/$(body_id)" '{"folderName":"For Bea"}')
    folder_id=$(body_id)
    if [ "$code" != 200 ]; then fail "creating a folder to share → $code"; return; fi
    code=$(call PUT "/drive/$ADMIN_ID/default/path/$folder_id/acl" '{"add":[{"id":"bea@eigen.test","read":true,"write":false}]}')
    if [ "$code" != 200 ]; then fail "sharing the folder with bea@eigen.test → $code"; return; fi
    ok "the admin shares a folder with a user made through the admin API"

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
    elif printf '%s' "$message" | grep -q '"From":{"Name":"Alice via Probe","Address":"noreply@eigen.test"}' &&
        printf '%s' "$message" | grep -q '"ReplyTo":\[{"Name":"Alice","Address":"alice@eigen.test"}\]'; then
        ok "the share mail is From \"Alice via Probe\" <noreply@eigen.test>, Reply-To alice@eigen.test"
    else
        fail "share mail sender: $(printf '%s' "$message" | grep -o '"From":{[^}]*}') $(printf '%s' "$message" | grep -o '"ReplyTo":\[[^]]*\]')"
    fi
}

# probe_collab <web server service> <its URL inside its own container>: a document made over the API syncs over its
# collab WebSocket through that web server. Bun from the API image, in the web server's network namespace, sends sync
# step 1 and waits for the server's sync step 2.
probe_collab() {
    local doc_id cookie result
    call GET "/drive/$ADMIN_ID/default/root" >/dev/null
    call POST "/drive/$ADMIN_ID/default/folder/$(body_id)/create/doc" '{"fileName":"Collab probe"}' >/dev/null
    doc_id=$(body_id)
    cookie=$(awk -F'\t' 'NF >= 7 && ($1 !~ /^#/ || $1 ~ /^#HttpOnly_/) { printf "%s=%s; ", $6, $7 }' "$JAR")
    result=$(docker run --rm --network "container:$(dc ps -q "$1")" --entrypoint bun -e COOKIE="$cookie" \
        -e URL="$2/eigen/ws/collab/$ADMIN_ID/default/$doc_id" "$EIGEN_API_IMAGE" -e '
            const ws = new WebSocket(process.env.URL, {
                headers: { Cookie: process.env.COOKIE, Origin: "https://localhost" },
                tls: { rejectUnauthorized: false },
            });
            ws.binaryType = "arraybuffer";
            ws.onopen = () => ws.send(new Uint8Array([0, 0, 1, 0]));
            ws.onmessage = ({ data }) => {
                const frame = new Uint8Array(data);
                if (frame[0] === 0 && frame[1] === 1) {
                    console.log("synced");
                    process.exit(0);
                }
            };
            ws.onclose = ({ code }) => {
                console.log(`closed ${code}`);
                process.exit(1);
            };
            setTimeout(() => {
                console.log("no sync step 2 in 15s");
                process.exit(1);
            }, 15000);
        ' 2>&1 || true)
    if [ "$result" = synced ]; then
        ok "a document syncs over its collab WebSocket through $1"
    else
        fail "the collab WebSocket through $1 (doc '$doc_id'): $result"
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
admin "$BASE_HTTPS"
probe_share_mail
probe_collab caddy wss://localhost
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
admin "http://localhost:$PORT_STATIC"
probe_share_mail
probe_collab eigen-static ws://localhost:8080
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
