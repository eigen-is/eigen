---
title: "Host your mail on Eigen"
description: "Add the mail DNS records, use a mail domain other than the web address, connect mail and calendar apps, and block password guessing when Eigen runs your mail server."
type: how-to
category: Mail
tags: [self-hosting, mail, dns, dkim, spf, imap, smtp]
related: [self-hosting/mail-relay, self-hosting/keep-your-mail, connect/mail-client, connect/calendar-client]
order: 40
updated: 2026-09-30
---

When you answer yes to **Host email on this server?**, Eigen runs the mail server and holds everyone's mailbox. People read their mail in the Mail app and in any mail app on their phone or computer. This page covers what to do after the install so mail arrives and other servers trust what you send.

In the examples, Eigen runs at `eigen.example.com` and that is also the mail domain.

## Add the mail DNS records

When the mail server starts for the first time, it makes a DKIM key. You find it in `data/dkim/eigen.txt` in the install folder, and in the log of that first start (`./eigen logs postfix`, Ctrl-C to stop).

Add these records:

| Type | Name | Value |
|---|---|---|
| MX | `eigen.example.com` | `10 eigen.example.com` |
| TXT | `eigen.example.com` | `"v=spf1 mx ~all"` |
| TXT | `eigen._domainkey.eigen.example.com` | the DKIM key |
| TXT | `_dmarc.eigen.example.com` | `"v=DMARC1; p=quarantine; rua=mailto:postmaster@eigen.example.com"` |
| SRV | `_imaps._tcp.eigen.example.com` | `0 1 993 eigen.example.com` |
| SRV | `_submission._tcp.eigen.example.com` | `0 1 587 eigen.example.com` |
| SRV | `_caldavs._tcp.eigen.example.com` | `0 1 443 eigen.example.com` |
| SRV | `_carddavs._tcp.eigen.example.com` | `0 1 443 eigen.example.com` |
| TXT | `_caldavs._tcp.eigen.example.com` | `"path=/dav/"` |
| TXT | `_carddavs._tcp.eigen.example.com` | `"path=/dav/"` |

Sending through a relay? Add its SPF domain to the SPF record, like `"v=spf1 mx include:your-relay.com ~all"`.

Also set the **reverse DNS (PTR) record** of your server's IP address to your domain. You do that in the panel of your hosting provider, not at your domain registrar.

<div class="eigen-callout">

Registrar forms often add your domain to the name by themselves. Enter `_imaps._tcp`, not `_imaps._tcp.eigen.example.com`, or the record lands one level too deep. Forms that split an SRV name into fields want service `_imaps`, protocol `tcp`, and name `@`.

</div>

What the records do:

- **MX** tells the internet which server receives your mail.
- **SPF** says which servers may send mail for your domain.
- **DKIM** signs your outgoing mail, so receivers can check it is yours.
- **DMARC** tells receivers what to do with mail that fails those checks.
- **Reverse DNS** maps your IP address back to your domain. Many mail servers check it.
- **SRV** lets mail, calendar, and contacts apps find your server from an email address alone. The two TXT records tell calendar and contacts apps the path.

## Use a mail domain other than the web address

Eigen can run at `eigen.example.com` while addresses are `you@example.com`. Answer `eigen.example.com` to the first setup question and `example.com` to the second.

The mail records then live on the mail domain, and point at the web address:

```
example.com.                     MX   10 eigen.example.com.
example.com.                     TXT  "v=spf1 mx -all"
_dmarc.example.com.              TXT  "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com"
eigen._domainkey.example.com.    TXT  "<the DKIM key>"
_imaps._tcp.example.com.         SRV  0 1 993 eigen.example.com.
_submission._tcp.example.com.    SRV  0 1 587 eigen.example.com.
_caldavs._tcp.example.com.       SRV  0 1 443 eigen.example.com.
_carddavs._tcp.example.com.      SRV  0 1 443 eigen.example.com.
_caldavs._tcp.example.com.       TXT  "path=/dav/"
_carddavs._tcp.example.com.      TXT  "path=/dav/"
```

Some mail apps look for their settings at `autoconfig.example.com`. Point that name at the same IP address, and setup lists it as an optional A record. Or tell people to enter `eigen.example.com` as the mail server when they add their account.

## Outgoing port 25

Eigen delivers mail straight to the receiving server over port 25, like any mail server. Some providers block that port on new accounts. Ask them to open it, or send through a relay: see [Choose a mail relay](/support/self-hosting/mail-relay). Not sure? Leave the relay empty, and run `./eigen setup` again to add one later.

## Connect mail and calendar apps

People connect their own apps with the settings on their **Integrations** page in Space. See [Set up Eigen Mail in a mail client](/support/connect/mail-client) and [Set up Eigen Calendar in a calendar client](/support/connect/calendar-client). The server is your web address, IMAP is on port 993 and sending on port 587.

## Block password guessing

Out of the box, a user can only send mail as their own address, and failed sign-ins are limited per account and per IP address. That stops most password guessing.

To block it at the firewall as well, install fail2ban with the two rules Eigen comes with, one for sending and one for IMAP. Each bans an IP address after five failed sign-ins in ten minutes:

```bash
apt-get install fail2ban
cp /opt/eigen/docker/fail2ban/filter.d/*.conf /etc/fail2ban/filter.d/
cp /opt/eigen/docker/fail2ban/jail.d/eigen-mail-sasl.conf /etc/fail2ban/jail.d/
systemctl enable --now fail2ban
systemctl restart fail2ban
```

`fail2ban-client status eigen-postfix-sasl` shows what it caught. `./eigen` reloads fail2ban after an update, so the rules keep watching the new mail server. `docker/fail2ban/README.md` in the install folder has the details.
