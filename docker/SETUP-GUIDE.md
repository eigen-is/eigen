# Setting Up Eigen on Your Server

A step-by-step guide to deploying your own Eigen instance. No Docker experience needed.

## What You'll Get

Eigen is a self-hosted Google Workspace alternative: email, calendar, drive, docs, chat — all on your own server. This guide sets up:

- **Web apps** at `https://yourdomain.com` (mail, drive, docs, calendar, etc.)
- **Email receiving** on port 25 (incoming mail from the internet)
- **Email sending** via an SMTP relay (so your emails reach inboxes, not spam folders)
- **IMAP** on port 993 (connect Thunderbird, Apple Mail, etc.)
- **Automatic HTTPS** via Let's Encrypt (zero certificate management)

Everything runs in Docker containers — isolated, reproducible, and easy to update.

## Prerequisites

You need:
- A **Linux VPS** (Debian 12 or Ubuntu 22.04+, 2GB+ RAM recommended)
- A **domain name** you control (e.g., `eigen.example.com`)
- **SSH access** to your server
- An **SMTP relay account** for sending email (recommended: [Brevo](https://brevo.com) free tier — 300 emails/day)

### Why an SMTP relay?

Most VPS providers (Hetzner, DigitalOcean) block outbound port 25 to prevent spam. An SMTP relay service sends your emails through their trusted servers, ensuring they reach inboxes. Brevo's free tier works for personal/small team use.

## Step 1: Install Docker

SSH into your server and install Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

This installs Docker Engine and Docker Compose. Verify it works:

```bash
docker --version
docker compose version
```

Eigen needs Docker Compose **2.20 or newer** (the default since August 2023) — the optional-service profiles below rely on features added in that release. The default install gives you a recent version; the check above is a sanity check, not a chore.

## Step 2: Set Up DNS

Before your server can receive email and get HTTPS certificates, your domain needs to point to it.

Go to your DNS provider and add these records (replace `eigen.example.com` with your domain and `1.2.3.4` with your server's IP):

| Type | Name | Value | Why |
|------|------|-------|-----|
| A | `eigen.example.com` | `1.2.3.4` | Points your domain to your server |
| MX | `eigen.example.com` | `10 eigen.example.com` | Tells the internet where to deliver email |
| SRV | `_imaps._tcp.eigen.example.com` | `0 1 993 eigen.example.com` | Apple Mail / Thunderbird find IMAP automatically |
| SRV | `_submission._tcp.eigen.example.com` | `0 1 587 eigen.example.com` | Apple Mail / Thunderbird find SMTP automatically |

The SRV records enable auto-discovery: when you add an account in Apple Mail, Thunderbird, or other clients with just your email and password, they find IMAP and SMTP automatically. CalDAV (calendar sync) is discovered via `/.well-known/caldav` — no SRV record needed.

Wait for DNS propagation (usually 5-30 minutes). Verify:

```bash
dig eigen.example.com A     # Should show your server IP
dig eigen.example.com MX    # Should show your domain
dig _imaps._tcp.eigen.example.com SRV  # Should show 993
```

You'll add DKIM, SPF, and DMARC records in Step 6 (after the server generates your DKIM key).

## Step 3: Clone and Configure

```bash
git clone <eigen-repo-url> /opt/eigen
cd /opt/eigen
```

Install Bun (needed for both setup and the frontend build):

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
ln -sf ~/.bun/bin/bun  /usr/local/bin/bun
ln -sf ~/.bun/bin/bunx /usr/local/bin/bunx
```

Run the interactive setup. It asks four questions, writes `.env.production`, prints the
DNS records to add, and (if you say you have a host webserver) generates ready-to-use
nginx and Caddy snippets:

```bash
bun install
bun run setup
```

**Want mail at a different domain than the web URL?** When the script asks "Mail domain",
enter the domain you want addresses on (e.g. `example.com`) while keeping the web URL on
its subdomain (e.g. `eigen.example.com`). MX, SPF, DMARC, DKIM all get printed against the
mail domain.

**Already running nginx/Caddy on the host?** Answer "yes" to the reverse-proxy question.
The script writes `eigen.nginx.conf` and `eigen.Caddyfile` you can drop into your existing
config and sets `COMPOSE_PROFILES=mail` so the bundled Caddy is skipped. The snippets
include the SSE / WebSocket plumbing collaborative editing needs — see
[Other deployment shapes](#other-deployment-shapes) below for details and the host-cert
overlay you'll want for postfix / dovecot to use your existing Let's Encrypt certs.

Open the generated `.env.production` to add SMTP relay credentials if your VPS blocks
outbound port 25:

```
SMTP_RELAY_HOST=smtp-relay.brevo.com
SMTP_RELAY_USER=your-api-key@brevo.com
SMTP_RELAY_PASSWORD=your-smtp-key
```

If you don't have a relay yet, leave them empty — you can add them later.

> Non-interactive alternative: `./scripts/generate-env.sh eigen.example.com > .env.production`
> still works for CI / scripted installs. It doesn't ask about mail domain or host
> webserver — those settings stay at defaults.

## Step 4: Build the Frontend

The frontend apps (mail, drive, docs, etc.) need to be compiled with your domain baked in:

```bash
set -a && source .env.production && set +a
bun run --sequential --filter './apps/*' build
bun --filter '@apps/api' buildfordocker
```

This compiles 13 frontend apps into the `dist/` directory. The `--sequential` flag builds one app
at a time to avoid running out of memory on small servers (2-4GB RAM).

## Step 5: Start Eigen

```bash
# Ensure data directory is writable by the API container (runs as UID 1000)
mkdir -p data && chown -R 1000:1000 data

docker compose --env-file .env.production up -d
```

This starts the bundled stack — five containers in the all-in-one default:
- **caddy** — Reverse proxy with automatic HTTPS certificates
- **eigen-api** — The Eigen backend (handles all your data)
- **unbound** — Recursive DNS resolver (Postfix needs a real resolver, not Docker's DNS proxy)
- **postfix** — Email server (receives incoming mail, sends via relay)
- **dovecot** — IMAP server (lets mail clients read your inbox)

If you opted out of `edge` or `mail` during setup, fewer containers run — see
[Other deployment shapes](#other-deployment-shapes) below.

Check that everything is running:

```bash
docker compose --env-file .env.production ps
```

All containers should show `Up` and `healthy`.

### First-time setup

Open `https://eigen.example.com/admin` in your browser. The setup wizard will ask you to:
1. Choose a name for your organization
2. Create your admin account (email + password)
3. Configure storage settings

After setup, you're redirected to the login page. Sign in and you're ready to go!

## Step 6: Configure Email DNS Records

After Postfix starts for the first time, it generates a DKIM key. Check the logs:

```bash
docker compose --env-file .env.production logs postfix | grep -A1 "DKIM"
```

Now add these DNS records. **Records sit on `MAIL_DOMAIN`, not `DOMAIN`** — for a typical
single-domain deploy they're the same; for split deployments (web on `eigen.example.com`,
mail at `@example.com`) the records go on `example.com`. The setup script printed the exact
host names for your config; this table shows the shape:

| Type | Name | Value |
|------|------|-------|
| TXT | `<MAIL_DOMAIN>` | `"v=spf1 mx include:your-relay.com ~all"` |
| TXT | `eigen._domainkey.<MAIL_DOMAIN>` | *(the DKIM key from the logs)* |
| TXT | `_dmarc.<MAIL_DOMAIN>` | `"v=DMARC1; p=quarantine; rua=mailto:postmaster@<MAIL_DOMAIN>"` |

Also set the **rDNS (PTR) record** in your VPS provider's control panel — it should resolve
to your web domain (the host the mail server actually runs on).

### What these do:
- **SPF** — tells receiving servers which IPs are allowed to send email for your domain
- **DKIM** — digitally signs your outgoing emails to prove they're from you
- **DMARC** — tells receiving servers what to do with unsigned/suspicious emails
- **rDNS** — maps your IP back to your domain (many email servers check this)

## Step 7: Connect Your Email Client (Optional)

To use Thunderbird, Apple Mail, or any IMAP client alongside the web interface:

| Setting | Value |
|---------|-------|
| Server | your web URL (`DOMAIN`) — e.g. `eigen.example.com` |
| Port | `993` |
| Security | SSL/TLS |
| Username | your email (`you@<MAIL_DOMAIN>`) |
| Password | your Eigen password |

Note the split: addresses live on `MAIL_DOMAIN` but the IMAP server hostname is the web
`DOMAIN` (that's where Dovecot runs). Same shape for SMTP submission on port 587.

Your IMAP client and the Eigen web interface share the same mailbox — changes sync both ways.

## Step 8: Connect Your Calendar App (Optional)

Eigen includes a CalDAV server. Connect Apple Calendar, Thunderbird, DAVx5 (Android), or any CalDAV client:

| Setting | Value |
|---------|-------|
| Server | `https://eigen.example.com/dav/` |
| Username | Your email (e.g., `you@eigen.example.com`) |
| Password | Your Eigen password |

Apple Calendar and DAVx5 auto-discover your calendars from just the server URL. Thunderbird requires
the full calendar URL (`https://eigen.example.com/dav/calendars/{userId}/`).

Events sync both ways — create, edit, and delete in your calendar app or the Eigen web interface.

## Other deployment shapes

Steps 1–8 give you the all-in-one path: Eigen runs its own webserver and mail server. If
that's what you want, skip ahead to "Updating Eigen".

If you already run nginx, Caddy, or Apache on this server, or run your own postfix, or use
Cloudflare Tunnel / Tailscale Funnel, you can opt out of bundled pieces. Mix and match
with `COMPOSE_PROFILES`:

| Your setup | `COMPOSE_PROFILES=` |
|---|---|
| Default (bundled webserver + bundled mail) | `edge,mail` |
| Bundled mail, **your** webserver | `static,mail` |
| Bundled webserver, **your** mail server | `edge` |
| Neither — host runs both | `static` |

`bun run setup` asks "Run Eigen behind an existing webserver?" — answering yes sets
`static,mail` and writes a tiny ready-to-use webserver snippet next to `.env.production`.

### Running alongside an existing webserver

When `edge` is off and `static` is on, a small `eigen-static` container handles all the
SPA serving and API proxying internally on `127.0.0.1:8080`. Your webserver only needs to
terminate HTTPS and forward everything there.

The setup script writes two snippets you can drop in as-is:

- **`eigen.nginx.conf`** — symlink into `/etc/nginx/sites-enabled/`. About 25 lines:
  one `proxy_pass http://127.0.0.1:8080`, plus the WebSocket upgrade map and the SSE
  buffering settings collaborative editing needs.
- **`eigen.Caddyfile`** — append to your existing `Caddyfile`. Six lines: a single
  `reverse_proxy 127.0.0.1:8080`. Caddy auto-detects WebSocket upgrades, so no map
  directive needed.

The bundled `eigen-static` container is built from your local `dist/` directory at
`docker compose build` time, so it always matches the freshly-built frontend. Update
flow stays the same: `bun run build && docker compose --env-file .env.production up -d
--build`.

**On Apache**: skip the `prefork` MPM. It uses one process per long-lived SSE / WebSocket
connection and exhausts process slots quickly. Use the [event MPM](https://httpd.apache.org/docs/2.4/mod/event.html) instead.

#### TLS certs without bundled Caddy

The bundled certificate manager lives inside the Caddy container. When Caddy is off, postfix
and dovecot still need certs for IMAPS / SMTPS. Reuse your host's Let's Encrypt certs with
the host-cert overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.host-certs.yml \
    --env-file .env.production up -d
```

That mounts `/etc/letsencrypt/live/${MAIL_DOMAIN}/` into postfix and dovecot read-only. Wire
a certbot deploy-hook so they reload after each renewal:

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/eigen.sh > /dev/null <<'EOF'
#!/usr/bin/env sh
docker compose -f /opt/eigen/docker-compose.yml \
    -f /opt/eigen/docker-compose.host-certs.yml \
    --env-file /opt/eigen/.env.production kill -s HUP postfix dovecot
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/eigen.sh
```

### Running alongside an existing mail server

When `mail` is off, the postfix / dovecot / unbound containers don't start. Outbound
notifications (welcome, password reset, calendar invites, share-by-email) keep working —
Eigen relays through whatever `SMTP_HOST` points at. Add to `.env.production`:

```
SMTP_HOST=host.docker.internal
SMTP_PORT=25
```

`host.docker.internal` is Docker's name for "the machine the container is running on". For
this to work, your host postfix needs to:
- Bind to `0.0.0.0` (or the docker bridge gateway, default `172.20.0.1`), not just
  `127.0.0.1`-only
- Permit relay from the docker bridge subnet (`172.20.0.0/24`)

A third-party relay (Brevo, SendGrid, Postmark) works the same way: set `SMTP_HOST` to the
relay host and use the standard `SMTP_RELAY_*` credentials in `.env.production`.

> **Heads-up**: the in-app **Mail** tab still appears when bundled mail is off, and clicking
> it returns errors (the gating flag is on the roadmap, not shipped). Tell users to point
> their IMAP client at your existing mail server instead. Outbound from Eigen (welcome,
> password reset, share invites) is unaffected.

### Cloudflare Tunnel

Same shape as the host-webserver path — Cloudflare's `cloudflared` daemon is your edge. Use
`COMPOSE_PROFILES=static,mail`, keep `EIGEN_STATIC_BIND=127.0.0.1:8080`, and point the
tunnel at the bundled static container:

```yaml
# cloudflared config.yml
ingress:
  - hostname: eigen.example.com
    service: http://localhost:8080
  - service: http_status:404
```

WebSocket and SSE pass through the tunnel transparently. No public ports needed on the host.

### Tailscale Funnel / Serve

Identical shape — Tailscale terminates HTTPS, forwards to the static container:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale funnel --bg 443
```

### Mail at a different domain than the web URL

When you want addresses at `you@example.com` but Eigen at `eigen.example.com`, set them
separately during setup:

```
DOMAIN=eigen.example.com
MAIL_DOMAIN=example.com
```

DNS records for mail (MX, SPF, DKIM, DMARC) live on `MAIL_DOMAIN`. The MX *target* is your
web host:

```
example.com.            MX   10 eigen.example.com.
example.com.            TXT  "v=spf1 mx -all"
_dmarc.example.com.     TXT  "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com"
eigen._domainkey.example.com.  TXT  "<key from postfix logs after first boot>"
```

**Autoconfig caveat**: mail clients (Apple Mail, Thunderbird) look for auto-discovery at
`https://autoconfig.example.com/.well-known/autoconfig/mail/config-v1.1.xml` — that's the
apex, not the subdomain Caddy serves. Two options:

1. **Manual config**: tell users to enter `eigen.example.com` as the IMAP / SMTP server
   hostname when adding their account. Inelegant but works everywhere.
2. **Add an `autoconfig` DNS record**: point `autoconfig.example.com` at the same IP, then
   add a Caddy block that serves the same `autoconfig.xml` on that hostname. The setup
   script prints the right A record automatically when `DOMAIN ≠ MAIL_DOMAIN`.

## Updating Eigen

When there's a new version:

```bash
cd /opt/eigen
./scripts/update.sh
```

This pulls the latest code, installs dependencies, builds the frontend sequentially, sets data
directory permissions, and restarts the containers. Active connections (SSE, WebSocket) will
briefly reconnect.

## Backups

Create a backup:

```bash
./scripts/backup.sh
```

This saves all your data (emails, files, contacts, calendars, settings) to `./backups/`. Set up a daily cron job:

```bash
crontab -e
# Add: 0 3 * * * /opt/eigen/scripts/backup.sh
```

## Firewall

If you use a firewall, open these ports:

```bash
ufw allow 80/tcp     # HTTP (redirects to HTTPS)
ufw allow 443/tcp    # HTTPS (web interface)
ufw allow 443/udp    # HTTP/3 (optional, faster connections)
ufw allow 25/tcp     # SMTP (receive email)
ufw allow 465/tcp    # SMTPS (send email from external clients)
ufw allow 587/tcp    # SMTP submission (send email from external clients)
ufw allow 993/tcp    # IMAP (email clients)
ufw allow 22/tcp     # SSH (your access)
```

## Troubleshooting

### Check container status
```bash
docker compose --env-file .env.production ps
```

### View logs
```bash
docker compose --env-file .env.production logs            # All containers
docker compose --env-file .env.production logs caddy       # Just Caddy
docker compose --env-file .env.production logs eigen-api   # Just the API
docker compose --env-file .env.production logs postfix     # Just Postfix
docker compose --env-file .env.production logs dovecot     # Just Dovecot
```

### Restart everything
```bash
docker compose --env-file .env.production restart
```

### HTTPS certificate issues
Caddy handles certificates automatically. If something goes wrong, check Caddy's logs. Common issues:
- DNS not pointing to your server yet (wait for propagation)
- Port 80 or 443 blocked by firewall
- Another service using port 80/443

### Email not arriving
- Check Postfix logs: `docker compose --env-file .env.production logs postfix`
- Verify MX record: `dig yourdomain.com MX`
- Verify port 25 is open: `telnet yourdomain.com 25` from another machine
