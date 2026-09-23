#!/usr/bin/env bash
# The operator commands against a scratch edge,mail install of this working tree, run the way an operator runs
# them: ./eigen from the no-Bun docker:cli container. ./eigen status reports the version and every service,
# the control socket lives inside the API container and never under data/, ./eigen setup ends with a one-time
# link without which the /setup routes refuse through the real gateway, ./eigen reset-password with a piped
# password changes it and signs the account out over HTTP, ./eigen backup and ./eigen restore round-trip a
# folder made over HTTP with owners and modes intact, a failed snapshot still brings the stack back, a snapshot
# of a newer Eigen or one holding a hard link is refused without stopping anything, an interrupted restore brings
# the stack back on the data it had, and status and reset-password say where to look when the API is stopped.
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

# Every service running and eigen-api healthy.
stack_up() {
    local states
    states=$(dc ps -a --format '{{.Service}} {{.State}} {{.Health}}')
    printf '%s\n' "$states" | grep -q '^eigen-api running healthy$' &&
        ! printf '%s\n' "$states" | grep -v ' running' | grep -q .
}

api_started() { docker inspect --format '{{.State.StartedAt}}' "$(dc ps -q eigen-api)"; }

# The distinct owners under data/, seen from inside a container.
data_owners() {
    docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" sh -c 'find "$1" -exec stat -c "%u:%g" {} + | sort -u' sh \
        "$INSTALL/data" | tr '\n' ' '
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
# Postfix has no healthcheck, so up --wait returns before its queue can be read.
for _ in $(seq 1 30); do
    if dc exec -T postfix postqueue -p >/dev/null 2>&1; then break; fi
    sleep 1
done
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
for row in 'Setup  *not finished' 'Disk  *[0-9]*\.[0-9] [KMGT]B free of [0-9]*\.[0-9] [KMGT]B$' 'Last snapshot  *none yet' 'Mail queue  *empty'; do
    if printf '%s\n' "$OUT" | grep -q "^$row"; then ok "status: $row"; else fail "status lacks: $row"; fi
done
# The scratch checkout has no upstream to compare with.
if printf '%s\n' "$OUT" | grep -q '^Update'; then
    fail "status has an Update row without an upstream"
else
    ok "status leaves out the update check it cannot make"
fi
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
# The browser asks for the link without its fragment; the gateway must serve it, not redirect it.
link=$(grep -o 'https://[^ ]*#setup=[A-Za-z0-9_-]*' "$SCRATCH/setup.log" | tail -n 1 || true)
path=${link#https://*/}
path=${path%%#*}
code=$(curl -sk -o /dev/null -w '%{http_code}' "https://localhost:$PORT_HTTPS/$path" || echo 000)
if [ "$link" = "https://localhost/admin/#setup=$FIRST_TOKEN" ] && [ "$code" = 200 ]; then
    ok "the link is https://localhost/admin/#setup=…, and the gateway serves /$path (200)"
else
    fail "the link '$link': /$path → $code, expected 200"
fi
# Unroutable: a request that reached S3 would hang on it until the connect timeout.
S3_FIELDS='"endpoint":"http://10.255.255.1","bucket":"probe","accessKeyId":"key","secretAccessKey":"secret"'
ADMIN_FIELDS="\"orgName\":\"Probe\",\"storageType\":\"local-id\",\"adminUsername\":\"${ADMIN_EMAIL%@*}\",\"adminPassword\":\"$OLD_PASSWORD\",\"adminName\":\"Alice\""
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
header "./eigen backup and ./eigen restore"
##############################################################################
JAR="$SCRATCH/backup-session"
code=$(sign_in "$NEW_PASSWORD" "$JAR")
admin_id=$(curl -sk -b "$JAR" "$BASE/auth/get-session" | grep -o '"userId":"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)
# drive <method> <path> [json]: the body of a drive call as the signed-in admin.
drive() {
    curl -sk -b "$JAR" -X "$1" -H 'Content-Type: application/json' -H 'Origin: https://localhost' ${3:+-d "$3"} \
        "$BASE/drive/$admin_id/default$2" || true
}
root_id=$(drive GET /root | grep -o '"id":"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)
drive POST "/folder/$root_id" '{"folderName":"Kept by the snapshot"}' >/dev/null
if [ "$code" = 200 ] && drive GET "/folder/$root_id" | grep -q '"Kept by the snapshot"'; then
    ok "the admin made a folder over HTTPS"
else
    fail "could not make a folder to back up (sign-in $code, admin '$admin_id', root '$root_id')"
fi
# Docker Desktop shows a file the operator's container wrote as theirs to one container and as root's to another
# until it is chowned; on Linux this changes nothing.
docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" chown "$OPERATOR" "$INSTALL/.env.production"
ENV_OWNER=$(owner_mode "$INSTALL/.env.production")
OWNERS=$(data_owners)

started=$SECONDS
eigen backup
show
SNAPSHOT=$(printf '%s\n' "$OUT" | grep -o 'eigen-[0-9]\{8\}-[0-9]\{6\}\.tar\.gz' | head -n 1 || true)
if [ "$CODE" = 0 ] && [ -n "$SNAPSHOT" ]; then
    ok "./eigen backup saved backups/$SNAPSHOT in $((SECONDS - started))s"
else
    fail "./eigen backup exited $CODE"
fi
if stack_up; then ok "the stack is back up after the backup"; else fail "the stack is not up after the backup"; fi
got=$(owner_mode "$INSTALL/backups/$SNAPSHOT")
if [ "$got" = '1000:1000 600' ]; then ok "the snapshot is 1000:1000, mode 600"; else fail "the snapshot is '$got'"; fi
members=$(docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" tar -tzf "$INSTALL/backups/$SNAPSHOT" | awk 'NR <= 3' | tr '\n' ' ')
if [ "$members" = 'eigen-snapshot.json .env.production data/ ' ]; then
    ok "the snapshot starts with eigen-snapshot.json, .env.production, data/"
else
    fail "the snapshot starts with: $members"
fi

drive POST "/folder/$root_id" '{"folderName":"Made after the snapshot"}' >/dev/null
started=$(api_started)
eigen restore "$SNAPSHOT"
if [ "$CODE" != 0 ] && printf '%s\n' "$OUT" | grep -q -- '--yes' && [ "$(api_started)" = "$started" ]; then
    ok "restore without a terminal asks for --yes and stops nothing (exit $CODE)"
else
    fail "restore without --yes: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi

started=$SECONDS
eigen restore "backups/$SNAPSHOT" --yes
show
if [ "$CODE" = 0 ]; then ok "./eigen restore --yes finished in $((SECONDS - started))s"; else fail "./eigen restore exited $CODE"; fi
if stack_up; then ok "the stack is up after the restore"; else fail "the stack is not up after the restore"; fi
if curl -sk -b "$JAR" "$BASE/auth/get-session" | grep -q "\"$ADMIN_EMAIL\""; then
    ok "the session from before the backup outlives the restarts"
else
    fail "the session from before the backup was signed out by the restarts"
fi
listing=$(drive GET "/folder/$root_id")
if printf '%s' "$listing" | grep -q '"Kept by the snapshot"' && ! printf '%s' "$listing" | grep -q '"Made after the snapshot"'; then
    ok "the drive is as it was at the snapshot"
else
    fail "the drive after the restore: $listing"
fi
got=$(owner_mode "$INSTALL/.env.production")
if [ "$got" = "$ENV_OWNER" ]; then ok ".env.production kept its owner and mode ($got)"; else fail ".env.production is '$got', was '$ENV_OWNER'"; fi
got=$(data_owners)
if [ "$got" = "$OWNERS" ] && [ "$(printf '%s' "$OWNERS" | wc -w)" -gt 1 ]; then
    ok "data/ has the same mixed owners as before ($got)"
else
    fail "owners under data/: '$got', were '$OWNERS'"
fi
aside=$(cd "$INSTALL" && ls -d data.pre-restore-* .env.production.pre-restore-* 2>/dev/null | tr '\n' ' ' || true)
case $aside in
    data.pre-restore-*' '.env.production.pre-restore-*|.env.production.pre-restore-*' 'data.pre-restore-*)
        ok "the replaced data is kept aside: $aside" ;;
    *) fail "kept aside: '$aside'" ;;
esac

docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" mkdir "$INSTALL/backups/.eigen-snapshot.partial"
eigen backup
show
if [ "$CODE" != 0 ] && printf '%s\n' "$OUT" | grep -q 'Could not write to backups/'; then
    ok "a snapshot that cannot be written fails and says so (exit $CODE)"
else
    fail "the blocked snapshot: exit $CODE"
fi
if printf '%s\n' "$OUT" | grep -q 'Eigen is running' && stack_up; then
    ok "the stack is back up after the failed snapshot"
else
    fail "the stack is not up after the failed snapshot"
fi
docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" rmdir "$INSTALL/backups/.eigen-snapshot.partial"

NEWER=eigen-20990101-000000.tar.gz
docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" sh -c 'cd "$(mktemp -d)" && mkdir data &&
    echo "{\"version\":\"999.0.0\",\"createdAt\":\"2099-01-01T00:00:00.000Z\"}" >eigen-snapshot.json &&
    echo DOMAIN=newer.example.org >.env.production && tar -czf "$1" eigen-snapshot.json .env.production data' sh \
    "$INSTALL/backups/$NEWER"
started=$(api_started)
eigen restore "$NEWER" --yes
show
if [ "$CODE" != 0 ] && printf '%s\n' "$OUT" | grep -q '999.0.0' && printf '%s\n' "$OUT" | grep -q 'Update first, then restore'; then
    ok "a snapshot of a newer Eigen is refused (exit $CODE)"
else
    fail "the newer snapshot: exit $CODE"
fi
if [ "$(api_started)" = "$started" ] && [ "$(cd "$INSTALL" && ls -d data.pre-restore-* | wc -l | tr -d ' ')" = 1 ] &&
    grep -q '^DOMAIN=' "$INSTALL/.env.production" && ! grep -q newer.example.org "$INSTALL/.env.production"; then
    ok "the refusal stopped nothing and changed nothing"
else
    fail "the refused restore changed something"
fi

CRAFTED=eigen-20200101-000000.tar.gz
docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" sh -c 'cd "$(mktemp -d)" && mkdir data &&
    echo "{\"version\":\"$2\",\"createdAt\":\"2020-01-01T00:00:00.000Z\"}" >eigen-snapshot.json &&
    echo DOMAIN=crafted.example.org >.env.production && echo x >data/a && ln data/a data/b &&
    tar -czf "$1" eigen-snapshot.json .env.production data' sh "$INSTALL/backups/$CRAFTED" "$VERSION"
started=$(api_started)
eigen restore "$CRAFTED" --yes
show
if [ "$CODE" != 0 ] && printf '%s\n' "$OUT" | grep -q 'is a hard link' && [ "$(api_started)" = "$started" ] &&
    ! grep -q crafted.example.org "$INSTALL/.env.production"; then
    ok "a snapshot holding a hard link is refused before anything stops (exit $CODE)"
else
    fail "the crafted snapshot: exit $CODE"
fi

# Big enough that the restore is still unpacking when the interrupt lands.
docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" sh -c 'head -c 300000000 /dev/urandom >"$1"' sh \
    "$INSTALL/data/ballast.bin"
eigen backup
BIG=$(printf '%s\n' "$OUT" | grep -o 'eigen-[0-9]\{8\}-[0-9]\{6\}\.tar\.gz' | head -n 1 || true)
docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" rm "$INSTALL/data/ballast.bin"
drive POST "/folder/$root_id" '{"folderName":"Made before the interrupted restore"}' >/dev/null
aside=$(cd "$INSTALL" && ls -d data.pre-restore-* | wc -l | tr -d ' ')
(
    eigen restore "$BIG" --yes
    printf '%s\n' "$OUT" >"$SCRATCH/interrupted.log"
    exit "$CODE"
) &
waiter=$!
for _ in $(seq 1 600); do
    if [ "$(cd "$INSTALL" && ls -d data.pre-restore-* | wc -l | tr -d ' ')" -gt "$aside" ]; then break; fi
    sleep 0.1
done
# Ctrl-C without a terminal: the signal reaches the launcher's docker client, which passes it to the CLI.
docker exec "$(docker ps -q --filter "label=eigen.harness.run=$RUN" --filter "ancestor=$CLI_IMAGE")" kill -INT -1 || true
CODE=0
wait "$waiter" || CODE=$?
OUT=$(cat "$SCRATCH/interrupted.log")
show
if [ "$CODE" = 130 ] && printf '%s\n' "$OUT" | grep -q 'The restore was cancelled'; then
    ok "an interrupted restore says it was cancelled (exit 130)"
else
    fail "the interrupted restore: exit $CODE"
fi
listing=$(drive GET "/folder/$root_id")
if stack_up && printf '%s' "$listing" | grep -q '"Made before the interrupted restore"' &&
    [ ! -e "$INSTALL/data/ballast.bin" ] && [ "$(cd "$INSTALL" && ls -d data.pre-restore-* | wc -l | tr -d ' ')" = "$aside" ]; then
    ok "Eigen runs again on the data it had, and nothing is kept aside"
else
    fail "after the interrupted restore: $listing"
fi
docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" rm "$INSTALL/backups/$BIG"

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
if printf '%s\n' "$OUT" | grep -q '^eigen-api  *exited'; then
    ok "status still lists the services, without glyphs off a terminal"
else
    fail "status does not list eigen-api as exited"
fi
eigen reset-password --help
if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q '^Usage: reset-password <email>'; then
    ok "reset-password --help works with the API stopped"
else
    fail "reset-password --help with the API stopped: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
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
