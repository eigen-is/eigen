# CalDAV Implementation Plan

CalDAV (RFC 4791) server for Eigen's calendar. Enables sync with Apple Calendar, Thunderbird, DAVx5, GNOME Calendar.
Thin adapter layer on top of the existing `Calendar` class — same Elysia server, `/dav/*` prefix, HTTP Basic Auth.

## Overview

CalDAV extends WebDAV (RFC 4918) to provide calendar access using iCalendar format (RFC 5545). Clients interact via:

1. Discovery — PROPFIND chain from `/.well-known/caldav` to calendar-home-set
2. Sync — REPORT queries (calendar-query, sync-collection) or ctag polling
3. CRUD — PUT/DELETE with ETag conflict detection
4. XML everywhere — multistatus responses, multi-namespace (`DAV:`, `urn:ietf:params:xml:ns:caldav`, Apple extensions)

CalDAV clients are native apps (not browsers) — CORS does not apply. Auth is HTTP Basic, not cookie/session.

## Schema Changes

Eigen's schema is ~70% CalDAV-ready. Fields that map directly:

| Eigen Field             | CalDAV Equivalent          |
|-------------------------|----------------------------|
| `calendars.ctag`        | `CS:getctag`               |
| `events.etag`           | `DAV:getetag`              |
| `events.uid`            | `VEVENT UID`               |
| `events.uri`            | Resource URL               |
| `events.sequence`       | `VEVENT SEQUENCE`          |
| `events.rrule`          | `VEVENT RRULE`             |
| `events.timezone`       | `VTIMEZONE TZID`           |
| `events.status`         | `VEVENT STATUS`            |
| `events.title`          | `VEVENT SUMMARY`           |
| `events.description`    | `VEVENT DESCRIPTION`       |
| `events.location`       | `VEVENT LOCATION`          |
| `events.startTime`      | `VEVENT DTSTART`           |
| `events.endTime`        | `VEVENT DTEND`             |
| `events.allDay`         | `DTSTART;VALUE=DATE`       |
| `events.parentEventId`  | `RECURRENCE-ID`            |
| `events.recurrenceDate` | `RECURRENCE-ID` value      |
| `calendars.name`        | `DAV:displayname`          |
| `calendars.color`       | `ICAL:calendar-color`      |
| `data.attendees`        | `VEVENT ATTENDEE`          |
| `data.organizer`        | `VEVENT ORGANIZER`         |
| `data.reminders`        | `VEVENT VALARM`            |

### New columns

```sql
-- events table
ALTER TABLE events ADD COLUMN icsBlob TEXT;       -- raw .ics for round-trip fidelity
ALTER TABLE events ADD COLUMN eventCtag INTEGER;   -- ctag snapshot at time of last change

-- new table: deletion tombstones for sync-collection
CREATE TABLE event_tombstones (
  uri TEXT NOT NULL,
  calendarId TEXT NOT NULL,
  deletedAtCtag INTEGER NOT NULL
);
CREATE INDEX idx_tombstones_cal_ctag ON event_tombstones(calendarId, deletedAtCtag);
```

### New indexes

```sql
CREATE UNIQUE INDEX idx_events_uri_calendar ON events(calendarId, uri);
CREATE UNIQUE INDEX idx_events_uid_calendar ON events(calendarId, uid);
```

CalDAV addresses resources by URI (`{uid}.ics`). The current schema has no uniqueness constraint on `uri` or `uid`
per calendar, and no `getEventByUri()` method exists. Both are required — CalDAV PUT/GET/DELETE all use the URI as
the resource identifier.

### ETag fix

The current `computeEtag()` is content-based (MD5 of event fields). Two identical updates produce the same ETag,
which can confuse sync clients that rely on ETag changes for change detection. Fix: include `updatedAt` (or a
monotonic counter) in the hash input. Alternatively, use `"${calendarCtag}-${eventId}"` as the ETag — simple,
guaranteed unique per change, and trivially derived.

## Architecture

### Same Elysia server, `/dav/*` prefix

```
Port 8000:
  /auth/*         -> better-auth (cookie/session)
  /calendar/*     -> existing REST API (cookie auth)
  /dav/*          -> CalDAV routes (Basic Auth, XML bodies)
  /.well-known/*  -> CalDAV discovery redirects
```

Elysia supports custom HTTP methods via `.route()`:

```typescript
app.route('PROPFIND', '/dav/*', handler)
app.route('REPORT', '/dav/*', handler)
app.route('MKCALENDAR', '/dav/*', handler)
app.route('PROPPATCH', '/dav/*', handler)
```

**CORS note**: The current CORS config in `app.ts` only allows `GET/POST/PUT/DELETE/OPTIONS`. CalDAV methods
(PROPFIND, REPORT, etc.) are not in this list. This is fine — CalDAV clients are native apps, not browsers, so CORS
does not apply. But the Elysia CORS middleware must not reject requests with unknown methods on `/dav/*`. Either
exclude `/dav/*` from CORS or add WebDAV methods to the allowed list.

**Body parsing note**: Elysia parses JSON by default. CalDAV sends `application/xml` bodies. The `/dav/*` routes
must read the raw request body as text (`await request.text()`) and parse XML manually. Use `parse: 'text'` or
access `request.text()` directly.

### File structure

```
apps/api/src/lib/caldav/
├── caldav-router.ts      -- Elysia route group with Basic Auth
├── auth.ts               -- Basic Auth extraction + validation
├── discovery.ts          -- .well-known, principal, calendar-home-set
├── propfind.ts           -- PROPFIND handler (Depth 0/1)
├── proppatch.ts          -- PROPPATCH handler (calendar name/color)
├── report.ts             -- calendar-query, calendar-multiget, sync-collection
├── resource.ts           -- GET/PUT/DELETE on individual .ics resources
├── ical-serialize.ts     -- CalendarEvent -> iCalendar text
├── ical-parse.ts         -- iCalendar text -> CalendarEvent fields
├── xml-builder.ts        -- Multistatus XML response generation
├── xml-parser.ts         -- PROPFIND/REPORT XML request parsing
└── vtimezone.ts          -- VTIMEZONE component generation
```

## Authentication

CalDAV clients only support HTTP-level auth. Cookie/session auth does not work.

### HTTP Basic Auth

1. Extract `Authorization: Basic <base64>` header on all `/dav/*` requests
2. Decode to `email:password`
3. Validate against better-auth's credential store

### App-specific passwords (recommended)

Add an `app_passwords` table:

```sql
CREATE TABLE app_passwords (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  name TEXT NOT NULL,          -- "MacBook Calendar", "DAVx5"
  passwordHash TEXT NOT NULL,  -- bcrypt/argon2 hash
  createdAt INTEGER DEFAULT (unixepoch()),
  lastUsedAt INTEGER
);
```

Benefits: user's primary password never exposed to CalDAV clients, individually revocable, standard practice
(Google, Apple, Fastmail all use them). UI: settings page with "App Passwords" section — generate, name, revoke.

Validation order: try app-specific passwords first, fall back to primary credential if none match.

## Discovery Flow

```
1. GET /.well-known/caldav
   -> 301 redirect to /dav/

2. PROPFIND /dav/  (Depth: 0)
   <- DAV:current-user-principal = /dav/principals/{userId}/

3. PROPFIND /dav/principals/{userId}/  (Depth: 0)
   <- CALDAV:calendar-home-set = /dav/calendars/{userId}/

4. PROPFIND /dav/calendars/{userId}/  (Depth: 1)
   <- List of calendar collections with displayname, color, ctag, etc.

5. REPORT on each calendar (calendar-query or sync-collection)
```

Apple Calendar **requires** `/.well-known/caldav`. Thunderbird does not auto-discover — users enter the full URL.

### OPTIONS response

Every `/dav/*` request should respond to OPTIONS with:

```
DAV: 1, 2, 3, calendar-access, extended-mkcol
Allow: OPTIONS, GET, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR
```

The `DAV:` header is required — clients use it to detect CalDAV capability.

## HTTP Methods

| Method       | Path Pattern                                      | Purpose                              |
|--------------|---------------------------------------------------|--------------------------------------|
| OPTIONS      | `/dav/*`                                          | Advertise DAV capabilities           |
| PROPFIND     | `/dav/`                                           | current-user-principal               |
| PROPFIND     | `/dav/principals/{userId}/`                       | calendar-home-set                    |
| PROPFIND     | `/dav/calendars/{userId}/`                        | List calendars (Depth: 1)            |
| PROPFIND     | `/dav/calendars/{userId}/{calendarId}/`           | Calendar properties (Depth: 0 or 1)  |
| PROPPATCH    | `/dav/calendars/{userId}/{calendarId}/`           | Update calendar name/color           |
| MKCALENDAR   | `/dav/calendars/{userId}/{calendarId}/`           | Create calendar                      |
| DELETE       | `/dav/calendars/{userId}/{calendarId}/`           | Delete calendar                      |
| REPORT       | `/dav/calendars/{userId}/{calendarId}/`           | calendar-query, multiget, sync       |
| GET          | `/dav/calendars/{userId}/{calendarId}/{uri}`      | Retrieve single .ics                 |
| PUT          | `/dav/calendars/{userId}/{calendarId}/{uri}`      | Create/update event                  |
| DELETE       | `/dav/calendars/{userId}/{calendarId}/{uri}`      | Delete event                         |

### REPORT types

- **calendar-query** — filter by component type and time range, return matching events as iCalendar
- **calendar-multiget** — batch-fetch specific events by URL (after sync-token reveals changed URIs)
- **sync-collection** (RFC 6578) — incremental sync, client sends previous token, server returns changes
- **free-busy-query** — aggregate busy times, returns `VFREEBUSY` iCalendar (not XML)

### Properties

**Calendar collection (PROPFIND Depth: 0):**
`DAV:resourcetype`, `DAV:displayname`, `CALDAV:calendar-description`, `CALDAV:calendar-timezone`,
`CALDAV:supported-calendar-component-set`, `CS:getctag`, `DAV:sync-token`, `ICAL:calendar-color`

**Calendar object (PROPFIND Depth: 1 on collection):**
`DAV:getetag`, `DAV:getcontenttype` (`text/calendar; charset=utf-8`), `CALDAV:calendar-data`

**User principal:**
`DAV:current-user-principal`, `CALDAV:calendar-home-set`, `DAV:principal-URL`

## Calendar Class Changes

### New methods needed

```typescript
// Lookup by URI — CalDAV addresses resources by URI, not by ID
getEventByUri(calendarId: string, uri: string): CalendarEvent | null

// Raw events for CalDAV — NOT expanded occurrences
// Returns master events + exception events, NOT CalendarEventOccurrence[]
getRawEventsInRange(calendarId: string, from: number, to: number): CalendarEvent[]

// All raw events in a calendar (for initial sync / full PROPFIND Depth:1)
getRawEvents(calendarId: string): CalendarEvent[]

// Batch lookup by URI (for calendar-multiget REPORT)
getEventsByUris(calendarId: string, uris: string[]): CalendarEvent[]

// Sync-collection support
getChangedEventsSince(calendarId: string, sinceCtag: number): CalendarEvent[]
getDeletedEventsSince(calendarId: string, sinceCtag: number): { uri: string }[]

// CalDAV PUT — create or update from parsed iCalendar
upsertFromIcs(calendarId: string, uri: string, icsBlob: string, ifMatch?: string): CalendarEvent

// CalDAV DELETE — delete by URI with optional ETag check
deleteByUri(calendarId: string, uri: string, ifMatch?: string): void
```

### Critical: `getEventsInRange()` vs CalDAV

The existing `getEventsInRange()` returns **expanded `CalendarEventOccurrence[]`** — synthetic objects for each
recurrence instance. CalDAV clients do their own recurrence expansion. The server must return:

- The **master event** (with RRULE intact) — one VEVENT per recurring series
- Any **exception events** (with RECURRENCE-ID) — modified/cancelled instances
- The client does the expansion itself

For `calendar-query` with `time-range` filter, the server must check whether any occurrence of a recurring event
falls within the requested range (reuse the existing `expandRecurrence()` logic for this check), but still return
the **raw master VEVENT**, not expanded instances.

`getRawEventsInRange()` should:
1. Return non-recurring events that overlap `[from, to]` (same as current)
2. For recurring events: expand to check overlap, but if **any** occurrence hits the range, include the master event
3. Include all exception events whose parent is a matching recurring event

### Tombstone management

On event deletion, before removing the row:

```typescript
const cal = this.getCalendarById(event.calendarId);
this.db.insert(schema.eventTombstones).values({
  uri: event.uri,
  calendarId: event.calendarId,
  deletedAtCtag: cal.ctag + 1, // will be the ctag after incrementCtag()
}).run();
```

Periodically clean tombstones older than N ctags (or a time threshold) to bound table growth.

## iCalendar Serialization

### JSON -> iCalendar (`ical-serialize.ts`)

```
CalendarEvent                       VCALENDAR/VEVENT
  uid            ──────────>          UID
  title          ──────────>          SUMMARY
  description    ──────────>          DESCRIPTION
  location       ──────────>          LOCATION
  startTime      ──────────>          DTSTART (epoch -> UTC or TZID)
  endTime        ──────────>          DTEND
  allDay         ──────────>          DTSTART;VALUE=DATE / DTEND;VALUE=DATE
  rrule          ──────────>          RRULE
  timezone       ──────────>          DTSTART;TZID= + VTIMEZONE component
  status         ──────────>          STATUS (CONFIRMED/TENTATIVE/CANCELLED)
  sequence       ──────────>          SEQUENCE
  data.attendees ──────────>          ATTENDEE properties
  data.organizer ──────────>          ORGANIZER property
  data.reminders ──────────>          VALARM components
  data.url       ──────────>          URL
  recurrenceDate ──────────>          RECURRENCE-ID
```

If `icsBlob` exists on the event, **use it as the base** and only update fields that Eigen manages. This preserves
unknown X-properties (X-APPLE-TRAVEL-ADVISORY, X-APPLE-STRUCTURED-LOCATION, etc.) for round-trip fidelity.

### iCalendar -> JSON (`ical-parse.ts`)

Parse incoming `.ics` with `ical.js`. Extract known fields into Eigen's schema. Store the **full raw iCalendar text**
in `icsBlob`.

Recurring events with exceptions: a single `.ics` file can contain multiple VEVENT components (master + exceptions
with RECURRENCE-ID). The parser must split these into separate database rows sharing the same `uid`, with
`parentEventId` linking exceptions to the master.

### VTIMEZONE generation (`vtimezone.ts`)

iCalendar requires full VTIMEZONE components for every timezone referenced in events. Use
`timezones-ical-library` (npm) or `ical.js` built-in timezone registry.

Given that Eigen stores timezone as an IANA string (e.g., `America/New_York`), the serializer looks up the VTIMEZONE
definition from the registry and includes it in the VCALENDAR output. This is a mechanical lookup, not a computation.

### Library

**ical.js** (npm): full parser + generator, used internally by Thunderbird. Handles VTIMEZONE, RRULE,
RECURRENCE-ID, VALARM, ATTENDEE, ORGANIZER. No native deps, works in Bun.

**timezones-ical-library** (npm): provides VTIMEZONE data for all IANA timezones. Complements ical.js.

## Sync Mechanism

### CTag (ready)

`calendars.ctag` increments on every event change. Clients poll via PROPFIND. If unchanged, skip sync.

### ETag (needs fix)

Current MD5-based ETag must include `updatedAt` or use `"${eventCtag}-${id}"` to guarantee uniqueness per change.

### Sync-token (new)

Format: `https://{domain}/ns/sync/{ctag}`. Implementation:

1. Client sends REPORT sync-collection with token `sync/{N}`
2. Server queries `events WHERE calendarId = ? AND eventCtag > N`
3. Server queries `event_tombstones WHERE calendarId = ? AND deletedAtCtag > N`
4. Returns changed events (200) + deleted URIs (404) + new token `sync/{currentCtag}`
5. No token (initial sync): return all events + current token
6. Unrecognized token: return `403 Invalid Sync Token`, client does full re-sync

### eventCtag column

On every `createEvent()`, `updateEvent()`, `deleteEvent()`: set `eventCtag` to the calendar's current ctag (before
incrementing). Then `sync-collection` for token N is just `WHERE eventCtag > N`.

## Shared & Team Calendars

### Challenge

Shared calendar data lives in the **owner's** `calendar.db`, not the recipient's. CalDAV PROPFIND on a user's
calendar-home-set must list shared calendars too. Serving events from shared calendars requires proxying to the
owner's Home instance.

### Approach

On PROPFIND Depth:1 on `/dav/calendars/{userId}/`:

1. List the user's own calendars (from their Home)
2. Call `syncTeamCalendars()` + `getSharedCalendars()` to get shared calendar references
3. For each shared calendar, include a collection entry like:
   `/dav/calendars/{userId}/shared-{ownerUserId}-{calendarId}/`
4. The URL encodes the owner, so GET/REPORT on that collection can resolve the owner's Home

### Permission mapping

| Eigen Permission | CalDAV ACL Privilege             |
|------------------|----------------------------------|
| `free-busy`      | `CALDAV:read-free-busy`          |
| `read`           | `DAV:read`                       |
| `write`          | `DAV:read` + `DAV:write-content` |

### Team calendars

Exposed as collections `/dav/calendars/{userId}/team-{teamOwnerId}-{calendarId}/`. Listed alongside personal
calendars. Permission resolved via `checkPermission()`. ACL enforcement reuses `resolveCalendarForEvents()`.

## Scheduling (RFC 6638) — Deferred

Eigen's invitation system (`invite-propagation.ts`) already implements core scheduling:

| Eigen Feature               | RFC 6638 Equivalent |
|-----------------------------|---------------------|
| `propagateInvitation()`     | REQUEST             |
| `propagateCancellation()`   | CANCEL              |
| `propagateRsvp()`           | REPLY               |
| Linked events               | Scheduling objects  |
| `data.attendees[].status`   | `PARTSTAT=`         |

Full RFC 6638 adds: scheduling inbox/outbox collections, SCHEDULE-TAG header, iMIP gateway. This is **optional for
CalDAV compliance**. CalDAV clients will see the resulting events — they just cannot trigger invitations via CalDAV
PUT. The web UI handles invitations. Implement RFC 6638 only if external client scheduling is needed.

## Client Compatibility

### Apple Calendar (macOS/iOS)

- **REQUIRES** `/.well-known/caldav` redirect
- Expects `CS:getctag` and `ICAL:calendar-color` (Apple extensions)
- Aggressive PROPFIND on every sync cycle
- Known bugs with non-standard ports on some iOS versions
- Sends PROPFIND with `brief="t"` header — respect it (omit 404 propstat entries)

### Thunderbird

- No auto-discovery — users enter full calendar URL manually
- Solid compliance, good for testing
- Supports scheduling extensions

### DAVx5 (Android)

- Prefers sync-collection when available, falls back to ctag + ETag
- Uses `If-None-Match: *` for creates, `If-Match` for updates
- Handles self-signed certificates

### GNOME Calendar

- Uses Evolution Data Server (EDS) backend
- Standard CalDAV compliance is sufficient
- Limited auto-discovery

## XML Layer

CalDAV XML is deeply nested with multiple namespaces. Two approaches:

### Option 1: Build custom with `fast-xml-parser`

Parse incoming XML with `fast-xml-parser` (already well-suited for Bun). Build response XML with template literals
or a small builder. The XML structures are well-defined — there are ~10 distinct response shapes.

Pros: no framework dependency, full control, lightweight.
Cons: must handle namespace prefixes carefully, easy to get wrong.

### Option 2: Extract XML utilities from `caldav-adapter`

The `caldav-adapter` package handles all XML/WebDAV plumbing. Its XML builders and parsers can be extracted and used
standalone. The package is Koa middleware — using it as-is with Elysia would require porting the middleware pattern.
Extracting just the XML utilities is more practical than porting the full middleware.

### Recommendation

Start with `fast-xml-parser` for parsing and template-literal builders for responses. The response shapes are
finite and well-documented. If XML edge cases become painful, extract utilities from `caldav-adapter`.

## Implementation Phases

### Phase 0: Schema & Calendar class prep (2-3 days)

1. Add migration: `icsBlob`, `eventCtag` columns, `event_tombstones` table, unique indexes on `uri`/`uid`
2. Fix ETag to include `updatedAt`
3. Add `getEventByUri()`, `getRawEvents()`, `getRawEventsInRange()`, `getEventsByUris()`
4. Add `getChangedEventsSince()`, `getDeletedEventsSince()`
5. Wire tombstone creation into `deleteEvent()`
6. Set `eventCtag` in `createEvent()`, `updateEvent()`
7. Add `app_passwords` table and auth validation

### Phase 1: Read-only CalDAV (1-2 weeks)

1. Create `caldav-router.ts` with Basic Auth middleware
2. Implement discovery: `/.well-known/caldav` redirect, principal PROPFIND, calendar-home-set
3. Implement `OPTIONS` with `DAV:` header
4. Implement `PROPFIND` on calendar-home-set (Depth: 1, list calendars)
5. Implement `PROPFIND` on calendar collection (Depth: 0 properties, Depth: 1 event ETags)
6. Implement `GET` on `{uri}` — serialize `CalendarEvent` -> iCalendar via ical.js
7. Implement `REPORT calendar-query` with time-range filter (using `getRawEventsInRange()`)
8. Implement `REPORT calendar-multiget` (using `getEventsByUris()`)
9. Write `ical-serialize.ts` and `vtimezone.ts`
10. Write `xml-builder.ts` for multistatus responses
11. Test with Thunderbird (easiest) and Apple Calendar

### Phase 2: Read-write CalDAV (1-2 weeks)

1. Write `ical-parse.ts` — iCalendar -> CalendarEvent fields
2. Implement `PUT` with `If-Match` / `If-None-Match` — parse iCal, store `icsBlob`, call create/update
3. Handle multi-VEVENT `.ics` (recurring master + exceptions)
4. Implement `DELETE` with optional `If-Match`
5. Implement `MKCALENDAR` — create calendar collection
6. Implement `PROPPATCH` — update calendar name/color
7. Implement `REPORT sync-collection` using `eventCtag` + tombstones
8. Test full two-way sync with Thunderbird, Apple Calendar, DAVx5

### Phase 3: Shared & team calendars (1 week)

1. List shared + team calendars in PROPFIND Depth:1 on calendar-home-set
2. Route GET/REPORT on shared calendar paths to owner's Home
3. Enforce ACL (free-busy → strip details, read → allow GET, write → allow PUT/DELETE)
4. Test with multiple users sharing calendars

### Phase 4: Scheduling (optional, 2+ weeks)

1. Scheduling inbox/outbox collections
2. Wire PUT with ATTENDEE to `propagateInvitation()`
3. Handle REPLY/CANCEL iTIP methods
4. SCHEDULE-TAG support

## Effort Summary

| Phase     | Scope                 | Effort         |
|-----------|-----------------------|----------------|
| Phase 0   | Schema + Calendar API | 2-3 days       |
| Phase 1   | Read-only CalDAV      | 1-2 weeks      |
| Phase 2   | Read-write CalDAV     | 1-2 weeks      |
| Phase 3   | Shared/team calendars | ~1 week        |
| Phase 4   | Scheduling (RFC 6638) | 2+ weeks       |
| **Total** | **Full CalDAV**       | **~5-8 weeks** |

The biggest piece is the XML layer + client compatibility testing. The iCalendar serialization is mechanical once
ical.js is wired up. Schema changes are small.

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Client quirks (each client expects slightly different behavior) | High | Test against Apple Calendar, Thunderbird, DAVx5 from day one. Keep a compatibility log |
| XML complexity (multi-namespace, deeply nested) | Medium | Use fast-xml-parser + template builders. Finite set of response shapes |
| Round-trip fidelity (losing unknown iCal properties) | Medium | Store raw `icsBlob`, merge on update. Never discard unknown properties |
| Recurrence in REPORT | Medium | Return raw master+exceptions, NOT expanded. Existing expansion logic reused only for time-range filtering |
| Shared calendar proxying | Medium | Encode owner in collection URL. Reuse `resolveCalendarForEvents()` for access control |
| Body parsing (Elysia JSON default vs XML) | Low | Read raw body as text on `/dav/*`. Exclude from JSON parsing |
| CORS interference | Low | Exclude `/dav/*` from CORS middleware or add WebDAV methods to allowed list |
| Performance (large calendars) | Low | SQLite is fast. ctag prevents unnecessary syncs. No pagination needed |

## Dependencies

```
ical.js                    -- iCalendar parse + generate (used by Thunderbird)
timezones-ical-library     -- VTIMEZONE definitions for IANA timezones
fast-xml-parser            -- XML parse (for PROPFIND/REPORT request bodies)
```

## Files Changed

| File | Change |
|------|--------|
| `apps/api/src/lib/caldav/*` | New directory — all CalDAV logic |
| `apps/api/src/lib/calendar/schema.ts` | Add `icsBlob`, `eventCtag` columns, `event_tombstones` table |
| `apps/api/src/lib/calendar/db-config.ts` | Migration v2 |
| `apps/api/src/lib/calendar/calendar.ts` | New methods: `getEventByUri`, `getRawEvents*`, `upsertFromIcs`, `deleteByUri`, tombstones |
| `apps/api/src/app.ts` | Add `caldavRouter`, handle CORS exclusion for `/dav/*` |
| `packages/lib/src/types/calendar.ts` | Add `icsBlob`, `eventCtag` to `CalendarEvent` type |
| `apps/api/src/lib/auth/auth.ts` | App-specific password validation |
| `apps/api/src/routes/settings.ts` | App password management endpoints |

## References

- [RFC 4791 — CalDAV](https://datatracker.ietf.org/doc/html/rfc4791)
- [RFC 5545 — iCalendar](https://datatracker.ietf.org/doc/html/rfc5545)
- [RFC 6578 — WebDAV Sync](https://datatracker.ietf.org/doc/html/rfc6578)
- [RFC 6638 — CalDAV Scheduling](https://datatracker.ietf.org/doc/rfc6638/)
- [RFC 3744 — WebDAV ACL](https://datatracker.ietf.org/doc/html/rfc3744)
- [sabre/dav Client Guide](https://sabre.io/dav/building-a-caldav-client/) — best practical reference for client behavior
- [sabre/dav Integration Guide](https://sabre.io/dav/caldav-carddav-integration-guide/) — backend integration patterns
- [caldav-adapter](https://github.com/forwardemail/caldav-adapter) — Node.js CalDAV middleware (XML utilities extractable)
- [ical.js](https://github.com/kewisch/ical.js) — iCalendar parser/generator
