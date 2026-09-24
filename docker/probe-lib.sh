# What every docker/test-*.sh sources: the bookkeeping, the scratch installs, the probes and the summary. Bash 3.2
# clean, since macOS ships it. No harness runs Compose in the checkout: each installs a copy under $TMPDIR as a Compose
# project named eigentest…, on 127.0.0.1 ports from 18000-18999, and removes what it started, and nothing else, on exit.
# HARNESS_KEEP=1 leaves all of it.

# The operator's Compose settings would point the harness's host-side compose calls at another stack.
unset COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES

PASS=0
FAIL=0
SKIP=0
# Only expanded when FAIL > 0: bash 3.2 with `set -u` treats an empty array as unbound.
FAIL_LINES=()

log()    { printf '  %s\n' "$*"; }
header() { printf '\n=== %s ===\n' "$*"; }
ok()     { log "✓ $*"; PASS=$((PASS+1)); }
fail()   { log "✗ $*"; FAIL=$((FAIL+1)); FAIL_LINES+=("$*"); }
skip()   { log "– skipped: $*"; SKIP=$((SKIP+1)); }

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
BUN_VERSION=$(cat "$REPO_ROOT/.bun-version")
export BUN_VERSION
VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO_ROOT/package.json" | head -n 1)
# IMAGES in ./eigen is the list of images a release pins.
IMAGES=$(sed -n "s/^IMAGES='\(.*\)'/\1/p" "$REPO_ROOT/eigen")
# image_key in ./eigen: the variable that names an image.
image_key() { printf 'EIGEN_%s_IMAGE\n' "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"; }
# The docker run flags that pass those variables into a container, when set. Expanded as ${IMAGE_FLAGS[@]+"…"}: bash 3.2
# with `set -u` treats an empty array as unbound.
IMAGE_FLAGS=()
for name in $IMAGES; do IMAGE_FLAGS+=(-e "$(image_key "$name")"); done
# Space-separated, not an array: bash 3.2 with `set -u` treats an empty array as unbound.
HARNESS_PROJECTS=''
PICKED_PORTS=' '

# scratch_init <purpose>: the scratch root, private image tags so ghcr.io/eigen-is/eigen/*:local is never overwritten, the
# no-Bun docker:cli image the launcher runs in, scratch_run's container and the cleanup trap.
scratch_init() {
    local name
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
    for name in $IMAGES; do export "$(image_key "$name")=eigentest-$name:$RUN"; done
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
    SCRATCH_BOX="eigentest-box-$RUN"
    scratch_box
    log "scratch $SCRATCH (run $RUN)"
}

# working_tree: a tar of the tracked files as the working tree has them, without data/, backups/, snapshots/ and
# caddy-data/. Untracked files, other agents' among them, stay out: git add a new file to ship it.
working_tree() {
    (cd "$REPO_ROOT" && git ls-files -z -c -- . ':!data' ':!backups' ':!snapshots' ':!caddy-data' |
        while IFS= read -r -d '' file; do
            if [ -e "$file" ] || [ -L "$file" ]; then printf '%s\0' "$file"; fi
        done | COPYFILE_DISABLE=1 tar -cf - --null -T -)
}

# register_install <folder name> <uid:gid>: $INSTALL in the scratch root, its owner, and its Compose project as Compose
# names it from the folder, which the cleanup removes.
register_install() {
    INSTALL="$SCRATCH/$1"
    INSTALL_OWNER=$2
    PROJECT=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-' | sed 's/^[_-]*//')
    HARNESS_PROJECTS="$HARNESS_PROJECTS $PROJECT"
}

# new_install <folder name> [uid:gid]: $INSTALL, the working tree committed to a fresh repo, so the launcher sees a
# source checkout, owned by uid:gid (default: the host user) as if that operator had cloned it.
new_install() {
    register_install "$1" "${2:-$(id -u):$(id -g)}"
    # Created and filled inside containers: Docker Desktop refuses a later chown of the host's read-only
    # git objects, and on Linux the host user could not write a folder another uid owns.
    scratch_run sh -c 'mkdir "$1" && chown "$2" "$1"' sh "$INSTALL" "$INSTALL_OWNER"
    working_tree |
        docker run --rm -i --user "$INSTALL_OWNER" -e HOME=/tmp -v "$SCRATCH:$SCRATCH" -w "$INSTALL" "$CLI_IMAGE" \
            sh -c 'tar -xf - && git init -q && git add -A &&
                git -c user.name=harness -c user.email=harness@eigen.invalid commit -qm "harness copy of the working tree"'
    assert_isolated
}

# The guard before every harness's first Compose call: an eigentest project whose data/ is a real folder outside the
# checkout.
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

# write_override [--mailpit]: the install's docker-compose.override.yml: every published port on a fresh 127.0.0.1 port,
# the harness label on every image a source install builds, and optionally Mailpit as the outgoing relay.
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
# the Docker socket, and the scratch folder at its own path so the bind mounts Compose creates resolve on the host. The
# EIGEN_*_IMAGE variables pass through when set.
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
        -v /var/run/docker.sock:/var/run/docker.sock -v "$SCRATCH:$SCRATCH" -w "$INSTALL" ${IMAGE_FLAGS[@]+"${IMAGE_FLAGS[@]}"} \
        -e NO_COLOR=1 -e HARNESS_PRUNE_LOG="$PRUNE_LOG" ${user[@]+"${user[@]}"} "$CLI_IMAGE" "$@"
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

# The snapshot the last ./eigen backup saved, from its output.
saved_snapshot() { printf '%s\n' "$OUT" | grep -o 'eigen-\(light-\)\{0,1\}[0-9]\{8\}-[0-9]\{6\}\.tar\.gz' | head -n 1 || true; }

# run_setup <log> [--user uid:gid] <setup flags…>: ./eigen setup in the no-Bun container, its output in <log>. A
# setup that fails shows that output and ends the harness.
run_setup() {
    local log="$1" user=() started=$SECONDS
    shift
    if [ "$1" = --user ]; then
        user=(--user "$2")
        shift 2
    fi
    assert_isolated
    if in_cli_container ${user[@]+"${user[@]}"} ./eigen setup "$@" >"$log" 2>&1; then
        ok "./eigen setup finished in $((SECONDS - started))s"
        return 0
    fi
    fail "./eigen setup failed after $((SECONDS - started))s"
    sed 's/^/    /' "$log"
    dc logs --tail=30 2>&1 | sed 's/^/    /' || true
    header "Result"
    probe_summary
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

# The commit the image eigen-api runs was built at.
api_revision() {
    docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
        "$(docker inspect --format '{{.Image}}' "$(dc ps -q eigen-api)")"
}

# The last KEY= line of the install's .env.production.
env_of() { scratch_run sed -n "s/^$1=//p" "$INSTALL/.env.production" | tail -n 1; }

# How many data/ folders restores have kept aside.
aside_count() { (cd "$INSTALL" && ls -d data.pre-restore-* 2>/dev/null | wc -l | tr -d ' '); }

# The pre-update snapshots, space-separated; snapshots/ is root's alone.
pre_updates() {
    scratch_run sh -c 'cd "$1" 2>/dev/null && ls eigen-pre-update-*.tar.gz 2>/dev/null' sh "$INSTALL/snapshots" | tr '\n' ' '
}

# setup_token <log>: the token of the last setup link in ./eigen setup output.
setup_token() { grep -o 'setup=[A-Za-z0-9_-]*' "$1" | tail -n 1 | cut -d= -f2 || true; }

# probe_setup_link <log> <origin>: the web server serves the page of the last setup link, fetched without its fragment.
probe_setup_link() {
    local link path code
    link=$(grep -o 'https://[^ ]*#setup=[A-Za-z0-9_-]*' "$1" | tail -n 1 || true)
    path=${link#https://*/}
    path=${path%%#*}
    code=$(curl -sk -o /dev/null -w '%{http_code}' "$2/$path" || echo 000)
    if [ -n "$link" ] && [ "$code" = 200 ]; then
        ok "the setup link ${link%%#*}#… serves /$path (200)"
    else
        fail "the setup link '$link': /$path → $code, expected 200"
    fi
}

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

# admin_fields <password>: the /setup/complete fields that make $ADMIN_EMAIL, without the token.
admin_fields() {
    printf '"orgName":"Probe","storageType":"local-id","adminUsername":"%s","adminPassword":"%s","adminName":"Alice"' \
        "${ADMIN_EMAIL%@*}" "$1"
}

# The user ID of the session in $JAR.
session_user() { curl -sk -b "$JAR" "$BASE/auth/get-session" | grep -o '"userId":"[^"]*"' | head -n 1 | cut -d'"' -f4 || true; }

# create_admin <setup log> <password>: finishes the setup through the link in the log as $ADMIN_EMAIL, signs in
# into the cookie jar $JAR and sets ADMIN_ID; returns non-zero when a step fails.
create_admin() {
    local code
    read -r code _ <<<"$(setup_post complete "$(admin_fields "$2"),\"setupToken\":\"$(setup_token "$1")\"")"
    [ "$code" = 200 ] && [ "$(sign_in "$2" "$JAR")" = 200 ] || return 1
    ADMIN_ID=$(session_user)
    [ -n "$ADMIN_ID" ]
}

# api <method> <path> [json]: the body of an API call on $BASE as the signed-in admin.
api() {
    curl -sk -b "$JAR" -X "$1" -H 'Content-Type: application/json' -H 'Origin: https://localhost' ${3:+-d "$3"} \
        "$BASE$2" || true
}

# The first "id" of a JSON body on stdin.
first_id() { grep -o '"id":"[^"]*"' | head -n 1 | cut -d'"' -f4 || true; }

# collab_tab <web server service> <its origin inside its container> <doc ID> <kept> <edit>: a browser tab on the
# document over its collab WebSocket through that web server, as the admin in $JAR, from Bun in the API image. <kept>
# is what an open tab holds, epoch:Y.Doc, or empty for a fresh tab; <edit> is typed before it connects, as while
# offline. Prints "synced <kept> <text>" once the server has its state, or "closed <code> <reason>".
collab_tab() {
    local cookie
    cookie=$(awk -F'\t' 'NF >= 7 && ($1 !~ /^#/ || $1 ~ /^#HttpOnly_/) { printf "%s=%s; ", $6, $7 }' "$JAR")
    docker run --rm --network "container:$(dc ps -q "$1")" --entrypoint bun -e COOKIE="$cookie" -e KEPT="$4" \
        -e EDIT="$5" -e URL="$2/eigen/ws/collab/$ADMIN_ID/default/$3" "$EIGEN_API_IMAGE" -e '
            const Y = require("yjs");
            const encoding = require("lib0/encoding");
            const decoding = require("lib0/decoding");
            const sync = require("y-protocols/sync");
            const doc = new Y.Doc();
            const text = doc.getText("probe");
            let epoch = "";
            if (process.env.KEPT) {
                const [kept, state] = process.env.KEPT.split(":");
                epoch = kept;
                Y.applyUpdate(doc, Buffer.from(state, "base64"));
            }
            if (process.env.EDIT) text.insert(text.length, process.env.EDIT);
            const ws = new WebSocket(process.env.URL + (epoch ? `?epoch=${epoch}` : ""), {
                headers: { Cookie: process.env.COOKIE, Origin: "https://localhost" },
                tls: { rejectUnauthorized: false },
            });
            ws.binaryType = "arraybuffer";
            const step1 = () => {
                const encoder = encoding.createEncoder();
                encoding.writeVarUint(encoder, 0);
                sync.writeSyncStep1(encoder, doc);
                ws.send(encoding.toUint8Array(encoder));
            };
            ws.onopen = step1;
            let answers = 0;
            ws.onmessage = ({ data }) => {
                const decoder = decoding.createDecoder(new Uint8Array(data));
                const type = decoding.readVarUint(decoder);
                if (type === 100) epoch = decoding.readVarString(decoder);
                if (type !== 0) return;
                const encoder = encoding.createEncoder();
                encoding.writeVarUint(encoder, 0);
                // Answers sync step 1 of the server with what this tab has and the server lacks, as y-websocket does.
                const kind = sync.readSyncMessage(decoder, encoder, doc, null);
                if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
                if (kind !== 1) return;
                // The second answer comes after the server read the state this tab sent.
                if (++answers === 1) return step1();
                const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
                console.log(`synced ${epoch}:${state} ${text.toString()}`);
                process.exit(0);
            };
            ws.onclose = ({ code, reason }) => {
                console.log(`closed ${code} ${reason}`);
                process.exit(0);
            };
            setTimeout(() => {
                console.log("no sync in 15s");
                process.exit(1);
            }, 15000);
        ' 2>&1 || true
}

# scratch_run <command…>: runs as root in a docker:cli container that sees the scratch folder at its own path, and the
# checkout at /repo. Docker Desktop's file share shows every file as the host user, so the owner a container wrote is
# only visible from inside one; and on Linux the host user cannot read what root or another uid keeps to itself.
scratch_run() { docker exec "${SCRATCH_BOX:-}" "$@"; }

# scratch_box: starts scratch_run's container, replacing the one before. Named, so a subshell can replace it too. A
# worktree's .git names the repository's own, which git in the box reaches at the same path.
scratch_box() {
    local git_dir
    git_dir=$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)
    docker rm -f "$SCRATCH_BOX" >/dev/null 2>&1 || true
    docker run -d --name "$SCRATCH_BOX" --label eigen.harness=1 --label "eigen.harness.run=$RUN" \
        -v "$SCRATCH:$SCRATCH" -v "$REPO_ROOT:/repo:ro" -v "$git_dir:$git_dir:ro" --entrypoint tail "$CLI_IMAGE" \
        -f /dev/null >/dev/null
}

# git_run <args…>: git as root in the scratch folder.
git_run() { scratch_run git -c safe.directory='*' -c user.name=harness -c user.email=harness@eigen.invalid "$@"; }

# owner_mode <path>: its uid:gid and mode. While a container keeps the scratch folder mounted, Docker Desktop shows a
# file another uid wrote without a chown as root's, to every container; so the box is replaced first.
owner_mode() {
    scratch_box
    scratch_run stat -c '%u:%g %a' "$1"
}

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
# tags, dangling harness-labelled images, and the scratch folder.
harness_cleanup() {
    local code=$? project ids name key image
    if [ "${HARNESS_KEEP:-0}" = 1 ]; then
        log "HARNESS_KEEP=1: left $SCRATCH and the projects$HARNESS_PROJECTS"
        return "$code"
    fi
    for project in $HARNESS_PROJECTS; do down_project "$project"; done
    # data/ holds files owned by 1000 and root, which the host user cannot always delete.
    scratch_run find "$SCRATCH" -mindepth 1 -delete >/dev/null 2>&1 || true
    ids=$(docker ps -aq --filter "label=eigen.harness.run=$RUN")
    if [ -n "$ids" ]; then docker rm -f $ids >/dev/null || true; fi
    rm -rf "$SCRATCH"
    # Unset where a harness installs releases, which it pulls instead of building under these tags.
    for name in $IMAGES; do
        key=$(image_key "$name")
        image=${!key:-}
        if [ -n "$image" ]; then docker image rm "$image" "$image-next" >/dev/null 2>&1 || true; fi
    done
    docker image rm "$CLI_IMAGE" >/dev/null 2>&1 || true
    docker image prune -f --filter label=eigen.harness=1 >/dev/null 2>&1 || true
    return "$code"
}

# probe <what> <URL> <status> [body pattern]
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
    # 401 is the auth gate, so the upgrade reached the API; a 404 means it arrived as a plain GET.
    if [ "$got_code" = "401" ]; then
        ok "$desc → 401 (auth, upgrade pass-through OK)"
    else
        fail "WS at $url → $got_code, expected 401"
    fi
}

# probe_site <origin>: /eigen/health, the landing page, three apps with their own bundles, and the WebSocket upgrade.
probe_site() {
    probe "/eigen/health" "$1/eigen/health" 200 "OK"
    probe "/ (landing)" "$1/" 200
    probe "/mail/" "$1/mail/" 200 '"/mail/assets/'
    probe "/sheets/" "$1/sheets/" 200 '"/sheets/assets/'
    probe "/admin/" "$1/admin/" 200 '"/admin/assets/'
    probe_ws "WS /eigen/ws/collab/..." "$1/eigen/ws/collab/x/y/z"
}

# The 220 banner, which also proves postfix reached unbound, the part that breaks when EIGEN_SUBNET and EIGEN_UNBOUND_IP
# disagree. Retried: postfix has no healthcheck, so up --wait returns before it accepts.
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

# The ad flag on a signed domain: unbound's trust anchor holds and it reaches the root servers.
probe_dnssec() {
    local flags=""
    for _ in 1 2 3 4 5; do
        flags=$(dc exec -T unbound drill -D @127.0.0.1 cloudflare.com 2>/dev/null | grep -m1 'flags:' || true)
        echo "$flags" | grep -q ' ad ' && break
        sleep 1
    done
    if echo "$flags" | grep -q ' ad '; then
        ok "unbound validates DNSSEC (ad flag)"
    else
        fail "unbound answered without the ad flag: '$flags'"
    fi
}

# The IMAPS greeting; `a logout` keeps openssl connected until it arrives.
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

# The tally, and the script's exit: 0 when nothing failed, 1 otherwise. Callers print their own "Result" header first.
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
