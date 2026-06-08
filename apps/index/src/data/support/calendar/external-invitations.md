---
title: "How invitations work with people outside Eigen"
description: "Invite external guests to your events and receive invitations from other calendar apps via email."
type: faq
tags: [calendar, invitations, external, imip, rsvp]
related: [calendar/invite-people, calendar/respond-to-invitation, calendar/create-event]
order: 70
updated: 2026-06-08
---

Eigen can exchange calendar invitations with people who use other calendar apps, such as Google Calendar,
Apple Calendar, or Outlook. This works through standard invitation emails: when you invite an external
guest, they receive an email they can accept or decline in their own app. When someone outside Eigen
invites you, the invitation arrives in Mail and the event is added to your calendar automatically.

## How do I invite someone who doesn't use Eigen?

When creating or editing an event, type the person's email address into the **Add guests** field and press
**+**. You can add any email address, whether or not the person has an Eigen account.

When you save the event, Eigen sends a calendar invitation email to your external guests. The email
includes the event details and a standard `.ics` attachment their calendar app can read. They can accept,
decline, or mark themselves as maybe directly from their own calendar app or email client.

If you later update the event, Eigen sends an updated invitation email automatically. If you delete the
event, Eigen sends a cancellation email.

## What does an external guest see?

External guests receive a plain invitation email with the event title, date and time, location (if any),
and description. Their calendar app handles the rest: most will show an **Accept / Decline** prompt and,
if accepted, add the event to their calendar.

Their response comes back to you as a reply email. When that email arrives in Eigen Mail, Eigen reads
the reply and updates the attendee's status on your event.

## What happens when someone outside Eigen invites me?

When an invitation email arrives in your Eigen mailbox, Mail shows a calendar card inside the message
instead of a bare attachment. The card displays the event title, date and time, location, and the
organiser's name. Click **View in Calendar** to open Calendar on that event.

Eigen adds the event to your default calendar automatically. You do not need to do anything else for it
to appear.

## How do I respond to an externally-organised event?

Open the event in Calendar. Because you are an attendee and not the organiser, the event shows an
**RSVP** section at the bottom of the event detail. Click **Accept**, **Maybe**, or **Decline**.

Eigen sends a reply email to the organiser so their calendar app can update their attendee list.

## Can I edit an event that someone outside Eigen organised?

No. On events organised by someone else, the title, time, location, and description are read-only.
To suggest a different time, contact the organiser directly.

## What if I receive a cancellation email?

When the organiser cancels the event, a new email arrives in Mail. The calendar card in that email shows
"This event has been cancelled". Eigen removes the event from your calendar automatically.

## Why did my invited guest not receive anything?

Invitation emails are sent through your Eigen server's outbound mail setup. If your server does not
have outbound email configured, the invitation will not be delivered. Contact your Eigen administrator
if you are unsure whether outbound mail is set up.

<div class="eigen-callout">

External guests receive standard iMIP calendar emails (RFC 6047). Most modern calendar apps and email
clients handle them automatically, including Google Calendar, Apple Calendar, and Outlook.

</div>
