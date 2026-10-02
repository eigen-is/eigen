---
title: "Install Eigen on a server"
description: "Install Docker, point your domain at the server, run the one-line install, answer the setup questions, and sign in for the first time."
type: how-to
category: Install
tags: [self-hosting, install, setup, docker, dns]
related: [self-hosting/requirements, admin/get-started, self-hosting/host-your-mail, self-hosting/keep-your-mail]
order: 30
updated: 2026-10-02
---

This takes you from an empty server to your first sign-in. The install itself is two lines. Check [what you need](/support/self-hosting/requirements) first. If your server already runs a web server for other sites, read [Run Eigen behind your own web server](/support/self-hosting/behind-your-web-server) before you start.

## 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
docker compose version   # 2.20 or newer
```

## 2. Point your domain at the server

Add one DNS record. Replace `eigen.example.com` with your domain and `1.2.3.4` with the IP address of your server:

| Type | Name | Value |
|---|---|---|
| A | `eigen.example.com` | `1.2.3.4` |

A new record can take a few minutes to reach everyone, sometimes half an hour. Check it with `dig eigen.example.com A`.

The setup lists every other record your answers need. With hosted mail, the mail records come after the first start: see [Host your mail on Eigen](/support/self-hosting/host-your-mail). A new install makes a new DKIM key to sign mail with, so a domain that still has the `eigen._domainkey` record of an earlier install needs it replaced, while [a restore](/support/self-hosting/move-to-another-server) keeps the old key.

## 3. Open the ports

Many hosting providers put a firewall in front of your server, like the cloud firewalls of Hetzner and DigitalOcean. Such a firewall blocks every port you don't open. In your provider's panel, open the ports your setup needs: [Network ports](/support/self-hosting/requirements#network-ports) lists them. Keep SSH open too.

## 4. Run the install

Eigen lives in one folder: the `eigen` command, the settings, and all your data. This guide uses `/opt/eigen`, but any folder will do.

Whoever runs the install owns it. Root is fine. So is a normal user in the `docker` group. Use the same user every time you run `./eigen`.

```bash
mkdir -p /opt/eigen && cd /opt/eigen
curl -fsSL https://eigen.is/install | sh
```

The script downloads the `eigen` command and runs `./eigen setup`. Setup downloads the newest release, asks its questions, starts Eigen, and prints a link. Your answers go into `.env.production` in the install folder. That file also names the release you run, so nothing changes until you run `./eigen update`.

Want to type `eigen` from anywhere? Link it: `ln -s /opt/eigen/eigen /usr/local/bin/eigen`.

### Without piping a script into sh

The same install, by hand, from the release image:

```bash
mkdir -p /opt/eigen && cd /opt/eigen
docker run --rm --pull always -v "$PWD:/out" ghcr.io/eigen-is/eigen/api:latest bootstrap
./eigen setup
```

Name a version instead of `latest`, like `api:0.3.0`, to install a specific release.

## 5. Answer the setup questions

Setup asks five questions and suggests an answer for each. Press Enter to keep the suggestion.

1. **Where will Eigen be hosted?** Your web address, like `eigen.example.com`.
2. **Which mail domain will you use?** Every account's email address and sign-in ends in it, like `jane@example.com`. It defaults to the web address. If your mail stays with your current provider (Proton Mail, Google Workspace, Microsoft 365, Fastmail…), answer the domain your addresses are on now: everyone then signs in to Eigen with the email address they already have. You cannot change it later, because every account is made on it.
3. **How do people reach Eigen over HTTPS?** Pick **Eigen handles it on ports 80 and 443**, and setup asks which email address Let's Encrypt may use. Or pick **My web server forwards to Eigen**, and setup asks where Eigen should listen for it.
4. **Host email on this server?** Yes means Eigen hosts the mailboxes. No means your mail stays where it is. Both are a full install.
5. **Which mail relay should Eigen send through?** If your mail stays with your current provider, you need a relay, or Eigen sends no email at all. If Eigen hosts your mail, leave it empty unless your provider blocks outgoing port 25. See [Choose a mail relay](/support/self-hosting/mail-relay).

Then setup saves your answers, lists the DNS records to add, and starts Eigen. Run `./eigen setup` again whenever you want to change an answer. It keeps the others. `./eigen setup --help` lists the flags for a run without questions.

## 6. Finish in your browser

Setup ends with a link that works once, like `https://eigen.example.com/admin/#setup=…`. Open it to name your organization, pick the sender of Eigen's own mail, choose where files are stored, and create your admin account. [Set up your Eigen server](/support/admin/get-started) walks through that form. Then **Go to Login** takes you to the sign-in page.

Lost the link? Run `./eigen setup` again for a fresh one.

`./eigen status` shows how Eigen is doing at any time.

## 7. Finish the mail

- If Eigen hosts your mail, add the mail DNS records in [Host your mail on Eigen](/support/self-hosting/host-your-mail).
- If your mail stays with your current provider, check the relay and the sender in [Keep your existing mail](/support/self-hosting/keep-your-mail).

Then set up a nightly backup: [Back up and restore the whole server](/support/self-hosting/back-up-and-restore).
