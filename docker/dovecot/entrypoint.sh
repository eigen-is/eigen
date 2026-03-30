#!/bin/bash
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

echo "Starting Dovecot..."
exec dovecot -F
