#!/bin/bash
set -e

echo "=== Eigen Postfix Container ==="
echo "Domain: ${DOMAIN}"

# --- Config templating ---
# Only substitute $DOMAIN — leave Postfix's own variables ($mydomain, ${recipient}) alone
envsubst '$DOMAIN' < /etc/postfix/main.cf.template > /etc/postfix/main.cf
envsubst '$DOMAIN' < /etc/postfix/master.cf.template > /etc/postfix/master.cf

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
    echo "Generating DKIM key for ${DOMAIN}..."
    opendkim-genkey -b 2048 -d "${DOMAIN}" -s eigen -D /data/dkim/
    chown opendkim:opendkim /data/dkim/eigen.private /data/dkim/eigen.txt
    echo ""
    echo "============================================"
    echo "=== Add this DNS TXT record for DKIM:    ==="
    echo "============================================"
    cat /data/dkim/eigen.txt
    echo "============================================"
    echo ""
fi

# Ensure correct ownership (files may have been created by another container)
chown opendkim:opendkim /data/dkim/eigen.private 2>/dev/null || true

# OpenDKIM config
cat > /etc/opendkim.conf <<EOF
Syslog              yes
LogWhy              yes
Mode                sv
Socket              inet:8891@localhost
Domain              ${DOMAIN}
Selector            eigen
KeyFile             /data/dkim/eigen.private
Canonicalization    relaxed/simple
UserID              root
EOF

# --- Start services ---
echo "Starting OpenDKIM..."
if opendkim -x /etc/opendkim.conf 2>/dev/null; then
    echo "OpenDKIM started."
else
    echo "WARNING: OpenDKIM failed to start (DKIM signing disabled). This is normal on macOS Docker due to file ownership."
    # Remove DKIM milter from Postfix config so it doesn't try to connect
    sed -i '/milter/d' /etc/postfix/main.cf
fi

echo "Starting Postfix..."
exec postfix start-fg
