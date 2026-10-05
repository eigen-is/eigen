#!/usr/bin/env bash
# The launcher alone, without a stack: under dash (debian:bookworm-slim), BusyBox sh and this host's /bin/sh, with a
# stub docker on PATH that answers info and compose version and fails on demand. Covers every command's help, unknown
# commands and arguments, the preflight refusals, local-build and release mode, need_install, update and rollback
# refused in a local build, a failing compose config, stop, what update asks the CLI and names the builds, on a release
# and on the main channel, the tags it refuses, a build whose images differ, a tag that moves during an update, a pinned
# api image that is not here, the files an unfinished update left, the backup an update makes on the running API before
# it writes anything and hands over, typed on a terminal too, update --no-backup with Eigen stopped, an update refused
# while eigen-api reads a .env.production replaced since it started or cannot be asked, and backup refused and restart
# stopping eigen-api first then, what setup
# downloads with and without pins and the build it records, backup on the running API, restore's stage and swap and
# what each failure leaves, an archive uid 1000 cannot read, a running server backup waited out before the stop, an
# update interrupted in that wait that stops and restarts nothing, a swap
# that was cut off and finished first, with no .env.production too, a restore on a new machine from the launcher
# alone, what rollback runs or prints, a lock without a pid, the group and mode every start gives .env.production first but on Docker Desktop,
# and what status passes the CLI about backups/, the files of an unfinished update and the newest build of main, and
# its folder; setup in a folder that holds the launcher alone, with the registry or the build .env.production names,
# and the installer script apps/index/public/install on this host, as a file and on stdin, for setup and restore.
#
# Usage:  ./docker/test-launcher.sh
# Needs:  docker (pulls debian:bookworm-slim and busybox once).

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

FIX=$(mktemp -d "${TMPDIR:-/tmp}/eigentest-launcher.XXXXXX")
FIX=$(cd "$FIX" && pwd -P)
trap 'rm -rf "$FIX"' EXIT

# The stub logs every call to $STUB_LOG. STUB_INFO (version, architecture, operating system) and STUB_COMPOSE answer
# info and compose version, empty for a failure; STUB_FAIL names the compose subcommands and docker commands that fail; STUB_IMAGE=1 makes image inspect fail
# on an image the launch has not pulled;
# STUB_LATEST and STUB_REVISION are the version and commit the registry's manifest of any api tag names;
# STUB_LABEL_VERSION and STUB_LABEL_REVISION the labels of any local image, STUB_LABEL_REVISION_DOVECOT that of a dovecot
# image, and STUB_MOVED that of any image once api was pulled twice, as a tag that moves; STUB_DIGEST the registry
# digest of every local image; a docker run with STUB_RUN_FAIL among its arguments fails, and one with --staged also
# prints STUB_CHECKED, one of update-check --level prints level=STUB_LEVEL, one of restore --env writes a
# .env.production that pins sha256:eee, and one of restore --swap removes .eigen/restore-swap, or with STUB_SWAP_CUT=1
# leaves one and fails, after 3 s with STUB_SWAP_SLOW=1; with STUB_SWAP_KEPT=<folder> it keeps that folder aside and
# says so, as the CLI does. A run of bootstrap writes a Compose file into this folder, the starter keys into
# .env.production when it names no release, keeping the registry it names, and a launcher that prints STUB_LAUNCHER on
# stderr. Compose ps names eigen-api as running unless STUB_RUNNING=0, compose run (the stage) exits STUB_STAGE, and
# compose exec of backup prints archive=STUB_ARCHIVE and exits STUB_EXEC, and one that checksums $EIGEN_ENV_FILE
# that of STUB_MOUNTED, the file eigen-api mounts, else .env.production. With a -t among a run's arguments,
# update-check --level ends its line in \r\n, as Docker's pty does. A run of restore --env refuses a folder with a
# .env.production.
mkdir "$FIX/bin"
cat >"$FIX/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$STUB_LOG"
fails() { case " ${STUB_FAIL:-} " in *" $1 "*) echo "stub: $1 fails" >&2; exit 1 ;; esac; }
case $1 in
    info)
        info=${STUB_INFO-27.3.1 x86_64 Ubuntu 24.04.1 LTS}
        if [ -z "$info" ]; then exit 1; fi
        echo "$info"
        ;;
    compose)
        shift
        while :; do
            case $1 in --env-file | -f | --progress) shift 2 ;; *) break ;; esac
        done
        fails "compose-$1"
        case $1 in
            version) if [ -n "${STUB_COMPOSE-2.29.1}" ]; then echo "${STUB_COMPOSE-2.29.1}"; else exit 1; fi ;;
            config) if [ "${2:-}" = --services ]; then printf 'eigen-api\ncaddy\n'; else echo 'name: stub'; fi ;;
            ps) if [ "${STUB_RUNNING:-1}" = 1 ]; then echo eigen-api; fi ;;
            run) exit "${STUB_STAGE:-0}" ;;
            exec)
                case " $* " in *'cksum <"$EIGEN_ENV_FILE"'*)
                    cksum <"${STUB_MOUNTED:-.env.production}" 2>/dev/null || echo unreadable
                    ;;
                esac
                case " $* " in *" backup "*)
                    echo "archive=${STUB_ARCHIVE-server-pre-update-light-20260101-000000.tar}"
                    exit "${STUB_EXEC:-0}"
                    ;;
                esac
                ;;
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
        case " $* " in *" --staged "*) printf '%s\n' "${STUB_CHECKED:-}" ;; esac
        case " $* " in
            *" -t "*" update-check "*" --level "*) printf 'level=%s\r\n' "${STUB_LEVEL:-light}" ;;
            *" update-check "*" --level "*) echo "level=${STUB_LEVEL:-light}" ;;
        esac
        case " $* " in *" --env "*)
            if [ -e .env.production ]; then echo 'This folder has a .env.production already.' >&2; exit 1; fi
            printf 'DOMAIN=eigen.example.com\nEIGEN_VERSION=0.2.98\n' >.env.production
            for name in api frontend postfix dovecot unbound; do
                printf 'EIGEN_%s_IMAGE=ghcr.io/eigen-is/eigen/%s@sha256:eee\n' "$(echo $name | tr a-z A-Z)" $name >>.env.production
            done
            ;;
        esac
        case " $* " in *" restore --swap "*)
            if [ "${STUB_SWAP_SLOW:-0}" = 1 ]; then sleep 3; fi
            if [ "${STUB_SWAP_CUT:-0}" = 1 ]; then
                : >.eigen/restore-swap
                exit 1
            fi
            rm -f .eigen/restore-swap
            if [ -n "${STUB_SWAP_KEPT:-}" ]; then
                mkdir -p "$STUB_SWAP_KEPT"
                echo "◇  Kept aside: $STUB_SWAP_KEPT"
            fi
            case ${STUB_CHECKED:-} in *EIGEN_API_IMAGE=*)
                printf 'DOMAIN=eigen.example.com\n%s\n' "$STUB_CHECKED" >.env.production
                ;;
            esac
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
HOST_OS=$(docker info --format '{{.OperatingSystem}}')
docker pull -q busybox >/dev/null
PATH_IN=/stub:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# launch <folder> <args…>: the launcher under $SHELL_NAME in $FIX/<folder>; sets CODE, OUT (stdout), ERR (stderr) and
# CALLS (what docker was asked). STUB_* pass through as set here. LAUNCH_TTY=1 gives a container shell a terminal, which
# takes stderr into OUT. LAUNCH_TERM=<call> sends the launcher a TERM a second after docker is asked <call>, as Ctrl-C
# would: bash starts a background job with INT ignored, which a shell cannot trap, and the launcher traps both alike.
# Every launch runs as such a job, its stdin /dev/null as on CI, so one that has not ended 120 s after its start is
# killed, its container too, and exits 137, which fails the check and leaves the suite going.
launch() {
    local dir="$FIX/$1" vars=("STUB_LOG=$FIX/calls.log") flags=() run name var pid deadline
    shift
    : >"$FIX/calls.log"
    for name in STUB_INFO STUB_COMPOSE STUB_FAIL STUB_IMAGE STUB_LATEST STUB_REVISION STUB_LABEL_VERSION \
        STUB_LABEL_REVISION STUB_LABEL_REVISION_DOVECOT STUB_MOVED STUB_DIGEST STUB_RUN_FAIL STUB_CHECKED STUB_LEVEL \
        STUB_SWAP_CUT STUB_SWAP_SLOW STUB_SWAP_KEPT STUB_RUNNING STUB_STAGE STUB_ARCHIVE STUB_EXEC STUB_MOUNTED; do
        if [ -n "${!name+set}" ]; then vars+=("$name=${!name}"); fi
    done
    CODE=0
    if [ "$SHELL_NAME" = host ]; then
        run=(env "${vars[@]}" PATH="$FIX/bin:$PATH" /bin/sh ./eigen "$@")
    else
        for var in "${vars[@]}"; do flags+=(-e "$var"); done
        # As this user, or on a Linux host root's .eigen would refuse this script's own lock below.
        if [ "${LAUNCH_TTY:-0}" = 1 ]; then flags+=(-t); fi
        # A killed docker run leaves its container running.
        rm -f "$FIX/cid"
        flags+=(--cidfile "$FIX/cid")
        # docker run passes the TERM on to the shell in the container.
        run=(docker run --rm --user "$(id -u):$(id -g)" -v "$FIX:$FIX" -v "$FIX/bin:/stub:ro" -w "$dir"
            -e PATH="$PATH_IN" "${flags[@]}" "$IMAGE" "$SHELL_CMD" ./eigen "$@")
    fi
    (cd "$dir" && exec "${run[@]}") >"$FIX/stdout" 2>"$FIX/stderr" &
    pid=$!
    deadline=$(($(date +%s) + 120))
    if [ -n "${LAUNCH_TERM:-}" ]; then
        while kill -0 "$pid" 2>/dev/null && ! grep -qF -- "$LAUNCH_TERM" "$FIX/calls.log" &&
            [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.2; done
        if grep -qF -- "$LAUNCH_TERM" "$FIX/calls.log"; then
            sleep 1
            kill -s TERM "$pid" 2>/dev/null || :
        fi
    fi
    while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.2; done
    if kill -0 "$pid" 2>/dev/null; then
        kill -s KILL "$pid" 2>/dev/null || :
        if [ -s "$FIX/cid" ]; then docker kill "$(cat "$FIX/cid")" >/dev/null 2>&1 || :; fi
        echo 'launch: killed, 120 s after its start' >>"$FIX/stderr"
    fi
    wait "$pid" || CODE=$?
    OUT=$(cat "$FIX/stdout")
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

# The run that gives .env.production group 1000 and mode 0640, as root in a container, in the launcher's call log.
SHARE='-c chgrp 1000 /install/.env.production && chmod 0640 /install/.env.production'

# shared <folder>: the last launch started Eigen, and gave .env.production of that folder to group 1000 right before
# every start.
shared() {
    printf '%s\n' "$CALLS" | awk -v share="run --rm --user 0 --entrypoint sh -v $FIX/$1:/install " -v script=" $SHARE" '
        / up -d --wait$/ { ups++; if (index(prev, share) == 1 && substr(prev, length(prev) - length(script) + 1) == script) shared++ }
        { prev = $0 }
        END { exit !(ups > 0 && ups == shared) }'
}

ARCHIVE=server-manual-full-20260101-000000.tar

# steps: what of the last launch a restore, update or rollback turns on, in order, on one line: the stage (compose
# run), stop, up, pulls, the share of .env.production, and the CLI's restore, bootstrap, configure and rm runs with the
# image each ran in.
steps() {
    printf '%s\n' "$CALLS" | sed -n -e 's/^compose .* run --rm --no-deps -T -e TERM -e NO_COLOR \(.*\)$/stage \1/p' \
        -e 's/^compose .* stop$/stop/p' -e 's/^compose .* up -d --wait$/up/p' -e 's/^\(pull .*\)$/\1/p' \
        -e "s|^run --rm --user 0 --entrypoint sh .* $SHARE\$|share|p" \
        -e 's/^run .* \([^ ]*\) restore \(.*\)$/restore \2 (\1)/p' \
        -e 's/^run .* \([^ ]*\) bootstrap --force --out \/install$/bootstrap \1/p' \
        -e 's/^run .* \([^ ]*\) configure --backfill$/configure \1/p' -e 's/^run .* rm -rf \(.*\)$/rm \1/p' | tr '\n' '|'
}

# update_steps: what of the last launch an update from 0.2.99 turns on, in order, on one line: the notes and the level
# the new CLI gives, the backup on the running API, the bootstrap and configure runs with the image each ran in, the
# stop and the start.
update_steps() {
    printf '%s\n' "$CALLS" | sed -n -e 's/^compose .* stop$/stop/p' -e 's/^compose .* up -d --wait$/up/p' \
        -e 's/^run .* \([^ ]*\) update-check --from 0.2.99 --level$/level \1/p' \
        -e 's/^run .* \([^ ]*\) update-check --from 0.2.99$/notes \1/p' \
        -e 's/^compose .* exec -T -e TERM -e NO_COLOR eigen-api \/app\/docker\/api\/entrypoint.sh \(backup .*\)$/\1/p' \
        -e 's/^run .* \([^ ]*\) bootstrap --force --out \/install$/bootstrap \1/p' \
        -e 's/^run .* \([^ ]*\) configure --backfill$/configure \1/p' | tr '\n' '|'
}

# A restore's stub swap writes the pins of its archive into .env.production; this puts the fixture's back.
reset_release() { printf 'DOMAIN=eigen.example.com\nEIGEN_VERSION=0.2.99\n' >"$FIX/release/.env.production"; }

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
    for command in status backup restore logs update rollback restart stop; do
        launch bare "$command" --help
        case "$CODE $(printf '%s\n' "$OUT" | head -n 1)" in
            "0 Usage: ./eigen $command"*) ;;
            *) failed="$failed $command" ;;
        esac
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: status, backup, restore, logs, update, rollback, restart and stop --help print their usage"
    else
        fail "$SHELL_NAME: no usage from --help of:$failed"
    fi
    failed=''
    for command in setup reset-password; do
        launch local "$command" --help
        cli=$command
        if [ "$command" = setup ]; then cli=configure; fi
        case $OUT in "stub run: "*" $cli --help") ;; *) failed="$failed $command" ;; esac
    done
    if [ -z "$failed" ] && [ "$CODE" = 0 ]; then
        ok "$SHELL_NAME: setup and reset-password --help ask the CLI for its usage"
    else
        fail "$SHELL_NAME: --help did not reach the CLI for:$failed"
    fi

    launch bare frobnicate
    expect_error 2 'Unknown command "frobnicate"' "an unknown command is refused with the usage on stderr"
    failed=''
    for args in 'status extra' 'backup extra' 'backup --light --keep' 'restore a b' 'restore a --bogus' 'restart extra' \
        'stop extra' 'logs a b' 'update --bogus' 'update 1 2' 'rollback --nope'; do
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
    STUB_INFO='27.3.1 aarch64 Debian GNU/Linux 12 (bookworm)' launch local restart
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
    if shared release && ! printf '%s\n' "$CALLS" | grep -q ' stop eigen-api$'; then
        ok "$SHELL_NAME: restart gives .env.production group 1000 and mode 0640, as root in a container, right before the start, and stops nothing"
    else
        fail "$SHELL_NAME: restart does not share .env.production before the start: calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    STUB_INFO='27.5.1 aarch64 Docker Desktop' launch release restart
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q '◇  Docker 27.5.1 on aarch64, Compose 2.29.1' &&
        printf '%s\n' "$CALLS" | grep -q ' up -d --wait$' && ! printf '%s\n' "$CALLS" | grep -qF -- "$SHARE"; then
        ok "$SHELL_NAME: on Docker Desktop, where uid 1000 reads the file already, restart leaves .env.production alone"
    else
        fail "$SHELL_NAME: restart on Docker Desktop: exit $CODE, '$OUT', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    if [ "$(id -u)" = 0 ]; then
        skip "$SHELL_NAME: root writes a .env.production of mode 0440"
    elif [ "$SHELL_NAME" = dash ] && [ "$HOST_OS" = 'Docker Desktop' ]; then
        # Its file sharing answers glibc's access() for a 0440 file with writable; the write itself fails.
        skip "$SHELL_NAME: Docker Desktop tells dash that a .env.production of mode 0440 is writable"
    else
        chmod 0440 "$FIX/release/.env.production"
        launch release restart
        chmod 0644 "$FIX/release/.env.production"
        expect_error 1 '■  .env.production is not writable by this user.' "a .env.production this user reads but cannot write"
    fi
    STUB_IMAGE=1 launch local reset-password --help
    expect_error 1 '■  Eigen is not built yet.' "reset-password --help in an unbuilt local build"
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
    STUB_IMAGE=1 launch release reset-password --help
    case "$CODE $OUT" in
        "0 stub run: "*" -v $FIX/release:/install -w /install ghcr.io/eigen-is/eigen/api:local reset-password --help")
            ok "$SHELL_NAME: a release folder runs the CLI without looking for a build" ;;
        *) fail "$SHELL_NAME: reset-password --help in a release folder: exit $CODE, '$OUT'" ;;
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
    if shared channel; then
        ok "$SHELL_NAME: setup gives the .env.production configure wrote group 1000 and mode 0640 before it starts Eigen"
    else
        fail "$SHELL_NAME: setup does not share .env.production before the start: calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    if [ "$(cat "$FIX/channel/.eigen/bundle" 2>&1)" = ghcr.io/eigen-is/eigen/api@sha256:aaa ]; then
        ok "$SHELL_NAME: setup records the build its files are of, for a swap cut off before any update"
    else
        fail "$SHELL_NAME: setup's .eigen/bundle: '$(cat "$FIX/channel/.eigen/bundle" 2>&1)'"
    fi
    rm -f "$FIX/channel/.eigen/bundle"
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
    # The stop would kill a server backup that runs, and that night would have none.
    mkdir -p "$FIX/local/backups"
    record="$FIX/local/backups/server-scheduled-full-20260101-020000.tar.json"
    printf '{\n  "state": "running",\n  "startedAt": "2026-01-01T02:00:00.000Z"\n}\n' >"$record"
    (sleep 3; rm -f "$record") &
    launch local stop
    wait
    rm -r "$FIX/local/backups"
    if [ "$CODE" = 0 ] && [ "$(printf '%s\n' "$OUT" | grep -o -e 'The server backup ended' -e 'Eigen stopped' | tr '\n' '|')" = 'The server backup ended|Eigen stopped|' ]; then
        ok "$SHELL_NAME: stop waits for the server backup that runs to end"
    else
        fail "$SHELL_NAME: stop during a server backup: exit $CODE, '$OUT'"
    fi
    # The upload that follows a backup runs in the API too, and a stop cuts it off before the bucket has the archive.
    mkdir -p "$FIX/local/backups"
    printf '{\n  "state": "done",\n  "upload": {\n    "state": "running"\n  }\n}\n' >"$record"
    (sleep 3; rm -f "$record") &
    launch local stop
    wait
    rm -r "$FIX/local/backups"
    if [ "$CODE" = 0 ] && [ "$(printf '%s\n' "$OUT" | grep -o -e 'The server backup ended' -e 'Eigen stopped' | tr '\n' '|')" = 'The server backup ended|Eigen stopped|' ]; then
        ok "$SHELL_NAME: stop waits for the upload of a server backup to end"
    else
        fail "$SHELL_NAME: stop during the upload of a server backup: exit $CODE, '$OUT'"
    fi

    mkdir -p "$FIX/release/backups" "$FIX/release/.eigen" "$FIX/channel/.eigen"
    : >"$FIX/release/backups/server-manual-full-20260101-000000.tar"
    echo ghcr.io/eigen-is/eigen/api@sha256:bbb >"$FIX/release/.eigen/bundle"
    STUB_LATEST=0.2.99 STUB_LABEL_VERSION=0.2.100 launch release status
    rm -r "$FIX/release/backups" "$FIX/release/.eigen/bundle"
    # --services spans lines of the call log.
    if printf '%s\n' "$CALLS" | grep -q " status --install=$FIX/release --services=" &&
        printf '%s\n' "$CALLS" | grep -q ' --backups=server-manual-full-20260101-000000.tar ' &&
        printf '%s\n' "$CALLS" | grep -q ' --latest=0.2.99 --files=0.2.100 (abc1234)$'; then
        ok "$SHELL_NAME: status passes the folder, what backups/ holds, and the build the files were written from"
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

    # The update as the operator types it: the new version's CLI names the level, the running API makes the backup,
    # and only then are the new files written and the new launcher takes over, with the archive.
    mkdir -p "$FIX/release/data"
    STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update
    sequence=$(update_steps)
    if [ "$CODE" = 0 ] && [ "$sequence" = 'notes ghcr.io/eigen-is/eigen/api:0.3.1|level ghcr.io/eigen-is/eigen/api:0.3.1|backup --level light --reason pre-update --wait|bootstrap ghcr.io/eigen-is/eigen/api@sha256:ddd|configure ghcr.io/eigen-is/eigen/api@sha256:ddd|stop|configure ghcr.io/eigen-is/eigen/api@sha256:ddd|up|' ] &&
        [ "$(cat "$FIX/release/.eigen/last-update")" = server-pre-update-light-20260101-000000.tar ] &&
        printf '%s\n' "$ERR" | grep -qx STUB_LAUNCHER &&
        printf '%s\n' "$OUT" | grep -q '│  Saved before the update: backups/server-pre-update-light-20260101-000000.tar$' &&
        printf '%s\n' "$OUT" | grep -q '└  ./eigen rollback goes back to Eigen 0.2.99 (abc1234).'; then
        ok "$SHELL_NAME: update backs up on the running API at the level the new CLI names, before it writes a file, and the new launcher records the archive for a rollback"
    else
        fail "$SHELL_NAME: update: exit $CODE, sequence '$sequence', '$OUT', '$ERR'"
    fi
    STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update --full
    if [ "$CODE" = 0 ] && printf '%s\n' "$CALLS" | grep -q ' backup --level full --reason pre-update --wait$' &&
        ! printf '%s\n' "$CALLS" | grep -q ' --level$'; then
        ok "$SHELL_NAME: update --full makes a full backup without asking the level"
    else
        fail "$SHELL_NAME: update --full: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    rm "$FIX/release/.eigen/last-update" "$FIX/release/.eigen/bundle"
    failed=''
    for stub in STUB_RUNNING=0 STUB_EXEC=1 STUB_ARCHIVE=; do
        case $stub in
            STUB_RUNNING=0) STUB_RUNNING=0 STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update ;;
            STUB_EXEC=1) STUB_EXEC=1 STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update ;;
            *) STUB_ARCHIVE='' STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update ;;
        esac
        if [ "$CODE" != 1 ] || printf '%s\n' "$CALLS" | grep -Eq ' bootstrap | stop$| up -d' ||
            [ -e "$FIX/release/.eigen/last-update" ]; then
            failed="$failed $stub ($CODE)"
        fi
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: update with Eigen stopped, a failed backup or one that names no archive ends with Eigen running and no new file"
    else
        fail "$SHELL_NAME: update went on without a backup:$failed"
    fi
    STUB_RUNNING=0 STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update
    if printf '%s\n' "$ERR" | grep -q 'copy data/ and .env.production somewhere safe, then run ./eigen update --no-backup.$'; then
        ok "$SHELL_NAME: update with Eigen stopped says how to update without the backup"
    else
        fail "$SHELL_NAME: update with Eigen stopped names no way on: '$ERR'"
    fi
    # eigen-api mounts .env.production by inode, here a hard link: a file written anew beside it is not what it reads.
    ln "$FIX/release/.env.production" "$FIX/mounted.env"
    { cat "$FIX/release/.env.production"; echo '# edited'; } >"$FIX/release/.env.new"
    mv "$FIX/release/.env.new" "$FIX/release/.env.production"
    STUB_MOUNTED=$FIX/mounted.env STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update
    if [ "$CODE" = 1 ] &&
        printf '%s\n' "$ERR" | grep -q '■  .env.production was replaced since Eigen started, and Eigen still reads the old one.' &&
        printf '%s\n' "$ERR" | grep -q '└  Run ./eigen restart, then ./eigen update again.' &&
        ! printf '%s\n' "$CALLS" | grep -Eq ' backup | bootstrap | stop$| up -d' && [ ! -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: update refuses before its backup while eigen-api reads a .env.production replaced since it started"
    else
        fail "$SHELL_NAME: update with a replaced .env.production: exit $CODE, '$ERR', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    STUB_MOUNTED=$FIX/mounted.env launch release backup
    if [ "$CODE" = 1 ] &&
        printf '%s\n' "$ERR" | grep -q '■  .env.production was replaced since Eigen started, and Eigen still reads the old one.' &&
        printf '%s\n' "$ERR" | grep -q '└  Run ./eigen restart, then ./eigen backup again.' &&
        ! printf '%s\n' "$CALLS" | grep -q ' backup '; then
        ok "$SHELL_NAME: backup refuses while eigen-api reads a .env.production replaced since it started"
    else
        fail "$SHELL_NAME: backup with a replaced .env.production: exit $CODE, '$ERR', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    # Only a start of eigen-api mounts the file anew, and an up starts a running one only when a value changed.
    STUB_MOUNTED=$FIX/mounted.env launch release restart
    if [ "$CODE" = 0 ] &&
        [ "$(printf '%s\n' "$CALLS" | sed -n -e 's/^compose .* \(stop eigen-api\)$/\1/p' -e 's/^compose .* \(up -d --wait\)$/\1/p' |
            tr '\n' '|')" = 'stop eigen-api|up -d --wait|' ]; then
        ok "$SHELL_NAME: restart stops eigen-api before the start while it reads a .env.production replaced since it started"
    else
        fail "$SHELL_NAME: restart with a replaced .env.production: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    rm "$FIX/mounted.env"
    reset_release
    STUB_FAIL=compose-exec STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Could not ask eigen-api which .env.production it reads.' &&
        ! printf '%s\n' "$CALLS" | grep -Eq ' bootstrap | stop$| up -d'; then
        ok "$SHELL_NAME: update says so when eigen-api cannot be asked which .env.production it reads"
    else
        fail "$SHELL_NAME: update with a failed exec: exit $CODE, '$ERR', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    echo server-pre-update-light-20250101-000000.tar >"$FIX/release/.eigen/last-update"
    STUB_RUNNING=0 STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update --no-backup
    sequence=$(update_steps)
    if [ "$CODE" = 0 ] && [ "$sequence" = 'notes ghcr.io/eigen-is/eigen/api:0.3.1|bootstrap ghcr.io/eigen-is/eigen/api@sha256:ddd|configure ghcr.io/eigen-is/eigen/api@sha256:ddd|stop|configure ghcr.io/eigen-is/eigen/api@sha256:ddd|up|' ] &&
        [ ! -e "$FIX/release/.eigen/last-update" ] &&
        printf '%s\n' "$OUT" | grep -q '└  No backup was made before the update, so ./eigen rollback has nothing to go back to.$'; then
        ok "$SHELL_NAME: update --no-backup with Eigen stopped makes no backup, and leaves no way back to an older update"
    else
        fail "$SHELL_NAME: update --no-backup: exit $CODE, sequence '$sequence', '$OUT', '$ERR'"
    fi
    rm -f "$FIX/release/.eigen/last-update" "$FIX/release/.eigen/bundle"
    # A terminal on stdin: Docker's pty ends the level the new CLI prints in \r\n, unless the CLI runs without one.
    if [ "$SHELL_NAME" = host ]; then
        skip "$SHELL_NAME: update typed on a terminal, which only the container shells get"
    else
        LAUNCH_TTY=1 STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update
        if [ "$CODE" = 0 ] && printf '%s\n' "$CALLS" | grep -q ' backup --level light --reason pre-update --wait$' &&
            printf '%s\n' "$CALLS" | grep ' update-check --from 0.2.99 --level$' | grep -vq ' -t '; then
            ok "$SHELL_NAME: update typed on a terminal asks the level without one, and backs up at that level"
        else
            fail "$SHELL_NAME: update on a terminal: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n\r' '|^')"
        fi
        rm -f "$FIX/release/.eigen/last-update" "$FIX/release/.eigen/bundle"
    fi
    # The archive becomes the way back once the switch is written: a switch that failed leaves the build as it was.
    STUB_RUN_FAIL=EIGEN_VERSION STUB_DIGEST=ddd launch release update --pulled 0.2.99 --saved server-pre-update-full-20260101-000000.tar
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Could not write Eigen .* into .env.production' &&
        [ ! -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: a handover whose switch fails records no backup for a rollback"
    else
        fail "$SHELL_NAME: a failed switch: exit $CODE, '$ERR', last-update '$(cat "$FIX/release/.eigen/last-update" 2>&1)'"
    fi
    # A launcher older than 0.3.1 hands over with neither the backup nor --no-backup.
    STUB_DIGEST=ddd launch release update --pulled 0.2.99
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  This update was started by a launcher older than 0.3.1.' &&
        printf '%s\n' "$ERR" | grep -q '└  Copy data/ and .env.production somewhere safe, then run ./eigen update 0.3.1 --no-backup, then ./eigen update.' &&
        ! printf '%s\n' "$CALLS" | grep -Eq ' configure | stop$| up -d' && [ ! -e "$FIX/release/.eigen/lock" ]; then
        ok "$SHELL_NAME: a handover with neither a backup nor --no-backup is refused before it changes anything"
    else
        fail "$SHELL_NAME: a handover from an older launcher: exit $CODE, '$ERR', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    STUB_DIGEST=ddd launch release update --pulled 0.2.99 --saved server-pre-update-full-20260101-000000.tar
    rm -r "$FIX/release/data"
    if [ "$CODE" = 0 ] && [ "$(cat "$FIX/release/.eigen/last-update")" = server-pre-update-full-20260101-000000.tar ]; then
        ok "$SHELL_NAME: a handover with the backup's archive records it"
    else
        fail "$SHELL_NAME: update --pulled --saved: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    rm "$FIX/release/.eigen/last-update"
    # The stop is armed only after the wait for a running server backup, so an interrupt there leaves Eigen running.
    mkdir -p "$FIX/release/data" "$FIX/release/backups"
    printf '{\n  "state": "running",\n  "startedAt": "2026-01-01T02:00:00.000Z"\n}\n' \
        >"$FIX/release/backups/server-scheduled-full-20260101-020000.tar.json"
    LAUNCH_TERM='ps --status running --services' STUB_DIGEST=ddd \
        launch release update --pulled 0.2.99 --saved server-pre-update-full-20260101-000000.tar
    rm -r "$FIX/release/data" "$FIX/release/backups"
    if [ "$CODE" = 130 ] && ! printf '%s\n' "$CALLS" | grep -Eq ' (stop|up -d --wait)$| configure --backfill$' &&
        [ ! -e "$FIX/release/.eigen/lock" ] && [ ! -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: an interrupt while an update waits for a running server backup neither stops nor restarts Eigen, nor writes .env.production"
    else
        fail "$SHELL_NAME: an update interrupted in the backup wait: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    STUB_FAIL=compose-config launch local restart
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Eigen did not start' &&
        printf '%s\n' "$CALLS" | grep -q ' config --services$' &&
        ! printf '%s\n' "$CALLS" | grep -Eq '^(rm|stop) | (up|stop) '; then
        ok "$SHELL_NAME: a failing compose config removes, stops and starts nothing"
    else
        fail "$SHELL_NAME: failing compose config: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi

    # A restore: the stage as the API's user beside the running API, then the swap as root with Eigen stopped.
    mkdir -p "$FIX/elsewhere" "$FIX/release/backups"
    : >"$FIX/elsewhere/$ARCHIVE"
    : >"$FIX/release/backups/$ARCHIVE"
    echo server-pre-update-light-20260101-000000.tar >"$FIX/local/.eigen/last-update"
    # With data/ gone, which Docker would make root's for the stage's bind mount.
    rm -rf "$FIX/local/data"
    launch local restore "$ARCHIVE" --yes
    if [ "$CODE" = 0 ] && [ "$(steps)" = "share|stage eigen-api restore $ARCHIVE --stage --yes|restore --staged (ghcr.io/eigen-is/eigen/api:local)|stop|restore --swap (ghcr.io/eigen-is/eigen/api:local)|configure ghcr.io/eigen-is/eigen/api:local|share|up|" ] &&
        [ ! -e "$FIX/local/.eigen/lock" ] && [ ! -e "$FIX/local/.eigen/last-update" ] && [ -d "$FIX/local/data" ] &&
        printf '%s\n' "$OUT" | grep -q 'Data folders ready'; then
        ok "$SHELL_NAME: a restore prepares the data/ that is gone, stages while Eigen runs, then stops it, swaps as root, adds what is new to a local build's .env.production, forgets the last update's backup and starts Eigen"
    else
        fail "$SHELL_NAME: a local build's restore: exit $CODE, steps '$(steps)', '$ERR'"
    fi
    if shared local; then
        ok "$SHELL_NAME: a restore gives .env.production group 1000 and mode 0640 before the stage and before it starts Eigen"
    else
        fail "$SHELL_NAME: a restore does not share .env.production before the start: calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    # The stop would kill a server backup that runs, so it waits for its record to end.
    mkdir -p "$FIX/local/backups"
    record="$FIX/local/backups/server-scheduled-full-20260101-020000.tar.json"
    printf '{\n  "state": "running",\n  "startedAt": "2026-01-01T02:00:00.000Z"\n}\n' >"$record"
    (sleep 3; rm -f "$record") &
    launch local restore "$ARCHIVE" --yes
    wait
    rm -r "$FIX/local/backups"
    if [ "$CODE" = 0 ] && [ "$(printf '%s\n' "$OUT" | grep -o -e 'The server backup ended' -e 'Eigen stopped' | tr '\n' '|')" = 'The server backup ended|Eigen stopped|' ] &&
        printf '%s\n' "$(steps)" | grep -q '|stop|restore --swap'; then
        ok "$SHELL_NAME: a restore waits for the server backup that runs to end before it stops Eigen"
    else
        fail "$SHELL_NAME: a restore during a server backup: exit $CODE, '$OUT', steps '$(steps)'"
    fi
    # A record whose end was never written, as on a full disk, stays running with no job behind it.
    mkdir -p "$FIX/local/backups"
    printf '{\n  "state": "running",\n  "startedAt": "2026-01-01T02:00:00.000Z"\n}\n' >"$record"
    touch -t 202601010200 "$record"
    launch local restore "$ARCHIVE" --yes
    rm -r "$FIX/local/backups"
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q 'looks stale' &&
        printf '%s\n' "$(steps)" | grep -q '|stop|restore --swap'; then
        ok "$SHELL_NAME: a restore goes on past a server backup record that stayed running for over a day"
    else
        fail "$SHELL_NAME: a restore past a stale server backup record: exit $CODE, '$OUT', steps '$(steps)'"
    fi
    STUB_FAIL=compose-run launch local restore "$ARCHIVE" --yes
    if [ "$CODE" = 1 ] && [ "$(steps)" = "share|stage eigen-api restore $ARCHIVE --stage --yes|rm data/.restoring|" ] &&
        [ ! -e "$FIX/local/.eigen/lock" ]; then
        ok "$SHELL_NAME: a refused stage stops nothing, and removes what it staged and the lock"
    else
        fail "$SHELL_NAME: a refused stage: exit $CODE, steps '$(steps)'"
    fi
    # As when data/.restoring is on another disk than data/: refused before the stop.
    STUB_RUN_FAIL=--staged launch local restore "$ARCHIVE" --yes
    if [ "$CODE" = 1 ] && [ "$(steps)" = "share|stage eigen-api restore $ARCHIVE --stage --yes|restore --staged (ghcr.io/eigen-is/eigen/api:local)|rm data/.restoring|" ] &&
        [ ! -e "$FIX/local/.eigen/lock" ]; then
        ok "$SHELL_NAME: a staged tree the swap cannot rename in is refused before the stop, and removed"
    else
        fail "$SHELL_NAME: a refused --staged: exit $CODE, steps '$(steps)'"
    fi
    STUB_STAGE=3 launch local restore "$ARCHIVE"
    if [ "$CODE" = 0 ] && [ "$(steps)" = "share|stage eigen-api restore $ARCHIVE --stage|" ]; then
        ok "$SHELL_NAME: a no to the stage's question exits 0 and stops nothing"
    else
        fail "$SHELL_NAME: a declined stage: exit $CODE, steps '$(steps)'"
    fi
    STUB_RUN_FAIL=--swap launch local restore "$ARCHIVE" --yes
    if [ "$CODE" = 1 ] &&
        [ "$(steps)" = "share|stage eigen-api restore $ARCHIVE --stage --yes|restore --staged (ghcr.io/eigen-is/eigen/api:local)|stop|restore --swap (ghcr.io/eigen-is/eigen/api:local)|share|up|rm data/.restoring|" ] &&
        [ ! -e "$FIX/local/.eigen/lock" ]; then
        ok "$SHELL_NAME: a swap refused before its marker starts Eigen again, then removes the staged tree and the lock"
    else
        fail "$SHELL_NAME: a refused swap: exit $CODE, steps '$(steps)'"
    fi
    if [ "$(printf '%s\n' "$CALLS" | grep -c ' config$')" = 1 ]; then
        ok "$SHELL_NAME: one compose config names the project for the stop and the start"
    else
        fail "$SHELL_NAME: the project was asked $(printf '%s\n' "$CALLS" | grep -c ' config$') times"
    fi
    STUB_RUN_FAIL=--swap STUB_FAIL=compose-up launch local restore "$ARCHIVE" --yes
    if [ "$CODE" = 1 ] && printf '%s\n' "$(steps)" | grep -q '|up|rm data/.restoring|$'; then
        ok "$SHELL_NAME: a refused swap whose start fails still removes the staged tree"
    else
        fail "$SHELL_NAME: a refused swap that cannot start: exit $CODE, steps '$(steps)'"
    fi
    # The TERM only reaches the launcher, which waits the swap out; the start after it must still end.
    LAUNCH_TERM='restore --swap' STUB_SWAP_SLOW=1 launch local restore "$ARCHIVE" --yes
    if [ "$CODE" = 0 ] && printf '%s\n' "$(steps)" | grep -q '|restore --swap (ghcr.io/eigen-is/eigen/api:local)|configure ghcr.io/eigen-is/eigen/api:local|share|up|$'; then
        ok "$SHELL_NAME: a TERM during the swap lets it finish, and Eigen starts"
    else
        fail "$SHELL_NAME: a TERM during the swap: exit $CODE, steps '$(steps)'"
    fi
    STUB_RUN_FAIL=--backfill launch local restore "$ARCHIVE" --yes
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q 'The data is restored. Fix what it says, then run ./eigen setup.' &&
        printf '%s\n' "$(steps)" | grep -q '|configure ghcr.io/eigen-is/eigen/api:local|share|up|$'; then
        ok "$SHELL_NAME: a restore that fails after its swap starts Eigen and does not send the operator to restore again"
    else
        fail "$SHELL_NAME: a failure after the swap: exit $CODE, steps '$(steps)', '$ERR'"
    fi
    STUB_SWAP_CUT=1 launch local restore "$ARCHIVE" --yes
    if [ "$CODE" = 1 ] && [ "$(steps)" = "share|stage eigen-api restore $ARCHIVE --stage --yes|restore --staged (ghcr.io/eigen-is/eigen/api:local)|stop|restore --swap (ghcr.io/eigen-is/eigen/api:local)|" ] &&
        [ -e "$FIX/local/.eigen/restore-swap" ] && [ ! -e "$FIX/local/.eigen/lock" ] &&
        printf '%s\n' "$ERR" | grep -q '■  The swap is unfinished and Eigen is stopped: ./eigen restart finishes it.'; then
        ok "$SHELL_NAME: a swap cut off after its marker leaves Eigen stopped, the marker in place, and says ./eigen restart finishes it"
    else
        fail "$SHELL_NAME: a swap cut off: exit $CODE, steps '$(steps)', '$ERR'"
    fi
    # Cut off after its first rename, the swap had set data/ aside before the command that finishes it.
    kept=data.pre-restore-20260101-000000
    mkdir "$FIX/local/$kept"
    STUB_SWAP_KEPT=$kept launch local restart
    rm -rf "${FIX:?}/local/$kept"
    if [ "$CODE" = 0 ] && [ "$(steps)" = 'restore --swap (ghcr.io/eigen-is/eigen/api:local)|configure ghcr.io/eigen-is/eigen/api:local|share|up|share|up|' ] &&
        [ ! -e "$FIX/local/.eigen/restore-swap" ] &&
        [ "$(printf '%s\n' "$OUT" | tail -n 2 | head -n 1)" = '└  Check that all is well, then delete what was kept aside.' ]; then
        ok "$SHELL_NAME: the next command finishes the swap first, starts Eigen, says to delete what the swap kept aside, then does what it does"
    else
        fail "$SHELL_NAME: the next command after a swap cut off: exit $CODE, steps '$(steps)', '$OUT'"
    fi
    : >"$FIX/release/.eigen/restore-swap"
    echo ghcr.io/eigen-is/eigen/api@sha256:bbb >"$FIX/release/.eigen/bundle"
    launch release restart
    if [ "$CODE" = 0 ] && [ "$(steps)" = 'restore --swap (ghcr.io/eigen-is/eigen/api@sha256:bbb)|bootstrap ghcr.io/eigen-is/eigen/api:local|share|up|share|up|' ]; then
        ok "$SHELL_NAME: a release install finishes the swap with the build its files are of, then writes the files of the build it pins"
    else
        fail "$SHELL_NAME: a release install after a swap cut off: exit $CODE, steps '$(steps)'"
    fi
    rm "$FIX/release/.eigen/bundle"
    : >"$FIX/release/.eigen/restore-swap"
    STUB_RUN_FAIL=--swap launch release status
    rm "$FIX/release/.eigen/restore-swap"
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  The restore that was cut off cannot be finished' &&
        ! printf '%s\n' "$CALLS" | grep -q ' status '; then
        ok "$SHELL_NAME: a swap that cannot be finished stops every command before it does anything"
    else
        fail "$SHELL_NAME: a swap that cannot be finished: exit $CODE, '$ERR'"
    fi
    : >"$FIX/release/.eigen/restore-swap"
    echo server-pre-update-light-20260101-000000.tar >"$FIX/release/.eigen/last-update"
    launch release status
    if [ "$CODE" = 0 ] && [ "$(steps)" = 'restore --swap (ghcr.io/eigen-is/eigen/api:local)|share|up|' ] &&
        printf '%s\n' "$OUT" | grep -q '◇  The restore that was cut off is finished' &&
        printf '%s\n' "$OUT" | grep -q '◇  Eigen is running' && [ ! -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: status finishes a swap that was cut off where it shows, forgets the last update's backup and starts Eigen"
    else
        fail "$SHELL_NAME: status after a swap cut off: exit $CODE, steps '$(steps)', '$OUT'"
    fi
    rm -f "$FIX/release/.eigen/last-update"
    : >"$FIX/release/.eigen/restore-swap"
    echo server-pre-update-light-20260101-000000.tar >"$FIX/release/.eigen/last-update"
    launch release rollback --yes
    rm -f "$FIX/release/.eigen/last-update"
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  There is no update to roll back.' &&
        [ "$(steps)" = 'restore --swap (ghcr.io/eigen-is/eigen/api:local)|share|up|' ]; then
        ok "$SHELL_NAME: rollback finishes a swap that was cut off first, and then has no update to roll back"
    else
        fail "$SHELL_NAME: rollback after a swap cut off: exit $CODE, steps '$(steps)', '$ERR'"
    fi
    # An aside there before the command, which the swap does not name, is not one it kept: finish_swap leaves it out.
    : >"$FIX/release/.eigen/restore-swap"
    mkdir "$FIX/release/$kept"
    STUB_FAIL=compose-up launch release stop
    rm -rf "${FIX:?}/release/$kept"
    if [ "$CODE" = 0 ] && [ "$(steps)" = 'restore --swap (ghcr.io/eigen-is/eigen/api:local)|stop|' ] &&
        [ ! -e "$FIX/release/.eigen/restore-swap" ] &&
        [ "$(printf '%s\n' "$OUT" | tail -n 2 | head -n 1)" = '└  Check that all is well.' ]; then
        ok "$SHELL_NAME: stop finishes a swap that was cut off without starting Eigen, says it kept nothing aside, then stops it"
    else
        fail "$SHELL_NAME: stop after a swap cut off: exit $CODE, steps '$(steps)', '$OUT', '$ERR'"
    fi
    # Cut off between its two renames of .env.production, a swap leaves none: still an install, whose swap goes on.
    rm "$FIX/release/.env.production"
    : >"$FIX/release/.eigen/restore-swap"
    echo ghcr.io/eigen-is/eigen/api@sha256:bbb >"$FIX/release/.eigen/bundle"
    STUB_CHECKED=EIGEN_API_IMAGE=ghcr.io/eigen-is/eigen/api@sha256:bbb launch release restart
    rm "$FIX/release/.eigen/bundle"
    if [ "$CODE" = 0 ] && [ "$(steps)" = 'restore --swap (ghcr.io/eigen-is/eigen/api@sha256:bbb)|share|up|share|up|' ]; then
        ok "$SHELL_NAME: a swap cut off with no .env.production is finished, not sent to setup"
    else
        fail "$SHELL_NAME: a swap cut off with no .env.production: exit $CODE, steps '$(steps)', '$ERR'"
    fi
    reset_release

    STUB_CHECKED=EIGEN_API_IMAGE=ghcr.io/eigen-is/eigen/api:local launch release restore "$ARCHIVE" --yes
    if [ "$CODE" = 0 ] && [ "$(steps)" = "share|stage eigen-api restore $ARCHIVE --stage --yes|restore --staged (ghcr.io/eigen-is/eigen/api:local)|stop|restore --swap (ghcr.io/eigen-is/eigen/api:local)|share|up|" ]; then
        ok "$SHELL_NAME: a release restore of the images it runs leaves the archive's .env.production to its files"
    else
        fail "$SHELL_NAME: a release restore: exit $CODE, steps '$(steps)'"
    fi
    reset_release
    checked="EIGEN_VERSION=main"
    for name in $IMAGES; do
        checked="$checked
$(image_key "$name")=ghcr.io/eigen-is/eigen/$name@sha256:bbb"
    done
    STUB_IMAGE=1 STUB_CHECKED=$checked launch release restore "$ARCHIVE" --yes
    if [ "$CODE" = 0 ] && [ "$(printf '%s\n' "$CALLS" | grep -m 1 '^pull ')" = 'pull ghcr.io/eigen-is/eigen/api:local' ] &&
        printf '%s\n' "$(steps)" | grep -q 'pull ghcr.io/eigen-is/eigen/unbound@sha256:bbb|stop|restore --swap (ghcr.io/eigen-is/eigen/api:local)|bootstrap ghcr.io/eigen-is/eigen/api@sha256:bbb|share|up|$' &&
        [ "$(cat "$FIX/release/.eigen/bundle")" = ghcr.io/eigen-is/eigen/api@sha256:bbb ]; then
        ok "$SHELL_NAME: a release restore gets the api image it runs, pulls the images the archive pins while Eigen runs, then writes the files of its api image"
    else
        fail "$SHELL_NAME: a release restore to other images: exit $CODE, steps '$(steps)'"
    fi
    rm "$FIX/release/.eigen/bundle"
    reset_release
    STUB_CHECKED=EIGEN_API_IMAGE=ghcr.io/eigen-is/eigen/api@sha256:bbb launch release restore "$ARCHIVE" --yes
    expect_error 1 '■  The archive pins no frontend image.' "a release restore of an archive that pins some images"
    if printf '%s\n' "$CALLS" | grep -q ' stop$' || ! printf '%s\n' "$(steps)" | grep -q '|rm data/.restoring|$'; then
        fail "$SHELL_NAME: that refusal stopped Eigen, or left the staged tree: steps '$(steps)'"
    fi
    stages=''
    for path in "$FIX/elsewhere/$ARCHIVE" "$FIX/release/backups/$ARCHIVE"; do
        STUB_CHECKED=EIGEN_API_IMAGE=ghcr.io/eigen-is/eigen/api:local launch release restore "$path" --yes
        stages="$stages$(printf '%s\n' "$(steps)" | cut -d '|' -f 2)|"
    done
    if [ "$stages" = "stage -v $FIX/elsewhere/$ARCHIVE:/restore/$ARCHIVE:ro eigen-api restore /restore/$ARCHIVE --stage --yes|stage eigen-api restore $ARCHIVE --stage --yes|" ]; then
        ok "$SHELL_NAME: an archive elsewhere is mounted read-only into the stage, and one in backups/ goes by its name"
    else
        fail "$SHELL_NAME: the archive's path: '$stages'"
    fi
    reset_release
    launch release restore "$FIX/nowhere/$ARCHIVE"
    expect_error 1 "■  There is no archive $FIX/nowhere/$ARCHIVE." "a restore of a file that is not there"
    launch release restore --yes
    expect_error 1 '■  Name the archive to restore.' "a restore without an archive"

    # A new machine: the archive's .env.production pins the build that restores it, and that build's launcher does.
    alone
    STUB_IMAGE=1 launch alone restore "$FIX/elsewhere/$ARCHIVE" --yes
    pinned="$(for name in $IMAGES; do printf 'pull ghcr.io/eigen-is/eigen/%s@sha256:eee|' "$name"; done)"
    eee=ghcr.io/eigen-is/eigen/api@sha256:eee
    if [ "$CODE" = 0 ] && [ "$(steps)" = "pull ghcr.io/eigen-is/eigen/api:latest|restore /restore/$ARCHIVE --env (ghcr.io/eigen-is/eigen/api:latest)|${pinned}bootstrap $eee|share|stage -v $FIX/elsewhere/$ARCHIVE:/restore/$ARCHIVE:ro eigen-api restore /restore/$ARCHIVE --stage --yes|restore --staged ($eee)|stop|restore --swap ($eee)|share|up|" ] &&
        printf '%s\n' "$ERR" | grep -qx STUB_LAUNCHER && [ -e "$FIX/alone/data" ] && [ ! -e "$FIX/alone/.eigen/lock" ] &&
        [ "$(printf '%s\n' "$OUT" | tail -n 1)" = '└  Check that all is well.' ]; then
        ok "$SHELL_NAME: a restore beside the launcher alone takes .env.production from the archive, gets the build it pins, and hands over to its launcher, which restores and keeps nothing aside"
    else
        fail "$SHELL_NAME: a restore on a new machine: exit $CODE, steps '$(steps)', '$ERR'"
    fi
    alone
    STUB_RUN_FAIL=--env launch alone restore "$FIX/elsewhere/$ARCHIVE" --yes
    if [ "$CODE" = 1 ] && [ ! -e "$FIX/alone/.env.production" ] && ! printf '%s\n' "$CALLS" | grep -q ' bootstrap '; then
        ok "$SHELL_NAME: a new machine whose archive cannot be read is left as it was"
    else
        fail "$SHELL_NAME: a new machine with an unreadable archive: exit $CODE, steps '$(steps)'"
    fi
    # A mirror install names its registry in .env.production before anything else is there.
    alone
    echo EIGEN_REGISTRY=example.test/eigen >"$FIX/alone/.env.production"
    STUB_IMAGE=1 launch alone restore "$FIX/elsewhere/$ARCHIVE" --yes
    if [ "$CODE" = 0 ] && [ "$(printf '%s\n' "$CALLS" | grep -m 1 '^pull ')" = 'pull example.test/eigen/api:latest' ] &&
        printf '%s\n' "$(steps)" | grep -q "|restore --swap (ghcr.io/eigen-is/eigen/api@sha256:eee)|share|up|$" &&
        [ -z "$(ls -A "$FIX/alone/.eigen" | grep -vx -e bundle -e last-step.log || :)" ]; then
        ok "$SHELL_NAME: a restore beside the launcher and a .env.production that names a registry alone gets Eigen from it"
    else
        fail "$SHELL_NAME: a restore on a new machine with a registry: exit $CODE, steps '$(steps)', '$ERR'"
    fi
    alone
    echo EIGEN_REGISTRY=example.test/eigen >"$FIX/alone/.env.production"
    STUB_RUN_FAIL=--env launch alone restore "$FIX/elsewhere/$ARCHIVE" --yes
    if [ "$CODE" = 1 ] && [ "$(cat "$FIX/alone/.env.production")" = EIGEN_REGISTRY=example.test/eigen ]; then
        ok "$SHELL_NAME: that .env.production is left as it was when the archive cannot be read"
    else
        fail "$SHELL_NAME: a mirror's .env.production after a failed restore: exit $CODE, '$(cat "$FIX/alone/.env.production" 2>&1)'"
    fi
    mkdir -p "$FIX/with:colon"
    : >"$FIX/with:colon/$ARCHIVE"
    launch release restore "$FIX/with:colon/$ARCHIVE" --yes
    expect_error 1 "■  Docker cannot mount $FIX/with:colon/$ARCHIVE, whose path has a colon." "a restore of an archive whose path has a colon"
    if printf '%s\n' "$CALLS" | grep -Eq '^run | run '; then fail "$SHELL_NAME: that refusal ran something: $(steps)"; fi
    # The stage reads the archive as uid 1000, so a copy root left 0600 is refused before anything runs, on a new
    # machine too. As uid 1000 this user reads it.
    if [ "$(id -u)" != 1000 ]; then
        mkdir -p "$FIX/private"
        : >"$FIX/private/$ARCHIVE"
        chmod 600 "$FIX/private/$ARCHIVE" "$FIX/release/backups/$ARCHIVE"
        unread=''
        for where in "release $FIX/private/$ARCHIVE $FIX/private/$ARCHIVE" \
            "release $ARCHIVE backups/$ARCHIVE" "alone $FIX/private/$ARCHIVE $FIX/private/$ARCHIVE"; do
            read -r folder arg file <<<"$where"
            alone
            launch "$folder" restore "$arg" --yes
            if [ "$CODE" != 1 ] || ! printf '%s\n' "$ERR" | grep -q "sudo chown 1000:1000 $file" ||
                printf '%s\n' "$CALLS" | grep -Eq '^(run|pull) | run '; then
                unread="$unread $arg: exit $CODE, '$ERR', steps '$(steps)';"
            fi
        done
        chmod 644 "$FIX/release/backups/$ARCHIVE"
        if [ -z "$unread" ]; then
            ok "$SHELL_NAME: an archive uid 1000 cannot read is refused with the chown that fixes it, before anything runs"
        else
            fail "$SHELL_NAME: an archive uid 1000 cannot read:$unread"
        fi
    fi

    echo server-pre-update-light-20260101-000000.tar >"$FIX/release/.eigen/last-update"
    STUB_CHECKED=$checked launch release rollback --yes
    if [ "$CODE" = 1 ] &&
        printf '%s\n' "$ERR" | grep -q '■  The backup the last update made, backups/server-pre-update-light-20260101-000000.tar, is gone.' &&
        [ -z "$(steps)" ] && [ -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: rollback whose archive is gone says so before it stages anything"
    else
        fail "$SHELL_NAME: rollback without its archive: exit $CODE, steps '$(steps)', '$ERR'"
    fi
    : >"$FIX/release/backups/server-pre-update-light-20260101-000000.tar"
    STUB_CHECKED=$checked launch release rollback --yes
    rm "$FIX/release/backups/server-pre-update-light-20260101-000000.tar"
    if [ "$CODE" = 0 ] &&
        printf '%s\n' "$OUT" | grep -q '◆  Back from Eigen 0.2.99 (abc1234) to the backup the last update made' &&
        [ "$(steps)" = 'share|stage eigen-api restore server-pre-update-light-20260101-000000.tar --stage --yes|restore --staged (ghcr.io/eigen-is/eigen/api:local)|stop|restore --swap (ghcr.io/eigen-is/eigen/api:local)|bootstrap ghcr.io/eigen-is/eigen/api@sha256:bbb|share|up|' ] &&
        [ ! -e "$FIX/release/.eigen/last-update" ] &&
        printf '%s\n' "$OUT" | grep -q '◇  Eigen 0.2.99 (abc1234) → 0.2.99 (abc1234) is running at https://eigen.example.com/'; then
        ok "$SHELL_NAME: rollback restores the archive .eigen/last-update names on the images it pins, and names the builds it leaves and reaches"
    else
        fail "$SHELL_NAME: a release rollback: exit $CODE, steps '$(steps)', '$OUT', '$ERR'"
    fi
    if shared release; then
        ok "$SHELL_NAME: rollback gives the .env.production it put back group 1000 and mode 0640 before it starts Eigen"
    else
        fail "$SHELL_NAME: rollback does not share .env.production before the start: calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    rm "$FIX/release/.eigen/bundle"
    reset_release

    # A backup runs on the running API and stops nothing.
    failed=''
    for flags in '--light|light' '|full' '--full|full' '--s3|full-s3' '--s3 --wait|full-s3 --wait'; do
        # shellcheck disable=SC2086
        launch local backup ${flags%|*}
        if [ "$CODE" != 0 ] || [ "$(printf '%s\n' "$CALLS" | grep ' exec .*/entrypoint.sh ' | sed 's/^.* exec //')" != "-T -e TERM -e NO_COLOR eigen-api /app/docker/api/entrypoint.sh backup --level ${flags#*|}" ] ||
            printf '%s\n' "$CALLS" | grep -Eq ' (stop|up)( |$)'; then
            failed="$failed '${flags%|*}' ($CODE)"
        fi
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: backup starts the level its flags name on the running API, and stops nothing"
    else
        fail "$SHELL_NAME: backup levels:$failed"
    fi
    launch bare backup --help
    if printf '%s\n' "$OUT" | grep -q 'Exits 0 once the archive verified, 1 when it failed, 2 on a wrong argument, and 4$'; then
        ok "$SHELL_NAME: backup --help names the exit codes of the CLI"
    else
        fail "$SHELL_NAME: backup --help: '$OUT'"
    fi
    launch local backup --light --s3
    expect_error 2 'A light backup holds no files, so it takes no --s3.' "backup --light --s3"
    STUB_EXEC=4 launch local backup
    if [ "$CODE" = 4 ]; then ok "$SHELL_NAME: backup exits with the code of the CLI"; else fail "$SHELL_NAME: backup exit $CODE, expected 4"; fi
    STUB_RUNNING=0 launch local backup
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Eigen is not running, and a backup runs on the running server.' &&
        printf '%s\n' "$ERR" | grep -q 'With Eigen stopped, a copy of data/ and .env.production is a backup too.' &&
        ! printf '%s\n' "$CALLS" | grep -q ' exec '; then
        ok "$SHELL_NAME: backup with Eigen stopped says a copy of the quiet data/ is a backup too"
    else
        fail "$SHELL_NAME: backup with Eigen stopped: exit $CODE, '$ERR'"
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
    launch local stop
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Another ./eigen command is running.' && printf '%s\n' "$ERR" |
        grep -q '└  Wait for it to end, then run ./eigen stop again. If none runs, remove .eigen/lock.$' &&
        [ -e "$FIX/local/.eigen/lock/pid" ]; then
        ok "$SHELL_NAME: a lock without a pid refuses a stop, says how to remove it, and stays"
    else
        fail "$SHELL_NAME: a lock without a pid: exit $CODE, '$ERR', lock $(ls "$FIX/local/.eigen/lock" 2>&1)"
    fi
    rm -rf "$FIX/local/.eigen/lock"
    # A container's own PID namespace cannot see this shell.
    if [ "$SHELL_NAME" = host ]; then
        mkdir "$FIX/local/.eigen/lock"
        echo $$ >"$FIX/local/.eigen/lock/pid"
        launch local stop
        expect_error 1 '■  Another ./eigen command is running.' "a running command's lock refuses a stop"
        rm -r "$FIX/local/.eigen/lock"
    fi
done

# The installer under this host's /bin/sh; the launcher it hands over to runs under all three above.
header "The installer"
INSTALLER="$REPO_ROOT/apps/index/public/install"
mkdir "$FIX/fresh" "$FIX/piped" "$FIX/taken" "$FIX/configured" "$FIX/mirror" "$FIX/empty" "$FIX/nodocker" "$FIX/page" \
    "$FIX/home"
: >"$FIX/taken/docker-compose.yml"
echo DOMAIN=eigen.example.com >"$FIX/configured/.env.production"
echo EIGEN_REGISTRY=example.test/eigen >"$FIX/mirror/.env.production"
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
mkdir "$FIX/restored"
: >"$FIX/calls.log"
CODE=0
OUT=$(cd "$FIX/restored" && env STUB_LOG="$FIX/calls.log" PATH="$FIX/bin:$PATH" /bin/sh -s -- restore \
    "$FIX/elsewhere/$ARCHIVE" --yes <"$INSTALLER" 2>"$FIX/stderr") || CODE=$?
ERR=$(cat "$FIX/stderr")
CALLS=$(cat "$FIX/calls.log")
if [ "$CODE" = 0 ] && sed 2d "$FIX/restored/eigen" | cmp -s "$REPO_ROOT/eigen" - &&
    [ "$(steps | cut -d '|' -f 1-2)" = "pull ghcr.io/eigen-is/eigen/api:latest|restore /restore/$ARCHIVE --env (ghcr.io/eigen-is/eigen/api:latest)" ] &&
    printf '%s\n' "$(steps)" | grep -q "|stage -v $FIX/elsewhere/$ARCHIVE:/restore/$ARCHIVE:ro eigen-api restore /restore/$ARCHIVE --stage --yes|" &&
    printf '%s\n' "$ERR" | grep -qx STUB_LAUNCHER; then
    ok "the installer with restore downloads the launcher and runs ./eigen restore, which sets Eigen up from the archive"
else
    fail "the installer with restore: exit $CODE, '$ERR', steps: $(steps)"
fi
run_installer taken
if [ "$CODE" = 1 ] &&
    [ "$ERR" = 'This folder already has an Eigen install. Run ./eigen setup to change it, or ./eigen update.' ] &&
    [ ! -e "$FIX/taken/eigen" ] && [ -z "$CALLS" ]; then
    ok "the installer refuses a folder with an install, before it downloads anything"
else
    fail "the installer in a folder with an install: exit $CODE, '$ERR'"
fi
: >"$FIX/calls.log"
CODE=0
OUT=$(cd "$FIX/configured" && env STUB_LOG="$FIX/calls.log" PATH="$FIX/bin:$PATH" /bin/sh "$INSTALLER" restore \
    "$FIX/elsewhere/$ARCHIVE" </dev/null 2>"$FIX/stderr") || CODE=$?
ERR=$(cat "$FIX/stderr")
if [ "$CODE" = 1 ] && [ "$ERR" = 'This folder already has an Eigen install. Run ./eigen restore <archive> in it.' ] &&
    [ ! -e "$FIX/configured/eigen" ] && [ ! -s "$FIX/calls.log" ]; then
    ok "the installer with restore in a folder whose .env.production names a domain says to run ./eigen restore there"
else
    fail "the installer with restore in a folder with an install: exit $CODE, '$ERR'"
fi
# A mirror's .env.production names its registry before the launcher is there.
: >"$FIX/calls.log"
CODE=0
OUT=$(cd "$FIX/mirror" && env STUB_LOG="$FIX/calls.log" PATH="$FIX/bin:$PATH" /bin/sh "$INSTALLER" restore \
    "$FIX/elsewhere/$ARCHIVE" --yes </dev/null 2>"$FIX/stderr") || CODE=$?
ERR=$(cat "$FIX/stderr")
CALLS=$(cat "$FIX/calls.log")
if [ "$CODE" = 0 ] && sed 2d "$FIX/mirror/eigen" | cmp -s "$REPO_ROOT/eigen" - &&
    [ "$(steps | cut -d '|' -f 1-2)" = "pull example.test/eigen/api:latest|restore /restore/$ARCHIVE --env (example.test/eigen/api:latest)" ] &&
    printf '%s\n' "$ERR" | grep -qx STUB_LAUNCHER; then
    ok "the installer with restore in a mirror's folder downloads the launcher and restores from the registry it names"
else
    fail "the installer with restore in a mirror's folder: exit $CODE, '$ERR', steps: $(steps)"
fi
HOME=$FIX/home run_installer home
if [ "$CODE" = 1 ] &&
    [ "$ERR" = "Eigen and its data get a folder of their own, not $FIX/home. Make one: mkdir -p /opt/eigen && cd /opt/eigen" ] &&
    [ ! -e "$FIX/home/eigen" ] && [ -z "$CALLS" ]; then
    ok "the installer refuses the home folder, before it downloads anything"
else
    fail "the installer in the home folder: exit $CODE, '$ERR'"
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
