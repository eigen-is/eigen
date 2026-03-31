# Local Docker Testing Guide

Run the full Eigen stack locally to test the Docker deployment, debug issues, or develop deployment-related features.

## What's Different from Production

| | Production | Local |
|---|---|---|
| HTTPS | Let's Encrypt (automatic) | Self-signed cert (browser warning) |
| Email sending | Postfix → SMTP relay → internet | Mailpit (catches all mail) |
| Email receiving | Postfix on port 25 | Simulate via API endpoint |
| Domain | Your real domain | `localhost` |
| IMAP | Dovecot with real TLS cert | Dovecot with self-signed cert |

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Bun](https://bun.sh) installed (for building the frontend)
- The Eigen repo cloned locally

## Quick Start

### 1. Generate environment file

```bash
cd /path/to/eigen
./scripts/generate-env.sh localhost > .env.production
```

Edit `.env.production` — change `COOKIE_DOMAIN` from `.localhost` to `localhost`:

```bash
sed -i '' 's/COOKIE_DOMAIN=.localhost/COOKIE_DOMAIN=localhost/' .env.production
```

### 2. Build the frontend

```bash
set -a && source .env.production && set +a
bun install
bun run build:prod
```

### 3. Start the stack

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production up -d
```

This starts 4 containers:
- **caddy** — Reverse proxy at `https://localhost` (self-signed cert)
- **eigen-api** — Backend API
- **mailpit** — Catches all outbound email (replaces Postfix in dev)
- **dovecot** — IMAP server for testing mail clients

### 4. Open Eigen

Go to **https://localhost** in your browser. Accept the self-signed certificate warning.

If this is a fresh install, go to **https://localhost/setup** to create your admin account.

## URLs

| Service | URL | What it does |
|---------|-----|-------------|
| Eigen web app | `https://localhost` | Main application |
| Setup wizard | `https://localhost/setup` | First-run configuration |
| Mailpit | `http://localhost:8025` | Web UI showing all caught outbound mail |
| API direct | `https://localhost/eigen/health` | API health check |

## Testing Email

### Sending mail (outbound)

1. Open Eigen's mail app at `https://localhost/mail`
2. Compose and send an email to anyone
3. Open **http://localhost:8025** — your sent email appears in Mailpit
4. No real email is sent — Mailpit catches everything

### Receiving mail (inbound)

Simulate incoming mail by POSTing to the delivery endpoint:

```bash
# Create a test email
cat > /tmp/test.eml <<'EOF'
From: sender@example.com
To: you@localhost
Subject: Test incoming mail
Date: Mon, 30 Mar 2026 12:00:00 +0000
Content-Type: text/plain

This is a test message delivered via the API.
EOF

# Deliver it
curl -sk -X POST \
    -H "Content-Type: application/octet-stream" \
    --data-binary @/tmp/test.eml \
    https://localhost/eigen/mail/deliver/YOUR_EMAIL@localhost
```

Replace `YOUR_EMAIL@localhost` with the email you used during setup. The email appears in your Eigen inbox immediately.

### Testing IMAP (Thunderbird / Apple Mail)

Connect your mail client with these settings:

| Setting | Value |
|---------|-------|
| Server | `localhost` |
| Port | `993` |
| Security | SSL/TLS |
| Username | Your email (e.g., `admin@localhost`) |
| Password | Any password (auth is disabled in dev) |

Accept the self-signed certificate warning. You'll see the same mailbox as in the Eigen web app.

**Testing flag sync:** Mark a message as read in Thunderbird → refresh in Eigen web UI (or vice versa). The flag change should appear on both sides.

### Testing IMAP via command line

```bash
# Connect and list mailboxes
(echo '1 LOGIN "admin@localhost" "anything"'
 echo '2 LIST "" "*"'
 echo '3 SELECT INBOX'
 echo '4 FETCH 1:* (ENVELOPE)'
 echo '5 LOGOUT') | openssl s_client -connect localhost:993 -quiet 2>/dev/null
```

## Testing CalDAV (Calendar Sync)

### Thunderbird

1. Open Thunderbird → **Calendar** tab
2. Right-click calendars → **New Calendar** → **On the Network** → **CalDAV**
3. Find your user ID:
```bash
curl -sk -X POST -H "Content-Type: application/json" \
    -d '{"email":"YOUR_EMAIL","password":"x"}' \
    https://localhost/eigen/internal/auth/verify
```
4. Enter:
   - **Location:** `https://localhost/dav/calendars/{userId}/`
   - **Username:** your email
   - **Password:** anything (auth is open in dev)
5. Accept the self-signed cert warning

Your Eigen calendars appear in Thunderbird. Changes sync both ways — create, edit, and delete events
in either client.

### Testing CalDAV via command line

```bash
USER_ID="your-user-id"

# List calendars
curl -sk -u your@email:x -X PROPFIND -H "Depth: 1" \
    https://localhost/dav/calendars/$USER_ID/ | xmllint --format -

# Create an event
curl -sk -u your@email:x -X PUT \
    -H "Content-Type: text/calendar" \
    -d 'BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-123@eigen
SUMMARY:Test Event
DTSTART:20260401T100000Z
DTEND:20260401T110000Z
END:VEVENT
END:VCALENDAR' \
    https://localhost/dav/calendars/$USER_ID/<CALENDAR_ID>/test-123.ics
```

**Note:** On a real server, CalDAV clients like Apple Calendar and DAVx5 auto-discover calendars —
you just enter `https://yourdomain.com/dav/`, your email, and password. The user ID in the URL is
only needed for Thunderbird which skips auto-discovery.

## Container Management

```bash
# Check status
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production ps

# View logs (all containers)
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production logs -f

# View logs (specific container)
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production logs -f eigen-api

# Restart a single container
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production restart dovecot

# Rebuild after code changes
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production up -d --build

# Stop everything
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production down

# Stop and remove all data (fresh start)
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production down -v
rm -rf data/ caddy-data/
```

## Architecture

```
Browser (https://localhost)
    │
    ▼
┌─────────┐     ┌───────────┐     ┌─────────┐
│  Caddy  │────▶│ Eigen API │◀────│ Dovecot │
│  :80/:443│     │  :8000    │     │  :993   │
└─────────┘     └───────────┘     └─────────┘
                     │
                ┌────▼────┐
                │ Mailpit │
                │  :8025  │
                └─────────┘

Caddy:     HTTPS termination, static files, API proxy
Eigen API: All business logic, data storage
Mailpit:   Catches outbound email (dev only)
Dovecot:   IMAP server (reads same Maildir as API)
```

All containers share `./data/` — user files, databases, and emails live there.

## Differences from `bun run serve`

| Feature | `bun run serve` | Docker dev |
|---------|----------------|------------|
| Frontend | Each app on separate port | All apps on localhost via Caddy |
| API | Direct on :8000 | Proxied via `/eigen/*` |
| Email | Skipped | Mailpit catches outbound |
| IMAP | Not available | Dovecot on :993 |
| HTTPS | No | Yes (self-signed) |

Use `bun run serve` for fast frontend development. Use Docker dev for testing deployment, email, IMAP, or anything that needs the full stack.

## Common Issues

### "Not Found" when opening an app
Add a trailing slash: `https://localhost/mail/` not `https://localhost/mail` (Caddy redirects automatically, but some browsers cache the non-slash version).

### CORS / "Failed to fetch" errors
The frontend was built with wrong environment variables. Rebuild:
```bash
set -a && source .env.production && set +a
bun run build:prod
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production restart caddy
```

### Dovecot: "Mail access for users with UID X not permitted"
This means the auth endpoint isn't returning the right user ID. Check the API is healthy and the user exists.

### Port already in use
Something else is using port 80, 443, 993, or 8025. Stop the conflicting service or change the port mapping in `docker-compose.dev.yml`.
