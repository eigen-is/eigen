---
title: "Back up and restore the whole server"
description: "Save all of Eigen as one snapshot with ./eigen backup, run it every night, know what a snapshot leaves out, and put one back with ./eigen restore."
type: how-to
category: Maintenance
tags: [self-hosting, backup, restore, snapshot, cron]
related: [self-hosting/move-to-another-server, self-hosting/update, admin/back-up-home, admin/backup-contents]
order: 90
updated: 2026-09-30
---

Eigen does not back itself up. One command saves the whole server as a snapshot: every account's mail, files, contacts, and calendars, the settings, the server databases, and `.env.production`. This page shows how to make one, what it leaves out, and how to put one back.

## Make a snapshot

In the install folder, run:

```bash
./eigen backup
```

Eigen checks that the snapshot fits on the disk, stops, saves `snapshots/eigen-<time>.tar.gz`, and starts again. It is down for as long as that takes, so the snapshot is consistent. Then it deletes all but the newest three snapshots of that kind. `--keep 7` keeps seven. The snapshots an update saves do not count.

`./eigen backup --light` saves a light snapshot, `snapshots/eigen-light-<time>.tar.gz`: the databases, the settings, and `.env.production`, without the files and the mail. Light ones never push out your last full one.

Only the owner of the install folder can read a snapshot. Treat one like `.env.production`: it holds everything.

## Run it every night

Add a line to the crontab of the user that owns the install:

```bash
crontab -e
# 0 3 * * * /opt/eigen/eigen backup
```

A snapshot on the same disk does not survive the loss of that disk. Copy snapshots off the server, with the tool you already use for that.

## What a snapshot leaves out

- The HTTPS certificates. Eigen gets them again by itself.
- Mail still waiting to go out.
- The `backups/` folder, with the backups of single users and teams.
- `docker-compose.override.yml`, if you made one.
- The files of drives stored in an S3 bucket.

A drive in an S3 bucket keeps its files in the bucket, and a snapshot holds only the list of them. A restore brings that list back and leaves the bucket as it is, so a file changed since shows its new content. A full snapshot does hold the changes that were still on their way to the bucket. A restore uploads each of them, unless the server it replaces had already uploaded, replaced, or deleted that file, and `./eigen restore` says how many it left out. Turn on versioning for the bucket, as in [Make an S3 bucket safe for Eigen](/support/admin/s3-bucket-safety), and use a backup of the user or team when you need a copy with the files in it.

## Put a snapshot back

```bash
./eigen restore eigen-<time>.tar.gz
```

1. Eigen unpacks and checks the snapshot while it keeps running, and asks whether to go on.
2. It stops, moves the current `data/` and `.env.production` aside as `data.pre-restore-<time>` and `.env.production.pre-restore-<time>`, and puts the snapshot in their place.
3. It starts again. Check that all is well, then delete what was kept aside.

A light snapshot puts back only the databases, the settings, and `.env.production`, and leaves files and mail as they are.

A snapshot knows which version of Eigen made it. Restoring one of another version brings that version back too. Restore refuses a snapshot of a newer Eigen than the one you run: update first, then restore. `data/` must be a plain folder inside the install folder, not a link or another disk.

After a restore, everything in the Trash stays there for the full **Trash Retention (days)** period, counted from the restore. `./eigen restore <snapshot> --yes` skips the question, for scripts.

## Back up one user or team

An admin can back up and restore one user or one team from the Admin pages, without stopping the server. Those backups land in `backups/` in the install folder. See [Back up a user or team](/support/admin/back-up-home). They do not hold the server's own databases, settings, or `.env.production`, so they do not replace `./eigen backup`.
