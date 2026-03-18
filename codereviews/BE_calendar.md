# Backend Code Review: Calendar

## Summary

The Calendar domain is one of the most complex backend subsystems in Eigen. It handles per-user and per-team SQLite
calendars, RRULE-based recurrence expansion with timezone-aware DST handling, a push-based sharing model, invitation
propagation with linked event copies, per-occurrence RSVP, and CalDAV-readiness features (uid, uri, etag, ctag,
sequence). The code is spread across seven files (~1200 lines of domain logic) plus one route file, with four dedicated
test files providing solid coverage.

Overall the implementation is well-structured and handles many edge cases correctly. The timezone-aware recurrence
expansion is particularly well-engineered. The issues below range from authorization gaps to missing validation.

**Files reviewed:**

| File | Lines | Purpose |
|------|-------|---------|
| `apps/api/src/lib/calendar/calendar.ts` | ~1198 | Core Calendar class |
| `apps/api/src/lib/calendar/schema.ts` | 59 | Drizzle schema |
| `apps/api/src/lib/calendar/db-config.ts` | 72 | DB config + migration |
| `apps/api/src/lib/calendar/get-calendar.ts` | 72 | Access resolution |
| `apps/api/src/lib/calendar/share-propagation.ts` | 119 | Push shares to recipients |
| `apps/api/src/lib/calendar/invite-propagation.ts` | 153 | Push invites to attendees |
| `apps/api/src/lib/calendar/sse-events.ts` | 93 | SSE event builders |
| `apps/api/src/routes/calendar.ts` | 195 | API routes |

## Architecture Compliance

The Calendar domain follows the documented architecture patterns well:

- Domain class in `apps/api/src/lib/calendar/calendar.ts` owned by the Home singleton.
- Schema in `schema.ts` with separate `db-config.ts` for migrations.
- Thin route layer in `apps/api/src/routes/calendar.ts` using `{auth: true}`.
- SSE events built with `buildCalendarEvent()` / `buildCalendarShareEvent()` and emitted via `home.notify()`.
- Share propagation via dedicated `share-propagation.ts`, matching the Drive model.
- Types shared with frontend in `packages/lib/src/types/calendar.ts`.
- `resolveCalendar()` / `resolveCalendarForEvents()` in `get-calendar.ts` follows the `get-drive.ts` pattern.
- Team calendars use `TeamHome` with `team_{teamId}` owner prefix.

**Minor deviation**: The `CalendarEvent` type has `organizerEventId` and `organizerUserId` as top-level DB columns *and*
duplicated inside `EventData.organizerEventId` and `EventData.organizer.userId`. This is intentional (columns for
indexing, data for transport) but could be documented more clearly.

## Issues Found

### Critical

**1. Authorization bypass on `shared-with-me` endpoint (routes/calendar.ts:173-176)**

```
.get("/calendar/:ownerId/shared-with-me", async ({params, user}) => {
    const ownerHome = await getHome(params.ownerId);
    ...
```

Any authenticated user can call `GET /calendar/{anyUserId}/shared-with-me` and it will open the owner's Home and query
their calendar shares. While the result only shows calendars shared with the requesting user (filtered by email/team),
the endpoint does not verify that the caller has any relationship with `params.ownerId`. More critically, `getHome()`
is called with an unvalidated `ownerId`, which could be used to probe whether a user ID exists (it would throw for
non-existent users, returning an error, vs. returning an empty array for existing users who haven't shared anything).

**Location**: `apps/api/src/routes/calendar.ts` lines 173-177

**2. `shared` endpoint ignores `ownerId` param (routes/calendar.ts:182-184)**

```
.get("/calendar/:ownerId/shared", async ({user}) => {
    return syncTeamCalendars(user);
```

The `:ownerId` parameter is declared in the route but never used -- the handler always operates on the authenticated
`user`. This means `GET /calendar/someone-else/shared` returns the *caller's* shared calendars, not the owner's. This
is a semantic mismatch that could confuse API consumers, but is not a security issue since it always returns the
caller's data.

**Location**: `apps/api/src/routes/calendar.ts` lines 182-184

### Important

**3. No validation of RRULE strings (calendar.ts:276, 303)**

RRULE strings from the client are stored as-is with zero validation. A malformed RRULE (e.g., `FREQ=BANANAS`) will be
stored successfully but crash on expansion in `getEventsInRange()` when `RRule.parseString()` or `RRule.between()` is
called. This would make the entire calendar's range queries fail, since the error would propagate up.

**Location**: `apps/api/src/lib/calendar/calendar.ts` lines 256-311 (`createEvent`), 336-401 (`updateEvent`)

**Recommendation**: Wrap RRULE parsing in a try/catch at creation/update time, or validate with `RRule.parseString()`
before storing. At minimum, catch errors in `expandRecurrence()` to prevent one bad event from breaking all range
queries.

**4. `notifySharedCalendarUsers` does not notify team members (share-propagation.ts:21-29)**

```typescript
} else if (parsed.type === 'team') {
    // for teams, we really on staletime refresh at FE
    //    const members = await getTeamMembers(parsed.id);
    //    for (const member of members) userIds.add(member.user.id);
}
```

The code for notifying team members on calendar event changes is commented out. The comment says "we rely on staletime
refresh at FE" (also note the typo "really" should be "rely"). This means team members do not receive real-time SSE
notifications when events on shared calendars change -- they only see updates on the next frontend poll/stale-time
refresh. For a collaborative calendar product, this degrades the real-time experience.

**Location**: `apps/api/src/lib/calendar/share-propagation.ts` lines 21-29

**5. `notifySharedCalendarUsers` misidentifies user shares (share-propagation.ts:22-24)**

For user-type shares, the code calls `getUserByEmail(share.targetId)` but `share.targetId` for user shares is an email
address, while `parseOwnerId()` on line 21 parses it as if it were a user/team ID. Since an email address does not
start with `team_`, `parseOwnerId` returns `{type: 'user', id: email}`, then `getUserByEmail` is called with the raw
email. This works by coincidence (the email IS the targetId for user shares), but the intermediate `parseOwnerId` call
is semantically wrong. In `CalendarShare`, `targetId` can be an email *or* `team_{id}` -- it is NOT a standard ownerId.

**Location**: `apps/api/src/lib/calendar/share-propagation.ts` lines 20-24

**6. No `startTime < endTime` validation (calendar.ts:256, routes/calendar.ts:46-59)**

Neither the route schemas nor the Calendar class validate that `endTime > startTime`. A client can create events with
`endTime < startTime`, producing negative-duration events. The `expandRecurrence()` function would then produce
occurrences with `endTime: ts + eventDuration` where `eventDuration` is negative, causing events to "end before they
start."

**Location**: `apps/api/src/routes/calendar.ts` lines 46-59 (`CreateEventSchema`), `apps/api/src/lib/calendar/calendar.ts` line 256

**7. `from/to` validation uses falsy check (routes/calendar.ts:107-108)**

```typescript
const from = Number(params.from);
const to = Number(params.to);
if (!from || !to) throw new ApiError(400, 'Invalid from/to parameters');
```

`Number("0")` produces `0`, which is falsy. A `from` of `0` (Unix epoch) is a valid timestamp but would be rejected.
More importantly, `Number("abc")` produces `NaN` which is also falsy -- so this catches garbage input, but the falsy
check is semantically incorrect. Should use `isNaN(from) || isNaN(to)`.

**Location**: `apps/api/src/routes/calendar.ts` lines 106-108, 114-116

**8. `resolveCalendarForEvents` grants all team members write access (get-calendar.ts:34-35)**

```typescript
if (parsed.type === 'team') {
    ...
    return {calendar: home.calendar, permission: 'write'};
}
```

Every team member automatically gets `write` permission on team calendar events, regardless of the team calendar's
actual share settings. The `syncTeamCalendars()` function respects per-calendar permission levels (defaulting to `read`),
but `resolveCalendarForEvents()` bypasses this entirely by hardcoding `write`. This means even if a team calendar is
shared as `read` or `free-busy`, team members can still create/update/delete events through the events API.

**Location**: `apps/api/src/lib/calendar/get-calendar.ts` lines 29-35

**9. `getEventsWithAttendee` performs full table scan (calendar.ts:854-864)**

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

This loads ALL non-linked events into memory, maps them, then filters in JS by parsing the JSON `data` column. Since
attendees are stored in a JSON text column, there is no SQL-level filtering. As the event count grows, this will become
a performance bottleneck. Used in share reconciliation (`apps/api/src/lib/share/reconciliation.ts:73`).

**Location**: `apps/api/src/lib/calendar/calendar.ts` lines 854-864

**10. Recurring events without `COUNT` or `UNTIL` cause unbounded expansion (calendar.ts:1041-1113)**

For recurring events with no `UNTIL` or `COUNT` (e.g., `FREQ=WEEKLY;BYDAY=MO`), `rule.between(rangeStart, rangeEnd)`
will expand all occurrences within the requested range. If a client requests a very large range (e.g., 100 years), this
could produce tens of thousands of occurrences, consuming significant CPU and memory. There is no cap on the number of
expanded occurrences.

**Location**: `apps/api/src/lib/calendar/calendar.ts` lines 1041-1113

### Minor

**11. MD5 used for etag (calendar.ts:43)**

`createHash('md5')` is used for etag computation. MD5 is cryptographically broken and, while not a security concern for
etags (this is a change-detection hash, not authentication), some security scanners flag it. Consider SHA-256 for
cleanliness, or just use a simpler hash/counter if performance matters.

**Location**: `apps/api/src/lib/calendar/calendar.ts` line 43

**12. Exception loading has no range filter (calendar.ts:451-457)**

```typescript
const exceptions = this.db.select().from(schema.events).where(
    and(
        ...conditions,
        sql`${schema.events.parentEventId} IS NOT NULL`,
    )
).all();
```

All recurrence exceptions for the calendar (or all calendars) are loaded regardless of the query range. For a calendar
with many historical exceptions, this loads more data than needed. Should filter by `startTime`/`endTime` overlap with
the range, or by the parent event IDs of the recurring events in that range.

**Location**: `apps/api/src/lib/calendar/calendar.ts` lines 451-457

**13. SQL template literal formatting (calendar.ts:445-446, 454-455, 1033-1034)**

Multi-line SQL template literals have awkward formatting with `IS NOT NULL` on a new line:

```typescript
sql`${schema.events.rrule}
IS NOT NULL`,
```

This works because SQLite treats whitespace (including newlines) as separators, but it looks like an accidental line
break. Same pattern at line 454 and 1033. Suggest keeping these on one line for readability.

**Location**: `apps/api/src/lib/calendar/calendar.ts` lines 445-446, 454-455, 1033-1034

**14. `constrainRRule` off-by-one in UNTIL comparison (calendar.ts:1123-1130)**

```typescript
function constrainRRule(incoming: string | null, local: string | null): string | null {
    ...
    if (incomingUntil && incomingUntil <= localUntil) return incoming;
    return truncateRRule(incoming, new Date(localUntil.getTime() + 86400_000));
}
```

When the incoming rrule has no `until` (infinite), but the local has an `until`, `incomingUntil` is `null` and the
condition `incomingUntil && ...` is false, so it calls `truncateRRule(incoming, localUntil + 1 day)`. The `truncateRRule`
then subtracts 1 day and sets UNTIL to `23:59:59`. This preserves the local UNTIL correctly. However, the addition of
`86400_000` ms before subtracting a day in `truncateRRule` is a roundabout way to pass the original date. A cleaner
approach would be to pass the date directly.

**Location**: `apps/api/src/lib/calendar/calendar.ts` lines 1123-1130

**15. Typo in comment (share-propagation.ts:26)**

```typescript
// for teams, we really on staletime refresh at FE
```

Should be "we rely on stale-time refresh at FE".

**Location**: `apps/api/src/lib/calendar/share-propagation.ts` line 26

**16. `organizerEventId` on `event.data` can be undefined but is accessed with `!` (calendar.ts:963)**

```typescript
const organizerEventId = event.data.organizerEventId!;
```

The `EventData.organizerEventId` field is optional (`organizerEventId?: string`). The non-null assertion is safe here
because the code has already checked `event.data?.organizer` exists (line 954), and invite-propagation always sets both
fields together. However, the `!` assertion obscures this coupling. A guard would be more defensive.

**Location**: `apps/api/src/lib/calendar/calendar.ts` line 963

**17. Inconsistent `unixepoch()` usage in SQL (calendar.ts:230, 1033-1034)**

In some places, `sql\`unixepoch()\`` is used (line 230, 382, etc.), while in others it appears within parentheses in
the migration DDL (e.g., `DEFAULT (unixepoch())`). This is consistent within its context (Drizzle expressions vs raw
SQL), but the `incrementCtag` method has a particularly odd formatting where the SQL template spreads across two lines.

**Location**: `apps/api/src/lib/calendar/calendar.ts` lines 1030-1038

**18. No unique constraint on `shared_calendars(ownerUserId, calendarId)` (schema.ts:48-59, db-config.ts:57-68)**

The `shared_calendars` table allows duplicate rows for the same `(ownerUserId, calendarId)` pair. The code handles this
with upsert-style logic in `receiveShare()` and `ensureSharedEntry()`, but there is no database-level uniqueness
constraint to prevent race conditions from creating duplicates if two share propagations run concurrently for the same
target.

**Location**: `apps/api/src/lib/calendar/schema.ts` lines 48-59, `apps/api/src/lib/calendar/db-config.ts` lines 57-68

## Robustness

**Timezone handling**: The `utcToLocal()` / `localToUtcSeconds()` pair is well-implemented with a double-verify pattern
to handle DST edge cases. The `Intl.DateTimeFormat` cache (`intlCache`) avoids repeated allocations. The approach of
converting to wall-clock time, running rrule in that space, and converting back correctly avoids the known issues with
rrule.js's built-in TZID handling.

**Error handling**: Errors in async propagation (invites, shares, SSE) are caught and logged with `.catch(console.error)`
or `.catch(() => {})`, preventing propagation failures from crashing the primary operation. This is appropriate for
fire-and-forget notification side effects.

**Transaction usage**: `updateAttendeeStatus()` correctly uses a transaction to atomically read-modify-write the JSON
attendees array. Other JSON mutations (like in `rsvpForOccurrence`) do not use transactions, creating a theoretical
(but unlikely with SQLite's single-writer) race window.

**Concurrency**: SQLite's single-writer model largely protects against concurrency issues. The `ManagedDatabase` layer
provides WAL mode and busy_timeout, which is appropriate. The main concurrency concern is async propagation tasks
(invites, shares) running after the primary response, but these operate on different user databases, so contention is
minimal.

**Edge cases handled well**:
- Self-invite prevention (organizer skipped during propagation)
- Linked event guard (attendees can only modify reminders/color)
- RRULE constraint on invitation updates (attendee truncation preserved)
- Idempotent invitation receipt (returns existing ID if already exists)
- Calendar ctag increment on all event mutations

## Test Coverage

Four test files provide comprehensive coverage:

| Test file | Tests | Coverage area |
|-----------|-------|---------------|
| `calendar.test.ts` | ~25 | CRUD, RRULE storage, recurrence expansion, exceptions, this-and-following, sharing, free-busy, cross-user isolation, frontend-like scenarios |
| `calendar-invites.test.ts` | ~12 | Invite propagation, RSVP, update propagation, cancellation, linked event guard, self-invite prevention, per-occurrence RSVP (scope=this, scope=all, scope=this-and-following), rrule constraint |
| `team-calendar-share.test.ts` | ~10 | Team calendar sharing, membership-based access, team settings, disabled calendar, write permission via shares |
| `calendar-timezone.test.ts` | ~12 | Timezone storage, DST drift prevention (Amsterdam, US), timezone propagation via invites, occurrence RSVP with timezone, backward compat without timezone |

**Missing test scenarios**:
- No tests for invalid/malformed RRULE strings
- No tests for `startTime > endTime` edge cases
- No tests for `from=0` in range queries (would fail due to falsy check)
- No tests for very large date ranges (unbounded expansion)
- No tests for the `shared-with-me` endpoint authorization
- No tests for concurrent share propagation (duplicate `shared_calendars` rows)
- No tests for deleting a calendar that has active shares (what happens to recipient `shared_calendars` entries?)
- No tests for `getEventsWithAttendee` (used in reconciliation)
- No tests for `getEventsInRange` without `calendarId` (all-calendars mode) including both recurring and non-recurring events across multiple calendars

## Recommendations

1. **Fix the team member permission hardcoding** in `resolveCalendarForEvents()` (issue #8). Consult the actual team
   calendar share settings instead of hardcoding `write`.

2. **Add RRULE validation** at create/update time (issue #3). At minimum, wrap `RRule.parseString()` in a try/catch and
   return 400 for malformed rules. Also add a try/catch in `expandRecurrence()` to gracefully skip broken events rather
   than failing the entire range query.

3. **Add `startTime < endTime` validation** to `CreateEventSchema` / `UpdateEventSchema` or in the Calendar class
   (issue #6).

4. **Fix `from/to` validation** to use `Number.isNaN()` instead of falsy checks (issue #7).

5. **Add authorization check** to the `shared-with-me` endpoint, or switch to using the authenticated user's context
   instead of the raw `ownerId` param (issue #1).

6. **Add a unique index** on `shared_calendars(ownerUserId, calendarId)` to prevent duplicate entries (issue #18).

7. **Cap expanded occurrence count** in `expandRecurrence()` (e.g., max 1000 occurrences per event) to prevent DoS via
   large range queries on infinite recurring events (issue #10).

8. **Consider enabling team SSE notifications** for calendar event changes, or document the deliberate omission more
   clearly (issue #4).
