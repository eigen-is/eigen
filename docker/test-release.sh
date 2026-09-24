#!/usr/bin/env bash
# The release gate, run locally: releases 0.2.98, 0.2.99 (also :latest) and 0.2.100 (with a breaking change), built
# from the working tree and pushed to a registry:2 of this run. With ./eigen in a docker:cli container that has no Bun:
# install 0.2.98 and seed a document, sheet, event, contact and chat message; update to :latest; roll back; refuse and
# then accept the breaking release; refuse an unknown version and a downgrade; restore a snapshot of 0.2.98, which brings
# its launcher and Compose files back; install 0.2.99 twice, on one digest.
#
# Usage:  ./docker/test-release.sh
# Needs:  docker, curl, git. Builds the API three times and the other images once (the first on a cold cache takes
#         minutes).

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

ADMIN_EMAIL=alice@example.org
PASSWORD="probe-$$"
PREVIOUS=0.2.98
NEW=0.2.99
BREAKING=0.2.100
SETUP_FLAGS=(--yes --mail-domain example.org --no-mail --no-relay --no-proxy --contact-email admin@example.org)

scratch_init release
# Release installs pull their images; the private build tags of a source install do not apply.
unset EIGEN_API_IMAGE EIGEN_FRONTEND_IMAGE EIGEN_POSTFIX_IMAGE EIGEN_DOVECOT_IMAGE

free_port REGISTRY_PORT
REGISTRY="localhost:$REGISTRY_PORT/eigen-is/eigen"
REGISTRY_VOLUME="eigentest-registry-$RUN"

# Every local image under $REGISTRY, by repository:tag or by ID.
registry_images() {
    docker image ls --format "{{.Repository}}:{{.Tag}} {{.ID}}" | awk -v repo="$REGISTRY/" 'index($1, repo) == 1'
}

# remove_registry_images: every local image under $REGISTRY, by ID, since a dangling one has no tag to name it by.
remove_registry_images() {
    local images
    images=$(registry_images | awk '{ print $2 }' | sort -u)
    if [ -n "$images" ]; then docker image rm -f $images >/dev/null 2>&1 || true; fi
}

# What this run pushed and pulled, the registry and its volume; harness_cleanup does the rest. The installs go first:
# an image in use stays.
release_cleanup() {
    local project
    if [ "${HARNESS_KEEP:-0}" = 1 ]; then return; fi
    for project in $HARNESS_PROJECTS; do down_project "$project"; done
    remove_registry_images
    docker rm -f "eigentest-registry-$RUN" >/dev/null 2>&1 || true
    docker volume rm "$REGISTRY_VOLUME" >/dev/null 2>&1 || true
}
trap 'code=$?; release_cleanup; (exit $code); harness_cleanup' EXIT

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

# release_install <folder name> <version>: $INSTALL, bootstrapped by root from the no-Bun container, with the
# harness's ports. The folder name is the Compose project, so it holds no dot.
release_install() {
    register_install "$1" 0:0
    scratch_run mkdir "$INSTALL"
    assert_isolated
    in_cli_container docker run --rm -v "$INSTALL:/out" "$REGISTRY/api:$2" bootstrap >"$SCRATCH/bootstrap-$1.log" 2>&1
    write_override
    BASE="https://localhost:$PORT_HTTPS/eigen"
}

# tags_are <tag…>: whether the api image has these tags here and no others.
tags_are() {
    [ "$(docker image ls "$REGISTRY/api" --format '{{.Tag}}' | grep -v '<none>' | sort | tr '\n' ' ')" = \
        "$(printf '%s\n' "$@" | sort | tr '\n' ' ')" ]
}

seed() {
    local drive="/drive/$ADMIN_ID/default"
    ROOT_ID=$(api GET "$drive/root" | first_id)
    api POST "$drive/folder/$ROOT_ID/create/doc" '{"fileName":"Release doc"}' >/dev/null
    api POST "$drive/folder/$ROOT_ID/create/sheets" '{"fileName":"Release sheet"}' >/dev/null
    CAL_ID=$(api GET "/calendar/$ADMIN_ID/calendars" |
        grep -o '"id":"[^"]*","name":"[^"]*","color":"[^"]*","isDefault":true' | cut -d'"' -f4 || true)
    EVENT_ID=$(api POST "/calendar/$ADMIN_ID/calendars/$CAL_ID/events" \
        '{"title":"Release event","startTime":"2026-10-01T10:00:00Z","endTime":"2026-10-01T11:00:00Z","allDay":false}' |
        first_id)
    CONTACT_ID=$(api POST "/contacts/$ADMIN_ID/contacts" \
        '{"firstName":"Release","lastName":"Contact","email":["release@example.com"],"phone":[]}' | tr -d '"')
    CHAT_ID=$(api POST "$drive/folder/$ROOT_ID/create/chat" '{"fileName":"Release chat"}' | first_id)
    api POST "/chat/$ADMIN_ID/default/$CHAT_ID/messages" '{"content":"survives the update"}' >/dev/null
}

# missing_items: what of the seed is gone, empty when all of it is there. Signs in first: a rollback brings back
# the session store of its snapshot.
missing_items() {
    local listing missing=''
    sign_in "$PASSWORD" "$JAR" >/dev/null
    listing=$(api GET "/drive/$ADMIN_ID/default/folder/$ROOT_ID")
    for name in 'Release doc.eigendoc' 'Release sheet.eigensheets' 'Release chat.eigenchat'; do
        printf '%s' "$listing" | grep -q "\"$name\"" || missing="$missing '$name'"
    done
    api GET "/calendar/$ADMIN_ID/calendars/$CAL_ID/events/$EVENT_ID" | grep -q '"Release event"' || missing="$missing event"
    api GET "/contacts/$ADMIN_ID/contacts/$CONTACT_ID" | grep -q '"release@example.com"' || missing="$missing contact"
    api GET "/chat/$ADMIN_ID/default/$CHAT_ID/messages" | grep -q '"survives the update"' || missing="$missing message"
    printf '%s' "$missing"
}

# check_running <version>: healthy, status names the version, it is pinned by digest, every seeded item is there.
check_running() {
    local missing
    if stack_up; then ok "every service runs and eigen-api is healthy"; else fail "the stack is not up"; fi
    eigen status
    if says "Version  *$1"; then ok "status shows $1"; else fail "status shows another version"; show; fi
    if [ "$(env_of EIGEN_VERSION)" = "$1" ] && env_of EIGEN_API_IMAGE | grep -q "^$REGISTRY/api@sha256:"; then
        ok ".env.production pins $1 by digest"
    else
        fail ".env.production pins $(env_of EIGEN_VERSION) as $(env_of EIGEN_API_IMAGE)"
    fi
    missing=$(missing_items)
    if [ -z "$missing" ]; then
        ok "the document, sheet, event, contact and chat message are all there"
    else
        fail "missing:$missing"
    fi
}

# Every line of the env file but the pins.
unpinned() { scratch_run cat "$INSTALL/.env.production" | grep -v '^EIGEN_\(VERSION\|[A-Z]*_IMAGE\)='; }

api_tags() { docker image ls "$REGISTRY/api" --format '{{.Tag}}' | tr '\n' ' '; }

header "Releases $PREVIOUS, $NEW and $BREAKING in a registry on port $REGISTRY_PORT"
started=$SECONDS
docker volume create --label eigen.harness=1 "$REGISTRY_VOLUME" >/dev/null
docker run -d --name "eigentest-registry-$RUN" --label eigen.harness=1 --label "eigen.harness.run=$RUN" \
    -p "127.0.0.1:$REGISTRY_PORT:5000" -v "$REGISTRY_VOLUME:/var/lib/registry" registry:2 >/dev/null
release_source "$PREVIOUS" ''
release_source "$NEW" "$NEW_SECTION"
release_source "$BREAKING" "$BREAKING_SECTION
$NEW_SECTION"
build() { docker build -q --label eigen.harness=1 --build-arg BUN_VERSION "$@" >/dev/null; }
for version in "$PREVIOUS" "$NEW" "$BREAKING"; do
    build -f "$SCRATCH/src-$version/docker/api/Dockerfile" --build-arg "EIGEN_VERSION=$version" \
        --build-arg EIGEN_COMMIT=harness --build-arg "EIGEN_REGISTRY=$REGISTRY" -t "$REGISTRY/api:$version" \
        "$SCRATCH/src-$version"
done
build -f "$SCRATCH/src-$PREVIOUS/docker/frontend/Dockerfile" -t "$REGISTRY/frontend:$PREVIOUS" "$SCRATCH/src-$PREVIOUS"
build -t "$REGISTRY/postfix:$PREVIOUS" "$SCRATCH/src-$PREVIOUS/docker/postfix"
build -t "$REGISTRY/dovecot:$PREVIOUS" "$SCRATCH/src-$PREVIOUS/docker/dovecot"
for name in frontend postfix dovecot; do
    docker tag "$REGISTRY/$name:$PREVIOUS" "$REGISTRY/$name:$NEW"
    docker tag "$REGISTRY/$name:$PREVIOUS" "$REGISTRY/$name:$BREAKING"
done
for name in api frontend postfix dovecot; do
    docker tag "$REGISTRY/$name:$NEW" "$REGISTRY/$name:latest"
    for tag in "$PREVIOUS" "$NEW" "$BREAKING" latest; do docker push -q "$REGISTRY/$name:$tag" >/dev/null; done
done
# The installs must pull what they run.
remove_registry_images
ok "built and pushed the three releases in $((SECONDS - started))s"

##############################################################################
header "Installing $PREVIOUS"
##############################################################################
release_install "eigentest-release-$$" "$PREVIOUS"
JAR="$SCRATCH/session"
run_setup "$SCRATCH/setup.log" "${SETUP_FLAGS[@]}" --domain localhost
if ! create_admin "$SCRATCH/setup.log" "$PASSWORD"; then
    fail "the setup link of $PREVIOUS made no admin"
    header "Result"
    probe_summary
fi
seed
check_running "$PREVIOUS"
UNPINNED=$(unpinned)

##############################################################################
header "./eigen update to :latest"
##############################################################################
started=$SECONDS
eigen update
show
if [ "$CODE" = 0 ] && says "◆  Eigen $NEW" && says "The harness's new release" &&
    says "◇  Eigen $PREVIOUS → $NEW is running at https://localhost/"; then
    ok "./eigen update went from $PREVIOUS to $NEW in $((SECONDS - started))s, with its notes"
else
    fail "./eigen update exited $CODE"
fi
check_running "$NEW"
after=$(unpinned)
if [ "${after:0:${#UNPINNED}}" = "$UNPINNED" ]; then
    ok "every line of .env.production but the pins is kept"
else
    fail ".env.production changed: $(diff <(printf '%s\n' "$UNPINNED") <(printf '%s\n' "$after") | tr '\n' ' ')"
fi
archive=$(pre_updates)
archive=${archive% }
pointer=$(scratch_run cat "$INSTALL/.eigen/last-update" | tr '\n' ' ')
meta=$(scratch_run tar -xzOf "$INSTALL/snapshots/$archive" eigen-snapshot.json || true)
if [ "$pointer" = "$archive $PREVIOUS harness " ] && [[ $meta == *"\"version\":\"$PREVIOUS\""* ]]; then
    ok ".eigen/last-update names snapshots/$archive, a snapshot of $PREVIOUS"
else
    fail ".eigen/last-update '$pointer', snapshot $meta"
fi
if tags_are "$PREVIOUS" "$NEW"; then
    ok "only $PREVIOUS (for a rollback) and $NEW are kept"
else
    fail "api tags kept: $(api_tags)"
fi
if grep -qx "image prune -f --filter label=org.opencontainers.image.source=https://github.com/eigen-is/eigen" "$PRUNE_LOG"; then
    ok "it prunes Eigen's dangling images"
else
    fail "the prunes: $(cat "$PRUNE_LOG")"
fi

started=$(api_started)
eigen update
if [ "$CODE" = 0 ] && says "Eigen $NEW is up to date and running at https://localhost/" &&
    [ "$(api_started)" = "$started" ]; then
    ok "a rerun says $NEW is up to date and running, and restarts nothing"
else
    fail "the rerun: exit $CODE"
    show
fi
eigen update --check
if [ "$CODE" = 0 ] && says "Eigen $NEW is up to date." && [ "$(api_started)" = "$started" ]; then
    ok "--check says it is up to date"
else
    fail "update --check: exit $CODE"
    show
fi

##############################################################################
header "./eigen rollback"
##############################################################################
eigen_piped n rollback
if [ "$CODE" = 0 ] && says "a snapshot of Eigen $PREVIOUS, made on " && says 'kept aside as data.pre-restore-\*' &&
    says 'Nothing was changed.' && [ "$(api_started)" = "$started" ]; then
    ok "rollback asks with the version, the date and the age, and a no stops nothing"
else
    fail "rollback answered no: exit $CODE"
    show
fi
started=$SECONDS
eigen rollback --yes
show
if [ "$CODE" = 0 ] && says "◇  Eigen $NEW → $PREVIOUS is running at https://localhost/"; then
    ok "./eigen rollback --yes went back to $PREVIOUS in $((SECONDS - started))s"
else
    fail "./eigen rollback exited $CODE"
fi
check_running "$PREVIOUS"
if [ ! -e "$INSTALL/.eigen/last-update" ] && ls -d "$INSTALL"/data.pre-restore-* >/dev/null 2>&1; then
    ok "the pointer is gone and the data of $NEW is kept aside"
else
    fail "after the rollback: .eigen/last-update is left, or no data.pre-restore-*"
fi
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
    [ "$(scratch_run cat "$INSTALL/.env.production")" = "$env_before" ] && [ "$(pre_updates)" = "$archive " ]; then
    ok "the refusal stopped nothing and changed nothing"
else
    fail "the refused update changed something"
fi
started=$SECONDS
eigen update "$BREAKING" --accept-breaking
show
if [ "$CODE" = 0 ] && says "◇  Eigen $PREVIOUS → $BREAKING is running at https://localhost/"; then
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
header "./eigen restore of a snapshot of $PREVIOUS"
##############################################################################
inode=$(scratch_run stat -c %i "$INSTALL/eigen")
eigen restore "$(scratch_run sed -n 1p "$INSTALL/.eigen/last-update")" --yes
show
if [ "$CODE" = 0 ] && says "◇  Eigen $PREVIOUS files written" && [ "$(scratch_run stat -c %i "$INSTALL/eigen")" != "$inode" ]; then
    ok "a restore of a snapshot of $PREVIOUS on $BREAKING writes the launcher and Compose files of $PREVIOUS"
else
    fail "the restore of a snapshot of $PREVIOUS: exit $CODE"
fi
check_running "$PREVIOUS"
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
