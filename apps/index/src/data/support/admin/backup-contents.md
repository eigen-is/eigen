---
title: "What a backup contains and how it is checked"
description: "A reference for what one user's or team's backup holds, what it leaves out, how Eigen verifies it, and the limits of the backup panel."
type: reference
category: Backups
tags: [admin, backup, restore, server]
related: [admin/back-up-home, admin/restore-home]
order: 92
updated: 2026-09-30
---

A backup made from the **Backup** section in Admin is a single archive of one user or one team. This page lists what goes into that archive, what stays out, how Eigen checks it, and where the panel's limits are. To make or restore a backup, see [Back up a user or team](/support/admin/back-up-home) and [Restore a user or team](/support/admin/restore-home).

## What is in a backup

One archive covers one user or one team, and nothing else on the server.

| Item | In the backup? |
|---|---|
| All files in Drive | Yes |
| Earlier versions of a file | Yes |
| Trashed files | Yes |
| Thumbnails | Yes |
| Documents, spreadsheets, presentations, drawings, and boards | Yes |
| Chats | Yes |
| Mail | Yes (for a user) |
| Calendars | Yes |
| Contacts | Yes (for a user) |
| The account's settings | Yes |
| The user's profile picture | Yes (for a user) |
| Who each file is shared with | Yes |
| Files stored in S3 | Yes, downloaded and included in full |
| Other users or teams | No |
| Server-wide settings | No |
| The server's own configuration | No |

A team backup is the same shape as a user backup, minus the parts a team has no equivalent for, such as mail and contacts.

## The archive file

| Detail | Value |
|---|---|
| Format | `.tar.zst`, a compressed tar archive you can open with standard tools (`tar --zstd`) |
| Name | `home-<id>-<date>-<time>.tar.zst`, for example `home-a1b2c3-20260911-140322.tar.zst` |
| Where it lands | The server's backups folder: `EIGEN_BACKUPS_DIR` if set, otherwise `backups/` next to the data directory |

Files stored in an S3 bucket are downloaded and written into the archive, so a restore never depends on the bucket, its credentials, or the storage type staying the same.

<div class="eigen-callout">

An archive holds every file, every mail, saved passwords, and any S3 keys the account uses. Treat it like a password. Downloads are admin-only. Keep any copy you take off the server encrypted, and delete it when you are done.

</div>

## How verification works

Eigen checks every archive after it is made, again whenever you click **Verify**, and once more at the start of every restore. Three checks run in order:

1. **Files**: every file in the archive has exactly the size and checksum recorded for it, and there is nothing extra.
2. **Databases**: each of Eigen's own databases passes an integrity check.
3. **Documents**: a sample of the largest documents is opened and decoded to confirm the content reads back.

Each archive shows one of three badges:

| Badge | Meaning |
|---|---|
| **Verified** | All three checks passed. You can restore from it. |
| **Failed** | A check failed. The archive is kept for reference, but the panel will not restore from it. |
| **Not verified** | The archive has not been checked yet. This is normal for one you copied onto the server by hand. |

Click **Verify** on any archive to run the checks again and update its badge.

## Limits

| Limit | Detail |
|---|---|
| Scheduling | None for one user or team. The nightly backup of the whole server holds every user and team. |
| Clean-up | None. Archives of one user or team and safety copies stay until you delete them. |
| Whole server | The panel backs up one user or team, not the whole server. |
| Concurrent jobs | One at a time per user or team. A second request is refused while one runs, and while the whole-server backup copies that user or team. |
| Restore target | An archive restores only to the same user or team it came from. |
| Upload size | About 1 GB through **Upload backup**. For a larger archive, copy the file into the backups folder by hand. |

## Whole-server backup

The panel covers one user or team at a time. The owner backs up the whole server in [Settings](/support/admin/server-settings#backups), every night or by hand, or with `./eigen backup` on the server. It runs while Eigen runs, holds the server's own databases and settings as well, is checked the same way, and can go to a backup bucket off the server. See [Back up and restore the whole server](/support/self-hosting/back-up-and-restore).

A whole-server backup holds an archive of every user and team. Copied into the backups folder, one lists in that user's or team's **Backup** section like any other archive. A copy out of a **Light** backup holds no files and no mail, and one out of a **Full** backup holds no files of a drive in an S3 bucket. Neither restores on its own: the row says why and offers no **Restore**.
