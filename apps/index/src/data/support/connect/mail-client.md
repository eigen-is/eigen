---
title: "Set up Eigen Mail in a mail client"
description: "Read and send your Eigen email from any IMAP and SMTP client, such as Thunderbird or Apple Mail, using an app password."
type: how-to
category: Email
tags: [mail, imap, smtp, thunderbird, apple mail, app passwords, integrations]
related: [connect/app-passwords, connect/overview]
crossSections: [mail]
order: 30
updated: 2026-06-08
---

Your Eigen mailbox is available over IMAP and SMTP, so you can use any standard email client alongside or instead
of the browser. This article walks you through getting the connection details and entering them in your client.

## Before you start

You need an **app password** to connect. App passwords are separate credentials you create for external clients.
They keep working when two-factor authentication is on, and you can revoke one at any time without changing your
main password.

To create one:

1. Open the [**Integrations**](/space/services) page in Space.
2. Scroll to **App passwords**.
3. Type a name in the **Name** field (for example, `Thunderbird` or `Apple Mail`), then click **Generate**.
4. Copy the password now. It is only shown once.
5. Click **Done**.

Your Eigen **email address** is the username for both IMAP and SMTP.

## Connection settings

All the values you need are on the [**Integrations**](/space/services) page under **IMAP (Email sync)**. The
table below summarises them.

| Setting | Value |
|---|---|
| **IMAP server** | Your Eigen host (shown on the Integrations page) |
| **IMAP Port** | `993` |
| **Security** | SSL/TLS |
| **SMTP server** | Your Eigen host (same as IMAP) |
| **SMTP port** | `465` |
| **Username** | Your Eigen email address |
| **Password** | The app password you generated |

<div class="eigen-callout">

Use the app password, not your main Eigen password. If you have two-factor authentication switched on, only app
passwords work; your main password is rejected by the mail server.

</div>

## Set up in Thunderbird

1. In Thunderbird, open **Edit → Account Settings** (or **Thunderbird → Account Settings** on macOS).
2. At the bottom of the account list, click **Account Actions → Add Mail Account**.
3. Enter your name, your Eigen email address, and the app password you generated, then click **Configure
   manually**.
4. For incoming mail, set the protocol to **IMAP**, enter the server hostname from the Integrations page, set
   the port to `993`, and set security to **SSL/TLS**.
5. For outgoing mail, enter the same server hostname, set the port to `465`, and set security to **SSL/TLS**.
6. Set the authentication method to **Normal password** for both incoming and outgoing.
7. Click **Done**.

Thunderbird will verify the settings and download your folders.

## Set up in Apple Mail

1. In Mail, open the account preferences and add a new account. Choose **Other Mail Account** when asked for the
   account type.
2. Enter your name, your Eigen email address, and the app password.
3. If Mail cannot detect the settings automatically, enter the IMAP and SMTP server details from the table above.
4. Set the port to `993` for IMAP and `465` for SMTP, with SSL on for both.

## Sign in again after revoking an app password

If you revoke an app password, the connected client will stop receiving mail and will ask you to sign in again.
Generate a new app password on the [**Integrations**](/space/services) page and update the password in your
client's account settings.
