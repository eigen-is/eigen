---
title: "Commands, logs, and files"
description: "What each ./eigen command does, how to read the logs, and where Eigen keeps its settings and data in the install folder."
type: reference
category: Maintenance
tags: [self-hosting, commands, logs, status, files]
related: [self-hosting/troubleshooting, self-hosting/update, self-hosting/back-up-and-restore]
order: 110
updated: 2026-09-30
---

Everything you do with Eigen on the server goes through `./eigen` in the install folder. `./eigen help` lists the commands, and `./eigen <command> --help` tells more about one.

## Commands

| Command | What it does |
|---|---|
| `./eigen setup` | Asks the setup questions, starts Eigen, and prints the link that finishes the setup. Run it again to change an answer. |
| `./eigen status` | Shows the version, a waiting update, the services, disk space, the newest backup, the certificate, and the mail queue |
| `./eigen logs [service]` | Follows the logs of every service, or of one. Ctrl-C stops it. |
| `./eigen restart` | Starts Eigen, and any part of it that stopped |
| `./eigen stop` | Stops Eigen. `./eigen restart` starts it again. |
| `./eigen update` | Installs a new release. See [Update Eigen](/support/self-hosting/update). |
| `./eigen rollback` | Goes back to the version before the last update |
| `./eigen backup` | Backs up the whole server into `backups/` while Eigen runs. See [Back up and restore the whole server](/support/self-hosting/back-up-and-restore). |
| `./eigen restore <backup>` | Puts a whole-server backup back, on this server or a new one |
| `./eigen reset-password <email>` | Sets a new password for an account. See [Reset a password from the server](/support/self-hosting/reset-a-password). |

`./eigen` runs one command that changes Eigen at a time, like an update, a rollback, or a restore. A second one stops with "Another ./eigen command is running." `./eigen backup` does not count: it changes nothing, and runs on the running server.

## Status

`./eigen status` also names the install folder, and the newest backup with its age and size. The Backup row turns red when the last nightly backup failed. It warns when that backup did not reach your backup bucket, when there is no backup yet, and when nightly backups are on but no Full backup has checked out in two days. An update that stopped halfway shows as `files of <new version>, running <old version>`, and `./eigen update` finishes it.

## Logs

`./eigen logs` follows the last lines of every service and keeps going. `./eigen logs eigen-api` shows only the server itself. The services are:

| Service | What it is | Runs when |
|---|---|---|
| `eigen-api` | The Eigen server | Always |
| `caddy` | Eigen's own web server, with HTTPS | Eigen handles HTTPS |
| `eigen-static` | The web pages, for your own web server to forward to | Your web server forwards to Eigen |
| `postfix` | Mail in and out | Eigen hosts your mail |
| `dovecot` | IMAP, for mail apps | Eigen hosts your mail |
| `unbound` | Looks up other mail servers | Eigen hosts your mail |

Docker keeps three log files of 10 MB for each service, and ten of 50 MB for `postfix` and `dovecot`, so a run of password guessing is still there when you look.

When a step of `./eigen` fails, it shows the last lines of its output. The full output is in `.eigen/last-step.log`.

## Where things live

Everything is in the install folder, like `/opt/eigen`:

| Path | What it holds |
|---|---|
| `eigen` | The `eigen` command |
| `.env.production` | Your setup answers and the version you run. Only its owner and Eigen can read it. |
| `.env.example` | Every setting, with a comment on each |
| `docker-compose.yml` | Which services run. An update rewrites it. |
| `docker-compose.override.yml` | Your own Compose settings, if you made one. An update leaves it alone. |
| `data/home/`, `data/team/`, `data/org/` | Every user's, team's, and organization's files, mail, calendars, and contacts |
| `data/server/` | The accounts, the server settings, and the organization |
| `data/dkim/` | The key that signs outgoing mail |
| `data/certs/` | The certificate of the mail server |
| `backups/` | Whole-server backups, and backups of single users and teams made in Admin |
| `snapshots/` | Only after the update from Eigen 0.3.0: the snapshot that update saved. See [Update Eigen](/support/self-hosting/update#after-the-update-from-030). |
| `caddy-data/` | The HTTPS certificates of Eigen's own web server |
| `eigen.nginx.conf`, `eigen.apache.conf`, `eigen.Caddyfile` | Settings for your own web server, when it forwards to Eigen |
| `docker/fail2ban/` | Rules for fail2ban, when you host mail |
| `.eigen/` | The command's own notes, like `last-step.log` |

Mail still waiting to go out is the one thing outside the folder. Docker keeps it in a volume of its own.
