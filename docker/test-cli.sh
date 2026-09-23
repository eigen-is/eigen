#!/usr/bin/env bash
# The online commands against a scratch edge,mail install of this working tree, run the way an operator runs
# them: ./eigen from the no-Bun docker:cli container. ./eigen status reports the version and every service,
# the control socket lives inside the API container and never under data/, ./eigen setup ends with a one-time
# link without which the /setup routes refuse through the real gateway, ./eigen reset-password with a piped
# password changes it and signs the account out over HTTP, and both commands say where to look when the API
# is stopped.
#
# Usage:  ./docker/test-cli.sh
# Needs:  docker, curl, git. Builds every image in Docker (a few minutes on a cold cache).

set -euo pipefail

# Counters, log/probe helpers, the scratch installs and the Result summary.
. "$(dirname "$0")/probe-lib.sh"

VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO_ROOT/package.json" | head -n 1)
ADMIN_EMAIL=alice@eigen.test
OLD_PASSWORD="probe-old-$$"
NEW_PASSWORD="probe-new-$$"
OPERATOR="$(id -u):$(id -g)"

# eigen <args…>: the launcher as the operator; sets OUT (stdout and stderr) and CODE.
eigen() {
    CODE=0
    OUT=$(in_cli_container --user "$OPERATOR" ./eigen "$@" 2>&1) || CODE=$?
}

# eigen_piped <input> <args…>: the same with one line on stdin, as a script would answer.
eigen_piped() {
    local input="$1"
    shift
    CODE=0
    OUT=$(printf '%s\n' "$input" | in_cli_container --stdin --user "$OPERATOR" ./eigen "$@" 2>&1) || CODE=$?
}

show() { printf '%s\n' "$OUT" | sed 's/^/    │ /'; }

# setup_token <log>: the token of the last setup link in ./eigen setup output.
setup_token() { grep -o 'setup=[A-Za-z0-9_-]*' "$1" | tail -n 1 | cut -d= -f2 || true; }

# setup_post <route> <json fields>: the HTTP status and the seconds it took, as "403 0.012".
setup_post() {
    curl -sk -o /dev/null -w '%{http_code} %{time_total}' --max-time 20 -X POST -H 'Content-Type: application/json' \
        -d "{$2}" "$BASE/setup/$1" || echo '000 20'
}

# sign_in <password> <cookie jar>: prints the HTTP status of a browser sign-in.
sign_in() {
    curl -sk -c "$2" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
        -H 'Origin: https://localhost' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$1\"}" \
        "$BASE/auth/sign-in/email" || echo 000
}

scratch_init cli
new_install "eigentestcli$$"
write_override
BASE="https://localhost:$PORT_HTTPS/eigen"

header "Installing edge,mail"
started=$SECONDS
if run_setup --user "$OPERATOR" --yes --domain localhost --mail --mail-domain eigen.test \
    --contact-email admin@eigen.test --no-proxy --no-relay >"$SCRATCH/setup.log" 2>&1; then
    ok "./eigen setup finished in $((SECONDS - started))s"
else
    log "× setup failed after $((SECONDS - started))s:"
    sed 's/^/    /' "$SCRATCH/setup.log"
    exit 1
fi

##############################################################################
header "./eigen status"
##############################################################################
eigen status
show
if [ "$CODE" = 0 ]; then ok "status exits 0"; else fail "status exited $CODE"; fi
if printf '%s\n' "$OUT" | grep -q "^Version  *$VERSION"; then
    ok "status prints the version $VERSION"
else
    fail "status does not print the version $VERSION"
fi
for service in $(dc config --services); do
    if printf '%s\n' "$OUT" | grep -q "^$service  *running"; then
        ok "status lists $service as running"
    else
        fail "status does not list $service as running"
    fi
done
for row in 'Setup  *not finished' 'Disk  *[0-9.]* [KMGT]B free of' 'Last snapshot  *none yet' 'Mail queue  *empty'; do
    if printf '%s\n' "$OUT" | grep -q "^$row"; then ok "status: $row"; else fail "status lacks: $row"; fi
done
if printf '%s' "$OUT" | grep -q "$(printf '\033')"; then
    fail "status prints escape codes without a terminal"
else
    ok "status is plain text without a terminal"
fi

##############################################################################
header "The control socket"
##############################################################################
socket=$(dc exec -T eigen-api stat -c '%a %u:%g %F' /run/eigen/control.sock | tr -d '\r' || true)
if [ "$socket" = "600 1000:1000 socket" ]; then
    ok "/run/eigen/control.sock is a 1000:1000 socket, mode 600"
else
    fail "/run/eigen/control.sock: '$socket', expected '600 1000:1000 socket'"
fi
api_id=$(dc ps -q eigen-api)
mounts=$(docker inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$api_id")
case " $mounts" in
    *' /run'*) fail "eigen-api mounts something under /run: $mounts" ;;
    *) ok "no mount of eigen-api reaches /run/eigen ($mounts)" ;;
esac
found=$(docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" find "$INSTALL/data" -name '*.sock')
if [ -z "$found" ]; then ok "no socket under data/"; else fail "a socket under data/: $found"; fi

##############################################################################
header "The setup link"
##############################################################################
FIRST_TOKEN=$(setup_token "$SCRATCH/setup.log")
if [ "${#FIRST_TOKEN}" = 43 ]; then
    ok "./eigen setup ends with a setup link"
else
    fail "./eigen setup printed no setup link"
fi
# Unroutable: a request that reached S3 would hang on it until the connect timeout.
S3_FIELDS='"endpoint":"http://10.255.255.1","bucket":"probe","accessKeyId":"key","secretAccessKey":"secret"'
ADMIN_FIELDS="\"domain\":\"localhost\",\"orgName\":\"Probe\",\"storageType\":\"local-id\",\"adminEmail\":\"$ADMIN_EMAIL\",\"adminPassword\":\"$OLD_PASSWORD\",\"adminName\":\"Alice\""
for route in s3check s3harden complete; do
    case $route in
        s3check) fields=$S3_FIELDS ;;
        s3harden) fields="$S3_FIELDS,\"noncurrentDays\":30" ;;
        complete) fields=$ADMIN_FIELDS ;;
    esac
    for token in '' "${FIRST_TOKEN}x"; do
        read -r code seconds <<<"$(setup_post "$route" "$fields${token:+,\"setupToken\":\"$token\"}")"
        what="/setup/$route without a token"
        if [ -n "$token" ]; then what="/setup/$route with a wrong token"; fi
        if [ "$code" != 403 ]; then
            fail "$what → $code, expected 403"
        elif awk -v s="$seconds" 'BEGIN { exit !(s < 2) }'; then
            ok "$what → 403 in ${seconds}s"
        else
            fail "$what → 403 but took ${seconds}s, as if it had called out"
        fi
    done
done

started=$SECONDS
if run_setup --user "$OPERATOR" --yes --domain localhost --mail --mail-domain eigen.test \
    --contact-email admin@eigen.test --no-proxy --no-relay >"$SCRATCH/setup-again.log" 2>&1; then
    ok "./eigen setup reran in $((SECONDS - started))s"
else
    fail "the setup rerun failed after $((SECONDS - started))s"
    sed 's/^/    /' "$SCRATCH/setup-again.log"
fi
SECOND_TOKEN=$(setup_token "$SCRATCH/setup-again.log")
if [ "${#SECOND_TOKEN}" = 43 ] && [ "$SECOND_TOKEN" != "$FIRST_TOKEN" ]; then
    ok "the rerun prints a fresh link"
else
    fail "the rerun printed no fresh link"
fi
read -r code _ <<<"$(setup_post complete "$ADMIN_FIELDS,\"setupToken\":\"$FIRST_TOKEN\"")"
if [ "$code" = 403 ]; then ok "the first link no longer works (403)"; else fail "the first link → $code, expected 403"; fi
read -r code _ <<<"$(setup_post complete "$ADMIN_FIELDS,\"setupToken\":\"$SECOND_TOKEN\"")"
if [ "$code" != 200 ]; then
    fail "creating $ADMIN_EMAIL through the fresh link answered $code"
    header "Result"
    probe_summary
fi
ok "the fresh link creates $ADMIN_EMAIL"
for route in complete s3check; do
    case $route in complete) fields=$ADMIN_FIELDS ;; s3check) fields=$S3_FIELDS ;; esac
    read -r code _ <<<"$(setup_post "$route" "$fields,\"setupToken\":\"$SECOND_TOKEN\"")"
    if [ "$code" = 403 ]; then ok "a second use on /setup/$route is refused (403)"; else fail "a second use on /setup/$route → $code"; fi
done
OUT=$(dc exec -T eigen-api bun /app/apps/api/src/cli/index.ts setup-link 2>&1 || true)
show
if printf '%s\n' "$OUT" | grep -q 'already set up' && ! printf '%s' "$OUT" | grep -q 'setup='; then
    ok "setup-link says Eigen is already set up, with no link"
else
    fail "setup-link after the setup does not say it is done"
fi

##############################################################################
header "./eigen reset-password, piped"
##############################################################################
OLD_SESSION="$SCRATCH/old-session"
code=$(sign_in "$OLD_PASSWORD" "$OLD_SESSION")
if [ "$code" = 200 ]; then ok "$ADMIN_EMAIL signs in with the setup password"; else fail "first sign-in → $code"; fi
if curl -sk -b "$OLD_SESSION" "$BASE/auth/get-session" | grep -q "\"$ADMIN_EMAIL\""; then
    ok "the session cookie works"
else
    fail "the session cookie does not work before the reset"
fi

eigen_piped "$NEW_PASSWORD" reset-password ALICE@eigen.test
show
if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q "Password changed for $ADMIN_EMAIL"; then
    ok "reset-password with a piped password (address in another case) succeeds"
else
    fail "reset-password exited $CODE"
fi
if curl -sk -b "$OLD_SESSION" "$BASE/auth/get-session" | grep -q "\"$ADMIN_EMAIL\""; then
    fail "the old session cookie still works after the reset"
else
    ok "the old session cookie is signed out"
fi
code=$(sign_in "$OLD_PASSWORD" "$SCRATCH/old-password")
if [ "$code" = 401 ]; then ok "the old password is refused (401)"; else fail "old password → $code, expected 401"; fi
code=$(sign_in "$NEW_PASSWORD" "$SCRATCH/new-password")
if [ "$code" = 200 ]; then ok "the new password signs in"; else fail "new password → $code, expected 200"; fi

eigen_piped "$NEW_PASSWORD" reset-password nobody@eigen.test
if [ "$CODE" != 0 ] && printf '%s\n' "$OUT" | grep -q 'No account uses nobody@eigen.test'; then
    ok "an unknown address fails and says so (exit $CODE)"
else
    fail "unknown address: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi

eigen status
if printf '%s\n' "$OUT" | grep -q '^Setup'; then fail "status still says setup is not finished"; else ok "status drops the setup line once an admin exists"; fi

##############################################################################
header "With the API stopped"
##############################################################################
dc stop eigen-api >/dev/null 2>&1
eigen status
show
if [ "$CODE" != 0 ] && printf '%s\n' "$OUT" | grep -q './eigen logs eigen-api'; then
    ok "status fails and points at ./eigen logs eigen-api (exit $CODE)"
else
    fail "status with the API stopped: exit $CODE"
fi
if printf '%s\n' "$OUT" | grep -q 'eigen-api  *exited'; then
    ok "status still lists the services"
else
    fail "status does not list eigen-api as exited"
fi
eigen_piped "$NEW_PASSWORD" reset-password "$ADMIN_EMAIL"
if [ "$CODE" != 0 ] && printf '%s\n' "$OUT" | grep -q 'The API is not running'; then
    ok "reset-password fails and says the API is not running (exit $CODE)"
else
    fail "reset-password with the API stopped: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi

##############################################################################
header "Result"
##############################################################################
probe_summary
