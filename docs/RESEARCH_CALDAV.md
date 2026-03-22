# CalDAV Backend Research

Research into adding CalDAV support to Eigen's calendar, allowing users to sync with Apple Calendar, Thunderbird,
DAVx5 (Android), GNOME Calendar, and other standards-compliant clients.

## TL;DR

Eigen's calendar schema is already ~70% CalDAV-ready (`ctag`, `etag`, `uid`, `uri`, `sequence`, `rrule`, timezone
support). The main work is building the WebDAV/XML request/response layer, iCalendar serialization, and
authentication. Estimated effort: **2-4 weeks** using a library for XML plumbing, or **3-6 months** from scratch.
Recommended approach: thin CalDAV adapter layer on top of the existing Calendar class.

---

## What CalDAV Is

CalDAV (RFC 4791) extends WebDAV (RFC 4918) to provide calendar access using the iCalendar data format (RFC 5545).
Clients interact with a CalDAV server by:

1. Discovering the user's calendar home via PROPFIND
2. Listing calendars in the home (PROPFIND Depth:1)
3. Syncing events via REPORT queries or sync-token
4. Creating/updating/deleting events via PUT/DELETE with ETags for conflict detection

The protocol is XML-heavy. Every request/response uses WebDAV's multistatus XML format with multiple namespaces
(`DAV:`, `urn:ietf:params:xml:ns:caldav`, Apple extensions).

---

## Current Schema Alignment

Fields Eigen already has that map directly to CalDAV:

| Eigen Field             | CalDAV Equivalent          | Status |
|-------------------------|----------------------------|--------|
| `calendars.ctag`        | `CS:getctag`               | Ready  |
| `events.etag`           | `DAV:getetag`              | Ready  |
| `events.uid`            | `VEVENT UID`               | Ready  |
| `events.uri`            | Resource URL (`{uid}.ics`) | Ready  |
| `events.sequence`       | `VEVENT SEQUENCE`          | Ready  |
| `events.rrule`          | `VEVENT RRULE`             | Ready  |
| `events.timezone`       | `VTIMEZONE TZID`           | Ready  |
| `events.status`         | `VEVENT STATUS`            | Ready  |
| `events.title`          | `VEVENT SUMMARY`           | Ready  |
| `events.description`    | `VEVENT DESCRIPTION`       | Ready  |
| `events.location`       | `VEVENT LOCATION`          | Ready  |
| `events.startTime`      | `VEVENT DTSTART`           | Ready  |
| `events.endTime`        | `VEVENT DTEND`             | Ready  |
| `events.allDay`         | `DTSTART;VALUE=DATE`       | Ready  |
| `events.parentEventId`  | `RECURRENCE-ID`            | Ready  |
| `events.recurrenceDate` | `RECURRENCE-ID` value      | Ready  |
| `calendars.name`        | `DAV:displayname`          | Ready  |
| `calendars.color`       | `ICAL:calendar-color`      | Ready  |
| `data.attendees`        | `VEVENT ATTENDEE`          | Ready  |
| `data.organizer`        | `VEVENT ORGANIZER`         | Ready  |
| `data.reminders`        | `VEVENT VALARM`            | Ready  |

**What's missing:**

| Need                    | Purpose                                               | Effort |
|-------------------------|-------------------------------------------------------|--------|
| iCalendar blob column   | Round-trip fidelity (preserve unknown properties)     | Small  |
| Deletion tombstones     | sync-collection REPORT needs to report deleted events | Small  |
| VTIMEZONE generation    | iCalendar requires full timezone definitions          | Small  |
| XML request/response    | WebDAV multistatus parsing and generation             | Large  |
| iCalendar serialization | Convert JSON schema <-> `.ics` text                   | Medium |
| Discovery endpoints     | `.well-known/caldav`, principal, calendar-home-set    | Small  |
| Basic Auth endpoint     | CalDAV clients cannot use cookie/session auth         | Small  |

---

## Protocol Requirements

### HTTP Methods Needed

| Method          | Purpose                                                       | Priority               |
|-----------------|---------------------------------------------------------------|------------------------|
| `OPTIONS`       | Advertise CalDAV capabilities                                 | Required               |
| `PROPFIND`      | Property discovery (calendars, user)                          | Required               |
| `PROPPATCH`     | Modify calendar properties                                    | Required               |
| `REPORT`        | calendar-query, calendar-multiget, sync-collection, free-busy | Required               |
| `GET`           | Retrieve single `.ics` resource                               | Required               |
| `PUT`           | Create/update event (with `If-Match`)                         | Required               |
| `DELETE`        | Delete event                                                  | Required               |
| `MKCALENDAR`    | Create new calendar collection                                | Required               |
| `MKCOL`         | Create collection (generic WebDAV)                            | Nice-to-have           |
| `COPY`/`MOVE`   | Move events between calendars                                 | Rarely used            |
| `LOCK`/`UNLOCK` | Concurrency (WebDAV)                                          | Not needed in practice |

### REPORT Queries

Three mandatory reports, all returning `207 Multi-Status` XML:

- **calendar-query**: Filter events by component type, time range, and property values. This is the main sync
  mechanism for clients that don't support sync-token
- **calendar-multiget**: Batch-fetch specific events by URL (used after sync-token reveals changed URLs)
- **free-busy-query**: Aggregate busy times for a time range (returns `VFREEBUSY` iCalendar, not XML)
- **sync-collection** (RFC 6578): Incremental sync -- client sends previous sync-token, server returns only
  changes since that token. Preferred by modern clients (DAVx5, Apple Calendar)

### Properties Required

**On calendar collections (PROPFIND Depth:0):**

- `DAV:resourcetype` -- `<collection/>` + `<calendar/>`
- `DAV:displayname` -- calendar name
- `CALDAV:calendar-description`
- `CALDAV:calendar-timezone` -- default VTIMEZONE
- `CALDAV:supported-calendar-component-set` -- `VEVENT` (and optionally `VTODO`)
- `CS:getctag` -- Apple extension, all clients expect it
- `DAV:sync-token` -- RFC 6578
- `ICAL:calendar-color` -- Apple extension

**On the user principal:**

- `DAV:current-user-principal` -- who is logged in
- `CALDAV:calendar-home-set` -- URL of the calendar collection parent
- `DAV:principal-URL`

**On calendar objects:**

- `DAV:getetag`
- `DAV:getcontenttype` -- `text/calendar; charset=utf-8`
- `CALDAV:calendar-data` -- the iCalendar content

---

## Discovery Flow

Every CalDAV client performs this sequence on initial setup:

```
1. GET /.well-known/caldav
   -> 301 redirect to /dav/

2. PROPFIND /dav/  (Depth: 0)
   <- DAV:current-user-principal = /dav/principals/{userId}/

3. PROPFIND /dav/principals/{userId}/  (Depth: 0)
   <- CALDAV:calendar-home-set = /dav/calendars/{userId}/

4. PROPFIND /dav/calendars/{userId}/  (Depth: 1)
   <- List of calendar collections with displayname, color, ctag, etc.

5. REPORT on each calendar for events (calendar-query or sync-collection)
```

Apple Calendar and iOS **require** the `/.well-known/caldav` redirect. Thunderbird does not support auto-discovery --
users enter the full calendar URL manually.

---

## Authentication

CalDAV clients only support HTTP-level authentication:

- **HTTP Basic Auth** -- universally supported, simplest to implement
- **HTTP Digest Auth** -- supported by most clients, more complex server-side
- **Bearer tokens** -- not supported by most native CalDAV clients

Cookie/session auth (what Eigen uses via better-auth) **does not work** with CalDAV clients.

### Recommended approach

Add a `/dav/*` route prefix to Elysia that:

1. Extracts `Authorization: Basic <base64>` header
2. Validates against better-auth's credential store (email + password)
3. Or supports app-specific passwords (a separate password table for CalDAV access, better security practice)

App-specific passwords are worth considering since they:

- Don't expose the user's primary password to every CalDAV client
- Can be individually revoked
- Are standard practice (Google, Apple, Fastmail all use them for CalDAV)

### HTTPS

Eigen requires HTTPS for all instances, so this is already satisfied. CalDAV over HTTPS (sometimes called CalDAVS)
is the standard transport -- all major clients expect it, and iOS/DAVx5 refuse plain HTTP. Basic Auth credentials
are transmitted securely over TLS, so no additional transport-layer concerns.

DNS SRV auto-discovery (optional) uses the `_caldavs._tcp` record type (the `s` suffix denotes TLS).

---

## iCalendar Serialization

Converting between Eigen's JSON event model and iCalendar `.ics` format.

### JSON -> iCalendar (for GET/REPORT responses)

```
CalendarEvent {                     VEVENT {
  uid            ───────────────>     UID
  title          ───────────────>     SUMMARY
  description    ───────────────>     DESCRIPTION
  location       ───────────────>     LOCATION
  startTime      ───────────────>     DTSTART (epoch -> UTC or TZID)
  endTime        ───────────────>     DTEND
  allDay         ───────────────>     DTSTART;VALUE=DATE / DTEND;VALUE=DATE
  rrule          ───────────────>     RRULE
  timezone       ───────────────>     DTSTART;TZID= + VTIMEZONE component
  status         ───────────────>     STATUS (CONFIRMED/TENTATIVE/CANCELLED)
  sequence       ───────────────>     SEQUENCE
  data.attendees ───────────────>     ATTENDEE properties
  data.organizer ───────────────>     ORGANIZER property
  data.reminders ───────────────>     VALARM components
  data.url       ───────────────>     URL
  recurrenceDate ───────────────>     RECURRENCE-ID (on exception events)
}                                   }
```

### iCalendar -> JSON (for PUT requests from clients)

Reverse mapping. Parse with `ical.js`, extract known fields into the Eigen schema, and store the **raw `.ics` blob**
in a new column for properties we don't model (custom X-properties, unknown fields). This ensures round-trip
fidelity -- a requirement of CalDAV.

### Recommended library

**ical.js** (`npm: ical.js`): Full parser and generator, used internally by Thunderbird, handles VTIMEZONE, RRULE,
RECURRENCE-ID, VALARM, ATTENDEE, ORGANIZER. No native dependencies, works in Bun.

---

## Sync Mechanism

### CTag (already implemented)

Eigen's `calendars.ctag` increments on every event change. CalDAV clients poll this via PROPFIND to detect whether
a calendar has changed. If unchanged, no further sync needed.

### ETag (already implemented)

Eigen's `events.etag` (MD5 of event content) is used in `If-Match` headers for optimistic concurrency.

### Sync-token (needs implementation)

RFC 6578 `sync-collection` is the most efficient sync method. Implementation:

1. Use `ctag` as the basis: sync-token = `https://eigen.example/ns/sync/{ctag}`
2. Add a **deletion tombstone table**:
   ```sql
   CREATE TABLE event_tombstones (
     uri TEXT NOT NULL,
     calendarId TEXT NOT NULL,
     deletedAtCtag INTEGER NOT NULL  -- ctag value when deleted
   );
   ```
3. On `sync-collection` REPORT with token `ctag=N`:
    - Return events with `updatedAt > timestamp_of_ctag_N` (or just events where the calendar's ctag was > N at
      time of event change -- simpler: add an `eventCtag` column that records the ctag value at time of change)
    - Return tombstones where `deletedAtCtag > N` as `404` responses
    - Return current ctag as new sync-token
4. On initial sync (no token): return all events + current token
5. On expired token: return `410 Gone`, client does full re-sync

**Simpler alternative:** Add an `eventCtag INTEGER` column to events that records the calendar's ctag value at the
time of the last change. Then sync-collection for token N just queries `WHERE eventCtag > N`. Combined with
tombstones for deletions, this is complete.

---

## Shared & Team Calendars via CalDAV

### Shared calendars

CalDAV has native support for shared calendars via WebDAV ACL (RFC 3744). Eigen's existing share model maps to:

| Eigen Permission | CalDAV ACL Privilege             |
|------------------|----------------------------------|
| `free-busy`      | `CALDAV:read-free-busy`          |
| `read`           | `DAV:read`                       |
| `write`          | `DAV:read` + `DAV:write-content` |

Shared calendars appear in the recipient's calendar-home-set via `DAV:shared-owner` or can be surfaced as separate
collections with appropriate ACL.

### Team calendars

Team calendars could be exposed as additional collections in the user's calendar home, listed during PROPFIND
Depth:1 on the calendar home. They would appear alongside personal calendars with appropriate read/write ACL based
on team membership.

---

## Scheduling (RFC 6638)

Eigen's invitation system (invite-propagation.ts) already implements the core scheduling semantics:

| Eigen Feature                      | RFC 6638 Equivalent         |
|------------------------------------|-----------------------------|
| `propagateInvitation()`            | Auto-schedule REQUEST       |
| `propagateCancellation()`          | Auto-schedule CANCEL        |
| `propagateRsvp()`                  | Auto-schedule REPLY         |
| `propagateDecline()`               | REPLY with DECLINED         |
| Linked events (`organizerEventId`) | Scheduling object resources |
| `data.attendees[].status`          | `ATTENDEE;PARTSTAT=`        |
| `events.sequence`                  | `SEQUENCE`                  |

Full RFC 6638 support would additionally require:

- **Scheduling inbox/outbox collections** -- special collections at `/calendars/{userId}/inbox/` and `/outbox/`
- **SCHEDULE-TAG** header -- like ETag but only changes on scheduling-relevant modifications
- **iMIP gateway** -- for sending invitations to external (non-Eigen) users via email

RFC 6638 is optional for CalDAV compliance. The existing REST-based invitation system can coexist with CalDAV --
CalDAV clients would see the resulting events in their calendars, they just wouldn't trigger the invitation flow
via CalDAV PUT. A pragmatic first version can skip RFC 6638 and let the web UI handle invitations.

---

## Client Compatibility Notes

### Apple Calendar (macOS/iOS)

- **REQUIRES** `/.well-known/caldav` redirect
- Requires HTTPS (satisfied by Eigen's HTTPS requirement)
- Expects `CS:getctag` and `ICAL:calendar-color` (Apple extensions)
- Aggressive PROPFIND on every sync cycle
- Known bugs with non-standard ports on some iOS versions

### Thunderbird

- No auto-discovery -- users enter full calendar URL manually
- Each calendar added separately
- Solid CalDAV compliance, good for testing
- Supports scheduling extensions

### DAVx5 (Android)

- Prefers sync-collection (RFC 6578) when available
- Falls back to PROPFIND + ETag comparison
- Uses `If-None-Match: *` for new events, `If-Match` for updates
- Requires HTTPS (satisfied by Eigen's HTTPS requirement)
- Handles self-signed certificates

### GNOME Calendar

- Uses Evolution Data Server as backend
- Standard CalDAV compliance is sufficient
- Limited auto-discovery (no `/.well-known` support in GNOME Online Accounts)

---

## Existing Libraries

### Server-side

| Library                                           | Status          | Notes                                                                                                                                                      |
|---------------------------------------------------|-----------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **caldav-adapter** (@forwardemail/caldav-adapter) | Active (v9.3.2) | Koa/Express/Fastify middleware. Callback-based: you provide `getCalendar`, `getEventsForCalendar`, etc. Handles XML/WebDAV plumbing. Most practical option |
| **Nephele** (sciactive/nephele)                   | Active          | WebDAV only (RFC 4918), CalDAV not implemented yet                                                                                                         |
| **Fennel** (andris9/fennel)                       | Abandoned       | Node.js CalDAV/CardDAV with SQLite. Not maintained                                                                                                         |

**No Bun-native CalDAV library exists.** The caldav-adapter would need an Express compatibility layer or porting to
work with Elysia directly.

### iCalendar libraries

| Library            | Purpose                                                                    |
|--------------------|----------------------------------------------------------------------------|
| **ical.js**        | Full parser + generator, used by Thunderbird. Best for round-trip fidelity |
| **node-ical**      | Parser with RRULE expansion. TypeScript types                              |
| **ical-generator** | Generation only, lightweight                                               |

---

## Implementation Plan

### Phase 1: Read-only CalDAV (1-2 weeks)

Expose existing calendars and events as read-only CalDAV resources. This alone enables one-way sync to any CalDAV
client.

1. **Add `/dav/*` route group** to Elysia with Basic Auth
2. **Implement discovery chain**:
    - `GET /.well-known/caldav` -> redirect to `/dav/`
    - `PROPFIND /dav/` -> current-user-principal
    - `PROPFIND /dav/principals/{userId}/` -> calendar-home-set
    - `PROPFIND /dav/calendars/{userId}/` Depth:1 -> list calendars
3. **Implement `OPTIONS`** returning `DAV: 1, 2, access-control, calendar-access`
4. **Implement `PROPFIND`** on calendar collections (displayname, resourcetype, ctag, color, supported-components)
5. **Implement `GET`** on event resources (serialize JSON -> iCalendar using ical.js)
6. **Implement `REPORT calendar-query`** with time-range filter (reuse `getEventsInRange()`)
7. **Implement `REPORT calendar-multiget`** (batch GET by URL)

### Phase 2: Read-write CalDAV (1-2 weeks)

Enable full two-way sync.

1. **Implement `PUT`** for event creation/update:
    - Parse iCalendar -> JSON event fields
    - Handle `If-Match` / `If-None-Match` for conflict detection
    - Store raw `.ics` blob for round-trip fidelity
    - Map to `createEvent()` / `updateEvent()`
2. **Implement `DELETE`** for event removal
3. **Implement `MKCALENDAR`** for calendar creation
4. **Implement `PROPPATCH`** for calendar property changes (name, color)
5. **Add deletion tombstones** and implement `REPORT sync-collection`
6. **Add `eventCtag` column** for efficient sync queries

### Phase 3: Shared & team calendars (1 week)

1. **Expose shared calendars** in PROPFIND Depth:1 on calendar-home-set
2. **Apply ACL** based on share permissions (free-busy/read/write)
3. **Expose team calendars** as additional collections

### Phase 4: Scheduling (optional, 2+ weeks)

1. Implement scheduling inbox/outbox
2. Wire up auto-scheduling (PUT with ATTENDEE -> propagateInvitation)
3. Handle REPLY and CANCEL iTIP methods
4. Add SCHEDULE-TAG support

---

## Architecture Decision: Where to Mount

Two options for serving CalDAV alongside the existing REST API:

### Option A: Same Elysia server, `/dav/*` prefix

```
Port 8000:
  /api/*          -> existing REST API (cookie auth)
  /dav/*          -> CalDAV (Basic Auth)
  /.well-known/*  -> CalDAV discovery redirects
```

**Pros:** Single server, shared Calendar class, no IPC
**Cons:** Elysia doesn't natively support WebDAV methods (PROPFIND, REPORT, MKCALENDAR). Would need custom method
registration or a raw HTTP handler fallback.

Elysia does support custom HTTP methods via `.route()`:

```typescript
app.route('PROPFIND', '/dav/*', handler)
app.route('REPORT', '/dav/*', handler)
app.route('MKCALENDAR', '/dav/*', handler)
```

### Option B: Separate process, reverse-proxied

```
Port 8000: Elysia REST API
Port 8001: CalDAV server (Express + caldav-adapter or custom)

Nginx/Caddy:
  /api/*          -> :8000
  /dav/*          -> :8001
  /.well-known/*  -> :8001
```

**Pros:** Clean separation, can use Express-based caldav-adapter directly
**Cons:** Separate process, needs IPC or direct DB access for Calendar operations

### Recommendation

**Option A** (same server) is preferable. Elysia's `.route()` supports custom HTTP methods. The CalDAV layer can
directly call the Calendar class methods. The XML parsing/generation can be isolated in a `/dav/` route group. This
avoids the complexity of running and coordinating a second server process.

---

## Effort Summary

| Phase     | Scope                 | Effort         | Depends on                        |
|-----------|-----------------------|----------------|-----------------------------------|
| Phase 1   | Read-only CalDAV      | 1-2 weeks      | XML layer, iCal serialization     |
| Phase 2   | Read-write CalDAV     | 1-2 weeks      | Phase 1, tombstones, blob storage |
| Phase 3   | Shared/team calendars | ~1 week        | Phase 2                           |
| Phase 4   | Scheduling (RFC 6638) | 2+ weeks       | Phase 2, optional                 |
| **Total** | **Full CalDAV**       | **~4-7 weeks** |                                   |

The biggest single piece of work is the WebDAV XML layer (PROPFIND/REPORT parsing and multistatus response
generation). If caldav-adapter can be adapted for Elysia (or its XML utilities extracted), this shrinks
significantly.

---

## Risk Assessment

| Risk                                                            | Impact                               | Mitigation                                                         |
|-----------------------------------------------------------------|--------------------------------------|--------------------------------------------------------------------|
| Client quirks (each client expects slightly different behavior) | High -- users blame the server       | Test against Apple Calendar, Thunderbird, and DAVx5 from day one   |
| XML complexity (deeply nested, multi-namespace)                 | Medium -- verbose but well-specified | Use a library (fast-xml-parser) or extract from caldav-adapter     |
| Round-trip fidelity (losing unknown iCal properties)            | Medium -- data loss                  | Store raw `.ics` blob, merge on update                             |
| Recurrence expansion in REPORT queries                          | Low -- already implemented           | Reuse `getEventsInRange()` with time-range filter                  |
| Performance (PROPFIND Depth:1 on large calendars)               | Low -- SQLite is fast                | Pagination not required by CalDAV, ctag prevents unnecessary syncs |

---

## References

- [RFC 4791 -- CalDAV](https://datatracker.ietf.org/doc/html/rfc4791)
- [RFC 5545 -- iCalendar](https://datatracker.ietf.org/doc/html/rfc5545)
- [RFC 6578 -- WebDAV Sync](https://datatracker.ietf.org/doc/html/rfc6578)
- [RFC 6638 -- CalDAV Scheduling](https://datatracker.ietf.org/doc/rfc6638/)
- [RFC 3744 -- WebDAV ACL](https://datatracker.ietf.org/doc/html/rfc3744)
- [sabre/dav Integration Guide](https://sabre.io/dav/caldav-carddav-integration-guide/) -- best practical reference
- [caldav-adapter](https://github.com/forwardemail/caldav-adapter) -- Node.js CalDAV middleware
- [Cal.com CalDAV Challenges](https://cal.com/blog/the-intricacies-and-challenges-of-implementing-a-caldav-supporting-system-for-cal)
