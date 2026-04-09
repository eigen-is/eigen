# iMIP: Email-Based Calendar Invitations

Bidirectional iMIP (RFC 6047) support for Eigen calendar. Enables email-based invitations to/from external
users, with native accept/decline in their calendar clients (Google, Apple, Outlook, Thunderbird).

## Problem

External attendees added to Eigen calendar events are stuck at "pending" forever. No email is sent, and they
have no way to see the invite or RSVP. Eigen users receiving calendar invites from external senders also have
no way to see those events in their calendar.

## Design Decisions

- **Full bidirectional**: both outbound invites and inbound invite detection
- **Full lifecycle**: REQUEST, REPLY, CANCEL with SEQUENCE tracking
- **From address**: organizer's Eigen email (not a system no-reply address)
- **Inbound processing at delivery time**: events appear in the calendar immediately when mail arrives
- **Mail UI widget**: lightweight banner linking to the calendar event, not duplicating accept/decline controls
- **No schema changes**: calendar method and UID extracted from the .ics attachment on demand
- **`external_` prefix**: for organizerUserId on events from external organizers (matches `team_` convention)

## Architecture

### New Module: `apps/api/src/lib/calendar/imip.ts`

Single module owning all email-based scheduling logic.

**Outbound functions:**

- `sendInviteEmail(home, event, attendees)` — compose email with `METHOD:REQUEST` .ics attachment. From:
  organizer's email. Subject: "Invitation: {title}". Body: plain text + HTML summary (date, time, location,
  description). Uses Nodemailer's built-in `icalEvent` option for proper `text/calendar` MIME encoding
  rather than a regular attachment. Sends via existing `sendMail()`
- `sendUpdateEmail(home, event, attendees)` — same structure, `METHOD:REQUEST` with incremented `SEQUENCE`.
  Subject: "Updated invitation: {title}". External calendars detect updated SEQUENCE and overwrite
- `sendCancelEmail(home, event, attendees)` — `METHOD:CANCEL` with `STATUS:CANCELLED`. Subject:
  "Cancelled: {title}". External calendars remove or strike through the event
- `sendRsvpReply(home, event, organizerEmail, status)` — when Eigen user RSVPs to an externally-organized
  event, send `METHOD:REPLY` back to the external organizer. Contains only the attendee's ATTENDEE line
  with updated PARTSTAT

**Inbound function:**

- `processInboundImip(home, parsedMail)` — checks attachments for `text/calendar`, parses iCal, routes
  based on METHOD:
  - `REQUEST` → create or update event via `receiveInvitation()` / `receiveInvitationUpdate()` with
    `organizerUserId` set to `external_{email}`
  - `REPLY` → find organizer's event by UID, update attendee status via `updateAttendeeStatus()`
  - `CANCEL` → find and cancel linked event via `removeInvitation()`

### iCal Serializer/Parser Extensions

**`ical-serialize.ts`:**
- `wrapInVCalendar()` gains optional `method` parameter (`'REQUEST' | 'REPLY' | 'CANCEL'`)
- When set, adds `METHOD:{method}` after `VERSION:2.0`
- Existing CalDAV code doesn't pass a method — behavior unchanged

**`ical-parse.ts`:**
- Extract `METHOD` from VCALENDAR level (currently only VEVENT properties are parsed)
- Return alongside parsed events: `{ method?: 'REQUEST' | 'REPLY' | 'CANCEL', events: [...] }`

### Integration Points

**Outbound — `invite-propagation.ts`:**

Current flow for unknown attendee email:
```
getUserByEmail() -> null -> addRegistryEntry()
```

New flow:
```
getUserByEmail() -> null -> sendInviteEmail() + addRegistryEntry()
```

Registry entry kept for future signup reconciliation. Same pattern for updates (call `sendUpdateEmail()`)
and cancellations (call `sendCancelEmail()`).

**Outbound RSVP — `calendar.ts`:**

When user RSVPs to an event where `organizerUserId` starts with `external_`, call `sendRsvpReply()` instead
of `sendToHome()`.

**Inbound — mail delivery route (`routes/mail.ts`):**

After `mailboxDeliver()` stores the message:
1. Parse the delivered message
2. Check attachments for `contentType` matching `text/calendar`
3. If found, call `processInboundImip(home, parsedMail)`

Fire-and-forget — if iMIP processing fails, the email is still delivered.

**Inbound — IMAP sync:**

Same detection runs when messages are synced into the mailbox via IMAP.

### Mail Parser Changes

**`mail-parser.ts`:**
- For `text/calendar` MIME parts, extract `METHOD` from the iCal content
- Set `calendarMethod` on the `Attachment` metadata

**`packages/lib/src/types/mail.ts`:**
- Add optional `calendarMethod?: 'REQUEST' | 'REPLY' | 'CANCEL'` to `Attachment` type

### Mail UI Widget

When the mail client renders an email with a `text/calendar` attachment, show a lightweight inline widget
above the email body.

**Detection:** frontend checks attachment list for `contentType` starting with `text/calendar`.

**Data:** fetch the .ics attachment via existing endpoint, parse on client to extract UID and METHOD.

**Widget variants by method:**
- `REQUEST` — event summary (title, date/time, location) + "View in Calendar" link
- `CANCEL` — "This event has been cancelled" + link to the cancelled event
- `REPLY` — "{name} has {accepted/declined} your invitation" (informational)

**Linking:** reuse existing calendar route `?eventId=` search param. Frontend resolves UID to local event ID,
then links to `/calendar/view/{mode}/{from}/{to}?eventId={localId}`. Calendar route may also be extended to
accept `?uid=` for direct UID-based lookup.

## File Changes

| File | Change |
|------|--------|
| `lib/caldav/ical-serialize.ts` | Add optional `method` param to `wrapInVCalendar()` |
| `lib/caldav/ical-parse.ts` | Extract `METHOD` from VCALENDAR level |
| **`lib/calendar/imip.ts`** (new) | All iMIP functions: send invite/update/cancel/reply, process inbound |
| `lib/calendar/invite-propagation.ts` | Call imip.ts for external attendees alongside registry |
| `lib/calendar/calendar.ts` | RSVP: detect `external_` organizer, call `sendRsvpReply()` |
| `routes/mail.ts` | After delivery, detect `text/calendar`, call `processInboundImip()` |
| `packages/lib/src/types/mail.ts` | Add `calendarMethod?` to `Attachment` type |
| `lib/mail/mail-parser.ts` | Extract METHOD from `text/calendar` parts, set on attachment |
| `apps/mail/` (frontend) | Lightweight widget on emails with `text/calendar` attachment |
| `apps/calendar/` (frontend) | Optionally support `?uid=` search param for UID-based lookup |

No database schema changes. No new tables.
