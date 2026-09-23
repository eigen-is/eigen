#!/usr/bin/env bash
# Install Eigen the way a stranger does: ./eigen setup, flag-driven, from a docker:cli container that has no
# Bun, into a scratch copy of this working tree (source mode). Once as root into a folder whose name has
# capitals and a space (so the Compose project is not `eigen`), once as uid 1001. Asserts the stack is
# healthy, the frontend answers on the harness port, setup is still pending, a rerun keeps the env file, who
# owns the env file and data/, and that no container sees the Docker socket.
#
# The copy is `git ls-files -co --exclude-standard` into the scratch folder, committed to a fresh repo: unlike
# `git stash create` or a clone plus the diff, it also carries untracked files, and it never copies ignored
# ones (node_modules, .env.production) or anything under data/, backups/ and caddy-data/.
#
# Usage:  ./docker/test-install.sh
# Needs:  docker, curl, git. Builds every image in Docker (a few minutes on a cold cache).

set -euo pipefail

# Counters, log/probe helpers, the scratch installs and the Result summary.
. "$(dirname "$0")/probe-lib.sh"

SETUP_FLAGS=(--domain localhost --no-mail --no-relay --no-proxy --contact-email admin@example.org)

# The env file is the operator's, mode 0600: read it as root in a container, which works on Linux too.
scratch_cat() {
    docker run --rm -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" cat "$1"
}

# check_install <operator uid:gid>
check_install() {
    local operator="$1" base="https://localhost:$PORT_HTTPS" status mounts
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

    # On Docker Desktop the host sees every file as the host user and ignores modes for access, so owners
    # and modes are asserted as a container sees them; on Linux that is also the host's view.
    local env_stat data_stat backups_stat
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

# Release mode: bootstrap from a local registry, then ./eigen setup. U9 adds the registry helper and fills this.
test_release_install() {
    skip "release-mode install (needs the local registry helper)"
}

scratch_init install

##############################################################################
header "Source install as root, into 'Eigentest Install $$'"
##############################################################################
new_install "Eigentest Install $$" 0:0
write_override
started=$SECONDS
if run_setup "${SETUP_FLAGS[@]}"; then
    ok "./eigen setup as root finished in $((SECONDS - started))s"
else
    fail "./eigen setup as root failed after $((SECONDS - started))s"
fi
check_install 0:0

header "Rerun: ./eigen setup --yes keeps the env file"
before=$(scratch_cat "$INSTALL/.env.production")
started=$SECONDS
if run_setup --yes; then
    ok "rerun finished in $((SECONDS - started))s"
else
    fail "rerun failed after $((SECONDS - started))s"
fi
after=$(scratch_cat "$INSTALL/.env.production")
if [ "${after:0:${#before}}" = "$before" ]; then
    added=$(printf '%s' "${after:${#before}}" | sed -n 's/^\([A-Z_]*\)=.*/\1/p' | tr '\n' ' ')
    ok "every line of .env.production kept${added:+, backfilled: $added}"
else
    fail ".env.production changed on rerun: $(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | tr '\n' ' ')"
fi
check_install 0:0
down_project "$PROJECT"

##############################################################################
header "Source install as uid 1001"
##############################################################################
new_install "eigentest-uid1001-$$" 1001:1001
write_override
started=$SECONDS
if run_setup --user 1001:1001 "${SETUP_FLAGS[@]}"; then
    ok "./eigen setup as 1001 finished in $((SECONDS - started))s"
else
    fail "./eigen setup as 1001 failed after $((SECONDS - started))s"
fi
check_install 1001:1001
down_project "$PROJECT"

##############################################################################
header "Release install"
##############################################################################
test_release_install

##############################################################################
header "Result"
##############################################################################
probe_summary
