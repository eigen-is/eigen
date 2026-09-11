---
title: "Restore a user or team from a backup"
description: "Replace one user's or team's account with an earlier backup archive from the admin panel, and keep the current state as a safety copy."
type: how-to
category: Backups
tags: [admin, backup, restore, server]
related: [admin/back-up-home, admin/backup-contents]
order: 91
updated: 2026-09-11
---

You can put a single user's or team's account back to the state held in a backup archive. Eigen checks the archive first, replaces the account from it, and keeps the current state beside it as a safety copy, so nothing is thrown away. Only an admin can do this.

## Before you start

A backup archive can only restore the same account it was made from. You cannot use one user's archive to fill in another user, and you cannot restore an archive onto a different server. If you need to bring an archive over from another machine first, see [Back up a user or team](/support/admin/back-up-home).

To see what an archive contains, read [What a backup contains](/support/admin/backup-contents).

## Restore an account

1. Sign in to Eigen as an admin and open [Admin](/admin).
2. For a person, click **Users** in the sidebar and pick the user. For a team, click **Teams** and pick the team.
3. Scroll to the **Backup** section. It lists every archive for that account.
4. Find the archive you want, hover over its row, and click **Restore** (the circular arrow icon). An archive that failed its check has no **Restore** button: fix or replace it first.
5. A dialog titled **Restore this home** asks you to confirm. It explains that this replaces every file, email, and setting in the account with the archive, that the account is unavailable while the restore runs, that open editors reload, and that the current state is kept beside it as a safety copy.
6. Click **Restore** to start. The section shows **Restoring home** with its progress while the job runs, then **Home restored** when it finishes.

Eigen verifies the archive before it touches anything. If the check fails, the job stops and the account is left exactly as it was.

<div class="eigen-callout">

Only one backup job runs per account at a time. If a backup, verify, or another restore is already running for this user or team, wait for it to finish before you start the restore.

</div>

## What people see while it runs

The account is unavailable for the length of the restore, which is usually seconds to a few minutes. During that time:

- Anyone using that account gets a "Restore in progress" message. Requests fail until the restore finishes, then work again.
- Nobody is signed out. Sessions stay as they are.
- Open editor tabs reload themselves once the restore is done, so they pick up the restored content instead of the version they were holding.
- A mail client connected over IMAP keeps seeing the old mailbox until the restore finishes. Mail delivered or flagged in that window lands in the safety copy, not in the restored account. For a mail-heavy restore, either pause the mail client for the window or copy any missing messages out of the safety copy afterwards.

## Safety copies and undoing a restore

Every restore keeps the account as it stood beforehand. These show up under a **Safety copies** heading in the same **Backup** section:

- **The home before a restore** is the account exactly as it was just before you restored it.
- **A restore that did not finish** is the leftover of a restore that was interrupted. It is not a working account, so you can only delete it.

To undo a restore, hover over the matching **The home before a restore** row and click **Restore this copy**. The account goes back to that earlier state, and the version it is in now becomes a new safety copy beside it. This makes a restore reversible by hand.

To free up space, click **Delete safety copy** on any row. Safety copies are never removed automatically and each one keeps a full second copy of the account on disk, so delete them once you are sure you no longer need them.
