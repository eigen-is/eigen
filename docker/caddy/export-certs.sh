#!/bin/sh
# Export Caddy's auto-managed Let's Encrypt certs to a shared directory.
# Dovecot and Postfix read from /shared-certs/.
# Runs as a background loop in the Caddy container.
ACME_DIR="/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory"

while true; do
    if [ -f "${ACME_DIR}/${DOMAIN}/${DOMAIN}.crt" ]; then
        cp -f "${ACME_DIR}/${DOMAIN}/${DOMAIN}.crt" /shared-certs/cert.pem
        cp -f "${ACME_DIR}/${DOMAIN}/${DOMAIN}.key" /shared-certs/key.pem
        chmod 644 /shared-certs/cert.pem
        chmod 600 /shared-certs/key.pem
    fi
    sleep 43200  # 12 hours
done
