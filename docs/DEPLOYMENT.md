# Eigen Deployment Design

Full Docker deployment for Eigen on a VPS. Covers: reverse proxy with auto-HTTPS, the Eigen API, email
(receiving + sending + IMAP), and CalDAV — all in one `docker compose up -d`.

## Architecture

```
                    Internet
                       │
          ┌────────────┼────────────────────┐
          │ Port 80/443│    Port 25   Port 993
          ▼            │       ▼         ▼
     ┌─────────┐  ┌────┴────┐ ┌───────┐ ┌─────────┐
     │  Caddy  │  │  Caddy  │ │Postfix│ │ Dovecot │
     │ static  │  │ proxy   │ │  MTA  │ │  IMAP   │
     │  files  │  │ /eigen/*│ │       │ │         │
     └────┬────┘  └────┬────┘ └───┬───┘ └────┬────┘
          │            │          │           │
          │       ┌────▼────┐     │           │
          │       │  Eigen  │◄────┘           │
          │       │   API   │                 │
          │       │  :8000  │                 │
          │       └────┬────┘                 │
          │            │                      │
          └────────────┼──────────────────────┘
                       │
                ┌──────▼──────┐
                │  ./data/    │  (bind mount)
                │  server/    │  auth DB, config
                │  home/      │  user data + Maildirs
                │  team/      │  team data
                │  certs/     │  TLS certs (from Caddy)
                │  dkim/      │  DKIM keys
                └─────────────┘
```

All services on a single Docker bridge network (`eigen`). Only Caddy, Postfix, and Dovecot expose ports
to the host. The API is internal-only.

## Services

### Caddy (Reverse Proxy + Static Files)

**Why Caddy over nginx/Apache:**
- **Automatic HTTPS** — Let's Encrypt, zero config. Type your domain, done.
- **HTTP/2 by default** — critical for SSE (multiplexed connections, no browser limit per domain)
- **Simple config** — 30 lines vs 100+ for nginx. No cert renewal cron, no certbot.

**Routing:**

| Path | Target | Notes |
|------|--------|-------|
| `/eigen/*` | `eigen-api:8000` | API proxy, SSE streaming, WebSocket upgrade |
| `/dav/*` | `eigen-api:8000` | CalDAV (HTTP Basic Auth) |
| `/.well-known/caldav` | `301 → /dav/` | CalDAV discovery |
| `/mail/*`, `/drive/*`, etc. | Static files from `dist/` | SPA fallback to `index.html` |
| `/` | `dist/index/` | Landing page |

**API URL change:** The Docker setup routes the API via path (`eigen.is/eigen/*`) instead of a
subdomain (`api.eigen.is`). This matches the existing Docker local pattern, eliminates the need for a
separate subdomain, and keeps everything on one domain / one TLS cert. The frontend build uses
`VITE_API_HOST=https://${DOMAIN}/eigen` (set in `.env.production`).

**Caddyfile:**

```
# Snippet for SPA apps — reuse for each frontend app
(app) {
    handle_path /{args[0]}/* {
        root * /www/{args[0]}
        try_files {path} /index.html
        file_server
    }
}

{$DOMAIN} {
    # API + WebSocket + SSE
    handle /eigen/* {
        reverse_proxy eigen-api:8000 {
            flush_interval -1
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
        }
    }

    # CalDAV
    handle /dav/* {
        reverse_proxy eigen-api:8000
    }
    handle /.well-known/caldav {
        redir /dav/ 301
    }

    # Frontend apps
    import app mail
    import app drive
    import app docs
    import app contacts
    import app calendar
    import app chat
    import app stickies
    import app slides
    import app sheets
    import app space
    import app people

    # Landing page (fallback)
    handle {
        root * /www/index
        try_files {path} /index.html
        file_server
    }

    # Cache static assets
    @static path *.js *.css *.png *.jpg *.svg *.woff2 *.ttf
    header @static Cache-Control "public, max-age=31536000, immutable"

    # Security headers
    header X-Frame-Options SAMEORIGIN
    header X-Content-Type-Options nosniff
}
```

**Cert export:** Caddy manages Let's Encrypt certs internally. Dovecot and Postfix need the same certs
for TLS. A background script in the Caddy container copies certs to `./data/certs/` every 12 hours:

```bash
#!/bin/sh
ACME_DIR="/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory"
while true; do
    if [ -f "${ACME_DIR}/${DOMAIN}/${DOMAIN}.crt" ]; then
        cp -f "${ACME_DIR}/${DOMAIN}/${DOMAIN}.crt" /shared-certs/cert.pem
        cp -f "${ACME_DIR}/${DOMAIN}/${DOMAIN}.key" /shared-certs/key.pem
        chmod 644 /shared-certs/cert.pem
        chmod 600 /shared-certs/key.pem
    fi
    sleep 43200
done
```

### Eigen API

Same as existing Dockerfile (`oven/bun:1-slim` + system deps), with two code changes:

**1. SMTP transport in `mailer.ts`:**

Currently uses `/usr/sbin/sendmail` binary — doesn't exist in the API container. Switch to SMTP
transport when `SMTP_HOST` env var is set:

```typescript
function createTransport(): Mail {
    if (process.env.SMTP_HOST) {
        return nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 25),
            secure: false,  // Internal Docker network
        });
    }
    return nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: '/usr/sbin/sendmail',
    });
}
```

In Docker: `SMTP_HOST=postfix` sends via the Postfix container. Outside Docker: sendmail fallback works
as before.

**2. Internal auth endpoint for Dovecot:**

```
POST /internal/auth/verify
Restriction: requireLocalhost (Docker bridge counts as local)
Body: { "email": "user@domain.com", "password": "secret" }
Response: { "userId": "uuid-...", "email": "user@domain.com" }
    or 401 Unauthorized
```

Verification order:
1. Look up user by email in `users3.db`
2. Check app-specific password (better-auth API key plugin — already installed)
3. Fall back to primary password
4. Return userId on success (Dovecot needs this to locate the Maildir)

Why app-specific passwords: IMAP clients store passwords in plaintext config. Users should generate a
dedicated "app password" in Space settings rather than use their primary password. The `@better-auth/api-key`
plugin handles this — it's already in `package.json`.

**Environment variables (Docker):**

```
PRODUCTION=1
EIGEN_DATA_ROOT=/app/data
DOMAIN=eigen.is
SMTP_HOST=postfix
SMTP_PORT=25
```

### Postfix (MTA)

Handles incoming and outgoing email. Runs in its own container.

**Ports:**
- `25` — SMTP (receive mail from the internet)
- `587` — Submission (future: authenticated sending from IMAP clients)

**Incoming mail flow:**

```
Internet → Port 25 → Postfix → virtual_transport → eigen-deliver script
    → curl POST http://eigen-api:8000/mail/deliver/{recipient}
    → Eigen writes to Maildir → DB sync → SSE notification
```

Postfix uses a custom transport (`eigen`) that pipes the message to a delivery script:

```bash
#!/bin/sh
# /usr/local/bin/eigen-deliver
# Called by Postfix for each incoming message. Reads from stdin.
RECIPIENT="$1"
exec curl -sf -X POST \
    -H "Content-Type: application/octet-stream" \
    --data-binary @- \
    --max-time 30 \
    "http://eigen-api:8000/mail/deliver/${RECIPIENT}"
```

**Outgoing mail flow:**

```
Eigen API → SMTP to postfix:25 → Postfix
    → DKIM signing (OpenDKIM milter)
    → Relay via SMTP_RELAY_HOST (or direct if port 25 open)
    → Internet
```

**SMTP relay configuration:** Hetzner blocks outbound port 25 on new servers. Configure an external
relay (Brevo, Mailgun, Amazon SES) via env vars:

```
SMTP_RELAY_HOST=smtp-relay.brevo.com
SMTP_RELAY_PORT=587
SMTP_RELAY_USER=your-api-key@brevo.com
SMTP_RELAY_PASSWORD=your-smtp-key
```

If `SMTP_RELAY_HOST` is empty, Postfix sends directly (for servers with open port 25).

**DKIM:** OpenDKIM runs as a milter inside the Postfix container. On first start, generates a 2048-bit
DKIM key and outputs the DNS TXT record to add:

```bash
# First-run in entrypoint.sh
if [ ! -f /data/dkim/eigen.private ]; then
    opendkim-genkey -b 2048 -d "${DOMAIN}" -s eigen -D /data/dkim/
    echo "=== Add this DNS TXT record ==="
    cat /data/dkim/eigen.txt
fi
```

**Key Postfix config (`main.cf` template):**

```
myhostname = ${DOMAIN}
mydomain = ${DOMAIN}
myorigin = $mydomain
mydestination = localhost
mynetworks = 127.0.0.0/8 172.16.0.0/12

# Accept mail for our domain
virtual_mailbox_domains = ${DOMAIN}
virtual_transport = eigen

# TLS (inbound)
smtpd_tls_cert_file = /certs/cert.pem
smtpd_tls_key_file = /certs/key.pem
smtpd_tls_security_level = may

# TLS (outbound)
smtp_tls_security_level = may

# Size
message_size_limit = 26214400

# DKIM milter
milter_default_action = accept
milter_protocol = 6
smtpd_milters = inet:localhost:8891
non_smtpd_milters = inet:localhost:8891

# Anti-spam basics
smtpd_helo_required = yes
smtpd_recipient_restrictions =
    permit_mynetworks,
    reject_unauth_destination,
    reject_invalid_hostname,
    reject_non_fqdn_sender
```

**Transport definition (`master.cf`):**

```
eigen   unix  -  n  n  -  10  pipe
    flags=DRhu user=nobody argv=/usr/local/bin/eigen-deliver ${recipient}
```

### Dovecot (IMAP)

Serves the Maildir that Eigen writes to. Read-only for users who want native mail clients
(Thunderbird, Apple Mail, etc.) alongside the Eigen web UI.

**Port:** `993` (IMAPS — TLS required)

**Auth flow:**

```
IMAP client → Dovecot :993 (TLS)
    → checkpassword script
    → curl POST http://eigen-api:8000/internal/auth/verify
    → Returns userId → Dovecot maps to Maildir path
```

**Checkpassword script (`/usr/local/bin/eigen-checkpassword`):**

```bash
#!/bin/bash
# Dovecot checkpassword auth against Eigen API
# Reads: username\0password\0 from fd 3
# Success: set env + exec post-login
# Failure: exit 1

read -d $'\0' -r username <&3
read -d $'\0' -r password <&3

response=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${username}\",\"password\":\"${password}\"}" \
    "http://eigen-api:8000/internal/auth/verify" 2>/dev/null)

if [ $? -ne 0 ]; then
    exit 111  # Temp failure (API unreachable)
fi

user_id=$(echo "$response" | jq -r '.userId // empty')
if [ -z "$user_id" ]; then
    exit 1  # Auth failed
fi

export USER="$username"
export HOME="/data/home/${user_id}/eigen.mail"
export userdb_uid=1000
export userdb_gid=1000
export userdb_mail="maildir:/data/home/${user_id}/eigen.mail/Maildir"

exec "$@"
```

**Dovecot config:**

```
protocols = imap

# TLS
ssl = required
ssl_cert = </certs/cert.pem
ssl_key = </certs/key.pem
ssl_min_protocol = TLSv1.2

# Auth
auth_mechanisms = plain login

passdb {
    driver = checkpassword
    args = /usr/local/bin/eigen-checkpassword
}

userdb {
    driver = prefetch
}

# Namespace with standard mailboxes
namespace inbox {
    inbox = yes
    separator = /

    mailbox Sent {
        auto = subscribe
        special_use = \Sent
    }
    mailbox Drafts {
        auto = subscribe
        special_use = \Drafts
    }
    mailbox Trash {
        auto = subscribe
        special_use = \Trash
    }
    mailbox Junk {
        auto = subscribe
        special_use = \Junk
    }
    mailbox Archive {
        auto = subscribe
        special_use = \Archive
    }
}

# Logging
log_path = /dev/stderr
info_log_path = /dev/stderr

# Performance
mail_fsync = optimized
```

**Coexistence with Eigen:** Both Eigen and Dovecot access the same Maildir. This is safe because:
- Eigen delivers to `new/`, Dovecot moves to `cur/` and assigns UIDs
- Flag changes by either side are filename renames — atomic on Linux
- `mail.db` is a rebuild-safe cache — Eigen's sync engine reconciles on next access
- See `docs/IMAP.md` for the full coexistence protocol

**requireLocalhost for Docker:** The `requireLocalhost()` check in `access.ts` currently checks for
`127.0.0.1`, `::1`, and `::ffff:127.0.0.1`. In Docker, containers connect via the bridge network
(172.x.x.x). The auth endpoint and mail delivery endpoint need to accept connections from the Docker
network. Two options:

1. Add the Docker bridge subnet (`172.16.0.0/12`) to `requireLocalhost` — simple but broadens trust
2. Use a shared secret header (`X-Internal-Secret`) — more secure

Recommendation: use option 1 with a configurable `TRUSTED_NETWORKS` env var that defaults to
`127.0.0.0/8,::1,172.16.0.0/12`. In production Docker, all these are internal.

## CalDAV

CalDAV is built into the Eigen API — no extra container. See `docs/RESEARCH_CALDAV.md` for the
complete implementation plan.

**Deployment-relevant details:**

- Routes at `/dav/*` — Caddy proxies to API
- Discovery at `/.well-known/caldav` — Caddy redirects to `/dav/`
- **HTTP Basic Auth** — not cookies. Uses `Authorization: Basic base64(email:password)`
- App-specific passwords (better-auth API key plugin) for CalDAV clients
- Same auth verification as Dovecot

**Client configuration (Apple Calendar, Thunderbird, DAVx5):**

```
Server:   https://eigen.is/dav/
Username: user@eigen.is
Password: (app-specific password)
```

CalDAV implementation is independent of the deployment infrastructure — it's just API routes.
The infrastructure (Caddy routing, auth endpoint) supports it from day one.

## Docker Compose

```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"    # HTTP/3
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./dist:/www:ro
      - ./caddy-data:/data
      - ./data/certs:/shared-certs
    environment:
      DOMAIN: ${DOMAIN}
    restart: unless-stopped
    networks: [eigen]

  eigen-api:
    build:
      context: .
      dockerfile: docker/api/Dockerfile
    volumes:
      - ./data:/app/data
    environment:
      PRODUCTION: 1
      EIGEN_DATA_ROOT: /app/data
      DOMAIN: ${DOMAIN}
      SMTP_HOST: postfix
      SMTP_PORT: 25
      COOKIE_DOMAIN: .${DOMAIN}
    restart: unless-stopped
    networks: [eigen]
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8000/health"]
      interval: 30s
      timeout: 3s
      retries: 3

  postfix:
    build:
      context: .
      dockerfile: docker/postfix/Dockerfile
    ports:
      - "25:25"
    volumes:
      - ./data/dkim:/data/dkim
      - ./data/certs:/certs:ro
    environment:
      DOMAIN: ${DOMAIN}
      SMTP_RELAY_HOST: ${SMTP_RELAY_HOST:-}
      SMTP_RELAY_PORT: ${SMTP_RELAY_PORT:-587}
      SMTP_RELAY_USER: ${SMTP_RELAY_USER:-}
      SMTP_RELAY_PASSWORD: ${SMTP_RELAY_PASSWORD:-}
    restart: unless-stopped
    networks: [eigen]

  dovecot:
    build:
      context: .
      dockerfile: docker/dovecot/Dockerfile
    ports:
      - "993:993"
    volumes:
      - ./data:/data
      - ./data/certs:/certs:ro
    environment:
      DOMAIN: ${DOMAIN}
    restart: unless-stopped
    networks: [eigen]

networks:
  eigen:
    driver: bridge
```

## DNS Configuration

Required DNS records (the setup script outputs these):

```
Type   Name                     Value
─────  ───────────────────────  ────────────────────────────────────────
A      eigen.is                 <server-ip>
MX     eigen.is                 10 eigen.is
TXT    eigen.is                 "v=spf1 a mx include:<relay> ~all"
TXT    eigen._domainkey         "v=DKIM1; k=rsa; p=<pubkey>"
TXT    _dmarc.eigen.is          "v=DMARC1; p=quarantine; rua=mailto:postmaster@eigen.is"
```

Notes:
- If using SMTP relay (Brevo, Mailgun), add `include:relay-domain.com` to SPF
- DKIM public key is generated on first Postfix start — check logs for the DNS record
- rDNS (PTR record): set via Hetzner's control panel — must resolve to `eigen.is`
- If NOT using a relay, omit the `include:` from SPF

## File Structure

```
/opt/eigen/                          # Installation root
├── docker-compose.yml               # Production compose
├── docker-compose.dev.yml           # Local dev overrides
├── Caddyfile                        # Caddy config
├── .env.production                  # Domain, API host, relay credentials
├── .env.example                     # Template (DOMAIN, ACME_EMAIL, VITE_API_HOST, COOKIE_DOMAIN, relay)
├── docker/
│   ├── api/
│   │   └── Dockerfile               # Eigen API (Bun)
│   ├── postfix/
│   │   ├── Dockerfile               # Postfix + OpenDKIM
│   │   ├── main.cf.template         # Postfix config
│   │   ├── master.cf.template       # Postfix transport
│   │   ├── eigen-deliver            # Delivery script (curl to API)
│   │   └── entrypoint.sh            # DKIM key gen, config templating
│   ├── dovecot/
│   │   ├── Dockerfile               # Dovecot
│   │   ├── dovecot.conf             # Dovecot config
│   │   ├── eigen-checkpassword      # Auth script (curl to API)
│   │   └── entrypoint.sh            # Startup
│   └── caddy/
│       └── export-certs.sh          # Cert export for Dovecot/Postfix
├── scripts/
│   ├── setup.sh                     # First-time: build + start + DNS output
│   ├── update.sh                    # git pull + rebuild + restart
│   └── backup.sh                    # Tar data directory
├── data/                            # Persistent data (bind mount)
│   ├── server/                      # Auth DB, config.json, settings.json
│   ├── home/{userId}/               # User data (drives, mail, contacts, etc.)
│   ├── team/{teamId}/               # Team data
│   ├── certs/                       # TLS certs (cert.pem, key.pem)
│   └── dkim/                        # DKIM private key
├── dist/                            # Built frontend apps (mounted into Caddy)
└── caddy-data/                      # Caddy internal data (ACME state, etc.)
```

## Local Development

Three modes, from lightweight to full-stack:

### 1. Development (no Docker)

```bash
bun run serve        # All apps + API on dev ports
bun serve:mail       # Single app + API
```

No email, no IMAP, no CalDAV clients. Pure app development. Same as today.

### 2. Integration Testing (Docker)

Full stack with **mailpit** (catches all outbound mail, provides a web UI):

```yaml
# docker-compose.dev.yml
services:
  caddy:
    environment:
      DOMAIN: localhost
    ports:
      - "80:80"
      # No 443 — Caddy uses HTTP for localhost

  mailpit:
    image: axllent/mailpit
    ports:
      - "8025:8025"    # Web UI (see all caught mail)
      - "1025:1025"    # SMTP

  eigen-api:
    environment:
      PRODUCTION: 0
      SMTP_HOST: mailpit
      SMTP_PORT: 1025

  postfix:
    profiles: ["disabled"]    # Skip in dev

  dovecot:
    # Still runs — test IMAP with Thunderbird at localhost:993
    environment:
      DOMAIN: localhost
```

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

- Web UI: `http://localhost`
- Caught mail: `http://localhost:8025`
- IMAP test: `localhost:993` in Thunderbird (self-signed cert)
- CalDAV test: `http://localhost/dav/` in Thunderbird/DAVx5

### 3. Production

```bash
docker compose up -d
```

## Installation

### Prerequisites

- Linux VPS (Debian 12 / Ubuntu 22.04+)
- Docker + Docker Compose (install: `curl -fsSL https://get.docker.com | sh`)
- Domain with DNS access
- (Optional) SMTP relay account (Brevo free tier: 300 emails/day)

### First-Time Setup

```bash
# 1. Clone
git clone <eigen-repo-url> /opt/eigen
cd /opt/eigen

# 2. Configure
cp .env.example .env.production
nano .env.production
#   DOMAIN=eigen.is
#   ACME_EMAIL=admin@eigen.is
#   VITE_API_HOST=https://eigen.is/eigen
#   COOKIE_DOMAIN=.eigen.is
#   SMTP_RELAY_HOST=smtp-relay.brevo.com   (optional)
#   SMTP_RELAY_USER=...                     (optional)
#   SMTP_RELAY_PASSWORD=...                 (optional)

# 3. Build frontend (requires bun on host — see Docker-only alternative below)
bun install && bun run build:prod

# 4. Start
docker compose up -d

# 5. Check DKIM DNS record
docker compose logs postfix | grep "Add this DNS record"

# 6. Set DNS records (see DNS Configuration section)

# 7. Open https://eigen.is → complete setup wizard
```

**Docker-only build (no bun on host):** For self-hosters who don't want to install bun, the Caddy
Dockerfile can include a multi-stage build that compiles the frontend inside Docker:

```dockerfile
FROM oven/bun:1-slim AS frontend
WORKDIR /app
COPY . .
RUN bun install && bun run build:prod

FROM caddy:2-alpine
COPY --from=frontend /app/dist /www
COPY Caddyfile /etc/caddy/Caddyfile
```

This makes the build slower but removes all host dependencies besides Docker and git.

### Updates

```bash
cd /opt/eigen
git pull
bun install && bun run build:prod    # Rebuild frontend
docker compose up -d --build         # Rebuild + restart containers
```

This can be wrapped in a single script:

```bash
#!/bin/bash
# scripts/update.sh
set -e
cd /opt/eigen
git pull
bun install
bun run build:prod
docker compose up -d --build
echo "Updated. Check: docker compose ps"
```

### Rollback

```bash
git checkout <previous-commit>
bun install && bun run build:prod
docker compose up -d --build
```

## Backup & Recovery

**Hot backup** (SQLite WAL mode supports concurrent reads):

```bash
#!/bin/bash
# scripts/backup.sh
BACKUP_DIR="/opt/eigen/backups"
mkdir -p "$BACKUP_DIR"
tar -czf "${BACKUP_DIR}/eigen-$(date +%Y%m%d-%H%M%S).tar.gz" \
    -C /opt/eigen data/ .env.production
echo "Backup complete: ${BACKUP_DIR}"
```

**Restore:**

```bash
cd /opt/eigen
docker compose down
tar -xzf backups/eigen-20260330-120000.tar.gz
docker compose up -d
```

**Automate:** Add a cron job for daily backups.

## Security

**Firewall (ufw):**

```bash
ufw allow 80/tcp     # HTTP (Caddy redirect to HTTPS)
ufw allow 443/tcp    # HTTPS
ufw allow 443/udp    # HTTP/3 (QUIC)
ufw allow 25/tcp     # SMTP (receive mail)
ufw allow 993/tcp    # IMAPS
ufw allow 22/tcp     # SSH
ufw enable
```

**TLS:**
- Web: Caddy auto-HTTPS (Let's Encrypt), HTTP/2, HSTS
- IMAP: Dovecot IMAPS (port 993, TLS required)
- SMTP inbound: STARTTLS offered (opportunistic)
- SMTP outbound: TLS when supported by recipient

**Application-level:**
- Rate limiting: 300 req/min/IP (Eigen API, already implemented)
- Auth: better-auth sessions + API keys
- Internal endpoints: restricted to Docker network via `requireLocalhost` / trusted networks
- Postfix: no open relay — only accepts mail for configured domain

**Optional hardening:**
- fail2ban for Dovecot/Postfix brute-force protection
- Automatic security updates via `unattended-upgrades`

## Implementation Phases

### Phase 1: Docker Infrastructure

Migrate from bare-metal to Docker. No new features — just cleaner deployment.

- [ ] Caddyfile + cert export script
- [ ] Update `docker-compose.yml` (Caddy replaces nginx)
- [ ] `docker-compose.dev.yml` for local testing
- [ ] `.env.example` with all config vars
- [ ] `scripts/setup.sh`, `scripts/update.sh`, `scripts/backup.sh`
- [ ] Update `requireLocalhost` to support `TRUSTED_NETWORKS` env var
- [ ] Test: `docker compose up` serves the full app with HTTPS

### Phase 2: Email (Postfix)

- [ ] Postfix Dockerfile + config templates
- [ ] `eigen-deliver` script (Postfix → Eigen API)
- [ ] OpenDKIM integration + key generation
- [ ] SMTP relay support (`SMTP_RELAY_HOST` env var)
- [ ] `mailer.ts`: add SMTP transport option (`SMTP_HOST` env var)
- [ ] DNS record documentation / check script
- [ ] Test: receive mail, send mail (via relay), verify DKIM/SPF

### Phase 3: IMAP (Dovecot)

- [ ] Dovecot Dockerfile + config
- [ ] `eigen-checkpassword` auth script
- [ ] `POST /internal/auth/verify` endpoint in Eigen API
- [ ] TLS cert sharing (Caddy → Dovecot via `data/certs/`)
- [ ] Test: Thunderbird connects to IMAP, sees inbox, flags sync

### Phase 4: App-Specific Passwords

- [ ] UI in Space settings to generate/revoke app passwords
- [ ] Expose better-auth API key plugin endpoints
- [ ] Documentation for IMAP/CalDAV client setup

### Phase 5: CalDAV

See `docs/RESEARCH_CALDAV.md` for the complete implementation plan.

- [ ] Phase 0: Schema changes (icsBlob, eventCtag, event_tombstones)
- [ ] Phase 1: Read-only CalDAV (PROPFIND, GET, REPORT)
- [ ] Phase 2: Read-write CalDAV (PUT, DELETE, MKCALENDAR)
- [ ] Phase 3: Shared & team calendar proxying
- [ ] Test: Apple Calendar / Thunderbird / DAVx5 sync

### Phase 6: SMTP Submission (Port 587) — Future

Allow IMAP clients to send mail directly via SMTP (not just the web UI).

- [ ] Postfix submission config (port 587, authenticated)
- [ ] SASL auth via Dovecot auth socket
- [ ] Test: Thunderbird sends mail via SMTP submission

## Alternatives Considered

### Hybrid (Docker Eigen + native mail)

Postfix and Dovecot installed via `apt`, Eigen in Docker.

**Pros:** Easier mail debugging (`journalctl -u postfix`), mail services don't need Docker knowledge.
**Cons:** Two deployment systems (Docker + systemd), harder to reproduce for self-hosters, OS-specific
configs, manual cert management for Dovecot.

**Verdict:** Rejected. Consistency wins — one system to learn, one way to deploy.

### All native (systemd everything)

Everything installed via `apt` and `bun`, managed by systemd.

**Pros:** Maximum flexibility, no Docker dependency, simplest debugging.
**Cons:** OS-specific, hard to package for others, manual cert management, update = manual build + restart.

**Verdict:** This is what the current deploy does. Works but doesn't scale to self-hosters.

### Managed email + Docker Eigen

Use an external email provider (Fastmail, Migadu) for mail, only self-host Eigen for Drive/Docs/Calendar.

**Pros:** Best deliverability, simplest setup, no Postfix/Dovecot to manage.
**Cons:** Not truly self-hosted email, monthly cost, depends on third party.

**Verdict:** Valid for users who don't want to run their own mail. Could be documented as an alternative
setup path.

### nginx instead of Caddy

**Pros:** Already configured in the project, more widely known.
**Cons:** No auto-HTTPS (need certbot + cron), HTTP/2 config is manual, 3x more config lines,
cert renewal failure is silent.

**Verdict:** Caddy's auto-HTTPS alone justifies the switch for a self-hosted platform.
