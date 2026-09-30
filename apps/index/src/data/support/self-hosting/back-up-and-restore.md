---
title: "Back up and restore the whole server"
description: "Back up all of Eigen every night while it runs, keep a copy in a bucket of its own, know what a backup leaves out, and put one back with ./eigen restore."
type: how-to
category: Maintenance
tags: [self-hosting, backup, restore, s3, cron]
related: [self-hosting/move-to-another-server, self-hosting/update, admin/server-settings, admin/back-up-home, admin/backup-contents]
order: 90
updated: 2026-09-30
---

Eigen backs up the whole server while it runs: every account's mail, files, contacts, and calendars, the settings, the server databases, `.env.production`, and the key that signs your mail. Nobody is signed out and nothing stops. This page shows how to back up every night, how to keep a copy off the server, what a backup leaves out, and how to put one back.

## Back up every night

The owner turns this on in Eigen itself:

1. Sign in as the owner, open [Admin](/admin), and click **Settings**.
2. In the **Backups** section, turn on **Back up every night**.
3. Pick the **Time**. The list shows your own time with UTC beside it.
4. Set **Nightly backups to keep**. The default is 7.
5. Click **Save** at the bottom of the page.

Each night Eigen makes a Full backup, checks it, and deletes the oldest nightly ones past the number you keep. A night that failed never pushes out the last good backup. If you turn the schedule on after today's time has passed, the first backup starts within a few minutes.

When a user or team keeps files in an S3 bucket, **Include files in S3 buckets** appears too. See [Drives in an S3 bucket](#drives-in-an-s3-bucket).

A backup that fails, or a copy that does not reach the bucket, sends the owner a notification. `./eigen status` shows it too.

## Keep a copy off the server

A backup on the same disk does not survive the loss of that disk. Eigen can send every backup to an S3 bucket:

1. In **Settings → Backups**, turn on **Upload to a backup bucket**.
2. Fill in the **Endpoint**, **Bucket**, **Access Key ID**, and **Secret Access Key** of a bucket you made for this alone. **Prefix** and **Region** are optional.
3. Click **Test Connection**.
4. Set **Backups to keep in the bucket**. The default is 30.
5. Click **Save**.

Eigen refuses a bucket that holds Eigen's own files, and an access key that opens one, so one lost bucket or key cannot take your data and your backups together. It also refuses a bucket that anyone can read. When the bucket has no rule that cleans up an upload that was cut off halfway, the test warns you: add a lifecycle rule that aborts incomplete multipart uploads after 1 day.

Each backup that checks out goes to `<prefix>/<your web address>/` in the bucket, as soon as it is made. The bucket keeps the nightly backups by its own count, and always keeps the newest one that holds every user and team. Backups you make by hand stay in the bucket until you delete them there. The backup an update makes stays on the server.

Eigen never shows the secret key again. Leave the field empty to keep the saved one. When you change the endpoint, the bucket, or the access key, enter the secret again.

<div class="eigen-callout">

**Keep the bucket's details somewhere other than this server.** Write down the endpoint, the bucket name, and both keys. The only other copy is inside the backups, so a new machine can't reach them without you. Backups are not encrypted: keep the bucket private and its keys for this bucket alone.

</div>

## Back up now

In **Settings → Backups**, pick a level next to **Back up now** and click it. On the server, run this in the install folder:

```bash
./eigen backup
```

It prints each step, then the name and size of the backup. Pick what goes in:

| Level | Command | What it holds |
|---|---|---|
| **Full** | `./eigen backup` | Everything, except the files of drives stored in an S3 bucket. This is the default and what the nightly backup makes. |
| **Full + S3** | `./eigen backup --s3` | Everything, the files in S3 buckets too |
| **Light** | `./eigen backup --light` | The accounts, settings, and databases: no files and no mail |

`--wait` waits for a backup that is running to end, instead of refusing. `./eigen backup` exits with 0 when the backup checked out, 1 when it failed, 2 on a wrong argument, and 4 when it checked out but did not reach the bucket, so a cron job can tell them apart.

Backups land in `backups/` in the install folder, named `server-<why>-<level>-<date>-<time>.tar`. Eigen checks that the folder has room before it starts. Backups you make by hand are never deleted by Eigen: delete them in **Settings → Backups** when you no longer need them. Treat a backup like `.env.production`: it holds everything.

With Eigen stopped there is nothing to run the backup, so `./eigen backup` refuses. A copy of `data/` and `.env.production` is a backup too.

## What a backup leaves out

- `caddy-data/`, the HTTPS certificates. Eigen gets them again by itself.
- `data/certs/`, the mail server's certificate. Eigen's own web server puts it back. Behind your own web server, run your certificate hook again.
- Mail still waiting to go out. Docker keeps it in a volume of its own.
- The `backups/` folder itself.
- `docker-compose.override.yml`, if you made one.
- The keys of the backup bucket. Keep those yourself.

## Drives in an S3 bucket

A Full backup holds the list of a drive's files in an S3 bucket, and the changes that were still on their way to the bucket, but not the files the bucket already has. The bucket keeps those, and with versioning it keeps their history too: turn it on as in [Make an S3 bucket safe for Eigen](/support/admin/s3-bucket-safety).

A restore of a Full backup leaves the bucket as it is, so a file changed since shows its new content. It uploads the changes that were on their way, unless this server had already uploaded, replaced, or deleted that file, and `./eigen restore` says how many it left out.

A Full + S3 backup holds every file of those drives as well. `./eigen restore <backup> --s3-from-archive` uploads them into the bucket as new files, for a bucket that was damaged or lost.

## Put a backup back

In the install folder, name a backup in `backups/`, or give the path of one:

```bash
./eigen restore server-scheduled-full-<date>-<time>.tar
```

1. Eigen unpacks and checks the backup while it keeps running. It shows what the backup holds, like its level, its date, and any user or team that is not in it, and asks whether to go on.
2. It stops, moves the current `data/` and `.env.production` aside as `data.pre-restore-<time>` and `.env.production.pre-restore-<time>`, and puts the backup in their place.
3. It starts again, on the version of Eigen that made the backup. Check that all is well, then delete what was kept aside.

A Light backup puts back the databases, the settings, and `.env.production`, and leaves files and mail as they are. What it replaces goes aside in `data.pre-restore-<time>`.

A user or team that failed during the backup is not in it, and the question names them. After a restore of a Full backup, their data is in `data.pre-restore-<time>` only.

Everyone is signed in as they were when the backup was made. Every open browser tab reloads once. After a restore, everything in the Trash stays there for the full **Trash Retention (days)** period, counted from the restore. `--yes` skips the question, for scripts.

Restore refuses a backup of a newer Eigen than the one you run: update first, then restore. `data/` must be a plain folder inside the install folder, on the same disk, with room to unpack the backup. If a restore is cut off, the next `./eigen` command finishes it before it does anything else.

To restore on a new machine, see [Move Eigen to another server](/support/self-hosting/move-to-another-server).

## Restore one user or team from a server backup

Each server backup holds a backup of every user and team, under `homes/`. Copy one out into `backups/`, and an admin can restore that user or team from the Admin pages:

```bash
cd /opt/eigen
tar -tf backups/server-scheduled-full-<date>-<time>.tar | grep homes/
tar -xOf backups/server-scheduled-full-<date>-<time>.tar homes/home-<id>-<date>-<time>.tar.zst > backups/home-<id>-<date>-<time>.tar.zst
sudo chown 1000:1000 backups/home-<id>-<date>-<time>.tar.zst
```

It shows up under **Backup** on that user's or team's page, as **Not verified**. See [Restore a user or team](/support/admin/restore-home). A Light backup's copy holds no files, and a Full backup's copy of someone with a drive in an S3 bucket holds no files of that drive, so neither restores on its own. The row says why.

## Back up one user or team

An admin can also back up and restore one user or one team from the Admin pages, with every file included. See [Back up a user or team](/support/admin/back-up-home).
