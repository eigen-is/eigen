#!/bin/bash
set -e

echo "=== Eigen Postfix Container ==="
echo "Domain: ${DOMAIN}"

# --- DNS: Postfix's internal resolver queries nameservers directly, bypassing
# glibc (getent/nss). Docker's embedded DNS at 127.0.0.11 doesn't handle these
# raw queries reliably. Use real resolvers, keep Docker's for container names. ---
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\nnameserver 127.0.0.11\n' > /etc/resolv.conf

# --- Config templating ---
# Only substitute $DOMAIN — leave Postfix's own variables ($mydomain, ${recipient}) alone
envsubst '$DOMAIN' < /etc/postfix/main.cf.template > /etc/postfix/main.cf
envsubst '$DOMAIN' < /etc/postfix/master.cf.template > /etc/postfix/master.cf

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
    echo "Generating DKIM key for ${DOMAIN}..."
    opendkim-genkey -b 2048 -d "${DOMAIN}" -s eigen -D /data/dkim/
    echo ""
    echo "============================================"
    echo "=== Add this DNS TXT record for DKIM:    ==="
    echo "============================================"
    cat /data/dkim/eigen.txt
    echo "============================================"
    echo ""
fi

# Ensure correct ownership for OpenDKIM
chown opendkim:opendkim /data/dkim /data/dkim/eigen.private /data/dkim/eigen.txt 2>/dev/null || true

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
UserID              opendkim
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

echo "Starting Postfix..."
exec postfix start-fg
