---
title: "Create and manage app passwords"
description: "Generate a separate password for external clients like Thunderbird or Finder, and revoke one when you no longer need it."
type: how-to
category: Authentication
tags: [app passwords, integrations, two-factor, imap, caldav, webdav, security]
related: [connect/mount-drive-on-your-computer]
crossSections: [account]
order: 20
updated: 2026-06-08
---

An app password is a separate credential you give to an external client, such as Thunderbird, Apple Mail, or
Finder, instead of your main Eigen password. When two-factor authentication is on, external clients cannot use
your main password at all, so an app password is required. You can create as many as you need and revoke any of
them at any time without affecting the others.

## Create an app password

1. Open the [**Integrations**](/space/services) page in Space.
2. Scroll down to the **App passwords** section.
3. In the **Name** field, type a label that helps you remember what the password is for (for example,
   `Thunderbird` or `My laptop`).
4. Click **Generate**.
5. A box appears showing the new password. Copy it now. **You will not be able to see it again.**
6. Paste the password into your external client when prompted, then click **Done**.

<div class="eigen-callout">

Use your Eigen **email address** as the username in the external client, and the app password as the password.
Do not use your main Eigen password.

</div>

## Revoke an app password

1. Open the [**Integrations**](/space/services) page in Space.
2. Scroll to **App passwords**. The list shows every password you have created, along with when it was created
   and when it was last used.
3. Click the trash icon in the row for the password you want to remove.

The password stops working immediately. Any client that was using it will be asked to sign in again.

## What to do if you missed copying the password

App passwords are shown only once. If you did not copy it before clicking **Done**, revoke it and generate a
new one. Give the new one the same name if it helps you keep track.
