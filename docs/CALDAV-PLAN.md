# CalDAV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CalDAV server to Eigen so Apple Calendar, Thunderbird, and DAVx5 can sync with Eigen calendars.

**Architecture:** Thin adapter layer on top of the existing `Calendar` class. Same Elysia server, `/dav/*` prefix, HTTP Basic Auth. CalDAV clients discover their calendar URL via a PROPFIND chain, then sync via REPORT queries and GET/PUT/DELETE on `.ics` resources. All XML request/response handling done with `fast-xml-parser` + template-literal builders.

**Tech Stack:** ical.js (iCal parse/generate), fast-xml-parser (XML parsing), timezones-ical-library (VTIMEZONE data)

**Full spec:** `docs/RESEARCH_CALDAV.md` — contains field mappings, XML examples, client quirks, and all details.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `apps/api/src/lib/calendar/schema.ts` | Add `icsBlob`, `eventCtag` columns, `eventTombstones` table |
| Modify | `apps/api/src/lib/calendar/db-config.ts` | Migration v2 |
| Modify | `apps/api/src/lib/calendar/calendar.ts` | New methods: getEventByUri, getRawEvents, upsertFromIcs, deleteByUri, tombstones |
| Modify | `packages/lib/src/types/calendar.ts` | Add `icsBlob`, `eventCtag` to CalendarEvent type |
| Create | `apps/api/src/lib/caldav/auth.ts` | HTTP Basic Auth extraction + verification |
| Create | `apps/api/src/lib/caldav/xml-builder.ts` | Multistatus XML response builders |
| Create | `apps/api/src/lib/caldav/xml-parser.ts` | PROPFIND/REPORT XML request parsing |
| Create | `apps/api/src/lib/caldav/ical-serialize.ts` | CalendarEvent → iCalendar text |
| Create | `apps/api/src/lib/caldav/ical-parse.ts` | iCalendar text → CalendarEvent fields |
| Create | `apps/api/src/lib/caldav/discovery.ts` | PROPFIND on /dav/, principals, calendar-home-set |
| Create | `apps/api/src/lib/caldav/propfind.ts` | PROPFIND on calendar collections |
| Create | `apps/api/src/lib/caldav/report.ts` | calendar-query, calendar-multiget, sync-collection |
| Create | `apps/api/src/lib/caldav/resource.ts` | GET/PUT/DELETE on individual .ics |
| Create | `apps/api/src/lib/caldav/proppatch.ts` | PROPPATCH + MKCALENDAR |
| Create | `apps/api/src/lib/caldav/caldav-router.ts` | Elysia route group, OPTIONS, wires all handlers |
| Modify | `apps/api/src/app.ts` | Register caldavRouter |
| Create | `apps/api/src/test/caldav.test.ts` | Integration tests |

## Dependency Graph

```
Task 1 (deps + schema)─────┐
Task 2 (XML utils)──────────┤
Task 3 (Basic Auth)─────────┤
                             ├──> Task 6 (Calendar methods) ──┐
Task 4 (iCal serialize)──┐  │                                 ├──> Task 9 (PROPFIND)
Task 5 (iCal parse)───┐  │  │                                 ├──> Task 10 (GET/PUT/DELETE)
                       │  │  │                                 ├──> Task 11 (REPORT)
                       │  │  │                                 ├──> Task 12 (MKCALENDAR+PROPPATCH)
                       │  │  │                                 │
                       └──┴──┴──> Task 7 (discovery)───────────┘
                                  Task 8 (router + OPTIONS)────┘
                                  Task 13 (wire up + test)
```

**Parallelizable rounds:**
- Round 1: Tasks 1, 2, 3, 4, 5 (all independent)
- Round 2: Tasks 6, 7, 8 (depend on Round 1)
- Round 3: Tasks 9, 10, 11, 12 (depend on Round 2)
- Round 4: Task 13 (integration)

---

## Task 1: Dependencies + Schema Migration

**Files:**
- Modify: `package.json` (root — install deps)
- Modify: `apps/api/src/lib/calendar/schema.ts`
- Modify: `apps/api/src/lib/calendar/db-config.ts`
- Modify: `packages/lib/src/types/calendar.ts`

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/reinder/Documents/GitHub/eigen
bun add ical.js fast-xml-parser --filter '@apps/api'
```

Note: `timezones-ical-library` is bundled with `ical.js` — no separate install needed.

- [ ] **Step 2: Add schema columns and tombstones table**

In `apps/api/src/lib/calendar/schema.ts`, add to the `events` table definition (after `updatedAt`):

```typescript
icsBlob: text('icsBlob'),
eventCtag: integer('eventCtag'),
```

Add new unique indexes to the events table (in the indexes function):

```typescript
uriCalendar: index('idx_events_uri_calendar').on(table.calendarId, table.uri),
uidCalendar: index('idx_events_uid_calendar').on(table.calendarId, table.uid),
```

Add new table after `sharedCalendars`:

```typescript
export const eventTombstones = sqliteTable(
    'event_tombstones',
    {
        uri: text('uri').notNull(),
        calendarId: text('calendarId').notNull(),
        deletedAtCtag: integer('deletedAtCtag').notNull(),
    },
    (table) => ({
        calCtag: index('idx_tombstones_cal_ctag').on(table.calendarId, table.deletedAtCtag),
    }),
);
```

- [ ] **Step 3: Add migration v2 in db-config.ts**

Add a version 2 migration that runs the ALTER TABLE and CREATE TABLE statements. Follow the existing
migration pattern in the file (version 1 creates the initial tables).

The migration SQL:
```sql
ALTER TABLE events ADD COLUMN icsBlob TEXT;
ALTER TABLE events ADD COLUMN eventCtag INTEGER;
CREATE TABLE event_tombstones (uri TEXT NOT NULL, calendarId TEXT NOT NULL, deletedAtCtag INTEGER NOT NULL);
CREATE INDEX idx_tombstones_cal_ctag ON event_tombstones(calendarId, deletedAtCtag);
CREATE UNIQUE INDEX idx_events_uri_calendar ON events(calendarId, uri);
CREATE UNIQUE INDEX idx_events_uid_calendar ON events(calendarId, uid);
```

- [ ] **Step 4: Update CalendarEvent type**

In `packages/lib/src/types/calendar.ts`, add to the `CalendarEvent` type:

```typescript
icsBlob: string | null;
eventCtag: number | null;
```

- [ ] **Step 5: Run check**

```bash
bun run check
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(caldav): add schema for icsBlob, eventCtag, and event tombstones"
```

---

## Task 2: XML Utilities

**Files:**
- Create: `apps/api/src/lib/caldav/xml-builder.ts`
- Create: `apps/api/src/lib/caldav/xml-parser.ts`

CalDAV uses XML with multiple namespaces. The builder produces `DAV:multistatus` responses. The parser
extracts requested properties from PROPFIND/REPORT XML bodies.

- [ ] **Step 1: Create xml-builder.ts**

This file exports functions that build XML response strings. Key functions:

```typescript
// Namespace prefixes used throughout
// DAV: = D, urn:ietf:params:xml:ns:caldav = C, http://calendarserver.org/ns/ = CS,
// http://apple.com/ns/ical/ = ICAL

export function multistatus(responses: string[]): string
// Wraps response elements in <D:multistatus> with all namespace declarations

export function response(href: string, propstats: string[]): string
// Single <D:response> element

export function propstat(status: string, props: string[]): string
// <D:propstat> with <D:status> and <D:prop>

export function calendarCollectionProps(calendar: CalendarItem, baseUrl: string): string
// Full propstat for a calendar: displayname, color, ctag, resourcetype, supported-component-set

export function eventResourceProps(event: { uri: string; etag: string }, baseUrl: string): string
// Propstat for an event: getetag, getcontenttype

export function eventResourceWithData(event: CalendarEvent, icsData: string, baseUrl: string): string
// Propstat with calendar-data included (for REPORT responses)

export function principalProps(userId: string): string
// current-user-principal response

export function calendarHomeSetProps(userId: string): string
// calendar-home-set response
```

Use template literals for XML construction — the shapes are well-defined. Include all namespace
declarations on the root `<D:multistatus>` element:
- `xmlns:D="DAV:"`
- `xmlns:C="urn:ietf:params:xml:ns:caldav"`
- `xmlns:CS="http://calendarserver.org/ns/"`
- `xmlns:ICAL="http://apple.com/ns/ical/"`

See `docs/RESEARCH_CALDAV.md` "Properties" section for the exact properties each response type needs.

- [ ] **Step 2: Create xml-parser.ts**

Parse incoming XML from PROPFIND and REPORT requests using `fast-xml-parser`.

```typescript
import { XMLParser } from 'fast-xml-parser';

type PropfindRequest = {
    propNames: string[];  // requested property names
};

type ReportRequest = {
    type: 'calendar-query' | 'calendar-multiget' | 'sync-collection';
    hrefs?: string[];        // for multiget: specific URIs to fetch
    timeRange?: { start: number; end: number };  // for calendar-query
    syncToken?: string;      // for sync-collection
    propNames: string[];
};

export function parsePropfind(xml: string): PropfindRequest
export function parseReport(xml: string): ReportRequest
```

Configure the XMLParser with `ignoreAttributes: false`, `attributeNamePrefix: '@_'`, and
`removeNSPrefix: false` to preserve namespace prefixes in the parsed output.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/caldav/
git commit -m "feat(caldav): add XML builder and parser utilities"
```

---

## Task 3: HTTP Basic Auth

**Files:**
- Create: `apps/api/src/lib/caldav/auth.ts`

- [ ] **Step 1: Implement Basic Auth extraction**

```typescript
import { getUserByEmail } from '../user';
import type { User } from '../../auth-schema';

export type CalDavUser = {
    id: string;
    email: string;
    name: string;
};

export async function authenticateBasic(request: Request): Promise<CalDavUser> {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Basic ')) {
        throw unauthorizedResponse();
    }

    const decoded = atob(authHeader.slice(6));
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) throw unauthorizedResponse();

    const email = decoded.slice(0, colonIndex);
    const password = decoded.slice(colonIndex + 1);

    const user = await getUserByEmail(email);
    if (!user) throw unauthorizedResponse();

    // TODO: validate password (app-specific passwords). For now, accept any password.
    return { id: user.id, email: user.email, name: user.name };
}

function unauthorizedResponse(): Response {
    return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Eigen CalDAV"' },
    });
}
```

Important: the `throw` of a `Response` object works in Elysia — it short-circuits and sends the response.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/caldav/auth.ts
git commit -m "feat(caldav): add HTTP Basic Auth for CalDAV"
```

---

## Task 4: iCalendar Serializer

**Files:**
- Create: `apps/api/src/lib/caldav/ical-serialize.ts`

Converts `CalendarEvent` → iCalendar text (`.ics` format). Uses `ical.js` for VTIMEZONE data.

- [ ] **Step 1: Implement serializer**

Key function:

```typescript
export function eventToIcs(event: CalendarEvent, calendarTimezone?: string): string
```

If `event.icsBlob` exists, return it as-is (round-trip fidelity for CalDAV-created events).

Otherwise, build a VCALENDAR string from the event fields:
- VCALENDAR wrapper with PRODID and VERSION
- VTIMEZONE component (if event.timezone is set — use `ICAL.TimezoneService` from ical.js)
- VEVENT with: UID, SUMMARY, DESCRIPTION, LOCATION, DTSTART, DTEND, RRULE, STATUS, SEQUENCE, CREATED, LAST-MODIFIED
- For all-day events: `DTSTART;VALUE=DATE:YYYYMMDD` (no time component)
- For timezone-aware events: `DTSTART;TZID=America/New_York:YYYYMMDDTHHMMSS`
- For UTC events: `DTSTART:YYYYMMDDTHHMMSSZ`
- ATTENDEE properties from `event.data?.attendees`
- ORGANIZER property from `event.data?.organizer`
- VALARM components from `event.data?.reminders`
- RECURRENCE-ID if `event.recurrenceDate` is set (this is an exception event)

Also export:

```typescript
export function eventsToIcs(events: CalendarEvent[], calendarTimezone?: string): string
```

For recurring events with exceptions: multiple VEVENT components in one VCALENDAR. Group events by
`uid` — the master event (no parentEventId) and its exceptions (with parentEventId) go in one `.ics`.

See `docs/RESEARCH_CALDAV.md` "iCalendar Serialization" section for the complete field mapping.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/caldav/ical-serialize.ts
git commit -m "feat(caldav): add iCalendar serializer (CalendarEvent -> .ics)"
```

---

## Task 5: iCalendar Parser

**Files:**
- Create: `apps/api/src/lib/caldav/ical-parse.ts`

Parses `.ics` text from CalDAV PUT requests into Eigen's event fields.

- [ ] **Step 1: Implement parser**

```typescript
import ICAL from 'ical.js';

type ParsedEvent = {
    uid: string;
    title: string;
    description: string | null;
    location: string | null;
    startTime: number;       // Unix epoch seconds
    endTime: number;
    allDay: boolean;
    rrule: string | null;    // Raw RRULE string (without "RRULE:" prefix)
    timezone: string | null; // IANA timezone ID
    status: 'confirmed' | 'tentative' | 'cancelled';
    sequence: number;
    recurrenceDate: string | null;  // YYYY-MM-DD for exception events
    data: EventData | null;
};

export function parseIcs(icsText: string): { events: ParsedEvent[]; raw: string }
```

Uses `ICAL.parse()` + `ICAL.Component` from ical.js. A single `.ics` can contain multiple VEVENTs
(master + exceptions). Return all of them.

For time parsing:
- `VALUE=DATE` → allDay=true, convert to midnight UTC epoch
- `TZID=...` → extract timezone, convert to UTC epoch
- UTC (`...Z`) → direct epoch conversion

For RRULE: extract the raw string (e.g., `FREQ=WEEKLY;BYDAY=MO,WE,FR`).

For attendees/organizer: parse into `EventData.attendees[]` and `EventData.organizer`.

For VALARM: parse into `EventData.reminders[]` (type + minutes before).

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/caldav/ical-parse.ts
git commit -m "feat(caldav): add iCalendar parser (.ics -> CalendarEvent fields)"
```

---

## Task 6: Calendar Class — New CalDAV Methods

**Files:**
- Modify: `apps/api/src/lib/calendar/calendar.ts`

Add the methods listed in `docs/RESEARCH_CALDAV.md` "Calendar Class Changes" section. These operate
on raw events (not expanded occurrences) and support CalDAV's URI-based addressing.

- [ ] **Step 1: Add getEventByUri, getRawEvents, getEventsByUris**

```typescript
public getEventByUri(calendarId: string, uri: string): CalendarEvent | null {
    return this.db.select().from(schema.events)
        .where(and(eq(schema.events.calendarId, calendarId), eq(schema.events.uri, uri)))
        .get() as CalendarEvent | null;
}

public getRawEvents(calendarId: string): CalendarEvent[] {
    return this.db.select().from(schema.events)
        .where(eq(schema.events.calendarId, calendarId))
        .all() as CalendarEvent[];
}

public getEventsByUris(calendarId: string, uris: string[]): CalendarEvent[] {
    return this.db.select().from(schema.events)
        .where(and(
            eq(schema.events.calendarId, calendarId),
            inArray(schema.events.uri, uris),
        ))
        .all() as CalendarEvent[];
}
```

- [ ] **Step 2: Add getRawEventsInRange**

For `calendar-query` with time-range: return master events (not expanded) that have ANY occurrence
in the range. Reuse existing `expandRecurrence()` to check overlap, but return the raw master event.

```typescript
public getRawEventsInRange(calendarId: string, from: number, to: number): CalendarEvent[] {
    // 1. Non-recurring events: direct time range check
    // 2. Recurring events: expand to check if any occurrence overlaps, include master if yes
    // 3. Include exception events whose parent is included
}
```

- [ ] **Step 3: Add sync-collection support methods**

```typescript
public getChangedEventsSince(calendarId: string, sinceCtag: number): CalendarEvent[] {
    return this.db.select().from(schema.events)
        .where(and(
            eq(schema.events.calendarId, calendarId),
            gt(schema.events.eventCtag, sinceCtag),
        ))
        .all() as CalendarEvent[];
}

public getDeletedEventsSince(calendarId: string, sinceCtag: number): { uri: string }[] {
    return this.db.select({ uri: schema.eventTombstones.uri })
        .from(schema.eventTombstones)
        .where(and(
            eq(schema.eventTombstones.calendarId, calendarId),
            gt(schema.eventTombstones.deletedAtCtag, sinceCtag),
        ))
        .all();
}
```

- [ ] **Step 4: Add upsertFromIcs and deleteByUri**

```typescript
public upsertFromIcs(calendarId: string, uri: string, parsedEvents: ParsedEvent[],
                     icsBlob: string, userId?: string): CalendarEvent
// If event with this URI exists: update it (check If-Match etag if provided)
// If not: create it
// Store icsBlob for round-trip fidelity
// Set eventCtag to current calendar ctag
// Increment calendar ctag

public deleteByUri(calendarId: string, uri: string): void
// Delete event, create tombstone, increment ctag
```

- [ ] **Step 5: Wire eventCtag into createEvent and updateEvent**

In existing `createEvent()` and `updateEvent()` methods, set `eventCtag` to the calendar's current
`ctag` value (before the ctag is incremented). This enables `sync-collection` queries.

In existing `deleteEvent()`, insert a tombstone before deleting:

```typescript
const event = this.getEventById(id);
if (event) {
    const cal = this.getCalendarById(event.calendarId);
    this.db.insert(schema.eventTombstones).values({
        uri: event.uri,
        calendarId: event.calendarId,
        deletedAtCtag: (cal?.ctag ?? 0) + 1,
    }).run();
}
```

- [ ] **Step 6: Fix ETag to include updatedAt**

Change `computeEtag()` to include `updatedAt` in the hash input (or use a simpler scheme like
`"${ctag}-${id}"`). This ensures ETags change on every update, which CalDAV clients rely on.

- [ ] **Step 7: Run check + commit**

```bash
bun run check
git add apps/api/src/lib/calendar/
git commit -m "feat(caldav): add Calendar class methods for CalDAV (URI lookup, raw events, sync, tombstones)"
```

---

## Task 7: Discovery Handlers

**Files:**
- Create: `apps/api/src/lib/caldav/discovery.ts`

Handles the PROPFIND chain from `/dav/` → principals → calendar-home-set.

- [ ] **Step 1: Implement discovery handlers**

```typescript
export function handleRootPropfind(userId: string): Response
// Returns multistatus with current-user-principal = /dav/principals/{userId}/

export function handlePrincipalPropfind(userId: string): Response
// Returns multistatus with calendar-home-set = /dav/calendars/{userId}/

export function handleCalendarHomePropfind(userId: string, calendars: CalendarItem[], depth: string): Response
// Depth 0: just the home collection properties
// Depth 1: home collection + each calendar as a child collection
```

All responses use `xml-builder.ts` functions. Status `207 Multi-Status`, content-type `application/xml; charset=utf-8`.

See `docs/RESEARCH_CALDAV.md` "Discovery Flow" for exact response structure.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/caldav/discovery.ts
git commit -m "feat(caldav): add CalDAV discovery PROPFIND handlers"
```

---

## Task 8: CalDAV Router + OPTIONS

**Files:**
- Create: `apps/api/src/lib/caldav/caldav-router.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Create the router**

The router uses Elysia's `.route()` for WebDAV methods and applies Basic Auth to all requests.

```typescript
import Elysia from 'elysia';
import { authenticateBasic } from './auth';
// ... import all handlers

export const caldavRouter = new Elysia({ name: 'caldav' })
    // OPTIONS — advertise DAV capabilities
    .options('/dav/*', ({ set }) => {
        set.headers['DAV'] = '1, 2, 3, calendar-access';
        set.headers['Allow'] = 'OPTIONS, GET, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR';
        return '';
    })

    // All other /dav/* routes require Basic Auth
    .route('PROPFIND', '/dav/', async ({ request }) => { ... })
    .route('PROPFIND', '/dav/principals/:ownerId', async ({ request, params }) => { ... })
    .route('PROPFIND', '/dav/principals/:ownerId/*', async ({ request, params }) => { ... })
    .route('PROPFIND', '/dav/calendars/:ownerId', async ({ request, params }) => { ... })
    .route('PROPFIND', '/dav/calendars/:ownerId/*', async ({ request, params }) => { ... })
    .route('REPORT', '/dav/calendars/:ownerId/*', async ({ request, params }) => { ... })
    .get('/dav/calendars/:ownerId/*', async ({ request, params }) => { ... })
    .put('/dav/calendars/:ownerId/*', async ({ request, params }) => { ... })
    .delete('/dav/calendars/:ownerId/*', async ({ request, params }) => { ... })
    .route('MKCALENDAR', '/dav/calendars/:ownerId/*', async ({ request, params }) => { ... })
    .route('PROPPATCH', '/dav/calendars/:ownerId/*', async ({ request, params }) => { ... })
```

Each handler: authenticate via `authenticateBasic(request)`, verify ownerId matches user, get the
user's Home + Calendar, delegate to the appropriate handler function, return the XML response.

Parse the wildcard path to extract `calendarId` and optional `eventUri` segments:
`/dav/calendars/{ownerId}/{calendarId}/{eventUri}` — split on `/`.

- [ ] **Step 2: Register in app.ts**

Add import and `.use(caldavRouter)` in `apps/api/src/app.ts`.

- [ ] **Step 3: Run check + commit**

```bash
bun run check
git add apps/api/src/lib/caldav/caldav-router.ts apps/api/src/app.ts
git commit -m "feat(caldav): add CalDAV router with OPTIONS and Basic Auth"
```

---

## Task 9: PROPFIND on Calendar Collections

**Files:**
- Create: `apps/api/src/lib/caldav/propfind.ts`

- [ ] **Step 1: Implement collection PROPFIND**

```typescript
export function handleCalendarPropfind(
    calendar: CalendarItem, events: CalendarEvent[], ownerId: string, depth: string
): Response
// Depth 0: calendar properties (displayname, color, ctag, resourcetype, supported-component-set)
// Depth 1: calendar properties + list of event resources (href + etag for each)
```

For Depth 1: include each event as a response element with just `getetag` and `getcontenttype`
(`text/calendar; charset=utf-8`). Clients use this to detect which events changed (by comparing
ETags) before fetching the full data.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/caldav/propfind.ts
git commit -m "feat(caldav): add PROPFIND handler for calendar collections"
```

---

## Task 10: Resource Handlers (GET/PUT/DELETE)

**Files:**
- Create: `apps/api/src/lib/caldav/resource.ts`

- [ ] **Step 1: Implement GET**

```typescript
export function handleGet(event: CalendarEvent, relatedEvents: CalendarEvent[]): Response
// Serialize event (+ exceptions sharing same uid) to .ics
// Return with Content-Type: text/calendar; charset=utf-8 and ETag header
```

`relatedEvents` includes the master + all exceptions with the same `uid`. Pass to `eventsToIcs()`.

- [ ] **Step 2: Implement PUT**

```typescript
export async function handlePut(
    calendar: Calendar, calendarId: string, uri: string,
    icsBody: string, ifMatch: string | null, ifNoneMatch: string | null
): Promise<Response>
// Parse .ics with ical-parse.ts
// If If-None-Match: * → create only (fail if exists)
// If If-Match: etag → update only (fail if etag mismatch)
// Call calendar.upsertFromIcs()
// Return 201 (created) or 204 (updated) with ETag header
```

- [ ] **Step 3: Implement DELETE**

```typescript
export function handleDelete(
    calendar: Calendar, calendarId: string, uri: string, ifMatch: string | null
): Response
// If If-Match and etag doesn't match → 412 Precondition Failed
// Call calendar.deleteByUri()
// Return 204 No Content
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/caldav/resource.ts
git commit -m "feat(caldav): add GET/PUT/DELETE handlers for .ics resources"
```

---

## Task 11: REPORT Handlers

**Files:**
- Create: `apps/api/src/lib/caldav/report.ts`

This is the most complex task. Three REPORT types.

- [ ] **Step 1: Implement calendar-query**

```typescript
export function handleCalendarQuery(
    calendar: Calendar, calendarId: string, ownerId: string,
    timeRange: { start: number; end: number } | undefined, propNames: string[]
): Response
// Uses getRawEventsInRange() if time-range filter, getRawEvents() otherwise
// Serialize each event to .ics
// Return multistatus with calendar-data for each event
```

- [ ] **Step 2: Implement calendar-multiget**

```typescript
export function handleCalendarMultiget(
    calendar: Calendar, calendarId: string, ownerId: string,
    hrefs: string[], propNames: string[]
): Response
// Extract URIs from hrefs, call getEventsByUris()
// Serialize each to .ics
// Return multistatus with calendar-data for each
// For missing URIs: include 404 response element
```

- [ ] **Step 3: Implement sync-collection**

```typescript
export function handleSyncCollection(
    calendar: Calendar, calendarId: string, calendarItem: CalendarItem,
    ownerId: string, syncToken: string | undefined, propNames: string[]
): Response
// Parse sync token: extract ctag number from "https://domain/ns/sync/{ctag}"
// No token (initial sync): return all events + current sync token
// With token: getChangedEventsSince(ctag) + getDeletedEventsSince(ctag)
// Changed events: 200 response with etag (and calendar-data if requested)
// Deleted events: 404 response with just the href
// New sync token: "https://domain/ns/sync/{currentCtag}"
// Invalid token: return 403 with DAV:valid-sync-token error
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/caldav/report.ts
git commit -m "feat(caldav): add REPORT handlers (calendar-query, multiget, sync-collection)"
```

---

## Task 12: MKCALENDAR + PROPPATCH

**Files:**
- Create: `apps/api/src/lib/caldav/proppatch.ts`

- [ ] **Step 1: Implement MKCALENDAR**

```typescript
export function handleMkcalendar(
    calendar: Calendar, calendarId: string, body: string
): Response
// Parse optional XML body for displayname and calendar-color
// Call calendar.createCalendar({ name, color })
// Return 201 Created
```

- [ ] **Step 2: Implement PROPPATCH**

```typescript
export function handleProppatch(
    calendar: Calendar, calendarId: string, body: string
): Response
// Parse XML body for property updates (displayname, calendar-color)
// Call calendar.updateCalendar(id, { name, color })
// Return 207 multistatus with success for each property
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/caldav/proppatch.ts
git commit -m "feat(caldav): add MKCALENDAR and PROPPATCH handlers"
```

---

## Task 13: Wire Up + Integration Test

**Files:**
- Create: `apps/api/src/test/caldav.test.ts`
- Verify: all routes working end-to-end

- [ ] **Step 1: Write integration test**

Using the existing test pattern (`getTestContext`, `authedRequest`), but with raw HTTP requests
(since CalDAV uses non-standard methods and XML bodies):

```typescript
import { describe, expect, test, beforeAll } from 'bun:test';
import { getTestContext } from './setup';
import { app } from '../app';

describe('CalDAV', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let userId: string;
    const basicAuth = (email: string) =>
        `Basic ${btoa(`${email}:testpassword`)}`;

    beforeAll(async () => {
        ctx = await getTestContext();
        userId = ctx.alice.user.id;
    });

    test('OPTIONS returns DAV header', async () => {
        const res = await app.handle(new Request('http://localhost/dav/', { method: 'OPTIONS' }));
        expect(res.headers.get('DAV')).toContain('calendar-access');
    });

    test('PROPFIND /dav/ returns current-user-principal', async () => {
        const res = await app.handle(new Request('http://localhost/dav/', {
            method: 'PROPFIND',
            headers: {
                Authorization: basicAuth(ctx.alice.user.email),
                Depth: '0',
            },
        }));
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain(`/dav/principals/${userId}/`);
    });

    test('PROPFIND calendar-home-set lists calendars', async () => {
        const res = await app.handle(new Request(`http://localhost/dav/calendars/${userId}/`, {
            method: 'PROPFIND',
            headers: {
                Authorization: basicAuth(ctx.alice.user.email),
                Depth: '1',
            },
        }));
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain('Personal');  // default calendar name
    });

    test('PUT creates event, GET retrieves it', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:test-event-1@eigen',
            'SUMMARY:Test Event',
            'DTSTART:20260401T100000Z',
            'DTEND:20260401T110000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        // Find the default calendar ID first
        const propfind = await app.handle(new Request(`http://localhost/dav/calendars/${userId}/`, {
            method: 'PROPFIND',
            headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '1' },
        }));
        const propXml = await propfind.text();
        // Extract a calendar href from the response
        const calMatch = propXml.match(/\/dav\/calendars\/[^/]+\/([^/]+)\//);
        expect(calMatch).not.toBeNull();
        const calId = calMatch![1];

        // PUT
        const putRes = await app.handle(new Request(
            `http://localhost/dav/calendars/${userId}/${calId}/test-event-1.ics`,
            {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar; charset=utf-8',
                    'If-None-Match': '*',
                },
                body: ics,
            },
        ));
        expect(putRes.status).toBe(201);
        expect(putRes.headers.get('ETag')).toBeTruthy();

        // GET
        const getRes = await app.handle(new Request(
            `http://localhost/dav/calendars/${userId}/${calId}/test-event-1.ics`,
            {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            },
        ));
        expect(getRes.status).toBe(200);
        const body = await getRes.text();
        expect(body).toContain('Test Event');
        expect(body).toContain('VCALENDAR');
    });

    test('DELETE removes event', async () => {
        // ... similar pattern: DELETE + verify GET returns 404
    });
});
```

- [ ] **Step 2: Run tests**

```bash
bun test apps/api/src/test/caldav.test.ts
```

- [ ] **Step 3: Run full check**

```bash
bun run check
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(caldav): add integration tests for CalDAV endpoints"
```

---

## Summary

| Task | What | Parallelizable with |
|------|------|-------------------|
| 1 | Schema + deps | 2, 3, 4, 5 |
| 2 | XML utilities | 1, 3, 4, 5 |
| 3 | Basic Auth | 1, 2, 4, 5 |
| 4 | iCal serializer | 1, 2, 3, 5 |
| 5 | iCal parser | 1, 2, 3, 4 |
| 6 | Calendar class methods | After 1 |
| 7 | Discovery PROPFIND | After 2, 3 |
| 8 | Router + OPTIONS | After 3 |
| 9 | Collection PROPFIND | After 2, 6 |
| 10 | GET/PUT/DELETE | After 4, 5, 6 |
| 11 | REPORT handlers | After 2, 4, 6 |
| 12 | MKCALENDAR + PROPPATCH | After 2, 6 |
| 13 | Integration test | After all |

**Estimated time with parallel agents: 3-5 hours.** Round 1 (Tasks 1-5) runs in parallel. Round 2
(Tasks 6-8) runs in parallel. Round 3 (Tasks 9-12) runs in parallel. Task 13 is sequential.
