---
title: "Run Eigen on your own server"
description: "What it takes to host Eigen yourself, and the articles that walk you through installing, running, and looking after it."
type: overview
category: Basics
tags: [self-hosting, install, server, getting-started]
related: [self-hosting/requirements, self-hosting/install, self-hosting/update, self-hosting/back-up-and-restore]
crossSections: [admin]
order: 10
updated: 2026-10-02
---

You can run Eigen on a server of your own, with your own domain. Everything runs in Docker, and one command, `./eigen`, installs it, updates it, and backs it up. This page shows the way through the articles in this section.

## Before you install

Check [what you need](/support/self-hosting/requirements): a Linux server, Docker, and a domain you control. Then decide two things, because the setup asks about them:

- **Who handles HTTPS.** Eigen can take ports 80 and 443 and get its own certificate. If your server already runs a web server for other sites, let that one forward to Eigen instead. See [Run Eigen behind your own web server](/support/self-hosting/behind-your-web-server).
- **Where your mail lives.** Eigen can host your mailboxes, or leave your mail where it is, at Proton Mail, Gmail, Google Workspace, Fastmail, or your own mail server. Both are a full install. See [Host your mail on Eigen](/support/self-hosting/host-your-mail) and [Keep your existing mail](/support/self-hosting/keep-your-mail).

## Install

[Install Eigen on a server](/support/self-hosting/install) takes you from an empty server to your first sign-in. The install is two lines. The setup asks five questions and prints a link that finishes the setup in your browser.

## Look after it

- [Update Eigen](/support/self-hosting/update) to a new release, or go back to the one before.
- [Back up and restore the whole server](/support/self-hosting/back-up-and-restore), and run the backup every night.
- [Move Eigen to another server](/support/self-hosting/move-to-another-server) with a backup.
- [Commands, logs, and files](/support/self-hosting/commands-and-files) lists what `./eigen` does and where everything lives.
- [Reset a password from the server](/support/self-hosting/reset-a-password) when nobody can sign in to Admin.
- [Fix common server problems](/support/self-hosting/troubleshooting) when something does not start or mail does not arrive.

Eigen is not 1.0 yet, and some things are still missing. [What Eigen does not do yet](/support/self-hosting/known-gaps) lists them, so you know before you start.
