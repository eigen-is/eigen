#!/usr/bin/env bash
# The launcher alone, without a stack: under dash (debian:bookworm-slim), BusyBox sh and this host's /bin/sh, with a
# stub docker on PATH that answers info and compose version and fails on demand. Covers every command's help, unknown
# commands and arguments, the preflight refusals, source and release mode, need_install, a failing compose config, stop,
# what update asks the CLI, and what status passes it about the snapshots and the files of an unfinished update.
#
# Usage:  ./docker/test-launcher.sh
# Needs:  docker (pulls debian:bookworm-slim and busybox once).

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

FIX=$(mktemp -d "${TMPDIR:-/tmp}/eigentest-launcher.XXXXXX")
FIX=$(cd "$FIX" && pwd -P)
trap 'rm -rf "$FIX"' EXIT

# The stub logs every call to $STUB_LOG. STUB_INFO and STUB_COMPOSE answer info and compose version, empty for a
# failure; STUB_FAIL names the compose subcommands and docker commands that fail; STUB_IMAGE=1 makes image inspect fail;
# STUB_LATEST is the version the registry's manifest of api:latest names; a docker run with STUB_RUN_FAIL among its
# arguments fails.
mkdir "$FIX/bin"
cat >"$FIX/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$STUB_LOG"
fails() { case " ${STUB_FAIL:-} " in *" $1 "*) echo "stub: $1 fails" >&2; exit 1 ;; esac; }
case $1 in
    info)
        info=${STUB_INFO-27.3.1 x86_64}
        if [ -z "$info" ]; then exit 1; fi
        echo "$info"
        ;;
    compose)
        shift
        while :; do
            case $1 in --env-file | -f) shift 2 ;; *) break ;; esac
        done
        fails "compose-$1"
        case $1 in
            version) if [ -n "${STUB_COMPOSE-2.29.1}" ]; then echo "${STUB_COMPOSE-2.29.1}"; else exit 1; fi ;;
            config) if [ "${2:-}" = --services ]; then printf 'eigen-api\ncaddy\n'; else echo 'name: stub'; fi ;;
        esac
        ;;
    image) exit "${STUB_IMAGE:-0}" ;;
    manifest) echo "\"org.opencontainers.image.version\": \"${STUB_LATEST:-}\"" ;;
    run)
        shift
        echo "stub run: $*"
        case " $* " in *" ${STUB_RUN_FAIL:-none} "*) exit 1 ;; esac
        ;;
    *) fails "$1" ;;
esac
EOF
chmod 755 "$FIX/bin/docker"

# A source checkout and a release folder, each with the launcher and a set-up .env.production; bare/ has no install.
for dir in source release bare; do
    mkdir "$FIX/$dir"
    cp "$REPO_ROOT/eigen" "$FIX/$dir/eigen"
done
mkdir "$FIX/source/.git"
: >"$FIX/source/docker-compose.build.yml"
cp "$REPO_ROOT/.bun-version" "$REPO_ROOT/package.json" "$FIX/source/"
for dir in source release; do printf 'DOMAIN=eigen.example.com\nEIGEN_VERSION=0.2.99\n' >"$FIX/$dir/.env.production"; done

docker pull -q debian:bookworm-slim >/dev/null
docker pull -q busybox >/dev/null
PATH_IN=/stub:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# launch <folder> <args…>: the launcher under $SHELL_NAME in $FIX/<folder>; sets CODE, OUT (stdout), ERR (stderr) and
# CALLS (what docker was asked). STUB_* pass through as set here.
launch() {
    local dir="$FIX/$1" vars=("STUB_LOG=$FIX/calls.log") flags=() name var
    shift
    : >"$FIX/calls.log"
    for name in STUB_INFO STUB_COMPOSE STUB_FAIL STUB_IMAGE STUB_LATEST STUB_RUN_FAIL; do
        if [ -n "${!name+set}" ]; then vars+=("$name=${!name}"); fi
    done
    CODE=0
    if [ "$SHELL_NAME" = host ]; then
        OUT=$(cd "$dir" && env "${vars[@]}" PATH="$FIX/bin:$PATH" /bin/sh ./eigen "$@" 2>"$FIX/stderr") || CODE=$?
    else
        for var in "${vars[@]}"; do flags+=(-e "$var"); done
        # As this user, or on a Linux host root's .eigen would refuse this script's own lock below.
        OUT=$(docker run --rm --user "$(id -u):$(id -g)" -v "$FIX:$FIX" -v "$FIX/bin:/stub:ro" -w "$dir" \
            -e PATH="$PATH_IN" "${flags[@]}" "$IMAGE" "$SHELL_CMD" ./eigen "$@" 2>"$FIX/stderr") || CODE=$?
    fi
    ERR=$(cat "$FIX/stderr")
    CALLS=$(cat "$FIX/calls.log")
}

# expect_error <code> <stderr fragment> <what>: the last launch exited <code> with this on stderr; a refusal (2) prints
# nothing on stdout.
expect_error() {
    if [ "$CODE" = "$1" ] && { [ "$1" != 2 ] || [ -z "$OUT" ]; } && printf '%s\n' "$ERR" | grep -q -- "$2"; then
        ok "$SHELL_NAME: $3 (exit $1)"
    else
        fail "$SHELL_NAME: $3: exit $CODE, stdout '$OUT', stderr '$ERR'"
    fi
}

for SHELL_NAME in dash busybox host; do
    case $SHELL_NAME in
        dash) IMAGE=debian:bookworm-slim SHELL_CMD=dash ;;
        busybox) IMAGE=busybox SHELL_CMD=sh ;;
        host) IMAGE='' SHELL_CMD=/bin/sh ;;
    esac
    header "$SHELL_NAME"

    launch bare help
    if [ "$CODE" = 0 ] && [ -z "$ERR" ] && [ "$(printf '%s\n' "$OUT" | head -n 1)" = 'Usage: ./eigen <command>' ] &&
        [ -z "$CALLS" ]; then
        ok "$SHELL_NAME: help prints the usage without asking Docker"
    else
        fail "$SHELL_NAME: help: exit $CODE, calls '$CALLS'"
    fi
    failed=''
    for command in status backup logs update rollback restart stop; do
        launch bare "$command" --help
        case "$CODE $(printf '%s\n' "$OUT" | head -n 1)" in
            "0 Usage: ./eigen $command"*) ;;
            *) failed="$failed $command" ;;
        esac
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: status, backup, logs, update, rollback, restart and stop --help print their usage"
    else
        fail "$SHELL_NAME: no usage from --help of:$failed"
    fi
    failed=''
    for command in setup restore reset-password; do
        launch source "$command" --help
        cli=$command
        if [ "$command" = setup ]; then cli=configure; fi
        case $OUT in "stub run: "*" $cli --help") ;; *) failed="$failed $command" ;; esac
    done
    if [ -z "$failed" ] && [ "$CODE" = 0 ]; then
        ok "$SHELL_NAME: setup, restore and reset-password --help ask the CLI for its usage"
    else
        fail "$SHELL_NAME: --help did not reach the CLI for:$failed"
    fi

    launch bare frobnicate
    expect_error 2 'Unknown command "frobnicate"' "an unknown command is refused with the usage on stderr"
    failed=''
    for args in 'status extra' 'backup extra' 'backup --keep 2 extra' 'restart extra' 'stop extra' 'logs a b' \
        'update --bogus' 'update 1 2' 'rollback --nope'; do
        # shellcheck disable=SC2086
        launch source $args
        if [ "$CODE" != 2 ] || [ -n "$OUT" ] || ! printf '%s\n' "$ERR" | grep -q "^Unknown argument \"${args##* }\"\.$" ||
            ! printf '%s\n' "$ERR" | grep -q '^Usage: ./eigen'; then
            failed="$failed '$args' ($CODE)"
        fi
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: an argument a command does not take is refused with its usage on stderr (exit 2)"
    else
        fail "$SHELL_NAME: not refused:$failed"
    fi

    failed=''
    for command in status backup restart stop update rollback logs reset-password; do
        launch bare "$command"
        if [ "$CODE" != 1 ] || ! printf '%s\n' "$ERR" | grep -q '■  Eigen is not set up in' ||
            ! printf '%s\n' "$ERR" | grep -q '└  Run ./eigen setup first.' || [ -n "$CALLS" ]; then
            failed="$failed $command"
        fi
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: every command but setup says to run ./eigen setup first, without asking Docker"
    else
        fail "$SHELL_NAME: need_install missing for:$failed"
    fi

    STUB_INFO='' launch source restart
    expect_error 1 '■  Docker is not running, or this user cannot use it.' "no Docker"
    STUB_COMPOSE='' launch source restart
    expect_error 1 '■  Docker Compose is not installed.' "no Compose"
    STUB_COMPOSE=2.19.3 launch source restart
    expect_error 1 '■  Docker Compose 2.19.3 is too old for this install; it needs 2.20 or newer.' "Compose 2.19.3"
    printf 'services:\n  caddy:\n    ports: !override []\n' >"$FIX/source/docker-compose.override.yml"
    STUB_COMPOSE=2.24.3-desktop.1 launch source restart
    rm "$FIX/source/docker-compose.override.yml"
    expect_error 1 'it needs 2.24.4 or newer' "an override with !override and Compose 2.24.3"
    STUB_INFO='27.3.1 aarch64' launch source restart
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q '◇  Docker 27.3.1 on aarch64, Compose 2.29.1'; then
        ok "$SHELL_NAME: an aarch64 server goes through, its architecture named"
    else
        fail "$SHELL_NAME: aarch64: exit $CODE, '$OUT'"
    fi

    launch source restart
    source_calls=$CALLS
    launch release restart
    if printf '%s\n' "$source_calls" | grep -q '^compose .* -f docker-compose.build.yml .*up -d --wait$' &&
        printf '%s\n' "$CALLS" | grep -q '^compose .*up -d --wait$' && ! printf '%s\n' "$CALLS" | grep -q build.yml; then
        ok "$SHELL_NAME: a checkout runs Compose with the build overlay, a release folder without"
    else
        fail "$SHELL_NAME: mode detection: source '$source_calls', release '$CALLS'"
    fi
    STUB_IMAGE=1 launch source restore --help
    expect_error 1 '■  Eigen is not built yet.' "restore --help in an unbuilt checkout"
    STUB_IMAGE=1 launch release restore --help
    case "$CODE $OUT" in
        "0 stub run: "*" -v $FIX/release:/install -w /install ghcr.io/eigen-is/eigen/api:local restore --help")
            ok "$SHELL_NAME: a release folder runs the CLI without looking for a build" ;;
        *) fail "$SHELL_NAME: restore --help in a release folder: exit $CODE, '$OUT'" ;;
    esac
    sed -i.bak '/^EIGEN_VERSION=/d' "$FIX/release/.env.production"
    launch release setup
    mv "$FIX/release/.env.production.bak" "$FIX/release/.env.production"
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  .env.production names no Eigen release.'; then
        ok "$SHELL_NAME: setup in a release folder without EIGEN_VERSION says to get a release"
    else
        fail "$SHELL_NAME: release setup without a version: exit $CODE, '$ERR'"
    fi

    # The launcher compares versions for equality only; the new version's CLI orders them.
    STUB_LATEST=0.2.99 launch release update --check
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q 'Eigen 0.2.99 is up to date' &&
        ! printf '%s\n' "$CALLS" | grep -q '^run '; then
        ok "$SHELL_NAME: update --check on the newest version says it is up to date without running the CLI"
    else
        fail "$SHELL_NAME: update --check when up to date: exit $CODE, '$OUT'"
    fi
    STUB_LATEST=0.2.98 launch release update --check
    if [ "$CODE" = 0 ] && printf '%s\n' "$CALLS" |
        grep -q '^run .* ghcr.io/eigen-is/eigen/api:0.2.98 update-check --from 0.2.99 --accept-breaking$'; then
        ok "$SHELL_NAME: update --check on another version asks that version's CLI, which orders them"
    else
        fail "$SHELL_NAME: update --check to another version: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    launch source stop
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q '◇  Eigen stopped' &&
        printf '%s\n' "$CALLS" | grep -q '^compose .* stop$' && ! printf '%s\n' "$CALLS" | grep -q ' up '; then
        ok "$SHELL_NAME: stop stops Eigen and starts nothing"
    else
        fail "$SHELL_NAME: stop: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    mkdir -p "$FIX/release/snapshots" "$FIX/release/.eigen"
    head -c 4096 /dev/zero >"$FIX/release/snapshots/eigen-20260101-000000.tar.gz"
    echo 0.2.100 >"$FIX/release/.eigen/bundle"
    STUB_LATEST=0.2.99 launch release status
    rm -r "$FIX/release/snapshots" "$FIX/release/.eigen/bundle"
    # --services spans lines of the call log.
    if printf '%s\n' "$CALLS" | grep -q ' --snapshots=eigen-20260101-000000.tar.gz --snapshots-kb=[1-9][0-9]* ' &&
        printf '%s\n' "$CALLS" | grep -q ' --latest=0.2.99 --files=0.2.100$'; then
        ok "$SHELL_NAME: status passes the snapshots, their size, and the version the files were last written for"
    else
        fail "$SHELL_NAME: status: calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    STUB_FAIL=compose-config launch source restart
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Eigen did not start' &&
        printf '%s\n' "$CALLS" | grep -q ' config --services$' &&
        ! printf '%s\n' "$CALLS" | grep -Eq '^(rm|stop) | (up|stop) '; then
        ok "$SHELL_NAME: a failing compose config removes, stops and starts nothing"
    else
        fail "$SHELL_NAME: failing compose config: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    STUB_RUN_FAIL=--yes launch source restore eigen-20260101-000000.tar.gz
    if [ "$CODE" = 1 ] && printf '%s\n' "$CALLS" | grep -q ' restore eigen-20260101-000000.tar.gz --yes$' &&
        printf '%s\n' "$CALLS" | grep -q ' up -d --wait$' &&
        printf '%s\n' "$CALLS" | tail -n 1 | grep -q ' rm -rf .eigen/restore$' && [ ! -e "$FIX/source/.eigen/lock" ]; then
        ok "$SHELL_NAME: a failed swap starts Eigen again, then removes the checked copy and the lock"
    else
        fail "$SHELL_NAME: a failed swap: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    if [ "$(printf '%s\n' "$CALLS" | grep -c ' config$')" = 1 ]; then
        ok "$SHELL_NAME: one compose config names the project for the stop and the start"
    else
        fail "$SHELL_NAME: the project was asked $(printf '%s\n' "$CALLS" | grep -c ' config$') times"
    fi

    # A source install runs today's Compose files on what an older snapshot's .env.production holds.
    launch source restore eigen-20260101-000000.tar.gz
    if [ "$CODE" = 0 ] && printf '%s\n' "$CALLS" | grep -A 1 ' restore eigen-20260101-000000.tar.gz --yes$' |
        grep -q ' configure --backfill$' && printf '%s\n' "$CALLS" | grep -q ' up -d --wait$'; then
        ok "$SHELL_NAME: a source restore adds what is new to the restored .env.production, then starts Eigen"
    else
        fail "$SHELL_NAME: a source restore: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    launch release restore eigen-20260101-000000.tar.gz
    if [ "$CODE" = 0 ] && printf '%s\n' "$CALLS" | grep -q ' restore eigen-20260101-000000.tar.gz --yes$' &&
        ! printf '%s\n' "$CALLS" | grep -q ' configure '; then
        ok "$SHELL_NAME: a release restore leaves the snapshot's .env.production to the files of its version"
    else
        fail "$SHELL_NAME: a release restore: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    mkdir "$FIX/source/.eigen/lock"
    echo 999999 >"$FIX/source/.eigen/lock/pid"
    STUB_FAIL=compose-config launch source restart
    if [ "$CODE" = 1 ] && printf '%s\n' "$CALLS" | grep -q ' config --services$' && [ ! -e "$FIX/source/.eigen/lock" ]; then
        ok "$SHELL_NAME: the lock of a process that is gone is taken over, and removed when the command fails"
    else
        fail "$SHELL_NAME: a stale lock: exit $CODE, lock $(ls "$FIX/source/.eigen/lock" 2>&1)"
    fi
    # A container's own PID namespace cannot see this shell.
    if [ "$SHELL_NAME" = host ]; then
        mkdir "$FIX/source/.eigen/lock"
        echo $$ >"$FIX/source/.eigen/lock/pid"
        launch source backup
        expect_error 1 '■  Another ./eigen command is running.' "a running command's lock refuses a backup"
        rm -r "$FIX/source/.eigen/lock"
    fi
done

header "Result"
probe_summary
