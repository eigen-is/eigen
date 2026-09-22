---
title: "What a restore brings back for your calendars"
description: "What returns when an admin restores your account from a backup, and the handful of calendar settings you have to set again."
type: reference
category: Basics
tags: [calendar, backup, restore, caldav, sharing]
related: [admin/restore-home, calendar/share-calendar, connect/calendar-client]
order: 110
updated: 2026-09-21
---

If an admin puts your account back from a backup, your events come back whole. A few things belong to a calendar rather than to the events in it, and those can need setting again. This page says which is which.

## Your events

Every event comes back, with every detail it had:

- The title, the date and time, the time zone, the location, the description, the guest list, and the reminders.
- Anything your calendar app added that Eigen does not show itself. Each event is kept as its own calendar file, exactly as it was written.
- A repeating event comes back as the whole series, including every occurrence you moved, changed, or removed.

Events keep their identity, so a phone or a laptop that already had an event recognizes the one that comes back instead of adding a second copy of it.

## Your calendars

A calendar's name and color are not part of an event, so they come back as long as Eigen still has its own list of your calendars. That list is what a restore normally brings back with everything else.

If the list has to be rebuilt from the calendar files on the server, each calendar returns under the name of its folder there:

- A calendar your phone or desktop app created keeps the name that app gave it.
- A calendar you made in Eigen comes back called **Recovered calendar**, numbered when there are several. Rename it from **Edit calendar** in the sidebar.
- Colors are picked fresh, so a calendar can come back in a different one. Change it in the same dialog.

## What you set again after a rebuilt list

These settings live with the list, not with the events, so a rebuild loses them:

- Who each calendar is shared with. Set the shares again. See [Share a calendar](/support/calendar/share-calendar).
- Which calendars are hidden, and which one is your default.
- The calendars other people shared with you. Ask each owner to share again.

## Connected calendar apps

After a restore, a calendar app connected over CalDAV downloads nothing twice. Eigen recognizes the restored files as the ones the app already has. See [Set up Eigen Calendar in a calendar client](/support/connect/calendar-client).

If the calendar list had to be rebuilt, every connected app syncs your calendars in full once. That takes a moment and changes nothing you see.

## What a restore cannot bring back

A restore puts your whole account back as it stood when the backup was taken, so anything added since then is not in it.

Nothing is thrown away, though. Your account as it stood just before the restore is kept beside it, and an admin can put that version back. See [Restore a user or team from a backup](/support/admin/restore-home).
