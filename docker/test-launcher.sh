#!/usr/bin/env bash
# The launcher alone, without a stack: under dash (debian:bookworm-slim), BusyBox sh and this host's /bin/sh, with a
# stub docker on PATH that answers info and compose version and fails on demand. Covers every command's help, unknown
# commands and arguments, the preflight refusals, local-build and release mode, need_install, update and rollback
# refused in a local build, a failing compose config, stop, what update asks the CLI and names the builds, on a release
# and on the main channel, the tags it refuses, a build whose images differ, a tag that moves during an update, a pinned
# api image that is not here, the files an unfinished update left, which build's CLI the handed-over update saves the
# snapshot with, what setup downloads with and without pins, what rollback names, a lock without a pid, and what status passes the CLI about the snapshots, the files of an unfinished
# update and the newest build of main; setup in a folder that holds the launcher alone, with the registry or the build
# .env.production names, and the installer script apps/index/public/install on this host, as a file and on stdin.
#
# Usage:  ./docker/test-launcher.sh
# Needs:  docker (pulls debian:bookworm-slim and busybox once).

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

FIX=$(mktemp -d "${TMPDIR:-/tmp}/eigentest-launcher.XXXXXX")
FIX=$(cd "$FIX" && pwd -P)
trap 'rm -rf "$FIX"' EXIT

# The stub logs every call to $STUB_LOG. STUB_INFO and STUB_COMPOSE answer info and compose version, empty for a
# failure; STUB_FAIL names the compose subcommands and docker commands that fail; STUB_IMAGE=1 makes image inspect fail
# on an image the launch has not pulled;
# STUB_LATEST and STUB_REVISION are the version and commit the registry's manifest of any api tag names;
# STUB_LABEL_VERSION and STUB_LABEL_REVISION the labels of any local image, STUB_LABEL_REVISION_DOVECOT that of a dovecot
# image, and STUB_MOVED that of any image once api was pulled twice, as a tag that moves; STUB_DIGEST the registry
# digest of every local image; a docker run with STUB_RUN_FAIL among its arguments fails, and one with --checked also
# prints STUB_CHECKED, and one of snapshot --pre-update writes .eigen/last-update. A run of bootstrap writes a Compose
# file into this folder, the starter keys into .env.production when it names no release, keeping the registry it
# names, and a launcher that prints STUB_LAUNCHER on stderr.
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
    image)
        for ref; do :; done
        if [ "$2" = inspect ] && [ "${STUB_IMAGE:-0}" = 1 ] && ! grep -qxF "pull $ref" "$STUB_LOG"; then exit 1; fi
        revision=${STUB_LABEL_REVISION:-abc1234}
        if [ -n "${STUB_MOVED:-}" ] && [ "$(grep -c '^pull [^ ]*/api:' "$STUB_LOG")" -ge 2 ]; then revision=$STUB_MOVED; fi
        case $* in
            *Labels*image.version*) echo "${STUB_LABEL_VERSION:-0.2.99}" ;;
            *Labels*image.revision*/dovecot*) echo "${STUB_LABEL_REVISION_DOVECOT:-$revision}" ;;
            *Labels*image.revision*) echo "$revision" ;;
            *RepoDigests*) if [ -n "${STUB_DIGEST:-}" ]; then echo "${ref%:*}@sha256:$STUB_DIGEST"; fi ;;
        esac
        ;;
    manifest)
        echo "\"org.opencontainers.image.version\": \"${STUB_LATEST:-}\","
        echo "\"org.opencontainers.image.revision\": \"${STUB_REVISION:-}\""
        ;;
    run)
        shift
        echo "stub run: $*"
        case " $* " in *" ${STUB_RUN_FAIL:-none} "*) exit 1 ;; esac
        case " $* " in *" --checked "*) printf '%s\n' "${STUB_CHECKED:-}" ;; esac
        case " $* " in *" snapshot --pre-update "*)
            mkdir -p .eigen
            echo eigen-pre-update-light-20260101-000000.tar.gz >.eigen/last-update
            ;;
        esac
        case " $* " in *" bootstrap "*)
            : >docker-compose.yml
            if ! grep -q '^EIGEN_VERSION=' .env.production 2>/dev/null; then
                registry=$(sed -n 's/^EIGEN_REGISTRY=//p' .env.production 2>/dev/null)
                if [ -z "$registry" ]; then
                    registry=ghcr.io/eigen-is/eigen
                    echo "EIGEN_REGISTRY=$registry" >>.env.production
                fi
                printf '%s\n' EIGEN_VERSION=0.2.99 "EIGEN_API_IMAGE=$registry/api:0.2.99" >>.env.production
            fi
            # A new file: the launcher that ran bootstrap still reads the old one.
            if [ "$(sed -n 2p eigen)" != 'echo STUB_LAUNCHER >&2' ]; then
                { head -n 1 eigen; echo 'echo STUB_LAUNCHER >&2'; tail -n +2 eigen; } >eigen.new
                chmod 755 eigen.new
                mv eigen.new eigen
            fi
            ;;
        esac
        ;;
    *) fails "$1" ;;
esac
EOF
chmod 755 "$FIX/bin/docker"
# The installer's download: this checkout's launcher at -o, or a web page with STUB_CURL_HTML=1. Logged like docker.
cat >"$FIX/bin/curl" <<EOF
#!/bin/sh
printf 'curl %s\n' "\$*" >>"\$STUB_LOG"
while [ "\$1" != -o ]; do shift; done
if [ "\${STUB_CURL_HTML:-0}" = 1 ]; then echo '<html>' >"\$2"; else cp "$REPO_ROOT/eigen" "\$2"; fi
EOF
chmod 755 "$FIX/bin/curl"

# A local build, a release folder and one on the main channel, each with the launcher and a set-up .env.production;
# bare/ has no install, and alone/ is the launcher alone, as the installer leaves it.
for dir in local release channel bare; do
    mkdir "$FIX/$dir"
    cp "$REPO_ROOT/eigen" "$FIX/$dir/eigen"
done
alone() {
    rm -rf "$FIX/alone"
    mkdir "$FIX/alone"
    cp "$REPO_ROOT/eigen" "$FIX/alone/eigen"
}
for dir in release channel; do : >"$FIX/$dir/docker-compose.yml"; done
: >"$FIX/local/docker-compose.build.yml"
cp "$REPO_ROOT/.bun-version" "$REPO_ROOT/package.json" "$FIX/local/"
for dir in local release; do printf 'DOMAIN=eigen.example.com\nEIGEN_VERSION=0.2.99\n' >"$FIX/$dir/.env.production"; done
printf 'DOMAIN=eigen.example.com\nEIGEN_VERSION=main\n' >"$FIX/channel/.env.production"
for name in $IMAGES; do
    printf '%s=ghcr.io/eigen-is/eigen/%s@sha256:aaa\n' "$(image_key "$name")" "$name" >>"$FIX/channel/.env.production"
done

docker pull -q debian:bookworm-slim >/dev/null
docker pull -q busybox >/dev/null
PATH_IN=/stub:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# launch <folder> <args…>: the launcher under $SHELL_NAME in $FIX/<folder>; sets CODE, OUT (stdout), ERR (stderr) and
# CALLS (what docker was asked). STUB_* pass through as set here.
launch() {
    local dir="$FIX/$1" vars=("STUB_LOG=$FIX/calls.log") flags=() name var
    shift
    : >"$FIX/calls.log"
    for name in STUB_INFO STUB_COMPOSE STUB_FAIL STUB_IMAGE STUB_LATEST STUB_REVISION STUB_LABEL_VERSION \
        STUB_LABEL_REVISION STUB_LABEL_REVISION_DOVECOT STUB_MOVED STUB_DIGEST STUB_RUN_FAIL STUB_CHECKED; do
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

# first_setup: the api images the last launch pulled, bootstrapped from and configured, in order, on one line.
first_setup() {
    printf '%s\n' "$CALLS" | sed -n -e 's/^\(pull [^ ]*\/api:[^ ]*\)$/\1/p' \
        -e 's/^run .* \([^ ]*\) bootstrap --force --out \/install$/bootstrap \1/p' -e 's/^run .* configure$/configure/p' |
        tr '\n' '|'
}
FIRST_SETUP='pull ghcr.io/eigen-is/eigen/api:latest|bootstrap ghcr.io/eigen-is/eigen/api:latest|pull ghcr.io/eigen-is/eigen/api:0.2.99|configure|'

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
        launch local "$command" --help
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
        launch local $args
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

    STUB_INFO='' launch local restart
    expect_error 1 '■  Docker is not running, or this user cannot use it.' "no Docker"
    STUB_COMPOSE='' launch local restart
    expect_error 1 '■  Docker Compose is not installed.' "no Compose"
    STUB_COMPOSE=2.19.3 launch local restart
    expect_error 1 '■  Docker Compose 2.19.3 is too old for this install; it needs 2.20 or newer.' "Compose 2.19.3"
    printf 'services:\n  caddy:\n    ports: !override []\n' >"$FIX/local/docker-compose.override.yml"
    STUB_COMPOSE=2.24.3-desktop.1 launch local restart
    rm "$FIX/local/docker-compose.override.yml"
    expect_error 1 'it needs 2.24.4 or newer' "an override with !override and Compose 2.24.3"
    STUB_INFO='27.3.1 aarch64' launch local restart
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q '◇  Docker 27.3.1 on aarch64, Compose 2.29.1'; then
        ok "$SHELL_NAME: an aarch64 server goes through, its architecture named"
    else
        fail "$SHELL_NAME: aarch64: exit $CODE, '$OUT'"
    fi

    launch local restart
    local_calls=$CALLS
    launch release restart
    if printf '%s\n' "$local_calls" | grep -q '^compose .* -f docker-compose.build.yml .*up -d --wait$' &&
        printf '%s\n' "$CALLS" | grep -q '^compose .*up -d --wait$' && ! printf '%s\n' "$CALLS" | grep -q build.yml; then
        ok "$SHELL_NAME: a folder with the build overlay runs Compose with it, a release folder without"
    else
        fail "$SHELL_NAME: mode detection: local '$local_calls', release '$CALLS'"
    fi
    STUB_IMAGE=1 launch local restore --help
    expect_error 1 '■  Eigen is not built yet.' "restore --help in an unbuilt local build"
    launch local update
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  A local build has no updates.' &&
        printf '%s\n' "$ERR" | grep -q '└  Pull the code and run ./eigen setup again, which builds it.' && [ -z "$CALLS" ]; then
        ok "$SHELL_NAME: update in a local build says setup builds it, without asking Docker"
    else
        fail "$SHELL_NAME: update in a local build: exit $CODE, '$ERR', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    launch local rollback --yes
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  A local build has no update to roll back.' &&
        printf '%s\n' "$ERR" | grep -q '└  Go back in the code and run ./eigen setup again, which builds it.' && [ -z "$CALLS" ]; then
        ok "$SHELL_NAME: rollback in a local build says setup builds it, without asking Docker"
    else
        fail "$SHELL_NAME: rollback in a local build: exit $CODE, '$ERR', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
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

    # The launcher compares builds for equality only; the new version's CLI orders them.
    STUB_LATEST=0.2.99 STUB_REVISION=abc1234 launch release update --check
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q 'Eigen 0.2.99 (abc1234) is up to date' &&
        ! printf '%s\n' "$CALLS" | grep -q '^run '; then
        ok "$SHELL_NAME: update --check on the newest version says it is up to date without running the CLI"
    else
        fail "$SHELL_NAME: update --check when up to date: exit $CODE, '$OUT'"
    fi
    STUB_LATEST=0.2.98 STUB_REVISION=def5678 launch release update --check
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q 'Eigen 0.2.98 (def5678) is out' && printf '%s\n' "$CALLS" |
        grep -q '^run .* ghcr.io/eigen-is/eigen/api:0.2.98 update-check --from 0.2.99 --accept-breaking$'; then
        ok "$SHELL_NAME: update --check on another version asks that version's CLI, which orders them"
    else
        fail "$SHELL_NAME: update --check to another version: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    # main compares builds too: the registry's newest against the labels of the pinned api image.
    STUB_LATEST=0.2.99 STUB_REVISION=abc1234 STUB_LABEL_REVISION=abc1234 launch channel update --check
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q 'Eigen 0.2.99 (abc1234) is up to date' &&
        ! printf '%s\n' "$CALLS" | grep -q '^run '; then
        ok "$SHELL_NAME: update --check on the newest build of main says it is up to date without running the CLI"
    else
        fail "$SHELL_NAME: update --check on main when up to date: exit $CODE, '$OUT'"
    fi
    STUB_LATEST=0.2.99 STUB_REVISION=def5678 STUB_LABEL_REVISION=abc1234 launch channel update --check
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q 'Eigen 0.2.99 (def5678) is out' &&
        printf '%s\n' "$CALLS" | grep -q '^pull ghcr.io/eigen-is/eigen/api:main$' && printf '%s\n' "$CALLS" |
        grep -q '^run .* ghcr.io/eigen-is/eigen/api:main update-check --from 0.2.99 --accept-breaking$'; then
        ok "$SHELL_NAME: update --check on main with a new build pulls it and asks its CLI from the version of the running one"
    else
        fail "$SHELL_NAME: update --check on main with a new build: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    STUB_LATEST=0.3.0 launch channel update 0.3.0 --check
    if [ "$CODE" = 0 ] && printf '%s\n' "$CALLS" |
        grep -q '^run .* ghcr.io/eigen-is/eigen/api:0.3.0 update-check --from 0.2.99 --accept-breaking$'; then
        ok "$SHELL_NAME: update <version> on main asks that version's CLI from the version of the running build"
    else
        fail "$SHELL_NAME: update 0.3.0 on main: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    STUB_IMAGE=1 STUB_REVISION=abc1234 STUB_LABEL_REVISION=abc1234 launch channel update --check
    if [ "$CODE" = 0 ] && [ "$(printf '%s\n' "$CALLS" | grep -m 1 '^pull ')" = 'pull ghcr.io/eigen-is/eigen/api@sha256:aaa' ]; then
        ok "$SHELL_NAME: update --check without the pinned api image here downloads it first"
    else
        fail "$SHELL_NAME: update --check without the pinned api image: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    STUB_IMAGE=1 STUB_FAIL=pull launch channel update --check
    expect_error 1 '■  The image Eigen runs, ghcr.io/eigen-is/eigen/api@sha256:aaa, is not here and cannot be downloaded.' \
        "update --check when the pinned api image can be neither found nor downloaded"
    failed=''
    for fixture in channel:main release:0.3.0; do
        STUB_LATEST=0.3.0 STUB_REVISION=def5678 STUB_LABEL_REVISION=abc1234 STUB_LABEL_REVISION_DOVECOT=def5678 \
            launch "${fixture%:*}" update
        if [ "$CODE" != 1 ] || ! printf '%s\n' "$ERR" | grep -q "■  The images of ${fixture#*:} are from different builds: api abc1234, frontend abc1234, postfix abc1234, dovecot def5678, unbound abc1234." ||
            printf '%s\n' "$CALLS" | grep -q ' stop$'; then
            failed="$failed $fixture ($CODE)"
        fi
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: update refuses the images of main or a version when they are of different builds, before anything stops"
    else
        fail "$SHELL_NAME: a mixed build not refused:$failed"
    fi
    STUB_LATEST=0.2.99 STUB_REVISION=def5678 STUB_MOVED=fff0000 launch channel update
    if [ "$CODE" = 1 ] &&
        printf '%s\n' "$ERR" | grep -q '■  main moved while downloading: the notes were of Eigen 0.2.99 (abc1234).' &&
        ! printf '%s\n' "$CALLS" | grep -Eq ' stop$| bootstrap '; then
        ok "$SHELL_NAME: update refuses a tag that moved between the notes and the download, before anything stops"
    else
        fail "$SHELL_NAME: a tag that moved: exit $CODE, '$ERR', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    launch release update candidate-0.3.0-arm64
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Eigen has no "candidate-0.3.0-arm64".' &&
        ! printf '%s\n' "$CALLS" | grep -q '^pull '; then
        ok "$SHELL_NAME: update to a tag that is no version, latest or main is refused before anything is pulled"
    else
        fail "$SHELL_NAME: update candidate-0.3.0-arm64: exit $CODE, '$ERR', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    # A tag is resolved to digests once: an install that pins them keeps them.
    STUB_IMAGE=1 launch channel setup
    if [ "$CODE" = 0 ] && printf '%s\n' "$CALLS" | grep -q '^pull ghcr.io/eigen-is/eigen/api@sha256:aaa$' &&
        ! printf '%s\n' "$CALLS" | grep -q '^pull ghcr.io/eigen-is/eigen/api:main$' &&
        printf '%s\n' "$CALLS" | grep ' configure$' | grep -vq EIGEN_VERSION; then
        ok "$SHELL_NAME: setup on an install that pins digests downloads those, and leaves the pins as they are"
    else
        fail "$SHELL_NAME: setup on main: exit $CODE, '$ERR', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    STUB_IMAGE=1 launch release setup
    if printf '%s\n' "$CALLS" | grep -q '^pull ghcr.io/eigen-is/eigen/api:0.2.99$' &&
        printf '%s\n' "$ERR" | grep -q 'api:0.2.99 has no registry digest'; then
        ok "$SHELL_NAME: setup on an install that pins no digests downloads its version and pins it"
    else
        fail "$SHELL_NAME: setup on 0.2.99: exit $CODE, '$ERR', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    # What the installer leaves: the release it downloads writes the rest, and that release's launcher takes over.
    alone
    STUB_DIGEST=ddd launch alone setup
    if [ "$CODE" = 0 ] && [ "$(first_setup)" = "$FIRST_SETUP" ] && [ ! -e "$FIX/alone/.eigen/lock" ] &&
        printf '%s\n' "$ERR" | grep -qx STUB_LAUNCHER; then
        ok "$SHELL_NAME: setup beside the launcher alone bootstraps from api:latest and hands over to the launcher it wrote, lock and all"
    else
        fail "$SHELL_NAME: setup beside the launcher alone: exit $CODE, '$ERR', calls: $(first_setup)"
    fi
    # A mirror install names its registry in .env.production by hand.
    alone
    echo EIGEN_REGISTRY=example.test/eigen >"$FIX/alone/.env.production"
    STUB_DIGEST=ddd launch alone setup
    if [ "$CODE" = 0 ] && [ "$(printf '%s\n' "$CALLS" | grep -m 1 '^pull ')" = 'pull example.test/eigen/api:latest' ] &&
        printf '%s\n' "$CALLS" | grep -q '^pull example.test/eigen/unbound:0.2.99$' &&
        printf '%s\n' "$ERR" | grep -qx STUB_LAUNCHER; then
        ok "$SHELL_NAME: setup beside the launcher alone gets Eigen from the registry .env.production names"
    else
        fail "$SHELL_NAME: setup beside the launcher alone with a registry: exit $CODE, '$ERR', calls: $(first_setup)"
    fi
    alone
    printf 'EIGEN_VERSION=0.2.98\nEIGEN_API_IMAGE=ghcr.io/eigen-is/eigen/api@sha256:ccc\n' >"$FIX/alone/.env.production"
    launch alone setup
    if [ "$(printf '%s\n' "$CALLS" | grep -m 1 '^pull ')" = 'pull ghcr.io/eigen-is/eigen/api@sha256:ccc' ] &&
        printf '%s\n' "$ERR" | grep -qx STUB_LAUNCHER; then
        ok "$SHELL_NAME: setup beside the launcher alone bootstraps from the api image .env.production pins"
    else
        fail "$SHELL_NAME: setup beside the launcher alone with a pin: exit $CODE, '$ERR', calls: $(first_setup)"
    fi
    STUB_REVISION=def5678 launch channel status
    if printf '%s\n' "$CALLS" | grep -q ' --latest=def5678$'; then
        ok "$SHELL_NAME: status on main passes the commit of its newest build"
    else
        fail "$SHELL_NAME: status on main: calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    launch local stop
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q '◇  Eigen stopped' &&
        printf '%s\n' "$CALLS" | grep -q '^compose .* stop$' && ! printf '%s\n' "$CALLS" | grep -q ' up '; then
        ok "$SHELL_NAME: stop stops Eigen and starts nothing"
    else
        fail "$SHELL_NAME: stop: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    mkdir -p "$FIX/release/snapshots" "$FIX/release/.eigen" "$FIX/channel/.eigen"
    head -c 4096 /dev/zero >"$FIX/release/snapshots/eigen-20260101-000000.tar.gz"
    echo ghcr.io/eigen-is/eigen/api@sha256:bbb >"$FIX/release/.eigen/bundle"
    STUB_LATEST=0.2.99 STUB_LABEL_VERSION=0.2.100 launch release status
    rm -r "$FIX/release/snapshots" "$FIX/release/.eigen/bundle"
    # --services spans lines of the call log.
    if printf '%s\n' "$CALLS" | grep -q ' --snapshots=eigen-20260101-000000.tar.gz --snapshots-kb=[1-9][0-9]* ' &&
        printf '%s\n' "$CALLS" | grep -q ' --latest=0.2.99 --files=0.2.100 (abc1234)$'; then
        ok "$SHELL_NAME: status passes the snapshots, their size, and the build the files were written from"
    else
        fail "$SHELL_NAME: status: calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    echo ghcr.io/eigen-is/eigen/api@sha256:aaa >"$FIX/channel/.eigen/bundle"
    launch channel status
    rm "$FIX/channel/.eigen/bundle"
    if [ "$CODE" = 0 ] && ! printf '%s\n' "$CALLS" | grep -q -- '--files'; then
        ok "$SHELL_NAME: status passes no files when they are of the api image .env.production pins"
    else
        fail "$SHELL_NAME: status with the files of the pinned image: calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    echo ghcr.io/eigen-is/eigen/api@sha256:bbb >"$FIX/release/.eigen/bundle"
    STUB_IMAGE=1 launch release status
    expect_error 1 '■  ghcr.io/eigen-is/eigen/api@sha256:bbb is not here.' \
        "status names no build of files whose api image is not here"

    # An update that stopped halfway, to whatever target, left the files of another build than the one it runs.
    STUB_LATEST=0.2.99 STUB_REVISION=abc1234 launch release update
    if [ "$CODE" = 0 ] && printf '%s\n' "$CALLS" | grep -A 100 ' ghcr.io/eigen-is/eigen/api:local bootstrap --force --out /install$' |
        grep -q ' up -d --wait$' && [ "$(cat "$FIX/release/.eigen/bundle")" = ghcr.io/eigen-is/eigen/api:local ]; then
        ok "$SHELL_NAME: update when up to date writes the files of the pinned build over another's, then starts Eigen"
    else
        fail "$SHELL_NAME: update over the files of another build: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    STUB_LATEST=0.2.99 STUB_REVISION=abc1234 launch release update
    rm "$FIX/release/.eigen/bundle"
    if [ "$CODE" = 0 ] && ! printf '%s\n' "$CALLS" | grep -q ' bootstrap ' &&
        printf '%s\n' "$CALLS" | grep -q ' up -d --wait$'; then
        ok "$SHELL_NAME: update when up to date leaves the files of the pinned build as they are"
    else
        fail "$SHELL_NAME: update over the files of the pinned build: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    # The handover: the new launcher pins the tag, and the running build's CLI saves the snapshot before the switch.
    mkdir "$FIX/release/data"
    STUB_DIGEST=ddd launch release update --pulled 0.2.99
    rm -r "$FIX/release/data" "$FIX/release/.eigen/last-update"
    sequence=$(printf '%s\n' "$CALLS" | sed -n -e 's/^compose .* stop$/stop/p' -e 's/^compose .* up -d --wait$/up/p' \
        -e 's/^run .* \([^ ]*\) snapshot --pre-update --light$/snapshot \1/p' \
        -e 's/^run .* \([^ ]*\) configure --backfill$/configure \1/p' | tr '\n' '|')
    if [ "$CODE" = 0 ] && [ "$sequence" = 'configure ghcr.io/eigen-is/eigen/api@sha256:ddd|stop|snapshot ghcr.io/eigen-is/eigen/api:local|configure ghcr.io/eigen-is/eigen/api@sha256:ddd|up|' ] &&
        printf '%s\n' "$OUT" | grep -q '│  Saved before the update: snapshots/eigen-pre-update-light-20260101-000000.tar.gz, a light snapshot' &&
        printf '%s\n' "$OUT" | grep -q '└  ./eigen rollback goes back to Eigen 0.2.99 (abc1234).'; then
        ok "$SHELL_NAME: update --pulled saves the snapshot with the running build's CLI, switches with the new one, and names what it saved"
    else
        fail "$SHELL_NAME: update --pulled: exit $CODE, sequence '$sequence', '$OUT', '$ERR'"
    fi

    STUB_FAIL=compose-config launch local restart
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Eigen did not start' &&
        printf '%s\n' "$CALLS" | grep -q ' config --services$' &&
        ! printf '%s\n' "$CALLS" | grep -Eq '^(rm|stop) | (up|stop) '; then
        ok "$SHELL_NAME: a failing compose config removes, stops and starts nothing"
    else
        fail "$SHELL_NAME: failing compose config: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    STUB_RUN_FAIL=--yes launch local restore eigen-20260101-000000.tar.gz
    if [ "$CODE" = 1 ] && printf '%s\n' "$CALLS" | grep -q ' restore eigen-20260101-000000.tar.gz --yes$' &&
        printf '%s\n' "$CALLS" | grep -q ' up -d --wait$' &&
        printf '%s\n' "$CALLS" | tail -n 1 | grep -q ' rm -rf .eigen/restore$' && [ ! -e "$FIX/local/.eigen/lock" ]; then
        ok "$SHELL_NAME: a failed swap starts Eigen again, then removes the checked copy and the lock"
    else
        fail "$SHELL_NAME: a failed swap: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    if [ "$(printf '%s\n' "$CALLS" | grep -c ' config$')" = 1 ]; then
        ok "$SHELL_NAME: one compose config names the project for the stop and the start"
    else
        fail "$SHELL_NAME: the project was asked $(printf '%s\n' "$CALLS" | grep -c ' config$') times"
    fi

    # A local build runs today's Compose files on what an older snapshot's .env.production holds.
    launch local restore eigen-20260101-000000.tar.gz
    if [ "$CODE" = 0 ] && printf '%s\n' "$CALLS" | grep -A 1 ' restore eigen-20260101-000000.tar.gz --yes$' |
        grep -q ' configure --backfill$' && printf '%s\n' "$CALLS" | grep -q ' up -d --wait$'; then
        ok "$SHELL_NAME: a local build's restore adds what is new to the restored .env.production, then starts Eigen"
    else
        fail "$SHELL_NAME: a local build's restore: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    STUB_CHECKED=EIGEN_API_IMAGE=ghcr.io/eigen-is/eigen/api:local launch release restore eigen-20260101-000000.tar.gz
    if [ "$CODE" = 0 ] && printf '%s\n' "$CALLS" | grep -q ' restore eigen-20260101-000000.tar.gz --yes$' &&
        ! printf '%s\n' "$CALLS" | grep -Eq ' (configure|bootstrap) '; then
        ok "$SHELL_NAME: a release restore of the images it runs leaves the snapshot's .env.production to its files"
    else
        fail "$SHELL_NAME: a release restore: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    checked="EIGEN_VERSION=main"
    for name in $IMAGES; do
        checked="$checked
$(image_key "$name")=ghcr.io/eigen-is/eigen/$name@sha256:bbb"
    done
    STUB_IMAGE=1 STUB_CHECKED=$checked launch release restore eigen-20260101-000000.tar.gz
    if [ "$CODE" = 0 ] && [ "$(printf '%s\n' "$CALLS" | grep -m 1 '^pull ')" = 'pull ghcr.io/eigen-is/eigen/api:local' ] &&
        printf '%s\n' "$CALLS" | grep -q '^pull ghcr.io/eigen-is/eigen/unbound@sha256:bbb$' &&
        printf '%s\n' "$CALLS" | grep -A 100 ' --yes$' |
        grep -q ' ghcr.io/eigen-is/eigen/api@sha256:bbb bootstrap --force --out /install$' &&
        [ "$(cat "$FIX/release/.eigen/bundle")" = ghcr.io/eigen-is/eigen/api@sha256:bbb ]; then
        ok "$SHELL_NAME: a release restore gets the api image it runs, pulls the images the snapshot pins, then writes the files of its api image"
    else
        fail "$SHELL_NAME: a release restore to other images: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    STUB_CHECKED=EIGEN_VERSION=0.2.98 launch release restore eigen-20260101-000000.tar.gz
    expect_error 1 '■  The snapshot pins no api image.' "a release restore of a snapshot that pins no images"
    echo eigen-pre-update-light-20260101-000000.tar.gz >"$FIX/release/.eigen/last-update"
    mkdir "$FIX/release/snapshots"
    : >"$FIX/release/snapshots/eigen-pre-update-light-20260101-000000.tar.gz"
    STUB_CHECKED=$checked launch release rollback --yes
    rm -rf "$FIX/release/snapshots" "$FIX/release/.eigen/last-update" "$FIX/release/.eigen/bundle"
    if [ "$CODE" = 0 ] &&
        printf '%s\n' "$OUT" | grep -q '◆  Back from Eigen 0.2.99 (abc1234) to the snapshot the last update saved' &&
        printf '%s\n' "$CALLS" | grep -q ' restore eigen-pre-update-light-20260101-000000.tar.gz --yes$' &&
        printf '%s\n' "$OUT" | grep -q '◇  Eigen 0.2.99 (abc1234) → 0.2.99 (abc1234) is running at https://eigen.example.com/'; then
        ok "$SHELL_NAME: rollback puts back the snapshot .eigen/last-update names, and names the builds it leaves and reaches"
    else
        fail "$SHELL_NAME: a release rollback: exit $CODE, '$OUT', '$ERR'"
    fi

    mkdir "$FIX/local/.eigen/lock"
    echo 999999 >"$FIX/local/.eigen/lock/pid"
    STUB_FAIL=compose-config launch local restart
    if [ "$CODE" = 1 ] && printf '%s\n' "$CALLS" | grep -q ' config --services$' && [ ! -e "$FIX/local/.eigen/lock" ]; then
        ok "$SHELL_NAME: the lock of a process that is gone is taken over, and removed when the command fails"
    else
        fail "$SHELL_NAME: a stale lock: exit $CODE, lock $(ls "$FIX/local/.eigen/lock" 2>&1)"
    fi
    # A launcher between its mkdir and its pid.
    mkdir "$FIX/local/.eigen/lock"
    : >"$FIX/local/.eigen/lock/pid"
    launch local backup
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Another ./eigen command is running.' && printf '%s\n' "$ERR" |
        grep -q '└  Wait for it to end, then run ./eigen backup again. If none runs, remove .eigen/lock.$' &&
        [ -e "$FIX/local/.eigen/lock/pid" ]; then
        ok "$SHELL_NAME: a lock without a pid refuses a backup, says how to remove it, and stays"
    else
        fail "$SHELL_NAME: a lock without a pid: exit $CODE, '$ERR', lock $(ls "$FIX/local/.eigen/lock" 2>&1)"
    fi
    rm -rf "$FIX/local/.eigen/lock"
    # A container's own PID namespace cannot see this shell.
    if [ "$SHELL_NAME" = host ]; then
        mkdir "$FIX/local/.eigen/lock"
        echo $$ >"$FIX/local/.eigen/lock/pid"
        launch local backup
        expect_error 1 '■  Another ./eigen command is running.' "a running command's lock refuses a backup"
        rm -r "$FIX/local/.eigen/lock"
    fi
done

# The installer under this host's /bin/sh; the launcher it hands over to runs under all three above.
header "The installer"
INSTALLER="$REPO_ROOT/apps/index/public/install"
mkdir "$FIX/fresh" "$FIX/piped" "$FIX/taken" "$FIX/empty" "$FIX/nodocker" "$FIX/page"
: >"$FIX/taken/docker-compose.yml"
ln -s "$FIX/bin/curl" "$FIX/nodocker/curl"

# run_installer [--stdin] <folder> [PATH]: the installer under this host's /bin/sh in $FIX/<folder>, as a file or, with
# --stdin, as curl | sh gives it; sets CODE, OUT, ERR and CALLS as launch does.
run_installer() {
    local script=("$INSTALLER") input=/dev/null
    if [ "$1" = --stdin ]; then
        script=(-s) input=$INSTALLER
        shift
    fi
    : >"$FIX/calls.log"
    CODE=0
    OUT=$(cd "$FIX/$1" && env STUB_LOG="$FIX/calls.log" STUB_DIGEST=ddd STUB_CURL_HTML="${STUB_CURL_HTML:-0}" \
        PATH="${2:-$FIX/bin:$PATH}" /bin/sh "${script[@]}" <"$input" 2>"$FIX/stderr") || CODE=$?
    ERR=$(cat "$FIX/stderr")
    CALLS=$(cat "$FIX/calls.log")
}

# installed <folder> <how the installer ran>: the last run_installer said where Eigen goes, downloaded the launcher as it
# is and ran ./eigen setup, which handed over.
installed() {
    if [ "$CODE" = 0 ] &&
        [ "$(printf '%s\n' "$OUT" | head -n 1)" = "Installing Eigen into $FIX/$1. Its data will live in this folder." ] &&
        [ "$(printf '%s\n' "$CALLS" | head -n 1)" = 'curl -fsSL -o eigen.tmp https://raw.githubusercontent.com/eigen-is/eigen/main/eigen' ] &&
        sed 2d "$FIX/$1/eigen" | cmp -s "$REPO_ROOT/eigen" - && [ ! -e "$FIX/$1/eigen.tmp" ] &&
        [ "$(first_setup)" = "$FIRST_SETUP" ] && printf '%s\n' "$ERR" | grep -qx STUB_LAUNCHER; then
        ok "the installer $2 says where Eigen goes, downloads the launcher as it is and runs ./eigen setup, which hands over"
    else
        fail "the installer $2: exit $CODE, '$OUT', '$ERR', calls: $(first_setup)"
    fi
}
run_installer fresh
installed fresh 'from a file'
# A command that read stdin would eat the rest of the script.
run_installer --stdin piped
installed piped 'on stdin, as curl | sh runs it,'
run_installer taken
if [ "$CODE" = 1 ] &&
    [ "$ERR" = 'This folder already has an Eigen install. Run ./eigen setup to change it, or ./eigen update.' ] &&
    [ ! -e "$FIX/taken/eigen" ] && [ -z "$CALLS" ]; then
    ok "the installer refuses a folder with an install, before it downloads anything"
else
    fail "the installer in a folder with an install: exit $CODE, '$ERR'"
fi
STUB_CURL_HTML=1 run_installer page
if [ "$CODE" = 1 ] && [ "$ERR" = 'The download is not the eigen command; try again later.' ] &&
    [ ! -e "$FIX/page/eigen" ] && [ ! -e "$FIX/page/eigen.tmp" ]; then
    ok "the installer refuses a download that is not the launcher, and leaves nothing behind"
else
    fail "the installer with a page for a launcher: exit $CODE, '$ERR', $(ls -A "$FIX/page" | tr '\n' ' ')"
fi
run_installer empty "$FIX/nodocker"
if [ "$CODE" = 1 ] && [ "$ERR" = 'Docker is not installed. Install it first: https://docs.docker.com/engine/install/' ]; then
    ok "the installer without Docker says to install it"
else
    fail "the installer without Docker: exit $CODE, '$ERR'"
fi

header "Result"
probe_summary
