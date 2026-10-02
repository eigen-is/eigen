---
title: "Keep your existing mail"
description: "Run Eigen while your mail stays at Gmail, Fastmail, Google Workspace, or your own mail server, and check that Eigen's own mail goes out through your relay."
type: how-to
category: Mail
tags: [self-hosting, mail, relay, sender, settings]
related: [self-hosting/mail-relay, self-hosting/host-your-mail, admin/server-settings]
order: 50
updated: 2026-10-02
---

When you answer no to **Host email on this server?**, your addresses and mailboxes stay where they are. Eigen hosts no mail. It still sends its own mail, like sign-in codes, invitations, and share notifications, through a relay you name at setup. This page covers what that looks like and how to check that the mail goes out.

## What changes without hosted mail

- There is no Mail app. It disappears from the app switcher and the command palette, and so do the "Mail to…" actions and the IMAP card on the **Integrations** page. Opening `/mail` shows **Mail is turned off on this server**.
- When setup asks **Which mail domain will you use?**, answer the domain your addresses are on now. Everyone then signs in to Eigen with the email address they already have: `jane@example.com` at Proton Mail is `jane@example.com` in Eigen too. Their mailboxes live wherever that domain's mail is hosted, so they keep using the mail app they have.
- Calendar and Contacts work as on any Eigen, calendar and contacts apps included.
- When someone outside Eigen answers a calendar invitation, the answer lands in the organizer's own mailbox. Eigen does not update that guest's status on the event.

## Name a relay

Everything Eigen sends goes out through the relay you named in the last setup question. Without one, Eigen sends no email at all: no codes, no invitations, no notifications. Setup warns when you leave it empty.

No relay yet? Pick one in [Choose a mail relay](/support/self-hosting/mail-relay), then run `./eigen setup` again. It keeps your other answers.

Setup lists no mail DNS records in this mode. Your mail domain keeps the records your mail provider set. A relay service that sends from your domain, like Brevo or Postmark, has you verify the domain first, usually with an SPF include and a DKIM key of its own. Add those beside the records you have.

## Check it in Admin

Sign in as the owner, go to [Admin](/admin), and click **Settings** in the sidebar.

1. Under **Server**, the **Mail** row reads "No mailboxes; mail goes out through" and the name of your relay. "No mailboxes and no relay" means Eigen sends no email.
2. Under **Mail**, the **Sender address** is the address Eigen's own mail comes from. You picked it when you finished the setup. The relay must accept it.
3. Mail that a person causes, like a share notification or a calendar invitation, comes from the sender address with their name, like `Ada via Acme <noreply@example.com>`, and replies go to them. If your relay lets you send from every address on your mail domain, turn on **Relay sends as users**. That mail then comes from the person's own address.
4. Click **Send test mail**. It sends one email from you to you, the way a share notification goes out. If it fails, Eigen shows the relay's answer. Save your changes first: the test uses the saved sender.

[Server settings](/support/admin/server-settings) describes the rest of that page.
