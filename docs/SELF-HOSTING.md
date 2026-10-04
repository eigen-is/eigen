# Self-hosting Eigen

How to run Eigen on your own server. The step-by-step guide lives in the help center, in the [Self-hosting](https://eigen.is/support/self-hosting/get-started) section. This page is the quick start and the technical reference that goes with the code.

An install is one folder, `/opt/eigen` in the quick start, that holds the `eigen` launcher, `.env.production`, `data/` and `backups/`. Eigen runs from it as Docker Compose services, on release images pinned by digest. One container, `eigen-api`, runs the API on port 8000 over the data in `data/`. In front of it a web server serves the apps' files and passes the rest on: the bundled Caddy, which also gets the HTTPS certificate, or `eigen-static` behind a web server of your own. Hosted mail adds Postfix, Dovecot and the Unbound resolver ([MAIL.md](MAIL.md)). The operator drives all of it through `./eigen` rather than Docker Compose: the launcher writes `.env.production`, pins the images and adds the override file to every Compose command ([The commands](#the-commands)).

## Requirements

- A Linux server, amd64 or arm64, with 2 GB of RAM, 4 GB recommended
- 10 GB of disk for the images, plus your data and its backups
- Docker, with the Docker Compose plugin 2.20 or newer. Nothing else: no Bun, no Node
- A domain you control
- A mail relay when your mail stays with your current provider. When Eigen hosts your mail, only when your provider blocks outgoing port 25

Memory, disk and ports per setup, with the measurements behind them: [What you need to run Eigen](https://eigen.is/support/self-hosting/requirements). Two numbers the article leaves out: the api image is 2.6 GB of the images, and Docker's containerd image store, which keeps the downloaded layers too, takes 3.8 GB, 4.3 GB with mail. An update keeps the previous release's images for `./eigen rollback`, so there can be two sets.

## Quick start

Point an A record for your domain at the server, then:

```bash
mkdir -p /opt/eigen && cd /opt/eigen
curl -fsSL https://eigen.is/install | sh
```

The script downloads the `eigen` command and runs `./eigen setup`. Setup asks five questions, starts Eigen and prints a one-time link that finishes the setup in your browser. The full walk-through: [Install Eigen on a server](https://eigen.is/support/self-hosting/install).

Developing Eigen? `./eigen setup` in a clone builds the images instead: [CONTRIBUTING.md § Eigen in Docker](CONTRIBUTING.md#eigen-in-docker).

## The guide

| Step | Article |
|---|---|
| nginx, Apache, Caddy, Traefik, a web server in Docker, tunnels, mail certificates without Caddy | [Run Eigen behind your own web server](https://eigen.is/support/self-hosting/behind-your-web-server) |
| Hosted mail: DNS records, a mail domain apart from the web address, fail2ban | [Host your mail on Eigen](https://eigen.is/support/self-hosting/host-your-mail) |
| Mail off: the relay, the sender, the test mail | [Keep your existing mail](https://eigen.is/support/self-hosting/keep-your-mail) |
| Which relay, and which senders it must accept | [Choose a mail relay](https://eigen.is/support/self-hosting/mail-relay) |
| `./eigen update`, breaking releases, the pre-1.0 data policy, rollback, the `main` channel | [Update Eigen](https://eigen.is/support/self-hosting/update) |
| The nightly backup, the backup bucket and its keys, `./eigen backup`, what a backup leaves out, `./eigen restore` | [Back up and restore the whole server](https://eigen.is/support/self-hosting/back-up-and-restore) |
| A new machine, restored from a backup with no setup first | [Move Eigen to another server](https://eigen.is/support/self-hosting/move-to-another-server) |
| Every command, the services, the logs, the install folder | [Commands, logs, and files](https://eigen.is/support/self-hosting/commands-and-files) |
| `./eigen reset-password` | [Reset a password from the server](https://eigen.is/support/self-hosting/reset-a-password) |
| Errors, HTTPS, mail that does not arrive | [Fix common server problems](https://eigen.is/support/self-hosting/troubleshooting) |
| Known gaps | [What Eigen does not do yet](https://eigen.is/support/self-hosting/known-gaps) |

The help center at eigen.is follows the `main` channel, so it can describe a build newer than the newest release. Every install serves its own copy at `/support`, which matches the version it runs.

## The commands

`./eigen` runs in the install folder. `./eigen <command> --help` tells more about each, and `NO_COLOR=1` turns its colors off.

| Command | What it does |
|---|---|
| `setup` | Asks the setup questions, writes `.env.production`, starts Eigen and prints the setup link. Run it again to change an answer |
| `status` | The version, a waiting update, the services, disk space, the newest backup, the certificate and the mail queue |
| `update [version]` | Backs up the running server, then switches to the new release. `--check` only tells whether there is an update and what it brings. `--accept-breaking` goes on past breaking changes without asking, as a run without a terminal must. `--full` makes the backup Full, `--no-backup` makes none |
| `rollback` | Restores the backup the last update made, with the version it ran. `--yes` does not ask |
| `backup` | Backs up the whole server into `backups/` while Eigen runs. `--light`, `--full` (the default), `--s3`, `--wait`. Its exit codes: [BACKUP.md § The whole-server backup runs inside the API](BACKUP.md#the-whole-server-backup-runs-inside-the-api) |
| `restore <archive>` | Puts a whole-server backup back, from `backups/` or a path, on this machine or a new one. `--yes` does not ask, `--s3-from-archive` uploads an archive's S3 files under fresh keys instead of keeping each bucket as it is |
| `restart` | Starts Eigen, and any part of it that stopped |
| `stop` | Stops Eigen |
| `logs [service]` | Follows the logs of every service, or of one |
| `reset-password` | Sets a new password for an account and signs it out everywhere |

One command that changes Eigen runs at a time, under `.eigen/lock`. `backup` takes no lock: it changes nothing and runs inside the API. What the backup and restore do, and why, is in [BACKUP.md](BACKUP.md).

The backup `update` makes is Light, the databases and settings without files and mail, unless a release since the running one lists a breaking change or `--full` asks for Full. Its name starts with `server-pre-update-`. Eigen keeps the two newest good ones and the one `rollback` needs ([BACKUP.md § Retention keeps good scheduled archives and every manual one](BACKUP.md#retention-keeps-good-scheduled-archives-and-every-manual-one)), and they never go to the backup bucket: they exist for `rollback` on this machine. A rollback from a Light backup puts the databases back over the files of today ([BACKUP.md § A Full restore swaps data/ whole, a Light one merges](BACKUP.md#a-full-restore-swaps-data-whole-a-light-one-merges)).

## backups/ is outside data/

Whole-server and per-home backups go to `backups/` in the install folder, mounted into the API as `/app/backups` (`EIGEN_BACKUPS_DIR`). It sits beside `data/`, so a wipe of the data folder cannot take the backups with it. Setup creates both folders and gives an empty one to uid 1000, the user Eigen runs as. A folder Docker creates for a bind mount is root's, so a stack started by hand needs `mkdir -p data backups && chown -R 1000:1000 data backups` first. `backups/` is not in any backup: copy archives off the server, or turn on the backup bucket in Settings.

## Compose profiles

`COMPOSE_PROFILES` picks the bundled services. `./eigen setup` writes it from the answers to "How do people reach Eigen over HTTPS?" and "Host email on this server?". Run setup again to change it.

| Setup | Profiles | Services | Published ports |
|---|---|---|---|
| All-in-one (default) | `edge,mail` | caddy, eigen-api, postfix, dovecot, unbound | 80, 443, 25, 465, 587, 993 |
| Bundled mail, your web server | `static,mail` | eigen-static, eigen-api, postfix, dovecot, unbound | `EIGEN_STATIC_HOST:EIGEN_STATIC_PORT`, 25, 465, 587, 993 |
| Bundled web server, mail kept elsewhere | `edge` | caddy, eigen-api | 80, 443 |
| Your web server, mail kept elsewhere | `static` | eigen-static, eigen-api | `EIGEN_STATIC_HOST:EIGEN_STATIC_PORT` |

`eigen-api` publishes no port. Every other service reaches it on the Docker network as `eigen-api:8000`.

## `.env.production`

Setup writes it, readable by its owner and by group 1000 ([The API reads three secrets as group 1000](#the-api-reads-three-secrets-as-group-1000)). A rerun of setup keeps every key it does not know. [`.env.example`](../.env.example) documents each key. In short:

| Keys | Written by | What they are |
|---|---|---|
| `DOMAIN`, `MAIL_DOMAIN`, `ACME_EMAIL` | setup | The web address, the domain of every address (fixed after the first setup), the Let's Encrypt contact |
| `COMPOSE_PROFILES`, `MAIL_ENABLED` | setup | The deployment shape ([Compose profiles](#compose-profiles)) |
| `EIGEN_STATIC_HOST`, `EIGEN_STATIC_PORT` | setup | Where `eigen-static` listens for your web server (`127.0.0.1:8080` by default) |
| `SMTP_RELAY_HOST`, `SMTP_RELAY_PORT`, `SMTP_RELAY_USER`, `SMTP_RELAY_PASSWORD` | setup | The relay. Postfix sends through it with hosted mail, the API without. Details in [SERVER-SETTINGS.md § Hosted mail and the relay are environment, not settings](SERVER-SETTINGS.md#hosted-mail-and-the-relay-are-environment-not-settings) |
| `EIGEN_SUBNET`, `EIGEN_UNBOUND_IP` | setup | Eigen's Docker network and the resolver's address in it, on a /24 no other network uses |
| `API_URL`, `VITE_*` | setup | Derived from `DOMAIN` |
| `EIGEN_REGISTRY`, `EIGEN_VERSION`, `EIGEN_*_IMAGE` | setup and update | The release or channel the install follows, and every image pinned by digest |
| `COMPOSE_PROJECT_NAME`, `QUEUE_CHECK_INTERVAL`, `QUEUE_ALERT_THRESHOLD`, `QUEUE_ALERT_COOLDOWN`, `EIGEN_DEMO`, `EIGEN_DEMO_ADMIN_PASSWORD` | you | Advanced: the Compose project, the mail queue alert, [demo mode](DEMO_MODE.md). Add the key, then run `./eigen setup` again |

## The API reads three secrets as group 1000

The whole-server backup runs in the API, as uid 1000, and archives three files the API does not write. Each is readable by group 1000:

| File | Given group 1000 by | When |
|---|---|---|
| `.env.production` | The launcher (`share_env` in `eigen`), mode 0640 | Every `./eigen` command that starts Eigen |
| `data/dkim/` | The Postfix entrypoint, the key mode 0640 | Every Postfix start |
| `data/certs/key.pem` | The Dovecot entrypoint, mode 0640 | Every Dovecot start and every new certificate |

The API mounts `.env.production` read-only at `EIGEN_ENV_FILE`, as the one file, so it reads the inode it started with. An editor or `sed -i` writes a new file, and the API keeps the old one until its container starts again, which an up does only when a value changed. So `restart` compares the file eigen-api reads with the one in the install folder by their `cksum`, and stops eigen-api first when they differ (`env_mounted` in `eigen`). After a hand edit run `./eigen restart`, which also gives the new file group 1000, where `docker compose up` does not. Until then a backup takes the old file on Linux and fails on Docker Desktop, where the read fails ENOENT, and from 0.3.2 on `./eigen backup` and `./eigen update` refuse before their backup by the same comparison. An update from 0.3.1 runs 0.3.1's launcher, which does not compare. What the API cannot read, the backup leaves out and says so ([BACKUP.md § A server archive is a plain tar of home archives, manifest last](BACKUP.md#a-server-archive-is-a-plain-tar-of-home-archives-manifest-last)).

## `docker-compose.override.yml`

Extra Compose settings go in `docker-compose.override.yml` in the install folder. That is the one place for them: `./eigen` adds it to every Compose command, and an update leaves it alone. An override that uses Compose's `!override` tag needs Compose 2.24.4 or newer. The Traefik labels in the help center are one example. Your own Caddyfile is another:

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

## Proxy snippets

With the `static` profile, setup fills in the templates in `docker/proxy/` (`{{DOMAIN}}` and `{{TARGET}}`, the listen address) and writes `eigen.nginx.conf`, `eigen.apache.conf` and `eigen.Caddyfile` next to `.env.production`. `docker/test-host-proxies.sh` runs all three in front of a real install.

Each one forwards everything to `eigen-static`, upgrades WebSockets, turns off buffering for SSE, and sets `X-Real-IP` to the visitor. `eigen-static` (`docker/static/Caddyfile`) trusts `X-Real-IP` from private ranges only and ignores `X-Forwarded-For`, which a client can prepend to, so rate limits, login lockout and OTP throttling key on the real visitor. It sets `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy` itself, as the bundled Caddy does. The Content-Security-Policy rides in each app's HTML.

## Firewall

```bash
ufw allow 22/tcp     # SSH
ufw allow 80/tcp     # HTTP (redirects to HTTPS)
ufw allow 443/tcp    # HTTPS
ufw allow 25/tcp     # SMTP (incoming)
ufw allow 465/tcp    # SMTPS
ufw allow 587/tcp    # SMTP submission
ufw allow 993/tcp    # IMAP
```

Ports 25, 465, 587 and 993 are for hosted mail. If your mail stays with your current provider, leave them closed. Behind your own web server, 80 and 443 are that server's.
