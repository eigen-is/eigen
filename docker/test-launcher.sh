#!/usr/bin/env bash
# The launcher alone, without a stack: under dash (debian:bookworm-slim), BusyBox sh and this host's /bin/sh, with a
# stub docker on PATH that answers info and compose version and fails on demand. Covers every command's help, unknown
# commands and arguments, the preflight refusals, source and release mode, need_install, and a failing compose config.
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
# CALLS (what docker was asked). STUB_* and EIGEN_ALLOW_ARCH pass through as set here.
launch() {
    local dir="$FIX/$1" vars=("STUB_LOG=$FIX/calls.log") flags=() name var
    shift
    : >"$FIX/calls.log"
    for name in STUB_INFO STUB_COMPOSE STUB_FAIL STUB_IMAGE STUB_LATEST STUB_RUN_FAIL EIGEN_ALLOW_ARCH; do
        if [ -n "${!name+set}" ]; then vars+=("$name=${!name}"); fi
    done
    CODE=0
    if [ "$SHELL_NAME" = host ]; then
        OUT=$(cd "$dir" && env "${vars[@]}" PATH="$FIX/bin:$PATH" /bin/sh ./eigen "$@" 2>"$FIX/stderr") || CODE=$?
    else
        for var in "${vars[@]}"; do flags+=(-e "$var"); done
        OUT=$(docker run --rm -v "$FIX:$FIX" -v "$FIX/bin:/stub:ro" -w "$dir" -e PATH="$PATH_IN" "${flags[@]}" \
            "$IMAGE" "$SHELL_CMD" ./eigen "$@" 2>"$FIX/stderr") || CODE=$?
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
    for command in status backup logs update rollback restart; do
        launch bare "$command" --help
        case "$CODE $(printf '%s\n' "$OUT" | head -n 1)" in
            "0 Usage: ./eigen $command"*) ;;
            *) failed="$failed $command" ;;
        esac
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: status, backup, logs, update, rollback and restart --help print their usage"
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
    for args in 'status extra' 'backup extra' 'restart extra' 'logs a b' 'update --bogus' 'update 1 2' \
        'rollback --nope'; do
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
    for command in status backup restart update rollback logs reset-password; do
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
    expect_error 1 '■  Eigen runs on x86_64 servers; this Docker runs on aarch64.' "aarch64 without EIGEN_ALLOW_ARCH"
    STUB_INFO='27.3.1 aarch64' EIGEN_ALLOW_ARCH=1 launch source restart
    if printf '%s\n' "$OUT" | grep -q '▲  aarch64 is unsupported; going on because EIGEN_ALLOW_ARCH=1.' &&
        printf '%s\n' "$OUT" | grep -q '◇  Docker 27.3.1, Compose 2.29.1'; then
        ok "$SHELL_NAME: EIGEN_ALLOW_ARCH=1 lets aarch64 through with a warning"
    else
        fail "$SHELL_NAME: EIGEN_ALLOW_ARCH=1: exit $CODE, '$OUT'"
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

    # A prerelease comes before its version, and its numbers compare as numbers: rc.9 before rc.10.
    failed=''
    for versions in '0.3.0-rc.10 0.3.0-rc.9 up' '0.3.0-rc.9 0.3.0-rc.10 behind' '0.3.0 0.3.0-rc.1 up' \
        '0.3.0-rc.1 0.3.0 behind' '0.2.100 0.2.99 up'; do
        read -r have latest expected <<<"$versions"
        printf 'DOMAIN=eigen.example.com\nEIGEN_VERSION=%s\n' "$have" >"$FIX/release/.env.production"
        STUB_LATEST=$latest launch release update --check
        got=behind
        if printf '%s\n' "$OUT" | grep -q "Eigen $have is up to date"; then got=up; fi
        if [ "$CODE" != 0 ] || [ "$got" != "$expected" ]; then failed="$failed $have/$latest"; fi
    done
    printf 'DOMAIN=eigen.example.com\nEIGEN_VERSION=0.2.99\n' >"$FIX/release/.env.production"
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: update --check orders versions and prereleases"
    else
        fail "$SHELL_NAME: update --check misorders:$failed"
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
