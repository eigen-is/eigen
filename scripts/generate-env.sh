#!/bin/bash
# Generate .env.production from DOMAIN.
# Usage: ./scripts/generate-env.sh eigen.is > .env.production
#    or: ./scripts/generate-env.sh (reads DOMAIN from .env.example or .env.production)
set -e

DOMAIN="${1:-}"

if [ -z "$DOMAIN" ]; then
    # Try to read from existing file
    for f in .env.production .env.example; do
        if [ -f "$f" ]; then
            DOMAIN=$(grep -E '^DOMAIN=' "$f" | head -1 | cut -d= -f2)
            [ -n "$DOMAIN" ] && break
        fi
    done
fi

if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "eigen.example.com" ]; then
    echo "Usage: $0 <domain>" >&2
    echo "  e.g. $0 eigen.is" >&2
    exit 1
fi

# Read optional vars from existing .env.production so re-runs preserve hand-edits.
ACME_EMAIL=""
MAIL_DOMAIN=""
COMPOSE_PROFILES=""
EIGEN_API_BIND=""
EIGEN_STATIC_BIND=""
SMTP_RELAY_HOST=""
SMTP_RELAY_PORT=""
SMTP_RELAY_USER=""
SMTP_RELAY_PASSWORD=""

if [ -f .env.production ]; then
    eval "$(grep -E '^(ACME_EMAIL|MAIL_DOMAIN|COMPOSE_PROFILES|EIGEN_API_BIND|EIGEN_STATIC_BIND|SMTP_RELAY_HOST|SMTP_RELAY_PORT|SMTP_RELAY_USER|SMTP_RELAY_PASSWORD)=' .env.production)"
fi

cat <<EOF
PRODUCTION=1

DOMAIN=${DOMAIN}
MAIL_DOMAIN=${MAIL_DOMAIN:-${DOMAIN}}
ACME_EMAIL=${ACME_EMAIL:-admin@${DOMAIN}}

COMPOSE_PROFILES=${COMPOSE_PROFILES:-edge,mail}
EIGEN_API_BIND=${EIGEN_API_BIND:-127.0.0.1:8000}
EIGEN_STATIC_BIND=${EIGEN_STATIC_BIND:-127.0.0.1:8080}

API_URL=https://${DOMAIN}
VITE_API_HOST=https://${DOMAIN}/eigen
COOKIE_DOMAIN=.${DOMAIN}

VITE_APP_SPACE_URL=https://${DOMAIN}/space
VITE_APP_MAIL_URL=https://${DOMAIN}/mail
VITE_APP_CALENDAR_URL=https://${DOMAIN}/calendar
VITE_APP_CONTACTS_URL=https://${DOMAIN}/contacts
VITE_APP_DRIVE_URL=https://${DOMAIN}/drive
VITE_APP_DOCS_URL=https://${DOMAIN}/docs
VITE_APP_STICKIES_URL=https://${DOMAIN}/stickies
VITE_APP_CHAT_URL=https://${DOMAIN}/chat
VITE_APP_ADMIN_URL=https://${DOMAIN}/admin
VITE_APP_SLIDES_URL=https://${DOMAIN}/slides
VITE_APP_SHEETS_URL=https://${DOMAIN}/sheets

TRUSTED_NETWORKS=127.0.0.0/8,::1,172.16.0.0/12

SMTP_RELAY_HOST=${SMTP_RELAY_HOST}
SMTP_RELAY_PORT=${SMTP_RELAY_PORT:-587}
SMTP_RELAY_USER=${SMTP_RELAY_USER}
SMTP_RELAY_PASSWORD=${SMTP_RELAY_PASSWORD}
EOF
