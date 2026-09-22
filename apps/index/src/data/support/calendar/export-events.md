---
title: "Export a calendar or an event as a calendar file"
description: "Download a whole calendar, or one event, as an .ics file you can open in another calendar app."
type: how-to
category: Basics
tags: [calendar, export, download, ics]
related: [calendar/import-events, calendar/show-hide-calendars, connect/calendar-client]
order: 95
updated: 2026-09-21
---

Calendar can hand you an `.ics` file, the standard calendar format every calendar program reads. Use it to move a schedule into another app, to send one event to someone, or to keep a copy of your own.

## Export a whole calendar

1. Open [Calendar](/calendar) and find the calendar in the sidebar on the left.
2. Hover over its name and click the **⋮** button on the right.
3. Click **Export calendar**.

Your browser downloads a file named after the calendar, for example `Work.ics`, holding every event in it.

Your own calendars under **My Calendars** and any team calendar under **Team Calendars** can be exported. A calendar someone shared with you from their own account cannot: it lives in their account, so you export it from theirs or ask them for the file.

## Export one event

1. Click the event in the month or week view. The event details open.
2. Click the download icon at the bottom left of the dialog.

The file is named after the event, for example `Autumn market.ics`.

For a repeating event you get the whole series in one file, whichever occurrence you opened, including any occurrence you moved or changed.

## What the file contains

Eigen writes out the event exactly as it is stored, so nothing is lost on the way:

- Titles, dates and times, time zones, locations, descriptions, and all-day events.
- Repeating events keep the rule that repeats them, along with every changed occurrence.
- The organizer and the guest list, with each guest's response.
- Reminders.

The file holds one calendar, so a program that reads only the first entry still gets everything.

## What you can do with the file

- Open it in another calendar app, or import it there.
- Import it back into Eigen, into another calendar or another account. See [Import events from a calendar file](/support/calendar/import-events).
- Keep it as your own copy of a calendar.

To keep a phone or a laptop in step with Eigen continuously, rather than taking a copy now and then, connect it over CalDAV instead. See [Set up Eigen Calendar in a calendar client](/support/connect/calendar-client).
