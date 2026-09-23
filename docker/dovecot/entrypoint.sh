#!/bin/sh
set -e

echo "=== Eigen Dovecot Container ==="
echo "Domain: ${DOMAIN}"

# Generate self-signed cert if no cert exists (dev mode)
if [ ! -f /certs/cert.pem ]; then
    echo "No TLS certificate found. Generating self-signed cert for ${DOMAIN:-localhost}..."
    openssl req -x509 -newkey rsa:2048 \
        -keyout /certs/key.pem -out /certs/cert.pem \
        -days 365 -nodes -subj "/CN=${DOMAIN:-localhost}" 2>/dev/null
    echo "Self-signed certificate generated."
fi

# Wait for API to be reachable
echo "Waiting for Eigen API..."
until curl -sf http://eigen-api:8000/health > /dev/null 2>&1; do
    sleep 2
done
echo "API is reachable."

# Dovecot reads its certificate only at start, and Caddy's export-certs.sh swaps in each renewal: reload on a change.
# The loop outlives the exec as a child of dovecot, which as PID 1 takes the stop signal and ends the container.
cp /certs/cert.pem /tmp/loaded-cert.pem
while true; do
    sleep 600
    if ! cmp -s /certs/cert.pem /tmp/loaded-cert.pem; then
        echo "The TLS certificate changed; reloading Dovecot."
        cp /certs/cert.pem /tmp/loaded-cert.pem && doveadm reload || rm -f /tmp/loaded-cert.pem
    fi
done &

echo "Starting Dovecot..."
exec dovecot -F
