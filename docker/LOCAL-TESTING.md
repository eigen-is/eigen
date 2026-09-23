# Local Docker Testing Guide

Run the full Eigen stack locally to test the Docker deployment, debug issues, or develop deployment-related features.

## What's Different from Production

| | Production | Local |
|---|---|---|
| HTTPS | Let's Encrypt (automatic) | Caddy's own local certificate (browser warning) |
| Email sending | Postfix → SMTP relay → internet | Mailpit (catches all mail) |
| Email receiving | Postfix on port 25 | Simulate via API endpoint |
| Domain | Your real domain | `localhost`, with addresses on `eigen.localhost` |
| IMAP | Dovecot with real TLS cert | Dovecot with self-signed cert |
| Images | Pulled, or built by `./eigen setup` | Built from your checkout by Compose |

> **Why `eigen.localhost` for addresses?** better-auth requires email addresses with a dot in the domain, so `admin@localhost` is rejected. The dev overlay keeps the web address at `localhost` and puts addresses on `eigen.localhost`.

This is the stack for working on Eigen itself: it runs Compose by hand with the dev overlay. To try Eigen the way an operator installs it, run `./eigen setup` in a clone of its own, as in the [setup guide](SETUP-GUIDE.md).

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running, with Docker Compose 2.20 or newer
- [Bun](https://bun.sh) installed, for `bun run setup`
- The Eigen repo cloned locally

## Quick Start

### 1. Write the environment file

```bash
cd /path/to/eigen
bun run setup -- --domain localhost --yes
```

This writes `.env.production` for an all-in-one stack on `localhost` without asking. Leave out `--yes` to answer the questions yourself.

### 2. Build and start the stack

```bash
BUN_VERSION=$(cat .bun-version) docker compose -f docker-compose.yml -f docker-compose.build.yml \
    -f docker-compose.dev.yml --env-file .env.production up -d --build
```

`docker-compose.build.yml` builds the four images from your checkout, `docker-compose.dev.yml` adds Mailpit and dev settings. The stack writes into the checkout's `data/`. If that folder holds data you care about, move it aside first.

The rest of this guide shortens that Compose command to `$DC`. Every command with the build overlay needs `BUN_VERSION`, so set both in your shell:

```bash
export BUN_VERSION=$(cat .bun-version)
DC="docker compose -f docker-compose.yml -f docker-compose.build.yml -f docker-compose.dev.yml --env-file .env.production"
```

This starts 6 containers:
- **caddy**: Reverse proxy at `https://localhost` (local certificate)
- **eigen-api**: Backend API
- **unbound**: Recursive DNS resolver for Postfix
- **postfix**: SMTP server (submission on ports 587/465 for external clients)
- **dovecot**: IMAP server for testing mail clients
- **mailpit**: Catches outbound email from the Eigen web UI (port 8025)

### 3. Finish the setup

On a fresh `data/`, the API logs a one-time link:

```bash
$DC logs eigen-api | grep 'Finish the setup'
```

It reads `Finish the setup at https://localhost/admin/#setup=…`. Open it, accept the certificate warning, and create your admin account. Every restart of the API before setup is done logs a fresh link.

## URLs

| Service | URL | What it does |
|---------|-----|-------------|
| Eigen web app | `https://localhost` | Main application |
| Admin | `https://localhost/admin` | Admin panel |
| Mailpit | `http://localhost:8025` | Web UI showing all caught outbound mail |
| API direct | `https://localhost/eigen/health` | API health check |

## Testing Email

### Sending mail (outbound)

1. Open Eigen's mail app at `https://localhost/mail`
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
To: you@eigen.localhost
Subject: Test incoming mail
Date: Mon, 30 Mar 2026 12:00:00 +0000
Content-Type: text/plain

This is a test message delivered via the API.
EOF

# Deliver it via the API container (the endpoint is not exposed through Caddy)
$DC exec -T eigen-api curl -s -X POST \
    -H "Content-Type: application/octet-stream" \
    --data-binary @- \
    "http://localhost:8000/mail/deliver/YOUR_EMAIL@eigen.localhost" < /tmp/test.eml
```

Replace `YOUR_EMAIL@eigen.localhost` with the email you used during setup. The email appears in your Eigen inbox immediately.

### Testing IMAP (Thunderbird / Apple Mail)

Connect your mail client with these settings:

| Setting | Value |
|---------|-------|
| Server | `localhost` |
| Port | `993` |
| Security | SSL/TLS |
| Username | Your email (e.g., `admin@eigen.localhost`) |
| Password | Your password or an app password |

Accept the self-signed certificate warning. You'll see the same mailbox as in the Eigen web app.

> **App passwords:** Generate one in **Space → Calendar & Mail → App Passwords**. Required when 2FA is enabled.
> Without 2FA, your regular password works too.

**Testing flag sync:** Mark a message as read in Thunderbird → refresh in Eigen web UI (or vice versa). The flag change should appear on both sides.

### Testing IMAP via command line

```bash
# Connect and list mailboxes (replace YOUR_PASSWORD with your password or app password)
(echo '1 LOGIN "admin@eigen.localhost" "YOUR_PASSWORD"'
 echo '2 LIST "" "*"'
 echo '3 SELECT INBOX'
 echo '4 FETCH 1:* (ENVELOPE)'
 echo '5 LOGOUT') | openssl s_client -connect localhost:993 -quiet 2>/dev/null
```

## Testing CalDAV (Calendar Sync)

### Thunderbird

1. Open Thunderbird → **Calendar** tab
2. Right-click calendars → **New Calendar** → **On the Network** → **CalDAV**
3. Find your user ID (the verify endpoint is localhost-only — call it inside the API container):
```bash
$DC exec eigen-api curl -s -X POST -H "Content-Type: application/json" \
    -d '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}' \
    http://localhost:8000/internal/auth/verify
```
4. Enter:
   - **Location:** `https://localhost/dav/calendars/{userId}/`
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
    https://localhost/dav/calendars/$USER_ID/ | xmllint --format -

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
    https://localhost/dav/calendars/$USER_ID/<CALENDAR_ID>/test-123.ics
```

**Note:** On a real server, CalDAV clients like Apple Calendar and DAVx5 auto-discover calendars —
you just enter `https://yourdomain.com/dav/`, your email, and password. The user ID in the URL is
only needed for Thunderbird which skips auto-discovery.

## Container Management

```bash
# Check status
$DC ps

# View logs (all containers)
$DC logs -f

# View logs (specific container)
$DC logs -f eigen-api

# Restart a single container
$DC restart dovecot

# Rebuild after code changes
$DC up -d --build

# Stop everything
$DC down
```

For a fresh start, stop the stack and move `data/` and `caddy-data/` aside rather than deleting them: the checkout's `data/` may be the one your `bun run serve` or an older stack used.

## Architecture

```
Browser (https://localhost)
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

The harnesses in `docker/` install Eigen the way a stranger does, and never touch your checkout's `data/` or a stack you run. Each copies the tracked files as the working tree has them (`git add` a new file to include it) into a scratch folder under `$TMPDIR`, runs `./eigen` there from a `docker:cli` container that has no Bun, as its own Compose project on `127.0.0.1` ports 18000-18999, and removes what it started on exit. `HARNESS_KEEP=1` leaves the scratch install up. They share `docker/probe-lib.sh`: the pass/fail counters, the log helpers, the compose wrapper, the setup and admin helpers, the HTTP/SMTP/IMAPS probes, and the `Result` summary. A new probe script sources it first and adds only its own probes. Run them one at a time: two started together can pick the same subnet.

```bash
./docker/test-all.sh
```

Runs the harnesses one after another and prints one line per harness.

```bash
./docker/test-cli.sh
```

The operator commands on an `edge,mail` install made as uid 1001 in a folder whose name has capitals and a space, and on an `edge` install made as root: `status`, the control socket, the setup link, `reset-password`, `backup` and `restore` with their refusals, and what `status` and `reset-password` say with Eigen stopped.

```bash
./docker/test-deployments.sh
```

Reruns `./eigen setup` on one install for each `COMPOSE_PROFILES` combination (`edge,mail`, `static,mail`, `edge`, `static`), plus a custom-subnet variant (`172.29.0.0/24`) to exercise the network override path. Probes per scenario: landing page, per-app SPA bundles, `/eigen/health`, WebSocket upgrade pass-through, and, when `mail` is in the profile, the SMTP and IMAPS banners. Without mail, a share notification goes through a Mailpit relay, and a document made over the API syncs over its collab WebSocket through the web server. Prints `✓ ALL OK` or the list of failures. Run before merging anything that touches `eigen`, `apps/api/src/cli/configure.ts`, `docker-compose*`, or any Caddyfile.

```bash
./docker/test-host-proxies.sh
```

Installs `static,mail` once and runs nginx, Caddy, and Apache (each in a container, attached to the install's network) in front of `eigen-static` with the snippets `./eigen setup` writes. Probes the same SPA / API / WebSocket set through each proxy. Verifies the host-webserver path, the part `test-deployments.sh` can't cover without a real host webserver.

```bash
./docker/test-update.sh
```

Updates and rolls back a source install: `update --check`, the refusals before anything stops, the update, a rerun, a commit that breaks the build and its fix, and the rollback.

```bash
./docker/test-release.sh
```

The release gate, run locally, and what the publish workflow runs before it pushes a release. It builds releases 0.2.98, 0.2.99 (also `:latest`) and 0.2.100 (with a breaking change) from the working tree into a registry of its own, installs 0.2.98 with seeded content, updates to `:latest`, rolls back, refuses and then accepts the breaking release, and refuses an unknown version and a downgrade.

```bash
./docker/test-launcher.sh
```

The launcher alone, without a stack: under dash, BusyBox `sh` and this host's `/bin/sh`, with a stub `docker`. Covers every command's help, unknown commands and arguments, the preflight refusals, source and release mode, and a failing Compose config.

```bash
./docker/test-interactive.sh
```

The questions as a person answers them in a terminal, typed by `expect` (install it first): setup with hosted mail and a rerun without mail behind a web server, `reset-password`, the restore and rollback questions, and Ctrl-C at a question, during a restore and under the build spinner.

```bash
./docker/test-mail-hardening.sh
```

Installs `edge,mail` and checks the mail hardening described in [SETUP-GUIDE.md § Mail abuse hardening](SETUP-GUIDE.md#mail-abuse-hardening). Eleven numbered probes: a login sending as itself (250), the same login sending as another local address and as a foreign address (553 both), the same login sending with an empty envelope sender (250, the RFC 3834 exemption), a mixed-case login sending as its own lowercase address (250), unauthenticated inbound on port 25 with a foreign sender (accepted), the queue-backlog notification, and the SASL failure limiters: probe 10 (a run of failed logins over real SMTP AUTH locks the account's password path) and probe 11 (the client address travels the whole chain: postfix `rip` → dovecot `TCPREMOTEIP` → checkpassword `ip` → the per-IP bucket). Probe 11 asks dovecot's log which address it saw for one deliberate failed login, fills that address's bucket over HTTP from inside the API container, and then has a single real SMTP AUTH with the **correct** password refused, which can only happen if the same address traveled the chain. `PROBES=2,3,4` runs a subset (probe 1 comes along whenever a login probe is named, since it is what proves the credentials), `HARNESS_KEEP=1` leaves the stack up. The full run takes about 6 minutes, mostly probe 10 pacing itself under Postfix's anvil AUTH cap and probe 8 waiting for the queue monitor.

The install is fresh, so the script makes the admin `alice@eigen.test` through the setup link and logs in as her. Nothing is ever delivered: the dialogs stop at RCPT TO.

Two side effects, both inside the scratch install. Probe 8 parks mail in the queue with `defer_transports=smtp` and deletes the whole Postfix queue on exit (only when that probe ran). Probes 9, 10 and 11 fill the failure buckets and restart `eigen-api` to clear them, which also means a probe-10 or probe-11 run briefly refuses the test account's password on purpose.

Every rejection also shows up with its reason in the postfix log (`HARNESS_KEEP=1`, then `docker compose … logs postfix` in the scratch folder).

Some things about SMTP AUTH here look like bugs and are not. Worth knowing before you write your own probe.

The first AUTH after `eigen-api` restarts often gets `454 4.7.0 Temporary authentication failure`. Postfix is still holding its cached connection to Dovecot's auth service; it reconnects on the next attempt, so a retry succeeds.

A scripted dialog that sends `AUTH` and `QUIT` in one write loses the attempt entirely. Postfix abandons the Dovecot request when the client disconnects before the reply (`auth client disconnected with 1 pending requests: EOF` in the dovecot log), so the failure never reaches the API's limiter. Read each reply before closing.

Even with that pause, a long run of one-AUTH connections through Docker's port forward keeps losing some attempts, and the losses come in pairs: an abandoned request also kills the smtpd's cached Dovecot connection, so the next connection fails too. Measured 28 to 36 of 60 delivered, and holding each connection 12 seconds instead of 2 bought a single extra delivery. The loss is proportional to the number of attempts, so a bigger run does not help — which is why probe 11 fills the per-IP bucket over HTTP and spends exactly one SMTP AUTH on the assertion.

Dovecot's log is the place to learn which client address the containers actually see (`checkpassword(<user>,<ip>)` with `auth_verbose = yes`). It is the Docker gateway, and it differs between Docker Desktop and Linux, so never hardcode it.

### Test scenario B by hand (bundled static container, no bundled Caddy)

```bash
bun run setup -- --domain localhost --proxy 127.0.0.1:8080 --yes
$DC up -d --build
```

The bundled Caddy is skipped; `eigen-static` is exposed on `127.0.0.1:8080`. Probe directly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/eigen/health   # → 200
curl -s http://localhost:8080/mail/ | head -3                                 # mail SPA HTML
```

The mail HTML's `<script src="…">` tag should reference `/mail/assets/…`, not `/assets/…`
(the latter would mean the landing page got served instead of the mail SPA — bug).

To also test a real host webserver in front of `eigen-static`, use `./docker/test-host-proxies.sh`. It runs nginx, Caddy, and Apache (each in a container, attached to the install's network) with the snippets `./eigen setup` writes and probes the SPA / API / WebSocket set through each.

For postfix / dovecot when Caddy is off, use the host-cert overlay so they pick up TLS certs from the host instead of Caddy's export:

```bash
$DC -f docker-compose.host-certs.yml up -d
```

Locally that mounts `/etc/letsencrypt/live/eigen.localhost/`, which doesn't exist; for a real end-to-end test, generate a self-signed cert at that path or skip IMAPS testing.

### Test scenario C (no hosted mail, a relay)

Without hosted mail, the API sends through the relay itself. The dev stack's Mailpit makes a good relay: it catches outbound mail without sending it.

```bash
bun run setup -- --domain localhost --no-mail --relay mailpit:1025 --yes
$DC up -d --build
```

Outbound emails appear at `http://localhost:8025`. Inbound delivery and IMAP won't work (no postfix / dovecot in containers). That's the scenario.

### Test scenario D (neither)

Combine the two: `bun run setup -- --domain localhost --proxy 127.0.0.1:8080 --no-mail --relay mailpit:1025 --yes`, then `$DC up -d --build`. `eigen-static` on `:8080` serves the frontend + API, Mailpit catches the mail.

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
Add a trailing slash: `https://localhost/mail/` not `https://localhost/mail`.

### CORS / "Failed to fetch" errors
The frontend image was built with other environment variables than the stack runs with. Rebuild the images:
```bash
$DC up -d --build
```

### Dovecot: "Mail access for users with UID X not permitted"
This means the auth endpoint isn't returning the right user ID. Check the API is healthy and the user exists.

### Port already in use
Something else is using port 80, 443, 25, 465, 587, 993, or 8025. Stop the conflicting service or change the port mapping in `docker-compose.dev.yml`. (Port 8000 is not bound on the host: eigen-api lives on the docker network only.)

### Docker network subnet conflict
If `docker compose up` fails with `pool overlaps with other one on this address space`, another network on your host already uses `172.20.0.0/24`. `./eigen setup` picks a free subnet itself; `bun run setup` does not, so override both values in `.env.production`:
```
EIGEN_SUBNET=172.30.0.0/24
EIGEN_UNBOUND_IP=172.30.0.254
```
The two must stay consistent: unbound's IP must lie inside the subnet.
