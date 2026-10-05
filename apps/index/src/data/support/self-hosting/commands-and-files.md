---
title: "Commands, logs, and files"
description: "What each ./eigen command does, how to read the logs, and where Eigen keeps its settings and data in the install folder."
type: reference
category: Maintenance
tags: [self-hosting, commands, logs, status, files]
related: [self-hosting/troubleshooting, self-hosting/update, self-hosting/back-up-and-restore]
order: 110
updated: 2026-10-05
---

Everything you do with Eigen on the server goes through `./eigen` in the install folder. `./eigen help` lists the commands, and `./eigen <command> --help` tells more about one.

## Commands

| Command | What it does |
|---|---|
| `./eigen setup` | Asks the setup questions, starts Eigen, and prints the link that finishes the setup. Run it again to change an answer. |
| `./eigen status` | Shows the version, a waiting update, the services, disk space, the newest backup, the certificate, and the mail queue |
| `./eigen logs [service]` | Follows the logs of every service, or of one. Ctrl-C stops it. |
| `./eigen restart` | Starts Eigen, and any part of it that stopped |
| `./eigen stop` | Stops Eigen. When a backup is running, it waits for that one to end first. `./eigen restart` starts it again. |
| `./eigen update` | Installs a new release. See [Update Eigen](/support/self-hosting/update). |
| `./eigen rollback` | Goes back to the version before the last update |
| `./eigen backup` | Backs up the whole server into `backups/` while Eigen runs. Its exit code tells a script whether the backup verified and reached the bucket. Eigen keeps these backups until you delete them; for a backup every night, turn on the nightly backup instead. See [Back up now](/support/self-hosting/back-up-and-restore#back-up-now). |
| `./eigen restore <backup>` | Puts a whole-server backup back, on this server or a new one |
| `./eigen reset-password <email>` | Sets a new password for an account. See [Reset a password from the server](/support/self-hosting/reset-a-password). |

`./eigen` runs one command that changes Eigen at a time, like an update, a rollback, or a restore. A second one stops with "Another ./eigen command is running." `./eigen backup` does not count: it changes nothing, and runs on the running server.

## Status

`./eigen status` also names the install folder, and the newest backup with its age and size. The Backup row turns red when the last nightly backup failed. It warns when the last backup has warnings, when that backup did not reach your backup bucket, when there is no backup yet, and when nightly backups are on but no Full backup has verified in two days. An update that stopped halfway shows as `files of <new version>, running <old version>`, and `./eigen update` finishes it.

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
| `.env.production` | Your setup answers and the version you run. Its owner can read it, and so can Eigen, through group 1000, so the backup can take it along. |
| `.env.example` | Every setting, with a comment on each |
| `docker-compose.yml` | Which services run. An update rewrites it. |
| `docker-compose.override.yml` | Your own Compose settings, if you made one. An update leaves it alone. |
| `data/home/`, `data/team/`, `data/org/` | Every user's, team's, and organization's files, mail, calendars, and contacts |
| `data/guest/` | The workspaces of guests, people who sign in with a code. A backup leaves them out: after a restore of a Full backup, a guest keeps their account and starts with an empty workspace. A restore of a Light backup leaves them as they are. |
| `data/server/` | The accounts, the server settings, and the organization |
| `data/dkim/` | The key that signs outgoing mail |
| `data/certs/` | The certificate of the mail server |
| `backups/` | Whole-server backups, and backups of single users and teams made in Admin |
| `snapshots/` | The snapshots Eigen 0.3.0 made, by `./eigen backup` and by the update from 0.3.0. Only Eigen 0.3.0 restores them. |
| `caddy-data/` | The HTTPS certificates of Eigen's own web server |
| `eigen.nginx.conf`, `eigen.apache.conf`, `eigen.Caddyfile` | Settings for your own web server, when it forwards to Eigen |
| `docker/fail2ban/` | Rules for fail2ban, when you host mail |
| `scripts/` | The hourly reset of a demo server. A normal install does not use it. |
| `.eigen/` | The command's own notes, like `last-step.log` |

Mail still waiting to go out is the one thing outside the folder. Docker keeps it in a volume of its own.
