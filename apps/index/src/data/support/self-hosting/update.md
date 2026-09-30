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

An update is one command, and so is going back. Eigen saves a snapshot before every update, so a rollback puts back both the old version and the data as it was.

## Update to the newest release

In the install folder, run:

```bash
./eigen update
```

1. Eigen downloads the new release while it keeps running.
2. When the release notes list breaking changes, it shows them and asks whether to go on. Without a terminal, like from cron, it refuses until you run `./eigen update --accept-breaking`.
3. Eigen stops, saves a snapshot in `snapshots/`, switches to the new version, and starts again.

Eigen is down for as long as the snapshot takes. Open browser tabs reconnect by themselves. The update checks first that the snapshot fits on the disk, and removes the images of the old version when it is done.

To see whether there is an update, and what it brings, without installing it: `./eigen update --check`. To install a specific release: `./eigen update 0.3.1`.

## The snapshot an update saves

Usually the snapshot is a light one: the databases, the settings, and `.env.production`, without the files and the mail. That keeps the downtime short.

It is a full one, files and mail included, when a release since yours marks a change as breaking, or when you run `./eigen update --full`.

Eigen keeps the snapshots of the last two updates of each kind. A light one is named `eigen-pre-update-light-<time>.tar.gz`. These do not replace your own backups: see [Back up and restore the whole server](/support/self-hosting/back-up-and-restore).

## Go back with a rollback

```bash
./eigen rollback
```

This goes back to the version before the last update, with the data as it was then. It puts back the snapshot the update saved, with the version that snapshot names, and starts Eigen. The data it replaces is kept aside, not deleted.

After a light snapshot, a rollback puts back only the databases, the settings, and `.env.production`. Files and mail added since the update stay. A rollback goes back one update, not further.

## What 1.0 means for your data

Eigen is not 1.0 yet. Until then, a release can change how Eigen stores something, and it does not keep the old way working. It converts what you have once, or that data does not open after the update. Stickies boards are the exception: they keep working across releases.

A release like that marks the change as breaking in its notes. `./eigen update` shows you the notes, asks before it goes on, and saves a full snapshot first, so `./eigen rollback` can bring everything back. Read the notes before you say yes.

## Follow the newest code

`./eigen update main` puts an install on the main channel. Every change to Eigen's code builds a new version there. `./eigen update` then installs the newest build, and `./eigen status` names it, like `0.3.0 (abc1234) on main`. While a build is still being published, `./eigen update` says so. Run it again a few minutes later.

Release notes and the breaking question only come with a new version number, so on the main channel a breaking change can arrive without warning. The channel is for people who work on Eigen. `./eigen update <version>` takes you back to releases.
