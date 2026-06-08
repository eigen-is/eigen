---
title: "Add and manage members"
description: "Create a new user account, change a member's role, reset their password, or remove them from your Eigen server."
type: how-to
tags: [admin, members, users, roles, password]
related: [admin/teams, admin/guests]
order: 20
updated: 2026-06-08
---

Members are the people with full accounts on your Eigen server. You manage them from the [**Members**](/admin/members) page in Admin. You need an admin or owner role to do any of this.

## Add a member

1. Open [**Members**](/admin/members) in Admin.
2. Click the **+** button in the toolbar.
3. Fill in the **Name**, **Username**, and **Password** fields. The username becomes the person's email address on your mail domain.
4. Set the **Role**: **Member** for a regular account, or **Admin** to give the person admin access.
5. Click **Create**.

The account is ready immediately. Share the email address and the temporary password with the new person so they can sign in. They can change their password after logging in.

## Change a member's role

1. On the [**Members**](/admin/members) page, click the person's name to open their detail panel.
2. Under **Role**, open the dropdown and choose **Admin** or **Member**.
3. Click **Save**.

The change takes effect straight away. Owners cannot have their role changed this way.

## Reset a member's password

You can set a new password for any non-owner member, for example if they are locked out.

1. Click the member's name to open their detail panel.
2. Click the key icon in the toolbar to open **Reset password for [name]**.
3. A new password is pre-filled. You can replace it with your own if you prefer.
4. Click **Reset password**.

The dialog generates a random password. Share it with the person securely. They can change it themselves from [Security settings](/space/security/password) after signing in.

## Remove a member

<div class="eigen-callout">

Deleting a user permanently removes their account, files, emails, contacts, and calendars. This cannot be undone.

</div>

1. Click the member's name to open their detail panel.
2. Scroll to the **Danger zone** section at the bottom.
3. Click **Delete user**.
4. Read the confirmation and click to confirm.

The account and all associated data are deleted. Owners cannot be removed this way.
