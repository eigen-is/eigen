# Setting Up Eigen on Your Server

This guide takes you from an empty server to a running Eigen. It is longer than the install itself. The install is two lines; the rest is here for when your situation differs, and for the day something breaks.

## What you get

- The web apps at `https://yourdomain.com`: mail, drive, docs, sheets, slides, stickies, chat, calendar, contacts and vector
- Your own mail server, sending and receiving, with DKIM signing
- IMAP (port 993) and SMTP (port 587) for mail clients on your phone and desktop
- CalDAV and CardDAV for calendar and contacts apps
- WebDAV, so you can mount your drive in Finder, Files or any WebDAV client
- HTTPS from Let's Encrypt, renewed by itself

Everything runs in Docker. Updating is one command, and so is going back.

## Prerequisites

- A **Linux server** (Debian 12 or Ubuntu 22.04 or newer, 2 GB of RAM or more), amd64 or arm64
- **Docker**, with the **Docker Compose plugin 2.20 or newer**. Nothing else: no Bun, no Node.
- A **domain** you control, like `eigen.example.com`
- **SSH access** to the server
- A **mail relay**, optional. Most servers do without one: [Do I need a mail relay?](#do-i-need-a-mail-relay)

---

## Quick Start

This is the plain install: one domain, everything in Docker on one server. If you already run a web server or a mail server, or want addresses on another domain than the web address, read [Alternative deployments](#alternative-deployments) first.

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
docker compose version   # 2.20 or newer
```

`./eigen` checks both before it does anything.

### 2. Point your domain at the server

Add one DNS record. Replace `eigen.example.com` with your domain and `1.2.3.4` with the IP address of your server:

| Type | Name | Value |
|------|------|-------|
| A | `eigen.example.com` | `1.2.3.4` |

DNS takes a few minutes to spread, sometimes half an hour. Check with:

```bash
dig eigen.example.com A
```

`./eigen setup` lists every record your answers need. The mail records (MX, SPF, DKIM, DMARC, SRV) come in step 6, once the mail server has started and made its DKIM key.

### 3. Install Eigen

Eigen lives in one folder. Everything is in there: the `eigen` command, the config, and all your data. I use `/opt/eigen` in this guide, but any folder will do.

Whoever runs the install owns it. Root is fine. So is a normal user, as long as that user can use Docker (a member of the `docker` group). Use the same user every time you run `./eigen`.

Make the folder and install the newest release:

```bash
mkdir -p /opt/eigen && cd /opt/eigen
curl -fsSL https://eigen.is/install | sh
```

The script downloads the `eigen` command and runs `./eigen setup`. Setup gets the newest release, asks a few questions (step 4), starts Eigen and prints a link (step 5). Your answers end up in `.env.production`. That file also names the release you run, so nothing changes until you run `./eigen update`.

Want to type `eigen` from anywhere? Link it: `ln -s /opt/eigen/eigen /usr/local/bin/eigen`.

Rather not pipe a script into `sh`? The same install, by hand, from the release image:

```bash
mkdir -p /opt/eigen && cd /opt/eigen
docker run --rm -v "$PWD:/out" ghcr.io/eigen-is/eigen/api:latest bootstrap
./eigen setup
```

`bootstrap` writes the same files. Name a tag instead of `latest`, like `api:0.3.0`, for a specific release.

Developing Eigen? `./eigen setup` also builds the images from a clone of the repository. See [CONTRIBUTING.md § Eigen in Docker](../docs/CONTRIBUTING.md#eigen-in-docker). On a server, run a release.

### 4. Answer the setup questions

`./eigen setup` asks five questions, in this order, and suggests an answer for each:

1. **Where will Eigen be hosted?** Your web address, like `eigen.example.com`.
2. **Which mail domain will you use?** Everyone's address and login is on it, like `jane@example.com`. It defaults to the web address. You cannot change it later: every account is made on it. A later `./eigen setup` shows it instead of asking.
3. **How do people reach Eigen over HTTPS?** Eigen handles it on ports 80 and 443, or your own web server forwards to it ([Behind your existing webserver](#behind-your-existing-webserver)). With Eigen's own, it asks which email address Let's Encrypt may use, `admin@<mail domain>` by default. With yours, it asks where Eigen should listen.
4. **Host email on this server?** Yes: Eigen hosts the mailboxes, on ports 25, 465, 587 and 993. No: see [Using your existing mail server](#using-your-existing-mail-server).
5. **Which mail relay should Eigen send through?** Optional. Leave it empty and Eigen's own mail server delivers directly. To use one, answer `host:port` and setup asks for its user name and password. See [Do I need a mail relay?](#do-i-need-a-mail-relay).

Before the first question, setup downloads the release. After the last, it writes your answers to `.env.production` (only its owner can read it), lists the DNS records to add, and starts Eigen. Run `./eigen setup` again whenever you want to change an answer. It keeps the others, and every key it does not know. `./eigen setup --help` lists the flags for a run without questions.

Five containers start:

- **caddy**: the web server, with automatic HTTPS
- **eigen-api**: the backend
- **unbound**: a DNS resolver. Postfix needs a real one, not Docker's proxy
- **postfix**: incoming mail, and outgoing mail
- **dovecot**: IMAP

### 5. Finish in your browser

Setup ends with a link that works once, `https://eigen.example.com/admin/#setup=…`. Open it. It asks for the name of your organization, the sender of Eigen's own mail (codes, invitations and notifications; the organization name and `noreply@<mail domain>` unless you change them), where to keep files, and your admin account. Then **Go to Login** takes you to the sign-in page. You can change the sender later in Admin, under **Settings → Mail**. Lost the link? Run `./eigen setup` again for a fresh one.

Check on Eigen at any time with `./eigen status`.

### 6. Add the mail DNS records

When Postfix starts for the first time, it makes a DKIM key. You find it in `data/dkim/eigen.txt`, and in the postfix log of that first start (`./eigen logs postfix`, Ctrl-C to stop).

Add these records:

| Type | Name | Value |
|------|------|-------|
| MX | `eigen.example.com` | `10 eigen.example.com` |
| TXT | `eigen.example.com` | `"v=spf1 mx include:your-relay.com ~all"` |
| TXT | `eigen._domainkey.eigen.example.com` | *(the DKIM key)* |
| TXT | `_dmarc.eigen.example.com` | `"v=DMARC1; p=quarantine; rua=mailto:postmaster@eigen.example.com"` |
| SRV | `_imaps._tcp.eigen.example.com` | `0 1 993 eigen.example.com` |
| SRV | `_submission._tcp.eigen.example.com` | `0 1 587 eigen.example.com` |
| SRV | `_caldavs._tcp.eigen.example.com` | `0 1 443 eigen.example.com` |
| SRV | `_carddavs._tcp.eigen.example.com` | `0 1 443 eigen.example.com` |
| TXT | `_caldavs._tcp.eigen.example.com` | `"path=/dav/"` |
| TXT | `_carddavs._tcp.eigen.example.com` | `"path=/dav/"` |

Without a relay, drop the `include:your-relay.com` part of the SPF record.

Also set the **reverse DNS (PTR) record** in the panel of your hosting provider. It should resolve to your domain.

> Registrar forms often add your domain to the Name field by themselves. Enter `_imaps._tcp`, not `_imaps._tcp.eigen.example.com`, or the record lands one level too deep. Forms that split an SRV name into fields want service `_imaps`, protocol `tcp`, name `@`.

What these do:

- **MX** tells the internet which server receives your mail
- **SPF** says which servers may send mail for your domain
- **DKIM** signs your outgoing mail, so receivers can check it is yours
- **DMARC** tells receivers what to do with mail that fails those checks
- **Reverse DNS** maps your IP back to your domain. Many mail servers check it
- **SRV** lets mail, calendar and contacts apps find your server from just an email address. The two TXT records tell CalDAV and CardDAV clients the path (RFC 6764)

### 7. Connect a mail or calendar client (optional)

**IMAP / SMTP:**

| Setting | Value |
|---------|-------|
| Server | `eigen.example.com` |
| IMAP port | `993` (SSL/TLS) |
| SMTP port | `587` (STARTTLS) |
| Username | `you@eigen.example.com` |
| Password | your Eigen password |

**CalDAV / CardDAV** (Apple Calendar and Contacts, DAVx5, Thunderbird):

| Setting | Value |
|---------|-------|
| Server | `https://eigen.example.com/dav/` |
| Username | `you@eigen.example.com` |
| Password | your Eigen password |

Some clients find the server from your email address alone, through the SRV records of step 6 (DAVx5's login with email, for example). Support differs per client, so the server address above is the reliable way.

Thunderbird's calendar picker wants the full URL: `https://eigen.example.com/dav/calendars/{userId}/`. You find it on the Space → Integrations page, next to the one for your address book.

The web apps and your mail and calendar clients work on the same data. A change in one shows up in the other.

You are done.

---

## Operations

Everything goes through `./eigen` in the install folder. `./eigen help` lists the commands, `./eigen <command> --help` tells more about one.

```bash
./eigen status                   # version, pending update, services, disk, snapshots, certificate, mail queue
./eigen logs [service]           # follow the logs of every service, or of one
./eigen restart                  # start Eigen, and any part of it that stopped
./eigen stop                     # stop Eigen; ./eigen restart starts it again
./eigen reset-password <email>   # set a new password for an account
```

`status` names the install folder, the newest snapshot, and how many snapshots `snapshots/` holds and their size. An update that stopped halfway shows as `files of <new version> (<commit>), running <old version> (<commit>)`; `./eigen update` finishes it. On the main channel, a newer build shows as `a new build of main is out (<commit>)`.

`./eigen` runs one command that changes Eigen at a time. A second one, like a nightly backup in the middle of an update, stops with "Another ./eigen command is running."

`reset-password` asks for the new password (or makes one up with `--generate` and prints it once), signs the account out everywhere, and revokes its app passwords for mail, calendar and file apps. Eigen must be running. An admin can do the same on the admin Users page, for anyone but the owner. Only the owner resets the owner's password there.

### Updating

```bash
./eigen update
```

It gets the newest release, or the one you name (`./eigen update 0.3.1`). When the release notes list breaking changes, it shows them and asks whether to go on. Without a terminal, like from cron, it refuses until you run `./eigen update --accept-breaking`.

The download happens while Eigen runs. Then Eigen stops, saves a snapshot in `snapshots/`, switches to the new version and starts again. That snapshot is a light one: the databases, the settings and `.env.production`, without the files and the mail. When a release since yours marks a change as (breaking) in its CHANGELOG, or when you run `./eigen update --full`, it is a full one, files and mail included. Eigen is down for as long as that snapshot takes. The update checks first that it fits on the disk. It keeps the snapshots of the last two updates of each kind. A light one is named `eigen-pre-update-light-<UTC time>.tar.gz`. Open browser tabs reconnect by themselves. `./eigen update --check` only tells whether there is an update, and what it brings.

`./eigen rollback` goes back to the version before the last update, with the data as it was then. It puts back the snapshot the update saved, with the images that snapshot names, and starts Eigen. The current data is kept aside, not deleted. After a light snapshot it puts back only the databases, the settings and `.env.production`, so files and mail added since the update stay. It goes back one update, not further.

**Following the newest code instead of releases.** `./eigen update main` puts an install on the main channel. Every push to `main` builds new images. `./eigen update` then installs the newest build, and `./eigen status` names it, like `0.3.0 (abc1234) on main`. While a build is still being published, `./eigen update` says so. Run it again a few minutes later. Release notes and the (breaking) question only apply when the version number changes, so on the channel a breaking change can arrive without warning. The channel is for people who develop Eigen. `./eigen update <version>` takes you back to releases.

### Backups

```bash
./eigen backup
```

Saves all data (mail, files, contacts, calendars, settings, the server databases) and `.env.production` as one full snapshot, `snapshots/eigen-<UTC time>.tar.gz`. It checks that the snapshot fits on the disk, stops every service, archives the quiet `data/` with its owners and modes, and starts Eigen again. A short downtime, for a snapshot that is consistent. Then it deletes all but the newest three snapshots of that kind, so light ones never push out the last full one. `--keep <n>` keeps another number. The snapshots of updates do not count.

`./eigen backup --light` saves a light snapshot, `snapshots/eigen-light-<UTC time>.tar.gz`: the databases, the settings and `.env.production`, without the files and the mail.

Only the owner of the install folder can read a snapshot. Not in any snapshot: `caddy-data/` (Caddy gets its certificates again by itself), the Postfix queue of mail still waiting to go out, `backups/` with the per-home archives, `docker-compose.override.yml`, and the files of drives stored in an S3 bucket. Copy snapshots off the server, and run the backup every night:

```bash
crontab -e
# 0 3 * * * /opt/eigen/eigen backup
```

When a drive stores its files in an S3 bucket, a snapshot holds the list of those files but not the files. A restore or a rollback brings the list back and leaves the bucket as it is now, so a file changed since shows its new content. Turn on versioning and a cleanup rule for old versions on that bucket (the Bucket safety panel in the admin settings does both), and use a per-home backup when you need a copy with the files in it.

Put a snapshot back with `./eigen restore`. It unpacks and checks the snapshot while Eigen runs, and asks. Then it stops Eigen, moves the current `data/` and `.env.production` aside to `data.pre-restore-<UTC time>` and `.env.production.pre-restore-<UTC time>` (never deleted), puts the snapshot in their place and starts Eigen again. A light snapshot puts back only the databases, the settings and `.env.production`, moves those aside into `data.pre-restore-<UTC time>`, and leaves files and mail as they are.

A snapshot records the images it ran on. A snapshot of another build brings that build back, with its launcher and Compose files, the way a rollback does. The images come first: if they cannot be downloaded, Eigen runs on as it was. Restore refuses a snapshot of a newer Eigen: update first, then restore. It also refuses a snapshot of a local build on a release install, and the other way around. `data/` must be a plain folder inside the install folder, not a link or a mount of another disk.

```bash
./eigen restore eigen-<UTC time>.tar.gz
./eigen restore eigen-<UTC time>.tar.gz --yes   # without the question, for scripts
```

**Per-home backups** are the other half, and they need no downtime. An admin backs up, verifies, downloads and restores one user or one team from the Backup section of the admin Users and Teams pages. Those archives land in `./backups/` (`EIGEN_BACKUPS_DIR=/app/backups` inside the container, bind-mounted from the host), so keep an eye on its size. An archive holds every file, every mail and the mount credentials. Treat one like `.env.production`. The full guide: [docs/BACKUP.md](../docs/BACKUP.md).

`./eigen backup` is the whole-server backup. The per-home archives do not cover `users3.db`, `eigen.db`, `waitlist.db`, the server config or `.env.production`.

### Settings setup does not ask for

`.env.example` lists them under ADVANCED: the Docker subnet, the Compose project name, the mail queue alert, demo mode ([DEMO_MODE.md](../docs/DEMO_MODE.md)). Add a key to `.env.production`, then run `./eigen setup` again.

Extra Compose settings go in `docker-compose.override.yml` in the install folder. That is the one place for them: `./eigen` adds it to every Compose command, and an update leaves it alone. An override that uses Compose's `!override` tag needs Compose 2.24.4 or newer. For example, your own Caddyfile:

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

### Mail hardening

Out of the box, a user can only send mail as their own address, and failed logins are limited per account and per IP address. That stops most password guessing.

To block the guessing at the firewall as well, install fail2ban with the two jails Eigen ships, one for Postfix and one for Dovecot. Each bans an IP after five failed logins in ten minutes:

```bash
apt-get install fail2ban
cp /opt/eigen/docker/fail2ban/filter.d/*.conf /etc/fail2ban/filter.d/
cp /opt/eigen/docker/fail2ban/jail.d/eigen-mail-sasl.conf /etc/fail2ban/jail.d/
systemctl enable --now fail2ban
systemctl restart fail2ban
```

`fail2ban-client status eigen-postfix-sasl` shows what it caught. `./eigen` reloads fail2ban after an update, so the jails keep watching the new containers. More in [docker/fail2ban/README.md](fail2ban/README.md).

### Troubleshooting

**Status, logs, restart:**
```bash
./eigen status              # every service, its health, disk, certificate
./eigen logs                # all
./eigen logs eigen-api      # one service
./eigen restart
```

When a step of `./eigen` fails, it shows the last lines of its output. The full output is in `.eigen/last-step.log`.

**HTTPS not working.** Caddy gets the certificate by itself. When it does not, it is usually one of these:
- DNS has not spread yet
- Port 80 or 443 is blocked by a firewall
- Another program has port 80 or 443

**Email not arriving:**
- `./eigen logs postfix`
- `dig eigen.example.com MX`
- `telnet eigen.example.com 25` from another machine

**Docker network subnet conflict.** `./eigen setup` picks a subnet no other Docker network uses. If a network you add later overlaps with it, Eigen fails to start with `pool overlaps with other one on this address space`. Set both values in `.env.production`, then run `./eigen setup` again:

```
EIGEN_SUBNET=172.30.0.0/24
EIGEN_UNBOUND_IP=172.30.0.254
```

The two belong together: unbound's IP must lie inside the subnet. Postfix uses it as its DNS resolver.

---

## Alternative deployments

Pick one of these when your setup differs from the Quick Start. They combine.

### Behind your existing webserver

**Pick this when** your server already runs nginx, Caddy or Apache for other sites.

In step 4, when `./eigen setup` asks "How do people reach Eigen over HTTPS?", pick **My web server forwards to Eigen**, and give the address Eigen should listen on for it (`127.0.0.1:8080` by default). Setup then runs the bundled `eigen-static` container there instead of Caddy (`COMPOSE_PROFILES=static,…`) and writes a snippet for each web server next to `.env.production`:

- `eigen.nginx.conf`: link it into `/etc/nginx/sites-enabled/`, reload nginx
- `eigen.Caddyfile`: import it in your `Caddyfile`, reload Caddy
- `eigen.apache.conf`: copy it to `sites-available/eigen.conf`, `a2ensite eigen`

The nginx and Apache snippets expect a certbot certificate for your web address.

Each snippet covers TLS, the WebSocket upgrade and the SSE buffering settings that collaborative editing needs, and sets `X-Real-IP` to the real visitor. They proxy to the `eigen-static` container on the address you gave. That container sets the basic security headers itself (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`), as the bundled Caddy does. The Content-Security-Policy and the referrer policy ride inside each app's HTML, so every deployment gets them without proxy config.

The `eigen-static` container only ever hears from your host proxy, over the Docker bridge or loopback, so it trusts peers in the private ranges and passes their `X-Real-IP` on to the API. That is what keeps rate limiting, login lockout and OTP throttling tied to the actual visitor, instead of putting every user in one bucket. So the proxy must set `X-Real-IP` to the visitor's address, which the generated snippets do. `X-Forwarded-For` alone is not trusted: a client can prepend its own value and pick its rate-limit key.

**Apache notes:** the header of the snippet lists the modules to enable (`a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers`) and a one-liner to switch from `mpm_prefork` to `mpm_event`. Prefork uses one process per long-lived SSE or WebSocket connection and runs out of slots fast.

#### Behind a dockerized webserver (nginx proxy manager, etc.)

When the web server itself runs in Docker, `127.0.0.1` inside that container is its own loopback, not the host. The generated snippets' `proxy_pass http://127.0.0.1:8080` will not reach `eigen-static`. Two ways to fix it:

- **Share the eigen Docker network** (preferred). Attach the web server container to Eigen's network, `<project>_eigen` (`eigen_eigen` for an install in `/opt/eigen`), and proxy to `eigen-static:8080` directly. In the web server's compose file:
  ```yaml
  services:
    nginx-proxy-manager:
      networks: [default, eigen]
  networks:
    eigen:
      external: true
      name: eigen_eigen
  ```
  Nothing extra is exposed. The traffic stays on the Docker bridge.
- **Listen on the Docker host's address.** Answer `172.17.0.1:8080`, the host's address on Docker's default bridge, when setup asks where Eigen should listen, as its hint says. The generated snippets then proxy to that address. A container can reach it, the LAN cannot.

**Nginx Proxy Manager:** in the edit dialog of the proxy host, switch on **Websockets Support** (off by default). Without it, collaborative editing in docs, sheets, slides and stickies fails to connect, without saying so.

#### TLS certs without bundled Caddy

The bundled certificate manager lives in the Caddy container. Without Caddy, postfix and dovecot still need a certificate for IMAPS and SMTPS. They read `data/certs/cert.pem` and `data/certs/key.pem`, and make a self-signed one when there is none. Mail clients connect to your web address (`DOMAIN`), so the certificate is the one for that name. Copy the Let's Encrypt certificate of your host there with a certbot deploy hook, which runs after each renewal:

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

Replace `eigen.example.com` with your web address. The last line runs the hook once, to put the current certificate in place. The signal makes both reload it. Dovecot also notices a changed certificate by itself within ten minutes.

### Behind Cloudflare Tunnel or Tailscale Funnel

**Pick this when** you do not want public ports on your host.

In step 4, pick **My web server forwards to Eigen** and keep `127.0.0.1:8080`. Eigen runs the bundled static container there, and the tunnel is your edge. WebSocket and SSE pass through as they are. Neither tunnel sets `X-Real-IP`, so all visitors share one rate-limit and login-lockout bucket. Put nginx, Caddy or Apache between the tunnel and the container if per-visitor limits matter to you.

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

### Do I need a mail relay?

Usually not. Eigen comes with its own mail server, and Postfix delivers your mail straight to the receiving server, like any mail server. eigen.is runs that way. A relay is a mail server that takes your mail over a login and delivers it for you. You want one in two cases:

- **Your provider blocks outgoing port 25.** Hetzner and DigitalOcean do that on new accounts. Ask them to open it, or send through a relay.
- **You answered No to hosting mail.** Then there is no Postfix, and Eigen needs a relay for its own mail: sign-in codes, invitations and notifications. Without one, none of those go out.

Anything that speaks SMTP with a user name and password works: a mail service like Brevo, Postmark, Mailgun, SendGrid or Amazon SES (most have a free tier of a few hundred mails a day), the SMTP server of your current mail provider (Google Workspace, Gmail with an app password, Fastmail, your ISP), or a mail server you run yourself. Answer it as `host:port` at setup, like `smtp-relay.brevo.com:587`, and setup asks for the user name and password. `.env.production` keeps them as `SMTP_RELAY_HOST`, `SMTP_RELAY_PORT`, `SMTP_RELAY_USER` and `SMTP_RELAY_PASSWORD`. Port 465 is implicit TLS, any other port STARTTLS. With a user name, the connection must be encrypted, so the password never travels in the clear.

One thing to check: which addresses the relay lets you send from.

- **With hosted mail**, Postfix sends every user's mail through the relay from that user's own address. The relay must accept every address on your mail domain. A mail service does, once you have verified the domain. A personal Gmail account does not: Gmail rewrites the sender to the account itself, so mail from Jane would arrive as sent by you. Google Workspace has an SMTP relay service that sends for a whole domain.
- **Without hosted mail**, everything Eigen sends comes from one address, the sender address you pick at setup. Mail about a person carries that person's name, `Jane via Acme <noreply@example.com>`, and replies go to Jane. One mailbox is enough, a Gmail account included, as long as the sender address is one that account may send from.

Leave the relay empty at setup if you are not sure. Run `./eigen setup` again to add one later.

### Using your existing mail server

**Pick this when** you already run postfix and dovecot on the host, or want a mail provider to host the mailboxes and IMAP.

Answer **No** to "Host email on this server?" in step 4 (`--no-mail`). Postfix, Dovecot and Unbound do not start, and the server hosts no mailboxes. The Mail app, its entries in the app switcher and the command palette, the "Mail to…" actions and the IMAP settings card all disappear. Anyone who still opens `/mail` gets a plain "Mail is turned off on this server" page. Addresses stay on your mail domain, and people still sign in with them. Their mailboxes live wherever that domain's mail is hosted.

Eigen still sends mail of its own: two-factor codes by email, guest sign-in codes, invitations, share and access-request notifications, calendar invitations and replies. Without hosted mail it sends them through a relay, the next question setup asks. Without a relay, every one of those emails fails. Setup warns when you leave it empty. Which relays work, and how to answer: [Do I need a mail relay?](#do-i-need-a-mail-relay). Without hosted mail, Eigen also checks the relay's certificate.

Your own mail server on the same host works as a relay too: answer `host.docker.internal:25`. `host.docker.internal` is Docker's name for "the machine the container runs on". For this to work, your host postfix needs to:

- Bind to `0.0.0.0` (or the gateway of `EIGEN_SUBNET`, the Docker network in `.env.production`), not just `127.0.0.1`
- Permit relay from `EIGEN_SUBNET`

The relay must accept the system sender, the address Eigen's own mail comes from. You set it in the setup wizard, and later in Admin under **Settings → Mail**. Mail a person causes, like a share notification or a calendar invitation, comes from the system sender with their name, `Ada via Acme <noreply@example.com>`, and replies go to them. If your relay allows every address on your mail domain as a sender, turn on **Relay sends as users** in the same place. Mail a person causes then comes from their own address. **Send test mail** there sends one mail from you to you, the way a share notification goes out.

Tell your users to point their mail client at your existing mail server. Eigen shows no IMAP settings of its own.

### Mail at a different domain than the web URL

**Pick this when** Eigen runs at `eigen.example.com` but addresses are `you@example.com`.

Answer `eigen.example.com` to the first setup question and `example.com` to the second. In `.env.production` that is:

```
DOMAIN=eigen.example.com
MAIL_DOMAIN=example.com
```

The mail records (MX, SPF, DKIM, DMARC) live on `MAIL_DOMAIN`. The MX *target* is your web host:

```
example.com.                     MX   10 eigen.example.com.
example.com.                     TXT  "v=spf1 mx -all"
_dmarc.example.com.              TXT  "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com"
eigen._domainkey.example.com.    TXT  "<key from postfix logs after first boot>"
```

The SRV and TXT records for autodiscovery also live on `MAIL_DOMAIN`, because clients take the lookup domain from the email address. Their targets point at the web host:

```
_imaps._tcp.example.com.         SRV  0 1 993 eigen.example.com.
_submission._tcp.example.com.    SRV  0 1 587 eigen.example.com.
_caldavs._tcp.example.com.       SRV  0 1 443 eigen.example.com.
_carddavs._tcp.example.com.      SRV  0 1 443 eigen.example.com.
_caldavs._tcp.example.com.       TXT  "path=/dav/"
_carddavs._tcp.example.com.      TXT  "path=/dav/"
```

**Autoconfig:** mail clients look for auto-discovery at `https://autoconfig.example.com/...`, on the apex, not on Eigen's subdomain. Two options:

1. **Manual config.** Tell users to enter `eigen.example.com` as the IMAP and SMTP server when they add their account.
2. **Autoconfig record.** Point `autoconfig.example.com` at the same IP. `./eigen setup` lists that A record when `DOMAIN` and `MAIL_DOMAIN` differ.

### Compose profile reference

`COMPOSE_PROFILES` controls which bundled services start. `./eigen setup` writes it from your answers to the HTTPS and mail questions. To change it, run `./eigen setup` again with other answers:

| Setup | Profile |
|---|---|
| All-in-one (default) | `edge,mail` |
| Bundled mail, your webserver | `static,mail` |
| Bundled webserver, your mail server | `edge` |
| Neither: the host runs both | `static` |
