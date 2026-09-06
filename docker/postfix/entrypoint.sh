#!/bin/bash
set -e

# MAIL_DOMAIN defaults to DOMAIN when not split. Used for envelope sender, virtual mailbox
# acceptance, and DKIM signing — see main.cf.template.
: "${MAIL_DOMAIN:=$DOMAIN}"
export MAIL_DOMAIN

echo "=== Eigen Postfix Container ==="
echo "Hostname:    ${DOMAIN}"
echo "Mail domain: ${MAIL_DOMAIN}"

# --- Config templating ---
# Substitute $DOMAIN and $MAIL_DOMAIN; leave Postfix's own variables ($mydomain, ${recipient}) alone.
envsubst '$DOMAIN $MAIL_DOMAIN' < /etc/postfix/main.cf.template > /etc/postfix/main.cf
envsubst '$DOMAIN $MAIL_DOMAIN' < /etc/postfix/master.cf.template > /etc/postfix/master.cf

# --- TLS cert fallback ---
if [ ! -f /certs/cert.pem ]; then
    echo "No TLS certificate found. Generating self-signed cert for ${DOMAIN:-localhost}..."
    openssl req -x509 -newkey rsa:2048 \
        -keyout /certs/key.pem -out /certs/cert.pem \
        -days 365 -nodes -subj "/CN=${DOMAIN:-localhost}" 2>/dev/null
    echo "Self-signed certificate generated."
fi

# --- SMTP relay (optional) ---
if [ -n "${SMTP_RELAY_HOST}" ]; then
    echo "Configuring SMTP relay: ${SMTP_RELAY_HOST}:${SMTP_RELAY_PORT:-587}"
    cat >> /etc/postfix/main.cf <<EOF

# SMTP relay
relayhost = [${SMTP_RELAY_HOST}]:${SMTP_RELAY_PORT:-587}
smtp_sasl_auth_enable = yes
smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd
smtp_sasl_security_options = noanonymous
smtp_use_tls = yes
EOF
    echo "[${SMTP_RELAY_HOST}]:${SMTP_RELAY_PORT:-587} ${SMTP_RELAY_USER}:${SMTP_RELAY_PASSWORD}" \
        > /etc/postfix/sasl_passwd
    postmap /etc/postfix/sasl_passwd
    chmod 600 /etc/postfix/sasl_passwd /etc/postfix/sasl_passwd.db
fi

# --- DKIM ---
mkdir -p /data/dkim
if [ ! -f "/data/dkim/eigen.private" ]; then
    echo "Generating DKIM key for ${MAIL_DOMAIN}..."
    opendkim-genkey -b 2048 -d "${MAIL_DOMAIN}" -s eigen -D /data/dkim/
    echo ""
    echo "============================================"
    echo "=== Add this DNS TXT record for DKIM:    ==="
    echo "=== Host: eigen._domainkey.${MAIL_DOMAIN}"
    echo "============================================"
    cat /data/dkim/eigen.txt
    echo "============================================"
    echo ""
fi

# Ensure correct ownership for OpenDKIM
chown opendkim:opendkim /data/dkim /data/dkim/eigen.private /data/dkim/eigen.txt 2>/dev/null || true

# Hosts whose mail OpenDKIM signs (rather than just verifying). Must include the
# docker bridge subnet — eigen-api submits SMTP from 172.20.0.x, and OpenDKIM's
# default InternalHosts is loopback only, which would silently fall back to
# verify-only and ship mail unsigned.
mkdir -p /etc/opendkim
cat > /etc/opendkim/TrustedHosts <<EOF
127.0.0.0/8
::1
172.16.0.0/12
EOF

# OpenDKIM config — signs outbound mail as ${MAIL_DOMAIN} and, in verify mode (Mode sv), stamps
# inbound mail with an Authentication-Results header the API trusts for auto-processing iMIP invites.
# AuthservID fixes that header's authserv-id to our mail domain (default would be the container
# hostname); RemoveARFrom strips any pre-existing Authentication-Results claiming our authserv-id
# before delivery, so an attacker can't forge one — the header the API reads is only ever ours.
cat > /etc/opendkim.conf <<EOF
Syslog              yes
LogWhy              yes
Mode                sv
Socket              inet:8891@127.0.0.1
Domain              ${MAIL_DOMAIN}
Selector            eigen
KeyFile             /data/dkim/eigen.private
Canonicalization    relaxed/simple
UserID              opendkim
InternalHosts       /etc/opendkim/TrustedHosts
AuthservID          ${MAIL_DOMAIN}
RemoveARFrom        ${MAIL_DOMAIN}
EOF

# --- Start services ---
echo "Starting OpenDKIM..."
if opendkim -x /etc/opendkim.conf; then
    echo "OpenDKIM started."
else
    echo "WARNING: OpenDKIM failed to start (DKIM signing disabled)."
    # Remove DKIM milter from Postfix config so it doesn't try to connect
    sed -i '/milter/d' /etc/postfix/main.cf
fi

# Queue-backlog alerting — the API can't see the queue itself, so the probe runs here.
echo "Starting queue monitor (tune with QUEUE_CHECK_INTERVAL, QUEUE_ALERT_THRESHOLD, QUEUE_ALERT_COOLDOWN)..."
/usr/local/bin/queue-monitor.sh &

echo "Starting Postfix..."
exec postfix start-fg
