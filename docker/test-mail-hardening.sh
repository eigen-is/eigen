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
#         already in ./data. The script never creates accounts, it logs in as a real one. Stop any
#         host-side API on :8000 first. Without ALICE_EMAIL/ALICE_PASSWORD the probes that need a
#         login are skipped and the rest still run.
#
# The dev overlay pins postfix and dovecot to MAIL_DOMAIN=localhost, so Postfix's own mail domain
# can differ from the account's domain. The sender/login binding does not care: it compares the
# login with the envelope sender, whatever the domain is.
#
# LOCAL DEV ONLY: probe 7 sets `defer_transports=smtp`, seeds queue files, and deletes the whole
# Postfix queue afterwards. Never point this at a production stack.
#
# No message is ever delivered: the submission dialogs stop at RCPT TO and never send DATA.

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

HELO_NAME=probe.eigen.local
RCPT_PROBE=rcpt-probe@example.com

# One authenticated submission dialog, asserting whether the envelope sender is accepted.
# `smtpd_delay_reject = yes` defers sender restrictions to RCPT TO, so the 553 lands on the RCPT
# reply, not the MAIL FROM reply — assert against the whole transcript.
probe_submission() {
    local desc="$1" login="$2" password="$3" sender="$4" expect="$5"
    local auth transcript
    auth=$(auth_plain "$login" "$password")
    transcript=$(smtp465 "EHLO $HELO_NAME\nAUTH PLAIN $auth\nMAIL FROM:<$sender>\nRCPT TO:<$RCPT_PROBE>\nQUIT\n")

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
    if [ "${STACK_UP:-0}" = 1 ]; then
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

##############################################################################
header "Probe 1 — credential sanity (/internal/auth/verify)"
##############################################################################
HAVE_LOGIN=0
if ! should_run 1; then
    skip "probe 1 not in PROBES"
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
    skip "probe 2 (needs a working login)"
fi

##############################################################################
header "Probe 3 — same-domain forged sender is rejected"
##############################################################################
if should_run 3 && [ "$HAVE_LOGIN" = 1 ]; then
    probe_submission "AUTH $ALICE_EMAIL + MAIL FROM <$SENDER_OTHER>" \
        "$ALICE_EMAIL" "$ALICE_PASSWORD" "$SENDER_OTHER" reject
else
    skip "probe 3 (needs a working login)"
fi

##############################################################################
header "Probe 4 — foreign forged sender is rejected (the incident shape)"
##############################################################################
if should_run 4 && [ "$HAVE_LOGIN" = 1 ]; then
    probe_submission "AUTH $ALICE_EMAIL + MAIL FROM <$SENDER_FOREIGN>" \
        "$ALICE_EMAIL" "$ALICE_PASSWORD" "$SENDER_FOREIGN" reject
else
    skip "probe 4 (needs a working login)"
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
    skip "probe 5 (needs a working login)"
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
    transcript=$(smtp25 "EHLO $HELO_NAME\nMAIL FROM:<$SENDER_FOREIGN>\nRCPT TO:<probe@$postfix_domain>\nQUIT\n")
    if printf '%s\n' "$transcript" | grep -q '^553'; then
        fail "inbound MAIL FROM <$SENDER_FOREIGN> got a 553 sender rejection: $(oneline "$transcript")"
    elif printf '%s\n' "$transcript" | grep -q '^250 2\.1\.5'; then
        ok "inbound <$SENDER_FOREIGN> → <probe@$postfix_domain> accepted"
    else
        ok "inbound sender accepted; the recipient reply was: $(oneline "$transcript")"
    fi
else
    skip "probe 6 not in PROBES"
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
    skip "probe 7 not in PROBES"
fi

##############################################################################
header "Probe 8 — per-IP SASL failure lockout"
##############################################################################
# The limiter only sees a client IP because eigen-checkpassword forwards dovecot's `IP`. Drive it
# straight at the route with a synthetic IP so the lockout is observable without banning the host.
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
    skip "probe 8 not in PROBES"
fi

##############################################################################
header "Probe 9 — repeated bad AUTH locks the account's password path"
##############################################################################
# Runs LAST: it saturates the per-email failure bucket, so the correct password stays refused for
# 15 minutes (or until eigen-api restarts, which this probe does at the end).
# One AUTH per connection — smtpd_hard_error_limit=5 drops a session that keeps failing.
if should_run 9 && [ "$HAVE_LOGIN" = 1 ]; then
    log "waiting 60s for the anvil auth-rate window to roll over..."
    sleep 60
    bad=$(auth_plain "$ALICE_EMAIL" "definitely-not-the-password")
    for _ in $(seq 1 11); do
        smtp465 "EHLO $HELO_NAME\nAUTH PLAIN $bad\nQUIT\n" >/dev/null || true
    done
    good=$(auth_plain "$ALICE_EMAIL" "$ALICE_PASSWORD")
    transcript=$(smtp465 "EHLO $HELO_NAME\nAUTH PLAIN $good\nQUIT\n")
    if printf '%s\n' "$transcript" | grep -q '^235'; then
        fail "the correct password still authenticated after 11 failures, so the limiter did not engage"
    elif printf '%s\n' "$transcript" | grep -q '^535'; then
        ok "the correct password is refused while the failure bucket is saturated"
    else
        # A 450 here means postfix's own anvil AUTH rate limit answered first, not the limiter.
        fail "expected a 535 on the correct password: $(oneline "$transcript")"
    fi
    log "restarting eigen-api to clear the in-memory failure buckets..."
    dc restart eigen-api >/dev/null 2>&1
else
    skip "probe 9 (needs a working login)"
fi

##############################################################################
header "Result"
##############################################################################
if [ "$FAIL" -eq 0 ]; then
    printf '✓ ALL OK (%d checks passed, %d skipped)\n' "$PASS" "$SKIP"
    exit 0
else
    printf '✗ %d FAILURES (%d passed, %d skipped)\n' "$FAIL" "$PASS" "$SKIP"
    for line in "${FAIL_LINES[@]}"; do printf '  - %s\n' "$line"; done
    exit 1
fi
