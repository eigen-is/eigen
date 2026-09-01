#!/usr/bin/env bash
# Verify the outbound mail-relay hardening (2026-08-31 spam-incident fixes) against a running
# local stack: sender/login binding on the submission ports, the per-IP SASL failure lockout, and
# the queue-backlog alert.
#
# Usage:
#   ALICE_EMAIL=admin@eigen.is ALICE_PASSWORD='...' ./docker/test-mail-hardening.sh
#   PROBES=2,3,4 ALICE_EMAIL=... ALICE_PASSWORD=... ./docker/test-mail-hardening.sh   # subset
#   KEEP_STACK=1 ...                                                                # leave it up
#
# Needs:  docker, openssl, nc, and a `.env.production` whose MAIL_DOMAIN matches the accounts
#         already in ./data. The script never creates accounts, it logs in as a real one. A host
#         dev API on :8000 is fine to leave running: eigen-api has no host port binding. Without
#         ALICE_EMAIL/ALICE_PASSWORD the probes that need a login are skipped and the rest still run.
#
# The dev overlay pins postfix and dovecot to MAIL_DOMAIN=localhost, so Postfix's own mail domain
# can differ from the account's domain. The sender/login binding does not care: it compares the
# login with the envelope sender, whatever the domain is.
#
# LOCAL DEV ONLY: probe 7 sets `defer_transports=smtp`, seeds queue files, and deletes the whole
# Postfix queue afterwards. Never point this at a production stack.
#
# No message is ever delivered: the submission dialogs stop at RCPT TO and never send DATA.
#
# Runtime is about 6 minutes: probe 9 paces itself under Postfix's anvil AUTH cap and probe 7 waits
# for the queue monitor's next interval; everything else is quick. A PROBES subset that names any
# login probe also runs probe 1, which is what proves the credentials.

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0
SKIP=0
FAIL_LINES=()

log()    { printf '  %s\n' "$*"; }
header() { printf '\n=== %s ===\n' "$*"; }
ok()     { log "✓ $*"; PASS=$((PASS+1)); }
fail()   { log "✗ $*"; FAIL=$((FAIL+1)); FAIL_LINES+=("$*"); }
skip()   { log "– skipped: $*"; SKIP=$((SKIP+1)); }

oneline() { printf '%s' "$1" | tr '\r\n' '  '; }

dc() {
    docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production "$@"
}

# Only run the probes named in PROBES (default: all).
should_run() {
    [ -z "${PROBES:-}" ] && return 0
    case ",${PROBES}," in *,"$1",*) return 0 ;; *) return 1 ;; esac
}

# Why a login probe did not run. Deselecting it and having no credentials are different things, and
# reporting the wrong one sends the reader hunting for a broken password that works fine.
skip_login_probe() {
    if should_run "$1"; then
        skip "probe $1 (needs a working login)"
    else
        skip "probe $1 not selected"
    fi
}

# --- SMTP dialog helpers ---------------------------------------------------------------------
# `-quiet` implies `-ign_eof`, so s_client keeps reading until the server closes after QUIT;
# `-crlf` turns the \n in our scripted dialogs into the CRLF the protocol requires.
smtp465() {
    printf '%b' "$1" | openssl s_client -connect localhost:465 -quiet -crlf 2>/dev/null
}

smtp25() {
    printf '%b' "$1" | nc -w 10 localhost 25 2>/dev/null
}

auth_plain() {
    printf '\000%s\000%s' "$1" "$2" | base64 | tr -d '\n'
}

# The failure limiter is in-memory, so the probes below restart eigen-api to reset it. Wait for it
# to serve again before continuing, or the next dialog fails for the wrong reason.
wait_api() {
    for _ in $(seq 1 30); do
        dc exec -T eigen-api curl -sf http://localhost:8000/health >/dev/null 2>&1 && return 0
        sleep 1
    done
    return 1
}

# Postfix has no healthcheck, so `up --wait` returns while it is still starting and the first
# dialog would land on a closed port. Wait for the real banner instead.
wait_smtps() {
    local banner
    for _ in $(seq 1 60); do
        banner=$(printf 'QUIT\n' | openssl s_client -connect localhost:465 -quiet -crlf 2>/dev/null | head -1 || true)
        printf '%s' "$banner" | grep -q '^220 ' && return 0
        sleep 1
    done
    return 1
}

HELO_NAME=probe.eigen.local
RCPT_PROBE=rcpt-probe@example.com

# One AUTH per connection, and QUIT only goes out after the reply has had time to arrive. Writing
# the whole dialog in one shot (AUTH then QUIT, no pause) disconnects while the dovecot request is
# still in flight, and postfix abandons it: dovecot logs "auth client disconnected with 1 pending
# requests: EOF" and the attempt never reaches the API. Measured 15 of 60 lost that way, and the
# loss scales with the spray, so no larger spray fixes it. The generator subshell holds the pipe
# open across the pause; callers then count the 535s they actually got, so a lost attempt is
# reported rather than quietly shrinking the spray. (A read-driven dialog would need `coproc`,
# which macOS's stock bash 3.2 does not have.)
auth_once() {
    local auth="$1"
    {
        printf 'EHLO %s\n' "$HELO_NAME"
        printf 'AUTH PLAIN %s\n' "$auth"
        sleep 2
        printf 'QUIT\n'
    } | openssl s_client -connect localhost:465 -quiet -crlf 2>/dev/null || true
}

# Postfix caps AUTH commands per client IP per 60s (smtpd_client_auth_rate_limit=20), and every
# connection here comes from the same host address, so probe 9's run of failures holds itself to 18
# per window. Measured on the clock, so the dialogs' own duration counts toward the window and only
# the shortfall is slept off.
ANVIL_BUDGET=18
anvil_window_start=$SECONDS
anvil_sent=0

anvil_pace() {
    anvil_sent=$((anvil_sent + 1))
    if [ "$anvil_sent" -lt "$ANVIL_BUDGET" ]; then return 0; fi
    local elapsed=$((SECONDS - anvil_window_start))
    if [ "$elapsed" -lt 62 ]; then
        log "  $1 sent; waiting $((62 - elapsed))s out of the anvil window..."
        sleep $((62 - elapsed))
    fi
    anvil_window_start=$SECONDS
    anvil_sent=0
}

anvil_reset() {
    anvil_window_start=$SECONDS
    anvil_sent=0
}

# Make room for N more AUTH commands in the current window, sleeping out its remainder only when
# the budget would otherwise be exceeded. Probe 10 runs right after probe 9 has spent most of a
# window, and a 450 there would look like a limiter failure instead of a pacing one.
anvil_reserve() {
    if [ $((anvil_sent + $1)) -le "$ANVIL_BUDGET" ]; then
        anvil_sent=$((anvil_sent + $1))
        return 0
    fi
    local elapsed=$((SECONDS - anvil_window_start))
    if [ "$elapsed" -lt 62 ]; then
        log "  waiting $((62 - elapsed))s for the anvil window before $1 more AUTH commands..."
        sleep $((62 - elapsed))
    fi
    anvil_window_start=$SECONDS
    anvil_sent="$1"
}

# One authenticated submission dialog, asserting whether the envelope sender is accepted.
# `smtpd_delay_reject = yes` defers sender restrictions to RCPT TO, so the 553 lands on the RCPT
# reply, not the MAIL FROM reply — assert against the whole transcript.
probe_submission() {
    local desc="$1" login="$2" password="$3" sender="$4" expect="$5"
    local auth transcript
    auth=$(auth_plain "$login" "$password")
    transcript=$(smtp465 "EHLO $HELO_NAME\nAUTH PLAIN $auth\nMAIL FROM:<$sender>\nRCPT TO:<$RCPT_PROBE>\nQUIT\n") || true

    if ! printf '%s\n' "$transcript" | grep -q '^235'; then
        fail "$desc — AUTH itself failed (no 235): $(oneline "$transcript")"
        return
    fi
    if [ "$expect" = accept ]; then
        if printf '%s\n' "$transcript" | grep -q '^5'; then
            fail "$desc — expected acceptance, got a 5xx: $(oneline "$transcript")"
        else
            ok "$desc → accepted"
        fi
    elif printf '%s\n' "$transcript" | grep -q '^553'; then
        ok "$desc → 553 rejected"
    else
        fail "$desc — expected 553 sender rejection: $(oneline "$transcript")"
    fi
}

# --- prerequisites ---------------------------------------------------------------------------

if [ ! -f .env.production ]; then
    echo ".env.production missing — see docker/LOCAL-TESTING.md" >&2
    exit 1
fi
set -a; source .env.production; set +a
MAIL_DOMAIN="${MAIL_DOMAIN:-$DOMAIN}"

ALICE_EMAIL="${ALICE_EMAIL:-}"
ALICE_PASSWORD="${ALICE_PASSWORD:-}"
# A same-domain address the login does NOT own. It need not exist: the login/sender map is
# consulted for the sender address, not the mailbox.
SENDER_OTHER="${SENDER_OTHER:-someone-else@$MAIL_DOMAIN}"
SENDER_FOREIGN="${SENDER_FOREIGN:-anne@pobox.com}"

# The queue probe needs a threshold the seeded mail can cross. Exported before `up` because
# queue-monitor.sh reads its environment once, at container start.
export QUEUE_ALERT_THRESHOLD="${QUEUE_ALERT_THRESHOLD:-3}"
export QUEUE_CHECK_INTERVAL="${QUEUE_CHECK_INTERVAL:-10}"

cleanup() {
    # Only undo what probe 7 did. Without the flag a PROBES=2,3 run would wipe a queue it never
    # touched.
    if [ "${STACK_UP:-0}" = 1 ] && [ "${QUEUE_PROBE_RAN:-0}" = 1 ]; then
        dc exec -T postfix sh -c 'postconf -e defer_transports= && postfix reload && postsuper -d ALL' \
            >/dev/null 2>&1 || true
    fi
    if [ "${KEEP_STACK:-0}" != 1 ]; then
        COMPOSE_PROFILES=edge,static,mail dc down --remove-orphans >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

header "Bringing up edge,mail (MAIL_DOMAIN=$MAIL_DOMAIN)"
COMPOSE_PROFILES=edge,mail dc up -d --build --wait >/dev/null 2>&1 || {
    log "× compose failed; recent logs:"
    dc logs --tail=30
    exit 1
}
STACK_UP=1
log "up (queue alert threshold $QUEUE_ALERT_THRESHOLD, checked every ${QUEUE_CHECK_INTERVAL}s)"
if wait_smtps; then
    log "postfix is answering on :465"
else
    log "✗ postfix never answered on :465 within 60s; look at: dc logs postfix"
    exit 1
fi

# Login probes. Probe 1 is what proves the credentials and sets HAVE_LOGIN, so it is not optional
# when one of these is selected: excluding it would skip every login probe and still print green.
LOGIN_PROBES="2 3 4 5 9 10"
NEEDS_LOGIN=0
for p in $LOGIN_PROBES; do
    if should_run "$p"; then NEEDS_LOGIN=1; fi
done

##############################################################################
header "Probe 1 — credential sanity (/internal/auth/verify)"
##############################################################################
HAVE_LOGIN=0
if ! should_run 1 && [ "$NEEDS_LOGIN" = 0 ]; then
    skip "probe 1 not selected"
elif [ -z "$ALICE_EMAIL" ] || [ -z "$ALICE_PASSWORD" ]; then
    skip "ALICE_EMAIL / ALICE_PASSWORD not set — every login probe will be skipped"
else
    code=$(dc exec -T eigen-api curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' \
        -d "{\"email\":\"$ALICE_EMAIL\",\"password\":\"$ALICE_PASSWORD\"}" \
        http://localhost:8000/internal/auth/verify | tr -d '\r')
    if [ "$code" = "200" ]; then
        HAVE_LOGIN=1
        ok "the API accepts $ALICE_EMAIL"
    else
        fail "the API rejected $ALICE_EMAIL → HTTP $code (wrong password, or no such account in ./data)"
    fi
fi

##############################################################################
header "Probe 2 — own sender is still accepted (regression guard)"
##############################################################################
if should_run 2 && [ "$HAVE_LOGIN" = 1 ]; then
    probe_submission "AUTH $ALICE_EMAIL + MAIL FROM <$ALICE_EMAIL>" \
        "$ALICE_EMAIL" "$ALICE_PASSWORD" "$ALICE_EMAIL" accept
else
    skip_login_probe 2
fi

##############################################################################
header "Probe 3 — same-domain forged sender is rejected"
##############################################################################
if should_run 3 && [ "$HAVE_LOGIN" = 1 ]; then
    probe_submission "AUTH $ALICE_EMAIL + MAIL FROM <$SENDER_OTHER>" \
        "$ALICE_EMAIL" "$ALICE_PASSWORD" "$SENDER_OTHER" reject
else
    skip_login_probe 3
fi

##############################################################################
header "Probe 4 — foreign forged sender is rejected (the incident shape)"
##############################################################################
if should_run 4 && [ "$HAVE_LOGIN" = 1 ]; then
    probe_submission "AUTH $ALICE_EMAIL + MAIL FROM <$SENDER_FOREIGN>" \
        "$ALICE_EMAIL" "$ALICE_PASSWORD" "$SENDER_FOREIGN" reject
else
    skip_login_probe 4
fi

##############################################################################
header "Probe 5 — mixed-case login still owns its lowercase address"
##############################################################################
# The login/sender comparison must be case-insensitive, or every client that stores the address
# capitalised breaks. If this one fails, the fix is a /i pattern in sender_login.regexp plus
# lowercasing in eigen-checkpassword.
if should_run 5 && [ "$HAVE_LOGIN" = 1 ]; then
    MIXED_LOGIN=$(printf '%s' "$ALICE_EMAIL" | tr '[:lower:]' '[:upper:]')
    probe_submission "AUTH $MIXED_LOGIN + MAIL FROM <$ALICE_EMAIL>" \
        "$MIXED_LOGIN" "$ALICE_PASSWORD" "$ALICE_EMAIL" accept
else
    skip_login_probe 5
fi

##############################################################################
header "Probe 6 — inbound port 25 never rejects a foreign sender"
##############################################################################
# The sender/login rule lives on the submission services only. If it ever leaks into main.cf,
# every message from the internet is refused, so this probe is the canary: a 553 here is the
# failure. The recipient uses Postfix's own mydomain, which in the dev overlay is `localhost`
# whatever MAIL_DOMAIN says, so a 550 unknown-user reply is fine. Sender restrictions run before
# recipient restrictions, so a leak would show up as a 553 first either way.
if should_run 6; then
    postfix_domain=$(dc exec -T postfix postconf -h mydomain | tr -d '\r')
    transcript=$(smtp25 "EHLO $HELO_NAME\nMAIL FROM:<$SENDER_FOREIGN>\nRCPT TO:<probe@$postfix_domain>\nQUIT\n") || true
    if printf '%s\n' "$transcript" | grep -q '^553'; then
        fail "inbound MAIL FROM <$SENDER_FOREIGN> got a 553 sender rejection: $(oneline "$transcript")"
    elif printf '%s\n' "$transcript" | grep -q '^250 2\.1\.5'; then
        ok "inbound <$SENDER_FOREIGN> → <probe@$postfix_domain> accepted"
    else
        ok "inbound sender accepted; the recipient reply was: $(oneline "$transcript")"
    fi
else
    skip "probe 6 not selected"
fi

##############################################################################
header "Probe 7 — queue backlog raises an admin-alert notification"
##############################################################################
# Newest admin-alert notification across all homes, as a unix timestamp (0 when there is none).
# The alert coalesces on one tag, so a rerun updates that row instead of adding one: the stamp is
# what moves, not the count. Read from INSIDE the API container, because on Docker Desktop the
# host's view of the bind mount lags behind the container's writes.
admin_alert_stamp() {
    dc exec -T eigen-api bun -e '
const { readdirSync, existsSync } = require("node:fs");
const { Database } = require("bun:sqlite");
const base = "/app/data/home";
let newest = 0;
for (const dir of readdirSync(base)) {
    const path = base + "/" + dir + "/eigen.notifications/notifications.db";
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    const row = db.query("select max(createdAt) as t from notifications where type = ?").get("admin-alert");
    if (row && row.t > newest) newest = row.t;
    db.close();
}
console.log(newest);
' 2>/dev/null | tr -dc '0-9'
}

if should_run 7; then
    QUEUE_PROBE_RAN=1
    before=$(admin_alert_stamp)
    # Restart postfix so queue-monitor.sh starts fresh: it holds its alert cooldown in memory, and
    # a rerun against a kept stack would otherwise still be inside that 6 hour window.
    dc restart postfix >/dev/null 2>&1
    # defer_transports parks every outbound message in the deferred queue without a delivery
    # attempt, so the backlog is deterministic instead of DNS-timing dependent.
    dc exec -T postfix sh -c 'postconf -e defer_transports=smtp && postfix reload' >/dev/null 2>&1
    for i in 1 2 3 4 5; do
        dc exec -T postfix sh -c \
            "printf 'Subject: queue probe\n\nprobe\n' | sendmail -f postmaster@$MAIL_DOMAIN queue-probe-$i@example.com" \
            >/dev/null 2>&1
    done
    # Locally submitted mail waits in maildrop until the pickup service runs, and neither the
    # monitor nor this count looks there, so the first snapshot can still read 0.
    sleep 5
    queued=$(dc exec -T postfix sh -c \
        'find /var/spool/postfix/incoming /var/spool/postfix/active /var/spool/postfix/deferred -type f | wc -l' \
        | tr -dc '0-9')
    log "queue holds $queued messages (threshold $QUEUE_ALERT_THRESHOLD)"

    after="$before"
    for _ in $(seq 1 12); do
        sleep 10
        after=$(admin_alert_stamp)
        [ "${after:-0}" -gt "${before:-0}" ] && break
    done
    if [ "${after:-0}" -gt "${before:-0}" ]; then
        ok "queue-monitor.sh alerted and the admin-alert notification was written"
    else
        fail "no admin-alert notification within 120s (queue=$queued); look at: dc logs postfix"
    fi
else
    skip "probe 7 not selected"
fi

##############################################################################
header "Probe 8 — per-IP SASL failure lockout"
##############################################################################
# The route-level half of the story: drive it with a synthetic IP so the lockout is observable
# without locking this host out. Probe 10 proves the real SMTP path actually delivers a client IP.
if should_run 8; then
    code=$(dc exec -T eigen-api sh -c '
for i in $(seq 1 50); do
    curl -s -o /dev/null -X POST -H "Content-Type: application/json" \
        -d "{\"email\":\"spray-$i@probe.invalid\",\"password\":\"wrongpassword\",\"ip\":\"198.51.100.10\"}" \
        http://localhost:8000/internal/auth/verify
done
curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
    -d "{\"email\":\"spray-51@probe.invalid\",\"password\":\"wrongpassword\",\"ip\":\"198.51.100.10\"}" \
    http://localhost:8000/internal/auth/verify
' | tr -d '\r')
    if [ "$code" = "429" ]; then
        ok "51st failure from one IP → 429 (per-IP bucket engaged)"
    else
        fail "expected 429 after 50 failures from one IP, got $code"
    fi
else
    skip "probe 8 not selected"
fi

##############################################################################
header "Probe 9 — repeated bad AUTH locks the account's password path"
##############################################################################
# Saturates the per-email failure bucket (cap 10), so the correct password stays refused for 15
# minutes, or until eigen-api restarts — which this probe does at the end.
# Same delivery discipline as probe 10: one AUTH per connection, reply read before QUIT, and the
# 535s counted, because an abandoned attempt would leave the bucket one short and read as a
# regression in the limiter.
if should_run 9 && [ "$HAVE_LOGIN" = 1 ]; then
    log "waiting 60s for the anvil auth-rate window to roll over..."
    sleep 60
    anvil_reset
    bad=$(auth_plain "$ALICE_EMAIL" "definitely-not-the-password")
    delivered=0
    for _ in $(seq 1 12); do
        attempt=$(auth_once "$bad")
        printf '%s\n' "$attempt" | grep -q '^535' && delivered=$((delivered + 1))
        anvil_pace "$delivered failures"
    done
    good=$(auth_plain "$ALICE_EMAIL" "$ALICE_PASSWORD")
    transcript=$(auth_once "$good")
    if printf '%s\n' "$transcript" | grep -q '^454'; then
        log "  454 on the first attempt (postfix's cached SASL connection); retrying once"
        transcript=$(auth_once "$good")
    fi
    if [ "$delivered" -lt 10 ]; then
        fail "only $delivered of 12 failures reached the API, short of the per-email cap of 10 — the spray, not the limiter, is what failed"
    elif printf '%s\n' "$transcript" | grep -q '^235'; then
        fail "the correct password still authenticated after $delivered failures, so the limiter did not engage"
    elif printf '%s\n' "$transcript" | grep -q '^535'; then
        ok "the correct password is refused while the failure bucket is saturated ($delivered failures)"
    else
        # A 450 here means postfix's own anvil AUTH rate limit answered first, not the limiter.
        fail "expected a 535 on the correct password: $(oneline "$transcript")"
    fi
    log "restarting eigen-api to clear the in-memory failure buckets..."
    dc restart eigen-api >/dev/null 2>&1
    wait_api || fail "eigen-api did not come back healthy after the restart"
else
    skip_login_probe 9
fi

##############################################################################
header "Probe 10 — the client IP reaches the limiter through real SMTP AUTH"
##############################################################################
# Proves the chain the limiter depends on: postfix reports the SMTP client as `rip`, dovecot exports
# it as TCPREMOTEIP, eigen-checkpassword forwards it as `ip`, and verifyProtocolAuth keys its per-IP
# bucket on that value. The assertion is one real SMTP AUTH with the CORRECT password against a
# bucket filled for the address the containers see: a 535 is only possible if the same string
# travelled the whole chain, and alice's own bucket stays cold, so nothing else can refuse her.
#
# The bucket is filled over HTTP rather than by spraying SMTP. A write-only SMTP spray cannot get
# there on this host: postfix abandons an auth request that is still in flight when the client
# disconnects, and the next connection on that smtpd then finds its cached dovecot connection dead,
# so losses arrive in pairs. Only 28-36 of 60 attempts landed, and holding the connection 12s
# instead of 2s bought one extra delivery — the loss is proportional, so no larger spray fixes it.
# Probe 9 is the real-SASL-transport proof; this probe is the IP-threading proof.
if should_run 10 && [ "$HAVE_LOGIN" = 1 ]; then
    log "restarting eigen-api for a clean failure-bucket baseline..."
    dc restart eigen-api >/dev/null 2>&1
    wait_api || fail "eigen-api did not come back healthy"

    # 1. A deliberate failure over real SMTP, then ask dovecot which client address it saw. Never
    # hardcode it: it is the docker gateway, and the value differs between Docker Desktop and Linux.
    # Retried, because this very attempt can be one postfix abandons (see the notes in
    # LOCAL-TESTING.md), and an abandoned attempt reaches dovecot's log no more than the API.
    discover_user="ip-discover@probe.invalid"
    client_ip=""
    anvil_reserve 8  # 4 discovery attempts at worst, plus the assertion and its retry
    for _ in 1 2 3 4; do
        auth_once "$(auth_plain "$discover_user" "wrongpassword")" >/dev/null
        client_ip=$(dc logs --tail=400 dovecot 2>&1 |
            grep -F "checkpassword($discover_user," |
            tail -1 |
            sed -n 's/.*checkpassword([^,]*,\([^,)]*\).*/\1/p' |
            tr -d '\r' || true)
        [ -n "$client_ip" ] && break
    done

    if [ -z "$client_ip" ]; then
        fail "dovecot logged no checkpassword line for $discover_user, so the client IP could not be discovered — look at: dc logs dovecot"
    else
        log "dovecot sees this client as $client_ip"

        # 2. Fill that address's bucket over HTTP, one unique email per post so no per-email bucket
        # (cap 10) can be what refuses anything later. Stop as soon as the limiter says 429.
        filled=$(dc exec -T -e PROBE_IP="$client_ip" eigen-api sh -c '
i=0
while [ $i -lt 70 ]; do
    i=$((i + 1))
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
        -d "{\"email\":\"ipfill-$i-$$@probe.invalid\",\"password\":\"wrong\",\"ip\":\"$PROBE_IP\"}" \
        http://localhost:8000/internal/auth/verify)
    if [ "$code" = "429" ]; then echo "$i"; exit 0; fi
done
echo 0
' | tr -dc '0-9')

        # 3. One real SMTP AUTH with the correct password. Only the per-IP bucket can refuse it.
        good=$(auth_plain "$ALICE_EMAIL" "$ALICE_PASSWORD")
        transcript=$(auth_once "$good")
        if printf '%s\n' "$transcript" | grep -qE '^(454|450)'; then
            # 454 is a pre-existing quirk, unrelated to this branch: the first AUTH after an
            # auth-server restart hits postfix's stale cached SASL connection, and postfix
            # reconnects on the next attempt. A 450 would be postfix's own anvil cap answering, so
            # give the window room before the retry.
            log "  $(printf '%s\n' "$transcript" | grep -E '^(454|450)' | head -1) on the first attempt; retrying once"
            anvil_reserve 2
            transcript=$(auth_once "$good")
        fi

        if [ "${filled:-0}" -eq 0 ]; then
            fail "the limiter never answered 429 for $client_ip after 70 posts, so the bucket was never full — the probe, not the chain, is what failed"
        elif printf '%s\n' "$transcript" | grep -q '^235'; then
            fail "a correct password authenticated even though $client_ip is locked out: that address is not reaching the limiter (postfix rip → dovecot TCPREMOTEIP → checkpassword ip)"
        elif printf '%s\n' "$transcript" | grep -q '^535'; then
            ok "locking out $client_ip (429 after $filled posts) refuses a correct password over real SMTP AUTH"
        else
            fail "expected a 535 from the per-IP lockout: $(oneline "$transcript")"
        fi
    fi

    log "restarting eigen-api to clear the in-memory failure buckets..."
    dc restart eigen-api >/dev/null 2>&1
    wait_api || fail "eigen-api did not come back healthy after the restart"
else
    skip_login_probe 10
fi

##############################################################################
header "Result"
##############################################################################
if [ "$FAIL" -eq 0 ] && [ "$PASS" -eq 0 ]; then
    # Green with nothing asserted is the worst outcome: it reads as a pass.
    printf '✗ NOTHING RAN (%d probes skipped) — check PROBES and ALICE_EMAIL/ALICE_PASSWORD\n' "$SKIP"
    exit 1
elif [ "$FAIL" -eq 0 ]; then
    printf '✓ ALL OK (%d checks passed, %d skipped)\n' "$PASS" "$SKIP"
    exit 0
else
    printf '✗ %d FAILURES (%d passed, %d skipped)\n' "$FAIL" "$PASS" "$SKIP"
    for line in "${FAIL_LINES[@]}"; do printf '  - %s\n' "$line"; done
    exit 1
fi
