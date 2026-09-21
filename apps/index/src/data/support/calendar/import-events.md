---
title: "Import events from a calendar file"
description: "Bring events into one of your calendars from an .ics file in Drive, or one attached to a message, a chat message, or a card."
type: how-to
category: Basics
tags: [calendar, import, ics]
related: [calendar/get-started, calendar/export-events, calendar/external-invitations, drive/preview-a-file]
order: 90
updated: 2026-09-21
---

Most calendar programs can save events as an `.ics` file, the standard calendar format. Eigen reads those files, so you can bring a conference schedule, a season of matches, or a whole calendar from another provider into one of your own calendars.

## Import a file

1. Put the file in [Drive](/drive), or find it as an attachment on an email, a chat message, or a card.
2. In Drive, right-click the file or click its **⋮** button. For an attachment, right-click the chip, or press and hold it on a phone.
3. Choose **Import to Calendar**.
4. Pick the calendar the events go into, then click **Import**.

The events appear in your calendar straight away, and a message tells you what happened, for example "Imported 12 events, skipped 3 duplicates".

To read the file before you import it, select it and press **Space**, or choose **Quick preview** from the same menu. The preview lists every event in the file with its time, where it repeats, its location, and its guests, up to the first 200. The bar at the bottom has the same **Import to Calendar** button. See [Preview a file](/support/drive/preview-a-file).

## Choose the calendar

The dialog lists your own calendars under **My Calendars**, with your default one already selected. Any team calendar you can edit is listed below it under **Team Calendars**, so a schedule the whole team needs can go straight where everyone sees it. Choose **New calendar** instead to make a fresh one for the file. Eigen names it after the file, and you can change the name before you import. A new calendar is always one of your own. If nothing ends up going in, because every event in the file was already in your calendar, the new calendar is removed again.

A calendar someone shared with you from their own account is not in the list, and neither is a team calendar you can only read.

## What comes across

- The title, the date and time, the time zone, the location, the description, and whether the event lasts all day.
- Repeating events keep the rule that repeats them, and any single occurrence that was moved or changed keeps its change.
- Reminders come across, however many the event carries.
- Anything else the file holds comes across with it. Eigen keeps every line an event was written with, including the parts it does not show you itself.

Two things are deliberately left behind, so an imported file never sends mail on your behalf:

- **The organizer and the guest list.** An imported event is your own event, not an invitation from someone else. You can open it and invite people yourself.
- **The file's purpose.** An invitation file and a cancellation file both import as plain events. To accept a real invitation, open the email it came with instead. See [Respond to an invitation](/support/calendar/respond-to-invitation).

An event you already have is skipped rather than imported twice. Eigen matches on the identifier the event carries, across every calendar in the same account, so re-importing the same file adds nothing. Importing it into a second calendar of yours adds nothing either, because an event lives in one place per account. An invitation you already accepted never gets a twin. A team is its own account, so a file you have already imported for yourself still lands in a team calendar.

## Limits

- A file can be up to 5 MB and can hold up to 10,000 events, whichever it reaches first. A bigger file is refused as a whole, so split it before you import.
- The file has to be saved as UTF-8, which is what every current calendar program writes.

## If nothing is imported

A message saying **No events found in this file** means the file was readable but held no event Eigen could take. If the file is not a calendar file at all, you get a **Not a calendar file** error instead and nothing is imported. Open the file in a text editor to check: a calendar file starts with the line `BEGIN:VCALENDAR`.

Events that could not be read are counted separately in the message, as "unreadable". The rest of the file is still imported.
