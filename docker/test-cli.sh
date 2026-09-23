#!/usr/bin/env bash
# The online commands against a scratch edge,mail install of this working tree, run the way an operator runs
# them: ./eigen from the no-Bun docker:cli container. ./eigen status reports the version and every service,
# ./eigen reset-password with a piped password changes it and signs the account out over HTTP, the control
# socket lives inside the API container and never under data/, and both commands say where to look when the
# API is stopped.
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
header "./eigen reset-password, piped"
##############################################################################
code=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d "{\"domain\":\"localhost\",\"orgName\":\"Probe\",\"storageType\":\"local-id\",\"adminEmail\":\"$ADMIN_EMAIL\",\"adminPassword\":\"$OLD_PASSWORD\",\"adminName\":\"Alice\"}" \
    "$BASE/setup/complete" || true)
if [ "$code" != 200 ]; then
    fail "creating $ADMIN_EMAIL through /setup/complete answered $code"
    header "Result"
    probe_summary
fi
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
