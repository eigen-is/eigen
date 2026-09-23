# Shared scaffolding for the docker/test-*.sh probe scripts: the pass/fail bookkeeping, the log
# helpers, the scratch installs every harness runs in, the compose wrapper, the HTTP/SMTP/IMAPS probes,
# and the Result summary. Sourced, never run:
#
#   . "$(dirname "$0")/probe-lib.sh"
#
# Everything in here must stay bash 3.2 clean, because that is what macOS ships.
#
# Data safety: no harness runs Compose in the checkout. Each one copies the working tree into a scratch
# folder under $TMPDIR, installs there with ./eigen under a Compose project named eigentest…, publishes
# only 127.0.0.1 ports from 18000-18999, and removes what it started (and nothing else) on exit.

# The operator's Compose settings would point the harness's host-side compose calls at another stack.
unset COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES

PASS=0
FAIL=0
SKIP=0
# Only ever expanded inside a `FAIL > 0` branch: bash 3.2 with `set -u` treats an empty array as
# unbound and would exit instead of printing the summary.
FAIL_LINES=()

log()    { printf '  %s\n' "$*"; }
header() { printf '\n=== %s ===\n' "$*"; }
ok()     { log "✓ $*"; PASS=$((PASS+1)); }
fail()   { log "✗ $*"; FAIL=$((FAIL+1)); FAIL_LINES+=("$*"); }
skip()   { log "– skipped: $*"; SKIP=$((SKIP+1)); }

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
BUN_VERSION=$(cat "$REPO_ROOT/.bun-version")
export BUN_VERSION
# Space-separated, not an array: bash 3.2 with `set -u` treats an empty array as unbound.
HARNESS_PROJECTS=''
PICKED_PORTS=' '

# scratch_init <purpose>: the scratch root, private image tags so ghcr.io/eigen-is/eigen/*:local is never overwritten, the
# no-Bun docker:cli image the launcher runs in, and the cleanup trap.
scratch_init() {
    RUN="$1$$"
    SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/eigentest-$1.XXXXXX")
    SCRATCH=$(cd "$SCRATCH" && pwd -P)
    # An install owned by another uid must be reachable through it.
    chmod 755 "$SCRATCH"
    case "$SCRATCH/" in "$REPO_ROOT"/*)
        echo "harness: scratch folder $SCRATCH is inside the checkout; set TMPDIR elsewhere" >&2
        exit 1
        ;;
    esac
    trap harness_cleanup EXIT
    trap 'exit 130' INT TERM
    export EIGEN_API_IMAGE="eigentest-api:$RUN" EIGEN_FRONTEND_IMAGE="eigentest-frontend:$RUN"
    export EIGEN_POSTFIX_IMAGE="eigentest-postfix:$RUN" EIGEN_DOVECOT_IMAGE="eigentest-dovecot:$RUN"
    # The published images are amd64; an arm64 Mac runs the harness through the launcher's escape hatch.
    case "$(docker info --format '{{.Architecture}}')" in
        x86_64 | amd64) ;;
        *) export EIGEN_ALLOW_ARCH=1 ;;
    esac
    CLI_IMAGE="eigentest-cli:$RUN"
    # The daemon is shared with whatever else runs on this machine, so the launcher's prunes, which reach past its
    # own install, are logged to $HARNESS_PRUNE_LOG instead of run.
    mkdir "$SCRATCH/cli-image"
    printf '%s\n' '#!/bin/sh' \
        'case "$1 $2" in "image prune" | "builder prune") echo "$*" >>"$HARNESS_PRUNE_LOG"; exit 0 ;; esac' \
        'exec docker.real "$@"' >"$SCRATCH/cli-image/docker"
    chmod 755 "$SCRATCH/cli-image/docker"
    printf '%s\n' 'FROM docker:cli' \
        'RUN command -v git >/dev/null || apk add --no-cache git' \
        'RUN ! command -v bun && ! command -v node && ! command -v curl' \
        'RUN mv /usr/local/bin/docker /usr/local/bin/docker.real' \
        'COPY docker /usr/local/bin/docker' >"$SCRATCH/cli-image/Dockerfile"
    docker build -q --label eigen.harness=1 -t "$CLI_IMAGE" "$SCRATCH/cli-image" >/dev/null
    PRUNE_LOG="$SCRATCH/prune.log"
    : >"$PRUNE_LOG"
    chmod 666 "$PRUNE_LOG"
    SOCKET_GID=$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$CLI_IMAGE" \
        stat -c %g /var/run/docker.sock)
    log "scratch $SCRATCH (run $RUN)"
}

# new_install <folder name> [uid:gid]: $INSTALL, a scratch copy of the working tree (tracked and untracked
# files, not ignored ones, nothing under data/, backups/, snapshots/ or caddy-data/) committed to a fresh repo so the
# launcher sees a source checkout, owned by uid:gid (default: the host user) as if that operator had cloned
# it. $PROJECT is the Compose project name Compose derives from the folder name.
new_install() {
    INSTALL="$SCRATCH/$1"
    INSTALL_OWNER="${2:-$(id -u):$(id -g)}"
    PROJECT=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
    HARNESS_PROJECTS="$HARNESS_PROJECTS $PROJECT"
    # Created and filled inside containers: Docker Desktop refuses a later chown of the host's read-only
    # git objects, and on Linux the host user could not write a folder another uid owns.
    scratch_run sh -c 'mkdir "$1" && chown "$2" "$1"' sh "$INSTALL" "$INSTALL_OWNER"
    (cd "$REPO_ROOT" && git ls-files -z -co --exclude-standard -- . ':!data' ':!backups' ':!snapshots' ':!caddy-data' |
        while IFS= read -r -d '' file; do
            if [ -e "$file" ] || [ -L "$file" ]; then printf '%s\0' "$file"; fi
        done | COPYFILE_DISABLE=1 tar -cf - --null -T -) |
        docker run --rm -i --user "$INSTALL_OWNER" -e HOME=/tmp -v "$SCRATCH:$SCRATCH" -w "$INSTALL" "$CLI_IMAGE" \
            sh -c 'tar -xf - && git init -q && git add -A &&
                git -c user.name=harness -c user.email=harness@eigen.invalid commit -qm "harness copy of the working tree"'
    assert_isolated
}

# The guard every harness passes before its first Compose call: a unique eigentest project whose data/ is
# a real folder outside the checkout.
assert_isolated() {
    local data
    case "$PROJECT" in eigentest?*) ;; *)
        echo "harness: Compose project '$PROJECT' is not a harness project; refusing" >&2
        exit 1
        ;;
    esac
    if [ -L "$INSTALL/data" ]; then
        echo "harness: $INSTALL/data is a symlink; refusing" >&2
        exit 1
    fi
    data="$(cd "$INSTALL" && pwd -P)/data"
    case "$data/" in "$REPO_ROOT"/*)
        echo "harness: $data is inside the checkout $REPO_ROOT; refusing" >&2
        exit 1
        ;;
    esac
}

# free_port <var>: an unused host port from 18000-18999 that this run has not handed out yet.
free_port() {
    local port tries=0
    while [ "$tries" -lt 200 ]; do
        tries=$((tries + 1))
        port=$((18000 + RANDOM % 1000))
        case "$PICKED_PORTS" in *" $port "*) continue ;; esac
        if ! (: >"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
            PICKED_PORTS="$PICKED_PORTS$port "
            printf -v "$1" '%s' "$port"
            return 0
        fi
    done
    echo "harness: no free port in 18000-18999" >&2
    exit 1
}

# write_override [--mailpit]: the harness overlay as the install's docker-compose.override.yml, which the
# launcher layers on: every published port moved to a fresh 127.0.0.1 port, the harness label on every
# image a source install builds, and optionally Mailpit as the outgoing relay.
write_override() {
    local name mailpit='' build=''
    for name in PORT_HTTP PORT_HTTPS PORT_STATIC PORT_SMTP PORT_SMTPS PORT_SUBMISSION PORT_IMAPS PORT_MAILPIT; do
        free_port "$name"
    done
    # A release install pulls its images; a build: block there would ask Compose for a build context.
    build='    labels: { eigen.harness: "1" }'
    if [ -f "$INSTALL/docker-compose.build.yml" ]; then build='    build: *harness-build'; fi
    if [ "${1:-}" = --mailpit ]; then
        mailpit="  mailpit:
    image: axllent/mailpit
    ports:
      - \"127.0.0.1:$PORT_MAILPIT:8025\"
    networks: [eigen]"
    fi
    docker run --rm -i --user "$INSTALL_OWNER" -v "$SCRATCH:$SCRATCH" "$CLI_IMAGE" \
        sh -c 'cat >"$1"' sh "$INSTALL/docker-compose.override.yml" <<EOF
x-harness-build: &harness-build
  labels:
    eigen.harness: "1"
services:
  eigen-api:
$build
  caddy:
$build
    ports: !override
      - "127.0.0.1:$PORT_HTTP:80"
      - "127.0.0.1:$PORT_HTTPS:443"
  eigen-static:
$build
  postfix:
$build
    ports: !override
      - "127.0.0.1:$PORT_SMTP:25"
      - "127.0.0.1:$PORT_SMTPS:465"
      - "127.0.0.1:$PORT_SUBMISSION:587"
  dovecot:
$build
    ports: !override
      - "127.0.0.1:$PORT_IMAPS:993"
$mailpit
EOF
}

# in_cli_container [--stdin] [--user uid:gid] <command…>: runs in $INSTALL inside the no-Bun docker:cli image, with
# the Docker socket, and the scratch folder at its own path so the bind mounts Compose creates resolve on the host.
# --stdin passes this script's stdin through, for a piped answer; without it the command reads nothing.
in_cli_container() {
    local user=() stdin=()
    if [ "$1" = --stdin ]; then
        stdin=(-i)
        shift
    fi
    if [ "$1" = --user ]; then
        user=(--user "$2" --group-add "$SOCKET_GID" -e HOME=/tmp)
        shift 2
    fi
    docker run --rm ${stdin[@]+"${stdin[@]}"} --label eigen.harness=1 --label "eigen.harness.run=$RUN" \
        -v /var/run/docker.sock:/var/run/docker.sock -v "$SCRATCH:$SCRATCH" -w "$INSTALL" \
        -e EIGEN_API_IMAGE -e EIGEN_FRONTEND_IMAGE -e EIGEN_POSTFIX_IMAGE -e EIGEN_DOVECOT_IMAGE \
        -e EIGEN_ALLOW_ARCH -e NO_COLOR=1 -e HARNESS_PRUNE_LOG="$PRUNE_LOG" ${user[@]+"${user[@]}"} "$CLI_IMAGE" "$@"
}

# eigen <args…>: the launcher in the no-Bun container, as $OPERATOR when set (else root); sets OUT (stdout and
# stderr) and CODE.
eigen() {
    CODE=0
    OUT=$(in_cli_container ${OPERATOR:+--user "$OPERATOR"} ./eigen "$@" 2>&1) || CODE=$?
}

# eigen_piped <input> <args…>: the same with one line on stdin, as a script would answer.
eigen_piped() {
    local input="$1"
    shift
    CODE=0
    OUT=$(printf '%s\n' "$input" | in_cli_container --stdin ${OPERATOR:+--user "$OPERATOR"} ./eigen "$@" 2>&1) || CODE=$?
}

show() { printf '%s\n' "$OUT" | sed 's/^/    │ /'; }

# says <text>: whether the last output holds this line fragment.
says() { printf '%s\n' "$OUT" | grep -q -- "$1"; }

# run_setup [--user uid:gid] <setup flags…>: ./eigen setup in the no-Bun container.
run_setup() {
    local user=()
    if [ "$1" = --user ]; then
        user=(--user "$2")
        shift 2
    fi
    assert_isolated
    in_cli_container ${user[@]+"${user[@]}"} ./eigen setup "$@"
}

# The harness's own view of the install's stack, from the host, with the files the launcher uses.
dc() {
    local build=()
    assert_isolated
    if [ -f "$INSTALL/docker-compose.build.yml" ]; then build=(-f docker-compose.build.yml); fi
    (cd "$INSTALL" && docker compose -p "$PROJECT" --env-file .env.production -f docker-compose.yml \
        ${build[@]+"${build[@]}"} -f docker-compose.override.yml "$@")
}

# Every service running and eigen-api healthy.
stack_up() {
    local states
    states=$(dc ps -a --format '{{.Service}} {{.State}} {{.Health}}')
    printf '%s\n' "$states" | grep -q '^eigen-api running healthy$' &&
        ! printf '%s\n' "$states" | grep -v ' running' | grep -q .
}

api_started() { docker inspect --format '{{.State.StartedAt}}' "$(dc ps -q eigen-api)"; }

# setup_token <log>: the token of the last setup link in ./eigen setup output.
setup_token() { grep -o 'setup=[A-Za-z0-9_-]*' "$1" | tail -n 1 | cut -d= -f2 || true; }

# setup_post <route> <json fields>: the HTTP status and the seconds it took on $BASE, as "403 0.012".
setup_post() {
    curl -sk -o /dev/null -w '%{http_code} %{time_total}' --max-time 20 -X POST -H 'Content-Type: application/json' \
        -d "{$2}" "$BASE/setup/$1" || echo '000 20'
}

# sign_in <password> <cookie jar>: prints the HTTP status of a browser sign-in as $ADMIN_EMAIL on $BASE.
sign_in() {
    curl -sk -c "$2" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
        -H 'Origin: https://localhost' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$1\"}" \
        "$BASE/auth/sign-in/email" || echo 000
}

# create_admin <setup log> <password>: finishes the setup through the link in the log as $ADMIN_EMAIL, signs in
# into the cookie jar $JAR and sets ADMIN_ID; returns non-zero when a step fails.
create_admin() {
    local token code
    token=$(setup_token "$1")
    read -r code _ <<<"$(setup_post complete "\"orgName\":\"Probe\",\"storageType\":\"local-id\",\"adminUsername\":\"${ADMIN_EMAIL%@*}\",\"adminPassword\":\"$2\",\"adminName\":\"Alice\",\"setupToken\":\"$token\"")"
    [ "$code" = 200 ] && [ "$(sign_in "$2" "$JAR")" = 200 ] || return 1
    ADMIN_ID=$(curl -sk -b "$JAR" "$BASE/auth/get-session" | grep -o '"userId":"[^"]*"' | head -n 1 | cut -d'"' -f4)
    [ -n "$ADMIN_ID" ]
}

# api <method> <path> [json]: the body of an API call on $BASE as the signed-in admin.
api() {
    curl -sk -b "$JAR" -X "$1" -H 'Content-Type: application/json' -H 'Origin: https://localhost' ${3:+-d "$3"} \
        "$BASE$2" || true
}

# scratch_run <command…>: runs as root in the docker:cli image, the scratch folder at its own path. Docker
# Desktop's file share shows every file as the host user, so the owner a container wrote is only visible from
# inside one; and on Linux the host user cannot read what root or another uid keeps to itself.
scratch_run() {
    docker run --rm -v "$SCRATCH:$SCRATCH" --entrypoint '' "$CLI_IMAGE" "$@"
}

owner_mode() { scratch_run stat -c '%u:%g %a' "$1"; }

# down_project <project>: its containers, networks and volumes, found by Compose's project label.
down_project() {
    local kind ids
    ids=$(docker ps -aq --filter "label=com.docker.compose.project=$1")
    if [ -n "$ids" ]; then docker rm -f $ids >/dev/null || true; fi
    for kind in network volume; do
        ids=$(docker "$kind" ls -q --filter "label=com.docker.compose.project=$1")
        if [ -n "$ids" ]; then docker "$kind" rm $ids >/dev/null || true; fi
    done
}

# Removes only what this run started: its Compose projects, containers labelled with its run, its image
# tags, dangling harness-labelled images, and the scratch folder. HARNESS_KEEP=1 leaves all of it.
harness_cleanup() {
    local code=$? project ids
    if [ "${HARNESS_KEEP:-0}" = 1 ]; then
        log "HARNESS_KEEP=1: left $SCRATCH and the projects$HARNESS_PROJECTS"
        return "$code"
    fi
    for project in $HARNESS_PROJECTS; do down_project "$project"; done
    ids=$(docker ps -aq --filter "label=eigen.harness.run=$RUN")
    if [ -n "$ids" ]; then docker rm -f $ids >/dev/null || true; fi
    # data/ holds files owned by 1000 and root, which the host user cannot always delete.
    scratch_run find "$SCRATCH" -mindepth 1 -delete >/dev/null 2>&1 || true
    rm -rf "$SCRATCH"
    # Unset where a harness installs releases, which it pulls instead of building under these tags.
    docker image rm ${EIGEN_API_IMAGE:-} ${EIGEN_API_IMAGE:+$EIGEN_API_IMAGE-pre-update} ${EIGEN_FRONTEND_IMAGE:-} \
        ${EIGEN_POSTFIX_IMAGE:-} ${EIGEN_DOVECOT_IMAGE:-} "$CLI_IMAGE" >/dev/null 2>&1 || true
    docker image prune -f --filter label=eigen.harness=1 >/dev/null 2>&1 || true
    return "$code"
}

probe() {
    local desc="$1" url="$2" expected_code="$3" expected_pattern="${4:-}"
    local body=/tmp/eigen-probe-body-$$
    local got_code
    got_code=$(curl -sk -o "$body" -w '%{http_code}' --max-time 10 "$url" || echo 000)
    if [ "$got_code" != "$expected_code" ]; then
        fail "$desc → $got_code, expected $expected_code"
    elif [ -n "$expected_pattern" ] && ! grep -q "$expected_pattern" "$body"; then
        fail "$desc → $got_code but body missing '$expected_pattern' (likely the landing page served instead of the app)"
    else
        ok "$desc → $got_code${expected_pattern:+ with $expected_pattern}"
    fi
    rm -f "$body"
}

probe_ws() {
    local desc="$1" url="$2"
    local got_code
    got_code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 \
        --http1.1 \
        -H 'Upgrade: websocket' \
        -H 'Connection: Upgrade' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
        -H 'Sec-WebSocket-Version: 13' \
        "$url" || echo 000)
    # 401 = auth gate reached → the upgrade was correctly forwarded to the app.
    # 404 (or 426, …) = the upgrade headers got lost in translation and the request landed as a
    # plain GET on a route that does not exist.
    if [ "$got_code" = "401" ]; then
        ok "$desc → 401 (auth, upgrade pass-through OK)"
    else
        fail "WS at $url → $got_code, expected 401"
    fi
}

# Postfix should send a 220 SMTP banner as soon as the TCP connection is open. Doubles as proof that
# postfix could resolve unbound's IP and start cleanly — the part that breaks when EIGEN_SUBNET /
# EIGEN_UNBOUND_IP get out of sync. Retries because postfix has no healthcheck, so `compose up
# --wait` returns before the listener is fully accepting.
probe_smtp() {
    local desc="$1" port="$2"
    local banner=""
    for _ in 1 2 3 4 5; do
        banner=$(printf 'QUIT\r\n' | nc -w 5 localhost "$port" 2>/dev/null | head -1 || true)
        echo "$banner" | grep -q '^220 ' && break
        sleep 1
    done
    if echo "$banner" | grep -q '^220 '; then
        ok "$desc → 220 banner"
    else
        fail "SMTP banner on port $port: '$banner'"
    fi
}

# Dovecot IMAPS speaks IMAP over TLS. Sending `a logout` keeps the connection open long enough for
# openssl to emit the `* OK ...` greeting before exiting.
probe_imaps() {
    local desc="$1" port="$2"
    local banner=""
    for _ in 1 2 3 4 5; do
        banner=$(echo 'a logout' | openssl s_client -connect "localhost:$port" -quiet 2>/dev/null | head -1 || true)
        echo "$banner" | grep -q '^\* OK ' && break
        sleep 1
    done
    if echo "$banner" | grep -q '^\* OK '; then
        ok "$desc → '* OK' greeting"
    else
        fail "IMAPS banner on port $port: '$banner'"
    fi
}

# The tally, and the script's exit: 0 when nothing failed, 1 otherwise. Callers print their own
# "Result" header first, so a script can put its own guard (see test-mail-hardening.sh) above this.
probe_summary() {
    local skipped=''
    if [ "$SKIP" -gt 0 ]; then skipped=", $SKIP skipped"; fi

    if [ "$FAIL" -eq 0 ]; then
        printf '✓ ALL OK (%d checks passed%s)\n' "$PASS" "$skipped"
        exit 0
    fi
    printf '✗ %d FAILURES (%d passed%s)\n' "$FAIL" "$PASS" "$skipped"
    for line in "${FAIL_LINES[@]}"; do printf '  - %s\n' "$line"; done
    exit 1
}
