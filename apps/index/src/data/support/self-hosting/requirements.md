---
title: "What you need to run Eigen"
description: "The server, memory, software, domain, disk space, and network ports an Eigen install needs."
type: reference
category: Basics
tags: [self-hosting, install, requirements, server, memory, ports]
related: [self-hosting/install, self-hosting/get-started]
order: 20
updated: 2026-09-30
---

Eigen runs in Docker on one server. This page lists what that server needs before you [install Eigen](/support/self-hosting/install).

## The server

| What | Needed |
|---|---|
| Operating system | Linux, such as Debian 12 or Ubuntu 22.04 or newer |
| Processor | 64-bit: amd64 (Intel and AMD) or arm64. Eigen is built for these two only. |
| Memory | 2 GB of RAM at least, 4 GB recommended. See [Memory](#memory). |
| Docker | Docker, with the Docker Compose plugin 2.20 or newer |
| Access | SSH, as root or as a user in the `docker` group |

Nothing else goes on the server: no Bun, no Node. The one-line install needs `curl` or `wget` to download the `eigen` command. `./eigen` checks the Docker and Compose versions before it does anything.

If you add your own `docker-compose.override.yml` that uses Compose's `!override` tag, Compose must be 2.24.4 or newer.

## Memory

These are the numbers for a small install, measured with one person signing in, opening a document, uploading a few megabytes, searching, and exporting.

| Setup | Idle | Highest seen | Minimum | Recommended |
|---|---|---|---|---|
| You keep your existing mail | About 200 MB | About 850 MB | 2 GB | 4 GB |
| Eigen hosts your mail | About 250 MB | About 850 MB | 2 GB | 4 GB |

Exports use the most memory. One sheet exported to PDF took Eigen to about 600 MB, and five PDF exports at once to about 850 MB. Hosting mail adds about 50 MB. The rest of the minimum is for the operating system and Docker.

More people and bigger documents need more memory. The recommended 4 GB leaves room for that.

## A domain

You need a domain you can set DNS records for, like `eigen.example.com`. People open Eigen at that address, and it is where the HTTPS certificate is for.

Every account's address is on a mail domain, like `jane@example.com`. By default that is the same domain. You pick it once, at the first setup, and it cannot change after that.

## Disk space

Plan for 10 GB for Eigen's own software, plus room for your data.

Eigen's software comes as Docker images. They take about 2.8 GB of disk, or 3.2 GB when Eigen hosts your mail. On some Docker installs they take up to 4.3 GB, because Docker also keeps the downloaded copies. After an update, the images of the version before stay on disk so that `./eigen rollback` can go back to it. So count on room for two sets.

A fresh install starts with almost no data: under 1 MB before anyone uploads a file.

Everything else lives in one install folder: the files, the mail, the databases, and the backups in `backups/`. Leave room for your data and for its backups. A Full backup is a compressed copy of all of it, apart from the files of drives kept in an S3 bucket. Eigen keeps the nightly ones you ask for, seven by default, the two newest an update made, and every one you make by hand.

While it works, a backup needs more room than it ends up taking. Before it starts, it checks that `backups/` has room for all the data uncompressed and some to work with, and refuses when it has not. A restore unpacks the backup inside `data/`, on its disk, and checks for room the same way.

## Network ports

Which ports must be open to the internet depends on two setup answers.

| Setup answer | Incoming ports |
|---|---|
| Eigen handles HTTPS | 80 and 443 (TCP) |
| Your web server forwards to Eigen | None for Eigen. It listens on `127.0.0.1:8080` by default, and your web server keeps 80 and 443. |
| Eigen hosts your mail | 25, 465, 587, and 993 (TCP) |
| You keep your existing mail | None |

Leave SSH (22) open too, or whatever port you use for it.

Hosting mail also needs outgoing port 25, so Eigen can deliver to other mail servers. Some providers block it on new accounts. Then you send through a relay, which also covers the case where you keep your mail. See [Choose a mail relay](/support/self-hosting/mail-relay).
