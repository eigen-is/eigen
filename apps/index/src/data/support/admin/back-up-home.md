---
title: "Back up a user or team"
description: "Create a verified backup of one user or one team from the admin panel, then download, verify, or upload an archive."
type: how-to
category: Backups
tags: [admin, backup, restore, server]
related: [admin/restore-home, admin/backup-contents]
order: 90
updated: 2026-09-11
---

You can make a backup of a single user or a single team from the admin panel. The backup is one archive file that holds everything in that account: files, mail, documents, and settings. It covers one user or one team at a time, not the whole server.

Only admins can do this. The **Backup** section lives inside a user's or a team's detail pane, so you start by opening the account you want to back up.

## Create a backup

1. Go to [Admin](/admin).
2. Open **Users** and pick a user, or open **Teams** and pick a team. Their detail pane opens on the right.
3. Scroll to the **Backup** section.
4. Click **Create backup**.

The backup runs in the background, so you can keep working. The section shows its progress while it runs: first **Creating backup**, then **Verifying archive**, each with the current step and a progress bar. When it finishes, you see **Backup created** with the name of the new archive, and the archive appears in the list below.

Each archive is one file named `home-<id>-<date>.tar.zst`. Its row shows the date and size, and a badge:

- **Verified**: the archive passed every check and is ready to restore.
- **Not verified**: the archive has not been checked yet.
- **Failed**: a check found a problem. The row lists what went wrong and keeps the file, but offers no restore, so make a fresh backup.

<div class="eigen-callout">

A backup file holds everything in that account, including the stored storage credentials. Treat it as a secret: keep it somewhere safe, and delete any copy you make once you are done with it.

</div>

Only one backup or restore can run per user or per team at a time. If a job is already running, **Create backup** stays disabled until it finishes.

## Download an archive

Hover over an archive row and click **Download**. The file downloads to your computer. Keep it encrypted and somewhere safe, since it holds all of that account's data.

## Verify an archive

Every backup is checked once when it is created. To check an existing archive again, hover over its row and click **Verify**. This is useful for an archive you uploaded from another machine, which arrives unchecked.

For what verification looks at, see [What a backup contains](/support/admin/backup-contents).

## Upload an archive

If you have a backup file from another machine, you can bring it back in.

1. In the **Backup** section, click **Upload backup**.
2. Choose the archive file.

The file must be up to about 1 GB, and its name must match the pattern this server uses for that user or team. A file that arrives this way lists as **Not verified**, so click **Verify** afterwards.

For a file larger than 1 GB, copy it into the server's backups folder by hand instead. That folder is set by `EIGEN_BACKUPS_DIR`, or it is a `backups` folder next to the data directory if that variable is not set. The archive appears in the list once it is in place.

## Delete an archive

Hover over an archive row and click **Delete**, then confirm. This removes the file for good. If a user or team has no archives, the section shows **No backups yet**.

To put an account back from an archive, see [Restore a user or team](/support/admin/restore-home).
