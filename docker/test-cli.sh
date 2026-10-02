#!/usr/bin/env bash
# Installs Eigen as a stranger does, with ./eigen in a docker:cli container that has no Bun, and runs the operator
# commands against it: status, the control socket, the setup link, reset-password, full and light backups on the running
# API and restores of them with their refusals and an interrupt, stop, and what status, backup and reset-password say
# with Eigen stopped. The main install is edge,mail as uid 1001 in a folder whose name has capitals and a space; a
# second one is edge only, as root.
#
# Usage:  ./docker/test-cli.sh
# Needs:  docker, curl, git. Builds every image in Docker (a few minutes on a cold cache).

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

ADMIN_EMAIL=alice@eigen.test
OLD_PASSWORD="probe-old-$$"
NEW_PASSWORD="probe-new-$$"
OPERATOR=1001:1001

# check_install <operator uid:gid>: the stack, the files and the Docker socket of a fresh install.
check_install() {
    local operator="$1" base="https://localhost:$PORT_HTTPS" status mounts data_stat backups_stat
    probe "/eigen/health" "$base/eigen/health" 200 "OK"
    probe "/ (landing)" "$base/" 200
    probe "/admin/" "$base/admin/" 200 '"/admin/assets/'
    probe "/eigen/setup/status" "$base/eigen/setup/status" 200 '"setupRequired":true'
    status=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" \
        --filter "label=com.docker.compose.service=eigen-api" --format '{{.Status}}')
    case "$status" in
        *'(healthy)'*) ok "eigen-api of project $PROJECT is healthy" ;;
        *) fail "eigen-api of project $PROJECT: '$status', expected healthy" ;;
    esac
    if docker network inspect "${PROJECT}_eigen" >/dev/null 2>&1; then
        ok "network ${PROJECT}_eigen exists"
    else
        fail "no network ${PROJECT}_eigen"
    fi
    check_env "$operator" 'after setup'
    data_stat=$(owner_mode "$INSTALL/data")
    backups_stat=$(owner_mode "$INSTALL/backups")
    case "$data_stat $backups_stat" in
        "1000:1000 "*" 1000:1000 "*) ok "data/ and backups/ are 1000:1000" ;;
        *) fail "data/ is '$data_stat' and backups/ is '$backups_stat', expected 1000:1000" ;;
    esac
    mounts=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" |
        xargs docker inspect --format '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' || true)
    if printf '%s\n' "$mounts" | grep -q 'docker.sock'; then
        fail "a container mounts the Docker socket: $(printf '%s\n' "$mounts" | grep docker.sock)"
    else
        ok "no container of $PROJECT mounts the Docker socket ($(printf '%s\n' "$mounts" | wc -l | tr -d ' ') containers)"
    fi
}

# The distinct owners under data/.
data_owners() { scratch_run sh -c 'find "$1" -exec stat -c "%u:%g" {} + | sort -u' sh "$INSTALL/data" | tr '\n' ' '; }

# tab <kept> <edit>: collab_tab on $COLLAB_DOC through Caddy.
tab() { collab_tab caddy wss://localhost "$COLLAB_DOC" "$@"; }

SETUP_FLAGS=(--yes --domain localhost --mail --mail-domain eigen.test --contact-email admin@eigen.test --no-proxy
    --no-relay)

scratch_init cli
new_install "Eigentest CLI $$" "$OPERATOR"
write_override
BASE="https://localhost:$PORT_HTTPS/eigen"

header "Installing edge,mail as uid 1001 into '$(basename "$INSTALL")'"
run_setup "$SCRATCH/setup.log" --user "$OPERATOR" "${SETUP_FLAGS[@]}"
check_install "$OPERATOR"

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
if says "◇  Version  *$VERSION"; then ok "status prints the version $VERSION"; else fail "status does not print the version $VERSION"; fi
for service in $(dc config --services); do
    if says "  $service  *running"; then ok "status lists $service as running"; else fail "status does not list $service as running"; fi
done
for row in 'Setup  *not finished' 'Disk  *[0-9]*\.[0-9] [KMGT]B free of [0-9]*\.[0-9] [KMGT]B$' \
    'Backup  *none yet' 'Mail queue  *empty'; do
    if says "$row"; then ok "status: $row"; else fail "status lacks: $row"; fi
done
# A local build has no update to check for.
if says 'Update  '; then fail "status has an Update row on a local build"; else ok "status on a local build checks for no update"; fi
if printf '%s' "$OUT" | grep -q "$(printf '\033')"; then
    fail "status prints escape codes without a terminal"
else
    ok "status has no color without a terminal"
fi
# What status shows while an update that failed halfway left the files of one api image beside a server that runs
# another: here the same image by its ID, which is not the name .env.production gives it.
scratch_run sh -c 'echo "$2" >"$1/.eigen/bundle"' sh "$INSTALL" "$(docker image inspect --format '{{.Id}}' "$EIGEN_API_IMAGE")"
eigen status
scratch_run rm "$INSTALL/.eigen/bundle"
if says "▲  Update  *files of $VERSION (.*), running $VERSION (.*): run ./eigen update"; then
    ok "status says an update is unfinished while the files are of another api image"
else
    fail "status does not flag files of another api image"
    show
fi
eigen status extra
if [ "$CODE" = 2 ] && says 'Unknown argument "extra"' && says 'Usage: ./eigen status'; then
    ok "status refuses an argument it does not take, with its usage (exit 2)"
else
    fail "status extra: exit $CODE"
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
mounts=$(docker inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$(dc ps -q eigen-api)")
case " $mounts" in
    *' /run'*) fail "eigen-api mounts something under /run: $mounts" ;;
    *) ok "no mount of eigen-api reaches /run/eigen ($mounts)" ;;
esac
found=$(scratch_run find "$INSTALL/data" -name '*.sock')
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
if grep -q "https://localhost/admin/#setup=$FIRST_TOKEN" "$SCRATCH/setup.log"; then
    ok "the link is https://localhost/admin/#setup=…"
else
    fail "the link is not https://localhost/admin/#setup=…"
fi
probe_setup_link "$SCRATCH/setup.log" "https://localhost:$PORT_HTTPS"
# Unroutable: a request that reached S3 would hang on it until the connect timeout.
S3_FIELDS='"endpoint":"http://10.255.255.1","bucket":"probe","accessKeyId":"key","secretAccessKey":"secret"'
ADMIN_FIELDS=$(admin_fields "$OLD_PASSWORD")
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

before=$(scratch_run cat "$INSTALL/.env.production")
run_setup "$SCRATCH/setup-again.log" --user "$OPERATOR" "${SETUP_FLAGS[@]}"
after=$(scratch_run cat "$INSTALL/.env.production")
if [ "${after:0:${#before}}" = "$before" ]; then
    added=$(printf '%s' "${after:${#before}}" | sed -n 's/^\([A-Z_]*\)=.*/\1/p' | tr '\n' ' ')
    ok "the rerun kept every line of .env.production${added:+, added: $added}"
else
    fail ".env.production changed on rerun: $(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | tr '\n' ' ')"
fi
check_env "$OPERATOR" 'after the rerun'
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
    abort "creating $ADMIN_EMAIL through the fresh link answered $code"
fi
ok "the fresh link creates $ADMIN_EMAIL"
for route in complete s3check; do
    case $route in complete) fields=$ADMIN_FIELDS ;; s3check) fields=$S3_FIELDS ;; esac
    read -r code _ <<<"$(setup_post "$route" "$fields,\"setupToken\":\"$SECOND_TOKEN\"")"
    if [ "$code" = 403 ]; then ok "a second use on /setup/$route is refused (403)"; else fail "a second use on /setup/$route → $code"; fi
done
OUT=$(dc exec -T eigen-api /app/docker/api/entrypoint.sh setup-link 2>&1 || true)
show
if says 'already set up' && ! says 'setup='; then
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
if [ "$CODE" = 0 ] && says "eigen|reset-password>" && says "Password changed for $ADMIN_EMAIL. Signed out everywhere."; then
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
if [ "$CODE" != 0 ] && says '■  No account uses nobody@eigen.test' && says '└  Check the address'; then
    ok "an unknown address fails and says what to do (exit $CODE)"
else
    fail "unknown address: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi

eigen status
if says 'Setup  '; then fail "status still says setup is not finished"; else ok "status drops the setup line once an admin exists"; fi

##############################################################################
header "./eigen backup and ./eigen restore"
##############################################################################
JAR="$SCRATCH/backup-session"
code=$(sign_in "$NEW_PASSWORD" "$JAR")
ADMIN_ID=$(session_user)
FOLDER="/drive/$ADMIN_ID/default/folder"
root_id=$(api GET "/drive/$ADMIN_ID/default/root" | first_id)
api POST "$FOLDER/$root_id" '{"folderName":"Kept by the backup"}' >/dev/null
if [ "$code" = 200 ] && api GET "$FOLDER/$root_id" | grep -q '"Kept by the backup"'; then
    ok "the admin made a folder over HTTPS"
else
    fail "could not make a folder to back up (sign-in $code, admin '$ADMIN_ID', root '$root_id')"
fi
COLLAB_DOC=$(api POST "$FOLDER/$root_id/create/doc" '{"fileName":"Collab probe"}' | first_id)
read -r status TAB text <<<"$(tab '' before)"
if [ "$status" = synced ] && [ "$text" = before ]; then
    ok "a tab typed 'before' into a document over its collab WebSocket"
else
    fail "the tab on the document (doc '$COLLAB_DOC'): $status $text"
fi
OWNERS=$(data_owners)

started=$(api_started)
eigen backup
show
ARCHIVE=$(saved_archive)
if [ "$CODE" = 0 ] && [ -n "$ARCHIVE" ] && scratch_run test -f "$INSTALL/backups/$ARCHIVE" &&
    [ "$(api_started)" = "$started" ]; then
    ok "./eigen backup saved backups/$ARCHIVE while Eigen ran on"
else
    fail "./eigen backup exited $CODE"
fi
case $ARCHIVE in
    server-manual-full-*.tar) ok "it is a manual Full archive" ;;
    *) fail "the archive is named '$ARCHIVE'" ;;
esac
eigen backup --light --s3
if [ "$CODE" = 2 ] && says 'A light backup holds no files, so it takes no --s3.'; then
    ok "backup --light --s3 is refused with its usage (exit 2)"
else
    fail "backup --light --s3: exit $CODE"
fi
eigen status
if says "Backup  *$ARCHIVE, "; then
    ok "status names the newest backup"
else
    fail "status does not name $ARCHIVE"
    show
fi

api POST "$FOLDER/$root_id" '{"folderName":"Made after the backup"}' >/dev/null
aside=$(aside_count)
# unchanged: Eigen was not stopped, nothing went aside, and nothing is left staged or half swapped.
unchanged() {
    [ "$(api_started)" = "$started" ] && [ "$(aside_count)" = "$aside" ] &&
        ! scratch_run test -e "$INSTALL/data/.restoring" && ! scratch_run test -e "$INSTALL/.eigen/restore-swap"
}
eigen restore "$ARCHIVE"
if [ "$CODE" != 0 ] && says '--yes' && unchanged; then
    ok "restore without a terminal asks for --yes and stops nothing (exit $CODE)"
else
    fail "restore without --yes: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi
eigen_piped n restore "$ARCHIVE"
if [ "$CODE" = 0 ] && says 'Nothing was changed.' && unchanged; then
    ok "a no to the restore question exits 0 and stops nothing"
else
    fail "restore answered no: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi
eigen restore --help
if [ "$CODE" = 0 ] && says '^Usage: ./eigen restore <archive> \[--yes\] \[--s3-from-archive\]' && ! says '--stage'; then
    ok "restore --help prints its usage, without the stage and swap the launcher runs"
else
    fail "restore --help: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi
CODE=0
OUT=$(EIGEN_API_IMAGE="eigentest-none:$RUN" in_cli_container --user "$OPERATOR" ./eigen restore "$ARCHIVE" 2>&1) || CODE=$?
if [ "$CODE" = 1 ] && says '■  Eigen is not built yet.' && says '└  Run ./eigen setup first, then ./eigen restore <archive>.'; then
    ok "restore without the image says Eigen is not built yet"
else
    fail "restore without the image: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi

# A cut archive is refused by the stage, while Eigen runs.
CUT=server-manual-full-20200101-000000.tar
scratch_run sh -c 'head -c $(($(stat -c %s "$1/$2") / 2)) "$1/$2" >"$1/$3"' sh "$INSTALL/backups" "$ARCHIVE" "$CUT"
eigen restore "$CUT" --yes
scratch_run rm "$INSTALL/backups/$CUT"
if [ "$CODE" = 1 ] && says "$CUT" && unchanged; then
    ok "a cut archive is refused before anything stops"
else
    fail "the restore of a cut archive: exit $CODE"
    show
fi
# A broken override: Compose cannot run the stage, and nothing stops.
scratch_run sh -c 'cp -p "$1" "$1.bak" && printf "x-broken: [\n" >>"$1"' sh "$INSTALL/docker-compose.override.yml"
eigen restore "$ARCHIVE" --yes
scratch_run mv "$INSTALL/docker-compose.override.yml.bak" "$INSTALL/docker-compose.override.yml"
if [ "$CODE" != 0 ] && unchanged; then
    ok "a restore whose Compose files do not read stops nothing (exit $CODE)"
else
    fail "the restore with a broken override: exit $CODE"
    show
fi

started_at=$SECONDS
eigen restore "$INSTALL/backups/$ARCHIVE" --yes
show
if [ "$CODE" = 0 ] && says '└  Check that all is well, then delete what was kept aside.'; then
    ok "./eigen restore --yes finished in $((SECONDS - started_at))s, and says to delete what it kept aside"
else
    fail "./eigen restore exited $CODE"
fi
if stack_up; then ok "the stack is up after the restore"; else fail "the stack is not up after the restore"; fi
if curl -sk -b "$JAR" "$BASE/auth/get-session" | grep -q "\"$ADMIN_EMAIL\""; then
    ok "the session from before the backup is there after the restore"
else
    fail "the session from before the backup was signed out by the restore"
fi
listing=$(api GET "$FOLDER/$root_id")
if printf '%s' "$listing" | grep -q '"Kept by the backup"' && ! printf '%s' "$listing" | grep -q '"Made after the backup"'; then
    ok "the drive is as it was at the backup"
else
    fail "the drive after the restore: $listing"
fi
check_env "$OPERATOR" 'after the restore'
eigen status
if [ "$CODE" = 0 ]; then ok "the operator runs ./eigen on the restored .env.production"; else fail "status after the restore: exit $CODE"; show; fi
# The tab still holds 'before' from before the restore.
read -r status code reason <<<"$(tab "$TAB" '')"
if [ "$status $code $reason" = 'closed 1012 home-replaced' ]; then
    ok "the tab that loaded the document before the restore is closed 1012 when it reconnects, so it reloads"
else
    fail "the tab's reconnect after the restore: $status $code $reason"
fi
read -r status fresh text <<<"$(tab '' '')"
if [ "$status" = synced ] && [ "$text" = before ] && [ "${fresh%%:*}" != "${TAB%%:*}" ]; then
    ok "the document is as it was at the backup, under a new epoch"
else
    fail "the document after the restore: $status '$text' (epoch ${fresh%%:*}, was ${TAB%%:*})"
fi
got=$(data_owners)
if [ "$got" = "$OWNERS" ] && [ "$(printf '%s' "$OWNERS" | wc -w)" -gt 1 ]; then
    ok "data/ has the same mixed owners as before ($got)"
else
    fail "owners under data/: '$got', were '$OWNERS'"
fi
# The archive's .env.production is this one, byte for byte, so an aside of it would keep nothing.
kept=$(cd "$INSTALL" && ls -d data.pre-restore-* .env.production.pre-restore-* 2>/dev/null | tr '\n' ' ' || true)
if [[ $kept =~ ^data\.pre-restore-[0-9-]+\ $ ]]; then
    ok "the replaced data is kept aside, and the unchanged .env.production is not: $kept"
else
    fail "kept aside: '$kept'"
fi
if ! scratch_run test -e "$INSTALL/data/.restoring" && ! scratch_run test -e "$INSTALL/.eigen/restore-swap"; then
    ok "nothing is left staged, and no swap is marked"
else
    fail "data/.restoring or .eigen/restore-swap is left behind"
fi

# Big enough that the stage is still unpacking when the interrupt lands.
scratch_run sh -c 'head -c 300000000 /dev/urandom >"$1" && chown 1000:1000 "$1"' sh "$INSTALL/data/home/$ADMIN_ID/ballast.bin"
eigen backup
BIG=$(saved_archive)
scratch_run rm "$INSTALL/data/home/$ADMIN_ID/ballast.bin"
api POST "$FOLDER/$root_id" '{"folderName":"Made before the interrupted restore"}' >/dev/null
started=$(api_started)
aside=$(aside_count)
(
    eigen restore "$BIG" --yes
    printf '%s\n' "$OUT" >"$SCRATCH/interrupted.log"
    exit "$CODE"
) &
waiter=$!
for _ in $(seq 1 600); do
    if scratch_run test -d "$INSTALL/data/.restoring/data"; then break; fi
    sleep 0.1
done
# Ctrl-C without a terminal: the signal reaches the launcher's Compose client, which passes it to the stage.
launcher=$(docker ps --filter "label=eigen.harness.run=$RUN" --filter "ancestor=$CLI_IMAGE" \
    --format '{{.ID}} {{.Names}}' | awk -v box="$SCRATCH_BOX" '$2 != box { print $1 }')
docker exec "$launcher" kill -INT -1 || true
CODE=0
wait "$waiter" || CODE=$?
OUT=$(cat "$SCRATCH/interrupted.log")
show
if [ "$CODE" != 0 ]; then
    ok "a restore interrupted while it stages ends (exit $CODE)"
else
    fail "the interrupted restore exited 0"
fi
listing=$(api GET "$FOLDER/$root_id")
if printf '%s' "$listing" | grep -q '"Made before the interrupted restore"' && unchanged &&
    ! scratch_run test -e "$INSTALL/data/home/$ADMIN_ID/ballast.bin"; then
    ok "Eigen ran on throughout, nothing is kept aside, and the staged tree is gone"
else
    fail "after the interrupted restore: $listing"
fi
scratch_run sh -c 'rm "$1"*' sh "$INSTALL/backups/$BIG"

##############################################################################
header "./eigen backup --light, and a light restore"
##############################################################################
eigen backup --light
show
LIGHT=$(saved_archive)
case "$CODE $LIGHT" in
    "0 server-manual-light-"*.tar) ok "./eigen backup --light saved backups/$LIGHT" ;;
    *) fail "./eigen backup --light: exit $CODE, '$LIGHT'" ;;
esac
full_size=$(scratch_run stat -c %s "$INSTALL/backups/$ARCHIVE")
light_size=$(scratch_run stat -c %s "$INSTALL/backups/$LIGHT")
log "full $full_size bytes, light $light_size bytes: $(awk -v l="$light_size" -v f="$full_size" 'BEGIN { printf "%.1f%%", 100 * l / f }') of the full one"

# What is on disk is the files, what the listing shows is the drive's database.
files() {
    { scratch_run ls "$INSTALL/data/home/$ADMIN_ID/mounts/default/data" 2>/dev/null || true; } |
        grep -v -e '-wal$' -e '-shm$' || true
}
before=$(files)
api POST "$FOLDER/$root_id/create/doc" '{"fileName":"Made after the light backup"}' >/dev/null
aside=$(aside_count)
eigen restore "$LIGHT" --yes
show
listing=$(api GET "$FOLDER/$root_id")
if [ "$CODE" = 0 ] && stack_up && ! printf '%s' "$listing" | grep -q '"Made after the light backup"'; then
    ok "a light restore puts the databases back: the document made since is out of the drive"
else
    fail "the light restore: exit $CODE, listing $listing"
fi
# Names hold spaces, so they compare line by line.
lost=$(printf '%s\n' "$before" | grep -vxF -e "$(files)" || true)
if [ -z "$lost" ] && [ "$(aside_count)" = $((aside + 1)) ]; then
    ok "and leaves the files on disk as they are, with what it replaced kept aside"
else
    fail "files after the light restore: lost '$lost'; kept aside $(aside_count), was $aside"
fi

##############################################################################
header "./eigen stop, and with Eigen stopped"
##############################################################################
eigen stop
show
running=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")
if [ "$CODE" = 0 ] && says '◇  Eigen stopped' && [ -z "$running" ]; then
    ok "./eigen stop stops every container of the project"
else
    fail "./eigen stop: exit $CODE, still running: $running"
fi
eigen status
show
if [ "$CODE" = 1 ] && says '■  Eigen is not running.' && says '└  Run ./eigen logs eigen-api to see why.'; then
    ok "status fails and points at ./eigen logs eigen-api (exit $CODE)"
else
    fail "status with Eigen stopped: exit $CODE"
fi
if says '■  eigen-api  *exited' && says "Backup  *$LIGHT, Light, "; then
    ok "status still lists the services, and the newest backup from what backups/ holds"
else
    fail "status does not list eigen-api as exited, or the newest backup"
fi
eigen backup
if [ "$CODE" = 1 ] && says '■  Eigen is not running, and a backup runs on the running server.' &&
    says 'With Eigen stopped, a copy of data/ and .env.production is a backup too.'; then
    ok "backup with Eigen stopped says a copy of the quiet data/ is a backup too (exit $CODE)"
else
    fail "backup with Eigen stopped: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi
eigen reset-password --help
if [ "$CODE" = 0 ] && says '^Usage: ./eigen reset-password <email>'; then
    ok "reset-password --help works with Eigen stopped"
else
    fail "reset-password --help with Eigen stopped: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi
eigen_piped "$NEW_PASSWORD" reset-password "$ADMIN_EMAIL"
if [ "$CODE" = 1 ] && says '■  Eigen is not running.'; then
    ok "reset-password fails and says Eigen is not running (exit $CODE)"
else
    fail "reset-password with Eigen stopped: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi
down_project "$PROJECT"

##############################################################################
header "Installing edge as root into another folder"
##############################################################################
new_install "eigentest-root-$$" 0:0
write_override
run_setup "$SCRATCH/setup-root.log" --yes --domain localhost --mail-domain example.org --no-mail --no-relay \
    --no-proxy --contact-email admin@example.org
check_install 0:0
down_project "$PROJECT"

##############################################################################
header "Result"
##############################################################################
probe_summary
