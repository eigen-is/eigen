#!/usr/bin/env bash
# The launcher alone, without a stack: under dash (debian:bookworm-slim), BusyBox sh and this host's /bin/sh, with a
# stub docker on PATH that answers info and compose version and fails on demand. It covers:
#   - every command's help, unknown commands and arguments, the preflight refusals, need_install, and a lock
#     without a pid;
#   - local-build and release mode, with update and rollback refused in a local build, and a failing compose config;
#   - update: what it asks the CLI and how it names the builds, on a release and on the main channel; the tags it
#     refuses; a build whose images differ; a tag that moves during the update; a pinned api image that is not here;
#     the files an unfinished update left; the backup it makes on the running API before it writes anything, and
#     the handover, typed on a terminal too; --no-backup with Eigen stopped; a refusal while eigen-api reads a
#     .env.production replaced since it started, or cannot be asked; an interrupt in the backup wait, which stops and
#     restarts nothing;
#   - the restart notice: --in and its message, refused before anything runs when wrong; the notice after the pulls
#     and the countdown before the backup, or before the stop of a rollback or restore; a TERM, a hangup and a failed
#     backup each taking it back; a failed notice with and without a wait;
#   - backup on the running API, refused in the same .env.production cases, and restart stopping eigen-api first;
#   - stop, and a running server backup or its upload waited out before it;
#   - restore: the stage and the swap and what each failure leaves, an archive uid 1000 cannot read, a restore that
#     cannot write its files, a swap that was cut off and finished first (with no .env.production too), and a
#     restore on a new machine from the launcher alone;
#   - what rollback runs or prints;
#   - setup: what it downloads with and without pins and the build it records, and setup in a folder that holds the
#     launcher alone, with the registry or the build .env.production names;
#   - the group and mode every start gives .env.production and backups/ first, except on Docker Desktop, the line it
#     prints when other users share the install folder's group, and the mode of a step's log;
#   - what status passes the CLI about backups/, what restores kept aside, the files of an unfinished update, the
#     newest build of main, and its folder;
#   - the installer script apps/index/public/install on this host, as a file and on stdin, for setup and restore.
#
# Usage:  ./docker/test-launcher.sh
# Needs:  docker (pulls debian:bookworm-slim and busybox once).

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

FIX=$(mktemp -d "${TMPDIR:-/tmp}/eigentest-launcher.XXXXXX")
FIX=$(cd "$FIX" && pwd -P)
trap 'rm -rf "$FIX"' EXIT

# The stub logs every call to $STUB_LOG. STUB_INFO (version, architecture, operating system) and STUB_COMPOSE answer
# info and compose version, empty for a failure; STUB_FAIL names the compose subcommands and docker commands that fail,
# and the images whose pull fails; STUB_IMAGE=1 makes image inspect fail on an image the launch has not pulled;
# STUB_LATEST and STUB_REVISION are the version and commit the registry's manifest of any image names;
# STUB_LABEL_VERSION and STUB_LABEL_REVISION the labels of any local image, STUB_LABEL_REVISION_DOVECOT that of a
# dovecot image, and STUB_MOVED that of any image once api was pulled twice, as a tag that moves; STUB_DIGEST the
# registry digest of every local image; a docker run with STUB_RUN_FAIL among its arguments fails, with STUB_RUN_CODE or
# 1, one with --staged also prints STUB_CHECKED, one of restore --env writes a .env.production that pins sha256:eee, and
# one of restore --swap removes .eigen/restore-swap, or with STUB_SWAP_CUT=1 leaves one and fails, after 3 s with
# STUB_SWAP_SLOW=1; with STUB_SWAP_KEPT=<folder> it keeps that folder aside and says so, as the CLI does. A run of
# bootstrap writes a Compose file into this folder, the starter keys into .env.production when it names no release,
# keeping the registry it names, and a launcher that prints STUB_LAUNCHER on stderr. Compose ps names eigen-api as
# running unless STUB_RUNNING=0, compose run (the stage) exits STUB_STAGE, compose exec of backup prints
# archive=STUB_ARCHIVE and exits STUB_EXEC, one of restart-notice --in prints an at= and exits STUB_NOTICE, one of
# status --running prints the file STUB_JOBS names while it is there, or with STUB_ASK=fail fails as one that is not
# answering. With STUB_ASKS=<file> each ask takes that file's first line instead: fail fails, - names nothing and any
# other is printed, and once the file is empty it names nothing. An exec that checksums $EIGEN_ENV_FILE checksums
# STUB_MOUNTED, the file eigen-api mounts, or else .env.production. A run of restore --env refuses a folder with a
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
                    echo "archive=${STUB_ARCHIVE-server-pre-update-full-20260101-000000.tar}"
                    exit "${STUB_EXEC:-0}"
                    ;;
                esac
                case " $* " in *" restart-notice --in "*)
                    echo 'at=2026-01-01T00:10:00.000Z'
                    exit "${STUB_NOTICE:-0}"
                    ;;
                esac
                case " $* " in *" status --running "*)
                    case ${STUB_ASK:-} in
                        fail) echo '■  Eigen is not answering.' >&2; exit 1 ;;
                    esac
                    if [ -n "${STUB_ASKS:-}" ]; then
                        answer=$(head -n 1 "$STUB_ASKS")
                        sed 1d "$STUB_ASKS" >"$STUB_ASKS.next" && mv "$STUB_ASKS.next" "$STUB_ASKS"
                        case $answer in
                            fail) echo '■  Eigen is not answering.' >&2; exit 1 ;;
                            '' | -) ;;
                            *) printf '%s\n' "$answer" ;;
                        esac
                    elif [ -n "${STUB_JOBS:-}" ] && [ -f "$STUB_JOBS" ]; then cat "$STUB_JOBS"; fi
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
        case " $* " in *" ${STUB_RUN_FAIL:-none} "*) exit "${STUB_RUN_CODE:-1}" ;; esac
        case " $* " in *" --staged "*) printf '%s\n' "${STUB_CHECKED:-}" ;; esac
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
    pull)
        fails pull
        fails "$2"
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
# regroup <folder> <gid>: the fixture folder in that group, which only root may give it.
regroup() { docker run --rm -v "$FIX:$FIX" busybox chgrp "$2" "$FIX/$1"; }
# The fixture folders get a group only their owner is in, so no case depends on the host's gid, which may be a shared one.
FIX_GID=5151
for dir in local release channel bare; do regroup "$dir" "$FIX_GID"; done
PATH_IN=/stub:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# launch <folder> <args…>: the launcher under $SHELL_NAME in $FIX/<folder>; sets CODE, OUT (stdout), ERR (stderr) and
# CALLS (what docker was asked). STUB_* pass through as set here. LAUNCH_TTY=1 gives a container shell a terminal, which
# takes stderr into OUT. LAUNCH_TERM=<call> sends the launcher a TERM a second after docker is asked <call>, as Ctrl-C
# would: bash starts a background job with INT ignored, which a shell cannot trap, and the launcher traps both alike.
# LAUNCH_SIGNAL=HUP sends a hangup instead, as a lost SSH session would.
# Every launch runs as such a job, its stdin /dev/null as on CI, so one that has not ended 120 s after its start is
# killed, its container too, and exits 137, which fails the check and leaves the suite going. Without a terminal, the
# container's shell writes the launcher's stdout and stderr into $FIX itself: docker run can lose what a short-lived
# container printed, and a refusal check once saw exit 2 with its usage missing. What docker says itself joins ERR.
# LAUNCH_GROUP=<file> and LAUNCH_PASSWD=<file> are the /etc/group and /etc/passwd of a container shell; the host's own launch ignores them.
launch() {
    local dir="$FIX/$1" vars=("STUB_LOG=$FIX/calls.log") flags=() run name var pid deadline
    shift
    : >"$FIX/calls.log"
    for name in STUB_INFO STUB_COMPOSE STUB_FAIL STUB_IMAGE STUB_LATEST STUB_REVISION STUB_LABEL_VERSION \
        STUB_LABEL_REVISION STUB_LABEL_REVISION_DOVECOT STUB_MOVED STUB_DIGEST STUB_RUN_FAIL STUB_CHECKED STUB_RUN_CODE \
        STUB_SWAP_CUT STUB_SWAP_SLOW STUB_SWAP_KEPT STUB_RUNNING STUB_STAGE STUB_ARCHIVE STUB_EXEC STUB_NOTICE \
        STUB_MOUNTED STUB_ASK STUB_ASKS STUB_JOBS; do
        if [ -n "${!name+set}" ]; then vars+=("$name=${!name}"); fi
    done
    CODE=0
    : >"$FIX/out"
    : >"$FIX/err"
    if [ "$SHELL_NAME" = host ]; then
        run=(env "${vars[@]}" PATH="$FIX/bin:$PATH" /bin/sh ./eigen "$@")
    else
        for var in "${vars[@]}"; do flags+=(-e "$var"); done
        # A killed docker run leaves its container running.
        rm -f "$FIX/cid"
        flags+=(--cidfile "$FIX/cid")
        # As this user, or on a Linux host root's .eigen would refuse this script's own lock below.
        run=(docker run --rm --user "$(id -u):$(id -g)" -v "$FIX:$FIX" -v "$FIX/bin:/stub:ro" -w "$dir"
            -e PATH="$PATH_IN")
        if [ -n "${LAUNCH_GROUP:-}" ]; then run+=(-v "$LAUNCH_GROUP:/etc/group:ro"); fi
        if [ -n "${LAUNCH_PASSWD:-}" ]; then run+=(-v "$LAUNCH_PASSWD:/etc/passwd:ro"); fi
        # docker run passes the TERM on to the shell in the container, which exec makes the launcher's own.
        if [ "${LAUNCH_TTY:-0}" = 1 ]; then
            run+=(-t "${flags[@]}" "$IMAGE" "$SHELL_CMD" ./eigen "$@")
        else
            # shellcheck disable=SC2016
            run+=("${flags[@]}" "$IMAGE" "$SHELL_CMD" -c 'fix=$1; shift; exec "$0" ./eigen "$@" >"$fix/out" 2>"$fix/err"'
                "$SHELL_CMD" "$FIX" "$@")
        fi
    fi
    (cd "$dir" && exec "${run[@]}") >"$FIX/stdout" 2>"$FIX/stderr" &
    pid=$!
    deadline=$(($(date +%s) + 120))
    if [ -n "${LAUNCH_TERM:-}" ]; then
        while kill -0 "$pid" 2>/dev/null && ! grep -qF -- "$LAUNCH_TERM" "$FIX/calls.log" &&
            [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.2; done
        if grep -qF -- "$LAUNCH_TERM" "$FIX/calls.log"; then
            sleep 1
            kill -s "${LAUNCH_SIGNAL:-TERM}" "$pid" 2>/dev/null || :
        fi
    fi
    while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.2; done
    if kill -0 "$pid" 2>/dev/null; then
        kill -s KILL "$pid" 2>/dev/null || :
        if [ -s "$FIX/cid" ]; then docker kill "$(cat "$FIX/cid")" >/dev/null 2>&1 || :; fi
        echo 'launch: killed, 120 s after its start' >>"$FIX/stderr"
    fi
    wait "$pid" || CODE=$?
    OUT=$(cat "$FIX/out" "$FIX/stdout")
    ERR=$(cat "$FIX/err" "$FIX/stderr")
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

# The run that gives .env.production group 1000 and mode 0640, and backups/ the group after it with setgid and mode
# 2750, as root in a container, in the launcher's call log. The group is empty when other users share it.
SHARE='-c chgrp 1000 /install/.env.production && chmod 0640 /install/.env.production && if [ -n "$1" ] && [ "$(stat -c %u /install/backups 2>/dev/null)" = 1000 ]; then chgrp "$1" /install/backups && chmod 2750 /install/backups; fi sh'

# shared <folder>: the last launch started Eigen, and shared .env.production and backups/ of that folder right before
# every start.
shared() {
    printf '%s\n' "$CALLS" | awk -v share="run --rm --user 0 --entrypoint sh -v $FIX/$1:/install " -v script=" $SHARE " '
        / up -d --wait$/ { ups++; if (index(prev, share) == 1 && index(prev, script)) shared++ }
        { prev = $0 }
        END { exit !(ups > 0 && ups == shared) }'
}

ARCHIVE=server-manual-full-20260101-000000.tar

# steps: what of the last launch a restore, update or rollback turns on, in order, on one line: the stage (compose
# run), stop, up, pulls, the share of .env.production, and the CLI's restore, bootstrap, configure and rm runs with the
# image each ran in. The time of a rollback's second check reads as --since T.
steps() {
    printf '%s\n' "$CALLS" | sed -n -e 's/^compose .* run --rm --no-deps -T -e TERM -e NO_COLOR \(.*\)$/stage \1/p' \
        -e 's/^compose .* stop$/stop/p' -e 's/^compose .* up -d --wait$/up/p' -e 's/^\(pull .*\)$/\1/p' \
        -e 's|^run --rm --user 0 --entrypoint sh .* -c chgrp 1000 /install/\.env\.production .*|share|p' \
        -e 's/^run .* \([^ ]*\) restore \(.*\)$/restore \2 (\1)/p' \
        -e 's/^run .* \([^ ]*\) bootstrap --force --out \/install$/bootstrap \1/p' \
        -e 's/^run .* \([^ ]*\) configure --backfill$/configure \1/p' -e 's/^run .* rm -rf \(.*\)$/rm \1/p' |
        sed 's/ --since [0-9]* / --since T /' | tr '\n' '|'
}

# update_steps: what of the last launch an update from 0.2.99 turns on, in order, on one line: the notes the new CLI
# gives, the restart notices and the backup on the running API, the bootstrap and configure runs with the image each
# ran in, the stop and the start.
update_steps() {
    printf '%s\n' "$CALLS" | sed -n -e 's/^compose .* stop$/stop/p' -e 's/^compose .* up -d --wait$/up/p' \
        -e 's/^run .* \([^ ]*\) update-check --from 0.2.99$/notes \1/p' \
        -e 's/^compose .* exec -T -e TERM -e NO_COLOR eigen-api \/app\/docker\/api\/entrypoint.sh \(backup .*\)$/\1/p' \
        -e 's/^compose .* exec -T -e TERM -e NO_COLOR eigen-api \/app\/docker\/api\/entrypoint.sh \(restart-notice .*\)$/\1/p' \
        -e 's/^run .* \([^ ]*\) bootstrap --force --out \/install$/bootstrap \1/p' \
        -e 's/^run .* \([^ ]*\) configure --backfill$/configure \1/p' | tr '\n' '|'
}

# A restore's stub swap writes the pins of its archive into .env.production; this puts the fixture's back.
reset_release() { printf 'DOMAIN=eigen.example.com\nEIGEN_VERSION=0.2.99\n' >"$FIX/release/.env.production"; }

# What status --running prints while a server backup runs, and while its upload runs after it.
NIGHT=server-scheduled-full-20260101-020000.tar
BACKUP_RUNS="the server backup $NIGHT"
UPLOAD_RUNS="the upload of $NIGHT"

# launch_during_backup <what status --running prints> <args…>: launch in local/ while the API says that runs, until
# 3 s in.
launch_during_backup() {
    printf '%s\n' "$1" >"$FIX/jobs"
    shift
    (sleep 3; rm -f "$FIX/jobs") &
    STUB_JOBS=$FIX/jobs launch local "$@"
    wait
}

# launch_asked <answer…> -- <args…>: launch in local/ while status --running answers these in turn (STUB_ASKS).
launch_asked() {
    : >"$FIX/asks"
    while [ "$1" != -- ]; do
        printf '%s\n' "$1" >>"$FIX/asks"
        shift
    done
    shift
    STUB_ASKS=$FIX/asks launch local "$@"
    rm "$FIX/asks"
}

# asked: how often the last launch asked status --running.
asked() { printf '%s\n' "$CALLS" | grep -c ' status --running$' || :; }

# waited_for_backup: the last launch said what of a server backup it waited for, then that Eigen stopped.
waited_for_backup() {
    [ "$(printf '%s\n' "$OUT" | grep -o -e 'Waited for ' -e 'Eigen stopped' | tr '\n' '|')" = 'Waited for |Eigen stopped|' ]
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
    for command in update rollback restore; do
        launch bare "$command" --help
        if ! printf '%s\n' "$OUT" | grep -q '^  --in <time>  *Warn everyone first, then wait'; then failed="$failed $command"; fi
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: update, rollback and restore --help explain --in"
    else
        fail "$SHELL_NAME: no --in in the --help of:$failed"
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
    for args in 'status extra' 'backup extra' 'restore a b' 'restore a --bogus' 'restart extra' \
        'stop extra' 'logs a b' 'update --bogus' 'update --full' 'update 1 2' 'rollback --nope'; do
        # shellcheck disable=SC2086
        launch local $args
        if [ "$CODE" != 2 ] || [ -n "$OUT" ] || ! printf '%s\n' "$ERR" | grep -q "^Unknown argument \"${args##* }\"\.$" ||
            ! printf '%s\n' "$ERR" | grep -q '^Usage: ./eigen'; then
            failed="$failed '$args' (exit $CODE, stdout '$OUT', stderr '$ERR')"
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
    rm -f "$FIX/release/.eigen/last-step.log"
    launch release restart
    if [ "$(ls -l "$FIX/release/.eigen/last-step.log" | cut -c 1-10)" = '-rw-------' ]; then
        ok "$SHELL_NAME: the log of a step is the operator's alone"
    else
        fail "$SHELL_NAME: .eigen/last-step.log after a step: $(ls -l "$FIX/release/.eigen/last-step.log")"
    fi
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
        printf '%s\n' "$CALLS" | grep -q ' up -d --wait$' && ! printf '%s\n' "$CALLS" | grep -qF -- "$SHARE" &&
        ! printf '%s\n' "$OUT" | grep -q 'backups/ stays open'; then
        ok "$SHELL_NAME: on Docker Desktop, where uid 1000 reads the file already, restart leaves .env.production and backups/ alone"
    else
        fail "$SHELL_NAME: restart on Docker Desktop: exit $CODE, '$OUT', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    if [ "$HOST_OS" = 'Docker Desktop' ]; then
        skip "$SHELL_NAME: Docker Desktop keeps the host's group of a folder that root in a container gives another"
    else
        regroup release 4242
        launch release restart
        if [ "$CODE" = 0 ] && shared release && printf '%s\n' "$CALLS" | grep -qF -- "$SHARE 4242" &&
            ! printf '%s\n' "$OUT" | grep -q 'backups/ stays open'; then
            ok "$SHELL_NAME: restart gives backups/ the install folder's group, 4242, in the same root run"
        else
            fail "$SHELL_NAME: restart in group 4242: exit $CODE, '$OUT', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
        fi
        regroup release 100
        launch release restart
        if [ "$CODE" = 0 ] && shared release && printf '%s\n' "$CALLS" | grep -q -- "fi sh $" &&
            printf '%s\n' "$OUT" | grep -qF "▲  Other users of this host share this folder's group, 100, so backups/ stays open to them."; then
            ok "$SHELL_NAME: in a system group such as users, restart leaves backups/ as it is and says so"
        else
            fail "$SHELL_NAME: restart in group 100: exit $CODE, '$OUT', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
        fi
        if [ "$SHELL_NAME" != host ]; then
            printf 'root:x:0:\nteam:x:4242:someone\n' >"$FIX/group"
            regroup release 4242
            LAUNCH_GROUP=$FIX/group launch release restart
            if [ "$CODE" = 0 ] && shared release && printf '%s\n' "$CALLS" | grep -q -- "fi sh $" &&
                printf '%s\n' "$OUT" | grep -qF "▲  Other users of this host share this folder's group, 4242, so backups/ stays open to them."; then
                ok "$SHELL_NAME: in a group that lists another member, restart leaves backups/ as it is and says so"
            else
                fail "$SHELL_NAME: restart in group 4242 with a member: exit $CODE, '$OUT', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
            fi
            printf 'root:x:0:0::/root:/bin/sh\nother:x:2000:4242::/home/other:/bin/sh\n' >"$FIX/passwd"
            printf 'root:x:0:\nteam:x:4242:\n' >"$FIX/group"
            LAUNCH_GROUP=$FIX/group LAUNCH_PASSWD=$FIX/passwd launch release restart
            if [ "$CODE" = 0 ] && shared release && printf '%s\n' "$CALLS" | grep -q -- "fi sh $" &&
                printf '%s\n' "$OUT" | grep -qF "▲  Other users of this host share this folder's group, 4242, so backups/ stays open to them."; then
                ok "$SHELL_NAME: in a group another user has as primary group, restart leaves backups/ as it is and says so"
            else
                fail "$SHELL_NAME: restart in group 4242 with a primary user: exit $CODE, '$OUT', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
            fi
        fi
        # Two restarts in one command, the swap's and the command's own, say it once.
        regroup release 100
        mkdir "$FIX/release/.eigen" 2>/dev/null || :
        : >"$FIX/release/.eigen/restore-swap"
        launch release restart
        if [ "$(printf '%s\n' "$OUT" | grep -cF "so backups/ stays open to them")" = 1 ]; then
            ok "$SHELL_NAME: the shared-group warning prints once when restart runs twice"
        else
            fail "$SHELL_NAME: the shared-group warning twice: exit $CODE, '$OUT'"
        fi
        rm -f "$FIX/release/.eigen/restore-swap"
        regroup release "$FIX_GID"
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
    launch_during_backup "$BACKUP_RUNS" stop
    if [ "$CODE" = 0 ] && waited_for_backup && printf '%s\n' "$OUT" | grep -qF "Waited for $BACKUP_RUNS to end" &&
        [ "$(printf '%s\n' "$CALLS" | grep -c ' status --running$')" -gt 1 ]; then
        ok "$SHELL_NAME: stop asks the API again until the server backup that runs has ended, and names it"
    else
        fail "$SHELL_NAME: stop during a server backup: exit $CODE, '$OUT'"
    fi
    # The upload that follows a backup runs in the API too, and a stop cuts it off before the bucket has the archive.
    launch_during_backup "$UPLOAD_RUNS" stop
    if [ "$CODE" = 0 ] && waited_for_backup && printf '%s\n' "$OUT" | grep -qF "Waited for $UPLOAD_RUNS to end"; then
        ok "$SHELL_NAME: stop waits for the upload of a server backup to end"
    else
        fail "$SHELL_NAME: stop during the upload of a server backup: exit $CODE, '$OUT'"
    fi
    # With eigen-api stopped nothing runs a backup, so there is nobody to ask.
    STUB_RUNNING=0 launch_during_backup "$BACKUP_RUNS" stop
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q '◇  Eigen stopped' && ! printf '%s\n' "$OUT" | grep -q 'Waited' &&
        ! printf '%s\n' "$CALLS" | grep -q ' status --running$'; then
        ok "$SHELL_NAME: stop with eigen-api stopped asks nothing and waits for nothing"
    else
        fail "$SHELL_NAME: stop with eigen-api stopped: exit $CODE, '$OUT', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    # A stop is what an API that does not answer needs, so the launcher says so and does not wait.
    STUB_ASK=fail launch local stop
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q '▲  Eigen did not say whether a server backup runs' &&
        printf '%s\n' "$OUT" | grep -q '◇  Eigen stopped' && [ "$(asked)" = 2 ]; then
        ok "$SHELL_NAME: stop asks twice, then says so when the API does not answer whether a backup runs, and stops"
    else
        fail "$SHELL_NAME: stop with an API that does not answer: exit $CODE, '$OUT', asked $(asked) times"
    fi
    # One docker compose exec can fail on a busy host while the API and its backup run on.
    launch_asked fail - -- stop
    if [ "$CODE" = 0 ] && ! printf '%s\n' "$OUT" | grep -q 'did not say' && printf '%s\n' "$OUT" | grep -q '◇  Eigen stopped'; then
        ok "$SHELL_NAME: stop asks once more when the first ask fails"
    else
        fail "$SHELL_NAME: stop past one failed first ask: exit $CODE, '$OUT'"
    fi
    launch_asked "$BACKUP_RUNS" "$BACKUP_RUNS" fail "$BACKUP_RUNS" - -- stop
    if [ "$CODE" = 0 ] && waited_for_backup && ! printf '%s\n' "$OUT" | grep -q 'did not say' && [ "$(asked)" -ge 5 ]; then
        ok "$SHELL_NAME: stop waits on past one failed ask until the server backup has ended"
    else
        fail "$SHELL_NAME: stop past a failed ask in the wait: exit $CODE, '$OUT', asked $(asked) times"
    fi
    launch_asked "$BACKUP_RUNS" fail fail fail fail -- stop
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q '▲  Eigen did not say whether a server backup runs' &&
        printf '%s\n' "$ERR" | grep -q '■  Eigen stopped answering' && printf '%s\n' "$OUT" | grep -q '◇  Eigen stopped' &&
        [ "$(asked)" = 4 ]; then
        ok "$SHELL_NAME: stop gives up the wait after three failed asks in a row, says so, and stops"
    else
        fail "$SHELL_NAME: stop with an API that stops answering in the wait: exit $CODE, '$OUT', '$ERR', asked $(asked) times"
    fi
    # The upload starts as the backup ends, and the last line names what the stop waited for last. The wait sees the
    # change, and before_stop asks once more for what to wait for next.
    launch_asked "$BACKUP_RUNS" "$UPLOAD_RUNS" "$UPLOAD_RUNS" - -- stop
    if [ "$CODE" = 0 ] && [ "$(printf '%s\n' "$OUT" | grep 'Waited for ' | tail -n 1)" = "◇  Waited for $UPLOAD_RUNS to end" ]; then
        ok "$SHELL_NAME: stop names the upload it waited for after the server backup"
    else
        fail "$SHELL_NAME: stop during a backup and then its upload: exit $CODE, '$OUT'"
    fi

    mkdir -p "$FIX/release/backups" "$FIX/release/.eigen" "$FIX/channel/.eigen"
    : >"$FIX/release/backups/server-manual-full-20260101-000000.tar"
    echo ghcr.io/eigen-is/eigen/api@sha256:bbb >"$FIX/release/.eigen/bundle"
    mkdir "$FIX/release/data.pre-restore-20260101-000000"
    STUB_LATEST=0.2.99 STUB_LABEL_VERSION=0.2.100 launch release status
    rm -r "$FIX/release/backups" "$FIX/release/.eigen/bundle" "$FIX/release/data.pre-restore-20260101-000000"
    # --services spans lines of the call log.
    if printf '%s\n' "$CALLS" | grep -q " status --install=$FIX/release --services=" &&
        printf '%s\n' "$CALLS" | grep -q ' --backups=server-manual-full-20260101-000000.tar ' &&
        ! printf '%s\n' "$CALLS" | grep -q -e '--kept-aside' &&
        printf '%s\n' "$CALLS" | grep -q ' --latest=0.2.99 --files=0.2.100 (abc1234)$'; then
        ok "$SHELL_NAME: status passes the folder, what backups/ holds, and the build the files were written from, but not what restores kept aside while an update stopped halfway: that CLI may refuse the flag"
    else
        fail "$SHELL_NAME: status: calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    echo ghcr.io/eigen-is/eigen/api@sha256:aaa >"$FIX/channel/.eigen/bundle"
    launch channel status
    if [ "$CODE" = 0 ] && ! printf '%s\n' "$CALLS" | grep -q -e '--files' -e '--kept-aside'; then
        ok "$SHELL_NAME: status passes no files when they are of the api image .env.production pins, and nothing kept aside when there is none"
    else
        fail "$SHELL_NAME: status with the files of the pinned image: calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    mkdir "$FIX/channel/data.pre-restore-20260101-000000"
    launch channel status
    rm -r "$FIX/channel/.eigen/bundle" "$FIX/channel/data.pre-restore-20260101-000000"
    if [ "$CODE" = 0 ] && printf '%s\n' "$CALLS" | grep -q ' --kept-aside=data.pre-restore-20260101-000000$'; then
        ok "$SHELL_NAME: status passes what restores kept aside when the files are of the api image .env.production pins"
    else
        fail "$SHELL_NAME: status with a copy kept aside: calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
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

    # The update as the operator types it: the running API makes a Full backup, without asking the new CLI for a level,
    # and only then are the new files written and the new launcher takes over, with the archive. It records the pins
    # .env.production holds, which here are the version and the api image alone.
    mkdir -p "$FIX/release/data"
    echo EIGEN_API_IMAGE=ghcr.io/eigen-is/eigen/api:local >>"$FIX/release/.env.production"
    STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update
    sequence=$(update_steps)
    if [ "$CODE" = 0 ] && [ "$sequence" = 'notes ghcr.io/eigen-is/eigen/api:0.3.1|restart-notice --in 0 --reason update|backup --reason pre-update --wait|restart-notice --in 0 --reason update|bootstrap ghcr.io/eigen-is/eigen/api@sha256:ddd|configure ghcr.io/eigen-is/eigen/api@sha256:ddd|stop|configure ghcr.io/eigen-is/eigen/api@sha256:ddd|up|' ] &&
        [ "$(sed -n 1p "$FIX/release/.eigen/last-update")" = server-pre-update-full-20260101-000000.tar ] &&
        ! printf '%s\n' "$CALLS" | grep -q ' --level' &&
        grep -qx 'EIGEN_API_IMAGE=ghcr.io/eigen-is/eigen/api:local' "$FIX/release/.eigen/last-update" &&
        grep -qx 'EIGEN_VERSION=0.2.99' "$FIX/release/.eigen/last-update" &&
        ! grep -q '^EIGEN_FRONTEND_IMAGE=' "$FIX/release/.eigen/last-update" &&
        printf '%s\n' "$ERR" | grep -qx STUB_LAUNCHER &&
        printf '%s\n' "$OUT" | grep -q '│  Saved before the update: backups/server-pre-update-full-20260101-000000.tar$' &&
        printf '%s\n' "$OUT" | grep -q '└  ./eigen rollback goes back to Eigen 0.2.99 (abc1234).'; then
        ok "$SHELL_NAME: update tells the open tabs, makes a Full backup on the running API before it writes a file, tells them again, and the new launcher records the archive and the old pins for a rollback"
    else
        fail "$SHELL_NAME: update: exit $CODE, sequence '$sequence', '$OUT', '$ERR'"
    fi
    rm "$FIX/release/.eigen/last-update" "$FIX/release/.eigen/bundle"
    reset_release

    # --in: the notice goes out after every pull, the wait counts down in the launcher, and the backup follows it.
    STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update --in 1s 'Back in five'
    sequence=$(update_steps)
    if [ "$CODE" = 0 ] && [ "$sequence" = 'notes ghcr.io/eigen-is/eigen/api:0.3.1|restart-notice --in 1 --reason update --message Back in five|backup --reason pre-update --wait|restart-notice --in 0 --reason update --message Back in five|bootstrap ghcr.io/eigen-is/eigen/api@sha256:ddd|configure ghcr.io/eigen-is/eigen/api@sha256:ddd|stop|configure ghcr.io/eigen-is/eigen/api@sha256:ddd|up|' ] &&
        printf '%s\n' "$CALLS" | awk '/^pull /{ pulled = NR } / restart-notice --in 1 /{ told = NR } END { exit !(pulled && told > pulled) }' &&
        printf '%s\n' "$OUT" | grep -q '◆  Restarts in 1s, at 00:10:00 UTC. Ctrl+C cancels.$' &&
        printf '%s\n' "$OUT" | grep -q '│  Back in five$' && printf '%s\n' "$OUT" | grep -q '◇  Waited until 00:10:00 UTC$'; then
        ok "$SHELL_NAME: update --in tells the open tabs after every pull, with the message, counts down, then backs up"
    else
        fail "$SHELL_NAME: update --in: exit $CODE, sequence '$sequence', '$OUT', '$ERR'"
    fi
    rm -f "$FIX/release/.eigen/last-update" "$FIX/release/.eigen/bundle"
    # Ctrl+C or a lost SSH session in the wait takes the notice back, and nothing is backed up, stopped or written.
    failed=''
    for signal in TERM HUP; do
        LAUNCH_TERM='restart-notice --in 600' LAUNCH_SIGNAL=$signal STUB_LATEST=0.3.1 STUB_REVISION=def5678 \
            STUB_DIGEST=ddd launch release update --in 10m
        code=130
        if [ "$signal" = HUP ]; then code=129; fi
        if [ "$CODE" != "$code" ] || ! printf '%s\n' "$CALLS" | tail -n 1 | grep -q ' restart-notice --clear$' ||
            printf '%s\n' "$CALLS" | grep -Eq ' backup | bootstrap | stop$| up -d' || [ -e "$FIX/release/.eigen/lock" ] ||
            [ -e "$FIX/release/.eigen/bundle" ]; then
            failed="$failed $signal (exit $CODE, calls $(printf '%s' "$CALLS" | tr '\n' '|'))"
        fi
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: a TERM or a hangup in the --in wait takes the notice back and backs up, stops and writes nothing"
    else
        fail "$SHELL_NAME: an update cut off in its wait:$failed"
    fi
    LAUNCH_TERM='restart-notice --in 600' STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update --in 10m
    if printf '%s\n' "$ERR" | grep -q '■  The wait was cancelled. Eigen runs on as it was.$'; then
        ok "$SHELL_NAME: an update cut off in its wait says Eigen runs on"
    else
        fail "$SHELL_NAME: an update cut off in its wait: '$ERR'"
    fi
    # A failed backup after the notice takes it back too.
    STUB_EXEC=1 STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update
    if [ "$CODE" = 1 ] && [ "$(update_steps)" = 'notes ghcr.io/eigen-is/eigen/api:0.3.1|restart-notice --in 0 --reason update|backup --reason pre-update --wait|restart-notice --clear|' ]; then
        ok "$SHELL_NAME: a failed backup takes the notice back"
    else
        fail "$SHELL_NAME: a failed backup after the notice: exit $CODE, sequence '$(update_steps)'"
    fi
    # A notice with a wait that does not reach the tabs stops the update; one for now that does not is only named.
    STUB_NOTICE=1 STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update --in 1m
    told_code=$CODE told_err=$ERR told_calls=$CALLS
    STUB_NOTICE=1 STUB_LATEST=0.3.1 STUB_REVISION=def5678 STUB_DIGEST=ddd launch release update
    if [ "$told_code" = 1 ] && printf '%s\n' "$told_err" | grep -q '■  Could not tell the open tabs; Eigen runs on as it was$' &&
        ! printf '%s\n' "$told_calls" | grep -Eq ' backup | bootstrap ' && [ "$CODE" = 0 ] &&
        [ "$(printf '%s\n' "$OUT" | grep -c '▲  Could not tell the open tabs that Eigen restarts now.$')" = 2 ] &&
        printf '%s\n' "$CALLS" | grep -q ' backup --reason pre-update --wait$'; then
        ok "$SHELL_NAME: a notice with a wait that fails stops the update before the backup; a notice for now that fails does not"
    else
        fail "$SHELL_NAME: a failed notice: --in 1m exit $told_code, '$told_err'; without --in exit $CODE, '$OUT'"
    fi
    rm -f "$FIX/release/.eigen/last-update" "$FIX/release/.eigen/bundle"
    # A wrong --in or message is refused before anything runs.
    failed=''
    long=$(printf 'x%.0s' $(seq 201))
    for args in 'update --in 10' 'update --in 61m' 'update --in 2h' 'update --in 99999s' 'update --in 10x' \
        'update --in -5m' 'update --in' 'update --check --in 1m' "update --in 1m $long" 'rollback --in 10' \
        'restore a --in 5' 'update --in 10m 0.4.0' 'update --in 10m latest' 'update --in 10m main' \
        "restore --in 10m $ARCHIVE"; do
        # shellcheck disable=SC2086
        launch release $args
        if [ "$CODE" != 2 ] || [ -n "$OUT" ] || [ -n "$CALLS" ] || ! printf '%s\n' "$ERR" | grep -q '^Usage: ./eigen'; then
            failed="$failed '$args' (exit $CODE, stdout '$OUT', stderr '$ERR')"
        fi
    done
    STUB_LATEST=0.2.99 STUB_REVISION=abc1234 launch release update --in 0
    zero=$CODE
    launch release update --in 09m --bogus
    bogus_code=$CODE bogus_err=$ERR
    launch release update --in 10m 0.4.0
    version_err=$ERR
    launch release restore --in 10m "$ARCHIVE"
    restore_err=$ERR
    STUB_LATEST=0.2.99 STUB_REVISION=abc1234 launch release update --in 0 "5 min. New version 0.4.1"
    sentence_code=$CODE sentence_err=$ERR
    if [ -z "$failed" ] && [ "$zero" = 0 ] && [ "$bogus_code" = 2 ] &&
        printf '%s\n' "$bogus_err" | grep -q '^Unknown argument "--bogus".$' &&
        printf '%s\n' "$version_err" | grep -qx 'Put the version before --in: ./eigen update 0.4.0 --in 10m' &&
        printf '%s\n' "$restore_err" | grep -qx "Put the archive before --in: ./eigen restore $ARCHIVE --in 10m" &&
        [ "$sentence_code" = 0 ] && ! printf '%s\n' "$sentence_err" | grep -q 'Put the version before'; then
        ok "$SHELL_NAME: --in takes 0 and a leading zero, and refuses a bare number, more than an hour, a stray unit, no time, --check, a long message, and a version or an archive after it, before anything runs, and takes a message with spaces that holds a version"
    else
        fail "$SHELL_NAME: --in parsing:$failed; --in 0 exit $zero; --in 09m --bogus exit $bogus_code, '$bogus_err'; a version after --in '$version_err'; an archive after --in '$restore_err'; a sentence with a version exit $sentence_code, '$sentence_err'"
    fi
    rm -f "$FIX/release/.eigen/last-update" "$FIX/release/.eigen/bundle"
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
    echo server-pre-update-full-20250101-000000.tar >"$FIX/release/.eigen/last-update"
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
    # The archive becomes the way back once the switch is written: a switch that failed leaves the build as it was.
    STUB_RUN_FAIL=EIGEN_VERSION STUB_DIGEST=ddd launch release update --pulled 0.2.99 --saved server-pre-update-full-20260101-000000.tar
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Could not write Eigen .* into .env.production' &&
        [ ! -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: a handover whose switch fails records no backup for a rollback"
    else
        fail "$SHELL_NAME: a failed switch: exit $CODE, '$ERR', last-update '$(cat "$FIX/release/.eigen/last-update" 2>&1)'"
    fi
    # A handover that dies before update_apply (here in need_install) still takes the old launcher's notice back.
    mkdir -p "$FIX/bare/.eigen"
    launch bare update --pulled 0.2.99 --saved server-pre-update-full-20260101-000000.tar
    lock_left=''
    if [ -e "$FIX/bare/.eigen/lock" ]; then lock_left=1; fi
    rm -rf "$FIX/bare/.eigen"
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Eigen is not set up in ' &&
        printf '%s\n' "$CALLS" | tail -n 1 | grep -q ' restart-notice --clear$' && [ -z "$lock_left" ]; then
        ok "$SHELL_NAME: a handover that dies in need_install takes the notice back"
    else
        fail "$SHELL_NAME: a handover that dies in need_install: exit $CODE, '$ERR', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    STUB_DIGEST=ddd launch release update --pulled 0.2.99 --saved server-pre-update-full-20260101-000000.tar
    rm -r "$FIX/release/data"
    if [ "$CODE" = 0 ] && [ "$(sed -n 1p "$FIX/release/.eigen/last-update")" = server-pre-update-full-20260101-000000.tar ]; then
        ok "$SHELL_NAME: a handover with the backup's archive records it"
    else
        fail "$SHELL_NAME: update --pulled --saved: exit $CODE, calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    rm "$FIX/release/.eigen/last-update"
    # The stop is armed only after the wait for a running server backup, so an interrupt there leaves Eigen running.
    mkdir -p "$FIX/release/data"
    printf '%s\n' "$BACKUP_RUNS" >"$FIX/jobs"
    LAUNCH_TERM=' status --running' STUB_JOBS=$FIX/jobs STUB_DIGEST=ddd \
        launch release update --pulled 0.2.99 --saved server-pre-update-full-20260101-000000.tar
    rm -r "$FIX/release/data" "$FIX/jobs"
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
    echo server-pre-update-full-20260101-000000.tar >"$FIX/local/.eigen/last-update"
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
    # The stop would kill a server backup that runs, so it waits for it to end.
    launch_during_backup "$BACKUP_RUNS" restore "$ARCHIVE" --yes
    if [ "$CODE" = 0 ] && waited_for_backup && printf '%s\n' "$(steps)" | grep -q '|stop|restore --swap'; then
        ok "$SHELL_NAME: a restore waits for the server backup that runs to end before it stops Eigen"
    else
        fail "$SHELL_NAME: a restore during a server backup: exit $CODE, '$OUT', steps '$(steps)'"
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
    echo server-pre-update-full-20260101-000000.tar >"$FIX/release/.eigen/last-update"
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
    echo server-pre-update-full-20260101-000000.tar >"$FIX/release/.eigen/last-update"
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
    # The pull names the build the registry says the archive's api image is, not the channel it follows.
    STUB_IMAGE=1 STUB_CHECKED=$checked STUB_LATEST=0.2.98 STUB_REVISION=bbb1234 launch release restore "$ARCHIVE" --yes
    if [ "$CODE" = 0 ] && [ "$(printf '%s\n' "$CALLS" | grep -m 1 '^pull ')" = 'pull ghcr.io/eigen-is/eigen/api:local' ] &&
        printf '%s\n' "$CALLS" | grep -qx 'manifest inspect -v ghcr.io/eigen-is/eigen/api@sha256:bbb' &&
        printf '%s\n' "$OUT" | grep -q '◇  Eigen 0.2.98 (bbb1234) is here$' &&
        printf '%s\n' "$(steps)" | grep -q 'pull ghcr.io/eigen-is/eigen/unbound@sha256:bbb|stop|restore --swap (ghcr.io/eigen-is/eigen/api:local)|bootstrap ghcr.io/eigen-is/eigen/api@sha256:bbb|share|up|$' &&
        [ "$(cat "$FIX/release/.eigen/bundle")" = ghcr.io/eigen-is/eigen/api@sha256:bbb ]; then
        ok "$SHELL_NAME: a release restore gets the api image it runs, pulls the images the archive pins while Eigen runs, named by their build, then writes the files of its api image"
    else
        fail "$SHELL_NAME: a release restore to other images: exit $CODE, steps '$(steps)', '$OUT'"
    fi
    # Files that cannot be written after the swap stay those of the build before, which the restart the failure points
    # at writes anew.
    reset_release
    echo ghcr.io/eigen-is/eigen/api:local >"$FIX/release/.eigen/bundle"
    STUB_IMAGE=1 STUB_CHECKED=$checked STUB_RUN_FAIL=bootstrap launch release restore "$ARCHIVE" --yes
    outcome="exit $CODE, bundle $(cat "$FIX/release/.eigen/bundle"), '$ERR'"
    # Without the registry's annotations, the pull is named by the archive's EIGEN_VERSION.
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q 'The data is restored. Fix what it says, then run ./eigen restart.' &&
        printf '%s\n' "$OUT" | grep -q '◇  Eigen main is here$' &&
        [ "$(cat "$FIX/release/.eigen/bundle")" = ghcr.io/eigen-is/eigen/api:local ]; then
        launch release restart
        if [ "$CODE" = 0 ] && [ "$(steps)" = 'bootstrap ghcr.io/eigen-is/eigen/api@sha256:bbb|share|up|' ] &&
            [ "$(cat "$FIX/release/.eigen/bundle")" = ghcr.io/eigen-is/eigen/api@sha256:bbb ]; then
            ok "$SHELL_NAME: a release restore that cannot write its files leaves them stale, and restart writes them"
        else
            fail "$SHELL_NAME: restart after a restore that could not write its files: exit $CODE, steps '$(steps)'"
        fi
    else
        fail "$SHELL_NAME: a release restore that cannot write its files: $outcome"
    fi
    rm "$FIX/release/.eigen/bundle"
    # An api image that is here already, as after a rollback's pull, names the build by its labels: the registry is not
    # asked, so an offline host does not wait on it.
    reset_release
    STUB_CHECKED=$checked STUB_LATEST=0.2.98 STUB_REVISION=bbb1234 launch release restore "$ARCHIVE" --yes
    if [ "$CODE" = 0 ] && ! printf '%s\n' "$CALLS" | grep -q '^manifest inspect' &&
        printf '%s\n' "$OUT" | grep -q '◇  Eigen 0.2.99 (abc1234) is here$'; then
        ok "$SHELL_NAME: a release restore names a pinned api image that is here by its labels, without asking the registry"
    else
        fail "$SHELL_NAME: a release restore to an api image that is here: exit $CODE, '$OUT', calls: $(printf '%s' "$CALLS" | tr '\n' '|')"
    fi
    rm -f "$FIX/release/.eigen/bundle"
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

    echo server-pre-update-full-20260101-000000.tar >"$FIX/release/.eigen/last-update"
    STUB_CHECKED=$checked launch release rollback --yes
    if [ "$CODE" = 1 ] &&
        printf '%s\n' "$ERR" | grep -q '■  The backup the last update made, backups/server-pre-update-full-20260101-000000.tar, is gone.' &&
        [ -z "$(steps)" ] && [ -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: rollback whose archive is gone says so before it stages anything"
    else
        fail "$SHELL_NAME: rollback without its archive: exit $CODE, steps '$(steps)', '$ERR'"
    fi
    # The backups earlier updates made, which retention keeps, are the way back further: ./eigen restore takes one. They
    # list newest first by the stamp in the name, whatever their level, a name with a space whole.
    older="$FIX/release/backups/server-pre-update-full-s3-20251201-000000.tar"
    newer="$FIX/release/backups/server-pre-update-full-20251202-000000.tar"
    spaced="$FIX/release/backups/server-pre-update-full copy-20251203-000000.tar"
    : >"$older"
    : >"$newer"
    : >"$spaced"
    STUB_CHECKED=$checked launch release rollback --yes
    refused=$(printf '%s\n' "$ERR" | sed -n 's/^[│└]  *//p' | tr '\n' '|')
    refused_code=$CODE
    launch release rollback --help
    rm "$older" "$newer" "$spaced"
    if [ "$refused_code" = 1 ] &&
        [ "$refused" = "The backups earlier updates made:|$(basename "$spaced")|$(basename "$newer")|$(basename "$older")|./eigen restore <file> puts one of them back.|" ] &&
        [ "$CODE" = 0 ] && [ "$(printf '%s\n' "$OUT" | sed -n '/Kept:$/,/^$/p' | tr '\n' '|')" = "To go back further, ./eigen restore <file> puts back a backup an earlier update made. Kept:|  $(basename "$spaced")|  $(basename "$newer")|  $(basename "$older")||" ]; then
        ok "$SHELL_NAME: rollback whose archive is gone, and its --help, name the backups earlier updates made for ./eigen restore"
    else
        fail "$SHELL_NAME: rollback lists the backups earlier updates made: exit $refused_code, '$refused'; --help exit $CODE, '$OUT'"
    fi
    echo server-pre-update-full-20260101-000000.tar >"$FIX/release/.eigen/last-update"
    : >"$FIX/release/backups/server-pre-update-full-20260101-000000.tar"
    STUB_CHECKED=$checked launch release rollback --yes
    rm "$FIX/release/backups/server-pre-update-full-20260101-000000.tar"
    if [ "$CODE" = 0 ] &&
        printf '%s\n' "$OUT" | grep -q '▲  The launcher that made the last update kept no note of the build before it.$' &&
        printf '%s\n' "$OUT" | grep -q '◆  Back from Eigen 0.2.99 (abc1234) to the backup the last update made' &&
        [ "$(steps)" = 'share|stage eigen-api restore server-pre-update-full-20260101-000000.tar --stage --yes|restore --staged (ghcr.io/eigen-is/eigen/api:local)|stop|restore --swap (ghcr.io/eigen-is/eigen/api:local)|bootstrap ghcr.io/eigen-is/eigen/api@sha256:bbb|share|up|' ] &&
        [ ! -e "$FIX/release/.eigen/last-update" ] &&
        printf '%s\n' "$OUT" | grep -q '◇  Eigen 0.2.99 (abc1234) → 0.2.99 (abc1234) is running at https://eigen.example.com/'; then
        ok "$SHELL_NAME: rollback after an update that recorded no pins restores the archive .eigen/last-update names on the images it pins, and names the builds it leaves and reaches"
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
    # rollback --in waits after the stage, its question and the pull, right before the stop. Cut off in the wait, it
    # unstages, takes the notice back and stops nothing.
    notice_steps() {
        printf '%s\n' "$CALLS" | sed -n -e 's/^compose .* run --rm --no-deps .*$/stage/p' -e 's/^run .* restore --staged$/staged/p' \
            -e 's/^run .* rm -rf data\/.restoring$/unstage/p' -e 's/^compose .* stop$/stop/p' \
            -e 's/^compose .* exec .*\/entrypoint.sh \(restart-notice .*\)$/\1/p' | tr '\n' '|'
    }
    echo server-pre-update-full-20260101-000000.tar >"$FIX/release/.eigen/last-update"
    : >"$FIX/release/backups/server-pre-update-full-20260101-000000.tar"
    STUB_CHECKED=$checked launch release rollback --in 1s --yes
    sequence=$(notice_steps)
    rm -f "$FIX/release/.eigen/bundle"
    reset_release
    echo server-pre-update-full-20260101-000000.tar >"$FIX/release/.eigen/last-update"
    LAUNCH_TERM='restart-notice --in 600' STUB_CHECKED=$checked launch release rollback --yes --in 10m
    rm -f "$FIX/release/backups/server-pre-update-full-20260101-000000.tar" "$FIX/release/.eigen/last-update"
    if [ "$sequence" = 'stage|staged|restart-notice --in 1 --reason rollback|stop|' ] && [ "$CODE" = 130 ] &&
        [ "$(notice_steps)" = 'stage|staged|restart-notice --in 600 --reason rollback|unstage|restart-notice --clear|' ]; then
        ok "$SHELL_NAME: rollback --in waits right before the stop, and cut off there it unstages and takes the notice back"
    else
        fail "$SHELL_NAME: rollback --in: '$sequence'; cut off: exit $CODE, '$(notice_steps)', '$ERR'"
    fi
    reset_release
    launch local restore "$ARCHIVE" --yes --in 1s 'Back soon'
    if [ "$CODE" = 0 ] && [ "$(notice_steps)" = 'stage|staged|restart-notice --in 1 --reason rollback --message Back soon|stop|' ] &&
        printf '%s\n' "$OUT" | grep -q '◆  Restarts in 1s, at 00:10:00 UTC. Ctrl+C cancels.$'; then
        ok "$SHELL_NAME: restore --in tells the open tabs, with the message, and waits right before the stop"
    else
        fail "$SHELL_NAME: restore --in: exit $CODE, '$(notice_steps)', '$OUT', '$ERR'"
    fi
    # The notice expires a few minutes after its time, and a nightly backup can outlast that: the wait for it gives the
    # tabs the notice again, right before the stop.
    launch_during_backup "$BACKUP_RUNS" restore "$ARCHIVE" --yes
    if [ "$CODE" = 0 ] && waited_for_backup &&
        [ "$(notice_steps)" = 'stage|staged|restart-notice --in 0 --reason rollback|restart-notice --in 0 --reason rollback|stop|' ]; then
        ok "$SHELL_NAME: a restore that waited for a server backup tells the open tabs again before the stop"
    else
        fail "$SHELL_NAME: the notice after a wait for a server backup: exit $CODE, '$(notice_steps)', '$OUT', '$ERR'"
    fi

    # The first way back keeps data/: the build before the update checks it opens it, and Eigen switches to the pins the
    # update recorded. When that build cannot open it, the update's Full backup goes back.
    full=server-pre-update-full-20260101-000000.tar
    old=ghcr.io/eigen-is/eigen/api@sha256:old
    pinned="$full|EIGEN_REGISTRY=ghcr.io/eigen-is/eigen|EIGEN_VERSION=0.2.98|EIGEN_API_IMAGE=$old"
    record_pins() { printf '%s\n' "$pinned" | tr '|' '\n' >"$FIX/release/.eigen/last-update"; }
    : >"$FIX/release/backups/$full"
    record_pins
    STUB_IMAGE=1 STUB_FAIL=$old launch release rollback --yes
    if [ "$CODE" = 1 ] && printf '%s\n' "$ERR" | grep -q '■  Could not get the build before the update$' &&
        printf '%s\n' "$ERR" | grep -q "└  Full output: .*Check the network, then run ./eigen rollback again.$" &&
        [ "$(steps)" = "pull ghcr.io/eigen-is/eigen/api:local|pull $old|" ] && [ -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: rollback whose build before cannot be downloaded changes nothing and says to run it again"
    else
        fail "$SHELL_NAME: rollback with a failed pull of the build before: exit $CODE, steps '$(steps)', '$ERR'"
    fi
    STUB_RUN_FAIL=--check-data STUB_RUN_CODE=4 STUB_CHECKED=$checked launch release rollback --yes
    if [ "$CODE" = 0 ] && printf '%s\n' "$OUT" | grep -q "▲  Eigen 0.2.99 (abc1234) cannot open the data here.\$" &&
        printf '%s\n' "$OUT" | grep -q '◆  Back from Eigen 0.2.99 (abc1234) to the backup the last update made' &&
        [ "$(steps)" = "restore --check-data --yes ($old)|share|stage eigen-api restore $full --stage --yes|restore --staged (ghcr.io/eigen-is/eigen/api:local)|stop|restore --swap (ghcr.io/eigen-is/eigen/api:local)|bootstrap ghcr.io/eigen-is/eigen/api@sha256:bbb|share|up|" ] &&
        [ ! -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: rollback whose build before cannot open the data says so in one line and restores the update's Full backup"
    else
        fail "$SHELL_NAME: rollback after a failed check: exit $CODE, steps '$(steps)', '$OUT', '$ERR'"
    fi
    rm -f "$FIX/release/.eigen/bundle"
    reset_release
    record_pins
    # A no to the check's question, a Ctrl+C at it, and a check that stopped without a verdict, as when a database stays
    # locked, Docker cannot run the image or the OOM killer ends it, keep today's data and the way back.
    failed=''
    for code in 3 130 1 137 2; do
        STUB_RUN_FAIL=--check-data STUB_RUN_CODE=$code launch release rollback --yes
        ended=1
        case $code in 3) ended=0 ;; 130) ended=130 ;; esac
        if [ "$CODE" != "$ended" ] || [ "$(steps)" != "restore --check-data --yes ($old)|" ] ||
            [ ! -e "$FIX/release/.eigen/last-update" ]; then
            failed="$failed check exit $code (exit $CODE, steps '$(steps)', '$ERR')"
        fi
        # Only a check that stopped says so; a no and a Ctrl+C end quietly.
        said=$(printf '%s\n' "$ERR" | grep -c '■  ' || :)
        stopped=$(printf '%s\n' "$ERR" | grep -c "■  The check stopped (exit $code); Eigen 0.2.99 (abc1234) runs on as it was.\$" || :)
        want=0
        if [ "$ended" = 1 ]; then want=1; fi
        if [ "$said" != "$want" ] || [ "$stopped" != "$want" ]; then failed="$failed check exit $code says '$ERR'"; fi
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: rollback whose check is declined, cut off, or stops without a verdict changes nothing"
    else
        fail "$SHELL_NAME: rollback after a declined or stopped check:$failed"
    fi
    # Cut off after the stop, it starts Eigen again and keeps the way back, so the next rollback below finishes it.
    STUB_RUN_FAIL=bootstrap launch release rollback --yes
    if [ "$CODE" = 1 ] && [ "$(steps)" = "restore --check-data --yes ($old)|stop|restore --check-data --yes --since T ($old)|configure $old|bootstrap $old|share|up|" ] &&
        [ -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: rollback on the data as it is that fails writing the files starts Eigen and keeps .eigen/last-update"
    else
        fail "$SHELL_NAME: rollback on the data as it is cut off in the files: exit $CODE, steps '$(steps)', '$ERR'"
    fi
    started=$(date +%s)
    launch release rollback --yes
    since=$(printf '%s\n' "$CALLS" | sed -n 's/^run .* restore --check-data --yes --since \([0-9]*\)$/\1/p')
    if [ "$CODE" = 0 ] &&
        printf '%s\n' "$OUT" | grep -q '◆  Back from Eigen 0.2.99 (abc1234) to Eigen 0.2.99 (abc1234), on the data as it is' &&
        [ "$(steps)" = "restore --check-data --yes ($old)|stop|restore --check-data --yes --since T ($old)|configure $old|bootstrap $old|share|up|" ] &&
        [ -n "$since" ] && [ "$since" -le "$((started * 1000))" ] &&
        printf '%s\n' "$CALLS" | grep " configure --backfill$" | grep -q ' -e EIGEN_API_IMAGE ' &&
        [ ! -e "$FIX/release/.eigen/last-update" ] && [ -e "$FIX/release/backups/$full" ] &&
        printf '%s\n' "$OUT" | grep -q "└  The data stayed as it was. backups/$full stays, for ./eigen restore."; then
        ok "$SHELL_NAME: rollback keeps data/, and switches to the pins the update recorded once the build before checked the data, and checked again with Eigen stopped what was written since the first check began"
    else
        fail "$SHELL_NAME: a rollback on the data as it is: exit $CODE, since '$since', steps '$(steps)', '$OUT', '$ERR'"
    fi
    # The wait for the tabs and for a server backup ran on the new build, which may have moved a database to a schema
    # the build before cannot open. The second check finds it with Eigen stopped, and the rollback puts the update's
    # Full backup back. A check that stops without a verdict, or a build before that cannot check again, ends the
    # rollback, and Eigen starts again on the build it ran.
    record_pins
    STUB_RUN_FAIL=--since STUB_RUN_CODE=4 STUB_CHECKED=$checked launch release rollback --yes
    if [ "$CODE" = 0 ] &&
        printf '%s\n' "$OUT" | grep -q '▲  Eigen 0.2.99 (abc1234) cannot open what Eigen 0.2.99 (abc1234) wrote since the first check.$' &&
        [ "$(steps)" = "restore --check-data --yes ($old)|stop|restore --check-data --yes --since T ($old)|share|stage eigen-api restore $full --stage --yes|restore --staged (ghcr.io/eigen-is/eigen/api:local)|stop|restore --swap (ghcr.io/eigen-is/eigen/api:local)|bootstrap ghcr.io/eigen-is/eigen/api@sha256:bbb|share|up|" ] &&
        [ ! -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: rollback whose second check finds a database the build before cannot open puts the update's Full backup back"
    else
        fail "$SHELL_NAME: rollback after a failed second check: exit $CODE, steps '$(steps)', '$OUT', '$ERR'"
    fi
    rm -f "$FIX/release/.eigen/bundle"
    reset_release
    failed=''
    for code in 2 1; do
        record_pins
        STUB_RUN_FAIL=--since STUB_RUN_CODE=$code launch release rollback --yes
        why="The second check stopped (exit $code); Eigen 0.2.99 (abc1234) starts again."
        if [ "$CODE" != 1 ] || [ "$(steps)" != "restore --check-data --yes ($old)|stop|restore --check-data --yes --since T ($old)|share|up|" ] ||
            ! printf '%s\n' "$ERR" | grep -qF "■  $why" || [ ! -e "$FIX/release/.eigen/last-update" ]; then
            failed="$failed second check exit $code (exit $CODE, steps '$(steps)', '$ERR')"
        fi
    done
    if [ -z "$failed" ]; then
        ok "$SHELL_NAME: rollback whose second check stops starts Eigen again on the build it ran and keeps the way back"
    else
        fail "$SHELL_NAME: rollback after a stopped second check:$failed"
    fi
    reset_release
    record_pins
    # rollback --in on the data as it is waits after the check and its question, right before the stop. Cut off in the
    # wait by Ctrl+C or a lost SSH session, it takes the notice back and stops and switches nothing.
    kept_steps() {
        printf '%s\n' "$CALLS" | sed -n -e 's/^run .* restore --check-data .*$/checked/p' -e 's/^compose .* stop$/stop/p' \
            -e 's/^compose .* exec .*\/entrypoint.sh \(restart-notice .*\)$/\1/p' | tr '\n' '|'
    }
    failed=''
    for signal in TERM HUP; do
        record_pins
        LAUNCH_TERM='restart-notice --in 600' LAUNCH_SIGNAL=$signal launch release rollback --yes --in 10m
        code=130
        if [ "$signal" = HUP ]; then code=129; fi
        if [ "$CODE" != "$code" ] ||
            [ "$(kept_steps)" != 'checked|restart-notice --in 600 --reason rollback|restart-notice --clear|' ] ||
            printf '%s\n' "$CALLS" | grep -Eq ' bootstrap | configure --backfill$' || [ ! -e "$FIX/release/.eigen/last-update" ]; then
            failed="$failed $signal (exit $CODE, steps '$(kept_steps)', '$ERR')"
        fi
    done
    launch release rollback --in 1s 'Back soon' --yes
    if [ -z "$failed" ] && [ "$CODE" = 0 ] &&
        [ "$(kept_steps)" = 'checked|restart-notice --in 1 --reason rollback --message Back soon|stop|checked|' ] &&
        printf '%s\n' "$OUT" | grep -q '◆  Restarts in 1s, at 00:10:00 UTC. Ctrl+C cancels.$' &&
        [ ! -e "$FIX/release/.eigen/last-update" ]; then
        ok "$SHELL_NAME: rollback --in on the data as it is warns the open tabs after the check, waits right before the stop, and cut off there takes the notice back"
    else
        fail "$SHELL_NAME: rollback --in on the data as it is:$failed; --in 1s exit $CODE, steps '$(kept_steps)', '$OUT', '$ERR'"
    fi
    rm -f "$FIX/release/.eigen/bundle"
    reset_release
    rm -f "$FIX/release/backups/$full" "$FIX/release/.eigen/last-update"
    reset_release

    # A backup runs on the running API and stops nothing.
    failed=''
    for flags in '|full' '--full|full' '--s3|full-s3' '--s3 --wait|full-s3 --wait'; do
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
