# Calendar App — Architecture & Design

How to implement the Calendar backend (`apps/api`) and data model, fitting Eigen's architecture and philosophy.

## Summary

Calendar follows the **Contacts/Mail pattern**: a `Calendar` class owned by each `Home` singleton, storing data
in a per-user (or per-team) SQLite database at `{home}/eigen.calendar/calendar.db`. Sharing uses **push-based
propagation** (like Drive's `shared.db` / `acl-propagation.ts`) — not polling. Team calendars live in `TeamHome`
(like team drives). The schema is relational-first with CalDAV-ready columns (`uid`, `etag`, `ctag`, `uri`). RRULE is
stored as **RFC 5545** in the DB but exposed as a **JSON object** (`RecurrenceRule`) over the API for easier FE
development.

## Design Decisions

### 1. Storage: Per-User SQLite (like Contacts/Mail)

Calendar data belongs in the user's Home directory, not in Drive.

```
/data/home/{userId}/
├── eigen.calendar/
│   └── calendar.db
├── eigen.contacts/
│   └── contacts.db
├── eigen.mail/
│   └── mail.db
└── mounts/
    └── ...
```

**Why not Drive?** Calendars are not files. Users don't browse calendars in a file tree. Putting them in Drive would
couple calendar features to Drive's hierarchical ACL inheritance, which is designed for folder trees, not flat calendar
collections.

**Why not a central org-level database?** Breaks the per-user Home pattern. Every query would need user filtering,
backups become all-or-nothing. The Home-per-user model scales cleanly and matches Contacts and Mail.

### 2. Sharing: Push-Based Propagation (like Drive)

Drive solves this problem with push-based propagation:

1. Alice updates ACL on a path → `propagateACLChange()` resolves all affected users
2. For each user: `getHome(userId)` → `home.drive.receiveACLChange(path, newACL)`
3. The recipient's `shared.db` gets an insert/update/delete of the shared path

Calendar sharing works the same way:

1. Alice shares calendar "Team Events" with Bob → `propagateCalendarShare()` resolves Bob's userId
2. `getHome(bobId)` → `home.calendar.receiveShare(calendarInfo)`
3. Bob's `calendar.db` → `shared_calendars` table gets an insert (or update/delete on unshare)
4. Bob's calendar view queries his own `calendars` + `shared_calendars` — no cross-Home scanning

**The shares themselves live on the `calendars` table** as a JSON column (like `DrivePath.acl`), not in a separate
table. When shares change, the Calendar class propagates to affected recipients.

**Missed shares** (user doesn't exist yet, or new team member joins after share was created) are handled by the
**share registry** — see `docs/SHARE-PROPAGATION.md`. A lightweight table in the auth DB records pending share
relationships and reconciles them on account creation or team join.

### 3. Permissions: Three Levels

| Level      | Can see            | Can edit |
|------------|--------------------|----------|
| `free-busy` | Time blocks only (no titles, descriptions, or details) | No |
| `read`     | Full event details | No       |
| `write`    | Full event details | Yes      |

The `free-busy` level is essential for office use. A manager wants to see team availability without reading private
event titles. Google Calendar offers exactly these three levels. Cheap to include from the start.

### 4. CalDAV Readiness: Relational-First

The "store raw .ics alongside metadata" hybrid approach is standard for CalDAV servers but introduces a dual source of
truth: every update must modify both relational columns AND regenerate the .ics string.

**Start relational-only.** Include CalDAV-ready columns that cost nothing:

- `uid` — globally unique iCalendar UID (generated as UUID on create)
- `uri` — resource filename (`{uid}.ics`)
- `etag` — hash of canonical event data (changes on update, tells CalDAV clients to re-fetch)
- `ctag` — per-calendar counter that increments on any event change (tells CalDAV clients the collection changed)

When CalDAV is added later: add `icalData` TEXT column, generate .ics from relational data for CalDAV responses, parse
incoming .ics into relational columns on write.

### 5. Recurrence: RRULE in DB, JSON over API

The database stores **RFC 5545 RRULE strings** (CalDAV-ready). The API exposes a **`RecurrenceRule` JSON object** that
maps 1:1 to RRULE but is easier to work with in the frontend:

```typescript
type RecurrenceRule = {
    frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
    interval?: number          // default 1
    count?: number             // end after N occurrences
    until?: string             // ISO date string, e.g. "2026-12-31"
    byDay?: string[]           // ['MO', 'WE', 'FR'] — RFC 5545 day abbreviations
    byMonthDay?: number[]      // [1, 15]
    byMonth?: number[]         // [1, 6] (January, June)
    bySetPos?: number[]        // [-1] for "last weekday of month"
    weekStart?: string         // 'MO' (default), 'SU', etc.
}
```

**Conversion examples** (backend handles this transparently):

| `RecurrenceRule` JSON | RRULE in DB |
|-----------------------|-------------|
| `{ frequency: 'weekly', interval: 2, byDay: ['MO', 'WE', 'FR'] }` | `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR` |
| `{ frequency: 'monthly', byMonthDay: [15], count: 12 }` | `FREQ=MONTHLY;BYMONTHDAY=15;COUNT=12` |
| `{ frequency: 'yearly', byMonth: [3], byMonthDay: [11] }` | `FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=11` |
| `{ frequency: 'monthly', byDay: ['FR'], bySetPos: [-1] }` | `FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1` |

The conversion is a thin layer — just key renaming and array joining/splitting. Lives in
`packages/lib/src/core/calendar/rrule.ts` so both backend and frontend can use it. The `rrule` npm package
(or the existing `Recur` class in `calendar.test.ts`, adapted) handles **occurrence expansion** on the backend.

**Never store expanded occurrences.** A recurring event is one row with an `rrule` column. When the frontend requests
a date range, the backend expands recurrences in memory for that window.

**Recurrence exceptions** (cancelling or modifying a single occurrence) are stored as regular events in the `events`
table with two extra columns: `parentEventId` (FK → the recurring event) and `recurrenceDate` (the original occurrence
date being replaced). This follows the iCalendar model where a modified occurrence is just a VEVENT with RECURRENCE-ID.
No separate table needed — an exception IS an event.

- **Cancel an occurrence**: insert event with `parentEventId` set, `recurrenceDate` set, `status = 'cancelled'`
- **Modify an occurrence**: insert event with `parentEventId` set, `recurrenceDate` set, different title/time/etc.
- **When expanding**: query exceptions for the parent event, skip cancelled dates, substitute modified ones

### 6. Team Calendars

Teams own calendars directly, same pattern as team drives. `TeamHome` gets a `Calendar` instance:

```
/data/home/team_{teamId}/
├── eigen.calendar/
│   └── calendar.db
└── mounts/
    └── ...                 # Team drive already lives here
```

All team members access team calendars directly — no share propagation needed. Permission check:
`getMemberships(user.id).teamIds.includes(teamId)` (same as team drive).

This means share propagation only handles **user-to-user** sharing. Team calendars are a simpler, direct-access model.
See `docs/SHARE-PROPAGATION.md` for details.

### 7. Invitations & RSVP — How It Works Elsewhere

Understanding the standards matters for making good schema decisions now, even though full RSVP is a later phase.

**The standards:**

- **iTIP (RFC 5546)** — defines the scheduling protocol: METHOD:REQUEST (invite), METHOD:REPLY (RSVP),
  METHOD:CANCEL (cancel event)
- **iMIP (RFC 6047)** — iTIP over email. This is how Google Calendar and Outlook send invitations to external users.
  The invite is an email with a `.ics` attachment containing `METHOD:REQUEST`.

**How Google Calendar / Outlook work in practice:**

1. Organizer creates event with attendees → system sends REQUEST
2. **Same provider** (e.g., both on Gmail): direct database write. Google creates the event in both calendars instantly.
3. **Cross provider** (Gmail → Outlook): iMIP email with .ics attachment. Recipient's client parses it.
4. Attendee accepts/declines → REPLY sent back. Organizer's copy updated.
5. **Where events live**: each participant has their own copy. The organizer's copy is the source of truth for updates.
   Attendees have a linked copy with their personal RSVP status.

**For Eigen (all users on same server):**

Since all users share the same Eigen instance, invitations can use direct server-side propagation (no email needed):

1. Organizer creates event with attendees in their calendar
2. System writes a **linked event** to each attendee's default calendar via `getHome(attendeeId)` →
   `home.calendar.receiveInvitation(event)`
3. Linked event stores `organizerUserId` + `organizerEventId` pointing back to the original
4. Attendee RSVPs → updates their local copy → propagates status back to organizer's attendee list
5. Organizer updates event → propagates changes to all attendee copies

This is the same push-based pattern as sharing and Drive ACL propagation. The `data` JSON column on events stores the
attendees list: `[{email, status: 'pending'|'accepted'|'declined'|'tentative', role: 'required'|'optional'}]`.

**Future**: when Eigen gets external email integration, iMIP can be added on top using the Mail system.

## Schema

### Table: `calendars`

| Column      | Type    | Description                                                                |
|-------------|---------|----------------------------------------------------------------------------|
| `id`        | TEXT PK | UUID                                                                       |
| `name`      | TEXT    | Display name ("Personal", "Work", "Team Events")                           |
| `color`     | TEXT    | Hex color code                                                             |
| `isDefault` | INTEGER | Boolean. The user's primary calendar (created on init, cannot be deleted). |
| `ctag`      | INTEGER | Increments on any event change. CalDAV-ready.                              |
| `shares`    | TEXT    | JSON: `CalendarShare[]` or null. Like `DrivePath.acl`.                     |
| `createdAt` | INTEGER | Unix timestamp                                                             |
| `updatedAt` | INTEGER | Unix timestamp                                                             |

`CalendarShare`:
```typescript
type CalendarShare = {
    targetId: string       // email address or team_{id}
    permission: 'free-busy' | 'read' | 'write'
}
```

### Table: `events`

| Column           | Type    | Description                                                   |
|------------------|---------|---------------------------------------------------------------|
| `id`             | TEXT PK | UUID                                                          |
| `calendarId`     | TEXT FK | → calendars.id                                                |
| `uid`            | TEXT    | iCalendar UID (UUID, globally unique). CalDAV-ready.          |
| `uri`            | TEXT    | Resource filename (`{uid}.ics`). CalDAV-ready.                |
| `title`          | TEXT    | Event summary/title                                           |
| `description`    | TEXT    | Event description                                             |
| `location`       | TEXT    | Event location                                                |
| `startTime`      | INTEGER | Unix timestamp (indexed for range queries)                    |
| `endTime`        | INTEGER | Unix timestamp (indexed for range queries)                    |
| `allDay`         | INTEGER | Boolean. All-day events use date-only semantics.              |
| `rrule`          | TEXT    | RFC 5545 RRULE string (DB only). Null = non-recurring.        |
| `parentEventId`  | TEXT FK | → events.id, nullable. Set for recurrence exceptions.        |
| `recurrenceDate` | TEXT    | ISO date (`2026-03-15`), nullable. Original occurrence date.  |
| `status`         | TEXT    | `confirmed` / `tentative` / `cancelled`                       |
| `etag`           | TEXT    | Hash of event data. CalDAV-ready.                             |
| `data`           | TEXT    | JSON: attendees, reminders, custom properties                 |
| `createdAt`      | INTEGER | Unix timestamp                                                |
| `updatedAt`      | INTEGER | Unix timestamp                                                |

**Indexes**: `(calendarId, startTime)`, `(calendarId, endTime)`, `(parentEventId)`.

The `data` JSON column (same pattern as `contacts.data`) stores structured fields that don't need direct SQL querying:
attendees, reminders, organizer info. Keeps the table lean while being extensible. When attendees/RSVP become important
enough, they can be promoted to a proper table (data is throwaway per Eigen philosophy).

### Table: `shared_calendars`

This is the **recipient-side** table, populated via push propagation (like Drive's `shared_paths` in `shared.db`).

| Column          | Type    | Description                                                         |
|-----------------|---------|---------------------------------------------------------------------|
| `id`            | TEXT PK | UUID                                                                |
| `ownerUserId`   | TEXT    | userId of the calendar owner                                        |
| `calendarId`    | TEXT    | id of the calendar in the owner's DB                                |
| `calendarName`  | TEXT    | Cached display name (updated on propagation)                        |
| `calendarColor` | TEXT    | Owner's color (recipient can override locally)                      |
| `permission`    | TEXT    | `free-busy` / `read` / `write`                                     |
| `color`         | TEXT    | Local color override, nullable                                      |
| `visible`       | INTEGER | Boolean. Toggle visibility without unsubscribing.                   |
| `createdAt`     | INTEGER | Unix timestamp                                                      |
| `updatedAt`     | INTEGER | Unix timestamp                                                      |

**How sharing works end-to-end:**

1. Alice creates calendar "Team Events" and sets `shares: [{targetId: 'bob@eigen.local', permission: 'write'},
   {targetId: 'team_engineering', permission: 'read'}]`
2. `propagateCalendarShare()` resolves all affected users (by email → `getUserByEmail`, by team → `getTeamMembers`)
3. For each user: `getHome(userId)` → `home.calendar.receiveShare(...)` → insert/update/delete in `shared_calendars`
4. Bob's calendar view queries: own `calendars` table + `shared_calendars` table. No cross-Home scanning.
5. For each shared calendar, Bob's frontend fetches events via `GET /calendar/:aliceId/calendars/:calId/events`
6. The route handler checks Alice's `calendars.shares` to verify Bob has access before returning data.
7. Bob can toggle `visible` and override `color` locally on his `shared_calendars` entry.

## API Data Format

What the backend accepts and returns. These types live in `packages/lib/src/types/calendar.ts` and are used by both
the Elysia routes and the frontend hooks.

### Calendar

```typescript
type CalendarShare = {
    targetId: string                              // email or team_{id}
    permission: 'free-busy' | 'read' | 'write'
}

type CalendarItem = {
    id: string
    name: string
    color: string                                 // hex, e.g. "#4285f4"
    isDefault: boolean
    shares: CalendarShare[] | null
    createdAt: number                             // unix timestamp
    updatedAt: number
}
```

**Create** (`POST /calendar/:ownerId/calendars`):
```json
{
    "name": "Work",
    "color": "#4285f4"
}
```

**Update** (`PUT /calendar/:ownerId/calendars/:id`):
```json
{
    "name": "Work Projects",
    "color": "#34a853",
    "shares": [
        { "targetId": "bob@eigen.local", "permission": "write" },
        { "targetId": "team_engineering", "permission": "read" }
    ]
}
```
All fields optional. When `shares` changes, propagation runs.

**Response** — list and single calendar return `CalendarItem`:
```json
{
    "id": "a1b2c3d4-...",
    "name": "Work Projects",
    "color": "#34a853",
    "isDefault": false,
    "shares": [
        { "targetId": "bob@eigen.local", "permission": "write" },
        { "targetId": "team_engineering", "permission": "read" }
    ],
    "createdAt": 1741718400,
    "updatedAt": 1741718400
}
```

### Event

```typescript
type CalendarEvent = {
    id: string
    calendarId: string
    uid: string                                   // iCalendar UID (auto-generated)
    title: string
    description: string | null
    location: string | null
    startTime: number                             // unix timestamp
    endTime: number                               // unix timestamp
    allDay: boolean
    rrule: RecurrenceRule | null                    // JSON object (converted to/from RRULE in DB)
    parentEventId: string | null                  // set for recurrence exceptions
    recurrenceDate: string | null                 // ISO date, e.g. "2026-03-15"
    status: 'confirmed' | 'tentative' | 'cancelled'
    data: EventData | null
    createdAt: number
    updatedAt: number
}

type EventData = {
    reminders?: Reminder[]
    attendees?: Attendee[]                        // Phase 2
    organizer?: { userId: string, email: string } // Phase 2, set on linked events
    organizerEventId?: string                     // Phase 2, set on linked events
    url?: string
    notes?: string
    color?: string                                // per-event color override
}

type Reminder = {
    type: 'notification' | 'email'
    minutes: number                               // minutes before event (e.g. 10, 30, 1440)
}

type Attendee = {
    email: string
    status: 'pending' | 'accepted' | 'declined' | 'tentative'
    role: 'required' | 'optional'
}
```

**Create** (`POST /calendar/:ownerId/calendars/:calId/events`):
```json
{
    "title": "Weekly Sync",
    "startTime": 1741773600,
    "endTime": 1741777200,
    "allDay": false,
    "description": "Sprint progress review",
    "location": "Meeting Room A",
    "rrule": { "frequency": "weekly", "byDay": ["WE"] },
    "data": {
        "reminders": [{ "type": "notification", "minutes": 10 }]
    }
}
```

Minimal create (only required fields):
```json
{
    "title": "Lunch",
    "startTime": 1741780800,
    "endTime": 1741784400,
    "allDay": false
}
```

All-day event:
```json
{
    "title": "Company Holiday",
    "startTime": 1741737600,
    "endTime": 1741824000,
    "allDay": true
}
```

**Update** (`PUT /calendar/:ownerId/events/:id`) — partial, all fields optional:
```json
{
    "title": "Weekly Sync (updated)",
    "location": "Room B",
    "data": {
        "reminders": [
            { "type": "notification", "minutes": 10 },
            { "type": "notification", "minutes": 1440 }
        ]
    }
}
```

**Cancel a single recurrence** (`POST /calendar/:ownerId/calendars/:calId/events`):
```json
{
    "title": "Weekly Sync",
    "startTime": 1742378400,
    "endTime": 1742382000,
    "allDay": false,
    "parentEventId": "a1b2c3d4-...",
    "recurrenceDate": "2026-03-19",
    "status": "cancelled"
}
```

**Modify a single recurrence** (same route, different time/title):
```json
{
    "title": "Weekly Sync (moved)",
    "startTime": 1742464800,
    "endTime": 1742468400,
    "allDay": false,
    "parentEventId": "a1b2c3d4-...",
    "recurrenceDate": "2026-03-19"
}
```

### Events Response (Range Query)

`GET /calendar/:ownerId/events?from=1741737600&to=1742342400` returns a flat list with recurring events expanded
into individual **occurrences** for the requested range:

```json
[
    {
        "id": "a1b2c3d4-...",
        "calendarId": "cal-1",
        "uid": "a1b2c3d4-...",
        "title": "Weekly Sync",
        "startTime": 1741773600,
        "endTime": 1741777200,
        "allDay": false,
        "rrule": { "frequency": "weekly", "byDay": ["WE"] },
        "status": "confirmed",
        "location": "Meeting Room A",
        "description": "Sprint progress review",
        "data": { "reminders": [{ "type": "notification", "minutes": 10 }] },
        "recurrenceDate": null,
        "parentEventId": null,
        "createdAt": 1741718400,
        "updatedAt": 1741718400,
        "occurrenceDate": "2026-03-12"
    },
    {
        "id": "a1b2c3d4-...",
        "calendarId": "cal-1",
        "uid": "a1b2c3d4-...",
        "title": "Weekly Sync (moved)",
        "startTime": 1742464800,
        "endTime": 1742468400,
        "allDay": false,
        "rrule": null,
        "status": "confirmed",
        "location": "Meeting Room A",
        "description": "Sprint progress review",
        "data": null,
        "recurrenceDate": "2026-03-19",
        "parentEventId": "a1b2c3d4-...",
        "createdAt": 1741718400,
        "updatedAt": 1741718400,
        "occurrenceDate": "2026-03-20"
    }
]
```

Each item in the response is a **CalendarEventOccurrence** — the full event data plus an `occurrenceDate` field
(ISO date string) indicating which date this instance falls on. For non-recurring events, `occurrenceDate` equals
the event's start date. For recurring events, it's the specific occurrence date within the range.

```typescript
type CalendarEventOccurrence = CalendarEvent & {
    occurrenceDate: string    // ISO date, e.g. "2026-03-12"
}
```

Cancelled occurrences are **excluded** from the response (the backend skips them during expansion). Modified
occurrences are **substituted** (the exception event replaces the original occurrence at that date).

### Free-Busy Response

When the requester has `free-busy` permission, the events endpoint returns stripped data:

```json
[
    {
        "startTime": 1741773600,
        "endTime": 1741777200,
        "allDay": false,
        "status": "confirmed"
    }
]
```

No title, description, location, data, or any identifying fields. Just time blocks and status.

```typescript
type FreeBusyBlock = {
    startTime: number
    endTime: number
    allDay: boolean
    status: 'confirmed' | 'tentative'
}
```

### Shared Calendar (Recipient View)

```typescript
type SharedCalendar = {
    id: string                // local record id
    ownerUserId: string
    calendarId: string        // id in the owner's DB
    calendarName: string
    calendarColor: string     // owner's color
    permission: 'free-busy' | 'read' | 'write'
    color: string | null      // local override
    visible: boolean
    createdAt: number
    updatedAt: number
}
```

`GET /calendar/:ownerId/shared` returns the user's `SharedCalendar[]` list. The frontend uses `ownerUserId` +
`calendarId` to fetch events: `GET /calendar/:ownerUserId/calendars/:calendarId/events?from=...&to=...`.

## Backend Architecture

### File Structure

```
apps/api/src/lib/calendar/
├── calendar.ts              # Calendar class (business logic)
├── schema.ts                # Drizzle schema
├── db-config.ts             # CALENDAR_DB_CONFIG with migrations
├── share-propagation.ts     # Push shares to recipient Homes (like acl-propagation.ts)
└── sse-events.ts            # SSE event builders

apps/api/src/routes/
└── calendar.ts              # Elysia routes

packages/lib/src/types/
└── calendar.ts              # Shared types

packages/lib/src/core/calendar/
├── hooks/
│   └── use-calendar.ts      # Query hooks + invalidation functions
├── sse-handlers.ts          # SSE cache invalidation handlers
└── index.ts                 # Re-exports
```

### Calendar Class

```typescript
export class Calendar {
    private managedDb!: ManagedDatabase<typeof schema>;
    private db!: BunSQLiteDatabase<typeof schema>;
    private home: Home;

    constructor(home: Home) { ... }
    async init() { ... }       // Open DB, create default "Personal" calendar
    async destruct() { ... }   // Close DB

    // Calendars
    async getCalendars(): Promise<CalendarItem[]>
    async createCalendar(cal: CreateCalendar): Promise<string>
    async updateCalendar(id: string, cal: UpdateCalendar): Promise<void>
    async deleteCalendar(id: string): Promise<void>  // cannot delete default

    // Events
    async getEventsInRange(calendarId: string, from: number, to: number): Promise<CalendarEvent[]>
    async getAllEventsInRange(from: number, to: number): Promise<CalendarEvent[]>
    async createEvent(calendarId: string, event: CreateEvent): Promise<string>
    async updateEvent(id: string, event: UpdateEvent): Promise<void>
    async deleteEvent(id: string): Promise<void>

    // Sharing (owner-side)
    async updateShares(calendarId: string, shares: CalendarShare[]): Promise<void>

    // Shared calendars (recipient-side, called by propagation)
    async receiveShare(share: IncomingShare): Promise<void>
    async getSharedCalendars(): Promise<SharedCalendar[]>
    async updateSharedCalendar(id: string, prefs: { color?: string, visible?: boolean }): Promise<void>

    // Internals
    private expandRecurrences(events: RawEvent[], from: number, to: number): CalendarEvent[]
    private bumpCtag(calendarId: string): Promise<void>
    private computeEtag(event: CalendarEvent): string
}
```

### Share Propagation

```typescript
// apps/api/src/lib/calendar/share-propagation.ts
// Mirrors apps/api/src/lib/drive/acl-propagation.ts exactly

export async function propagateCalendarShare(
    calendar: { id: string, name: string, color: string, shares: CalendarShare[] | null },
    ownerUserId: string,
    oldShares: CalendarShare[] | null,
    newShares: CalendarShare[] | null
): Promise<void> {
    const userIds = new Set<string>();

    for (const share of [...(oldShares || []), ...(newShares || [])]) {
        const parsed = parseOwnerId(share.targetId);
        if (parsed.type === 'user') {
            const user = await getUserByEmail(share.targetId);
            if (user) userIds.add(user.id);
        } else if (parsed.type === 'team') {
            const members = await getTeamMembers(parsed.id);
            for (const m of members) userIds.add(m.user.id);
        }
    }

    for (const userId of userIds) {
        const home = await getHome(userId);
        await home.calendar.receiveShare({ ownerUserId, calendar, newShares });
    }
}
```

### Home Integration

```typescript
// home.ts — add to Home:
public calendar!: Calendar;

// user-home.ts — add to UserHome constructor:
this.calendar = new Calendar(this);

// team-home.ts — add to TeamHome constructor:
this.calendar = new Calendar(this);

// home.ts init() — add:
await this.calendar?.init();

// home.ts destruct() — add calendar cleanup
// home.ts size() — add calendar size
```

### Routes

```
GET    /calendar/:ownerId/calendars                              → list user's calendars
POST   /calendar/:ownerId/calendars                              → create calendar
PUT    /calendar/:ownerId/calendars/:id                          → update calendar (incl. shares)
DELETE /calendar/:ownerId/calendars/:id                          → delete calendar

GET    /calendar/:ownerId/events?from=...&to=...                 → all events in range (all own calendars)
GET    /calendar/:ownerId/calendars/:calId/events?from=...&to=.. → events for one calendar in range
POST   /calendar/:ownerId/calendars/:calId/events                → create event
PUT    /calendar/:ownerId/events/:id                             → update event
DELETE /calendar/:ownerId/events/:id                             → delete event

GET    /calendar/:ownerId/shared                                 → list shared-with-me calendars
PUT    /calendar/:ownerId/shared/:id                             → update local prefs (color, visible)
DELETE /calendar/:ownerId/shared/:id                             → remove shared calendar from view

GET    /calendar/:ownerId/shared-with-me                         → pull route (see SHARE-PROPAGATION.md)
```

`ownerId` can be a user ID or `team_{teamId}`. When it's a team ID, the route resolves to the team's `Calendar`
via `getHome('team_' + teamId)`. Permission check: `getMemberships(user.id).teamIds.includes(teamId)`.

Note: shares are updated via `PUT /calendar/:ownerId/calendars/:id` (the shares are a field on the calendar, like
`DrivePath.acl`). No separate share routes needed. Team calendars don't use shares — access is implicit via team
membership.

The `GET /calendar/:ownerId/calendars/:calId/events` endpoint serves both own and shared calendars. When Bob requests
events from Alice's calendar, the route handler calls `getHome(aliceId)`, checks `calendars.shares` for Bob's access
(via `parseOwnerId` + `getMemberships`), and returns events. For `free-busy` permission, it strips titles/descriptions
and returns only time blocks.

### SSE Events

```typescript
// packages/lib/src/types/sse.ts — add:
CALENDAR_CREATED: 'calendar:calendar-created',
CALENDAR_UPDATED: 'calendar:calendar-updated',
CALENDAR_DELETED: 'calendar:calendar-deleted',
CALENDAR_EVENT_CREATED: 'calendar:event-created',
CALENDAR_EVENT_UPDATED: 'calendar:event-updated',
CALENDAR_EVENT_DELETED: 'calendar:event-deleted',
CALENDAR_SHARED: 'calendar:shared',
CALENDAR_UNSHARED: 'calendar:unshared',
```

When events change on a shared calendar, SSE fires on the **owner's** Home. If Bob writes to Alice's calendar, the
SSE fires on Alice's Home (updating her open tabs). Bob's frontend cache is invalidated via the mutation's `onSuccess`.

The share propagation also emits `CALENDAR_SHARED`/`CALENDAR_UNSHARED` on the **recipient's** Home (via
`receiveShare()`), so their open tabs update the shared calendars list.

## Use Cases — What Office Users Expect

### Personal Calendars

Every user gets a default "Personal" calendar on first init (like Contacts creates default labels). They can create
additional calendars ("Work", "Side Projects") to organize events with different colors.

### Team Calendar

A team lead creates a calendar on `team_engineering` via `POST /calendar/team_engineering/calendars`. All team members
can read and write events directly — no share propagation needed. New team members get access automatically via
`getMemberships()`. Sprint ceremonies, deadlines, retrospectives all live in the team's own `calendar.db`.

### Company-Wide Calendar

An admin creates "Company Holidays" and shares it `read` to `org_{orgId}`. Everyone sees public holidays, company
events, all-hands. Only the admin can edit. Resolution via `getMemberships(userId).orgIds`.

### Manager Availability View

A manager shares their calendar `free-busy` with their team (or vice versa: reports share `free-busy` with manager).
The manager sees time blocks only — "busy 9-10", "busy 14-16" — without seeing private event titles like "Doctor" or
"Interview at CompanyX". This is the standard expectation in corporate environments and why `free-busy` exists as a
separate level.

### Meeting Scheduling (Phase 3)

Alice creates "Weekly Sync" on her calendar with attendees `[bob@eigen.local, charlie@eigen.local]`. The system:

1. Writes event to Alice's calendar
2. Pushes linked copies to Bob's and Charlie's default calendars (via `receiveInvitation()`)
3. Bob/Charlie see the invite, can accept/decline/tentative
4. RSVP status propagates back to Alice's attendee list

### Birthday Calendar

Computed on the fly from `home.contacts.getContacts()` — no storage needed. The API injects birthday events into the
events response as a virtual read-only calendar.

## Implementation Phases

### Phase 1 — Core + Sharing

- `Calendar` class in `apps/api/src/lib/calendar/`
- Schema: `calendars` (with `shares` JSON), `events` (with `parentEventId`/`recurrenceDate`), `shared_calendars`
- Routes: CRUD for calendars and events, shared calendar view, team calendar access
- Share propagation (`share-propagation.ts`) for user-to-user shares
- Team calendars via `TeamHome` (direct access, no propagation)
- Permission checks on cross-user and team calendar access
- `RecurrenceRule` JSON ↔ RFC 5545 RRULE conversion (`packages/lib/src/core/calendar/rrule.ts`)
- Recurrence expansion on the backend
- Default "Personal" calendar on init (user calendars only)
- SSE events
- Frontend hooks in `packages/lib/src/core/calendar/`
- Types in `packages/lib/src/types/calendar.ts`
- API tests (see Testing section)

Sharing is in Phase 1 because a calendar app without sharing is barely useful in an office setting.

### Phase 2 — Invitations & Attendees

- Attendees in `data` JSON (`[{email, status, role}]`)
- `receiveInvitation()` / `receiveInvitationUpdate()` propagation methods
- RSVP flow with status propagation back to organizer
- SSE notifications for invitations

### Phase 3 — CalDAV

- Add `icalData` TEXT column
- CalDAV protocol endpoints (PROPFIND, REPORT, PUT, DELETE)
- `ctag`/`etag` sync protocol
- iCalendar ↔ relational conversion
- iMIP email integration via Mail system for external invites

## Testing

API tests live in `apps/api/src/test/calendar.test.ts` together with the rest of test suite. Make sure it fits this suite and uses the same test users and teams as other tests. Run with `bun test test`.

### Calendar CRUD

- Create calendar with name and color → returns id, verify fields
- Update calendar name, color
- Delete non-default calendar → succeeds
- Delete default calendar → fails
- Init creates default "Personal" calendar automatically
- List calendars returns own calendars

### Event CRUD

- Create event with all fields → verify all fields returned correctly
- Create event with minimal fields (title, startTime, endTime, allDay) → defaults applied
- Create all-day event → `allDay: true`, date-only semantics
- Update event (partial) → only specified fields change, `updatedAt` bumped
- Delete event → no longer returned
- `etag` changes on update
- `ctag` increments on any event change in the calendar
- `uid` and `uri` auto-generated on create

### RecurrenceRule ↔ RRULE Conversion

- `{ frequency: 'weekly', byDay: ['MO', 'WE', 'FR'] }` → `FREQ=WEEKLY;BYDAY=MO,WE,FR`
- `{ frequency: 'monthly', byMonthDay: [15], count: 12 }` → `FREQ=MONTHLY;BYMONTHDAY=15;COUNT=12`
- `{ frequency: 'yearly', byMonth: [3], byMonthDay: [11] }` → `FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=11`
- `{ frequency: 'monthly', byDay: ['FR'], bySetPos: [-1] }` → `FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1`
- `{ frequency: 'daily', interval: 3 }` → `FREQ=DAILY;INTERVAL=3`
- Round-trip: JSON → RRULE → JSON is identity
- RRULE → JSON → RRULE is identity
- Omitted optional fields (interval=1, no count/until) produce clean RRULE without redundant parts

### Recurrence Expansion

- Daily recurrence: returns correct dates in range
- Weekly with `byDay: ['MO', 'WE', 'FR']`: returns only those weekdays
- Monthly with `byMonthDay: [15]`: returns 15th of each month in range
- Yearly: returns correct date each year
- `interval: 2` (every other week/month): skips correctly
- `count: 5`: stops after 5 occurrences
- `until: '2026-06-30'`: stops at date
- Events outside requested range are excluded
- Events that START before range but RECUR into range are included
- `occurrenceDate` is correct for each expanded instance

### Recurrence Exceptions

- Cancel occurrence: create exception with `parentEventId` + `recurrenceDate` + `status: 'cancelled'`
  → cancelled date excluded from expanded results
- Modify occurrence: create exception with `parentEventId` + `recurrenceDate` + different title/time
  → modified event substituted at that date
- Multiple exceptions on same recurring event: all applied correctly
- Exception for non-existent recurrence date: handled gracefully

### Sharing (User-to-User)

- Share calendar with user → recipient's `shared_calendars` updated
- Unshare → removed from recipient's `shared_calendars`
- Update share permission (read → write) → recipient's record updated
- Share with non-existent email → share registry entry created (no error)
- Recipient fetches events from shared calendar → succeeds with correct permission
- `free-busy` permission: response contains only time blocks (no title, description, location)
- `read` permission: full event data returned, write rejected
- `write` permission: full event data returned, write succeeds
- Unauthorized user (no share) → 403

### Team Calendars

- Create calendar on `team_{teamId}` → stored in team's `calendar.db`
- Team member can list team calendars
- Team member can create/read/update/delete events on team calendar
- Non-member cannot access team calendar → 403
- `getMemberships()` correctly resolves team access

### Range Queries

- `GET /events?from=...&to=...` returns only events overlapping the range
- All-day events at range boundaries included correctly
- Recurring event with no occurrences in range → not returned
- Large range with many recurring events → returns all expanded occurrences
- Empty range → empty array

### SSE

- Event created/updated/deleted → SSE fired on owner's Home
- Calendar shared → `CALENDAR_SHARED` SSE on recipient's Home
- Calendar unshared → `CALENDAR_UNSHARED` SSE on recipient's Home

## Files

| File                                                   | Purpose                                        |
|--------------------------------------------------------|------------------------------------------------|
| `apps/api/src/lib/calendar/calendar.ts`                | Calendar class (business logic)                |
| `apps/api/src/lib/calendar/calendar.test.ts`           | API tests                                      |
| `apps/api/src/lib/calendar/schema.ts`                  | Drizzle ORM schema                             |
| `apps/api/src/lib/calendar/db-config.ts`               | CALENDAR_DB_CONFIG + migrations                |
| `apps/api/src/lib/calendar/share-propagation.ts`       | Push shares to recipients (like Drive)         |
| `apps/api/src/lib/calendar/sse-events.ts`              | SSE event builders                             |
| `apps/api/src/routes/calendar.ts`                      | Elysia route definitions                       |
| `packages/lib/src/types/calendar.ts`                   | Shared types (incl. `RecurrenceRule`)          |
| `packages/lib/src/core/calendar/rrule.ts`              | RecurrenceRule ↔ RRULE conversion              |
| `packages/lib/src/core/calendar/hooks/use-calendar.ts` | Query hooks + invalidation                     |
| `packages/lib/src/core/calendar/sse-handlers.ts`       | SSE → cache invalidation                       |
| `apps/api/src/lib/core/constants.ts`                   | Add `PATHS.CALENDAR`                           |
| `apps/api/src/lib/home/home.ts`                        | Add `calendar` property                        |
| `apps/api/src/lib/home/user-home.ts`                   | Initialize Calendar in UserHome                |
| `apps/api/src/lib/home/team-home.ts`                   | Initialize Calendar in TeamHome                |
| `apps/api/src/app.ts`                                  | Register `calendarRouter`                      |
| `packages/lib/src/types/sse.ts`                        | Add calendar SSE event types                   |
