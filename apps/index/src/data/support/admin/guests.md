---
title: "Enable and configure guest access"
description: "Control how external people sign in to view shared files, set how long inactive guest accounts are kept, and review current guests."
type: how-to
tags: [admin, guests, sharing, access]
related: [admin/get-started, drive/share-a-file]
order: 50
updated: 2026-06-08
---

Guest access lets people outside your organisation view files you have shared with them. Guests sign in
with a one-time code sent to their email address, not a password, so they do not need a full account on
your server.

## How guest access works

When you share a file or folder with an email address that does not belong to a member, Eigen adds that
email to the share. The next time that person visits your Eigen server and enters their email address,
Eigen sends a six-digit code to their inbox. They enter the code to sign in and see only the content
shared with them.

Guest accounts are separate from member accounts. They cannot access any app, setting, or file that has
not been explicitly shared with them.

## Configure guest access settings

The guest access settings are only visible to the server **Owner**. Admins cannot see this section.

1. Open [**Guest access**](/admin/guest-settings) in Admin.
2. Adjust the settings as needed and click **Save**.

### Allow open guest signup

When **Allow open guest signup** is on (the default), anyone can enter their email address and request a
sign-in code, even before anything has been shared with them. They will be able to sign in, though they
will see an empty workspace until you share something.

Turn this off if you want to restrict sign-in codes to email addresses that already have a pending share.
With open signup off, someone whose email is not in any share gets an error when they request a code.

### Days of inactivity before deletion

Eigen runs a daily sweep that removes guest accounts that have not been active for longer than this many
days. The default is 7. You can set any value from 1 to 365.

Deletion removes the guest account, but the share record is preserved. If the same person signs in
again later, their access is restored automatically.

## Review and remove guest accounts

The [**Guests**](/admin/guests) page lists all current guest accounts. You can search by name or email
address.

Click a guest's name to open their detail panel. To remove a guest immediately, click the delete icon
in the toolbar and confirm the deletion. This removes the account, not the share, so if you shared
something with that person before, they could sign in again and their access would be restored.

## Email notifications for guests

When you share a file with a guest's email address, Eigen can send them a notification email. You
control this from [**Settings**](/admin/settings), under **Email notifications**, using the
**Email guests when added to share** toggle.

This is on by default. Guests have no in-app notification channel, so turning it off means they will not
know a file has been shared with them unless you tell them yourself.
