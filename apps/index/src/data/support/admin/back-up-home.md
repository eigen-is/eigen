---
title: "Back up a user or team"
description: "Create a verified backup of one user or one team in Admin, then download, verify, or upload an archive."
type: how-to
category: Backups
tags: [admin, backup, restore, server]
related: [admin/restore-home, admin/backup-contents]
order: 90
updated: 2026-10-01
---

You can make a backup of a single user or a single team in Admin. The backup is one archive file that holds everything in that account: files, mail, documents, and settings. It covers one user or one team at a time, not the whole server.

Only admins can do this. The **Backup** section lives inside a user's or a team's detail panel, so you start by opening the account you want to back up.

## Create a backup

1. Go to [Admin](/admin).
2. Open **Users** and pick a user, or open **Teams** and pick a team. Their detail panel opens on the right.
3. Scroll to the **Backup** section.
4. Click **Create backup**.

The backup runs in the background, so you can keep working. While it runs, the section shows **Creating backup** with the current step and its progress. When it finishes, you see **Backup created** with the name of the new archive, and the archive appears in the list below.

Only a rename or move on a drive, and the saves and uploads on that drive after it, can wait while the backup copies one very large file there.

A file Eigen has on record that is gone from its disk or bucket, for example because someone deleted it outside Eigen, does not stop the backup. The archive keeps its entry without the file, and the archive's row names it in a warning. The same goes for a document whose data is gone. Items whose folder is gone from the drive's records are left out, and named the same way. An archive with warnings still restores: the account comes back as it is now, without those files. The backup stops only when none of a drive's files can be read from its disk or bucket, even if someone has a document open, because then the disk or bucket is out of reach: the section shows **Creating backup failed**. An empty file, or one deleted while the backup runs, is left out without a warning.

Each archive is one file named `home-<id>-<date>-<time>.tar.zst`. Its row shows the date and size, and a badge:

- **Verified**: the archive passed every check and is ready to restore.
- **Not verified**: the archive has not been checked yet.
- **Failed**: a check found a problem. The row lists what went wrong and keeps the file, but offers no restore, so make a fresh backup.

<div class="eigen-callout">

A backup file holds everything in that account, including the stored storage credentials. Treat it as a secret: keep it somewhere safe, and delete any copy you make once you are done with it.

</div>

Only one backup or restore can run per user or per team at a time. If a job is already running, **Create backup** stays disabled until it finishes. While a backup of the whole server copies this user or team, a new job is refused for that moment too.

## Download an archive

Hover over an archive row and click **Download**. The file downloads to your computer. Keep it encrypted and somewhere safe, since it holds all of that account's data.

## Verify an archive

Every backup is checked once when it is created. To check an existing archive again, hover over its row and click **Verify**. This is useful for an archive you uploaded from another machine, which arrives unchecked.

For what verification looks at, see [What a backup contains](/support/admin/backup-contents).

## Upload an archive

If you have a backup file from another machine, you can bring it back in.

1. In the **Backup** section, click **Upload backup**.
2. Choose the archive file.

The file can be at most about 1 GB, and its name must match the pattern this server uses for that user or team. A file that arrives this way lists as **Not verified**, so click **Verify** afterwards.

For a file larger than 1 GB, whoever runs the server copies it into `backups/` in the install folder and gives it to user 1000 (`sudo chown 1000:1000 backups/<file>`). It appears in the list, and its row says **Verify first**: click **Verify** before you restore from it.

A backup of the whole server holds an archive of every user and team too. Whoever runs the server can copy one out into the backups folder: see [Restore one user or team from a server backup](/support/self-hosting/back-up-and-restore#restore-one-user-or-team-from-a-server-backup).

## Delete an archive

Hover over an archive row and click **Delete**, then confirm. This removes the file for good. If a user or team has no archives, the section shows **No backups yet**.

To put an account back from an archive, see [Restore a user or team](/support/admin/restore-home).
