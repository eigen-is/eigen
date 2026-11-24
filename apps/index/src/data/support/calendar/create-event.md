---
title: "Create and edit an event"
description: "Add an event to your calendar, fill in the details, and change or remove it afterwards."
type: how-to
tags: [calendar, events, recurring, attendees]
related: [calendar/get-started, calendar/invite-people, calendar/recurring-events]
order: 30
updated: 2026-11-24
---

You can create an event from the sidebar, by clicking a day in the month view, or by clicking or dragging over a time in the day, 3-day or week view, then fill in the date, time, guests, and other details. This article covers creating an event, editing it, and deleting it.

## Create an event

There are three ways to open the new-event form.

- Click **Create event** at the top of the sidebar.
- Click a day in the **Month** view. The form opens with that date already filled in.
- Click an empty time in the **Day**, **3 days** or **Week** view. The form opens at that quarter hour, for one hour. With a mouse you can also drag up or down a day's column to pick the start and the end at once. Press Escape while dragging to stop without opening the form. When the strip of all-day events above the hours shows, click an empty spot in it to start an all-day event on that day.

The **New event** form opens as a dialog. Fill in the fields you need:

1. Type a title in the **Add title** field at the top. A title is required.
2. Set the date and, if it is a timed event, pick a start time and an end time from the dropdowns. A new event starts an hour long.
3. Tick **All day** if the event has no specific time. The time pickers are replaced by a date-range picker.
4. To make the event repeat, open the recurrence dropdown (which shows **Does not repeat** by default) and pick a frequency. The built-in options are daily, weekly, monthly, annually, and every weekday. See [Create a recurring event](/support/calendar/recurring-events) for more detail.
5. To invite people, type a name or email address into the **Add guests** field and click the **+** button or press Enter. Repeat for each guest. See [Invite people and manage attendees](/support/calendar/invite-people) for how invitations work.
6. Type a room name or address into **Add location** if you want one.
7. Type any notes into **Add description**.
8. If you have more than one calendar, a calendar picker appears at the bottom. Choose which calendar the event belongs to. The picker also lists calendars that other people and teams have shared with you, when your access lets you edit them, so you can create the event straight into a shared calendar.
9. Click **Save**, or press Enter in the title field. **Save** stays grayed out until the event has a title and a calendar.

## Edit an event

1. Click the event in the calendar. A detail panel opens showing the time, location, description, and any guests.
2. Click the pencil icon in the bottom-left corner of the panel. The **Edit event** dialog opens with all the same fields.
3. Make your changes, then click **Save**, or press Enter in the title field.

On an event someone else invited you to, the details are grayed out, because only the organizer can change them. You can still move it to a different calendar, and you can [respond to the invitation](/support/calendar/respond-to-invitation).

The event can change elsewhere while you edit it, for example on your phone, by someone you share the calendar with, or when a guest replies. What you typed stays in the form, and the fields you haven't changed switch to the newer version. If you have typed something, your next save is refused and a message tells you the event changed elsewhere. Check the form and click **Save** again.

### Editing a recurring event

When you save changes to a recurring event, Calendar asks which occurrences to update:

- **This event**: changes this occurrence only. Future and past ones stay the same.
- **This and following events**: changes this occurrence and all that come after it.
- **All events in series**: changes every occurrence of the recurring event.

Choose the option that matches what you want, then click **OK**.

### Move an event by dragging

With a mouse or a pen you can change an event's time without opening it.

- In the **Day**, **3 days** or **Week** view, drag an event up or down to another time, or sideways to another day. It moves in steps of 15 minutes.
- Drag the bottom edge of an event to make it end earlier or later. It stays at least 15 minutes long.
- Drag an event in the strip of all-day events, or in the **Month** view, to another day.

Press Escape while dragging to put the event back. A click without dragging still opens the detail panel. On a touch screen, dragging scrolls the calendar instead.

If the event repeats, Calendar asks which occurrences to move, as it does for other edits. When you drag an occurrence to another day, it offers only **This event**. If the event has guests, a **Send update emails to guests?** dialog asks first: click **Send** to move it and tell them, or **Cancel** to leave it where it was. You can't drag an event someone else invited you to, or one on a calendar you can only view.

## Delete an event

1. Click the event to open its detail panel.
2. Click the trash icon in the bottom-left corner.
3. Confirm the deletion. For recurring events, Calendar asks the same scope question as when editing: you can remove this occurrence, this and following, or the whole series.

If the event changed elsewhere since it last loaded, the deletion is refused and a message says so. The event reloads, so check it and confirm again.

<div class="eigen-callout">

Deleting an event you organized removes it for you. If you invited other people, they will see their copy of the event canceled. To remove only your copy of a shared event you were invited to, decline it from the [Respond to an invitation](/support/calendar/respond-to-invitation) flow instead.

</div>
