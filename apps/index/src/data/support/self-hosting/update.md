---
title: "Update Eigen"
description: "Install a new release with one command, know what a breaking release means for your data before 1.0, and go back with a rollback."
type: how-to
category: Maintenance
tags: [self-hosting, update, rollback, release, breaking]
related: [self-hosting/back-up-and-restore, self-hosting/commands-and-files]
order: 80
updated: 2026-10-01
---

An update is one command, and so is going back. Eigen backs itself up before every update, so a rollback puts back the old version with the accounts, settings, and databases it had.

## Update to the newest release

In the install folder, run:

```bash
./eigen update
```

1. Eigen downloads the new release while it keeps running.
2. When the release notes list breaking changes, it shows them and asks whether to go on. Without a terminal, like from cron, it refuses until you run `./eigen update --accept-breaking`.
3. While Eigen keeps running, it makes a backup in `backups/`. When a backup is already running, it waits for that one to end. If the backup fails, the update stops there and Eigen runs on as it was.
4. Eigen stops, switches to the new version, and starts again.

Eigen is down only for the switch. Open browser tabs reconnect by themselves. What people change between the end of the backup and the stop is not in the backup, so the update prints the time the backup ends. When it is done, it removes older images. It keeps the images of the version before, so `./eigen rollback` can go back to it.

To see whether there is an update, and what it brings, without installing it: `./eigen update --check`. To install a specific release: `./eigen update 0.3.1`.

## The backup an update makes

Usually the backup is a Light one: the accounts, settings, and databases, without the files and the mail. It is a Full one, files and mail included, when a release since yours marks a change as breaking, or when you run `./eigen update --full`.

It is named `server-pre-update-<level>-<date>-<time>.tar`. Eigen keeps the two newest good ones, and always the one `./eigen rollback` would restore. They stay on the server: they are not sent to your backup bucket. They do not replace your nightly backups: see [Back up and restore the whole server](/support/self-hosting/back-up-and-restore).

The backup runs on the running server, so with Eigen stopped `./eigen update` refuses. Start Eigen with `./eigen restart`, or copy `data/` and `.env.production` somewhere safe and run `./eigen update --no-backup`. Without a backup, `./eigen rollback` has nothing to go back to.

## Go back with a rollback

```bash
./eigen rollback
```

This goes back to the version before the last update. It puts back the backup the update made, the way [`./eigen restore`](/support/self-hosting/back-up-and-restore#put-a-backup-back) does, with the version that backup names, and starts Eigen. The data it replaces is kept aside, not deleted. Every open browser tab reloads once. It asks first: `./eigen rollback --yes` skips the question, for scripts. Like a restore, it needs `data/` as a plain folder inside the install folder, on the same disk, with room to unpack the backup.

After a Full backup, a rollback puts back everything, files and mail included. A rollback goes back one update, not further.

After a Light backup, the usual kind, a rollback puts back the accounts, settings, databases, and `.env.production`. The files and the mail stay on disk as they are now, but Drive lists only what it held before the update. Files and documents made since no longer show in Drive, and on drives that store files by their names, files renamed, moved, or put in the Trash since do not open. Calendars and contacts go back to before the update, and mail stays as it is. Nothing is deleted from disk. See [A Light backup leaves the files where they are](/support/self-hosting/back-up-and-restore#a-light-backup-leaves-the-files-where-they-are). To be able to go back with the files too, update with `./eigen update --full`.

### After the update from 0.3.0

Close every open document before you update from 0.3.0. When Eigen comes back, an open document reloads, and every edit it had not sent to the server is lost, edits made while it was offline included. A Drive, Mail, Calendar, or Contacts tab opened on 0.3.0 does not reload by itself: it keeps the page it had until you reload it.

After the update, two files of 0.3.0 may be left over: `data/server/collab-epoch` and `data/server/collab-home-epochs.json`. Eigen does not read them, so you can delete them.

Does cron run `./eigen backup` for you? Check its line. The `--keep` option of 0.3.0 is gone: with it, `./eigen backup` stops with exit 2 and makes no backup. A stop before the backup has to go too, since the backup needs Eigen running. Backups made with `./eigen backup` stay until you delete them. To have Eigen keep a set number, turn on the nightly backup in **Settings → Backups** instead: it is off until the owner turns it on. See [Back up every night](/support/self-hosting/back-up-and-restore#back-up-every-night).

Eigen 0.3.0 made its own kind of backup, a snapshot in `snapshots/`, and the update from 0.3.0 saves one the same way, with Eigen stopped. Only Eigen 0.3.0 can put it back. `./eigen rollback` then prints three commands instead: the first brings back the `eigen` command of 0.3.0, the second restores the snapshot with it, and the third clears what the newer version noted.

## What 1.0 means for your data

Eigen is not 1.0 yet. Until then, a release can change how Eigen stores something, and it does not keep the old way working. It converts what you have once, or that data does not open after the update. Stickies boards are the exception: they keep working across releases.

A release like that marks the change as breaking in its notes. `./eigen update` shows you the notes, asks before it goes on, and makes a Full backup first, so `./eigen rollback` can bring everything back. Read the notes before you say yes.

## Follow the newest code

`./eigen update main` puts an install on the main channel. Every change to Eigen's code builds a new version there. `./eigen update` then installs the newest build, and `./eigen status` names it, like `0.3.0 (abc1234) on main`. While a build is still being published, `./eigen update` says so. Run it again a few minutes later.

Release notes and the breaking question only come with a new version number, so on the main channel a breaking change can arrive without warning. The channel is for people who work on Eigen. `./eigen update <version>` takes you back to releases.
