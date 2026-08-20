# Setting Up Eigen on Your Server

A step-by-step guide to deploying your own Eigen instance.

## What You'll Get

- Web apps at `https://yourdomain.com` — mail, drive, docs, calendar, chat, and more
- Email send/receive with automatic DKIM signing
- IMAP (port 993) and SMTP submission (port 587) for desktop/mobile clients
- CalDAV for calendar apps
- WebDAV for mounting your Drive in Finder, Files, or any WebDAV client
- Automatic HTTPS via Let's Encrypt

Everything runs in Docker — isolated, reproducible, easy to update.

## Prerequisites

- A **Linux VPS** (Debian 12 or Ubuntu 22.04+, 2 GB+ RAM)
- A **domain** you control (e.g., `eigen.example.com`)
- **SSH access** to your server
- An **SMTP relay account** for outbound email (e.g. [Brevo](https://brevo.com)'s free tier — 300 emails/day)

### Why an SMTP relay?

Most VPS providers (Hetzner, DigitalOcean) block outbound port 25 to prevent spam. A relay sends through trusted servers so your emails reach inboxes. You can skip this initially and add it later.

---

## Quick Start

This path assumes a single domain, all-in-one Docker deploy. If you already run a webserver, your own mail server, or want addresses on a different domain than the web URL, see [Alternative deployments](#alternative-deployments) below.

### 1. Install Docker and Bun

```bash
curl -fsSL https://get.docker.com | sh
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
ln -sf ~/.bun/bin/bun  /usr/local/bin/bun
ln -sf ~/.bun/bin/bunx /usr/local/bin/bunx
```

Verify:

```bash
docker compose version   # need 2.20+
bun --version
```

### 2. Point your domain at the server

Add one DNS record (replace `eigen.example.com` with your domain and `1.2.3.4` with your server's IP):

| Type | Name | Value |
|------|------|-------|
| A | `eigen.example.com` | `1.2.3.4` |

Wait for propagation (5–30 minutes), then verify:

```bash
dig eigen.example.com A
```

Mail-related DNS records (MX, SPF, DKIM, DMARC, SRV) come in step 6, after the mail server has booted and generated its DKIM key.

### 3. Clone and configure

```bash
git clone https://github.com/eigen-is/eigen.git /opt/eigen
cd /opt/eigen
bun install
bun run setup
```

The setup script asks four questions and writes `.env.production`. If you have an SMTP relay, add the credentials:

```
SMTP_RELAY_HOST=smtp-relay.brevo.com
SMTP_RELAY_USER=your-api-key@brevo.com
SMTP_RELAY_PASSWORD=your-smtp-key
```

If you don't, leave them empty for now.

> **CI / scripted installs:** `./scripts/generate-env.sh eigen.example.com > .env.production` skips the prompts and uses defaults.

### 4. Build the frontend

```bash
set -a && source .env.production && set +a
bun run --sequential --filter './apps/*' build
```

`--sequential` builds one app at a time so 2–4 GB servers don't run out of memory.

### 5. Start Eigen

```bash
mkdir -p data && chown -R 1000:1000 data
docker compose --env-file .env.production up -d
```

Five containers start:

- **caddy** — reverse proxy with automatic HTTPS
- **eigen-api** — backend
- **unbound** — DNS resolver (Postfix needs a real one, not Docker's proxy)
- **postfix** — incoming mail + outbound via your relay
- **dovecot** — IMAP

Check status:

```bash
docker compose --env-file .env.production ps
```

All containers should show `Up` and `healthy`.

Open `https://eigen.example.com/admin` in your browser. The setup wizard creates your organization and admin account, then redirects you to the login page.

### 6. Add the mail DNS records

After Postfix starts for the first time, it generates a DKIM key. Print it:

```bash
docker compose --env-file .env.production logs postfix | grep -A1 "DKIM"
```

Add these DNS records:

| Type | Name | Value |
|------|------|-------|
| MX | `eigen.example.com` | `10 eigen.example.com` |
| TXT | `eigen.example.com` | `"v=spf1 mx include:your-relay.com ~all"` |
| TXT | `eigen._domainkey.eigen.example.com` | *(DKIM key from logs)* |
| TXT | `_dmarc.eigen.example.com` | `"v=DMARC1; p=quarantine; rua=mailto:postmaster@eigen.example.com"` |
| SRV | `_imaps._tcp.eigen.example.com` | `0 1 993 eigen.example.com` |
| SRV | `_submission._tcp.eigen.example.com` | `0 1 587 eigen.example.com` |
| SRV | `_caldavs._tcp.eigen.example.com` | `0 1 443 eigen.example.com` |
| SRV | `_carddavs._tcp.eigen.example.com` | `0 1 443 eigen.example.com` |
| TXT | `_caldavs._tcp.eigen.example.com` | `"path=/dav/"` |
| TXT | `_carddavs._tcp.eigen.example.com` | `"path=/dav/"` |

Set the **rDNS (PTR) record** in your VPS provider's panel — it should resolve to your domain.

> Registrar UIs often auto-append your domain to the Name field — enter `_imaps._tcp`, not `_imaps._tcp.eigen.example.com`, or the record lands one zone too deep. SRV forms that split the name into fields want service `_imaps`, protocol `tcp`, name `@`.

What these do:

- **MX** — tells the internet which server delivers your mail
- **SPF** — which IPs may send email for your domain
- **DKIM** — signs outgoing email to prove it's from you
- **DMARC** — tells receivers what to do with unsigned mail
- **rDNS** — maps your IP back to your domain (many servers check this)
- **SRV records** — let mail clients auto-discover IMAP/SMTP, and calendar/contacts clients CalDAV/CardDAV, from just an email address; the two TXT records tell CalDAV/CardDAV clients the path (RFC 6764)

### 7. Connect a mail or calendar client (optional)

**IMAP / SMTP:**

| Setting | Value |
|---------|-------|
| Server | `eigen.example.com` |
| IMAP port | `993` (SSL/TLS) |
| SMTP port | `587` (STARTTLS) |
| Username | `you@eigen.example.com` |
| Password | your Eigen password |

**CalDAV / CardDAV** (Apple Calendar & Contacts, DAVx5, Thunderbird):

| Setting | Value |
|---------|-------|
| Server | `https://eigen.example.com/dav/` |
| Username | `you@eigen.example.com` |
| Password | your Eigen password |

Some clients can also find the server from just the email address via the SRV records from step 6 (for example DAVx5's login-with-email flow); support varies per client, so the server URL above is the reliable path.

Thunderbird's calendar picker prefers the full URL: `https://eigen.example.com/dav/calendars/{userId}/` (shown on the Space → Integrations page, along with the address-book equivalent).

The web interface and IMAP/CalDAV clients share the same data — changes sync both ways.

You're done.

---

## Operations

> **Tip:** every `docker compose` command needs `--env-file .env.production`. To save typing:
> ```bash
> alias dc='docker compose --env-file .env.production'
> ```
> Examples below use the full form for clarity.

### Updating

```bash
cd /opt/eigen
./scripts/update.sh
```

Pulls latest code, rebuilds the frontend, restarts containers. Active SSE/WebSocket connections briefly reconnect.

### Backups

```bash
./scripts/backup.sh
```

Saves all data (mail, files, contacts, calendars, settings) to `./backups/`. This runs against the
**live** tree, so an in-flight SQLite WAL can be caught mid-write — fine for routine daily copies.
Schedule daily:

```bash
crontab -e
# 0 3 * * * /opt/eigen/scripts/backup.sh
```

For a **consistent** archive, `snapshot.sh` briefly stops `eigen-api`, tars the quiesced tree
(WAL/`-shm` files included, so the two never-checkpointed server databases are captured intact),
then restarts it — seconds of downtime for a crash-consistent copy:

```bash
./scripts/snapshot.sh                             # -> ./backups/eigen-snapshot-<timestamp>.tar.gz
./scripts/snapshot.sh /path/to/backup.tar.gz      # custom output path
```

Restore either archive with `restore.sh`. It stops `eigen-api`, moves the current `data/` aside to
`data.pre-restore-<timestamp>` (never deleted), unpacks the archive, and starts `eigen-api`:

```bash
./scripts/restore.sh ./backups/eigen-snapshot-<timestamp>.tar.gz
```

### Demo instance

A demo box wipes and reseeds itself every hour, so strangers can try the product without a login and
without leaving anything behind. Turn it on with `EIGEN_DEMO=1` in `.env.production` (any other value,
or unset, keeps normal behaviour):

```
EIGEN_DEMO=1
```

Reset the world once by hand, then let the timer keep it fresh. `demo-reset.sh` stops `eigen-api`,
wipes the per-home + server data (never `data/certs` or `data/dkim`), runs the seeder in a throwaway
container off the current image, and starts `eigen-api` again:

```bash
./scripts/demo-reset.sh
```

It refuses to run unless `EIGEN_DEMO=1` is present in `.env.production`, so it can never wipe a real
instance.

Install the hourly reset with the shipped systemd units (they are **not** auto-installed by `git pull`):

```bash
cp scripts/systemd/eigen-demo-reset.service scripts/systemd/eigen-demo-reset.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now eigen-demo-reset.timer
```

The units assume the repo lives at `/opt/eigen`; edit `WorkingDirectory`/`ExecStart` if yours differs.
Check the schedule with `systemctl list-timers eigen-demo-reset.timer` and follow a run with
`journalctl -u eigen-demo-reset.service -f`.

Prefer cron? One line does the same:

```bash
crontab -e
# 0 * * * * /opt/eigen/scripts/demo-reset.sh >> /var/log/eigen-demo-reset.log 2>&1
```

### Firewall

```bash
ufw allow 22/tcp     # SSH
ufw allow 80/tcp     # HTTP (redirects to HTTPS)
ufw allow 443/tcp    # HTTPS
ufw allow 443/udp    # HTTP/3 (optional)
ufw allow 25/tcp     # SMTP (incoming)
ufw allow 465/tcp    # SMTPS
ufw allow 587/tcp    # SMTP submission
ufw allow 993/tcp    # IMAP
```

### Troubleshooting

**Container status:**
```bash
docker compose --env-file .env.production ps
```

**Logs:**
```bash
docker compose --env-file .env.production logs              # all
docker compose --env-file .env.production logs eigen-api    # one container
```

**Restart everything:**
```bash
docker compose --env-file .env.production restart
```

**HTTPS not working** — Caddy handles certs automatically. Common causes:
- DNS not propagated yet
- Port 80 or 443 blocked by firewall
- Another service occupying 80/443

**Email not arriving:**
- `docker compose --env-file .env.production logs postfix`
- `dig eigen.example.com MX`
- `telnet eigen.example.com 25` from another machine

**Docker network subnet conflict** — if `docker compose up` fails with
`pool overlaps with other one on this address space`, another network on your host already uses `172.20.0.0/24`. Override both values in `.env.production`:

```
EIGEN_SUBNET=172.30.0.0/24
EIGEN_UNBOUND_IP=172.30.0.254
```

The two must stay consistent — unbound's IP must lie inside the subnet (postfix uses it as its DNS resolver, so the value can't be auto-derived).

---

## Alternative deployments

Pick one of these instead of (or in addition to) the Quick Start when your setup differs.

### Behind your existing webserver

**Pick this when** your server already runs nginx, Caddy, or Apache for other sites.

In step 3, when `bun run setup` asks "Run Eigen behind an existing webserver?", answer **yes**. The script sets `COMPOSE_PROFILES=static,mail` and writes a drop-in snippet next to `.env.production`:

- `eigen.nginx.conf` — symlink into `/etc/nginx/sites-enabled/`
- `eigen.Caddyfile` — append to your existing `Caddyfile`
- `eigen.apache.conf` — `a2ensite` it

Each snippet covers SSL termination, the WebSocket upgrade map, and the SSE buffering settings collaborative editing needs. They proxy to the bundled `eigen-static` container on `127.0.0.1:8080`.

**Apache notes:** the config header lists modules to enable (`a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers`) and a one-liner to switch from `mpm_prefork` to `mpm_event` — prefork uses one process per long-lived SSE/WebSocket connection and runs out of slots fast.

#### Behind a dockerised webserver (nginx proxy manager, etc.)

When the webserver itself runs in docker, `127.0.0.1` inside that container is its own loopback — not the host — so the generated snippets' `proxy_pass http://127.0.0.1:8080` won't reach `eigen-static`. Two ways to fix it:

- **Bind eigen-static on the LAN.** In `.env.production`:
  ```
  EIGEN_STATIC_BIND=0.0.0.0:8080
  ```
  Then point your dockerised webserver upstream at `<host-LAN-IP>:8080`. Simple, but exposes plain HTTP on the LAN.
- **Share the eigen docker network.** Attach the webserver container to the `eigen_eigen` network and proxy to `eigen-static:8080` directly. In the webserver's compose file:
  ```yaml
  services:
    nginx-proxy-manager:
      networks: [default, eigen]
  networks:
    eigen:
      external: true
      name: eigen_eigen
  ```
  Cleaner — nothing extra exposed, traffic stays on the docker bridge.

**Nginx Proxy Manager specific:** in the proxy host's edit dialog, switch on **Websockets Support** (off by default). Without it, collab editing on docs / sheets / slides / stickies will silently fail to connect.

#### TLS certs without bundled Caddy

The bundled cert manager lives in the Caddy container. When Caddy is off, postfix and dovecot still need certs for IMAPS/SMTPS. Reuse your host's Let's Encrypt certs with the host-cert overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.host-certs.yml \
    --env-file .env.production up -d
```

That mounts `/etc/letsencrypt/live/${MAIL_DOMAIN}/` into postfix and dovecot read-only. Wire a certbot deploy-hook so they reload after each renewal:

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/eigen.sh > /dev/null <<'EOF'
#!/usr/bin/env sh
docker compose -f /opt/eigen/docker-compose.yml \
    -f /opt/eigen/docker-compose.host-certs.yml \
    --env-file /opt/eigen/.env.production kill -s HUP postfix dovecot
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/eigen.sh
```

### Behind Cloudflare Tunnel or Tailscale Funnel

**Pick this when** you don't want public ports on your host.

Set `COMPOSE_PROFILES=static,mail` in `.env.production`. Eigen runs the bundled static container on `127.0.0.1:8080`; the tunnel is your edge. WebSocket and SSE pass through transparently.

**Cloudflare Tunnel:**

```yaml
# cloudflared config.yml
ingress:
  - hostname: eigen.example.com
    service: http://localhost:8080
  - service: http_status:404
```

**Tailscale Funnel:**

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale funnel --bg 443
```

### Using your existing mail server

**Pick this when** you already run postfix/dovecot on the host, or want a third-party mail provider to handle inbox/IMAP.

Set `COMPOSE_PROFILES=edge` in `.env.production` — postfix, dovecot, and unbound containers won't start. Outbound notifications (welcome, password reset, calendar invites) keep working through your existing SMTP. Add to `.env.production`:

```
SMTP_HOST=host.docker.internal
SMTP_PORT=25
```

`host.docker.internal` is Docker's name for "the machine the container is running on". For this to work, your host postfix needs to:

- Bind to `0.0.0.0` (or the docker bridge gateway, default `172.20.0.1`), not just `127.0.0.1`
- Permit relay from the docker bridge subnet (`172.20.0.0/24`, or whatever you set `EIGEN_SUBNET` to)

Third-party relays (Brevo, SendGrid, Postmark) work the same way — set `SMTP_HOST` to the relay host and use the standard `SMTP_RELAY_*` credentials.

> **Heads-up:** the in-app **Mail** tab still appears when bundled mail is off, and clicking it returns errors (the gating flag is on the roadmap). Tell users to point their IMAP client at your existing mail server.

### Mail at a different domain than the web URL

**Pick this when** Eigen runs at `eigen.example.com` but addresses are `you@example.com`.

In `.env.production`:

```
DOMAIN=eigen.example.com
MAIL_DOMAIN=example.com
```

Mail DNS records (MX, SPF, DKIM, DMARC) live on `MAIL_DOMAIN`. The MX *target* is your web host:

```
example.com.                     MX   10 eigen.example.com.
example.com.                     TXT  "v=spf1 mx -all"
_dmarc.example.com.              TXT  "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com"
eigen._domainkey.example.com.    TXT  "<key from postfix logs after first boot>"
```

The autodiscovery SRV/TXT records also live on `MAIL_DOMAIN` — clients derive the lookup domain from the email address — while their targets point at the web host:

```
_imaps._tcp.example.com.         SRV  0 1 993 eigen.example.com.
_submission._tcp.example.com.    SRV  0 1 587 eigen.example.com.
_caldavs._tcp.example.com.       SRV  0 1 443 eigen.example.com.
_carddavs._tcp.example.com.      SRV  0 1 443 eigen.example.com.
_caldavs._tcp.example.com.       TXT  "path=/dav/"
_carddavs._tcp.example.com.      TXT  "path=/dav/"
```

**Autoconfig caveat:** mail clients look for auto-discovery at `https://autoconfig.example.com/...` — the apex, not Eigen's subdomain. Two options:

1. **Manual config** — tell users to enter `eigen.example.com` as the IMAP/SMTP server hostname when adding their account.
2. **Autoconfig record** — point `autoconfig.example.com` at the same IP. The setup script prints the right A record automatically when `DOMAIN ≠ MAIL_DOMAIN`.

### Compose profile reference

`COMPOSE_PROFILES` controls which bundled services start. `bun run setup` picks the right value based on your answers; you can also edit `.env.production` directly:

| Setup | Profile |
|---|---|
| All-in-one (default) | `edge,mail` |
| Bundled mail, your webserver | `static,mail` |
| Bundled webserver, your mail server | `edge` |
| Neither — host runs both | `static` |
