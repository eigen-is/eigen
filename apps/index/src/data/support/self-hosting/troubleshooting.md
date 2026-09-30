---
title: "Fix common server problems"
description: "What to do when ./eigen stops with an error, Eigen does not start, HTTPS does not work, or mail does not arrive or go out."
type: troubleshooting
category: Maintenance
tags: [self-hosting, troubleshooting, logs, https, mail, docker]
related: [self-hosting/commands-and-files, self-hosting/behind-your-web-server, self-hosting/mail-relay]
order: 130
updated: 2026-09-30
---

Start with `./eigen status`, which shows every service and its health, the disk, and the certificate. `./eigen logs` shows what the services say, and `./eigen logs <service>` shows one. When a step of `./eigen` fails, it prints the last lines of its output, and the full output is in `.eigen/last-step.log`.

The problems below are the common ones.

## Docker is not running, or this user cannot use it

`./eigen` checks Docker before it does anything. Start Docker, or run `./eigen` as root or as a user in the `docker` group. Use the same user as for the install.

When it says Docker Compose is too old, update the Docker Compose plugin to 2.20 or newer.

## Another ./eigen command is running

`./eigen` runs one command that changes Eigen at a time, so a nightly backup never stops Eigen in the middle of an update. Wait for the other command to end, then run yours again. If no other command runs, remove `.eigen/lock` in the install folder.

## The data folders are not writable

Eigen runs as user 1000 and must be able to write in `data/` and `backups/`. Setup hands them over when they are empty. When they already hold files that belong to someone else, give them to that user:

```bash
sudo chown 1000:1000 data backups
```

## Eigen does not start: pool overlaps

The message `pool overlaps with other one on this address space` means another Docker network uses the same addresses as Eigen's. Setup picks free ones, but a network added later, or a move to another server, can clash. Set two other values in `.env.production`, then run `./eigen setup` again:

```
EIGEN_SUBNET=172.30.0.0/24
EIGEN_UNBOUND_IP=172.30.0.254
```

The two belong together: the second address must lie inside the first range.

## HTTPS does not work

Eigen's own web server gets the certificate by itself. When it does not, it is usually one of these:

- The DNS record has not reached everyone yet. Check with `dig eigen.example.com A`.
- A firewall blocks port 80 or 443.
- Another program already uses port 80 or 443. Then either stop it, or let it forward to Eigen: see [Run Eigen behind your own web server](/support/self-hosting/behind-your-web-server).

`./eigen logs caddy` shows what the web server tried.

## Live editing does not connect

Behind your own web server, documents open but other people's changes do not appear, or editing says it cannot connect. The web server does not keep live connections open. Use the file setup wrote for it, or compare yours with it. In Nginx Proxy Manager, switch on **Websockets Support** for the proxy host.

## Everyone is locked out at once

Behind your own web server or a tunnel, one person's wrong passwords lock everyone out of signing in. The web server does not pass on the visitor's address, so Eigen sees all visitors as one. Set `X-Real-IP` to the visitor's address, as the files setup writes do.

## Mail does not arrive

When Eigen hosts your mail:

- `./eigen logs postfix` shows what the mail server does with each message.
- `dig eigen.example.com MX` shows whether the MX record points at your server.
- `telnet eigen.example.com 25`, from another machine, shows whether port 25 is open to the internet.

Mail you send that lands in spam usually misses a DNS record. Check the SPF, DKIM, DMARC, and reverse DNS records in [Host your mail on Eigen](/support/self-hosting/host-your-mail). When your provider blocks outgoing port 25, nothing goes out at all: send through a relay, as in [Choose a mail relay](/support/self-hosting/mail-relay).

## Eigen sends no email

Sign-in codes, invitations, or notifications do not arrive. Open [Admin](/admin), click **Settings**, and look at the **Mail** row under **Server**. "No mailboxes and no relay" means there is no relay: run `./eigen setup` again and name one. With a relay, click **Send test mail** under **Mail**. When it fails, Eigen shows the relay's answer, which usually names the problem: a wrong password, or a sender address the relay does not accept. See [Keep your existing mail](/support/self-hosting/keep-your-mail).

## Lost the setup link

Run `./eigen setup` again. It keeps your answers and prints a fresh link. Once the setup is finished, it prints where to sign in instead.
