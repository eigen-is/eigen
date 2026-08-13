# Calendar App

> **TLDR**: Per-user SQLite calendar at `{home}/eigen.calendar/calendar.db`. RRULE stored as-is (RFC 5545) and
> expanded in memory per query; exceptions are events with `parentEventId` + `recurrenceDate`. Sharing is
> push-based (like Drive ACL) at `free-busy`/`read`/`write`; team calendars are off until an admin enables them.
> The same store speaks **CalDAV** (RFC 4791, `/dav/calendars/`) and **iMIP** (RFC 6047) for off-server invites.

## Storage

```
data/home/{userId}/eigen.calendar/calendar.db
data/team/{teamId}/eigen.calendar/calendar.db
```

Follows the Contacts/Mail pattern — per-user Home directory, not Drive.

## Schema

Four tables, Drizzle definitions in `apps/api/src/lib/calendar/schema.ts`. Only the columns that carry meaning
are listed — UUID primary keys and `createdAt`/`updatedAt` are on every table.

**`calendars`** — `name`, `color`, `isDefault` (the auto-created primary, cannot be deleted), `visible` (UI
toggle), `shares` (JSON `CalendarShare[]`), and `ctag`, which increments on any event change and is the CalDAV
collection tag.

**`events`** — the iCalendar identity (`uid`, `uri`, `etag`, `sequence`), the times (`startTime`, `endTime`,
`allDay`, plus `rrule` and `timezone`, the IANA zone recurrence expansion runs in), `status`
(`confirmed`/`tentative`/`cancelled`), `title`/`description`/`location`, `data` (JSON: reminders, attendees,
organizer, url, notes, color), the recurrence-exception link (`parentEventId` + `recurrenceDate`, the ISO date
of the replaced occurrence), the invitation link (`organizerEventId` + `organizerUserId`), and `eventCtag` —
the calendar's ctag at the time of the last write to this row. `icsBlob` is **vestigial**: never written,
never read.

**`event_tombstones`** — `(uri, calendarId, deletedAtCtag)`. Event rows are hard-deleted, so this is the only
surviving trace that a resource existed.

`eventCtag` and the tombstones exist for one reason: the CalDAV **sync-collection REPORT**. Given a client's
sync token, `getChangedEventsSince()` selects rows with a higher `eventCtag` and `getDeletedEventsSince()`
reads tombstones past the same mark, so a client that has been offline learns about deletions it never saw.

**`shared_calendars`** (recipient side) — `ownerUserId` + `calendarId` point back at the owner's row,
`calendarName`/`calendarColor` are cached copies, `permission` is the resolved level, and `color`/`visible`
are the recipient's local overrides.

## Sharing

**Permissions**: `free-busy` (time blocks only), `read` (full details), `write` (can edit).

Push-based propagation — when shares change, `share-propagation.ts` resolves targets and writes to recipient's
`shared_calendars`. See [ACL.md](ACL.md#share-propagation).

**Team calendars**: **opt-in, not opt-out.** A `TeamHome` is constructed with settings defaulting to
`{ calendar: { enabled: false } }`, and the `TeamHome.calendar` getter throws 404 while that flag is false —
so a fresh team has no calendar until an admin turns it on from the Admin app team detail page (via
`PUT /team/:teamId/settings`).

Once enabled, the team calendar is auto-synced into each member's `shared_calendars` table (with
`ownerUserId = 'team_{teamId}'`) when `GET /calendar/:ownerId/shared` is called. Default member permission is
`read`. To grant `write` or `free-busy`, set shares on the team's default calendar:
`{targetId: 'team_{teamId}', permission: 'write'}`. Permission is resolved via `checkPermission()` and synced on
every fetch. While disabled, `syncTeamCalendars` catches the 404 and removes any stale entries from members'
`shared_calendars`. Displayed in a separate "Team Calendars" section in the sidebar, using the same
`SharedCalendar` infrastructure for visibility/color prefs.

## Invitations

Organizer creates event with `data.attendees[]` → server writes a linked copy to each attendee's default calendar →
attendees RSVP → status propagates back to organizer. All server-side, no email needed.

**Linked events**: Regular events in the attendee's calendar with `organizerEventId`/`organizerUserId` columns set
(indexed for fast lookup). Same `uid` as organizer's event (CalDAV requirement). `data.organizer` is also set with
`{ userId, email, name? }` and `data.organizerEventId`. DB-level detection: `organizerEventId IS NOT NULL` (used by
`findLinkedEvent`). Application-level detection: `event.data.organizer` is present (used by `updateEvent` guard and
`deleteEvent` decline logic).

**Propagation** (`invite-propagation.ts`):
- Create/update with attendees: diff old vs new → add/remove/update linked copies + SSE notifications
- Delete by organizer: cancel all attendee copies
- Delete by attendee: treated as decline (propagates `declined` status to organizer)
- Self-invite prevention: organizer's email is skipped during propagation
- Unknown email: added to share registry for reconciliation on signup

**RSVP**: Attendee calls `PUT .../events/:id/rsvp` with `{status, scope?, recurrenceDate?, remove?}`.

- `scope='all'` (default): updates attendee status on the linked event + propagates to organizer
- `scope='this'` + `recurrenceDate`: creates a recurrence exception with per-occurrence attendee status + propagates
  to organizer (who also gets an exception). With `remove: true`, creates a cancelled exception instead (hides
  occurrence) and propagates decline
- `scope='this-and-following'` + `recurrenceDate` + `remove: true`: truncates the linked event's rrule + propagates
  series-wide decline
- `remove: true` without scope: deletes the entire linked event (same as DELETE, propagates decline)

All handled by `Calendar.rsvp()`. Per-occurrence data is stored as recurrence exceptions (`parentEventId` +
`recurrenceDate`), reusing the existing expansion model — `getEventsInRange()` already substitutes exception data.

**rrule constraint**: When an organizer updates a recurring invited event, `receiveInvitationUpdate()` ensures the
incoming rrule does not extend beyond any local truncation the attendee made. This prevents "delete this and following"
from being undone by an organizer edit.

**Linked event guard**: Attendees can only change `data.reminders` and `data.color` on linked copies. Title, time,
description, location, rrule changes are blocked by `updateEvent()`. Detection: `event.data.organizer` is present
(not the DB column `organizerEventId`).

**SSE events**: `calendar:invite-received`, `calendar:invite-updated`, `calendar:invite-cancelled`, `calendar:invite-rsvp`.

## SSE Events

Full list of calendar SSE events (defined in `packages/lib/src/types/sse.ts`):

| Event                       | Trigger                           |
|-----------------------------|-----------------------------------|
| `calendar:calendar-created` | Calendar created                  |
| `calendar:calendar-updated` | Calendar updated (name/color/shares) |
| `calendar:calendar-deleted` | Calendar deleted                  |
| `calendar:event-created`    | Event created                     |
| `calendar:event-updated`    | Event updated                     |
| `calendar:event-deleted`    | Event deleted                     |
| `calendar:shared`           | Calendar shared with user         |
| `calendar:unshared`         | Calendar share removed            |
| `calendar:invite-received`  | Invitation received by attendee   |
| `calendar:invite-updated`   | Invitation updated by organizer   |
| `calendar:invite-cancelled` | Invitation cancelled by organizer |
| `calendar:invite-rsvp`      | Attendee RSVP propagated to organizer |

Shared calendar users are also notified via `notifySharedCalendarUsers()` when events are created/updated/deleted.

## Recurrence

- RRULE strings stored/transmitted as-is (no conversion layer)
- Expansion via `rrule` npm package: `new RRule({...RRule.parseString(rrule), dtstart}).between(from, to)`
- **Never store expanded occurrences** — expand in memory per query
- **Exceptions**: Regular events with `parentEventId` + `recurrenceDate`. Cancel = `status: 'cancelled'`, modify =
  different data at that date
- **Occurrence keys are wall-clock dates** (`YYYY-MM-DD` in the event's timezone). A substituted
  modified occurrence renders with the exception's STORED `recurrenceDate` — never the UTC date of
  its (possibly moved) startTime — so the FE can round-trip `occurrenceDate` into `scope='this'` RSVPs

### Recurrence limits

`recurrence-limits.ts` bounds what expansion can be asked to do, because `rrule.between` walks
occurrence-by-occurrence from dtstart to the query window on the single shared event loop:

- **Sub-daily rules are rejected.** `HOURLY`/`MINUTELY`/`SECONDLY` are refused at the API write boundary with a
  `400` (this is why an HOURLY rule fails to save) and silently stripped at the untrusted-ICS boundary, where a
  hard error would be the wrong answer. A `SECONDLY` rule starting a year before its window measured ~74s. No
  mainstream client emits sub-daily recurrence.
- **Recurring dtstart must fall in 1900–2200.** Same two seams, same reasoning: a pathological dtstart stalls
  the walk even at `DAILY`. Worst case inside the range is ~110k steps.
- **Materialised occurrences cap** at `MAX_OCCURRENCES` (10 000) per expansion.
- **Query windows are clamped**, not rejected, to a 5-year span — wide enough for any real view, and it stops
  a year-9999 range request.

## All-Day Events

`startTime`/`endTime` are midnight UTC. `endTime` is exclusive (day after last day). Frontend must use UTC date portion,
never convert to local time.

## Interval validation

`createEvent`/`updateEvent` reject `endTime < startTime` with `ApiError(400)`. REST and CalDAV PUT both funnel through
these two methods, so both are covered — interactive protocols where a 400 is actionable. Inbound iMIP bypasses them
(the `receive*` methods write rows directly), so it instead **clamps** a reversed interval to zero-duration at the
parse boundary (`imip.ts`): an emailed invite is fire-and-forget, so dropping it over a malformed interval is worse
than showing a zero-length event — the same degrade-don't-reject policy the parser applies to a malformed rrule/tzid.
Zero-duration (`endTime == startTime`) stays legal (RFC 5545 §3.6.1; CalDAV/iMIP importers synthesize it). Because
all-day uses an exclusive end (a valid all-day event is always ≥ `start + 1 day`), the single invariant covers timed
and all-day alike — no all-day special-casing.

## Moving events

`Calendar.moveEvent(sourceCalId, eventId, targetCalId)` (route `PUT .../events/:id/move`, write on both calendars)
re-homes an event to another calendar in the same Home as a pure `calendarId` UPDATE, in one transaction. It preserves
the row identity, timezone, `data` (organizer/attendees/reminders), status and recurrence, and drags the recurrence
exception children (`parentEventId` rows) along. It never runs the `deleteEvent` iMIP path, so moving a linked invite
doesn't decline it for the organizer. For CalDAV: the source gets a tombstone for the master uri (clients drop it) and
the target sees a changed event. Moving a lone recurrence occurrence (an exception row) is rejected.

## API Routes

`apps/api/src/routes/calendar.ts`, `ownerId` can be user ID or `team_{teamId}`:

```
GET    /calendar/:ownerId/calendars
POST   /calendar/:ownerId/calendars
PUT    /calendar/:ownerId/calendars/:calId        (includes shares)
DELETE /calendar/:ownerId/calendars/:calId
GET    /calendar/:ownerId/event-range/:from/:to   (all calendars)
GET    /calendar/:ownerId/calendars/:calId/event-range/:from/:to
POST   /calendar/:ownerId/calendars/:calId/events
PUT    /calendar/:ownerId/calendars/:calId/events/:id
DELETE /calendar/:ownerId/calendars/:calId/events/:id
PUT    /calendar/:ownerId/calendars/:calId/events/:id/move   (re-home to {targetCalendarId})
PUT    /calendar/:ownerId/calendars/:calId/events/:id/rsvp   (attendee RSVP)
GET    /calendar/:ownerId/calendars/:calId/access
GET    /calendar/:ownerId/shared                  (shared-with-me list, auto-syncs team calendars)
PUT    /calendar/:ownerId/shared/:id              (local prefs)
DELETE /calendar/:ownerId/shared/:id
GET    /calendar/:ownerId/shared-with-me          (pull: what has owner shared with me?)
```

Team calendar settings (enable/disable, member permission) are managed via the team router, not the calendar router:

```
GET    /team/:teamId/settings                     (includes calendar.enabled)
PUT    /team/:teamId/settings                     (update: {calendar: {enabled}})
```

Events endpoint returns `CalendarEventOccurrence[]` — expanded occurrences with `occurrenceDate` field. Free-busy
permission returns time blocks only.

## Types

```typescript
type CalendarShare = { targetId: string; permission: 'free-busy' | 'read' | 'write' }
type CalendarItem = { id, name, color, isDefault, visible, shares: CalendarShare[] | null, createdAt, updatedAt }
type CalendarEvent = { id, calendarId, uid, uri, title, description, location, startTime, endTime, allDay, rrule, timezone, parentEventId, recurrenceDate, status, sequence, etag, data, createByUserId, createdAt, updatedAt }
type CalendarEventOccurrence = CalendarEvent & { occurrenceDate: string }
type FreeBusyBlock = { startTime, endTime, allDay, status: 'confirmed' | 'tentative' }
type SharedCalendar = { id, ownerUserId, calendarId, calendarName, calendarColor, permission, color, visible, createdAt, updatedAt }
type Attendee = { email, name?, status: 'pending'|'accepted'|'declined'|'tentative', role: 'required'|'optional' }
type EventData = { reminders?: Reminder[], attendees?: Attendee[], organizer?: { userId, email, name? }, organizerEventId?, url?, notes?, color? }
```

Defined in `packages/lib/src/types/calendar.ts`.

## Frontend Hooks

All hooks in `packages/lib/src/core/calendar/hooks/use-calendar.ts`:

| Hook                          | Purpose                                    |
|-------------------------------|--------------------------------------------|
| `useCalendars(ownerId)`       | List calendars for an owner                |
| `useCreateCalendar(ownerId)`  | Create calendar mutation                   |
| `useUpdateCalendar(ownerId)`  | Update calendar mutation (name/color/shares/visible) |
| `useDeleteCalendar(ownerId)`  | Delete calendar mutation                   |
| `useEvents(ownerId, from, to)` | All events in time range (all calendars)  |
| `useCreateEvent(ownerId)`     | Create event mutation                      |
| `useUpdateEvent(ownerId)`     | Update event mutation                      |
| `useDeleteEvent(ownerId)`     | Delete event mutation                      |
| `useCalendarAccess(ownerId, calId)` | Get calendar shares (if `write` permission) |
| `useAllSharedCalendarEvents(sharedCalendars, from, to)` | Parallel queries for all visible shared calendar events |
| `useSharedCalendars(ownerId)` | List shared calendars (triggers team sync) |
| `useUpdateSharedCalendar(ownerId)` | Update local prefs (color/visible)    |
| `useDeleteSharedCalendar(ownerId)` | Remove shared calendar entry          |
| `useRsvp(ownerId)`            | RSVP mutation (accept/decline/tentative)   |

**Query keys**: `calendarKeys` with `ownerId`-scoped hierarchy — `all > owner(ownerId) > calendars/events/shared`.
SSE handler in `packages/lib/src/core/calendar/sse-handlers.ts` routes events to invalidation functions.

## iMIP (Email-Based Calendar Invitations)

iMIP enables calendar invitations between Eigen users and external parties via email (RFC 6047). It is layered on top of the existing invitation system — external attendees receive emails instead of in-app linked events.

### Outbound flow (Eigen → external)

- **Create event with external attendees**: `invite-propagation.ts` detects attendees with no Eigen account and calls `composeInviteEmail()` → `sendMail()`. Sends `METHOD:REQUEST`.
- **Update event**: same path calls `composeUpdateEmail()` → updated `METHOD:REQUEST`.
- **Cancel event**: `composeCancelEmail()` → `METHOD:CANCEL`.
- **Attendee RSVP**: when an Eigen user RSVPs to an externally-organized event, `calendar.ts` calls `composeRsvpReply()` → `METHOD:REPLY`. Triggered both from `rsvp()` and from `deleteEvent()` (delete = decline). A `scope:'this'` RSVP passes the occurrence's `recurrenceDate`, so the REPLY carries a `RECURRENCE-ID` for the original instant (from `computeOccurrenceTimes`) and the organizer applies the PARTSTAT to that occurrence, not the whole series; a master-scoped RSVP replies without one (RFC 5546).

### Inbound flow (external → Eigen)

- **Mail delivery hook**: inside `Mail.mailboxDeliver` (`apps/api/src/lib/mail/mail-domain.ts`). Once the raw bytes are appended to INBOX, the message is parsed and scanned for a `text/calendar` attachment; if there is one, `processInboundImip(home, parsedMail)` runs. This is **blocking on purpose** — "blocking so event exists before client queries" — so a client that reacts to the new-mail SSE already finds the event in its calendar. The surrounding `try`/`catch` only logs: a malformed invite never fails the delivery.
- **`METHOD:REQUEST`**: creates a linked event in the recipient's calendar via `calendar.receiveInvitation()`. If a linked event with the same `uid` already exists, updates it via `calendar.receiveInvitationUpdate()`. A single-occurrence REQUEST (one carrying a `RECURRENCE-ID`) instead attaches/updates an exception on the linked series via `calendar.receiveInvitationException()`, so a rescheduled instance doesn't collapse the whole series.
- **`METHOD:CANCEL`**: removes the linked event via `calendar.removeInvitation()`. A single-occurrence CANCEL (carrying a `RECURRENCE-ID`) instead cancels just that instance via `calendar.cancelInvitationOccurrence()`, which applies the same RFC 5546 SEQUENCE replay guard as the REQUEST path (strictly-older CANCELs are dropped; the cancelled exception records the CANCEL's SEQUENCE).
- **`METHOD:REPLY`**: updates attendee status on the organizer's event via `calendar.updateAttendeeStatus()`. A single-occurrence REPLY (carrying a `RECURRENCE-ID`) instead lands the sender's PARTSTAT on that instance's exception via `calendar.rsvpForOccurrence()`, so declining one occurrence doesn't mark the whole series. Only invited attendees are processed (exception-aware: an occurrence-only invitee lives on the exception's attendee list), and a REPLY never resurrects an occurrence the organizer deleted — it moves PARTSTAT only.

### `external_` prefix convention

External organizers have no Eigen user ID. `organizerUserId` is set to `external_{organizerEmail}` (e.g. `external_alice@example.com`). Mirrors the `team_{teamId}` convention used for team owner IDs. Code uses `organizerUserId.startsWith('external_')` to route RSVP replies via email instead of in-app propagation.

### `imip.ts` module

`apps/api/src/lib/calendar/imip.ts` — pure functions, no DB access:

| Function                  | Purpose                                                     |
|---------------------------|-------------------------------------------------------------|
| `composeInviteEmail()`    | Build `OutboundMail` for `METHOD:REQUEST` (new invite)      |
| `composeUpdateEmail()`    | Build `OutboundMail` for `METHOD:REQUEST` (update)          |
| `composeCancelEmail()`    | Build `OutboundMail` for `METHOD:CANCEL`                    |
| `composeRsvpReply()`      | Build `OutboundMail` for `METHOD:REPLY` (attendee response) |
| `extractCalendarAttachment()` | Find `text/calendar` attachment in a parsed mail        |
| `summarizeCalendarInvite()` | Read-time `CalendarInvite` summary for the message payload |
| `processInboundImip()`    | Dispatch inbound iMIP methods to calendar operations        |

### Mail UI widget

`apps/mail/src/components/mail/calendar-invite-widget.tsx` — rendered inline in `email-detail.tsx` for any attachment with `contentType.startsWith('text/calendar')`. Regular file attachments with `text/calendar` content type are excluded from the normal attachment list and shown as the widget instead. The widget is purely presentational: `Mail.messageGet` summarizes each calendar part via the canonical ical.js parser (`summarizeCalendarInvite`) into `Attachment.calendarInvite` (`CalendarInvite` in `packages/lib/src/types/mail.ts`); `null` means unparseable ICS and renders as an explicit error card.

## CalDAV

`apps/api/src/lib/caldav/` serves RFC 4791 CalDAV at `/dav/calendars/:ownerId/:calendarId/` (PROPFIND,
REPORT calendar-query/multiget/sync-collection, per-resource GET/PUT/DELETE). Auth via
`verifyProtocolAuth()`. One `.ics` resource per UID: the master VEVENT plus one override VEVENT per
stored exception — exception rows are internal and never appear as their own resources.

**Serialization** (`ical-serialize.ts`):

- Every referenced TZID gets a generated VTIMEZONE block (RFC 5545 §3.6.5). `vtimezone.ts` builds it
  from Intl offset data: transitions compressed to two open-ended RRULE observances when the zone's
  DST rule is regular, one observance per transition otherwise
- RECURRENCE-ID names the ORIGINAL occurrence — computed from the master via
  `computeOccurrenceTimes(master, recurrenceDate)` — in the master's TZID form, never the exception's
  moved startTime (which would orphan the override)
- The same serializer produces outbound iMIP bodies (`serializeEventForImip`), so Eigen↔Eigen
  federation keeps instants intact for non-server timezones

**Parsing** (`ical-parse.ts`):

- Datetimes with a resolvable zone (VTIMEZONE present, or UTC `Z`) resolve through ical.js. A valid
  IANA TZID without a VTIMEZONE is interpreted in that zone (RFC 7809) — consistent with the stored
  `timezone` column that recurrence expansion trusts. Genuinely floating datetimes map their wall
  components via `Date.UTC`, never through the server's local timezone
- RECURRENCE-ID / EXDATE → `recurrenceDate` keys are wall-clock dates: TZID-form values key on their
  own wall components (RFC 5545 canonical), UTC-`Z` values convert the instant to the SERIES timezone,
  floating/DATE values keep their raw components
- Not supported (accepted, low): `RANGE=THISANDFUTURE` on RECURRENCE-ID degrades to a single-instance
  edit, and RDATE-added occurrences never appear — mainstream clients split such series into new UIDs

**PUT is a full-resource replace**: `syncExceptionEvents` (`resource.ts`) upserts the exceptions in
the payload (preserving their SEQUENCE) and deletes stored exceptions of the master that are absent —
how Apple models "undo delete occurrence". The prune is quiet: ctag bump + master etag touch, no
tombstone, no cancellation fan-out. The PUT response ETag is re-read after the exception sync so it
always matches storage.

**Cancelled exceptions serve as EXDATE, never as override VEVENTs**: `eventsToIcs` emits a deleted
occurrence as an `EXDATE` line on the master (master-TZID form; `VALUE=DATE` for all-day) and skips
the cancelled row's VEVENT. Clients round-trip EXDATE natively; a `STATUS:CANCELLED` override VEVENT
is dropped by Thunderbird's next PUT, which the full-replace prune would read as "client removed the
exception" and resurrect the occurrence. The parser maps EXDATE back to cancelled exception rows, so
the round-trip is symmetric.

Regression nets: `caldav.test.ts` (protocol), `caldav-roundtrip.test.ts` (serialization/parse
round-trips, TZ-pinned floating tests), `vtimezone.test.ts` (generator vs Intl),
`calendar-timezone.test.ts` (occurrence keying), `ical-imip.test.ts` (iMIP scoping),
`caldav-client-sync.test.ts` (client-faithful sync flows against web-created events).

## Where the code lives

- **`apps/api/src/lib/calendar/`** — the domain. `calendar.ts` is the `Calendar` class; around it sit the pure
  helpers (`recurrence.ts` + `timezone.ts` for expansion and zone math, `recurrence-limits.ts` for the guards,
  `mappers.ts` for row→domain + `computeEtag`), the storage layer (`schema.ts`, `db-config.ts`, `types.ts`), access
  resolution (`get-calendar.ts`, the Drive `get-drive.ts` analogue), the two propagators
  (`share-propagation.ts`, `invite-propagation.ts`), `imip.ts`, and `sse-events.ts`.
- **`apps/api/src/lib/caldav/`** — the protocol layer: router, REPORT handlers, `ical-serialize.ts`,
  `ical-parse.ts`, `vtimezone.ts`, `resource.ts`.
- **`apps/api/src/routes/calendar.ts`** — thin route bindings.
- **`packages/lib/src/core/calendar/`** — FE hooks + SSE handlers; shared types in
  `packages/lib/src/types/calendar.ts`.
