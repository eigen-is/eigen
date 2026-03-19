# Backend Calendar Code Review

> Reviewed: 2026-03-19
> Scope: `apps/api/src/lib/calendar/`, `apps/api/src/routes/calendar.ts`, shared types, all calendar test files

## Architecture Overview

The calendar domain implements a per-user/per-team SQLite calendar system with CalDAV-ready schema design,
timezone-aware
RRULE recurrence expansion, push-based calendar sharing, invitation propagation with linked event copies, and
per-occurrence RSVP. The implementation spans seven domain files (~1200 lines of business logic in `calendar.ts` alone)
plus a thin route file, backed by four integration test files.

### Core Components

| File                                              | Lines | Purpose                                                                                                                |
|---------------------------------------------------|-------|------------------------------------------------------------------------------------------------------------------------|
| `apps/api/src/lib/calendar/calendar.ts`           | ~1209 | Calendar class: all business logic for calendars, events, invitations, RSVP, recurrence expansion, timezone conversion |
| `apps/api/src/lib/calendar/get-calendar.ts`       | ~94   | Access resolution (`resolveCalendar`, `resolveCalendarForEvents`, `syncTeamCalendars`)                                 |
| `apps/api/src/lib/calendar/schema.ts`             | ~59   | Drizzle ORM schema: `calendars`, `events`, `sharedCalendars` tables                                                    |
| `apps/api/src/lib/calendar/db-config.ts`          | ~72   | Database config with single v1 migration                                                                               |
| `apps/api/src/lib/calendar/share-propagation.ts`  | ~103  | Push calendar shares to recipients + SSE notifications                                                                 |
| `apps/api/src/lib/calendar/invite-propagation.ts` | ~153  | Push invitations to attendees, RSVP propagation to organizers                                                          |
| `apps/api/src/lib/calendar/sse-events.ts`         | ~92   | SSE event builders with notification templates                                                                         |
| `apps/api/src/routes/calendar.ts`                 | ~197  | Elysia route definitions (thin delegation layer)                                                                       |
| `packages/lib/src/types/calendar.ts`              | ~130  | Shared TypeScript types used by FE and BE                                                                              |

### Data Model

**Storage**: Per-user SQLite at `{home}/eigen.calendar/calendar.db`. Teams at
`data/team/{teamId}/eigen.calendar/calendar.db`.

**Event model**: Events are rows in the `events` table. Recurring events store an RFC 5545 RRULE string. Occurrences are
never stored -- they are expanded in-memory via the `rrule` npm package during range queries. Recurrence exceptions
(modifications or cancellations) are regular event rows with `parentEventId` + `recurrenceDate` set. A foreign key
cascade ensures exceptions are deleted when their parent is deleted.

**Invitation model**: The organizer creates an event with `data.attendees[]`. The server writes a "linked copy" to each
attendee's default calendar, setting `organizerEventId`/`organizerUserId` to point back at the source. The linked-event
guard (`updateEvent` lines 359-366) restricts attendee modifications to `data.reminders` and `data.color` only. RSVP
status flows back to the organizer via `propagateRsvp()`.

**Sharing model**: Push-based propagation. When shares change on a calendar, `propagateCalendarShare()` resolves target
users (email) and team members, then writes/removes `shared_calendars` entries in each recipient's database. Team
calendars are lazy-synced into users' `shared_calendars` on every `GET /calendar/:ownerId/shared` call via
`syncTeamCalendars()`.

**Timezone-aware recurrence**: Events can store a `timezone` string. When present, `expandRecurrence()` converts the
event's UTC start time to wall-clock time in that timezone, runs the RRule expansion in wall-clock space, then converts
results back to real UTC using `localToUtcSeconds()`. This prevents DST drift (e.g., a 23:30 CET event staying at
23:30 CEST after spring-forward, rather than drifting to 00:30).

### Access Resolution Flow

1. **Own calendars** (`resolveCalendar`): `ownerId` matches `user.id` or is a team the user belongs to. Returns the
   Calendar class directly with full access for calendar CRUD.
2. **Shared event access** (`resolveCalendarForEvents`): Resolves permission level (`free-busy`/`read`/`write`) based
   on calendar shares. Team members get at least `read` by default. Permission is enforced at the route layer.
3. **Team calendar sync** (`syncTeamCalendars`): Called on every shared-list read. Iterates user's team memberships,
   ensures `shared_calendars` entries exist with correct permissions, and also re-resolves permissions on user-owned
   shared calendars as a safety net.

---

## Issues

### Critical

#### C1. `resolveCalendarForEvents` hardcodes `write` permission for all team members

**File**: `apps/api/src/lib/calendar/get-calendar.ts`, lines 29-37

```typescript
if (parsed.type === 'team') {
    const memberships = await getMemberships(user.id);
    if (!memberships.teamIds.includes(parsed.id)) {
        throw new ApiError(403, 'Not a member of this team');
    }
    const home = await getHome(ownerId);
    const permission = home.calendar.checkPermission(calendarId, user.email, memberships.teamIds);
    return {calendar: home.calendar, permission: permission || 'read'};
}
```

After reading this code carefully, I see the function calls `checkPermission()` and falls back to `'read'`. This means
team calendar permission IS enforced via share configuration. The `permission || 'read'` fallback means members without
explicit shares get `read` access. This is correct and matches the documented behavior in `CALENDAR.md` line 80:
"Default member permission is `read`. To grant `write` or `free-busy`, set shares on the team's default calendar."

The test file `team-calendar-share.test.ts` confirms this: "Bob with read permission cannot create events" (line 342)
returns 403, and "upgrading to write permission allows event creation" (line 358) succeeds. **No issue here.**

#### C2. `deleteCalendar` does not cancel attendee invitations before cascade-deleting events

**File**: `apps/api/src/lib/calendar/calendar.ts`, lines 245-256

```typescript
public async deleteCalendar(id: string): Promise<void> {
    const existing = this.getCalendarById(id);
    if (!existing) throw new ApiError(404, 'Calendar not found');
    if (existing.isDefault) throw new ApiError(400, 'Cannot delete default calendar');

    if (existing.shares?.length) {
        await propagateCalendarShare(this.home, {...existing, shares: []}, existing.shares);
    }

    this.db.delete(schema.calendars).where(eq(schema.calendars.id, id)).run();
    this.home.notify(buildCalendarEvent(SSEventType.CALENDAR_DELETED, {calendarId: id, title: existing.name}));
}
```

The share propagation is handled (line 250-252: if the calendar has shares, it propagates empty shares to remove
recipients' `shared_calendars` entries). However, the cascade delete of events does NOT call `propagateCancellation()`
for events with attendees. If a calendar contains invited events, the attendees' linked copies become permanently
orphaned -- they still appear in the attendee's calendar, but RSVP and updates will silently fail because the
organizer's event no longer exists.

**Impact**: Data integrity. Orphaned linked invitation copies in attendees' calendars after calendar deletion.
**Fix**: Before deleting, query all events in the calendar that have attendees (`data` containing `attendees` array),
and call `propagateCancellation()` for each.

#### C3. `access` endpoint leaks share list to `free-busy` users

**File**: `apps/api/src/routes/calendar.ts`, lines 165-170

```typescript
.get("/calendar/:ownerId/calendars/:calId/access", async ({params, user}) => {
    const {calendar, permission} = await resolveCalendarForEvents(user, params.ownerId, params.calId);
    const calData = calendar.getCalendarById(params.calId);
    if (!calData) throw new ApiError(404, 'Calendar not found');
    return {ownerUserId: params.ownerId, shares: permission === 'write' ? (calData.shares || []) : []};
}, {auth: true})
```

After reading carefully, the code checks `permission === 'write'` and returns an empty array for non-write users. This
means `free-busy` and `read` users see `shares: []`. **This is correctly implemented.** No issue.

### Important

#### I1. No validation that `startTime < endTime`

**File**: `apps/api/src/lib/calendar/calendar.ts`, `createEvent()` (line 260) and `updateEvent()` (line 343)

Neither the route schemas (`CreateEventSchema`, `UpdateEventSchema`) nor the Calendar class validates that
`endTime > startTime`. A client can create events with zero or negative duration. `expandRecurrence()` computes
`eventDuration = event.endTime - event.startTime` (line 1055) and uses it to set `endTime: ts + eventDuration` --
a negative duration produces occurrences where endTime precedes startTime on every expansion.

**Impact**: Invalid data stored. Negative-duration occurrences in range queries. Potential frontend display bugs.
**Fix**: Add `if (startTime >= endTime) throw new ApiError(400, 'endTime must be after startTime')` in both methods.

#### I2. Recurring event range query loads ALL recurring events and ALL exceptions without date filtering

**File**: `apps/api/src/lib/calendar/calendar.ts`, lines 453-468

```typescript
const recurring = this.db.select().from(schema.events).where(
    and(
        ...conditions,
        sql`${schema.events.rrule} IS NOT NULL`,
        isNull(schema.events.parentEventId),
    )
).all();

const exceptions = this.db.select().from(schema.events).where(
    and(
        ...conditions,
        sql`${schema.events.parentEventId} IS NOT NULL`,
    )
).all();
```

Both queries fetch every recurring event and every exception in the calendar, regardless of the query range. For a user
with many recurring events that have long since ended (COUNT-based rules from years ago) and accumulated exceptions,
every range query pays the cost of loading all of them. The `expandRecurrence()` call returns empty arrays for past
events, but the DB I/O and object allocation still occur.

Additionally, the exceptions query loads ALL exceptions across ALL parents, then groups them by parent in JavaScript.
The exceptions could be scoped to only the parents fetched in the recurring query.

**Impact**: Performance degradation proportional to total historical recurring events/exceptions, not the query range.
**Fix**: For recurring events, add `lte(schema.events.startTime, to)` to exclude events that start after the range.
For exceptions, use `WHERE parentEventId IN (...)` to scope to fetched parents.

#### I3. `shared-with-me` endpoint has no authorization check on ownerId

**File**: `apps/api/src/routes/calendar.ts`, lines 175-179

```typescript
.get("/calendar/:ownerId/shared-with-me", async ({params, user}) => {
    const ownerHome = await getHome(params.ownerId);
    const memberships = await getMemberships(user.id);
    return ownerHome.calendar.getSharedWith(user.email, memberships.teamIds);
}, {auth: true})
```

Any authenticated user can call `GET /calendar/{anyUserId}/shared-with-me` to trigger `getHome()` on an arbitrary user.
While the response is correctly filtered to only show shares matching the caller, the route allows:

- User ID enumeration (non-existent IDs produce errors, existing IDs return empty arrays)
- Unnecessary Home singleton initialization for arbitrary users

**Impact**: Information disclosure (user existence probing), unnecessary resource consumption.
**Fix**: Validate that `params.ownerId` corresponds to an existing shared calendar in the caller's `shared_calendars`
table before calling `getHome()`.

#### I4. Fire-and-forget propagation with inconsistent error handling

**File**: `apps/api/src/lib/calendar/calendar.ts`, multiple locations

All invitation and share propagation calls use fire-and-forget:

```typescript
propagateInvitation(this.home, event, user, [], event.data.attendees).catch(console.error);
notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});
```

The inconsistency: invitation propagation logs errors via `console.error`, while SSE notifications silently swallow them
via `.catch(() => {})`. If invitation propagation fails, the organizer's event is saved but attendees never receive the
invite with no feedback. RSVP propagation to the organizer is also fire-and-forget -- an attendee's RSVP could succeed
locally but fail to reach the organizer.

**Impact**: Potential data inconsistency between organizer and attendee calendars with no detection or recovery.
**Fix**: At minimum, replace `.catch(() => {})` with `.catch(console.error)` for consistency. For critical propagation
(invites, RSVP), consider a warning in the response if propagation was scheduled to a missing user.

#### I5. `parseOwnerId` used on email-based share targetIds

**File**: `apps/api/src/lib/calendar/share-propagation.ts`, lines 20-24 and 55-57

```typescript
for (const share of shares) {
    const parsed = parseOwnerId(share.targetId);
    if (parsed.type === 'user') {
        const user = await getUserByEmail(share.targetId);
```

`CalendarShare.targetId` is an email address for user shares (confirmed by test: `{targetId: ctx.bob.user.email}`).
`parseOwnerId()` is designed for owner IDs (UUIDs and `team_`-prefixed). It happens to classify email addresses as
`user` type because they lack the `team_` prefix. Then `getUserByEmail(share.targetId)` correctly looks up the email.
This works by coincidence but is semantically wrong. If an email contained `team_` (e.g., `team_lead@example.com`), it
would be incorrectly classified as a team type.

**Impact**: Fragile code coupling. Correct behavior depends on `parseOwnerId` implementation details.
**Fix**: Replace with direct check: `share.targetId.startsWith('team_')`.

#### I6. `updateEvent` returns stale sequence when attendees are present

**File**: `apps/api/src/lib/calendar/calendar.ts`, lines 396-412

```typescript
this.incrementCtag(existing.calendarId);
const updated = this.getEventById(id)!;

// ... SSE notification ...

if (user && updated.data?.attendees?.length) {
    this.incrementSequence(id);
    const withSequence = this.getEventById(id)!;
    propagateInvitation(this.home, withSequence, user, oldAttendees, withSequence.data!.attendees!).catch(console.error);
    return withSequence;
}

return updated;
```

When the event has attendees, the code increments the sequence, re-reads the event (into `withSequence`), propagates
the invitation with the correct sequence, and returns `withSequence`. This is actually correct -- the
`return withSequence`
on line 409 returns the post-increment value. The early `return updated` on line 412 is only reached when there are NO
attendees. **No issue here on closer inspection.**

#### I7. Recurring vs. non-recurring range filtering inconsistency

**File**: `apps/api/src/lib/calendar/calendar.ts`, lines 443-451 vs 1092

Non-recurring events use overlap logic: `startTime <= to AND endTime >= from`. This includes events that start before
the range but extend into it.

The timezone-aware recurring expansion (line 1092) filters with `ts >= rangeFrom && ts <= rangeTo`, which only checks
the occurrence start time. The non-timezone path uses `rule.between(rangeStart, rangeEnd, true)`, also start-time only.
This means a recurring 3-hour event starting at 23:00 on the day before `rangeFrom` would be missed as a recurring
occurrence but included as an equivalent non-recurring event.

**Impact**: Recurring events spanning the range start boundary are missing from results.
**Fix**: In the timezone path, change filter to `ts + eventDuration >= rangeFrom && ts <= rangeTo`. In the non-timezone
path, adjust `rangeStart` backward by `eventDuration` before `rule.between()`.

#### I8. `from/to` validation uses falsy check, rejects timestamp 0

**File**: `apps/api/src/routes/calendar.ts`, lines 106-108

```typescript
const from = Number(params.from);
const to = Number(params.to);
if (!from || !to) throw new ApiError(400, 'Invalid from/to parameters');
```

`Number("0")` is `0`, which is falsy. Unix timestamp 0 (1970-01-01T00:00:00Z) is rejected as invalid. While unlikely
in practice, this is incorrect validation. Use `Number.isNaN(from) || Number.isNaN(to)`.

**Impact**: Edge case bug. Valid but unlikely range queries rejected.
**Fix**: Replace with `if (Number.isNaN(from) || Number.isNaN(to))`.

#### I9. No unique constraint on `shared_calendars(ownerUserId, calendarId)`

**File**: `apps/api/src/lib/calendar/schema.ts`, lines 48-59

The `shared_calendars` table has no unique constraint on `(ownerUserId, calendarId)`. The code uses check-then-insert
logic in `receiveShare()` and `ensureSharedEntry()`, but without a unique constraint, concurrent share propagations
could create duplicate entries. While SQLite's single-writer model makes this unlikely, the async fire-and-forget
propagation pattern means two tasks could interleave their read-check and insert operations across event loop ticks.

**Impact**: Potential duplicate shared calendar entries.
**Fix**: Add `CREATE UNIQUE INDEX idx_shared_owner_cal ON shared_calendars(ownerUserId, calendarId)` and use
`INSERT ... ON CONFLICT ... DO UPDATE`.

### Minor

#### M1. `shared` endpoint ignores `ownerId` parameter

**File**: `apps/api/src/routes/calendar.ts`, lines 184-186

```typescript
.get("/calendar/:ownerId/shared", async ({user}) => {
    return syncTeamCalendars(user);
}, {auth: true})
```

The handler never uses `params.ownerId`. The route always operates on the authenticated user's data. Not a security
issue but violates the ownerId contract documented in CLAUDE.md.

#### M2. `notifySharedCalendarUsers` does not notify team members

**File**: `apps/api/src/lib/calendar/share-propagation.ts`, lines 25-29

```typescript
} else if (parsed.type === 'team') {
    // Team members are not notified via SSE for calendar share changes.
    // Instead, the frontend uses TanStack Query's staleTime to periodically
    // re-sync team calendars (via syncTeamCalendars in get-calendar.ts).
}
```

Team members do not receive real-time SSE notifications when events change on team-shared calendars. This is documented
as intentional (to avoid resolving all team members on every event change), but creates an inconsistency: share changes
go through `propagateCalendarShare()` which DOES resolve team members, while event changes are delayed.

#### M3. MD5 used for etag computation

**File**: `apps/api/src/lib/calendar/calendar.ts`, line 43

`createHash('md5')` is used for etag generation. MD5 is not a security concern here (etags are for change detection),
but security scanners commonly flag MD5 usage. SHA-256 would avoid this noise.

#### M4. SQL template literals split across lines

**File**: `apps/api/src/lib/calendar/calendar.ts`, lines 456-457, 465-466, 1044-1045

```typescript
sql`${schema.events.rrule}
IS NOT NULL`,
```

These appear to be accidental line breaks from auto-formatting. SQLite handles the whitespace correctly, but it hurts
readability.

#### M5. Timezone string not validated

**File**: `apps/api/src/lib/calendar/calendar.ts`, `createEvent()` and `updateEvent()`

The `timezone` field is stored as-is with no validation. An invalid timezone string (e.g., `"Not/A/Zone"`) would cause
a runtime error in `Intl.DateTimeFormat` during recurrence expansion, breaking range queries for that event.

**Fix**: Validate against `Intl.supportedValuesOf('timeZone')` on create/update.

#### M6. `getEventsWithAttendee` performs full table scan with JS filtering

**File**: `apps/api/src/lib/calendar/calendar.ts`, lines 865-875

```typescript
public getEventsWithAttendee(email: string): CalendarEvent[] {
    const rows = this.db.select().from(schema.events).where(
        isNull(schema.events.organizerEventId)
    ).all();
    return rows.map(dbEventToCalendarEvent).filter(e =>
        e.data?.attendees?.some(a => a.email.toLowerCase() === email.toLowerCase())
    );
}
```

Loads all non-linked events, maps them, then filters in JavaScript by parsing JSON `data`. Used during share
reconciliation (infrequent), so low practical impact. Could use SQLite JSON functions or a `LIKE` pre-filter.

#### M7. `hour % 24` in `utcToLocal` handles a known runtime quirk

**File**: `apps/api/src/lib/calendar/calendar.ts`, line 85

`Intl.DateTimeFormat` with `hour12: false` can return hour `24` for midnight in some engines. The `% 24` correctly
maps 24 to 0. A brief comment would help future maintainers understand this is intentional.

#### M8. `constrainRRule` date arithmetic is roundabout

**File**: `apps/api/src/lib/calendar/calendar.ts`, lines 1134-1141

The function passes `localUntil + 86400_000` to `truncateRRule()`, which then subtracts one day. The net effect is
correct (UNTIL = localUntil), but the round-trip through date arithmetic could introduce off-by-one errors if
time-of-day components don't align. Consider simplifying to pass `localUntil` directly with appropriate adjustment.

---

## Strengths

1. **CalDAV-ready schema**: The `uid`, `uri`, `etag`, `ctag`, and `sequence` fields are correctly maintained. Etag
   is recomputed on every mutation, ctag is atomically incremented. This positions the calendar for future CalDAV
   server integration with minimal schema changes.

2. **Timezone-aware recurrence expansion**: The `utcToLocal()`/`localToUtcSeconds()` pair correctly handles DST
   transitions by operating in wall-clock space. The `localToUtcSeconds` function has a verify-and-correct pattern
   for ambiguous DST transitions. The approach correctly avoids the `rrule` library's broken built-in TZID support.

3. **Robust invitation model**: Linked events with bidirectional references (`organizerEventId`/`organizerUserId`)
   create clean separation. The linked-event guard (lines 359-366) prevents unauthorized modifications. The
   `constrainRRule` function (lines 1134-1141) elegantly prevents organizer updates from undoing an attendee's
   "delete this and following" truncation. Idempotent invitation receipt (line 726) prevents duplicates.

4. **Permission resolution with most-permissive-wins**: `checkPermission()` (lines 670-694) correctly iterates all
   shares (email + team) and selects the highest permission level. The `permissionRank` map makes comparison clean.

5. **Team calendar lazy sync with safety net**: `syncTeamCalendars()` re-resolves permissions on every read, catching
   stale permissions from team membership changes (lines 78-91 of get-calendar.ts). This avoids complex membership
   event handling.

6. **Clean separation of concerns**: Route file is thin (pure delegation), Calendar class owns all business logic,
   propagation files handle cross-user side effects, SSE events are typed builders with templates.

7. **Self-invite prevention**: Organizer's email is correctly skipped during propagation (line 28 of
   invite-propagation.ts), preventing the organizer from receiving a linked copy of their own event.

8. **Recurrence exception model**: Using regular event rows with `parentEventId` + `recurrenceDate` is clean and
   composable. The `getEventsInRange()` method correctly substitutes exceptions for parent occurrences and filters
   cancelled ones. The "modified exception then cancelled" case is handled and regression-tested.

---

## Test Coverage Analysis

### Test Files

| File                                            | Test Count | Coverage                                                                                                                                                                                                                                                                                                          |
|-------------------------------------------------|------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `apps/api/src/test/calendar.test.ts`            | ~30        | Calendar CRUD, event CRUD, RRULE storage/round-trip, recurrence expansion, exceptions (cancel/modify), this-and-following operations, range queries, sharing (read/write/free-busy), cross-user isolation, frontend-style queries, malformed RRULE validation                                                     |
| `apps/api/src/test/calendar-invites.test.ts`    | ~12        | Invite propagation, RSVP accepted/declined, non-linked RSVP rejection, non-attendee RSVP rejection, update propagation, cancellation, attendee-delete-declines, linked-event guard, self-invite prevention, per-occurrence RSVP (scope=this/all/this-and-following), organizer truncate constraint                |
| `apps/api/src/test/calendar-timezone.test.ts`   | ~12        | Timezone storage/update, DST drift prevention (Amsterdam/US), timezone propagation to attendees, RSVP with timezone-aware expansion, occurrence cancellation with timezone, backward compatibility for events without timezone                                                                                    |
| `apps/api/src/test/team-calendar-share.test.ts` | ~16        | Team calendar sharing, new-member reconciliation, shared-with-me pull, non-member access denial, team member listing, default read permission, write permission upgrade/downgrade, disabled team calendar removal, team settings authorization, shared event read access, permission enforcement regression tests |

### Coverage Gaps

1. **No test for `startTime >= endTime`** -- no test verifies events with invalid time ranges are rejected (the
   validation itself is missing).
2. **No test for calendar deletion with invited events** -- cascade-deleting events with attendees leaves orphaned
   linked copies; no test covers this scenario.
3. **No test for invalid timezone strings** -- e.g., `"Not/A/Zone"` would crash recurrence expansion.
4. **No test for `from=0` edge case** in range queries (rejected by current falsy check).
5. **No test for recurring event spanning range boundary** -- a recurring event that starts before `rangeFrom` but
   extends past it would be missed by the start-time-only filter.
6. **No test for concurrent share propagation** -- potential duplicate `shared_calendars` entries from interleaved
   check-then-insert operations.
7. **No test for invitation propagation failure** -- behavior when target user's Home cannot be loaded is not tested.
8. **No performance test for large recurrence expansion** -- `FREQ=DAILY` over multi-year ranges.

---

## Summary

The backend calendar is a well-architected, feature-complete domain with CalDAV-ready design, sophisticated
timezone-aware recurrence handling, and a clean invitation/RSVP model. Test coverage is strong across all major
feature areas.

Priority fixes:

- **C2**: Propagate cancellations before calendar deletion to prevent orphaned invitation copies
- **I1**: Add `startTime < endTime` validation
- **I2**: Scope recurring event and exception queries for performance at scale
- **I4**: Replace `.catch(() => {})` with `.catch(console.error)` for SSE notification errors
- **I5**: Replace `parseOwnerId` with direct `startsWith('team_')` check in share propagation
- **M5**: Validate timezone strings on create/update to prevent range query failures
