---
title: "Update Eigen"
description: "Install a new release with one command, know what a breaking release means for your data before 1.0, and go back with a rollback."
type: how-to
category: Maintenance
tags: [self-hosting, update, rollback, release, breaking]
related: [self-hosting/back-up-and-restore, self-hosting/commands-and-files]
order: 80
updated: 2026-09-30
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

It is named `server-pre-update-<level>-<date>-<time>.tar`. Eigen keeps the two newest of these, and they stay on the server: they are not sent to your backup bucket. They do not replace your nightly backups: see [Back up and restore the whole server](/support/self-hosting/back-up-and-restore).

The backup runs on the running server, so with Eigen stopped `./eigen update` refuses. Start Eigen with `./eigen restart`, or copy `data/` and `.env.production` somewhere safe and run `./eigen update --no-backup`. Without a backup, `./eigen rollback` has nothing to go back to.

## Go back with a rollback

```bash
./eigen rollback
```

This goes back to the version before the last update. It puts back the backup the update made, the way [`./eigen restore`](/support/self-hosting/back-up-and-restore#put-a-backup-back) does, with the version that backup names, and starts Eigen. The data it replaces is kept aside, not deleted. Every open browser tab reloads once. It asks first: `./eigen rollback --yes` skips the question, for scripts.

After a Light backup, the usual kind, a rollback puts back only the accounts, settings, databases, and `.env.production`. Files and mail added since the update stay. After a Full backup, it puts back the files and mail too. A rollback goes back one update, not further.

### After the update from 0.3.0

Eigen 0.3.0 made its own kind of backup, a snapshot in `snapshots/`, and the update from 0.3.0 saves one the same way, with Eigen stopped. Only Eigen 0.3.0 can put it back. `./eigen rollback` then prints three commands instead: the first brings back the `eigen` command of 0.3.0, the second restores the snapshot with it, and the third clears what the newer version noted.

## What 1.0 means for your data

Eigen is not 1.0 yet. Until then, a release can change how Eigen stores something, and it does not keep the old way working. It converts what you have once, or that data does not open after the update. Stickies boards are the exception: they keep working across releases.

A release like that marks the change as breaking in its notes. `./eigen update` shows you the notes, asks before it goes on, and makes a Full backup first, so `./eigen rollback` can bring everything back. Read the notes before you say yes.

## Follow the newest code

`./eigen update main` puts an install on the main channel. Every change to Eigen's code builds a new version there. `./eigen update` then installs the newest build, and `./eigen status` names it, like `0.3.0 (abc1234) on main`. While a build is still being published, `./eigen update` says so. Run it again a few minutes later.

Release notes and the breaking question only come with a new version number, so on the main channel a breaking change can arrive without warning. The channel is for people who work on Eigen. `./eigen update <version>` takes you back to releases.
