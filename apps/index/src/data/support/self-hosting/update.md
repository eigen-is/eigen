---
title: "Update Eigen"
description: "Install a new release with one command, know what a breaking release means for your data before 1.0, and go back with a rollback."
type: how-to
category: Maintenance
tags: [self-hosting, update, rollback, release, breaking]
related: [self-hosting/back-up-and-restore, self-hosting/commands-and-files]
order: 80
updated: 2026-11-02
---

An update is one command, and so is going back. Eigen backs itself up before every update, so you can go back to the version you had.

## Update to the newest release

In the install folder, run:

```bash
./eigen update
```

1. Eigen downloads the new release while it keeps running.
2. When the release notes list breaking changes, it shows them and asks whether to go on. Without a terminal, like from cron, it refuses until you run `./eigen update --accept-breaking`.
3. It tells everyone who has Eigen open that it is about to restart. With `--in`, it warns them first and waits: see [Warn everyone first](#warn-everyone-first).
4. While Eigen keeps running, it makes a backup in `backups/`. When a backup is already running, it waits for that one to end. If the backup fails, the update stops there and Eigen runs on as it was.
5. Eigen stops, switches to the new version, and starts again.

Eigen is down only for the switch. Meanwhile the open tabs say that Eigen is updating. When it is back, every open browser tab reloads by itself onto the new version. Anything a tab had not saved yet is lost, such as text typed while Eigen was down or a comment not yet sent. What people change between the end of the backup and the stop is not in the backup, so the update prints the time the backup ends. When it is done, it removes older images. It keeps the images of the version before, so `./eigen rollback` can go back to it.

To see whether there is an update, and what it brings, without installing it: `./eigen update --check`. To install a specific release: `./eigen update 0.3.1`.

## Warn everyone first

To give people time to save their work, warn them and wait before the restart:

```bash
./eigen update --in 10m "Back at three"
```

Every open Eigen page shows a banner at its foot, like the message `shutdown` sends to every terminal: "Eigen restarts for an update in 10 minutes", with your message below it. It counts down in minutes, and in seconds in the last minute. The terminal counts down too.

The time needs its unit: `90s`, `10m`, or `1h`, the longest wait. The message is optional, up to 200 characters, and comes right after the time. A version goes before `--in`: `./eigen update 0.3.2 --in 10m`.

The wait comes after the download and the question about breaking changes, and before the backup. Ctrl+C cancels it, and so does a lost SSH session, so run a long wait in tmux or screen. When you cancel, or the update fails, the banner goes away and Eigen runs on as it was.

`./eigen rollback --in 10m` and `./eigen restore <backup> --in 10m` warn the same way, right before Eigen stops.

## The backup an update makes

The backup is a Full one: the accounts, settings, databases, files, and mail. Some releases convert how Eigen stores part of its data, and the version before cannot read the converted data. A Full backup can bring it back either way.

It is named `server-pre-update-<level>-<date>-<time>.tar`. Eigen keeps the two newest good ones, and always the one the last update made. They stay on the server: they are not sent to your backup bucket. They do not replace your nightly backups: see [Back up and restore the whole server](/support/self-hosting/back-up-and-restore).

The backup runs on the running server, so with Eigen stopped `./eigen update` refuses. Start Eigen with `./eigen restart`, or copy `data/` and `.env.production` somewhere safe and run `./eigen update --no-backup`. Without a backup, `./eigen rollback` has nothing to go back to.

On 0.3.2 and later, it refuses too when you edited `.env.production` since Eigen started and Eigen still reads the file as it was. Run `./eigen restart`, then `./eigen update` again.

## Go back with a rollback

```bash
./eigen rollback
```

This goes back to the version before the last update. First it tries to keep your data as it is now.

Most updates do not change how your data is stored. While Eigen keeps running, the version before checks that it can open all of the data, and asks whether to go on. Then the rollback stops Eigen, switches back to the version before, and starts Eigen. Files, documents, mail, calendars, and contacts stay as users left them. The backup stays in `backups/`.

When the version before cannot open the data, or is too old to check, the rollback puts back the backup the update made instead, the way [`./eigen restore`](/support/self-hosting/back-up-and-restore#put-a-backup-back) does, with the version that backup names, and starts Eigen. Everything comes back as it was before the update, files and mail included. What people changed since is lost. The data it replaces is kept aside, not deleted. Every open browser tab reloads once. It asks first. Like a restore, it needs `data/` as a plain folder inside the install folder, on the same disk, with room to unpack the backup.

When the check itself stops before it can tell, for example because the server ran out of memory, the rollback stops too, and Eigen keeps running on your data as it is. Fix what it says, then run `./eigen rollback` again.

An update made by Eigen 0.4.1 or before may have made a Light backup, without files and mail. `./eigen rollback` cannot go back from one: it names the backup and stops. To go back, put back a Full backup with `./eigen restore <file>`.

`./eigen rollback --yes` skips the questions, for scripts. A rollback goes back one update, not further. To go back further, `./eigen rollback --help` lists the backups earlier updates made that Eigen kept, and `./eigen restore <file>` puts one of them back.

### After the update from 0.3.0

An install on 0.3.0 updates to 0.3.1 first: run `./eigen update 0.3.1`, then `./eigen update`.

Close every open document before you update from 0.3.0. When Eigen comes back, an open document reloads, and every edit it had not sent to the server is lost, edits made while it was offline included. A Drive, Mail, Calendar, or Contacts tab opened on 0.3.0 does not reload by itself: it keeps the page it had until you reload it.

After the update, two files of 0.3.0 may be left over: `data/server/collab-epoch` and `data/server/collab-home-epochs.json`. Eigen does not read them, so you can delete them.

Does cron run `./eigen backup` for you? Check its line. The `--keep` option of 0.3.0 is gone: with it, `./eigen backup` stops with exit 2 and makes no backup. A stop before the backup has to go too, since the backup needs Eigen running. Backups made with `./eigen backup` stay until you delete them. To have Eigen keep a set number, turn on the nightly backup in **Settings → Backups** instead: it is off until the owner turns it on. See [Back up every night](/support/self-hosting/back-up-and-restore#back-up-every-night).

## What 1.0 means for your data

Eigen is not 1.0 yet. Until then, a release can change how Eigen stores something, and it does not keep the old way working. It converts what you have once, or that data does not open after the update. Stickies boards are the exception: they keep working across releases.

A release like that marks the change as breaking in its notes. `./eigen update` shows you the notes, asks before it goes on, and makes a Full backup first, so `./eigen rollback` can bring everything back. Read the notes before you say yes.
