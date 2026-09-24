#!/usr/bin/env bash
# Installs Eigen as a stranger does, with ./eigen in a docker:cli container that has no Bun, and runs the operator
# commands against it: status, the control socket, the setup link, reset-password, full and light backups and restores
# with their refusals and retention, stop, and what status and reset-password say with Eigen stopped. The main install
# is edge,mail as uid 1001 in a folder whose name has capitals and a space; a second one is edge only, as root.
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
    local operator="$1" base="https://localhost:$PORT_HTTPS" status mounts env_stat data_stat backups_stat
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
    env_stat=$(owner_mode "$INSTALL/.env.production")
    data_stat=$(owner_mode "$INSTALL/data")
    backups_stat=$(owner_mode "$INSTALL/backups")
    if [ "$env_stat" = "$operator 600" ]; then
        ok ".env.production is $operator, mode 600"
    else
        fail ".env.production is '$env_stat', expected '$operator 600'"
    fi
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

# craft <name> <version> <commands run in its data/>: a snapshot in snapshots/, made as root.
craft() {
    scratch_run sh -c 'cd "$(mktemp -d)" && mkdir data &&
        echo "{\"version\":\"$2\",\"createdAt\":\"2020-01-01T00:00:00.000Z\"}" >eigen-snapshot.json &&
        echo DOMAIN=crafted.example.org >.env.production && echo x >data/a && (cd data && eval "$3") &&
        tar -czf "$1" eigen-snapshot.json .env.production data' sh "$INSTALL/snapshots/$1" "$2" "$3"
}

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
    'Last snapshot  *none yet' 'Mail queue  *empty'; do
    if says "$row"; then ok "status: $row"; else fail "status lacks: $row"; fi
done
# The scratch checkout has no upstream to compare with.
if says 'Update  '; then fail "status has an Update row without an upstream"; else ok "status leaves out the update check it cannot make"; fi
if printf '%s' "$OUT" | grep -q "$(printf '\033')"; then
    fail "status prints escape codes without a terminal"
else
    ok "status has no color without a terminal"
fi
# What status shows while an update that failed halfway left the files of one version beside a server of another.
scratch_run sh -c 'echo 9.9.9 >"$1/.eigen/bundle"' sh "$INSTALL"
eigen status
scratch_run rm "$INSTALL/.eigen/bundle"
if says "▲  Update  *files of 9.9.9, running $VERSION: run ./eigen update"; then
    ok "status says an update is unfinished while the files are of another version"
else
    fail "status does not flag files of another version"
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
api POST "$FOLDER/$root_id" '{"folderName":"Kept by the snapshot"}' >/dev/null
if [ "$code" = 200 ] && api GET "$FOLDER/$root_id" | grep -q '"Kept by the snapshot"'; then
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

started=$SECONDS
eigen backup
show
SNAPSHOT=$(saved_snapshot)
if [ "$CODE" = 0 ] && [ -n "$SNAPSHOT" ] && says "Saved snapshots/$SNAPSHOT (full, "; then
    ok "./eigen backup saved snapshots/$SNAPSHOT, a full snapshot, in $((SECONDS - started))s"
else
    fail "./eigen backup exited $CODE"
fi
if stack_up; then ok "the stack is back up after the backup"; else fail "the stack is not up after the backup"; fi
# Typed while the backup had Eigen stopped: the restart keeps the epoch, so the tab's reconnect keeps the edit.
read -r status kept text <<<"$(tab "$TAB" ' after')"
read -r _ fresh after <<<"$(tab '' '')"
if [ "$status" = synced ] && [ "$after" = 'before after' ] && [ "${fresh%%:*}" = "${TAB%%:*}" ]; then
    ok "the tab's edit made while Eigen was stopped syncs when it reconnects"
    TAB=$kept
else
    fail "the tab's reconnect after the backup: $status $text, the server has '$after'"
fi
got="$(owner_mode "$INSTALL/snapshots") / $(owner_mode "$INSTALL/snapshots/$SNAPSHOT")"
if [ "$got" = "$OPERATOR 700 / $OPERATOR 600" ]; then
    ok "snapshots/ is the operator's, mode 700, and so is the snapshot, mode 600"
else
    fail "snapshots/ and the snapshot are '$got'"
fi
members=$(scratch_run tar -tzf "$INSTALL/snapshots/$SNAPSHOT" | awk 'NR <= 3' | tr '\n' ' ')
if [ "$members" = 'eigen-snapshot.json .env.production data/ ' ]; then
    ok "the snapshot starts with eigen-snapshot.json, .env.production, data/"
else
    fail "the snapshot starts with: $members"
fi
if dc config --format json | grep -q 'snapshots'; then
    fail "a service of Eigen mounts snapshots/"
else
    ok "no service of Eigen mounts snapshots/"
fi
# Older by its time, newer by its name: status must pick by the time.
scratch_run touch "$INSTALL/snapshots/eigen-pre-update-20200101-000000.tar.gz"
eigen status
if says "Last snapshot  *$SNAPSHOT, " && says 'Snapshots  *2 in snapshots/, [0-9.]* [KMG]B on disk'; then
    ok "status names the newest snapshot by its time, and counts the snapshots and their size"
else
    fail "status names another snapshot, or does not count them"
    show
fi
scratch_run rm "$INSTALL/snapshots/eigen-pre-update-20200101-000000.tar.gz"

api POST "$FOLDER/$root_id" '{"folderName":"Made after the snapshot"}' >/dev/null
started=$(api_started)
eigen restore "$SNAPSHOT"
if [ "$CODE" != 0 ] && says '--yes' && [ "$(api_started)" = "$started" ]; then
    ok "restore without a terminal asks for --yes and stops nothing (exit $CODE)"
else
    fail "restore without --yes: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi
eigen_piped n restore "$SNAPSHOT"
if [ "$CODE" = 0 ] && says 'Nothing was changed.' && [ "$(api_started)" = "$started" ]; then
    ok "a no to the restore question exits 0 and stops nothing"
else
    fail "restore answered no: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi
eigen restore --help
if [ "$CODE" = 0 ] && says '^Usage: ./eigen restore <snapshot> \[--yes\]' && ! says '--check'; then
    ok "restore --help prints its usage, without the launcher's --check"
else
    fail "restore --help: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi
CODE=0
OUT=$(EIGEN_API_IMAGE="eigentest-none:$RUN" in_cli_container --user "$OPERATOR" ./eigen restore "$SNAPSHOT" 2>&1) || CODE=$?
if [ "$CODE" = 1 ] && says '■  Eigen is not built yet.' && says '└  Run ./eigen setup first, then ./eigen restore <snapshot>.'; then
    ok "restore without the image says Eigen is not built yet"
else
    fail "restore without the image: exit $CODE, output: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi

started=$SECONDS
eigen restore "$INSTALL/snapshots/$SNAPSHOT" --yes
show
if [ "$CODE" = 0 ]; then ok "./eigen restore --yes finished in $((SECONDS - started))s"; else fail "./eigen restore exited $CODE"; fi
if stack_up; then ok "the stack is up after the restore"; else fail "the stack is not up after the restore"; fi
if curl -sk -b "$JAR" "$BASE/auth/get-session" | grep -q "\"$ADMIN_EMAIL\""; then
    ok "the session from before the backup outlives the restarts"
else
    fail "the session from before the backup was signed out by the restarts"
fi
listing=$(api GET "$FOLDER/$root_id")
if printf '%s' "$listing" | grep -q '"Kept by the snapshot"' && ! printf '%s' "$listing" | grep -q '"Made after the snapshot"'; then
    ok "the drive is as it was at the snapshot"
else
    fail "the drive after the restore: $listing"
fi
got=$(owner_mode "$INSTALL/.env.production")
if [ "$got" = "$OPERATOR 600" ]; then ok ".env.production is the operator's, mode 600"; else fail ".env.production is '$got', expected '$OPERATOR 600'"; fi
eigen status
if [ "$CODE" = 0 ]; then ok "the operator runs ./eigen on the restored .env.production"; else fail "status after the restore: exit $CODE"; show; fi
# The tab still holds 'before after' from before the restore.
read -r status code reason <<<"$(tab "$TAB" '')"
if [ "$status $code $reason" = 'closed 1012 home-replaced' ]; then
    ok "the tab that loaded the document before the restore is closed 1012 when it reconnects, so it reloads"
else
    fail "the tab's reconnect after the restore: $status $code $reason"
fi
read -r status fresh text <<<"$(tab '' '')"
if [ "$status" = synced ] && [ "$text" = before ] && [ "${fresh%%:*}" != "${TAB%%:*}" ]; then
    ok "the document is as it was at the snapshot, under a new epoch"
else
    fail "the document after the restore: $status '$text' (epoch ${fresh%%:*}, was ${TAB%%:*})"
fi
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
if [ ! -e "$INSTALL/.eigen/restore" ]; then ok "nothing is left in .eigen/restore"; else fail ".eigen/restore is left behind"; fi

scratch_run mkdir "$INSTALL/snapshots/.eigen-snapshot.partial"
eigen backup
show
if [ "$CODE" != 0 ] && says '■  Could not write the snapshot:' &&
    ! scratch_run test -e "$INSTALL/snapshots/.eigen-snapshot.partial"; then
    ok "a snapshot that cannot be written fails, says so and leaves no partial file (exit $CODE)"
else
    fail "the blocked snapshot: exit $CODE"
fi
if says 'Eigen is running' && stack_up; then
    ok "the stack is back up after the failed snapshot"
else
    fail "the stack is not up after the failed snapshot"
fi

NEWER=eigen-20990101-000000.tar.gz
craft "$NEWER" 999.0.0 :
started=$(api_started)
aside=$(aside_count)
eigen restore "$NEWER" --yes
show
if [ "$CODE" != 0 ] && says '999.0.0' && says 'Update first, then restore'; then
    ok "a snapshot of a newer Eigen is refused (exit $CODE)"
else
    fail "the newer snapshot: exit $CODE"
fi
if [ "$(api_started)" = "$started" ] && [ "$(aside_count)" = "$aside" ] &&
    ! scratch_run grep -q crafted.example.org "$INSTALL/.env.production"; then
    ok "the refusal stopped nothing and changed nothing"
else
    fail "the refused restore changed something"
fi
scratch_run rm "$INSTALL/snapshots/$NEWER"

# Unpacked by root with GNU tar while Eigen runs, each is refused before anything stops: by what find sees in the
# unpacked copy, or by tar itself, which links only to what it unpacked and fails where the file share cannot hold a
# device.
n=0
for crafted in 'ln ../eigen-snapshot.json leak|leak' 'mknod null c 1 3|null' 'chmod 4755 a|is setuid or setgid' \
    'ln -s /etc/passwd passwd|is a link that leads out of data/'; do
    name="eigen-20200101-00000$((++n)).tar.gz"
    craft "$name" "$VERSION" "${crafted%%|*}"
    # Docker Desktop's file share drops the bit as root's tar unpacks it: then there is nothing to refuse.
    if [ "${crafted%%|*}" = 'chmod 4755 a' ] && [ "$(docker run --rm -v "$SCRATCH:$SCRATCH" --entrypoint sh \
        "$EIGEN_API_IMAGE" -c 'mkdir "$1.probe" && tar --numeric-owner -xzpf "$1" -C "$1.probe" data/a &&
        stat -c %a "$1.probe/data/a"; rm -rf "$1.probe"' sh "$INSTALL/snapshots/$name")" != 4755 ]; then
        skip "a setuid file: this file share drops the bit on unpack (the unit tests cover the refusal)"
        scratch_run rm "$INSTALL/snapshots/$name"
        continue
    fi
    started=$(api_started)
    eigen restore "$name" --yes
    if [ "$CODE" = 1 ] && { says "■  $name cannot be restored: .*${crafted#*|}" ||
        says "■  Unpacking failed: .*${crafted#*|}"; } && [ "$(api_started)" = "$started" ] &&
        [ "$(aside_count)" = "$aside" ] && [ ! -e "$INSTALL/.eigen/restore" ] &&
        ! scratch_run grep -q crafted.example.org "$INSTALL/.env.production"; then
        ok "a snapshot where data/ holds '${crafted%%|*}' is refused before anything stops"
    else
        fail "the snapshot with '${crafted%%|*}': exit $CODE"
        show
    fi
done

# A broken override: the check passes, Compose cannot stop Eigen, and root's unpacked copy must not stay behind.
started=$(api_started)
scratch_run sh -c 'cp -p "$1" "$1.bak" && printf "x-broken: [\n" >>"$1"' sh "$INSTALL/docker-compose.override.yml"
eigen restore "$SNAPSHOT" --yes
scratch_run mv "$INSTALL/docker-compose.override.yml.bak" "$INSTALL/docker-compose.override.yml"
if [ "$CODE" = 1 ] && says '■  Could not stop Eigen' && [ ! -e "$INSTALL/.eigen/restore" ] &&
    [ "$(api_started)" = "$started" ] && [ "$(aside_count)" = "$aside" ]; then
    ok "a restore whose stop fails leaves Eigen running and removes the unpacked copy"
else
    fail "the restore with a failing stop: exit $CODE"
    show
fi

# Big enough that the restore is still unpacking when the interrupt lands.
scratch_run sh -c 'head -c 300000000 /dev/urandom >"$1"' sh "$INSTALL/data/ballast.bin"
eigen backup
BIG=$(saved_snapshot)
scratch_run rm "$INSTALL/data/ballast.bin"
api POST "$FOLDER/$root_id" '{"folderName":"Made before the interrupted restore"}' >/dev/null
started=$(api_started)
(
    eigen restore "$BIG" --yes
    printf '%s\n' "$OUT" >"$SCRATCH/interrupted.log"
    exit "$CODE"
) &
waiter=$!
for _ in $(seq 1 600); do
    if [ -d "$INSTALL/.eigen/restore" ]; then break; fi
    sleep 0.1
done
# Ctrl-C without a terminal: the signal reaches the launcher's docker client, which passes it to the CLI.
launcher=$(docker ps --filter "label=eigen.harness.run=$RUN" --filter "ancestor=$CLI_IMAGE" \
    --format '{{.ID}} {{.Names}}' | awk -v box="$SCRATCH_BOX" '$2 != box { print $1 }')
docker exec "$launcher" kill -INT -1 || true
CODE=0
wait "$waiter" || CODE=$?
OUT=$(cat "$SCRATCH/interrupted.log")
show
if [ "$CODE" = 130 ] && says 'Cancelled. Nothing was changed.'; then
    ok "a restore interrupted while it unpacks says it was cancelled (exit 130)"
else
    fail "the interrupted restore: exit $CODE"
fi
listing=$(api GET "$FOLDER/$root_id")
if [ "$(api_started)" = "$started" ] && printf '%s' "$listing" | grep -q '"Made before the interrupted restore"' &&
    [ ! -e "$INSTALL/data/ballast.bin" ] && [ "$(aside_count)" = "$aside" ] && [ ! -e "$INSTALL/.eigen/restore" ]; then
    ok "Eigen ran on throughout, nothing is kept aside, and the unpacked copy is gone"
else
    fail "after the interrupted restore: $listing"
fi
scratch_run rm "$INSTALL/snapshots/$BIG"

# The launcher runs these as a restore's --check, then asks for what it checked.
checked=$(docker run --rm --user 0 -e NO_COLOR=1 -v "$INSTALL:/install" -w /install "$EIGEN_API_IMAGE" \
    sh -c 'cli=/app/docker/api/entrypoint.sh; $cli restore "$1" --check --yes >/dev/null && $cli restore "$1" --checked
        rm -rf .eigen/restore' sh "$SNAPSHOT" 2>&1 || true)
if [ "$checked" = "$(printf 'version=%s\nkind=full' "$VERSION")" ]; then
    ok "restore --checked answers version=$VERSION and kind=full for what --check unpacked"
else
    fail "restore --checked answered: $checked"
fi

##############################################################################
header "./eigen backup --light, retention, and a light restore"
##############################################################################
started=$(api_started)
eigen backup --keep two
if [ "$CODE" = 1 ] && says '--keep takes a number of snapshots' && [ "$(api_started)" = "$started" ]; then
    ok "backup --keep two is refused before anything stops"
else
    fail "backup --keep two: exit $CODE"
    show
fi
scratch_run sh -c 'cd "$1" && touch eigen-pre-update-20200101-000000.tar.gz eigen-light-20100101-000000.tar.gz \
    eigen-light-20100101-000001.tar.gz eigen-light-20100101-000002.tar.gz' sh "$INSTALL/snapshots"
full_before=$(scratch_run sh -c 'cd "$1" && ls eigen-2*.tar.gz' sh "$INSTALL/snapshots" | tr '\n' ' ')
# Folders the API could make, named like tar patterns that would leave out data/server or the mount's database.
MOUNT="$INSTALL/data/home/$ADMIN_ID/mounts/default"
scratch_run sh -c 'mkdir "$1/$(printf "evil\nserver")" "$1/*" && chown 1000:1000 "$1/$(printf "evil\nserver")" "$1/*"' \
    sh "$MOUNT"
eigen backup --light
show
LIGHT=$(printf '%s\n' "$OUT" | grep -o 'eigen-light-[0-9]\{8\}-[0-9]\{6\}\.tar\.gz' | head -n 1 || true)
if [ "$CODE" = 0 ] && [ -n "$LIGHT" ] && says "Saved snapshots/$LIGHT (light: databases and config, " && stack_up; then
    ok "./eigen backup --light saved snapshots/$LIGHT, named for its kind, and the stack is back up"
else
    fail "./eigen backup --light exited $CODE"
fi
full_size=$(scratch_run stat -c %s "$INSTALL/snapshots/$SNAPSHOT")
light_size=$(scratch_run stat -c %s "$INSTALL/snapshots/$LIGHT")
log "full $full_size bytes, light $light_size bytes: $(awk -v l="$light_size" -v f="$full_size" 'BEGIN { printf "%.1f%%", 100 * l / f }') of the full one"
light=$(scratch_run sh -c 'cd "$1" && ls eigen-light-*.tar.gz' sh "$INSTALL/snapshots" | tr '\n' ' ')
full=$(scratch_run sh -c 'cd "$1" && ls eigen-2*.tar.gz' sh "$INSTALL/snapshots" | tr '\n' ' ')
if [ "$light" = "eigen-light-20100101-000001.tar.gz eigen-light-20100101-000002.tar.gz $LIGHT " ] &&
    [ "$full" = "$full_before" ] && [ -z "${full##*"$SNAPSHOT "*}" ] &&
    scratch_run test -e "$INSTALL/snapshots/eigen-pre-update-20200101-000000.tar.gz"; then
    ok "backup --light keeps the newest three light snapshots, and no full or pre-update one counts"
else
    fail "light snapshots kept: '$light'; full ones '$full', before '$full_before'"
fi
scratch_run rm "$INSTALL/snapshots/eigen-pre-update-20200101-000000.tar.gz"
members=$(scratch_run tar -tzf "$INSTALL/snapshots/$LIGHT" || true)
if printf '%s\n' "$members" | grep -q '^data/server/users3.db$' &&
    printf '%s\n' "$members" | grep -q "^data/home/$ADMIN_ID/mounts/default/metadata.db$" &&
    ! printf '%s\n' "$members" | grep -q '/mounts/default/data/'; then
    ok "the light snapshot holds data/server and the mount's database beside the planted folders, and no drive file"
else
    fail "the light snapshot holds: $(printf '%s\n' "$members" | grep -v '^data/server/' | tr '\n' ' ')"
fi

# The drive keeps its files by id: what is on disk is the files, what the listing shows is its database. A document's
# file is written by the time Eigen stops; its -wal and -shm go when it closes.
files() {
    { scratch_run ls "$INSTALL/data/home/$ADMIN_ID/mounts/default/data" 2>/dev/null || true; } |
        grep -v -e '-wal$' -e '-shm$' | tr '\n' ' ' || true
}
before=$(files)
api POST "$FOLDER/$root_id/create/doc" '{"fileName":"Made after the light snapshot"}' >/dev/null
aside=$(aside_count)
# As a snapshot from before setup always wrote the resolver address: a source install's Compose has no default for it.
# Not the subnet, whose backfilled default another stack on this host may hold.
unbound=$(scratch_run sed -n 's/^EIGEN_UNBOUND_IP=//p' "$INSTALL/.env.production")
docker run --rm --user 0 -v "$SCRATCH:$SCRATCH" --entrypoint sh "$EIGEN_API_IMAGE" -c 'dir=$(mktemp -d) &&
    tar --numeric-owner -xzpf "$1" -C "$dir" && sed -i "/^EIGEN_UNBOUND_IP=/d" "$dir/.env.production" &&
    tar --numeric-owner -czf "$1" -C "$dir" eigen-snapshot.json .env.production data && rm -rf "$dir"' \
    sh "$INSTALL/snapshots/$LIGHT"
eigen restore "$LIGHT" --yes
show
listing=$(api GET "$FOLDER/$root_id")
if [ -n "$unbound" ] && says '.env.production has what Eigen needs' &&
    [ "$(scratch_run sed -n 's/^EIGEN_UNBOUND_IP=//p' "$INSTALL/.env.production")" = "$unbound" ]; then
    ok "the restore adds the resolver address the snapshot's .env.production lacked: $unbound"
else
    fail "after the restore, .env.production holds: $(scratch_run grep '^EIGEN_' "$INSTALL/.env.production" | tr '\n' ' ')"
fi
if scratch_run test -d "$MOUNT/$(printf 'evil\nserver')" && scratch_run test -d "$MOUNT/*"; then
    ok "the planted folders are left as they are, like every file folder a light restore does not hold"
else
    fail "a planted folder is gone after the light restore"
fi
scratch_run sh -c 'rm -r "$1/$(printf "evil\nserver")" "$1/*"' sh "$MOUNT"
if [ "$CODE" = 0 ] && says "Restored $LIGHT, a light snapshot of Eigen $VERSION: databases and config restored; files and mail kept as they are" &&
    stack_up && ! printf '%s' "$listing" | grep -q '"Made after the light snapshot"'; then
    ok "a light restore puts the databases back: the document made since is out of the drive"
else
    fail "the light restore: exit $CODE, listing $listing"
fi
after=$(files)
kept=1
for file in $before; do case " $after" in *" $file "*) ;; *) kept=0 ;; esac; done
if [ "$kept" = 1 ] && [ "$(printf '%s' "$after" | wc -w)" -gt "$(printf '%s' "$before" | wc -w)" ] &&
    [ "$(aside_count)" = $((aside + 1)) ]; then
    ok "and keeps the files as they are, the document's too, with what it replaced kept aside"
else
    fail "files after the light restore: '$after', before the document '$before'; kept aside $(aside_count), was $aside"
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
if says '■  eigen-api  *exited' && says "Last snapshot  *$LIGHT"; then
    ok "status still lists the services and the last snapshot"
else
    fail "status does not list eigen-api as exited, or the last snapshot"
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
