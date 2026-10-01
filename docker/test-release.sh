#!/usr/bin/env bash
# The release gate, run locally. First the real upgrade: install the newest release published on ghcr.io before this
# one, as published, seed it, update it to the release this tree becomes, and roll back. That release is publish.yml's
# candidate of it when CANDIDATE names one, the images it publishes, and else the working tree built as it. Locally, a
# tree whose version is out already becomes the next patch release. Then releases <version>-harness.8, .9 (also
# :latest) and .10 (with a breaking change), built from the working tree and pushed to a registry:2 of this run, beside
# the new release. With ./eigen in a docker:cli container that has no Bun:
# install .8 on the default storage and seed a document, sheet, event, contact, chat message, a renamed file and a
# trashed file and folder; update to :latest, which waits out a backup that runs and makes its own on the running API
# first; roll back to that backup; refuse and then accept the breaking
# release; refuse an unknown version and a downgrade; refuse the backup of .8 while the registry is down, before
# anything stops; restore the backup of .8, which brings its launcher and Compose files back; move .8 onto the main
# channel, update it to a second build of main, roll back one build, and leave main for .10; install from main; install
# .9 from the launcher alone; install .9 twice, on one digest. The published release updates through its own launcher,
# which saves a snapshot, and goes back through the three commands ./eigen rollback prints for it.
#
# Usage:  ./docker/test-release.sh
#         ACCEPT_BREAKING=1 is for a new release that lists breaking changes since the published one: the update takes
#         --accept-breaking, and the seed is only checked after the rollback. A release that lists none fails under
#         it. publish.yml sets it for the input breaking: true.
#         CANDIDATE=candidate-<version>-amd64 installs publish.yml's candidate images as the new release instead of a
#         build; with CANDIDATE_CREATED, it waits for the candidates publish.yml stamped with that time (copy_candidate).
# Needs:  docker, curl, git, and ghcr.io. Builds the API three times, four without CANDIDATE, and the other images
#         three times, twice from the cache (the first on a cold cache takes minutes).

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

ADMIN_EMAIL=alice@example.org
PASSWORD="probe-$$"
# Prereleases of the working tree's version no real release is named like; .10 after .9 compares as numbers.
PREVIOUS=$VERSION-harness.8
NEW=$VERSION-harness.9
BREAKING=$VERSION-harness.10
SETUP_FLAGS=(--yes --mail-domain example.org --no-mail --no-relay --no-proxy --contact-email admin@example.org)
SHEET_CELL='a cell before the update'

# older_than <x.y.z>: the versions on stdin below it, oldest first.
older_than() {
    awk -F. -v want="$1" 'BEGIN { split(want, w, ".") }
        { for (i = 1; i <= 3; i++) if ($i + 0 != w[i] + 0) { if ($i + 0 < w[i] + 0) print; next } }' |
        sort -t. -k1,1n -k2,2n -k3,3n
}

# PUBLISHED, the release a self-hoster runs when this one comes out, and RELEASE, what this tree is released as.
if ! RELEASES=$(published_releases); then
    echo "harness: could not list the releases on $PUBLISHED_REGISTRY" >&2
    exit 1
fi
# A release, a prerelease too, is never published twice: its tag moves no install on.
if [ "${GITHUB_REF_TYPE:-}" = tag ] && published_get api "manifests/$VERSION" >/dev/null 2>&1; then
    echo "harness: $VERSION is published on $PUBLISHED_REGISTRY already; release a new version" >&2
    exit 1
fi
if printf '%s\n' "$RELEASES" | grep -qxF "$VERSION"; then
    PUBLISHED=$VERSION
    RELEASE=${VERSION%.*}.$((${VERSION##*.} + 1))
else
    PUBLISHED=$(printf '%s\n' "$RELEASES" | older_than "${VERSION%%-*}" | tail -n 1)
    RELEASE=$VERSION
fi
# In CI, the first release alone has none to update.
if [ -z "$PUBLISHED" ] && [ -n "$RELEASES" ] && [ -n "${CI:-}" ]; then
    echo "harness: no release before $VERSION is published on $PUBLISHED_REGISTRY, which has" \
        "$(printf '%s\n' "$RELEASES" | tr '\n' ' ')" >&2
    exit 1
fi

scratch_init release
# Release installs pull their images; the private build tags of a local build do not apply.
for name in $IMAGES; do unset "$(image_key "$name")"; done
registry_init

# release_source <version> <changelog sections>: the working tree in $SCRATCH/src-<version>, at that version, with
# the sections above the first release in its CHANGELOG.md.
release_source() {
    local dir="$SCRATCH/src-$1"
    mkdir "$dir"
    working_tree | tar -xf - -C "$dir"
    sed -i.bak "s/^  \"version\": \".*\",\$/  \"version\": \"$1\",/" "$dir/package.json"
    printf '%s\n' "$2" >"$dir/sections.md"
    awk -v sections="$dir/sections.md" '!done && /^## \[/ { while ((getline line < sections) > 0) print line; done = 1 } 1' \
        "$dir/CHANGELOG.md" >"$dir/CHANGELOG.new"
    mv "$dir/CHANGELOG.new" "$dir/CHANGELOG.md"
    rm "$dir/package.json.bak" "$dir/sections.md"
}

NEW_SECTION="## [$NEW] - 2026-09-23

The harness's new release, with nothing that breaks.

### Fixed

- **Harness** — a fix
"
BREAKING_SECTION="## [$BREAKING] - 2026-09-24

The harness's breaking release.

### Changed

- **Harness storage (breaking)** — stored another way; there is no way back
"

# tags_are <tag…>: whether the api image has these tags here and no others.
tags_are() {
    [ "$(docker image ls "$REGISTRY/api" --format '{{.Tag}}' | grep -v '<none>' | sort | tr '\n' ' ')" = \
        "$(printf '%s\n' "$@" | sort | tr '\n' ' ')" ]
}

# doc_text: the text of the seeded document, as a fresh tab on it through Caddy gets it; empty when none syncs.
doc_text() {
    local status text
    read -r status _ text <<<"$(collab_tab caddy wss://localhost "$DOC_ID" '' '')"
    if [ "$status" = synced ]; then printf '%s' "$text"; fi
}

seed() {
    local drive="/drive/$ADMIN_ID/default" folder
    ROOT_ID=$(api GET "$drive/root" | first_id)
    DOC_ID=$(api POST "$drive/folder/$ROOT_ID/create/doc" '{"fileName":"Release doc"}' | first_id)
    collab_tab caddy wss://localhost "$DOC_ID" '' 'typed before the update' >/dev/null
    SHEET_ID=$(api POST "$drive/folder/$ROOT_ID/create/sheets" '{"fileName":"Release sheet"}' | first_id)
    # A workbook of one cell, imported as an operator imports an xlsx into a sheet.
    docker run --rm --entrypoint bun -e CELL="$SHEET_CELL" "$(api_image)" -e '
        const ExcelJS = require("exceljs");
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet("Sheet1").getCell("A1").value = process.env.CELL;
        workbook.xlsx.writeBuffer().then((buffer) => process.stdout.write(Buffer.from(buffer)));
    ' >"$SCRATCH/seed.xlsx"
    curl -sk -b "$JAR" -o /dev/null -X POST -H 'Content-Type: application/octet-stream' -H 'Origin: https://localhost' \
        --data-binary "@$SCRATCH/seed.xlsx" "$BASE$drive/file/$SHEET_ID/import" || true
    CAL_ID=$(api GET "/calendar/$ADMIN_ID/calendars" |
        grep -o '"id":"[^"]*","name":"[^"]*","color":"[^"]*","isDefault":true' | cut -d'"' -f4 || true)
    EVENT_ID=$(api POST "/calendar/$ADMIN_ID/calendars/$CAL_ID/events" \
        '{"title":"Release event","startTime":"2026-10-01T10:00:00Z","endTime":"2026-10-01T11:00:00Z","allDay":false}' |
        first_id)
    CONTACT_ID=$(api POST "/contacts/$ADMIN_ID/contacts" \
        '{"firstName":"Release","lastName":"Contact","email":["release@example.com"],"phone":[]}' | tr -d '"')
    CHAT_ID=$(api POST "$drive/folder/$ROOT_ID/create/chat" '{"fileName":"Release chat"}' | first_id)
    api POST "/chat/$ADMIN_ID/default/$CHAT_ID/messages" '{"content":"survives the update"}' >/dev/null
    # What the drive of an install that has been used holds: a file renamed, and a file and a folder with a file in it
    # in the trash, each moved on disk, since the default storage keeps files by name.
    RENAMED_ID=$(upload "$ROOT_ID" 'Release note.txt' | first_id)
    api PUT "$drive/path/$RENAMED_ID/rename" '{"newName":"Release renamed.txt"}' >/dev/null
    api DELETE "$drive/path/$(upload "$ROOT_ID" 'Release trashed.txt' | first_id)" >/dev/null
    folder=$(api POST "$drive/folder/$ROOT_ID" '{"folderName":"Release folder"}' | first_id)
    upload "$folder" 'Release inside.txt' >/dev/null
    api DELETE "$drive/path/$folder" >/dev/null
}

# upload <folder ID> <name>: a file of one line, $SEED_TEXT, into that folder of the admin's drive; prints the answer.
SEED_TEXT='kept under a new name'
upload() {
    printf '%s\n' "$SEED_TEXT" >"$SCRATCH/upload.txt"
    curl -sk -b "$JAR" -X POST -H 'Origin: https://localhost' -F "file=@$SCRATCH/upload.txt;filename=$2" \
        "$BASE/drive/$ADMIN_ID/default/file/$1" || true
}

# missing_items: what of the seed is gone, empty when all of it is there. Signs in first: a rollback brings back
# the session store of its backup.
missing_items() {
    local listing missing=''
    sign_in "$PASSWORD" "$JAR" >/dev/null
    listing=$(api GET "/drive/$ADMIN_ID/default/folder/$ROOT_ID")
    for name in 'Release doc.eigendoc' 'Release sheet.eigensheets' 'Release chat.eigenchat'; do
        printf '%s' "$listing" | grep -q "\"$name\"" || missing="$missing '$name'"
    done
    [ "$(doc_text)" = 'typed before the update' ] || missing="$missing 'document text'"
    api GET "/drive/$ADMIN_ID/default/file/$SHEET_ID/export/html" | grep -qF "$SHEET_CELL" ||
        missing="$missing 'sheet cell'"
    api GET "/calendar/$ADMIN_ID/calendars/$CAL_ID/events/$EVENT_ID" | grep -q '"Release event"' || missing="$missing event"
    api GET "/contacts/$ADMIN_ID/contacts/$CONTACT_ID" | grep -q '"release@example.com"' || missing="$missing contact"
    api GET "/chat/$ADMIN_ID/default/$CHAT_ID/messages" | grep -q '"survives the update"' || missing="$missing message"
    api GET "/drive/$ADMIN_ID/default/file/$RENAMED_ID/download" | grep -qxF "$SEED_TEXT" ||
        missing="$missing 'renamed file'"
    listing=$(api GET "/drive/$ADMIN_ID/default/trash")
    for name in 'Release trashed.txt' 'Release folder'; do
        printf '%s' "$listing" | grep -q "\"$name\"" || missing="$missing 'trashed $name'"
    done
    printf '%s' "$missing"
}

# check_pinned <version> [pinned [registry]]: healthy, status names the version, it or what is pinned instead (a
# channel) is pinned by digest, from this run's registry by default, and on a release of this tree the API reads
# .env.production. A release published before it may not share the file yet.
check_pinned() {
    local pinned=${2:-$1}
    if stack_up; then ok "every service runs and eigen-api is healthy"; else fail "the stack is not up"; fi
    eigen status
    if says "Version  *$1"; then ok "status shows $1"; else fail "status shows another version"; show; fi
    if [ "$(env_of EIGEN_VERSION)" = "$pinned" ] && env_of EIGEN_API_IMAGE | grep -q "^${3:-$REGISTRY}/api@sha256:"; then
        ok ".env.production pins $pinned by digest"
    else
        fail ".env.production pins $(env_of EIGEN_VERSION) as $(env_of EIGEN_API_IMAGE)"
    fi
    if [ -z "${3:-}" ]; then check_env 0:0 "on $1"; fi
}

# check_running <version> [pinned [registry]]: check_pinned, and every seeded item is there.
check_running() {
    local missing
    check_pinned "$@"
    missing=$(missing_items)
    if [ -z "$missing" ]; then
        ok "the document and its text, the sheet and its cell, event, contact, chat message, renamed file and trash are all there"
    else
        fail "missing:$missing"
    fi
}

# check_channel <commit>: check_running on the build of main at that commit, which is $NEW's code.
check_channel() { check_running "$NEW ($1) on main" main; }

# build_main <commit>: the five images of a build of main at that commit, from $NEW's code and cache, each labeled
# with the commit as publish.yml labels them. Pushed as :main and untagged, so the installs pull what they run. Like
# an install's own pull of a new build, the tag moves off the build an install pins.
build_main() {
    local name
    build -f "$SCRATCH/src-$NEW/docker/api/Dockerfile" --build-arg "EIGEN_VERSION=$NEW" --build-arg "EIGEN_COMMIT=$1" \
        --build-arg EIGEN_CHANNEL=main --build-arg "EIGEN_REGISTRY=$REGISTRY" -t "$REGISTRY/api:main" "$SCRATCH/src-$NEW"
    build -f "$SCRATCH/src-$NEW/docker/frontend/Dockerfile" --build-arg "EIGEN_COMMIT=$1" \
        -t "$REGISTRY/frontend:main" "$SCRATCH/src-$NEW"
    for name in postfix dovecot unbound; do
        build --build-arg "EIGEN_COMMIT=$1" -t "$REGISTRY/$name:main" "$SCRATCH/src-$NEW/docker/$name"
    done
    for name in $IMAGES; do
        docker push -q "$REGISTRY/$name:main" >/dev/null 2>&1
        docker image rm "$REGISTRY/$name:main" >/dev/null
    done
}

# image_label <image> <version or revision>: that org.opencontainers.image label of a local image.
image_label() { docker image inspect --format "{{index .Config.Labels \"org.opencontainers.image.$2\"}}" "$1"; }

# The api image the install runs, by ID.
api_image() { docker inspect --format '{{.Image}}' "$(dc ps -q eigen-api)"; }

# What backups/ holds.
backups() { scratch_run ls "$INSTALL/backups"; }

# Every line of the env file but the pins.
unpinned() { scratch_run cat "$INSTALL/.env.production" | grep -v '^EIGEN_\(VERSION\|[A-Z]*_IMAGE\)='; }

# The image pins of the env file.
pins() { scratch_run grep '^EIGEN_[A-Z]*_IMAGE=' "$INSTALL/.env.production" || true; }

# check_pins <pins>: after a rollback, the env file pins every image as it did before the update.
check_pins() {
    if [ -n "$1" ] && [ "$(pins)" = "$1" ]; then
        ok "every image is pinned as before the update"
    else
        fail "the pins after the rollback: $(diff <(printf '%s\n' "$1") <(pins) | tr '\n' ' ')"
    fi
}

api_tags() { docker image ls "$REGISTRY/api" --format '{{.Tag}}' | tr '\n' ' '; }

header "Releases $RELEASE, $PREVIOUS, $NEW and $BREAKING in a registry on port $REGISTRY_PORT"
started=$SECONDS
release_source "$PREVIOUS" ''
release_source "$NEW" "$NEW_SECTION"
release_source "$BREAKING" "$BREAKING_SECTION
$NEW_SECTION"
build() { docker build -q --label eigen.harness=1 --build-arg BUN_VERSION "$@" >/dev/null; }
# build_release <version>: its api image from its source, as a build of this tree that names commit harness.
build_release() {
    build -f "$SCRATCH/src-$1/docker/api/Dockerfile" --build-arg "EIGEN_VERSION=$1" --build-arg EIGEN_COMMIT=harness \
        --build-arg "EIGEN_REGISTRY=$REGISTRY" -t "$REGISTRY/api:$1" "$SCRATCH/src-$1"
}
for version in "$PREVIOUS" "$NEW" "$BREAKING"; do build_release "$version"; done
# One commit for all five, or the launcher refuses them as images of different builds.
build -f "$SCRATCH/src-$NEW/docker/frontend/Dockerfile" --build-arg EIGEN_COMMIT=harness \
    -t "$REGISTRY/frontend:$NEW" "$SCRATCH/src-$NEW"
for name in postfix dovecot unbound; do
    build --build-arg EIGEN_COMMIT=harness -t "$REGISTRY/$name:$NEW" "$SCRATCH/src-$NEW/docker/$name"
done
tags=("$PREVIOUS" "$NEW" "$BREAKING" latest)
if [ -z "${CANDIDATE:-}" ]; then
    release_source "$RELEASE" ''
    build_release "$RELEASE"
    tags+=("$RELEASE")
fi
for name in $IMAGES; do
    # api has a build of each version; latest, and every version of the other images, are $NEW's.
    for tag in "${tags[@]}"; do
        if [ "$tag" = latest ] || [ "$name" != api ]; then docker tag "$REGISTRY/$name:$NEW" "$REGISTRY/$name:$tag"; fi
    done
    for tag in "${tags[@]}"; do docker push -q "$REGISTRY/$name:$tag" >/dev/null 2>&1; done
done
# The installs must pull what they run.
remove_registry_images
ok "built and pushed the releases of this tree in $((SECONDS - started))s"
RELEASE_COMMIT=harness
if [ -n "${CANDIDATE:-}" ]; then
    started=$SECONDS
    if ! copy_candidate "$CANDIDATE" "$RELEASE"; then
        abort "no $CANDIDATE of this run on $PUBLISHED_REGISTRY: a publish job failed, or 40 minutes went by"
    fi
    RELEASE_COMMIT=$(image_label "$PUBLISHED_REGISTRY/api:$CANDIDATE" revision)
    if [ "$(image_label "$PUBLISHED_REGISTRY/api:$CANDIDATE" version)" != "$RELEASE" ]; then
        abort "$CANDIDATE is $(image_label "$PUBLISHED_REGISTRY/api:$CANDIDATE" version), not $RELEASE"
    fi
    remove_registry_images
    ok "$CANDIDATE ($RELEASE_COMMIT), as publish.yml publishes it, is $RELEASE here after $((SECONDS - started))s"
fi
JAR="$SCRATCH/session"

##############################################################################
header "Updating $PUBLISHED, as published, to $RELEASE"
##############################################################################
# upgrade_published: $PUBLISHED from $PUBLISHED_REGISTRY, seeded, updated to $RELEASE and rolled back, as a
# self-hoster does when $RELEASE comes out.
upgrade_published() {
    local before after pinned pointer meta missing snapshot=eigen-pre-update-light- breaking=''
    release_install "eigentest-published-$$" "$PUBLISHED" "$PUBLISHED_REGISTRY"
    run_setup "$SCRATCH/setup-published.log" "${SETUP_FLAGS[@]}" --domain localhost
    if ! create_admin "$SCRATCH/setup-published.log" "$PASSWORD"; then
        fail "the setup link of $PUBLISHED made no admin"
        return
    fi
    seed
    check_running "$PUBLISHED" "$PUBLISHED" "$PUBLISHED_REGISTRY"
    # $RELEASE is not out yet: the install names this run's registry, which holds it, as a mirror install does.
    scratch_run sed -i "s|^EIGEN_REGISTRY=.*|EIGEN_REGISTRY=$REGISTRY|" "$INSTALL/.env.production"
    if [ "$(env_of EIGEN_REGISTRY)" != "$REGISTRY" ]; then
        fail ".env.production of $PUBLISHED has no EIGEN_REGISTRY line to name this run's registry"
        return
    fi
    before=$(unpinned)
    pinned=$(pins)

    started=$SECONDS
    eigen update "$RELEASE"
    show
    if [ "$CODE" = 1 ] && says "■  Eigen $RELEASE has breaking changes, listed above."; then
        # The rest of the gate cannot make up for it.
        if [ "${ACCEPT_BREAKING:-}" != 1 ]; then
            abort "$RELEASE lists breaking changes since $PUBLISHED, so ./eigen update refuses it on every install of" \
                "$PUBLISHED. To publish it anyway, run publish.yml on its tag with the input breaking: true" \
                "(locally: ACCEPT_BREAKING=1)"
        fi
        ok "$RELEASE lists breaking changes since $PUBLISHED, accepted by ACCEPT_BREAKING=1"
        breaking=1
        # A breaking release may convert what a light snapshot leaves out.
        snapshot=eigen-pre-update-2
        started=$SECONDS
        eigen update "$RELEASE" --accept-breaking
        show
    # An update that failed otherwise says nothing of its breaking changes; the check below reports it.
    elif [ "$CODE" = 0 ]; then
        if [ "${ACCEPT_BREAKING:-}" = 1 ]; then
            fail "the gate ran with breaking: true, but $RELEASE lists no breaking change since $PUBLISHED. A (breaking)" \
                "line counts only under ## [$RELEASE] in CHANGELOG.md, not under [Unreleased]"
        else
            ok "$RELEASE lists no breaking changes since $PUBLISHED, so it updates without --accept-breaking"
        fi
    fi
    if [ "$CODE" = 0 ] &&
        says "◇  Eigen $PUBLISHED (.*) → $RELEASE ($RELEASE_COMMIT) is running at https://localhost/"; then
        ok "./eigen update went from $PUBLISHED to $RELEASE in $((SECONDS - started))s"
    else
        fail "./eigen update from $PUBLISHED to $RELEASE exited $CODE"
    fi
    if [ -n "$breaking" ]; then
        check_pinned "$RELEASE"
        # Its breaking changes may drop some of the seed: what is gone is told, and fails nothing.
        missing=$(missing_items)
        if [ -z "$missing" ]; then
            ok "the seed is all there on $RELEASE"
        else
            skip "the seed on $RELEASE, whose breaking changes dropped:$missing"
        fi
    else
        check_running "$RELEASE"
    fi
    after=$(unpinned)
    if [ "${after:0:${#before}}" = "$before" ]; then
        ok "every line of .env.production but the pins is kept"
    else
        fail ".env.production changed: $(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | tr '\n' ' ')"
    fi
    # $PUBLISHED's launcher hands over without a backup: its own image saved a snapshot after the stop.
    pointer=$(scratch_run sed -n 1p "$INSTALL/.eigen/last-update" 2>/dev/null || true)
    meta=$(scratch_run tar -xzOf "$INSTALL/snapshots/${pointer:-none}" eigen-snapshot.json 2>/dev/null || true)
    if [[ $pointer == "$snapshot"* ]] && [[ $meta == *"\"version\":\"$PUBLISHED\""* ]]; then
        ok ".eigen/last-update names snapshots/$pointer, made by $PUBLISHED before the update"
    else
        fail ".eigen/last-update names '$pointer', expected a $snapshot* snapshot of $PUBLISHED; it holds '$meta'"
    fi
    probe_site "https://localhost:$PORT_HTTPS"

    started=$SECONDS
    eigen rollback --yes
    show
    back=$(printf '%s\n' "$OUT" | sed -n 's/^│  \(docker run .* bootstrap --force --out \/install\)$/\1/p')
    restore=$(printf '%s\n' "$OUT" | sed -n 's/^│  \(EIGEN_API_IMAGE=.* \.\/eigen restore .*\)$/\1/p')
    clear=$(printf '%s\n' "$OUT" | sed -n 's/^│  \(rm -f \.eigen\/last-update \.eigen\/bundle\)$/\1/p')
    if [ "$CODE" = 0 ] && [ -n "$back" ] && [ -n "$restore" ] && [ -n "$clear" ]; then
        ok "./eigen rollback prints the three commands that go back to $PUBLISHED"
    else
        fail "./eigen rollback after the update from $PUBLISHED: exit $CODE"
    fi
    CODE=0
    OUT=$(in_cli_container sh -c "$back && $restore --yes && $clear" 2>&1) || CODE=$?
    show
    if [ "$CODE" = 0 ] && stack_up && ! scratch_run test -e "$INSTALL/.eigen/last-update" &&
        ! scratch_run test -e "$INSTALL/.eigen/bundle"; then
        ok "those three commands went back to $PUBLISHED in $((SECONDS - started))s, and left nothing of $RELEASE in .eigen/"
    else
        fail "the way back to $PUBLISHED exited $CODE"
    fi
    check_running "$PUBLISHED" "$PUBLISHED" "$PUBLISHED_REGISTRY"
    check_pins "$pinned"
    probe_site "https://localhost:$PORT_HTTPS"
}
if [ -n "$PUBLISHED" ]; then
    upgrade_published
    down_project "$PROJECT"
elif [ -z "$RELEASES" ]; then
    skip "the update from a published release: none is published on $PUBLISHED_REGISTRY yet, so $RELEASE is the first"
else
    skip "the update from a published release: none before $VERSION is published on $PUBLISHED_REGISTRY"
fi

##############################################################################
header "Installing $PREVIOUS"
##############################################################################
release_install "eigentest-release-$$" "$PREVIOUS"
run_setup "$SCRATCH/setup.log" "${SETUP_FLAGS[@]}" --domain localhost
if ! create_admin "$SCRATCH/setup.log" "$PASSWORD"; then
    abort "the setup link of $PREVIOUS made no admin"
fi
seed
check_running "$PREVIOUS"
UNPINNED=$(unpinned)
PINS_BEFORE=$(pins)

##############################################################################
header "./eigen update to :latest"
##############################################################################
# A Full backup that runs when the update starts, slow with a file of noise in the home: the update's own backup
# waits it out instead of failing. Its Light backup holds the file too, so the rollback brings it back. Its
# record's mtime says when it ended.
BALLAST="$INSTALL/data/home/$ADMIN_ID/ballast.bin"
scratch_run sh -c 'head -c 1000000000 /dev/urandom >"$1" && chown 1000:1000 "$1"' sh "$BALLAST"
(
    eigen backup
    printf '%s\n' "$OUT" >"$SCRATCH/running-backup.log"
    scratch_run stat -c %Y "$INSTALL/backups/$(saved_archive).json" >"$SCRATCH/running-backup.ended" 2>/dev/null || :
    exit "$CODE"
) &
running=$!
for _ in $(seq 1 300); do
    if backups | grep -q '^server-manual-full-.*\.tar\.json$'; then break; fi
    sleep 0.2
done
# The line the update's backup step writes while it waits, seen while it waits: the step's log is overwritten after.
(
    for _ in $(seq 1 1500); do
        if scratch_run grep -q 'Waiting for the running server backup to end' "$INSTALL/.eigen/last-step.log"; then
            touch "$SCRATCH/update-waited"
            exit 0
        fi
        sleep 0.2
    done
) 2>/dev/null &
watching=$!
started=$SECONDS
since=$(date +%s)
eigen update
show
backed_up=0
wait "$running" || backed_up=$?
kill "$watching" 2>/dev/null || :
wait "$watching" 2>/dev/null || :
scratch_run rm "$BALLAST"
if [ "$CODE" = 0 ] && says "◆  Eigen $NEW" && says "The harness's new release" &&
    says "◇  Eigen $PREVIOUS (harness) → $NEW (harness) is running at https://localhost/"; then
    ok "./eigen update went from $PREVIOUS to $NEW in $((SECONDS - started))s, with its notes"
else
    fail "./eigen update exited $CODE"
fi
saved=$(scratch_run cat "$INSTALL/.eigen/last-update" 2>/dev/null || true)
manual=$(sed -n 's/^archive=//p' "$SCRATCH/running-backup.log")
# A miss is the product's only if the update asked while the backup still ran: when its backup command started, with
# five seconds for the CLI to reach the API, against when the running one ended.
ended=$(cat "$SCRATCH/running-backup.ended" 2>/dev/null || true)
asked=$(docker events --since "$since" --until "$(date +%s)" --filter "container=$PROJECT-eigen-api-1" \
    --format '{{.Time}} {{.Action}}' | awk '/exec_start: .* backup .*--reason pre-update/ { print $1; exit }' || true)
if [ "$backed_up" != 0 ] || [ -z "$manual" ] || [[ $saved != server-pre-update-light-*.tar ]] ||
    ! says "Saved before the update: backups/$saved"; then
    fail "the backups around the update: the running one exited $backed_up as '$manual', the update's is '$saved'"
elif [ -e "$SCRATCH/update-waited" ]; then
    ok "the update waited for the backup that ran, $manual, then made $saved on the running API"
elif [ -n "$asked" ] && [ -n "$ended" ] && [ "$asked" -ge $((ended - 5)) ]; then
    skip "harness timing: the backup ended before the update asked, or too close to tell (ended at $ended, asked at $asked), so the wait went untested"
else
    fail "the update asked for its backup at '$asked', before $manual ended at '$ended', and was not seen waiting for it"
fi
check_running "$NEW"
after=$(unpinned)
if [ "${after:0:${#UNPINNED}}" = "$UNPINNED" ]; then
    ok "every line of .env.production but the pins is kept"
else
    fail ".env.production changed: $(diff <(printf '%s\n' "$UNPINNED") <(printf '%s\n' "$after") | tr '\n' ' ')"
fi
# latest is the same image as $NEW.
if tags_are "$PREVIOUS" "$NEW" latest; then
    ok "only $PREVIOUS (for a rollback) and $NEW, also tagged latest, are kept"
else
    fail "api tags kept: $(api_tags)"
fi
if grep -qx 'image prune -f --filter label=org.opencontainers.image.source=https://github.com/eigen-is/eigen' \
    "$PRUNE_LOG"; then
    ok "it prunes Eigen's dangling images"
else
    fail "the prunes: $(cat "$PRUNE_LOG")"
fi

started=$(api_started)
eigen update
if [ "$CODE" = 0 ] && says "Eigen $NEW (harness) is up to date and running at https://localhost/" &&
    [ "$(api_started)" = "$started" ]; then
    ok "a rerun says $NEW is up to date and running, and restarts nothing"
else
    fail "the rerun: exit $CODE"
    show
fi
eigen update --check
if [ "$CODE" = 0 ] && says "Eigen $NEW (harness) is up to date." && [ "$(api_started)" = "$started" ]; then
    ok "--check says it is up to date"
else
    fail "update --check: exit $CODE"
    show
fi

##############################################################################
header "./eigen rollback"
##############################################################################
eigen_piped n rollback
if [ "$CODE" = 0 ] && says "A light archive of Eigen $PREVIOUS for localhost, made on " && says 'Nothing was changed.' &&
    [ "$(api_started)" = "$started" ] && ! scratch_run test -e "$INSTALL/data/.restoring"; then
    ok "rollback asks with the level, the version, the date and the age, and a no stops nothing"
else
    fail "rollback answered no: exit $CODE"
    show
fi
started=$SECONDS
eigen rollback --yes
show
if [ "$CODE" = 0 ] && says "◇  Eigen $NEW (harness) → $PREVIOUS (harness) is running at https://localhost/"; then
    ok "./eigen rollback --yes went back to $PREVIOUS in $((SECONDS - started))s"
else
    fail "./eigen rollback exited $CODE"
fi
check_running "$PREVIOUS"
check_pins "$PINS_BEFORE"
if [ ! -e "$INSTALL/.eigen/last-update" ] && ls -d "$INSTALL"/data.pre-restore-* >/dev/null 2>&1; then
    ok "the pointer is gone and the data of $NEW is kept aside"
else
    fail "after the rollback: .eigen/last-update is left, or no data.pre-restore-*"
fi
scratch_run rm -f "$BALLAST"
eigen rollback --yes
if [ "$CODE" = 1 ] && says '■  There is no update to roll back.'; then
    ok "a second rollback says there is nothing to roll back"
else
    fail "a second rollback: exit $CODE"
    show
fi

##############################################################################
header "A breaking release"
##############################################################################
started=$(api_started)
inode=$(scratch_run stat -c %i "$INSTALL/eigen")
env_before=$(scratch_run cat "$INSTALL/.env.production")
backups_before=$(backups)
eigen update "$BREAKING"
show
if [ "$CODE" = 1 ] && says '▲  Harness storage (breaking)' &&
    says "■  Eigen $BREAKING has breaking changes, listed above." &&
    says '└  Read them, then run ./eigen update --accept-breaking.'; then
    ok "update to $BREAKING lists the breaking change and refuses without --accept-breaking"
else
    fail "update to $BREAKING without the flag: exit $CODE"
fi
if [ "$(api_started)" = "$started" ] && [ "$(scratch_run stat -c %i "$INSTALL/eigen")" = "$inode" ] &&
    [ "$(scratch_run cat "$INSTALL/.env.production")" = "$env_before" ] && [ "$(backups)" = "$backups_before" ]; then
    ok "the refusal stopped nothing and changed nothing"
else
    fail "the refused update changed something"
fi
started=$SECONDS
eigen update "$BREAKING" --accept-breaking
show
if [ "$CODE" = 0 ] && says "◇  Eigen $PREVIOUS (harness) → $BREAKING (harness) is running at https://localhost/"; then
    ok "with --accept-breaking it went to $BREAKING in $((SECONDS - started))s"
else
    fail "update to $BREAKING --accept-breaking: exit $CODE"
fi
check_running "$BREAKING"
if tags_are "$PREVIOUS" "$BREAKING"; then
    ok "$NEW is removed, $PREVIOUS and $BREAKING are kept"
else
    fail "api tags kept: $(api_tags)"
fi

##############################################################################
header "Versions that cannot be installed"
##############################################################################
started=$(api_started)
eigen update 9.9.9
if [ "$CODE" = 1 ] && says '■  Could not get Eigen 9.9.9' && says 'Releases: https://github.com/eigen-is/eigen/releases' &&
    [ "$(api_started)" = "$started" ]; then
    ok "an unknown version fails before anything stops, and points at the releases"
else
    fail "update 9.9.9: exit $CODE"
    show
fi
eigen update "$NEW"
if [ "$CODE" = 1 ] && says "■  Eigen $NEW is older than Eigen $BREAKING, which runs here." &&
    [ "$(api_started)" = "$started" ]; then
    ok "a downgrade is refused before anything stops"
else
    fail "update to $NEW from $BREAKING: exit $CODE"
    show
fi

##############################################################################
header "./eigen restore of the backup of $PREVIOUS"
##############################################################################
started=$(api_started)
env_before=$(scratch_run cat "$INSTALL/.env.production")
aside=$(aside_count)
# unchanged: Eigen was not stopped, and .env.production and data/ are as before, with nothing left staged.
unchanged() {
    [ "$(api_started)" = "$started" ] && [ "$(scratch_run cat "$INSTALL/.env.production")" = "$env_before" ] &&
        [ "$(aside_count)" = "$aside" ] && ! scratch_run test -e "$INSTALL/data/.restoring"
}

# The backup the update to $BREAKING made of $PREVIOUS.
archive=$(scratch_run cat "$INSTALL/.eigen/last-update")
# Only the registry has the images of $PREVIOUS now.
for name in $IMAGES; do docker image rm "$REGISTRY/$name:$PREVIOUS" >/dev/null; done
docker stop "eigentest-registry-$RUN" >/dev/null
eigen restore "$archive" --yes
docker start "eigentest-registry-$RUN" >/dev/null
if [ "$CODE" = 1 ] && says "■  Could not get Eigen $PREVIOUS; Eigen runs on as it was" && unchanged; then
    ok "with the registry down, a restore of the backup of $PREVIOUS stops nothing and says so"
else
    fail "the restore with the registry down: exit $CODE"
    show
fi
for _ in $(seq 30); do
    if curl -sf "http://localhost:$REGISTRY_PORT/v2/" >/dev/null; then break; fi
    sleep 1
done

inode=$(scratch_run stat -c %i "$INSTALL/eigen")
eigen restore "$archive" --yes
show
if [ "$CODE" = 0 ] && says "◇  Eigen $PREVIOUS (harness) files written" && [ "$(scratch_run stat -c %i "$INSTALL/eigen")" != "$inode" ]; then
    ok "a restore of the backup of $PREVIOUS on $BREAKING writes the launcher and Compose files of $PREVIOUS"
else
    fail "the restore of the backup of $PREVIOUS: exit $CODE"
fi
check_running "$PREVIOUS"

##############################################################################
header "The main channel"
##############################################################################
# registry:2 over plain HTTP takes no annotations, so the launcher finds the commit of main's newest build by pulling
# api:main and reading its label.
build_main main1
eigen update main
show
if [ "$CODE" = 0 ] && says "◇  Eigen $PREVIOUS (harness) → $NEW (main1) is running at https://localhost/"; then
    ok "./eigen update main moved $PREVIOUS onto the main channel"
else
    fail "./eigen update main exited $CODE"
fi
check_channel main1
main1=$(api_image)

started=$(api_started)
eigen update
if [ "$CODE" = 0 ] && says "Eigen $NEW (main1) is up to date and running at https://localhost/" &&
    [ "$(api_started)" = "$started" ]; then
    ok "./eigen update on the newest build of main says it is up to date, and restarts nothing"
else
    fail "update on the newest build of main: exit $CODE"
    show
fi
eigen update --check
if [ "$CODE" = 0 ] && says "Eigen $NEW (main1) is up to date." && [ "$(api_started)" = "$started" ]; then
    ok "--check on the newest build of main says it is up to date"
else
    fail "update --check on the newest build of main: exit $CODE"
    show
fi

build_main main2
eigen update --check
if [ "$CODE" = 0 ] && says "Eigen $NEW (main2) is out" && says '└  ./eigen update installs it.' &&
    [ "$(api_started)" = "$started" ]; then
    ok "--check names the new build of main, and stops nothing"
else
    fail "update --check with a new build of main: exit $CODE"
    show
fi
eigen update
show
if [ "$CODE" = 0 ] && says "◇  Eigen $NEW (main1) → $NEW (main2) is running at https://localhost/"; then
    ok "./eigen update installed the new build of main"
else
    fail "update to the new build of main: exit $CODE"
fi
check_channel main2
kept=$(docker image ls --all "$REGISTRY/api" -q --no-trunc | sort -u | tr '\n' ' ')
if [ "$kept" = "$(printf '%s\n' "$main1" "$(api_image)" | sort -u | tr '\n' ' ')" ]; then
    ok "only the two builds of main are kept: the running one, and the one the rollback's backup pins"
else
    fail "api images kept: $kept"
    for id in $kept; do
        log "  $id $(docker image inspect --format 'tags={{.RepoTags}} digests={{.RepoDigests}}' "$id")" \
            "build=$(image_label "$id" version) $(image_label "$id" revision)"
        docker ps -a --filter "ancestor=$id" --format '      used by {{.Names}} ({{.Status}})'
    done
fi

eigen rollback --yes
show
if [ "$CODE" = 0 ] && says "Back from Eigen $NEW (main2) to the backup the last update made" &&
    says "◇  Eigen $NEW (main2) → $NEW (main1) is running at https://localhost/"; then
    ok "./eigen rollback went back to the previous build of main"
else
    fail "rollback on main: exit $CODE"
fi
check_channel main1

started=$(api_started)
eigen update "$BREAKING"
if [ "$CODE" = 1 ] && says "■  Eigen $BREAKING has breaking changes, listed above." && [ "$(api_started)" = "$started" ]; then
    ok "leaving main for $BREAKING refuses its breaking change, since the version changes"
else
    fail "update from main to $BREAKING without the flag: exit $CODE"
    show
fi
eigen update "$BREAKING" --accept-breaking
show
if [ "$CODE" = 0 ] && says "◇  Eigen $NEW (main1) → $BREAKING (harness) is running at https://localhost/"; then
    ok "./eigen update $BREAKING left main"
else
    fail "update from main to $BREAKING --accept-breaking: exit $CODE"
fi
check_running "$BREAKING"
down_project "$PROJECT"

release_install "eigentest-main-$$" main
run_setup "$SCRATCH/setup-main.log" "${SETUP_FLAGS[@]}" --domain localhost
if stack_up && [ "$(env_of EIGEN_VERSION)" = main ]; then
    ok "an install bootstrapped from api:main follows main and runs"
else
    fail "the install from api:main: EIGEN_VERSION=$(env_of EIGEN_VERSION)"
fi
down_project "$PROJECT"

##############################################################################
header "Installing $NEW from the launcher alone"
##############################################################################
# The path eigen.is/install takes, whose script runs in test-launcher.sh: the no-Bun image has no curl or wget. Setup
# beside the launcher alone bootstraps from api:latest, which is $NEW.
register_install "eigentest-alone-$$" 0:0
scratch_run mkdir "$INSTALL"
scratch_run cp /repo/eigen "$INSTALL/eigen"
# The harness's registry is a mirror: named in .env.production before the first setup, as a mirror install does by hand.
scratch_run sh -c 'umask 077 && echo "EIGEN_REGISTRY=$1" >"$2"' sh "$REGISTRY" "$INSTALL/.env.production"
assert_isolated
write_override
run_setup "$SCRATCH/setup-alone.log" "${SETUP_FLAGS[@]}" --domain localhost
missing=''
for file in docker-compose.yml .env.example docker/fail2ban; do
    scratch_run test -e "$INSTALL/$file" || missing="$missing $file"
done
if [ -z "$missing" ]; then
    ok "setup wrote the Compose file, .env.example and the fail2ban files beside the launcher"
else
    fail "setup beside the launcher alone left out:$missing"
fi
if stack_up && [ "$(env_of EIGEN_VERSION)" = "$NEW" ] && env_of EIGEN_API_IMAGE | grep -q "^$REGISTRY/api@sha256:"; then
    ok "the install from the launcher alone runs, and .env.production pins $NEW by digest"
else
    fail "the install from the launcher alone: EIGEN_VERSION=$(env_of EIGEN_VERSION), $(env_of EIGEN_API_IMAGE)"
fi
if [ "$(env_of EIGEN_REGISTRY)" = "$REGISTRY" ]; then
    ok "bootstrap kept the registry .env.production named"
else
    fail "bootstrap replaced the registry .env.production named with '$(env_of EIGEN_REGISTRY)'"
fi
down_project "$PROJECT"

##############################################################################
header "Fresh installs of $NEW with two web addresses"
##############################################################################
PINS=()
RUNS=()
PORTS=()
for domain in localhost eigen2.localhost; do
    release_install "eigentest-release-${domain%%.*}-$$" "$NEW"
    run_setup "$SCRATCH/setup-$domain.log" "${SETUP_FLAGS[@]}" --domain "$domain"
    if stack_up; then ok "a fresh install of $NEW for $domain runs"; else fail "the fresh install for $domain is not up"; fi
    PINS+=("$(env_of EIGEN_API_IMAGE)")
    RUNS+=("$(docker inspect --format '{{.Image}}' "$(dc ps -q eigen-api)")")
    PORTS+=("$PORT_HTTPS")
done
n=0
for domain in localhost eigen2.localhost; do
    code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$domain:${PORTS[$n]}:127.0.0.1" \
        "https://$domain:${PORTS[$n]}/eigen/health" || echo 000)
    if [ "$code" = 200 ]; then ok "https://$domain/eigen/health answers 200"; else fail "https://$domain/eigen/health → $code"; fi
    n=$((n + 1))
done
if [ -n "${PINS[0]}" ] && [ "${PINS[0]}" = "${PINS[1]}" ] && [ "${RUNS[0]}" = "${RUNS[1]}" ]; then
    ok "both run the same api image, ${PINS[0]#*@}"
else
    fail "the two installs run ${PINS[0]} (${RUNS[0]}) and ${PINS[1]} (${RUNS[1]})"
fi

header "Result"
probe_summary
