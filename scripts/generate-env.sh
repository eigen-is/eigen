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
EIGEN_STATIC_HOST=""
EIGEN_STATIC_PORT=""
SMTP_RELAY_HOST=""
SMTP_RELAY_PORT=""
SMTP_RELAY_USER=""
SMTP_RELAY_PASSWORD=""

if [ -f .env.production ]; then
    eval "$(grep -E '^(ACME_EMAIL|MAIL_DOMAIN|COMPOSE_PROFILES|EIGEN_STATIC_HOST|EIGEN_STATIC_PORT|SMTP_RELAY_HOST|SMTP_RELAY_PORT|SMTP_RELAY_USER|SMTP_RELAY_PASSWORD)=' .env.production)"
fi

cat <<EOF
PRODUCTION=1

DOMAIN=${DOMAIN}
MAIL_DOMAIN=${MAIL_DOMAIN:-${DOMAIN}}
ACME_EMAIL=${ACME_EMAIL:-admin@${DOMAIN}}

COMPOSE_PROFILES=${COMPOSE_PROFILES:-edge,mail}
EIGEN_STATIC_HOST=${EIGEN_STATIC_HOST:-127.0.0.1}
EIGEN_STATIC_PORT=${EIGEN_STATIC_PORT:-8080}

API_URL=https://${DOMAIN}
# Frontend URLs are RELATIVE so the bundle works on any hostname (public domain, LAN IP,
# tunnel, ...). Runtime resolves them against window.location.origin in the browser, and
# server-side mail/preview helpers prepend API_URL. Don't hardcode an absolute here.
VITE_API_HOST=/eigen

VITE_APP_SPACE_URL=/space
VITE_APP_MAIL_URL=/mail
VITE_APP_CALENDAR_URL=/calendar
VITE_APP_CONTACTS_URL=/contacts
VITE_APP_DRIVE_URL=/drive
VITE_APP_DOCS_URL=/docs
VITE_APP_STICKIES_URL=/stickies
VITE_APP_CHAT_URL=/chat
VITE_APP_ADMIN_URL=/admin
VITE_APP_SLIDES_URL=/slides
VITE_APP_SHEETS_URL=/sheets
VITE_APP_VECTOR_URL=/vector
VITE_APP_INDEX_URL=/

TRUSTED_NETWORKS=127.0.0.0/8,::1,172.16.0.0/12

SMTP_RELAY_HOST=${SMTP_RELAY_HOST}
SMTP_RELAY_PORT=${SMTP_RELAY_PORT:-587}
SMTP_RELAY_USER=${SMTP_RELAY_USER}
SMTP_RELAY_PASSWORD=${SMTP_RELAY_PASSWORD}
EOF
