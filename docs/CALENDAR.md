# Calendar

> **TLDR:** A calendar event series is its VCALENDAR bytes: the `ics` BLOB of one `resources` row in the Home's `calendar.db`, with the `events` rows beside it as a projection that rebuilds from them. The domain is `apps/api/src/lib/calendar/`, the app `apps/calendar/`. Not obvious from the code: Eigen's own facts ride inside the bytes as `X-EIGEN-*` lines no client can forge. A web save patches only what moved, while a CalDAV PUT replaces the file. Team calendars stay off until an admin enables them. Protocol, format and invitations have their own docs (See also).

## The stored bytes are the event, and every column is a projection

Each Home has one `eigen.calendar/calendar.db`. Only the API process opens it, so unlike mail there are no watchers and nothing to reconcile ([IMAP.md](IMAP.md)). How a resource and a calendar are named is in [CALDAV.md](CALDAV.md#eigen-names-what-it-creates-and-keeps-a-clients-name-as-written). A resource row holds the bytes a client wrote, `VALARM` details and unknown properties included, and the SHA-256 of those bytes is its etag. A CalDAV GET serves them back verbatim ([CALDAV.md](CALDAV.md)).

The `events` rows, `uid`, `etag` and `hasUnindexedRecurrence` are projected from the bytes. `rebuildProjection` (`calendar.ts`) rewrites all of them from the blobs in one transaction, and `apps/api/src/test/calendar/resource-store.test.ts` pins that contract. A new projected column is added by altering the table and calling it.

Some facts no VCALENDAR can hold live only in the database: a calendar's name, color, visibility, default flag, `shares`, `ctag` and `syncGen`, the `resource_tombstones` a sync delta reports as removals, and the recipient-side `shared_calendars`. See `schema.ts` and [DATABASE.md](DATABASE.md). The database runs `synchronous: 'FULL'`, because the events themselves live in these rows and an acknowledged PUT must survive a power loss.

## One resource holds one series

A resource holds one UID: its master VEVENT, one override VEVENT per edited occurrence, and the VTIMEZONE of every TZID they name. A PUT carrying two UIDs is refused, or a second UID's overrides would hang off the first master.

Eigen cancels one occurrence with an `EXDATE` on the master, never with a `STATUS:CANCELLED` override. Thunderbird omits such an override from its next PUT, and the full replace would read that as "the client removed the exception" and bring the occurrence back. Cancelling a moved override is the one path that still stores one ([ROADMAP.md](ROADMAP.md)). Deleting an occurrence that is already cancelled puts it back, whichever of the two spellings a client used.

## Eigen's own facts ride as `X-EIGEN-*` lines no client can write

iCalendar has no place for a row id, a creator, a color or an invitation link, so they ride inside the VEVENT as `X-EIGEN-*` properties, spelled once in `EIGEN` (`lib/ical/ical-parse.ts`):

| Line | Carries |
|---|---|
| `X-EIGEN-EVENT-ID` | the `events` row id, so an id survives a projection rebuild |
| `X-EIGEN-CREATED-BY` | the user who first wrote the resource |
| `X-EIGEN-ORGANIZER-EVENT`, `-USER` | the invitation link on an attendee's copy ([CALENDAR-INVITATIONS.md](CALENDAR-INVITATIONS.md)) |
| `X-EIGEN-COLOR` | the per-event color |
| `X-EIGEN-IMPORTED-ORGANIZER` | the organizer an imported file named |
| `X-EIGEN-EXDATE` | beside each `EXDATE`: the exclusion's row id, SEQUENCE and message stamp |

**An incoming stamp is never trusted.** `parseIcs` is the reader for bytes a stranger wrote, and its result type can't name an Eigen fact, so a forged one has nowhere to land. On a PUT, `restampResource` strips every Eigen property and parameter at every level, then copies the stamps back from the stored resource. It matches on UID plus recurrence key, never on the raw `RECURRENCE-ID` or `EXDATE` text, which clients rewrite between TZID, UTC and comma-joined forms. Only a resource nobody wrote before takes the caller's own stamps. Nothing that leaves the Home carries a stamp, except a CalDAV GET to the owner's own clients.

## Every write takes one lock and one function

bun:sqlite already makes a transaction atomic and serial. `Calendar.writeLock` exists for the async gaps between a check and its commit, such as the quota lookup, so a racing `If-Match` PUT loses inside the lock. Reads take no lock.

Every resource write ends in `Calendar.writeResource`. It takes a `PreparedResource` computed once (`resource-store.ts`), so the bytes the checks judged are the bytes that land. It checks `EVENT_MAX_BYTES` (5 MiB), then the Home's storage budget, then commits. The commit is one transaction: the ctag bump, the blob, a delete-and-reinsert of the resource's `events` rows, and clearing any tombstone at that uri. A throw anywhere leaves the old bytes and the old projection in place. `purgeResource` is the same in reverse.

`Calendar` holds what must be one per Home: the database, the lock, the byte counter and the broadcast batch. The domain logic is plain functions over it in the sibling modules.

`moveEvent` re-homes a resource between two calendars of one Home in one transaction, so no window shows it in both. A lone occurrence can't be moved, a UID the target holds is a 409, and a uri the target holds becomes a fresh name. `deleteCalendar` deletes the calendar's tombstones itself, since no cascade reaches them and a calendar recreated at that id would inherit them.

## A web save patches what moved, and a CalDAV PUT replaces the file

The web form restates every field on every save. So `updateEvent` (`events.ts`) diffs the submitted times against the stored row, and `patchEvent` (`lib/ical/ical-component.ts`) writes only the properties that really changed. A title edit leaves a client's own `DTSTART` spelling, its `DURATION` and its VTIMEZONE alone. Each `ATTENDEE` line is patched in place, so `CUTYPE`, `RSVP` and every `X-` parameter a client set survive. Re-spelling the same instants in another zone changes bytes but is not a reschedule, so no guest is mailed.

A CalDAV PUT replaces the whole resource. Its preconditions and the linked-copy rule are in [CALDAV.md](CALDAV.md).

`touch` owns the revision fields. `LAST-MODIFIED` is always now. `DTSTAMP` is the applying message's stamp or the clock, but a local edit never moves it on an attendee's copy, where it orders the organizer's next message. `SEQUENCE` bumps only when the organizer makes a scheduling change to an event with attendees. An attendee copy takes the organizer's number instead, because a bump of its own would outrank the organizer's next update.

The web app sends no etag on an update, so two tabs editing one event last-write-win ([ROADMAP.md](ROADMAP.md)).

## Recurrence is expanded per read, never stored

An `RRULE` is stored as written and expanded in memory per query. An override is a VEVENT in the same resource, projected with `parentEventId` and `recurrenceDate`. An occurrence key is a wall-clock date (`YYYY-MM-DD`) in the series' zone, and an override keeps its stored key even after it moved, because the frontend sends that key back in a `scope='this'` RSVP.

A range read (`occurrences.ts`) is bounded by its window, not by the size of the Home. It loads the single events overlapping the window, the masters starting before its end (a rule never steps back before DTSTART), and their overrides plus any override moved into the window.

The edit dialog opens on an occurrence but "All events in series" saves on the master. So `seriesEditFromOccurrence` (`packages/lib/src/core/calendar/calendar-utils.ts`) sends a delta. The master's times shift by what the user moved, and a text field travels only when retyped. A series-wide text edit also reaches every override that still carried the master's old value; one that set its own keeps it.

Expansion walks from DTSTART, so a rule is bounded before it is stored ([ICALENDAR.md](ICALENDAR.md#expansion-is-bounded-because-it-walks-from-dtstart)).

## An all-day event is midnight UTC with an exclusive end

An all-day event's bounds are midnight UTC, and `endTime` is the day after the last day. The frontend reads the UTC date and never converts it. With an exclusive end, one invariant covers both kinds: `endTime < startTime` is a 400 over REST and a 403 on a PUT, and a zero-length event is legal. Inbound iMIP clamps a reversed interval to zero instead, because dropping an emailed invite is worse than showing it short.

`timezone` is nullable: only the web dialogs always set one. So `formatEventWhen` takes the fallback zone as a required argument. The browser passes `viewerTimeZone()`, the zone the grid draws in, so the detail dialog names the slot the grid shows. Invitation mail has no viewer and must not borrow the server's zone, so it renders a zone-less event in UTC and says so.

## Sharing is pushed, and team calendars are off by default

A share grants `free-busy` (time blocks only), `read` or `write`. When shares change, `share-propagation.ts` writes the calendar into each named recipient's `shared_calendars` ([ACL.md § Share Propagation](ACL.md#share-propagation)). A `free-busy` reader gets blocks with cancelled occurrences left out, so their existence doesn't leak.

A `TeamHome` starts with `{ calendar: { enabled: false } }`, and its `calendar` getter throws 404 until an admin enables it from the Admin app. Members get the team calendar in their `shared_calendars` at `read` on each `GET /calendar/:ownerId/shared`. A share on the team calendar upgrades them. While it is disabled, that sync removes the stale entries.

Two access rules guard a team home's calendars in `routes/calendar.ts`. Creating, changing and deleting one takes a team admin, because the admin sets a team calendar's shares. Any member may list them. Every event route takes the calendar share instead (`checkCalendarAccess`), so a member's `write` share is event-level. A non-team `ownerId` must be the caller's own.

REST bounds are never tighter than what a PUT may store. The ids Eigen mints cap at 512 characters, and every field a client spells caps at `EVENT_MAX_BYTES`, or an event a CalDAV client stored would be uneditable in the web app.

## Calendar shares the home data budget

Calendar counts against the home data quota with mail and contacts ([QUOTA.md](QUOTA.md)). `Calendar.size()` answers from the in-memory `eventsBytes`, so a device sync costs no query per resource. Each commit reads its delta inside its transaction and applies it after, so a rolled-back write moves nothing. A rewrite is credited the bytes it replaces, so a shrinking edit is never refused. A move and a delete are not metered. An inbound invitation over budget is dropped while its mail still lands, because a fire-and-forget receiver has nobody to answer a 507 to.

## Every write is announced to every Home that sees the calendar

A change broadcasts a `calendar:*` event ([SSE.md](SSE.md)) to the owner's tabs and to each Home the calendar is shared with. A PUT of bytes already stored commits nothing and announces nothing. An import holds its per-resource events and sends one `calendar:events-changed` at the end. The frontend hooks and the SSE handler that invalidates them are in `packages/lib/src/core/calendar/`.

## See also

- [CALDAV.md](CALDAV.md): the CalDAV protocol and client setup
- [ICALENDAR.md](ICALENDAR.md): the iCalendar format layer, recurrence bounds, import and export
- [CALENDAR-INVITATIONS.md](CALENDAR-INVITATIONS.md): linked copies, RSVPs and iMIP
- [QUOTA.md](QUOTA.md), [DATABASE.md](DATABASE.md), [STORAGE.md](STORAGE.md), [ACL.md](ACL.md)
- [CONTACTS.md](CONTACTS.md): the CardDAV twin on the same blob-store shape
