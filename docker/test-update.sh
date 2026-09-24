#!/usr/bin/env bash
# Updates and rolls back a source install with ./eigen in a docker:cli container that has no Bun. The install clones a
# scratch remote whose main is this branch plus the working tree, reset to the first commit whose snapshot writes
# .eigen/last-update (or $UPDATE_FROM), and is set up edge-only as root with an admin and a folder. Then: update --check,
# the refusals before anything stops, the update, a rerun, a commit that breaks the build and its fix, and the rollback.
#
# Usage:  ./docker/test-update.sh
# Needs:  docker, curl, git. Builds the images five times in Docker (the first on a cold cache takes minutes).

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

ADMIN_EMAIL=alice@example.org
PASSWORD="probe-$$"
BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)
FROM=${UPDATE_FROM:-$(git -C "$REPO_ROOT" log --reverse --format=%H -S'last-update' -- apps/api/src/cli/snapshot.ts |
    head -n 1)}
if [ -z "$FROM" ]; then
    echo "harness: no commit of $BRANCH writes .eigen/last-update yet; commit it, or set UPDATE_FROM" >&2
    exit 1
fi

scratch_init update
REMOTE="$SCRATCH/remote.git"
WORK="$SCRATCH/work"

# push_change <message> <shell command run in the work tree>: one more commit on the remote's main.
push_change() {
    scratch_run sh -c 'cd "$1" && eval "$2"' sh "$WORK" "$2"
    git_run -C "$WORK" commit -qam "$1"
    git_run -C "$WORK" push -q "$REMOTE" HEAD:refs/heads/main
}

head_of() { git_run -C "$1" rev-parse --short HEAD; }

kept() { api GET "/drive/$ADMIN_ID/default/folder/$ROOT_ID" | grep -q '"Kept by the update"'; }

header "A remote whose main is $BRANCH plus the working tree, and an install at ${FROM:0:9}"
git_run clone -q --single-branch --branch "$BRANCH" --no-tags file:///repo "$WORK"
scratch_run sh -c 'find "$1" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +' sh "$WORK"
working_tree | docker run --rm -i -v "$SCRATCH:$SCRATCH" -w "$WORK" --entrypoint tar "$CLI_IMAGE" -xf -
git_run -C "$WORK" add -A
git_run -C "$WORK" commit -q --allow-empty -m "harness: the working tree"
git_run init -q --bare "$REMOTE"
git_run -C "$WORK" push -q "$REMOTE" HEAD:refs/heads/main
git_run -C "$REMOTE" symbolic-ref HEAD refs/heads/main

register_install "eigentest-update-$$" 0:0
git_run clone -q "$REMOTE" "$INSTALL"
git_run -C "$INSTALL" reset -q --hard "$FROM"
assert_isolated
write_override
BASE="https://localhost:$PORT_HTTPS/eigen"
JAR="$SCRATCH/session"
OLD=$(head_of "$INSTALL")
behind=$(git_run -C "$INSTALL" rev-list --count HEAD..origin/main)
log "install at $OLD, $behind commits behind origin/main"

run_setup "$SCRATCH/setup.log" --yes --domain localhost --mail-domain example.org --no-mail --no-relay --no-proxy \
    --contact-email admin@example.org
if create_admin "$SCRATCH/setup.log" "$PASSWORD"; then
    ROOT_ID=$(api GET "/drive/$ADMIN_ID/default/root" | first_id)
    api POST "/drive/$ADMIN_ID/default/folder/$ROOT_ID" '{"folderName":"Kept by the update"}' >/dev/null
fi
if kept; then ok "the admin made a folder over HTTPS"; else fail "could not make a folder to keep"; fi
ENV_BEFORE=$(scratch_run cat "$INSTALL/.env.production")

##############################################################################
header "./eigen update --check"
##############################################################################
started=$(api_started)
eigen update --check
show
if [ "$CODE" = 0 ] && says "$behind new commit" && says './eigen update installs them.' &&
    [ "$(head_of "$INSTALL")" = "$OLD" ] && [ "$(api_started)" = "$started" ]; then
    ok "--check names $behind new commits and changes nothing"
else
    fail "update --check: exit $CODE"
fi

##############################################################################
header "Refusals before anything stops"
##############################################################################
# Docker Desktop's file share shows files as owned by whoever looks, so there the refusal cannot be seen. Probed on a
# folder of its own: a look from another uid at the install changes whom the share shows as its owner.
scratch_run mkdir "$SCRATCH/owned"
if docker run --rm --user 1001:1001 -v "$SCRATCH:$SCRATCH" --entrypoint sh "$CLI_IMAGE" -c '[ -O "$1" ]' sh \
    "$SCRATCH/owned"; then
    skip "a checkout owned by another user: this file share reports every file as the viewer's"
else
    scratch_run chmod 644 "$INSTALL/.env.production"
    CODE=0
    OUT=$(in_cli_container --user 1001:1001 ./eigen update 2>&1) || CODE=$?
    scratch_run chmod 600 "$INSTALL/.env.production"
    if [ "$CODE" = 1 ] && says '■  This checkout belongs to another user.' && says "└  Run ./eigen update as the owner of"; then
        ok "another user than the owner of .git is refused"
    else
        fail "update as uid 1001: exit $CODE"
        show
    fi
fi

push_change "harness: a README line" 'echo "One more line from the remote." >>README.md'
scratch_run sh -c 'echo "A local edit." >>"$1/README.md"' sh "$INSTALL"
eigen update
show
if [ "$CODE" = 1 ] && says '■  Local changes are in the way of the update: README.md' &&
    says 'git stash, or drop them with git checkout -- <file>' && [ "$(head_of "$INSTALL")" = "$OLD" ] &&
    [ "$(api_started)" = "$started" ]; then
    ok "local changes in the way are refused with the git commands that clear them, and nothing stops"
else
    fail "update with local changes: exit $CODE"
fi
git_run -C "$INSTALL" checkout -q -- README.md

##############################################################################
header "./eigen update"
##############################################################################
scratch_run mkdir "$INSTALL/dist"
started=$SECONDS
eigen update
show
NEW=$(head_of "$INSTALL")
if [ "$CODE" = 0 ] && says "Pulled $((behind + 1)) new commits from origin/main" &&
    says "◇  Eigen $VERSION ($OLD) → $VERSION ($NEW) is running at https://localhost/"; then
    ok "./eigen update went from $OLD to $NEW in $((SECONDS - started))s"
else
    fail "./eigen update exited $CODE"
fi
if [ "$NEW" = "$(head_of "$REMOTE")" ]; then ok "the checkout is at the remote's main"; else fail "the checkout is at $NEW"; fi
if stack_up; then ok "every service runs and eigen-api is healthy"; else fail "the stack is not up after the update"; fi
revision=$(api_revision)
if [ "$revision" = "$NEW" ]; then ok "eigen-api runs an image built at $NEW"; else fail "eigen-api runs $revision"; fi
if kept; then ok "the folder made before the update is there"; else fail "the folder is gone after the update"; fi
env_after=$(scratch_run cat "$INSTALL/.env.production")
if [ "${env_after:0:${#ENV_BEFORE}}" = "$ENV_BEFORE" ]; then
    ok "every line of .env.production is kept"
else
    fail ".env.production changed: $(diff <(printf '%s\n' "$ENV_BEFORE") <(printf '%s\n' "$env_after") | tr '\n' ' ')"
fi
archive=$(pre_updates)
archive=${archive% }
pointer=$(scratch_run cat "$INSTALL/.eigen/last-update" | tr '\n' ' ')
if [ -n "$archive" ] && [ "$pointer" = "$archive $VERSION $OLD " ] && says "snapshots/$archive"; then
    ok ".eigen/last-update names snapshots/$archive, $VERSION and $OLD"
else
    fail "pre-update snapshots '$archive', .eigen/last-update '$pointer'"
fi
meta=$(scratch_run tar -xzOf "$INSTALL/snapshots/$archive" eigen-snapshot.json || true)
case $meta in *"\"version\":\"$VERSION\""*) ok "the snapshot records $VERSION" ;; *) fail "the snapshot records: $meta" ;; esac
prunes=$(cat "$PRUNE_LOG")
if printf '%s\n' "$prunes" | grep -qx "image prune -f --filter label=org.opencontainers.image.source=https://github.com/eigen-is/eigen --filter label=com.docker.compose.project=$PROJECT" &&
    printf '%s\n' "$prunes" | grep -qx 'builder prune -f --filter until=168h'; then
    ok "it prunes this project's dangling images and week-old build cache"
else
    fail "the prunes: $prunes"
fi
if says 'unless you develop here, delete: dist/'; then ok "it names dist/ as a leftover"; else fail "no leftover note for dist/"; fi
eigen status
if says "Version  *$VERSION ($NEW)"; then ok "status shows $VERSION ($NEW)"; else fail "status shows another version"; show; fi

##############################################################################
header "Rerun and --check when up to date"
##############################################################################
started=$(api_started)
eigen update
show
if [ "$CODE" = 0 ] && says "Eigen $VERSION ($NEW) is up to date and running at https://localhost/" &&
    [ "$(api_started)" = "$started" ] && [ "$(pre_updates)" = "$archive " ]; then
    ok "a rerun says Eigen is up to date and running, and restarts nothing"
else
    fail "the rerun: exit $CODE"
fi
eigen update --check
if [ "$CODE" = 0 ] && says 'Eigen is up to date with origin/main.'; then
    ok "--check says Eigen is up to date"
else
    fail "update --check when up to date: exit $CODE"
    show
fi

##############################################################################
header "A commit that breaks the build"
##############################################################################
push_change "harness: break the API build" 'echo "RUN false" >>docker/api/Dockerfile'
started=$(api_started)
eigen update
show
if [ "$CODE" = 1 ] && says '■  Could not build Eigen' && says 'Eigen runs on as it was' &&
    [ "$(api_started)" = "$started" ] && stack_up && kept && [ "$(pre_updates)" = "$archive " ]; then
    ok "a failed build stops nothing, saves no snapshot, and Eigen runs on"
else
    fail "the failed build: exit $CODE"
fi
push_change "harness: fix the API build" 'sed -i "\$d" docker/api/Dockerfile'
eigen update
show
FIXED=$(head_of "$INSTALL")
if [ "$CODE" = 0 ] && says "→ $VERSION ($FIXED) is running" && stack_up && kept; then
    ok "the next update after the fix converges on $FIXED"
else
    fail "the update after the fix: exit $CODE"
fi
count=$(pre_updates | wc -w | tr -d ' ')
if [ "$count" = 2 ]; then ok "two pre-update snapshots are kept"; else fail "$count pre-update snapshots: $(pre_updates)"; fi

##############################################################################
header "./eigen rollback"
##############################################################################
api POST "/drive/$ADMIN_ID/default/folder/$ROOT_ID" '{"folderName":"Made after the update"}' >/dev/null
scratch_run sh -c 'echo "A local edit." >>"$1/README.md"' sh "$INSTALL"
started=$(api_started)
eigen rollback --yes
if [ "$CODE" = 1 ] && says '■  Local changes are in the way of the rollback: README.md' &&
    [ "$(head_of "$INSTALL")" = "$FIXED" ] && [ "$(api_started)" = "$started" ]; then
    ok "local changes are refused before anything stops"
else
    fail "rollback with local changes: exit $CODE"
    show
fi
git_run -C "$INSTALL" checkout -q -- README.md
started=$SECONDS
eigen rollback --yes
show
if [ "$CODE" = 0 ] && says "◇  Eigen $VERSION ($FIXED) → $VERSION ($NEW) is running at https://localhost/"; then
    ok "./eigen rollback went back from $FIXED to $NEW in $((SECONDS - started))s"
else
    fail "./eigen rollback exited $CODE"
fi
revision=$(api_revision)
if [ "$(head_of "$INSTALL")" = "$NEW" ] && [ "$revision" = "$NEW" ] && stack_up; then
    ok "the checkout is at $NEW, and eigen-api runs an image built there"
else
    fail "after the rollback the checkout is at $(head_of "$INSTALL") and eigen-api runs $revision"
fi
if kept && ! api GET "/drive/$ADMIN_ID/default/folder/$ROOT_ID" | grep -q '"Made after the update"' &&
    ! scratch_run test -e "$INSTALL/.eigen/last-update"; then
    ok "the data is as it was before the update, and .eigen/last-update is gone"
else
    fail "the data or .eigen/last-update after the rollback"
fi

header "Result"
probe_summary
