#!/usr/bin/env bash
# The interactive side of ./eigen, typed through a terminal by expect: the launcher runs under BusyBox sh in the
# no-Bun docker:cli container, reached with docker exec -it, so both it and the CLI see a terminal. On a scratch
# checkout: Ctrl-C at the first setup question, setup answering every question with hosted mail, reset-password typed
# twice, restore answered no and yes, the rollback question answered no, Ctrl-C while a restore unpacks, a setup rerun
# without mail behind a web server, ./eigen update from a remote one commit ahead, and Ctrl-C under the build spinner.
# Asserts on exit codes, files and the stack, not the screen.
#
# Usage:  ./docker/test-interactive.sh
# Needs:  docker, curl, git, expect. Builds every image in Docker (a few minutes on a cold cache).

set -euo pipefail

. "$(dirname "$0")/probe-lib.sh"

command -v expect >/dev/null || { echo "harness: expect is not installed" >&2; exit 1; }

VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO_ROOT/package.json" | head -n 1)
ADMIN_EMAIL=alice@eigen.test
OLD_PASSWORD="probe-old-$$"
NEW_PASSWORD="probe-new-$$"
RELAY_PASSWORD="relay-secret-$$"

scratch_init interactive
new_install "eigentest-interactive-$$" 0:0
write_override
free_port PORT_STATIC
BASE="https://localhost:$PORT_HTTPS/eigen"
JAR="$SCRATCH/session"

# The terminal: a docker:cli container that outlives each command, so what a command leaves running shows in its ps.
TERMINAL=$(docker run -d --init --label eigen.harness=1 --label "eigen.harness.run=$RUN" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$SCRATCH:$SCRATCH" \
    -e EIGEN_API_IMAGE -e EIGEN_FRONTEND_IMAGE -e EIGEN_POSTFIX_IMAGE -e EIGEN_DOVECOT_IMAGE -e EIGEN_ALLOW_ARCH \
    -e HARNESS_PRUNE_LOG="$PRUNE_LOG" --entrypoint tail "$CLI_IMAGE" -f /dev/null)

# type_into <name> <launcher args…>: ./eigen in the terminal, driven by the expect lines on stdin, which read their
# values from the environment. Its screen goes to $SCRATCH/<name>.log; sets CODE and SCREEN (that file).
type_into() {
    local name="$1"
    shift
    SCREEN="$SCRATCH/$name.log"
    {
        cat <<'EOF'
set timeout 900
set stty_init "rows 40 cols 100"
log_user 0
log_file -a -noappend $env(SCREEN)
proc stuck {what} { puts stderr "expect: $what"; exit 124 }
proc question {text} { expect -ex $text {} timeout { stuck "no '$text'" } eof { stuck "ended before '$text'" } }
# Ctrl-U clears the suggested answer first.
proc answer {text value} { question $text; send -- "\025"; send -- "$value\r" }
spawn -noecho {*}$argv
EOF
        cat
        cat <<'EOF'
expect eof {} timeout { stuck "no end" }
exit [lindex [wait] 3]
EOF
    } >"$SCRATCH/$name.exp"
    CODE=0
    SCREEN="$SCREEN" expect "$SCRATCH/$name.exp" docker exec -it -e TERM=xterm-256color -w "$INSTALL" "$TERMINAL" \
        ./eigen "$@" || CODE=$?
}

# The last lines of $SCREEN without escape codes, for a failure.
screen_tail() { tr -d '\r' <"$SCREEN" | sed $'s/\033\\[[0-9;?]*[A-Za-z]//g' | grep . | tail -n 8 | sed 's/^/    │ /'; }

env_of() { scratch_run sed -n "s/^$1=//p" "$INSTALL/.env.production" | tail -n 1; }

# What still runs in the terminal besides its own tail and ps, and the maintenance git detaches after a fetch.
leftovers() {
    docker exec "$TERMINAL" ps -o pid,args |
        awk 'NR > 1 && $2 != "tail" && $2 != "ps" && $2 !~ /init$/ && $2 !~ /git-core/' | tr '\n' ';'
}

aside_count() { (cd "$INSTALL" && ls -d data.pre-restore-* 2>/dev/null | wc -l | tr -d ' '); }

folder() {
    api POST "/drive/$ADMIN_ID/default/folder/$ROOT_ID" "{\"folderName\":\"$1\"}" >/dev/null
}
has_folder() { api GET "/drive/$ADMIN_ID/default/folder/$ROOT_ID" | grep -q "\"$1\""; }

##############################################################################
header "Ctrl-C at the first setup question"
##############################################################################
type_into setup-cancel setup <<'EOF'
question "Where will Eigen be hosted?"
send -- "\003"
EOF
if [ "$CODE" = 130 ]; then
    ok "Ctrl-C at the first question exits 130"
else
    fail "Ctrl-C at the first question: exit $CODE"
fi
# Setup makes an empty one for Compose before the build.
written=$(scratch_run cat "$INSTALL/.env.production" 2>/dev/null || true)
if [ -z "$written" ] && [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]; then
    ok "no configuration is written and nothing started"
else
    fail "after Ctrl-C at the first question .env.production holds: $(printf '%s' "$written" | tr '\n' ' ')"
fi
# The build spinner redraws its two lines in place: glyph, step and elapsed time, and the build's current line.
if grep -q $'\r\033\\[K\033\\[1A\r\033\\[K' "$SCREEN" && grep -q 'Building Eigen\.\.\.' "$SCREEN" &&
    grep -Eq '[◒◐◓◑].*Building Eigen\.\.\..*[0-9]+s' "$SCREEN" && grep -q $'│  [^\033]' "$SCREEN" &&
    grep -q '◇.*Eigen built' "$SCREEN"; then
    ok "the build runs under the spinner, with its elapsed time and current line, and ends in one line"
else
    fail "no spinner redraw in $SCREEN"
fi

##############################################################################
header "Setup, every question answered, with hosted mail and a relay"
##############################################################################
export RELAY_PASSWORD
type_into setup-mail setup <<'EOF'
answer "Where will Eigen be hosted?" localhost
answer "Which mail domain will you use?" eigen.test
question "How do people reach Eigen over HTTPS?"
send -- "\r"
answer "Which email address should Let's Encrypt use?" admin@eigen.test
question "Host email on this server?"
send -- "y"
answer "Which mail relay should Eigen send through" smtp.relay.invalid:2525
answer "What is the relay's user name?" relayuser
answer "What is the relay's password?" $env(RELAY_PASSWORD)
answer "Which address should Eigen's own mail come from?" "Eigen <noreply@eigen.test>"
EOF
if [ "$CODE" = 0 ]; then
    ok "interactive setup with mail finishes (exit 0)"
else
    fail "interactive setup with mail: exit $CODE"
    screen_tail
fi
got="$(env_of DOMAIN) $(env_of MAIL_DOMAIN) $(env_of ACME_EMAIL) $(env_of COMPOSE_PROFILES) $(env_of MAIL_ENABLED)"
got="$got $(env_of SMTP_RELAY_HOST):$(env_of SMTP_RELAY_PORT) $(env_of SMTP_RELAY_USER)"
if [ "$got" = "localhost eigen.test admin@eigen.test edge,mail 1 smtp.relay.invalid:2525 relayuser" ] &&
    [ "$(env_of SMTP_RELAY_PASSWORD | tr -d "'\"")" = "$RELAY_PASSWORD" ] &&
    env_of SMTP_FROM | grep -q 'Eigen <noreply@eigen.test>'; then
    ok ".env.production has every answer"
else
    fail ".env.production: $got"
fi
if grep -q "$RELAY_PASSWORD" "$SCREEN"; then
    fail "the relay password shows on screen"
else
    ok "the relay password does not show on screen"
fi
if stack_up && [ "$(dc ps --services | sort | tr '\n' ' ')" = 'caddy dovecot eigen-api postfix unbound ' ]; then
    ok "caddy, eigen-api, postfix, dovecot and unbound run"
else
    fail "services after the mail setup: $(dc ps --services | tr '\n' ' ')"
fi
if create_admin "$SCREEN" "$OLD_PASSWORD"; then
    ok "the link on screen makes $ADMIN_EMAIL"
    ROOT_ID=$(api GET "/drive/$ADMIN_ID/default/root" | grep -o '"id":"[^"]*"' | head -n 1 | cut -d'"' -f4)
else
    fail "the setup link on screen made no admin"
    header "Result"
    probe_summary
fi

##############################################################################
header "reset-password, typed and confirmed"
##############################################################################
export NEW_PASSWORD
type_into reset-password reset-password "$ADMIN_EMAIL" <<'EOF'
answer "New password for" $env(NEW_PASSWORD)
answer "Again, to confirm" "$env(NEW_PASSWORD)x"
question "The two passwords differ."
send -- "\025"
send -- "$env(NEW_PASSWORD)\r"
EOF
if [ "$CODE" = 0 ] && [ "$(sign_in "$OLD_PASSWORD" "$SCRATCH/old")" = 401 ] &&
    [ "$(sign_in "$NEW_PASSWORD" "$JAR")" = 200 ]; then
    ok "a mistyped confirmation is asked again; then the new password signs in and the old one does not"
else
    fail "reset-password: exit $CODE"
fi
if grep -q "$NEW_PASSWORD" "$SCREEN"; then
    fail "the password shows on screen"
else
    ok "the password does not show on screen"
fi

##############################################################################
header "restore and rollback questions"
##############################################################################
eigen backup
SNAPSHOT=$(printf '%s\n' "$OUT" | grep -o 'eigen-[0-9]\{8\}-[0-9]\{6\}\.tar\.gz' | head -n 1 || true)
if [ "$CODE" = 0 ] && [ -n "$SNAPSHOT" ]; then
    ok "./eigen backup saved $SNAPSHOT"
else
    fail "./eigen backup: exit $CODE"
    show
fi
folder "Made after the snapshot"
started=$(api_started)
export SNAPSHOT
type_into restore-no restore "$SNAPSHOT" <<'EOF'
question "Replace data/"
send -- "n"
EOF
if [ "$CODE" = 0 ] && [ "$(api_started)" = "$started" ] && has_folder "Made after the snapshot" &&
    [ "$(aside_count)" = 0 ]; then
    ok "restore answered no exits 0 and changes nothing"
else
    fail "restore answered no: exit $CODE"
fi
type_into restore-yes restore "$SNAPSHOT" <<'EOF'
question "Replace data/"
send -- "y"
EOF
if [ "$CODE" = 0 ] && stack_up && ! has_folder "Made after the snapshot" && [ "$(aside_count)" = 1 ]; then
    ok "restore answered yes puts the snapshot back and keeps the old data aside"
else
    fail "restore answered yes: exit $CODE"
fi

# A pointer as an update leaves it, to the snapshot just made: the question is the same after a real update.
commit=$(docker run --rm -v "$SCRATCH:$SCRATCH" --entrypoint git "$CLI_IMAGE" -c safe.directory='*' -C "$INSTALL" \
    rev-parse --short HEAD)
scratch_run sh -c 'printf "%s\n" "$2" "$3" "$4" >"$1/.eigen/last-update"' sh "$INSTALL" "$SNAPSHOT" "$VERSION" "$commit"
started=$(api_started)
type_into rollback-no rollback <<'EOF'
question "Replace data/"
send -- "n"
EOF
if [ "$CODE" = 0 ] && [ "$(api_started)" = "$started" ] && [ -e "$INSTALL/.eigen/last-update" ] &&
    [ "$(aside_count)" = 1 ]; then
    ok "rollback answered no exits 0 and changes nothing"
else
    fail "rollback answered no: exit $CODE"
fi
skip "rollback answered yes: the same question; test-update.sh and test-release.sh run the rollback itself"
scratch_run rm "$INSTALL/.eigen/last-update"

# Big enough that the restore is still unpacking when Ctrl-C lands.
scratch_run sh -c 'head -c 300000000 /dev/urandom >"$1"' sh "$INSTALL/data/ballast.bin"
eigen backup
BIG=$(printf '%s\n' "$OUT" | grep -o 'eigen-[0-9]\{8\}-[0-9]\{6\}\.tar\.gz' | head -n 1 || true)
scratch_run rm "$INSTALL/data/ballast.bin"
folder "Made before the interrupted restore"
started=$(api_started)
export BIG INSTALL
type_into restore-cancel restore "$BIG" <<'EOF'
question "Replace data/"
send -- "y"
for {set i 0} {$i < 600 && ![file isdirectory "$env(INSTALL)/.eigen/restore"]} {incr i} { after 100 }
send -- "\003"
EOF
if [ "$CODE" = 130 ] && [ "$(api_started)" = "$started" ] && has_folder "Made before the interrupted restore" &&
    [ ! -e "$INSTALL/data/ballast.bin" ] && [ "$(aside_count)" = 1 ] && [ ! -e "$INSTALL/.eigen/restore" ]; then
    ok "Ctrl-C while the restore unpacks exits 130; Eigen ran on, on its data, and the unpacked copy is gone"
else
    fail "Ctrl-C during the restore: exit $CODE"
    screen_tail
fi
scratch_run rm "$INSTALL/snapshots/$BIG"

##############################################################################
header "Setup rerun: no mail, behind the operator's web server"
##############################################################################
export PORT_STATIC
type_into setup-proxy setup <<'EOF'
answer "Where will Eigen be hosted?" localhost
answer "Which mail domain will you use?" eigen.test
question "How do people reach Eigen over HTTPS?"
send -- "\033\[B"
send -- "\r"
answer "Where should Eigen listen for your web server" 127.0.0.1:$env(PORT_STATIC)
question "Host email on this server?"
send -- "n"
answer "Which mail relay should Eigen send through" ""
EOF
if [ "$CODE" = 0 ]; then
    ok "the rerun finishes (exit 0)"
else
    fail "the rerun: exit $CODE"
    screen_tail
fi
got="$(env_of COMPOSE_PROFILES) $(env_of MAIL_ENABLED) $(env_of EIGEN_STATIC_HOST):$(env_of EIGEN_STATIC_PORT)"
got="$got [$(env_of SMTP_RELAY_HOST)]"
if [ "$got" = "static 0 127.0.0.1:$PORT_STATIC []" ] && [ -f "$INSTALL/eigen.nginx.conf" ]; then
    ok ".env.production has the static profile, no mail and no relay; the web server snippets are written"
else
    fail ".env.production after the rerun: $got"
fi
if stack_up && [ "$(dc ps -a --services | sort | tr '\n' ' ')" = 'eigen-api eigen-static ' ] &&
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_STATIC/eigen/health" || true)" = 200 ]; then
    ok "only eigen-api and eigen-static run, and 127.0.0.1:$PORT_STATIC answers"
else
    fail "services after the rerun: $(dc ps -a --services | tr '\n' ' ')"
fi

##############################################################################
header "update on a terminal"
##############################################################################
git_in() {
    docker run --rm -v "$SCRATCH:$SCRATCH" --entrypoint git "$CLI_IMAGE" -c safe.directory='*' -c user.name=harness \
        -c user.email=harness@eigen.invalid "$@"
}
# A remote one commit ahead, outside the build context, so the build is cached.
git_in clone -q --bare "$INSTALL" "$SCRATCH/remote.git"
git_in clone -q "$SCRATCH/remote.git" "$SCRATCH/work"
scratch_run sh -c 'echo "One more line." >>"$1/docs/TESTING.md"' sh "$SCRATCH/work"
git_in -C "$SCRATCH/work" commit -qam "docs: one more line"
git_in -C "$SCRATCH/work" push -q
git_in -C "$INSTALL" remote add origin "$SCRATCH/remote.git"
git_in -C "$INSTALL" fetch -q origin
git_in -C "$INSTALL" branch -q --set-upstream-to "origin/$(git_in -C "$INSTALL" rev-parse --abbrev-ref HEAD)"
NEW=$(git_in -C "$SCRATCH/work" rev-parse --short HEAD)
type_into update update </dev/null
revision=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$(docker inspect --format '{{.Image}}' "$(dc ps -q eigen-api)")")
if [ "$CODE" = 0 ] && [ "$revision" = "$NEW" ] && [ -e "$INSTALL/.eigen/last-update" ] && stack_up; then
    ok "./eigen update on a terminal pulls, builds and runs $NEW"
else
    fail "./eigen update on a terminal: exit $CODE, eigen-api runs $revision, expected $NEW"
    screen_tail
fi

##############################################################################
header "Ctrl-C under the build spinner"
##############################################################################
# A build step that outlasts the interrupt, in this scratch checkout only.
scratch_run sh -c 'echo "RUN sleep 600" >>"$1/docker/api/Dockerfile"' sh "$INSTALL"
started=$(api_started)
image=$(docker image inspect --format '{{.Id}}' "$EIGEN_API_IMAGE")
env_before=$(scratch_run cat "$INSTALL/.env.production")
type_into build-cancel setup <<'EOF'
question "RUN sleep 600"
send -- "\003"
EOF
if [ "$CODE" = 130 ] && grep -q 'Building Eigen: cancelled.' "$SCREEN"; then
    ok "Ctrl-C mid-build exits 130"
else
    fail "Ctrl-C mid-build: exit $CODE"
    screen_tail
fi
left=$(leftovers)
if [ -z "$left" ]; then ok "no process of the launcher is left running"; else fail "left running: $left"; fi
if [ "$(api_started)" = "$started" ] && stack_up &&
    [ "$(docker image inspect --format '{{.Id}}' "$EIGEN_API_IMAGE")" = "$image" ] &&
    [ "$(scratch_run cat "$INSTALL/.env.production")" = "$env_before" ]; then
    ok "the stack, its image and .env.production are as they were"
else
    fail "the cancelled build changed the stack, its image or .env.production"
fi

header "Result"
probe_summary
