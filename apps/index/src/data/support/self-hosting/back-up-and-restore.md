---
title: "Back up and restore the whole server"
description: "Back up all of Eigen every night while it runs, keep a copy in a bucket of its own, know what a backup leaves out, and put one back with ./eigen restore."
type: how-to
category: Maintenance
tags: [self-hosting, backup, restore, s3, cron]
related: [self-hosting/move-to-another-server, self-hosting/update, admin/server-settings, admin/back-up-home, admin/backup-contents]
order: 90
updated: 2026-10-01
---

Eigen backs up the whole server while it runs: every account's mail, files, contacts, and calendars, the settings, the server databases, `.env.production`, the key that signs your mail, and the mail server's certificate. Nobody is signed out and nothing stops: only a rename or move on a drive, and the saves and uploads on that drive after it, can wait while the backup copies one very large file there. This page shows how to back up every night, how to keep a copy off the server, and what a backup leaves out. To put one back, go to [Put a backup back](#put-a-backup-back).

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

Each backup that verified goes to `<prefix>/<your web address>/` in the bucket, as soon as it is made. The bucket keeps the nightly backups by its own count, and always keeps the newest one that holds every user and team. Backups you make by hand stay in the bucket until you delete them there. The backup an update makes stays on the server.

Eigen never shows the secret key again. Leave the field empty to keep the saved one. When you change the endpoint, the bucket, or the access key, enter the secret again.

<div class="eigen-callout">

**Keep the bucket's details somewhere other than this server.** Write down the endpoint, the bucket name, and both keys. The only other copy is inside the backups, so a new machine can't reach them without you. Backups are not encrypted: keep the bucket private and its keys for this bucket alone.

</div>

## Back up now

In **Settings → Backups**, pick a level and click **Back up now**. Or, on the server, run this in the install folder:

```bash
./eigen backup
```

It prints each step, then the name and size of the backup. Pick what goes in:

| Level | Command | What it holds |
|---|---|---|
| **Full** | `./eigen backup` | Everything, except the files of drives stored in an S3 bucket. This is the default and what the nightly backup makes. |
| **Full + S3** | `./eigen backup --s3` | Everything, the files in S3 buckets too |
| **Light** | `./eigen backup --light` | The accounts, settings, and databases: no files and no mail |

`--wait` waits for a backup that is running to end, instead of refusing. `./eigen backup` exits with 0 when the backup verified, 1 when it failed, 2 on a wrong argument, and 4 when it verified but did not reach the bucket, so a script can tell them apart. For a backup every night, use [Back up every night](#back-up-every-night) rather than cron: Eigen keeps the newest of those and deletes the rest, but keeps every backup `./eigen backup` makes.

Backups land in `backups/` in the install folder, named `server-<why>-<level>-<date>-<time>.tar`, where `<why>` is `scheduled`, `manual`, or `pre-update`. Eigen checks that the folder has room before it starts. Backups you make by hand are never deleted by Eigen: delete them in **Settings → Backups** when you no longer need them. Treat a backup like `.env.production`: it holds everything.

With Eigen stopped there is nothing to run the backup, so `./eigen backup` refuses. A copy of `data/` and `.env.production` is a backup too.

## What a backup leaves out

- `caddy-data/`, the HTTPS certificates. Eigen gets them again by itself.
- A fresh mail server certificate. The backup holds the certificate it had, which is as fresh as the backup. Eigen's own web server hands the mail server a new one by itself. Behind your own web server, your certbot hook does at the next renewal, or run it once by hand: see [Mail certificates without Eigen's own web server](/support/self-hosting/behind-your-web-server#mail-certificates-without-eigens-own-web-server).
- Mail still waiting to go out. Docker keeps it in a volume of its own.
- The `backups/` folder itself.
- `docker-compose.override.yml`, if you made one.
- A way into the backup bucket. Its keys are inside the backups, which are in that bucket, so keep a copy of them yourself.
- Guests' workspaces. After a restore of a Full backup, a guest keeps their account and starts with an empty workspace. A restore of a Light backup leaves guests' workspaces as they are.
- A user or team folder that no account owns. The backup's record in `backups/`, the file with its name and `.json` at the end, lists it under `orphans`. After a restore of a Full backup it is only in `data.pre-restore-<date>-<time>`.

## Drives in an S3 bucket

A Full backup holds the list of a drive's files in an S3 bucket, and the changes that were still on their way to the bucket, but not the files the bucket already has. The bucket keeps those, and with versioning it keeps their history too: turn it on as in [Make an S3 bucket safe for Eigen](/support/admin/s3-bucket-safety).

A restore of a Full backup leaves the bucket as it is, so a file changed since shows its new content. It uploads the changes that were on their way, unless this server had already uploaded, replaced, or deleted that file, and `./eigen restore` says how many it left out.

A Full + S3 backup holds every file of those drives as well. `./eigen restore <backup> --s3-from-archive` uploads them into the bucket as new files, for a bucket that was damaged or lost.

## Put a backup back

In the install folder, name a backup in `backups/`, or give the path of one:

```bash
./eigen restore server-scheduled-full-<date>-<time>.tar
```

`./eigen restore` then does three things:

1. It checks the backup while Eigen keeps running. It shows what the backup holds, like its level, its date, and any user or team that is not in it, and asks whether to go on. For a Light backup it also says what happens to the files changed since. Then it unpacks it, still while Eigen runs.
2. It stops Eigen, moves the current `data/` and `.env.production` aside as `data.pre-restore-<date>-<time>` and `.env.production.pre-restore-<date>-<time>`, and puts the backup in their place.
3. It starts Eigen again, on the version that made the backup.

Check that all is well, then delete what was kept aside:

```bash
sudo rm -rf data.pre-restore-<date>-<time> .env.production.pre-restore-<date>-<time>
```

The question also says whether the backup holds `.env.production`, the key that signs your mail, and the mail server's certificate. A backup made in the ten minutes after that certificate was renewed can miss it, and one of a server without hosted mail has neither. What a backup does not hold, the restore keeps as the server has it.

A user or team that failed during the backup is not in it, and the question names them. After a restore of a Full backup, their data is in `data.pre-restore-<date>-<time>` only.

Everyone is signed in as they were when the backup was made. Every open browser tab reloads once. After a restore, everything in the Trash stays there for the full **Trash Retention (days)** period, counted from the restore. `--yes` skips the question, for scripts.

Restore refuses a backup of a newer Eigen than the one you run: update first, then restore. `data/` must be a plain folder inside the install folder, on the same disk, with room to unpack the backup. Restore checks this before it stops Eigen. If a restore is cut off while it swaps the data in, Eigen stays stopped and `./eigen` says so. `./eigen restart` finishes the restore and starts Eigen. Any other `./eigen` command except `logs`, `reset-password`, and `help` finishes it too, before it does anything else.

To restore on a new machine, see [Move Eigen to another server](/support/self-hosting/move-to-another-server).

### A Light backup leaves the files where they are

A Light backup holds no files and no mail. Its restore puts back the accounts, the settings, `.env.production`, and every database. The files and the mail stay on disk as they are now, but Drive lists only what it held at the time of the backup:

- Files and documents made since the backup no longer show in Drive. Their content stays on disk.
- On drives that store files by their names, the default **Local (Full names)**, a file renamed, moved, or put in the Trash since shows at its old place and does not open. Its content is under the new name, or in the trash folder.
- A file deleted for good since comes back without its content.
- Calendars and contacts go back to the time of the backup.
- Mail stays as it is now.

Nothing is deleted from disk, and what the restore replaced is in `data.pre-restore-<date>-<time>`. A rollback after a usual update is a Light restore: see [Update Eigen](/support/self-hosting/update#go-back-with-a-rollback).

## Try a restore without moving

To find out whether your backups work, restore one on a second machine while your server keeps running. The test server is a copy of yours, so it also has:

- Your web address and mail domain, from `.env.production`.
- Every drive in an S3 bucket, with that bucket and its keys.
- The nightly backup with its time, and the backup bucket with its folder `<prefix>/<your web address>/`.

So do not leave it running. Five minutes after it starts, and every five minutes after that, it checks whether today's nightly backup is due. Once the time you set has passed today (UTC), it makes one, uploads it to the same folder as your server, and deletes the oldest nightly backups there by the same count, your server's too.

**Do not sign in to the test server when a user or team keeps a drive in an S3 bucket**, not even through a hosts-file entry. The test server opens their workspace at their sign-in, or for a nightly backup. It then puts the changes that were on their way when the backup was made into that bucket, over what your server wrote since, and whatever changes in that drive changes the bucket.

To try a restore safely:

1. Restore the backup on the second machine as in steps 2 and 3 of [Move Eigen to another server](/support/self-hosting/move-to-another-server). Skip opening ports on the second machine: the test needs none. Leave your server and your domain as they are.
2. As soon as the restore says Eigen is running, stop it:

   ```bash
   ./eigen stop
   ```

3. Read what the restore printed: how many users and teams the backup holds, any that are not in the backup, and whether it held `.env.production`, the key that signs your mail, and the mail server's certificate. Before it put anything in place, the restore checked every file and database of the backup, so a restore that got this far has a backup that works.
4. Delete the second machine, or its install folder. Do not start Eigen on it again.

Your web address still points at your server, so a browser opens that one, not the test. The test needs no sign-in: what the restore printed is the result. When no user or team keeps a drive in an S3 bucket, signing in to the test server before step 2 is safe too, as long as you stop it within five minutes of its start, before its first nightly check.

## Restore one user or team from a server backup

Each server backup holds a backup of every user and team, under `homes/`. Copy one out into `backups/`, and an admin can restore that user or team in Admin:

```bash
cd /opt/eigen
tar -tf backups/server-scheduled-full-<date>-<time>.tar | grep homes/
sudo sh -c 'tar -xOf backups/server-scheduled-full-<date>-<time>.tar homes/home-<id>-<date>-<time>.tar.zst > backups/home-<id>-<date>-<time>.tar.zst'
sudo chown 1000:1000 backups/home-<id>-<date>-<time>.tar.zst
```

It shows up under **Backup** on that user's or team's page, as **Not verified**, and offers **Restore** once an admin clicks **Verify**. See [Restore a user or team](/support/admin/restore-home). The one out of a Light backup holds no files, and the one out of a Full backup of someone with a drive in an S3 bucket holds no files of that drive, so neither restores on its own. The row says why.

## Back up one user or team

An admin can also back up and restore one user or one team in Admin, with every file included. See [Back up a user or team](/support/admin/back-up-home).
