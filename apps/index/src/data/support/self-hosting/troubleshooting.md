---
title: "Fix common server problems"
description: "What to do when ./eigen stops with an error, a backup or restore refuses, Eigen does not start, HTTPS does not work, or mail does not arrive or go out."
type: troubleshooting
category: Maintenance
tags: [self-hosting, troubleshooting, logs, https, mail, docker]
related: [self-hosting/commands-and-files, self-hosting/behind-your-web-server, self-hosting/mail-relay]
order: 130
updated: 2026-10-01
---

Start with `./eigen status`, which shows every service and its health, the disk, and the certificate. `./eigen logs` shows what the services say, and `./eigen logs <service>` shows one. When a step of `./eigen` fails, it prints the last lines of its output, and the full output is in `.eigen/last-step.log`.

## Docker is not running, or this user cannot use it

`./eigen` checks Docker before it does anything. Start Docker, or run `./eigen` as root or as a user in the `docker` group. Use the same user as for the install.

When it says Docker Compose is too old, update the Docker Compose plugin to 2.20 or newer.

## Another ./eigen command is running

`./eigen` runs one command that changes Eigen at a time, so two of them never stop and start Eigen at the same time. Wait for the other command to end, then run yours again. The lock of a command that has ended is taken over by the next one, so you rarely need to do more. If it still stops and no other command runs, remove `.eigen/lock` in the install folder. When it names another user, remove it as that user or as root.

## The data folders are not writable

Eigen runs as user 1000 and must be able to write in `data/` and `backups/`, and in everything in them. Setup hands the folders over when they are empty, and leaves the owners of folders that already hold files alone. When they hold files that belong to someone else, like a copy you made as root, give them all to user 1000:

```bash
sudo chown -R 1000:1000 data backups
```

## A backup or restore stops with an error

**"Eigen runs as uid 1000, which cannot read" a backup.** A restore reads the backup as user 1000. A copy made as root is often readable by root alone. Give it the file, as the message says:

```bash
sudo chown 1000:1000 <backup>
```

**"A full backup needs up to …; the backups folder has … free".** A backup checks for room before it starts, and needs room for everything uncompressed while it works. Free space on the disk of `backups/`, or delete backups you no longer need in **Settings → Backups**, then try again. A restore checks the disk of `data/` the same way, and says "Staging <backup> needs up to …".

**"The swap of <backup> stopped halfway and cannot go on".** A restore moves folders in place one by one, and something in the way stopped it. `.eigen/restore-swap` lists every move, and the message names where the old data went aside. Put `data/` right by hand from those two, then delete `.eigen/restore-swap`. Until you do, every `./eigen` command other than `logs`, `reset-password`, and `help` tries to finish the restore first.

**"data/ is in use by Eigen or by another restore".** Something still has `data/` open while the restore wants to swap it: another restore, or an Eigen that `./eigen` did not start. Wait for it to end, or stop it, then run `./eigen restore` again.

**"… cannot be swapped in: … is in the way here".** A restore of a Light backup moves the files of the backup into the users' and teams' folders, and something in your `data/` sits where one of them goes. Move what the message names out of the way, then run `./eigen restore` again.

**"… is on another disk than …".** A restore moves folders by renaming them, which works only within one disk. `data/`, `data/.restoring/`, and every user's and team's folder in `data/` must be on the disk of the install folder, not mounted from another one. Move them there, then run `./eigen restore` again.

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
