# Local Docker Testing Guide

Run the full Eigen stack locally to test the Docker deployment, debug issues, or develop deployment-related features.

## What's Different from Production

| | Production | Local |
|---|---|---|
| HTTPS | Let's Encrypt (automatic) | Self-signed cert (browser warning) |
| Email sending | Postfix → SMTP relay → internet | Mailpit (catches all mail) |
| Email receiving | Postfix on port 25 | Simulate via API endpoint |
| Domain | Your real domain | `eigen.local` (mapped to 127.0.0.1 via /etc/hosts) |
| IMAP | Dovecot with real TLS cert | Dovecot with self-signed cert |

> **Why not `localhost`?** better-auth requires email addresses with a proper TLD (e.g., `admin@eigen.local`).
> Bare `localhost` emails like `admin@localhost` are rejected. Use any `.local` domain and map it in `/etc/hosts`.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Bun](https://bun.sh) installed (for building the frontend)
- The Eigen repo cloned locally

## Quick Start

### 1. Add local domain to /etc/hosts

```bash
echo '127.0.0.1 eigen.local' | sudo tee -a /etc/hosts
```

### 2. Generate environment file

```bash
cd /path/to/eigen
./scripts/generate-env.sh eigen.local > .env.production
```

### 3. Build the frontend

```bash
bun install
set -a && source .env.production && set +a
bun run --sequential --filter './apps/*' build
```

### 4. Start the stack

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.production up -d
```

This starts 6 containers:
- **caddy** — Reverse proxy at `https://eigen.local` (self-signed cert)
- **eigen-api** — Backend API
- **unbound** — Recursive DNS resolver for Postfix
- **postfix** — SMTP server (submission on ports 587/465 for external clients)
- **dovecot** — IMAP server for testing mail clients
- **mailpit** — Catches outbound email from the Eigen web UI (port 8025)

### 5. Open Eigen

Go to **https://eigen.local** in your browser. Accept the self-signed certificate warning.

If this is a fresh install, go to **https://eigen.local/admin** to create your admin account.

## URLs

| Service | URL | What it does |
|---------|-----|-------------|
| Eigen web app | `https://eigen.local` | Main application |
| Admin / Setup | `https://eigen.local/admin` | Admin panel (shows setup wizard on first run) |
| Mailpit | `http://localhost:8025` | Web UI showing all caught outbound mail |
| API direct | `https://eigen.local/eigen/health` | API health check |

## Testing Email

### Sending mail (outbound)

1. Open Eigen's mail app at `https://eigen.local/mail`
2. Compose and send an email to anyone
3. Open **http://localhost:8025** — your sent email appears in Mailpit
4. No real email is sent — Mailpit catches everything

### Receiving mail (inbound)

`/mail/deliver` is localhost-only — Postfix calls it directly on the Docker network, and Caddy
404s it at the edge, so it is not reachable from the host. Simulate incoming mail by POSTing to
it from inside the API container:

```bash
# Create a test email
cat > /tmp/test.eml <<'EOF'
From: sender@example.com
To: you@eigen.local
Subject: Test incoming mail
Date: Mon, 30 Mar 2026 12:00:00 +0000
Content-Type: text/plain

This is a test message delivered via the API.
EOF

# Deliver it via the API container (the endpoint is not exposed through Caddy)
docker compose exec -T eigen-api curl -s -X POST \
    -H "Content-Type: application/octet-stream" \
    --data-binary @- \
    "http://localhost:8000/mail/deliver/YOUR_EMAIL@eigen.local" < /tmp/test.eml
```

Replace `YOUR_EMAIL@eigen.local` with the email you used during setup. The email appears in your Eigen inbox immediately.

### Testing IMAP (Thunderbird / Apple Mail)

Connect your mail client with these settings:

| Setting | Value |
|---------|-------|
| Server | `eigen.local` |
| Port | `993` |
| Security | SSL/TLS |
| Username | Your email (e.g., `admin@eigen.local`) |
| Password | Your password or an app password |

Accept the self-signed certificate warning. You'll see the same mailbox as in the Eigen web app.

> **App passwords:** Generate one in **Space → Calendar & Mail → App Passwords**. Required when 2FA is enabled.
> Without 2FA, your regular password works too.

**Testing flag sync:** Mark a message as read in Thunderbird → refresh in Eigen web UI (or vice versa). The flag change should appear on both sides.

### Testing IMAP via command line

```bash
# Connect and list mailboxes (replace YOUR_PASSWORD with your password or app password)
(echo '1 LOGIN "admin@eigen.local" "YOUR_PASSWORD"'
 echo '2 LIST "" "*"'
 echo '3 SELECT INBOX'
 echo '4 FETCH 1:* (ENVELOPE)'
 echo '5 LOGOUT') | openssl s_client -connect eigen.local:993 -quiet 2>/dev/null
```

## Testing CalDAV (Calendar Sync)

### Thunderbird

1. Open Thunderbird → **Calendar** tab
2. Right-click calendars → **New Calendar** → **On the Network** → **CalDAV**
3. Find your user ID (the verify endpoint is localhost-only — call it inside the API container):
```bash
docker compose exec eigen-api curl -s -X POST -H "Content-Type: application/json" \
    -d '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}' \
    http://localhost:8000/internal/auth/verify
```
4. Enter:
   - **Location:** `https://eigen.local/dav/calendars/{userId}/`
   - **Username:** your email
   - **Password:** your password or app password
5. Accept the self-signed cert warning

Your Eigen calendars appear in Thunderbird. Changes sync both ways — create, edit, and delete events
in either client.

### Testing CalDAV via command line

```bash
USER_ID="your-user-id"

# List calendars
curl -sk -u your@email:YOUR_PASSWORD -X PROPFIND -H "Depth: 1" \
    https://eigen.local/dav/calendars/$USER_ID/ | xmllint --format -

# Create an event
curl -sk -u your@email:YOUR_PASSWORD -X PUT \
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
    https://eigen.local/dav/calendars/$USER_ID/<CALENDAR_ID>/test-123.ics
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
Browser (https://eigen.local)
    │
    ▼
┌──────────┐     ┌───────────┐     ┌─────────┐
│  Caddy   │────▶│ Eigen API │◀────│ Dovecot │
│ :80/:443 │     │   :8000   │     │  :993   │
└──────────┘     └───────────┘     └─────────┘
                       │                 │
                  ┌────▼────┐      ┌─────▼─────┐    ┌─────────┐
                  │ Mailpit │      │  Postfix   │◀───│ Unbound │
                  │  :8025  │      │ :25/465/587│    │  (DNS)  │
                  └─────────┘      └────────────┘    └─────────┘

Caddy:     HTTPS termination, static files, API proxy
Eigen API: All business logic, data storage
Unbound:   Recursive DNS resolver for Postfix
Postfix:   SMTP (inbound on 25, submission on 465/587 via Dovecot SASL)
Dovecot:   IMAP server (reads same Maildir as API, auth via API)
Mailpit:   Catches outbound email from web UI (dev only)
```

All containers share `./data/` — user files, databases, and emails live there.

## Testing different deployment shapes

The defaults above test scenario A (bundled Caddy + bundled mail, all-in-one). The other
shapes documented in [SETUP-GUIDE.md](SETUP-GUIDE.md#alternative-deployments) are testable
locally too — the dev compose hardcodes `localhost`, so you don't need real DNS or certs.

### Smoke-test the deployment shapes

```bash
./docker/test-deployments.sh
```

Boots each `COMPOSE_PROFILES` combination (`edge,mail`, `static,mail`, `edge`, `static`),
plus a custom-subnet variant (`EIGEN_SUBNET=172.30.0.0/24`) to exercise the network
override path. Probes per scenario: landing page, per-app SPA bundles, `/eigen/health`,
WebSocket upgrade pass-through, and — when `mail` is in the profile — the SMTP and IMAPS
banners. ~3 min wall clock; prints `✓ ALL OK` or the list of failures. Run before merging
anything that touches `setup.ts`, `docker-compose*`, `scripts/generate-env.sh`, or any
Caddyfile.

```bash
./docker/test-host-proxies.sh
```

Brings up `static,mail` once and runs nginx, Caddy, and Apache (each in a container,
attached to the eigen network) in front of `eigen-static` with adapted versions of the
snippets `setup.ts` generates. Probes the same SPA / API / WebSocket set through each
proxy. Verifies the host-webserver path — the part `test-deployments.sh` can't cover
without a real host webserver.

```bash
ALICE_EMAIL=admin@eigen.local ALICE_PASSWORD='your-password' ./docker/test-mail-hardening.sh
```

Brings up `edge,mail` and checks the mail hardening described in [SETUP-GUIDE.md § Mail abuse hardening](SETUP-GUIDE.md#mail-abuse-hardening). Ten numbered probes: a login sending as itself (250), the same login sending as another local address and as a foreign address (553 both), a mixed-case login sending as its own lowercase address (250), unauthenticated inbound on port 25 with a foreign sender (accepted), the queue-backlog notification, and the SASL failure limiters — including probe 10, which proves the client address travels the whole chain (postfix `rip` → dovecot `TCPREMOTEIP` → checkpassword `ip` → the per-IP bucket) by spraying 60 failures over 60 addresses, one AUTH per connection, and then having a correct password refused. `PROBES=2,3,4` runs a subset (probe 1 comes along whenever a login probe is named, since it is what proves the credentials), `KEEP_STACK=1` leaves the stack up. The full run takes about 10 minutes, since probes 9 and 10 pace themselves under Postfix's anvil AUTH cap.

The script logs in as a real account, so it needs `ALICE_EMAIL` and `ALICE_PASSWORD` for an account that already exists in `./data`, and `MAIL_DOMAIN` in `.env.production` must match that address (`MAIL_DOMAIN=eigen.is` if your `./data` came from the real instance). Without them the login probes skip and the rest still run. Stop any host API on `:8000` first. Nothing is ever delivered: the dialogs stop at RCPT TO. The dev overlay pins postfix and dovecot to `MAIL_DOMAIN=localhost`, so Postfix's own mail domain can differ from the account's; sender binding compares the login with the envelope sender and does not care about the domain.

Two side effects, so keep it on a local stack. Probe 7 parks mail in the queue with `defer_transports=smtp` and deletes the whole Postfix queue on exit (only when that probe ran). Probes 9 and 10 fill the failure buckets, then restart `eigen-api` to clear them.

Every rejection also shows up with its reason in `docker compose ... logs postfix`.

Two things about SMTP AUTH here that look like bugs and are not. The first AUTH after `eigen-api` restarts often gets `454 4.7.0 Temporary authentication failure`: Postfix is still holding its cached connection to Dovecot's auth service and reconnects on the next attempt, so a retry succeeds. And a scripted dialog that sends `AUTH` and `QUIT` in one write loses the attempt entirely — Postfix abandons the Dovecot request when the client disconnects before the reply (`auth client disconnected with 1 pending requests: EOF` in the dovecot log), and the failure never reaches the API's limiter. Read each reply before closing the connection.

### Test scenario B by hand (bundled static container, no bundled Caddy)

```bash
bun run setup    # answer "yes" to the host-webserver question
COMPOSE_PROFILES=static,mail docker compose -f docker-compose.yml -f docker-compose.dev.yml \
    --env-file .env.production up -d --build
```

The bundled Caddy is skipped; `eigen-static` (built from your local `dist/`) is exposed on
`127.0.0.1:8080`. Probe directly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/eigen/health   # → 200
curl -s http://localhost:8080/mail/ | head -3                                 # mail SPA HTML
```

The mail HTML's `<script src="…">` tag should reference `/mail/assets/…`, not `/assets/…`
(the latter would mean the landing page got served instead of the mail SPA — bug).

To also test a real host webserver in front of `eigen-static`, use `./docker/test-host-proxies.sh`
— it spins up nginx, Caddy, and Apache (each in a container, attached to the eigen network) with
adapted versions of the snippets `setup.ts` generates and probes the SPA / API / WebSocket set
through each. That replaces the older throwaway-nginx recipe, which couldn't actually run the
generated `eigen.nginx.conf` because it expects host-resident Let's Encrypt certs.

For postfix / dovecot when Caddy is off, use the host-cert overlay so they pick up TLS
certs from somewhere other than the (now-missing) Caddy export:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
    -f docker-compose.host-certs.yml --env-file .env.production up -d
```

Locally that mounts `/etc/letsencrypt/live/localhost/` which doesn't exist; for a real
end-to-end test, generate a self-signed cert at that path or skip IMAPS testing.

### Test scenario C (host mail, no bundled mail)

Use `COMPOSE_PROFILES=edge` and point `SMTP_HOST` somewhere reachable. Mailpit on the host
is the easy local choice — it catches outbound mail without sending it:

```bash
docker run --rm -d --name host-mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
COMPOSE_PROFILES=edge SMTP_HOST=host.docker.internal SMTP_PORT=1025 \
    docker compose -f docker-compose.yml -f docker-compose.dev.yml \
    --env-file .env.production up -d
```

Outbound emails appear at `http://localhost:8025`. Inbound delivery and IMAP won't work
(no postfix / dovecot in containers) — that's the scenario.

### Test scenario D (host both)

`COMPOSE_PROFILES=static`. Combine the two recipes above — `eigen-static` on `:8080` for
the frontend + API, host mailpit (or postfix) for SMTP.

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
Add a trailing slash: `https://eigen.local/mail/` not `https://eigen.local/mail`.

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
Something else is using port 80, 443, 25, 465, 587, 993, or 8025. Stop the conflicting service or change the port mapping in `docker-compose.dev.yml`. (Port 8000 is no longer bound on the host — eigen-api lives on the docker network only.)

### Docker network subnet conflict
If `docker compose up` fails with `pool overlaps with other one on this address space`, another network on your host already uses `172.20.0.0/24`. Override both values in `.env.production`:
```
EIGEN_SUBNET=172.30.0.0/24
EIGEN_UNBOUND_IP=172.30.0.254
```
The two must stay consistent — unbound's IP must lie inside the subnet.
