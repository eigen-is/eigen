---
title: "Restore a user or team from a backup"
description: "Replace one user's or team's account with an earlier backup archive from the admin panel, and keep the current state as a safety copy."
type: how-to
category: Backups
tags: [admin, backup, restore, server]
related: [admin/back-up-home, admin/backup-contents]
order: 91
updated: 2026-09-30
---

You can put a single user's or team's account back to the state held in a backup archive. Eigen checks the archive first, replaces the account from it, and keeps the current state beside it as a safety copy, so nothing is thrown away. Only an admin can do this.

## Before you start

A backup archive can only restore the same account it was made from. You cannot use one user's archive to fill in another user. The archive may come from another server, as long as it is a backup of this same account. To bring one over from another machine first, see [Back up a user or team](/support/admin/back-up-home).

To see what an archive contains, read [What a backup contains](/support/admin/backup-contents). A backup of the whole server holds an archive of every user and team, which whoever runs the server can [copy into the backups folder](/support/self-hosting/back-up-and-restore#restore-one-user-or-team-from-a-server-backup) to restore from here.

## Restore an account

1. Sign in to Eigen as an admin and open [Admin](/admin).
2. For a person, click **Users** in the sidebar and pick the user. For a team, click **Teams** and pick the team.
3. Scroll to the **Backup** section. It lists every archive for that account.
4. Find the archive you want, hover over its row, and click **Restore** (the circular arrow icon). An archive that failed its check has no **Restore** button: fix or replace it first. Neither has an archive that holds only part of the account, like a copy out of a Light backup of the whole server. Its row says what it leaves out.
5. A dialog titled **Restore this home** asks you to confirm. It explains that this replaces every file, mail, and database of the account with the archive, that the account is unavailable while the restore runs, that every open page of it reloads, and that the current state is kept beside it as a safety copy.
6. Click **Restore** to start. The section shows **Restoring home** with its progress while the job runs, then **Home restored** when it finishes.

Eigen verifies the archive before it touches anything. If the check fails, the job stops and the account is left exactly as it was.

<div class="eigen-callout">

Only one backup job runs per account at a time. If a backup, verify, or another restore is already running for this user or team, wait for it to finish before you start the restore.

</div>

## What people see while it runs

The account is unavailable for the length of the restore, which is usually seconds to a few minutes. During that time:

- Anyone using that account gets a "Restore in progress" message. Requests fail until the restore finishes, then work again.
- Nobody is signed out. Sessions stay as they are.
- Every open Eigen tab of the account reloads itself once the restore is done, in every app, so it shows the restored content instead of what it was holding. This usually takes a few seconds, and can take up to a minute. For a team, that goes for the tabs of every member.
- A tab that was offline during the restore reloads once, the next time it reconnects. That way it can't put old content back.
- Other people's tabs don't reload, unless they have a document of this account open. That document reloads the same way.
- If you restore your own account, your page reloads too, and it may reload before the **Backup** section shows **Home restored**.
- A mail client connected over IMAP keeps seeing the old mailbox until the restore finishes. What it does in that window, like flagging, moving, or saving a message, lands in the safety copy, not in the restored account. For a mail-heavy restore, either pause the mail client for the window or copy any missing messages out of the safety copy afterwards.
- New mail is not lost. It waits on the server and arrives in the restored account once the restore is done.

## Safety copies and undoing a restore

Every restore keeps the account as it stood beforehand. These show up under a **Safety copies** heading in the same **Backup** section:

- **The home before a restore** is the account exactly as it was just before you restored it.
- **A restore that did not finish** is the leftover of a restore that was interrupted. It is not a working account, so you can only delete it.

To undo a restore, hover over the matching **The home before a restore** row and click **Restore this copy**. The account goes back to that earlier state, and the version it is in now becomes a new safety copy beside it. This makes a restore reversible by hand.

To free up space, click **Delete safety copy** on any row. Safety copies are never removed automatically and each one keeps a full second copy of the account on disk, so delete them once you are sure you no longer need them.
