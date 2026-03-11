# Calendar App — Architecture & Design

This document is a deep analysis of how to implement the Calendar backend (`apps/api`) and data model, fitting
Eigen's architecture patterns and philosophy.

## Executive Summary

Calendar follows the **Contacts/Mail pattern**: a `Calendar` class owned by each user's `Home` singleton, storing data
in a per-user SQLite database at `{home}/eigen.calendar/calendar.db`. Sharing is handled via a calendar-specific ACL
model (not Drive), using the same `parseOwnerId` / team-membership infrastructure. The schema is designed
relational-first for simplicity, with specific columns (`uid`, `etag`, `ctag`, `uri`) that make future CalDAV adoption
painless.

## Design Decisions

### 1. Storage: Per-User SQLite (like Contacts/Mail)

Calendar data belongs in the user's Home directory, not in Drive.

```
/data/home/{userId}/
├── eigen.calendar/
│   └── calendar.db        # All calendar + event data
├── eigen.contacts/
│   └── contacts.db
├── eigen.mail/
│   └── mail.db
└── mounts/
    └── ...
```

**Why not Drive?** Calendars are not files. Users don't browse calendars in a file tree. Putting them in Drive would
require awkward mapping between calendar semantics and file/folder operations, and would couple calendar features to
Drive's ACL inheritance model (which is designed for hierarchical folder trees, not flat calendar collections).

**Why not a central org-level database?** It breaks the per-user Home pattern. Every query would need user filtering,
backups become all-or-nothing, and it's a single point of failure. The Home-per-user model scales cleanly and matches
how Contacts and Mail already work.

### 2. Sharing: Calendar-Specific ACL (not Drive ACL)

Drive's ACL system is powerful but designed for **hierarchical folder trees** with additive inheritance. Calendars are
**flat collections** — a user has a handful of calendars, each with explicit sharing rules. The inheritance model
(child inherits parent permissions, purely additive) doesn't apply.

Calendar sharing is simpler and self-contained:

- A calendar has a **shares list**: `[{targetId, permission}]` — similar to `DriveACL` but without inheritance.
- `targetId` uses the same format as Drive ACL: email addresses for users, `team_{id}` for teams.
- Permissions are `read` or `write` (write implies read).
- Resolution uses the existing `parseOwnerId()` and `getMemberships()` from `apps/api/src/lib/user/user.ts`.

This reuses Eigen's identity infrastructure without coupling to Drive's tree-based ACL logic.

### 3. CalDAV Readiness: Relational-First, Not Hybrid

The "store raw .ics alongside metadata columns" approach (hybrid storage) is the standard for CalDAV servers. But it
introduces a **dual source of truth** problem: every update must modify both the relational columns AND regenerate the
raw .ics string. They can drift.

**Recommendation: start relational-only.** Include CalDAV-ready columns (`uid`, `etag`, `ctag`, `uri`) that cost
nothing, but skip `icalData` for now.

When CalDAV is added later:

1. Add an `icalData` TEXT column.
2. **CalDAV → web**: Parse incoming .ics into relational columns + store raw.
3. **Web → CalDAV**: Generate .ics on the fly from relational data for CalDAV responses.
4. The `etag` (hash of canonical event data) tells CalDAV clients whether anything changed.

This is clean because Eigen's development philosophy explicitly allows breaking data between features — no migration
baggage.

### 4. Recurrence: Expand On Query, Not On Write

Recurring events (RRULE) are stored as a single row with an `rrule` column. When the frontend requests events for a
date range, the backend expands recurrences in memory for that window.

There's already a working recurrence engine in `apps/calendar/calendar.test.ts` (`Recur`, `PlainDate`, `Rule`) that
handles daily/monthly frequencies with `BYDAY`/`BYMONTHDAY`. This should move to a shared location
(`packages/lib/src/core/calendar/` or `apps/api/src/lib/calendar/`) and be used server-side for expansion.

Recurrence exceptions (cancelling or modifying a single occurrence) are stored in a separate table, referencing the
parent event and the original occurrence date.

## Schema

### Table: `calendars`

| Column        | Type    | Description                                                     |
|---------------|---------|-----------------------------------------------------------------|
| `id`          | TEXT PK | UUID                                                            |
| `name`        | TEXT    | Display name ("Personal", "Work", "Team Events")                |
| `color`       | TEXT    | Hex color code                                                  |
| `description` | TEXT    | Optional description                                            |
| `isDefault`   | INTEGER | Boolean. The user's primary calendar (created on init).         |
| `ctag`        | INTEGER | Increments on any change to events in this calendar. CalDAV-ready. |
| `createdAt`   | INTEGER | Unix timestamp                                                  |
| `updatedAt`   | INTEGER | Unix timestamp                                                  |

### Table: `events`

| Column          | Type    | Description                                                        |
|-----------------|---------|--------------------------------------------------------------------|
| `id`            | TEXT PK | UUID                                                               |
| `calendarId`    | TEXT FK | → calendars.id                                                     |
| `uid`           | TEXT    | Globally unique iCalendar UID. CalDAV-ready.                       |
| `uri`           | TEXT    | Resource filename (`{uid}.ics`). CalDAV-ready.                     |
| `title`         | TEXT    | Event summary                                                      |
| `description`   | TEXT    | Event description                                                  |
| `location`      | TEXT    | Event location                                                     |
| `startTime`     | INTEGER | Unix timestamp (indexed for range queries)                         |
| `endTime`       | INTEGER | Unix timestamp (indexed for range queries)                         |
| `allDay`        | INTEGER | Boolean. All-day events store date-only (midnight-to-midnight).    |
| `rrule`         | TEXT    | RFC 5545 RRULE string (nullable). Null = non-recurring.            |
| `status`        | TEXT    | `confirmed` / `tentative` / `cancelled`                            |
| `etag`          | TEXT    | Hash of canonical event data. CalDAV-ready.                        |
| `data`          | TEXT    | JSON blob for extended fields (reminders, attendees, custom props) |
| `createdAt`     | INTEGER | Unix timestamp                                                     |
| `updatedAt`     | INTEGER | Unix timestamp                                                     |

**Indexes**: `(calendarId, startTime)`, `(calendarId, endTime)` — critical for range queries.

The `data` JSON column follows the same pattern as Contacts (`contacts.data`): structured fields that don't need direct
SQL querying go here. This keeps the table lean while being extensible.

### Table: `recurrence_exceptions`

| Column               | Type    | Description                                               |
|----------------------|---------|-----------------------------------------------------------|
| `id`                 | TEXT PK | UUID                                                      |
| `eventId`            | TEXT FK | → events.id (the parent recurring event)                  |
| `originalDate`       | TEXT    | ISO date of the occurrence being modified (`2026-03-15`)   |
| `replacementEventId` | TEXT FK | → events.id (modified occurrence, nullable)               |
| `cancelled`          | INTEGER | Boolean. True = this occurrence is simply cancelled.       |

This is the standard CalDAV/iCalendar model: EXDATE for cancellations, modified VEVENT with RECURRENCE-ID for changes.

### Table: `calendar_shares`

| Column       | Type    | Description                                          |
|--------------|---------|------------------------------------------------------|
| `id`         | TEXT PK | UUID                                                 |
| `calendarId` | TEXT FK | → calendars.id                                       |
| `targetId`   | TEXT    | User email or `team_{id}` (same format as DriveACL)  |
| `permission` | TEXT    | `read` or `write`                                    |
| `createdAt`  | INTEGER | Unix timestamp                                       |

### Table: `calendar_subscriptions`

| Column         | Type    | Description                                          |
|----------------|---------|------------------------------------------------------|
| `id`           | TEXT PK | UUID                                                 |
| `ownerUserId`  | TEXT    | userId of the calendar owner                         |
| `calendarId`   | TEXT    | id of the calendar in the owner's DB                 |
| `displayName`  | TEXT    | Cached name (in case owner renames, until re-synced) |
| `color`        | TEXT    | Local color override (nullable)                      |
| `visible`      | INTEGER | Boolean. Toggle visibility in UI without unsubscribing. |
| `createdAt`    | INTEGER | Unix timestamp                                       |

**How sharing works end-to-end:**

1. Alice creates calendar "Team Events" and shares it with Bob (write) and team "Engineering" (read).
2. Entries go in Alice's `calendar_shares` table.
3. Bob calls `GET /calendar/:bobId/available-shares` → API checks all Homes for calendars shared with Bob
   (by email or team membership).
4. Bob subscribes → entry in Bob's `calendar_subscriptions`.
5. Bob's calendar view loads his own calendars + subscribed calendars (fetching events from each owner's Home).
6. Bob can toggle visibility and override colors locally.
7. When Bob creates an event on Alice's "Team Events" (if write permission), the API writes to Alice's
   `calendar.db` and emits SSE to Alice's Home.

## Backend Architecture

### File Structure

```
apps/api/src/lib/calendar/
├── calendar.ts          # Calendar class (business logic)
├── schema.ts            # Drizzle schema
├── db-config.ts         # CALENDAR_DB_CONFIG with migrations
└── sse-events.ts        # SSE event builders

apps/api/src/routes/
└── calendar.ts          # Elysia routes

packages/lib/src/types/
└── calendar.ts          # Shared types

packages/lib/src/core/calendar/
├── hooks/
│   └── use-calendar.ts  # Query hooks + invalidation functions
├── sse-handlers.ts      # SSE cache invalidation handlers
└── index.ts             # Re-exports
```

### Calendar Class

```typescript
// apps/api/src/lib/calendar/calendar.ts
export class Calendar {
    private managedDb!: ManagedDatabase<typeof schema>;
    private db!: BunSQLiteDatabase<typeof schema>;
    private home: Home;

    constructor(home: Home) { ... }
    async init() { ... }       // Open DB, create default calendar if needed
    async destruct() { ... }   // Close DB

    // Calendars
    async getCalendars(): Promise<CalendarItem[]>
    async createCalendar(cal: Omit<CalendarItem, 'id'>): Promise<string>
    async updateCalendar(id: string, cal: Partial<CalendarItem>): Promise<void>
    async deleteCalendar(id: string): Promise<void>

    // Events
    async getEvents(calendarId: string, from: number, to: number): Promise<CalendarEvent[]>
    async getAllEvents(from: number, to: number): Promise<CalendarEvent[]>
    async createEvent(calendarId: string, event: Omit<CalendarEvent, 'id'>): Promise<string>
    async updateEvent(id: string, event: Partial<CalendarEvent>): Promise<void>
    async deleteEvent(id: string): Promise<void>

    // Sharing
    async getShares(calendarId: string): Promise<CalendarShare[]>
    async shareCalendar(calendarId: string, targetId: string, permission: string): Promise<void>
    async unshareCalendar(calendarId: string, shareId: string): Promise<void>

    // Subscriptions
    async getSubscriptions(): Promise<CalendarSubscription[]>
    async subscribe(ownerUserId: string, calendarId: string): Promise<void>
    async unsubscribe(subscriptionId: string): Promise<void>

    // CalDAV-ready
    private bumpCtag(calendarId: string): Promise<void>
    private computeEtag(event: CalendarEvent): string
}
```

### Home Integration

```typescript
// apps/api/src/lib/home/home.ts — add:
public calendar!: Calendar;

// apps/api/src/lib/home/user-home.ts — add:
this.calendar = new Calendar(this);

// init(), destruct(), size() — add calendar alongside contacts/mail
```

### Routes

Following the contacts pattern (`/contacts/:ownerId/...`):

```
GET    /calendar/:ownerId/calendars                              → list calendars
POST   /calendar/:ownerId/calendars                              → create calendar
PUT    /calendar/:ownerId/calendars/:id                          → update calendar
DELETE /calendar/:ownerId/calendars/:id                          → delete calendar

GET    /calendar/:ownerId/events?from=...&to=...                 → all events in range
GET    /calendar/:ownerId/calendars/:calId/events?from=...&to=.. → events for one calendar
POST   /calendar/:ownerId/calendars/:calId/events                → create event
PUT    /calendar/:ownerId/events/:id                             → update event
DELETE /calendar/:ownerId/events/:id                             → delete event

GET    /calendar/:ownerId/calendars/:calId/shares                → list shares
POST   /calendar/:ownerId/calendars/:calId/shares                → share calendar
DELETE /calendar/:ownerId/calendars/:calId/shares/:id            → unshare

GET    /calendar/:ownerId/subscriptions                          → list subscriptions
POST   /calendar/:ownerId/subscriptions                          → subscribe
PUT    /calendar/:ownerId/subscriptions/:id                      → update (visibility, color)
DELETE /calendar/:ownerId/subscriptions/:id                      → unsubscribe
```

The `GET /calendar/:ownerId/events?from=...&to=...` endpoint is the workhorse: it queries all the user's own calendars,
expands recurring events within the range, and returns a flat list. The frontend can combine this with subscription data
fetched from other users' Homes.

### Cross-User Calendar Access

When Bob reads events from Alice's shared calendar:

1. Bob's frontend calls `GET /calendar/:aliceId/calendars/:calId/events?from=...&to=...`
2. The route handler gets Alice's Home: `getHome(aliceId)`
3. It checks Alice's `calendar_shares` for an entry matching Bob (by email or team membership)
4. If authorized, returns events from Alice's calendar
5. Uses the same `parseOwnerId()` + `getMemberships()` pattern as Drive ACL

This mirrors how `getSharedDrive(ownerId, user)` in `apps/api/src/lib/drive/get-drive.ts` works.

### SSE Events

Following the SSE checklist from `docs/SSE.md`:

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

When an event is created/updated/deleted on a shared calendar, the Calendar class emits SSE on the **owner's** Home.
If Bob writes to Alice's calendar, the event fires on Alice's Home listeners. Bob's frontend gets its cache invalidated
via the mutation's `onSuccess` callback (immediate), and Alice's open tabs get SSE (cross-tab).

For Bob's own frontend cache of Alice's calendar data, the subscription system should also notify subscribers.
A lightweight approach: when writing to a shared calendar, also emit SSE to the **writer's** Home (if different from
owner).

## Use Cases — What Office Users Expect

### Personal Calendars

Every user gets a default "Personal" calendar on first init (like Contacts creates default labels). They can create
additional calendars ("Work", "Side Projects") to organize events.

### Team Calendar

A team lead creates a "Sprint Planning" calendar and shares it write-access to the `team_engineering` team. All
engineering team members can add sprint ceremonies, deadlines, and retrospectives. New team members automatically
get access (resolved via `getMemberships` at query time, not at share time).

### Company-Wide Calendar

An admin creates "Company Holidays" and shares it read-only at the org level. Everyone sees public holidays,
company events, and all-hands meetings. Only the admin (or designated HR) can edit it.

Implementation: share with a special `org_{orgId}` target. Resolution via `getMemberships(userId).orgIds`.

### Manager Visibility

A manager subscribes to their reports' personal calendars (with their consent — the report must share read access).
The manager sees an overlay view of team availability. They don't need to see event details — just busy/free blocks.

Future enhancement: a "free/busy" permission level that shows time blocks without titles/descriptions.

### Meeting Scheduling

Alice creates "Weekly Sync" on her calendar and adds Bob and Charlie as attendees (stored in the event's `data` JSON).
The system creates a copy of the event in Bob's and Charlie's default calendars. RSVP status is tracked in the
`data.attendees` array.

This is Phase 3 complexity. For Phase 1, events are single-owner and don't propagate.

### Room/Resource Booking

Create a pseudo-user or dedicated calendar for each room ("Meeting Room A"). Share write access to the relevant team.
Conflicts are checked at event creation time.

This is Phase 4/future and doesn't require schema changes — it's just a calendar with special semantics.

### Birthday Calendar

Integration with Contacts: auto-generate a read-only "Birthdays" calendar from contacts that have birthday fields set.
This doesn't need to be stored — it can be computed on the fly from `home.contacts.getContacts()` and injected into the
events response.

## Implementation Phases

### Phase 1 — Core (MVP)

- `Calendar` class in `apps/api/src/lib/calendar/`
- Schema: `calendars`, `events`, `recurrence_exceptions`
- Routes: CRUD for calendars and events
- Recurrence expansion for date ranges
- Default "Personal" calendar on init
- SSE events for real-time updates
- Frontend hooks in `packages/lib/src/core/calendar/`
- Types in `packages/lib/src/types/calendar.ts`

### Phase 2 — Sharing

- Schema: `calendar_shares`, `calendar_subscriptions`
- Share/unshare routes with permission checks
- Cross-user calendar access via `getHome(ownerId)`
- Subscription management (visibility, color overrides)
- Team-based sharing via `getMemberships()`

### Phase 3 — Invitations & Attendees

- Event attendees in `data` JSON (email, status, role)
- Event propagation to attendees' calendars
- RSVP flow (accept/decline/tentative)
- SSE notifications for invitations

### Phase 4 — CalDAV

- Add `icalData` column for raw .ics storage
- CalDAV protocol endpoints (PROPFIND, REPORT, PUT, DELETE)
- `ctag`/`etag` sync protocol
- iCalendar generation from relational data
- iCalendar parsing into relational columns

## Data Layout

```
/data/home/{userId}/
├── eigen.calendar/
│   └── calendar.db          # calendars, events, shares, subscriptions
├── eigen.contacts/
│   └── contacts.db
├── eigen.mail/
│   └── mail.db
└── mounts/
    └── ...
```

## Files (After Implementation)

| File                                                   | Purpose                                    |
|--------------------------------------------------------|--------------------------------------------|
| `apps/api/src/lib/calendar/calendar.ts`                | Calendar class (business logic)            |
| `apps/api/src/lib/calendar/schema.ts`                  | Drizzle ORM schema                         |
| `apps/api/src/lib/calendar/db-config.ts`               | CALENDAR_DB_CONFIG + migrations            |
| `apps/api/src/lib/calendar/sse-events.ts`              | SSE event builders                         |
| `apps/api/src/routes/calendar.ts`                      | Elysia route definitions                   |
| `packages/lib/src/types/calendar.ts`                   | Shared types                               |
| `packages/lib/src/core/calendar/hooks/use-calendar.ts` | Query hooks + invalidation                 |
| `packages/lib/src/core/calendar/sse-handlers.ts`       | SSE → cache invalidation                   |
| `apps/api/src/lib/core/constants.ts`                   | Add `PATHS.CALENDAR`                       |
| `apps/api/src/lib/home/home.ts`                        | Add `calendar` property                    |
| `apps/api/src/lib/home/user-home.ts`                   | Initialize Calendar in constructor         |
| `apps/api/src/app.ts`                                  | Register `calendarRouter`                  |
| `packages/lib/src/types/sse.ts`                        | Add calendar SSE event types               |
