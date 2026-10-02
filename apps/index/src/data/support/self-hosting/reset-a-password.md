---
title: "Reset a password from the server"
description: "Set a new password for any account, the owner's included, with ./eigen reset-password when nobody can sign in to Admin."
type: how-to
category: Maintenance
tags: [self-hosting, password, admin, owner, account]
related: [admin/manage-members, account/change-password]
order: 120
updated: 2026-09-30
---

Forgot the owner's password, or the password of the only admin? Whoever runs the server can set a new one from the install folder. Eigen must be running.

## Set a new password

1. On the server, go to the install folder, like `cd /opt/eigen`.
2. Run the command with the address of the account:

   ```bash
   ./eigen reset-password jane@example.com
   ```

3. Type the new password, then type it again to confirm. It needs at least eight characters.

Rather have Eigen make one up? Run `./eigen reset-password jane@example.com --generate`. It prints the new password once, so copy it straight away.

## What else changes

The account is signed out everywhere. Its app passwords, for mail, calendar, and file apps, stop working too, so make new ones on the **Integrations** page after you sign in. See [Create and manage app passwords](/support/connect/app-passwords).

## From Admin instead

An admin who can still sign in can reset anyone's password on the [**Users**](/admin/users) page, except the owner's. Only the owner resets the owner's password there. See [Add and manage members](/support/admin/manage-members).
