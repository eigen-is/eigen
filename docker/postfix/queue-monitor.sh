#!/bin/sh
# Queue-backlog probe, backgrounded by entrypoint.sh.
#
# The API can't see the mail queue (private volume, 0700, no docker socket), so the count is taken
# in here. Every QUEUE_CHECK_INTERVAL seconds: count the queue files and, above
# QUEUE_ALERT_THRESHOLD, POST the number to the API's localhost-only /internal/mail/queue-alert
# route, which notifies the instance owner. One alert per crossing, repeated at most every
# QUEUE_ALERT_COOLDOWN seconds while the backlog lasts, re-armed when the queue drops back under
# the threshold. In the 2026-08-31 spam incident 17k queued messages went unnoticed for a day.

# Read one setting from the environment, falling back to the default unless it is a positive
# integer. Garbage would make every [ -lt ] below fail, and the loop would then alert on every
# interval for as long as the container runs.
setting() {
    value=$(printenv "$1")
    case "$value" in
        '' | *[!0-9]*) ;;
        *) if [ "$value" -gt 0 ]; then printf '%s' "$value"; return; fi ;;
    esac
    [ -n "$value" ] && echo "queue-monitor: $1='$value' is not a positive integer — using $2" >&2
    printf '%s' "$2"
}

INTERVAL=$(setting QUEUE_CHECK_INTERVAL 300)
THRESHOLD=$(setting QUEUE_ALERT_THRESHOLD 200)
COOLDOWN=$(setting QUEUE_ALERT_COOLDOWN 21600)

# Timestamp of the last alert we got through; 0 means armed, so the next crossing alerts at once.
last_alert=0

while true; do
    sleep "$INTERVAL"

    # `wc -l` pads its count with spaces on some platforms, and the JSON body below wants a bare number.
    queued=$(find /var/spool/postfix/incoming /var/spool/postfix/active /var/spool/postfix/deferred \
        -type f 2>/dev/null | wc -l | tr -d ' ')
    now=$(date +%s)

    if [ "$queued" -lt "$THRESHOLD" ]; then
        # Recovered (or never crossed) — re-arm so the next crossing alerts straight away.
        last_alert=0
        continue
    fi

    if [ "$last_alert" -ne 0 ] && [ $((now - last_alert)) -lt "$COOLDOWN" ]; then
        continue
    fi

    echo "queue-monitor: ${queued} messages queued (threshold ${THRESHOLD}) — alerting the API"
    # A failed POST must never kill the loop: the API may be the thing that is wedged, and the
    # next interval retries.
    if curl -sf -m 10 -X POST -H "Content-Type: application/json" \
        -d "{\"queued\":${queued}}" \
        "http://eigen-api:8000/internal/mail/queue-alert" >/dev/null 2>&1; then
        last_alert="$now"
    else
        echo "queue-monitor: alert POST failed — retrying at the next interval"
    fi
done
