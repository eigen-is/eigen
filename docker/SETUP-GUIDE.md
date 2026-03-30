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

## Step 2: Set Up DNS

Before your server can receive email and get HTTPS certificates, your domain needs to point to it.

Go to your DNS provider and add these records (replace `eigen.example.com` with your domain and `1.2.3.4` with your server's IP):

| Type | Name | Value | Why |
|------|------|-------|-----|
| A | `eigen.example.com` | `1.2.3.4` | Points your domain to your server |
| MX | `eigen.example.com` | `10 eigen.example.com` | Tells the internet where to deliver email |

Wait for DNS propagation (usually 5-30 minutes). Verify:

```bash
dig eigen.example.com A     # Should show your server IP
dig eigen.example.com MX    # Should show your domain
```

You'll add DKIM, SPF, and DMARC records in Step 6 (after the server generates your DKIM key).

## Step 3: Clone and Configure

```bash
git clone <eigen-repo-url> /opt/eigen
cd /opt/eigen
```

Generate your configuration file:

```bash
./scripts/generate-env.sh eigen.example.com > .env.production
```

This creates `.env.production` with all URLs derived from your domain. Now edit it to add your SMTP relay credentials:

```bash
nano .env.production
```

Find and fill in:
```
SMTP_RELAY_HOST=smtp-relay.brevo.com
SMTP_RELAY_USER=your-api-key@brevo.com
SMTP_RELAY_PASSWORD=your-smtp-key
```

If you don't have an SMTP relay yet, leave these empty — you can add them later.

## Step 4: Build the Frontend

The frontend apps (mail, drive, docs, etc.) need to be compiled with your domain baked in:

```bash
# Install Bun (JavaScript runtime)
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Install dependencies and build
bun install
set -a && source .env.production && set +a
bun run build:prod
```

This compiles 13 frontend apps into the `dist/` directory. Takes 1-2 minutes.

> **Note:** You only need Bun for building the frontend. Docker handles everything at runtime.

## Step 5: Start Eigen

```bash
docker compose --env-file .env.production up -d
```

This starts four containers:
- **caddy** — Reverse proxy with automatic HTTPS certificates
- **eigen-api** — The Eigen backend (handles all your data)
- **postfix** — Email server (receives incoming mail, sends via relay)
- **dovecot** — IMAP server (lets mail clients read your inbox)

Check that everything is running:

```bash
docker compose --env-file .env.production ps
```

All containers should show `Up` and `healthy`.

### First-time setup

Open `https://eigen.example.com/setup` in your browser. The setup wizard will ask you to:
1. Choose a name for your organization
2. Create your admin account (email + password)
3. Configure storage settings

After setup, you're redirected to the login page. Sign in and you're ready to go!

## Step 6: Configure Email DNS Records

After Postfix starts for the first time, it generates a DKIM key. Check the logs:

```bash
docker compose --env-file .env.production logs postfix | grep "DNS TXT"
```

Now add these DNS records:

| Type | Name | Value |
|------|------|-------|
| TXT | `eigen.example.com` | `"v=spf1 a mx include:your-relay.com ~all"` |
| TXT | `eigen._domainkey.eigen.example.com` | *(the DKIM key from the logs)* |
| TXT | `_dmarc.eigen.example.com` | `"v=DMARC1; p=quarantine; rua=mailto:postmaster@eigen.example.com"` |

Also set the **rDNS (PTR) record** in your VPS provider's control panel — it should resolve to your domain.

### What these do:
- **SPF** — tells receiving servers which IPs are allowed to send email for your domain
- **DKIM** — digitally signs your outgoing emails to prove they're from you
- **DMARC** — tells receiving servers what to do with unsigned/suspicious emails
- **rDNS** — maps your IP back to your domain (many email servers check this)

## Step 7: Connect Your Email Client (Optional)

To use Thunderbird, Apple Mail, or any IMAP client alongside the web interface:

| Setting | Value |
|---------|-------|
| Server | `eigen.example.com` |
| Port | `993` |
| Security | SSL/TLS |
| Username | Your email (e.g., `you@eigen.example.com`) |
| Password | Your Eigen password |

Your IMAP client and the Eigen web interface share the same mailbox — changes sync both ways.

## Updating Eigen

When there's a new version:

```bash
cd /opt/eigen
./scripts/update.sh
```

This pulls the latest code, rebuilds the frontend, and restarts the containers. Takes about 2 minutes. Active connections (SSE, WebSocket) will briefly reconnect.

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
