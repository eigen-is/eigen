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

- A **Linux server** (Debian 12 or Ubuntu 22.04+, 2 GB+ RAM) on amd64 or arm64
- **Docker** with the **Docker Compose plugin 2.20 or newer**. No Bun or Node on the server.
- A **domain** you control (e.g., `eigen.example.com`)
- **SSH access** to your server
- An **SMTP relay account** for outbound email (e.g. [Brevo](https://brevo.com)'s free tier — 300 emails/day)

### Why an SMTP relay?

Most VPS providers (Hetzner, DigitalOcean) block outbound port 25 to prevent spam. A relay sends through trusted servers so your emails reach inboxes. You can skip this initially and add it later by running `./eigen setup` again.

---

## Quick Start

This path assumes a single domain, all-in-one Docker deploy. If you already run a webserver, your own mail server, or want addresses on a different domain than the web URL, see [Alternative deployments](#alternative-deployments) below.

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
docker compose version   # need 2.20+
```

`./eigen` checks both before it does anything.

### 2. Point your domain at the server

Add one DNS record (replace `eigen.example.com` with your domain and `1.2.3.4` with your server's IP):

| Type | Name | Value |
|------|------|-------|
| A | `eigen.example.com` | `1.2.3.4` |

Wait for propagation (5–30 minutes), then verify:

```bash
dig eigen.example.com A
```

`./eigen setup` lists every record your answers need. The mail-related ones (MX, SPF, DKIM, DMARC, SRV) come in step 6, after the mail server has booted and generated its DKIM key.

### 3. Install Eigen

Eigen lives in one folder, `/opt/eigen` in this guide. Its data lives there too. Install the newest release:

```bash
mkdir -p /opt/eigen && cd /opt/eigen
curl -fsSL https://eigen.is/install | sh
```

The script downloads the `eigen` command into the folder and runs `./eigen setup`. Setup downloads the newest release, asks the questions of step 4, starts Eigen and prints the link of step 5. The folder then holds the `eigen` command, the Compose file, `.env.example`, the fail2ban files and `.env.production`. That file names the release, so the install stays on that version until `./eigen update`.

Rather not pipe a script into `sh`? The same install, by hand, from the release image:

```bash
mkdir -p /opt/eigen && cd /opt/eigen
docker run --rm -v "$PWD:/out" ghcr.io/eigen-is/eigen/api:latest bootstrap
./eigen setup
```

`bootstrap` writes the same files; name a tag instead of `latest`, like `api:0.3.0`, for a specific release.

Developing Eigen? `./eigen setup` also builds the images from a clone of the repository: see [CONTRIBUTING.md § Eigen in Docker](../docs/CONTRIBUTING.md#eigen-in-docker). On a server, run a release.

### 4. Answer the setup questions

`./eigen setup` asks, in this order, and suggests an answer for each:

1. **Where will Eigen be hosted?** The web address, like `eigen.example.com`.
2. **Which mail domain will you use?** Everyone's address and login is on it, like `jane@example.com`. It defaults to the web address. The mail domain cannot change after setup: every account is made on it. A later `./eigen setup` shows it instead of asking.
3. **How do people reach Eigen over HTTPS?** Eigen handles it on ports 80 and 443, or your own web server forwards to it ([Behind your existing webserver](#behind-your-existing-webserver)). With Eigen's own, it asks which email address Let's Encrypt should use, `admin@<mail domain>` by default; with yours, where Eigen should listen for it.
4. **Host email on this server?** Yes: Eigen hosts the mailboxes, on ports 25, 465, 587 and 993. No: see [Using your existing mail server](#using-your-existing-mail-server).
5. **Which mail relay should Eigen send through?** Optional with hosted mail, like `smtp-relay.brevo.com:587`, then its user name and password. With hosted mail, Postfix sends every user's mail through it as that user, so the relay must accept every address on your mail domain.

Before the first question, it downloads the release. After the last, it writes the answers to `.env.production` (only its owner can read it), lists the DNS records to add, and starts Eigen. Run `./eigen setup` again at any time to change an answer: it keeps the others and every key it does not know. `./eigen setup --help` lists the flags for a run without questions.

Run `./eigen` as the owner of the folder or as root, with access to Docker. To call it from anywhere, link it: `ln -s /opt/eigen/eigen /usr/local/bin/eigen`.

Five containers start:

- **caddy** — reverse proxy with automatic HTTPS
- **eigen-api** — backend
- **unbound** — DNS resolver (Postfix needs a real one, not Docker's proxy)
- **postfix** — incoming mail + outbound via your relay
- **dovecot** — IMAP

### 5. Finish in your browser

Setup ends with a one-time link, `https://eigen.example.com/admin/#setup=…`. Open it. It asks for the name of your organization, the sender of Eigen's own mail (codes, invitations and notifications; the organization name and `noreply@<mail domain>` unless you change them), where to keep files, and your admin account. Then **Go to Login** takes you to the sign-in page. You can change the sender later in Admin, under **Settings → Mail**. The link works once; lost it? Run `./eigen setup` again for a fresh one.

Check on Eigen at any time with `./eigen status`.

### 6. Add the mail DNS records

After Postfix starts for the first time, it generates a DKIM key. It is in `data/dkim/eigen.txt`, and in the postfix log of that first start (`./eigen logs postfix`, Ctrl-C to stop).

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

Everything runs through `./eigen` in the install folder. `./eigen help` lists the commands, `./eigen <command> --help` tells more about one.

```bash
./eigen status                   # version, pending update, services, disk, snapshots, certificate, mail queue
./eigen logs [service]           # follow the logs of every service, or of one
./eigen restart                  # start Eigen, and any part of it that stopped
./eigen stop                     # stop Eigen; ./eigen restart starts it again
./eigen reset-password <email>   # set a new password for an account
```

`status` names the newest snapshot, and how many `snapshots/` holds and their size on disk. On a release install, an update that stopped halfway shows as `files of <new version> (<commit>), running <old version> (<commit>)`; `./eigen update` finishes it. On the main channel it shows a newer build as `a new build of main is out (<commit>)`.

`./eigen` runs one command that changes Eigen at a time: while one runs, a second, like a nightly backup in the middle of an update, stops with "Another ./eigen command is running."

`reset-password` asks for the password (or `--generate` makes one up and prints it once), signs the account out everywhere, and stops its app passwords for mail, calendar and file apps. It needs Eigen running. An admin can do the same from the admin Users page, for anyone but the owner, whose password only the owner resets there.

### Updating

```bash
./eigen update
```

It gets the newest release, or the one you name (`./eigen update 0.3.1`). When the release notes list breaking changes, it shows them and asks whether to go on; run without a terminal, like from cron, it refuses until you run `./eigen update --accept-breaking`.

The download happens while Eigen runs. Then Eigen stops, saves a snapshot in `snapshots/`, switches to the new version and starts again. That snapshot is a light one: the databases, settings and `.env.production`, without the files and the mail. When a release since yours marks a change (breaking) in its CHANGELOG, or with `./eigen update --full`, it is a full one, files and mail too. Eigen is down for the length of that snapshot; the update checks first that the snapshot fits on the disk. It keeps the snapshots of the last two updates of each kind; a light one is named `eigen-pre-update-light-<UTC time>.tar.gz`. Active SSE/WebSocket connections briefly reconnect. `./eigen update --check` only tells whether there is an update, and what it brings.

`./eigen rollback` goes back to the version before the last update, with the data as it was then: it puts back the snapshot the update saved, with the images it pins, and starts Eigen. The current data is kept aside. After a light snapshot it puts back only the databases, settings and `.env.production`, so files and mail added since the update stay. It goes back one update only.

**Following the newest code instead of releases.** `./eigen update main` puts a release install on the main channel. Every push to `main` builds new images; `./eigen update` then installs the newest build, and `./eigen status` names the build, like `0.3.0 (abc1234) on main`. While a build is still being published, `./eigen update` says so; run it again a few minutes later. Release notes and the (breaking) question apply only when the version number changes, so on the channel a breaking change can arrive unannounced. The channel is for the people who develop Eigen. `./eigen update <version>` returns to releases.

On a version without light snapshots, the first `./eigen update` stops at the snapshot, because that version cannot save a light one. Run `./eigen update --full` then. `./eigen rollback` cannot undo that first update, because the older version records it in a form the new `./eigen` does not read. `./eigen restore` with its `eigen-pre-update-*` snapshot can.

### Backups

```bash
./eigen backup
```

Saves all data (mail, files, contacts, calendars, settings, the server databases) and `.env.production` as one full snapshot, `snapshots/eigen-<UTC time>.tar.gz`. It checks first that the snapshot fits on the disk, stops every service, archives the quiet `data/` with its owners and modes, and starts Eigen again: a short downtime for a consistent snapshot. Then it deletes all but the newest three snapshots of that kind it made, so light ones never push out the last full one; `--keep <n>` keeps another number, and the snapshots of updates do not count. `./eigen backup --light` saves a light snapshot, `snapshots/eigen-light-<UTC time>.tar.gz`: the databases, settings and `.env.production`, without the files and the mail. Only the owner of the install folder can read a snapshot. Not in any snapshot: `caddy-data/`, from which Caddy gets its certificates again, the Postfix queue of mail still waiting to go out, `backups/` with the per-home archives, and `docker-compose.override.yml`. Copy snapshots off the server, and schedule the backup daily:

```bash
crontab -e
# 0 3 * * * /opt/eigen/eigen backup
```

Put a snapshot back with `./eigen restore`. It unpacks and checks the snapshot while Eigen runs, asks, then stops Eigen, moves the current `data/` and `.env.production` aside to `data.pre-restore-<UTC time>` and `.env.production.pre-restore-<UTC time>` (never deleted), puts the snapshot in their place and starts Eigen again. A light snapshot puts back only the databases, settings and `.env.production`, moves the ones it replaces aside into `data.pre-restore-<UTC time>`, and leaves files and mail as they are. A snapshot records the images it ran on: on a release install, a snapshot that pins another build brings that build back, with its launcher and Compose files, as a rollback does. The images come first: if they cannot be downloaded, Eigen runs on as it was. It refuses a snapshot of a newer Eigen version: update first, then restore. It also refuses a snapshot of a local build on a release install, and the other way around. `data/` must be a plain folder inside the install folder, not a link or a mount of another disk.

```bash
./eigen restore eigen-<UTC time>.tar.gz
./eigen restore eigen-<UTC time>.tar.gz --yes   # without the question, for scripts
```

**Per-home backups** are the other half, and they need no downtime: an admin backs up, verifies, downloads and restores one user or one team from the Backup section of the admin Users and Teams detail panes. Those archives land in `./backups/` (`EIGEN_BACKUPS_DIR=/app/backups` inside the container, bind-mounted from the host), so keep an eye on its size. An archive holds every file, every mail and the mount credentials, so treat one like `.env.production`. Full operator guide: [docs/BACKUP.md](../docs/BACKUP.md).

`./eigen backup` is the whole-server backup: the per-home archives do not cover `users3.db`, `eigen.db`, `waitlist.db`, the server config or `.env.production`.

### Settings setup does not ask for

`.env.example` lists them under ADVANCED: the Docker subnet, the Compose project name, the mail queue alert, demo mode ([DEMO_MODE.md](../docs/DEMO_MODE.md)). Add a key to `.env.production`, then run `./eigen setup` again.

Extra Compose settings go in `docker-compose.override.yml` in the install folder, the one place for them: `./eigen` adds it to every Compose command, and an update leaves it alone. An override that uses Compose's `!override` tag needs Compose 2.24.4 or newer. For example, your own Caddyfile:

```yaml
services:
  caddy:
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
```

Or the API on a host port for debugging (`curl http://127.0.0.1:8000/health`):

```yaml
services:
  eigen-api:
    ports: ["127.0.0.1:8000:8000"]
```

Then `./eigen restart`.

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

### Mail abuse hardening

One stolen account password is enough to turn a mail server into a spam relay. In August 2026 a botnet pushed about 17k messages through eigen.is on port 465 with one password, using forged sender addresses. Three defenses are on by default. A fourth, fail2ban, is host config you install yourself.

**Senders are bound to their login.** On the submission ports (587 and 465) an authenticated user can only send as their own address. Postfix checks the envelope sender against `smtpd_sender_login_maps` (`docker/postfix/main.cf.template`) with `reject_authenticated_sender_login_mismatch` on both services (`master.cf.template`). Eigen gives every user one address and has no aliases and no send-as, so the map is the identity map in `docker/postfix/sender_login.regexp`. A forged sender gets `553 5.7.1 ... not owned by user`. One exemption comes first (`docker/postfix/null_sender.regexp`): an empty envelope sender, `MAIL FROM:<>`, is permitted, because the identity map gives it no owner and read receipts and vacation replies are required to be sent that way (RFC 3834). It opens no relay: the recipient rules still demand a login. Inbound port 25 keeps accepting foreign senders: the `authenticated_` variant of the check does nothing when there is no login. The API sends over `postfix:25` without authenticating, so app mail is unaffected.

**Failed logins are rate limited.** The API verifies every SASL login and counts failures in a sliding 15 minute window, 10 per address and 50 per client IP. It sees the client IP because Dovecot's `checkpassword` helper passes it along. Each submission service also caps AUTH attempts per client IP with Postfix's anvil counter, and hangs up on a session that keeps making errors:

| Setting | Value | Why this value |
|---|---|---|
| `smtpd_client_auth_rate_limit` | `20` per 60s | A client authenticates about once per message. Twenty a minute is well above what a real client does and well below what a password-guessing run needs. |
| `smtpd_hard_error_limit` | `5` | A submission client that makes five errors in one session is broken or hostile, so Postfix hangs up. Inbound port 25 keeps the default of 20, where a rejected recipient should not end the session. |

The AUTH rate limit is per client IP, so one abusive address cannot spend another client's budget. The hard error limit counts within a single SMTP session, so a hostile client gets a new budget on every reconnect. The rate limit and fail2ban are what make reconnecting expensive.

**The queue is watched.** `docker/postfix/queue-monitor.sh` counts the queue every `QUEUE_CHECK_INTERVAL` seconds (default 300). Above `QUEUE_ALERT_THRESHOLD` messages (default 200) it notifies the instance owner in the web UI. Set any of these in `.env.production` to tune it. Raise the threshold if your instance legitimately queues a few hundred messages. While the backlog lasts it repeats the alert at most every `QUEUE_ALERT_COOLDOWN` seconds (default 21600, six hours), and it re-arms once the queue drains. It is a notification and not an email, because an email about a jammed queue would sit in that queue. The 17k backlog above went unnoticed for a day.

**fail2ban (opt-in).** The layers above limit the damage but still accept the connections. To drop the traffic at the firewall, install the shipped jails. There are two, one for Postfix's submission ports and one for Dovecot's IMAPS, because a botnet that gets nowhere on 465 starts guessing on 993 and that traffic is in the dovecot log only. Each bans an IP after five failed logins in ten minutes:

```bash
apt-get install fail2ban
cp /opt/eigen/docker/fail2ban/filter.d/eigen-postfix-sasl.conf  /etc/fail2ban/filter.d/
cp /opt/eigen/docker/fail2ban/filter.d/eigen-dovecot-auth.conf  /etc/fail2ban/filter.d/
cp /opt/eigen/docker/fail2ban/jail.d/eigen-mail-sasl.conf       /etc/fail2ban/jail.d/
systemctl enable --now fail2ban
systemctl restart fail2ban
fail2ban-client status eigen-postfix-sasl
fail2ban-client status eigen-dovecot-auth
```

It stays host config because fail2ban writes host firewall rules, and it bans in the `DOCKER-USER` chain because Docker's published ports never pass through `INPUT`. The jails' log glob is expanded at start and the Docker log path embeds the container ID, so recreating the mail containers silently disarms them until a reload. After a start that recreated the mail containers, `./eigen` copies the filters again and runs `fail2ban-client reload` when the jails are installed and it can write them (as root, in practice); otherwise it prints the command to run as root. Only a by-hand `docker compose up` leaves the reload to you. Tuning, checks, and the nftables variant are in [docker/fail2ban/README.md](fail2ban/README.md).

The postfix and dovecot logs are the record of an abuse run, and what fail2ban reads, so they keep 10 files of 50 MB where the other containers keep 3 of 10 MB. During the incident the old 3x10 MB rotated away in about two hours and took the start of the run with it.

### Troubleshooting

**Status, logs, restart:**
```bash
./eigen status              # every service, its health, disk, certificate
./eigen logs                # all
./eigen logs eigen-api      # one service
./eigen restart
```

When a step of `./eigen` fails, it shows the last lines of its output; the full output is in `.eigen/last-step.log`.

**HTTPS not working** — Caddy handles certs automatically. Common causes:
- DNS not propagated yet
- Port 80 or 443 blocked by firewall
- Another service occupying 80/443

**Email not arriving:**
- `./eigen logs postfix`
- `dig eigen.example.com MX`
- `telnet eigen.example.com 25` from another machine

**Docker network subnet conflict.** `./eigen setup` picks a subnet no other Docker network uses. If a network added later overlaps and Eigen fails to start with `pool overlaps with other one on this address space`, set both values in `.env.production`, then run `./eigen setup` again:

```
EIGEN_SUBNET=172.30.0.0/24
EIGEN_UNBOUND_IP=172.30.0.254
```

The two must stay consistent: unbound's IP must lie inside the subnet (postfix uses it as its DNS resolver).

---

## Alternative deployments

Pick one of these instead of (or in addition to) the Quick Start when your setup differs.

### Behind your existing webserver

**Pick this when** your server already runs nginx, Caddy, or Apache for other sites.

In step 4, when `./eigen setup` asks "How do people reach Eigen over HTTPS?", pick **My web server forwards to Eigen**, and give the address Eigen listens on for it (`127.0.0.1:8080` by default). Setup runs the bundled `eigen-static` container there instead of Caddy (`COMPOSE_PROFILES=static,…`) and writes a drop-in snippet for each web server next to `.env.production`:

- `eigen.nginx.conf`: link into `/etc/nginx/sites-enabled/`, reload nginx
- `eigen.Caddyfile`: import it in your `Caddyfile`, reload Caddy
- `eigen.apache.conf`: copy to `sites-available/eigen.conf`, `a2ensite eigen`

The nginx and Apache snippets expect a certbot certificate for your web address.

Each snippet covers SSL termination, the WebSocket upgrade map and the SSE buffering settings collaborative editing needs, and sets `X-Real-IP` to the real visitor. They proxy to the bundled `eigen-static` container on the address you gave, which sets a baseline set of security response headers itself (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`), as the bundled Caddy does. The Content-Security-Policy and referrer meta ride inside each app's HTML, so every deployment shape inherits them without proxy config.

The `eigen-static` gateway only ever receives connections from your host proxy over the docker bridge / loopback, so it trusts private-range peers and forwards their `X-Real-IP` through to the API. That is what keeps rate limiting, login lockout, and OTP throttling keyed on the actual visitor rather than collapsing every user into one bucket, so the proxy must set `X-Real-IP` to the visitor's address (the generated snippets do). `X-Forwarded-For` alone is not trusted, because a client can prepend its own value and pick its rate-limit key.

**Apache notes:** the config header lists modules to enable (`a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers`) and a one-liner to switch from `mpm_prefork` to `mpm_event` — prefork uses one process per long-lived SSE/WebSocket connection and runs out of slots fast.

#### Behind a dockerized webserver (nginx proxy manager, etc.)

When the webserver itself runs in docker, `127.0.0.1` inside that container is its own loopback, not the host, so the generated snippets' `proxy_pass http://127.0.0.1:8080` won't reach `eigen-static`. Two ways to fix it:

- **Share the eigen docker network** (preferred). Attach the webserver container to Eigen's network, `<project>_eigen` (`eigen_eigen` for an install in `/opt/eigen`), and proxy to `eigen-static:8080` directly. In the webserver's compose file:
  ```yaml
  services:
    nginx-proxy-manager:
      networks: [default, eigen]
  networks:
    eigen:
      external: true
      name: eigen_eigen
  ```
  Nothing extra is exposed, and the traffic stays on the docker bridge.
- **Listen on the Docker host's address.** Answer `172.17.0.1:8080`, the host's address on Docker's default bridge, when setup asks where Eigen should listen, as its hint says. The generated snippets then proxy to that address, which a container can reach and the LAN cannot.

**Nginx Proxy Manager specific:** in the proxy host's edit dialog, switch on **Websockets Support** (off by default). Without it, collab editing on docs / sheets / slides / stickies will silently fail to connect.

#### TLS certs without bundled Caddy

The bundled cert manager lives in the Caddy container. When Caddy is off, postfix and dovecot still need a certificate for IMAPS and SMTPS. They read `data/certs/cert.pem` and `data/certs/key.pem`, and make a self-signed one when there is none. Mail clients connect to your web address (`DOMAIN`), so the certificate is the one for that name. Copy your host's Let's Encrypt certificate there with a certbot deploy hook, which runs after each renewal:

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/eigen.sh > /dev/null <<'EOF'
#!/bin/sh
set -e
live=/etc/letsencrypt/live/eigen.example.com
certs=/opt/eigen/data/certs
cp "$live/privkey.pem" "$certs/key.pem.tmp" && chmod 600 "$certs/key.pem.tmp" && mv -f "$certs/key.pem.tmp" "$certs/key.pem"
cp "$live/fullchain.pem" "$certs/cert.pem.tmp" && chmod 644 "$certs/cert.pem.tmp" && mv -f "$certs/cert.pem.tmp" "$certs/cert.pem"
cd /opt/eigen && docker compose --env-file .env.production kill -s HUP postfix dovecot
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/eigen.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/eigen.sh
```

Replace `eigen.example.com` with your web address. The last line runs the hook once, to put the current certificate in place. The signal makes both reload it; dovecot also notices a changed certificate by itself within ten minutes.

### Behind Cloudflare Tunnel or Tailscale Funnel

**Pick this when** you don't want public ports on your host.

In step 4, pick **My web server forwards to Eigen** and keep `127.0.0.1:8080`. Eigen runs the bundled static container there; the tunnel is your edge. WebSocket and SSE pass through transparently. Neither tunnel sets `X-Real-IP`, so all their visitors share one rate-limit and login-lockout bucket; put nginx, Caddy or Apache between the tunnel and the gateway if per-visitor limits matter.

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

Answer **No** to "Host email on this server?" in step 4 (`--no-mail`). Postfix, Dovecot and Unbound don't start, and the server hosts no mailboxes: the Mail app, its entries in the app switcher and command palette, the "Mail to…" actions and the IMAP settings card all disappear, and anyone who still opens `/mail` gets a plain "Mail is turned off on this server" page. Addresses stay on your mail domain, and people still sign in with them; their mailboxes live wherever that domain's mail is hosted.

Eigen still sends mail of its own: two-factor codes by email, guest sign-in codes, invitations, share and access-request notifications, calendar invitations and replies. Without hosted mail it sends them through a relay, the next question setup asks. Without a relay every one of those emails fails. Setup warns when you leave it empty.

The relay is `host:port`, and one set of keys in `.env.production` holds it, `SMTP_RELAY_HOST`, `SMTP_RELAY_PORT`, `SMTP_RELAY_USER` and `SMTP_RELAY_PASSWORD`, whichever way mail is set up. A third-party relay (Brevo, SendGrid, Postmark) takes a user name and password; setup asks for both. Port 465 is implicit TLS, any other port STARTTLS. With a user name, the connection must be encrypted, so the password never goes over a plain connection; without hosted mail, the relay's certificate must check out too.

Your mail server on the same host works as a relay too: answer `host.docker.internal:25`. `host.docker.internal` is Docker's name for "the machine the container is running on". For this to work, your host postfix needs to:

- Bind to `0.0.0.0` (or the gateway of `EIGEN_SUBNET`, the Docker network in `.env.production`), not just `127.0.0.1`
- Permit relay from `EIGEN_SUBNET`

The relay must accept the system sender, the address Eigen's own mail comes from. You set it in the setup wizard, and later in Admin under **Settings → Mail**. Mail a person causes, like a share notification or a calendar invitation, comes from the system sender with their name, `Ada via Acme <noreply@example.com>`, and replies go to them. If your relay allows every address on your mail domain as a sender, turn on **Relay sends as users** in the same place: mail a person causes then comes from their own address. **Send test mail** there sends one mail from you to you, the way a share notification goes out.

Tell users to point their mail client at your existing mail server. Eigen shows no IMAP settings of its own.

### Mail at a different domain than the web URL

**Pick this when** Eigen runs at `eigen.example.com` but addresses are `you@example.com`.

Answer `eigen.example.com` to the first setup question and `example.com` to the second. In `.env.production` that is:

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

1. **Manual config.** Tell users to enter `eigen.example.com` as the IMAP/SMTP server hostname when adding their account.
2. **Autoconfig record.** Point `autoconfig.example.com` at the same IP. `./eigen setup` lists that A record when `DOMAIN ≠ MAIL_DOMAIN`.

### Compose profile reference

`COMPOSE_PROFILES` controls which bundled services start. `./eigen setup` writes it from your answers to the HTTPS and mail questions; to change it, run `./eigen setup` again with other answers:

| Setup | Profile |
|---|---|
| All-in-one (default) | `edge,mail` |
| Bundled mail, your webserver | `static,mail` |
| Bundled webserver, your mail server | `edge` |
| Neither — host runs both | `static` |
