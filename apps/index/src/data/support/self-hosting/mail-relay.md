---
title: "Choose a mail relay"
description: "When Eigen needs a mail relay, which ones work, how to enter one at setup, and which sender addresses the relay must accept."
type: reference
category: Mail
tags: [self-hosting, mail, relay, smtp]
related: [self-hosting/keep-your-mail, self-hosting/host-your-mail]
order: 60
updated: 2026-10-01
---

A relay is a mail server that takes your mail after a sign-in and delivers it for you. This page tells you whether you need one, and what to check when you pick one.

## When you need one

It depends on your answer to **Host email on this server?**:

- **Keeping your mail: always.** Everything Eigen sends goes through the relay: two-factor codes by email, guest sign-in codes, invitations, share and access-request notifications, and calendar invitations and replies. Without a relay, every one of those fails.
- **Hosting mail: only when your provider blocks outgoing port 25.** Otherwise Eigen's mail server delivers straight to the receiving server. Hetzner and DigitalOcean block port 25 on new accounts. Ask them to open it, or send through a relay.

## Which relays work

Anything that takes mail over SMTP with a user name and password:

- A mail service like Brevo, Postmark, Mailgun, SendGrid, or Amazon SES. Most have a free tier of a few hundred mails a day.
- The SMTP server of your current mail provider: Google Workspace, Gmail with an app password, Fastmail, or your internet provider.
- A mail server you run yourself.

## Enter it at setup

Answer the relay question as `host:port`, like `smtp-relay.brevo.com:587`. Setup then asks for the user name and the password. To change the relay later, run `./eigen setup` again.

Port 465 means the connection is encrypted from the start. Any other port starts plain and switches to encryption. With a user name, the connection must be encrypted, so the password never travels in the clear. When you keep your mail and the relay has a user name, Eigen also checks the relay's certificate.

## Which addresses it must accept

Check which sender addresses the relay lets you use.

- **Keeping your mail**, Eigen sends from one address, the sender address in Admin **Settings**, unless you turn on **Relay sends as users**. One mailbox is enough, a Gmail account included, as long as it may send from that address. See [Keep your existing mail](/support/self-hosting/keep-your-mail).
- **Hosting mail**, every user's mail goes out through the relay from their own address. The relay must accept every address on your mail domain. A mail service does, once you have verified the domain. A personal Gmail account does not: Gmail rewrites the sender to the account itself, so mail from Jane would arrive as sent by you. Google Workspace has an SMTP relay service that sends for a whole domain.

## Use the mail server on this machine

Keeping your mail, and already running a mail server on the same machine, outside Docker? It can be the relay. Answer `host.docker.internal:25`, which is Docker's name for the machine Eigen runs on. That mail server must:

- Listen on `0.0.0.0` or on the gateway of Eigen's Docker network, not only on `127.0.0.1`. The network is `EIGEN_SUBNET` in `.env.production`.
- Allow relaying from that network.
