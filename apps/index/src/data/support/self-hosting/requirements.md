---
title: "What you need to run Eigen"
description: "The server, software, domain, disk space, and network ports an Eigen install needs."
type: reference
category: Basics
tags: [self-hosting, install, requirements, server, ports]
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
| Memory | 2 GB of RAM or more |
| Docker | Docker, with the Docker Compose plugin 2.20 or newer |
| Access | SSH, as root or as a user in the `docker` group |

Nothing else goes on the server: no Bun, no Node. The one-line install needs `curl` or `wget` to download the `eigen` command. `./eigen` checks the Docker and Compose versions before it does anything.

If you add your own `docker-compose.override.yml` that uses Compose's `!override` tag, Compose must be 2.24.4 or newer.

## A domain

You need a domain you can set DNS records for, like `eigen.example.com`. People open Eigen at that address, and it is where the HTTPS certificate is for.

Every account's address is on a mail domain, like `jane@example.com`. By default that is the same domain. You pick it once, at the first setup, and it cannot change after that.

## Disk space

Everything lives in one install folder: the files, the mail, the databases, and the backups. Leave room for your data and for its snapshots. A full snapshot is a compressed copy of all of it, and `./eigen backup` keeps the newest three. An update saves a snapshot too. Both check that the snapshot fits before they stop anything.

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
