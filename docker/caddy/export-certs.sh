#!/bin/sh
# Export Caddy's auto-managed Let's Encrypt certs to a shared directory.
# Dovecot and Postfix read from /shared-certs/, and so does the certificate row of ./eigen status.
# Runs as a background loop in the Caddy container.
ACME_DIR="/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${DOMAIN}"

while true; do
    # Only a changed pair is copied, each file through a temp file and mv so no reader sees half of one.
    if [ -f "${ACME_DIR}/${DOMAIN}.crt" ] && [ -f "${ACME_DIR}/${DOMAIN}.key" ] &&
        { ! cmp -s "${ACME_DIR}/${DOMAIN}.crt" /shared-certs/cert.pem || ! cmp -s "${ACME_DIR}/${DOMAIN}.key" /shared-certs/key.pem; }; then
        cp "${ACME_DIR}/${DOMAIN}.key" /shared-certs/key.pem.tmp && chmod 600 /shared-certs/key.pem.tmp &&
            mv -f /shared-certs/key.pem.tmp /shared-certs/key.pem &&
            cp "${ACME_DIR}/${DOMAIN}.crt" /shared-certs/cert.pem.tmp && chmod 644 /shared-certs/cert.pem.tmp &&
            mv -f /shared-certs/cert.pem.tmp /shared-certs/cert.pem
    fi
    sleep 600
done
