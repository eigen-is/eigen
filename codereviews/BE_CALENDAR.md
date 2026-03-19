# BE Code Review: Calendar

## Summary

The Calendar backend is a well-structured domain with mature features: per-user SQLite calendars, RRULE-based
recurrence, timezone-aware expansion, invitation propagation, push-based sharing, team calendar sync, and SSE
integration. The code handles many complex edge cases (RSVP per-occurrence, rrule truncation, linked event guards).
However, there are several missing `await` calls on async operations, fire-and-forget propagation that silently swallows
errors, input validation gaps, and a few access control issues.

## Critical Issues

### 1. Missing `await` on `rsvp()` in route handler (silent failure)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/calendar.ts`, line 156

```typescript
home.calendar.rsvp(params.id, user, body);
return {success: true};
```

`Calendar.rsvp()` calls `propagateRsvp()` and `propagateDecline()` which are async functions invoked via `.catch()`.
While `rsvp()` itself is synchronous, the fire-and-forget propagation means the response returns `{success: true}`
before propagation completes. If propagation fails, the organizer never learns about the RSVP. This is a design choice
but worth noting.

### 2. Missing `await` on `deleteEvent()` route handler

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/calendar.ts`, line 148

```typescript
calendar.deleteEvent(params.id, user);
return {success: true};
```

`deleteEvent()` is synchronous but calls `propagateDecline()` and `propagateCancellation()` via `.catch()` (lines
421-424 of `calendar.ts`). These are async and fire-and-forget. The response returns before attendee cancellation
propagation completes. Same pattern as rsvp above.

### 3. `shared` route ignores `ownerId` parameter

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/calendar.ts`, line 187

```typescript
.
get("/calendar/:ownerId/shared", async ({user}) => {
    return syncTeamCalendars(user);
}, {auth: true})
```

The `ownerId` URL parameter is accepted but completely ignored. `syncTeamCalendars` always operates on the
authenticated user's home. This means any `ownerId` could be passed in the URL with no validation. While not a security
issue (the function is scoped to `user`), it violates the convention that `:ownerId` should be validated and used. If a
client sends the wrong `ownerId`, it still works, which is confusing.

### 4. `shared/:id` PUT and DELETE also ignore `ownerId`

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/calendar.ts`, lines 191-199

```typescript
.
put("/calendar/:ownerId/shared/:id", async ({params, body, user}) => {
    const cal = await resolveCalendar(user, user.id);  // ownerId ignored, always uses user.id
```

Same issue: `params.ownerId` is ignored; `user.id` is hardcoded. Inconsistent with other routes.

### 5. `event-range` (all calendars) does not enforce cross-owner access

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/calendar.ts`, lines 108-114

```typescript
.
get("/calendar/:ownerId/event-range/:from/:to", async ({params, user}) => {
    const cal = await resolveCalendar(user, params.ownerId);
    return cal.getEventsInRange(from, to);
```

`resolveCalendar()` only checks team membership. For user-owned calendars, it returns events from ALL calendars without
checking per-calendar share permissions. A user who has `free-busy` permission on one calendar and `read` on another
would get full event details from both. The per-calendar route (`/calendars/:calId/event-range/`) does check
permissions via `resolveCalendarForEvents()`.

**Impact**: Information leakage. Users with `free-busy` access to one calendar can see full event details of all
calendars owned by that user via this route.

**Fix**: Either remove this route for cross-owner access, or iterate over calendars applying per-calendar permission
checks.

## Pattern Violations

### 6. Fire-and-forget async propagation throughout

**Files**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/calendar.ts`, lines 329, 332, 403, 408,
421, 424, 434, 979, 982, 986, 991

All propagation calls use `.catch(console.error)` or `.catch(() => {})`. This means:

- Invitation delivery failures are silently logged but never surfaced to the organizer
- RSVP propagation failures mean the organizer's copy is never updated
- `notifySharedCalendarUsers` failures are completely swallowed (`.catch(() => {})`)

While fire-and-forget is a reasonable tradeoff for notification delivery, the completely empty `.catch(() => {})` on
`notifySharedCalendarUsers` is a concern since it hides all errors including programming errors.

**Fix**: At minimum, change `.catch(() => {})` to `.catch(console.error)` for notification calls. Consider returning
propagation failures to the caller for important operations like RSVP.

### 7. Non-null assertions on potentially null data

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/calendar.ts`

- Line 421: `existing.data.organizerEventId!` -- relies on `organizer` being set implying `organizerEventId` exists
- Line 974: `event.data.organizerEventId!` -- same pattern

These are logically correct (if `organizer` is set, `organizerEventId` should also be set in the data), but
`organizerEventId` is an optional field in the `EventData` type. A corrupted event could crash the server.

**Fix**: Add explicit null check or throw a descriptive error.

## Security Concerns

### 8. No input validation on `from`/`to` range parameters

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/calendar.ts`, lines 109-111

```typescript
const from = Number(params.from);
const to = Number(params.to);
if (!from || !to) throw new ApiError(400, 'Invalid from/to parameters');
```

`Number()` returns `0` for empty strings, which would pass a Unix epoch of 0 (Jan 1, 1970). The check `!from` would
reject `0` but not negative numbers. There's no upper bound or relationship validation (`from < to`). An extremely
large range could cause excessive RRULE expansion.

**Fix**: Validate `from >= 0`, `to > from`, and optionally cap the maximum range to prevent denial-of-service via
unbounded recurrence expansion.

### 9. No length/content validation on calendar name/color inputs

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/calendar.ts`, lines 14-17

```typescript
const CreateCalendarSchema = t.Object({
    name: t.String(),
    color: t.String(),
});
```

No max length on `name` or format validation on `color`. A user could submit megabytes of data as a calendar name, or
an invalid color string.

**Fix**: Add `t.String({maxLength: 255})` for name, validate color format (hex pattern).

### 10. No validation on RRULE string length or complexity

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/calendar.ts`, lines 281-282

```typescript
if (rruleStr) {
    try {
        RRule.parseString(rruleStr);
    } catch {
        throw new ApiError(400, 'Invalid RRULE');
    }
}
```

The RRULE is parsed for validity but there's no limit on its complexity. A crafted RRULE with extreme `COUNT` or
extremely long `UNTIL` range could cause expensive expansion in `getEventsInRange()`.

### 11. `shared-with-me` route has no authorization for `ownerId`

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/calendar.ts`, lines 178-182

```typescript
.
get("/calendar/:ownerId/shared-with-me", async ({params, user}) => {
    const ownerHome = await getHome(params.ownerId);
```

Any authenticated user can call `getHome(params.ownerId)` with any user ID. While `getSharedWith` filters results to
the caller's email/teams, this still opens any user's Home instance. The response is filtered but the Home is
materialized.

## Data Integrity

### 12. `getEventsInRange` queries all exceptions for a calendar (no time filter)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/calendar.ts`, lines 462-468

```typescript
const exceptions = this.db.select().from(schema.events).where(
    and(
        ...conditions,
        sql`${schema.events.parentEventId} IS NOT NULL`,
    )
).all();
```

Exceptions are queried without any time-range filter. For a recurring event with many exceptions, this loads all of
them into memory even if the queried range is a single week. Performance degrades as exceptions accumulate.

**Fix**: Add a time-range filter on exceptions, or at minimum filter by `parentEventId` being in the set of recurring
events found.

### 13. No unique constraint on `(ownerUserId, calendarId)` in `shared_calendars`

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/schema.ts`

The `shared_calendars` table has no unique constraint on `(ownerUserId, calendarId)`. The code handles this with
upsert logic in `receiveShare()` and `ensureSharedEntry()`, but concurrent requests could create duplicate entries.

**Fix**: Add a unique index on `(ownerUserId, calendarId)` in the migration.

### 14. No unique constraint on `(parentEventId, recurrenceDate)` in events

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/schema.ts`

Similarly, there's no database-level unique constraint ensuring only one exception per parent-event + recurrence-date
pair. The code checks via `getException()` first, but concurrent requests could create duplicates.

### 15. `computeOccurrenceTimes` fallback uses raw UTC math for non-tz events

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/calendar.ts`, lines 1205-1207

```typescript
const startTime = Math.floor(occDate.getTime() / 1000) +
    dtstart.getUTCHours() * 3600 + dtstart.getUTCMinutes() * 60 + dtstart.getUTCSeconds();
```

When the rrule expansion doesn't find a match for the occurrence date (fallback path), this manually places the
original time-of-day onto the occurrence date. This is correct for UTC-only events, but the comment says "Fallback"
which suggests it shouldn't be commonly reached. If it is, it silently returns approximate times.

### 16. `syncTeamCalendars` re-resolves permissions on every request

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/get-calendar.ts`, lines 53-93

This function iterates all teams, opens their homes, checks all calendars, and re-resolves all shared calendar
permissions on every `GET /shared` request. For users in many teams with many calendars, this is expensive. The
`staleTime: 5 * 60 * 1000` on the frontend partially mitigates this, but the backend does full work on every call.

## Code Quality

### 17. Duplicated `truncateRRule` function

The `truncateRRule` function is implemented identically in three places:

- `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/calendar.ts`, line 1143
- `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/edit-event-dialog.tsx`, line 57
- `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/event-detail-dialog.tsx`, line 84

**Fix**: Extract to `packages/lib/src/core/calendar/` and share.

### 18. Large monolithic `Calendar` class (1050+ lines)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/calendar.ts`

The `Calendar` class handles: CRUD, recurrence expansion, timezone conversion, sharing, invitation management, RSVP,
and SSE notification. It could benefit from extracting:

- Recurrence expansion logic into a separate module
- Timezone conversion utilities into a shared utility
- RSVP logic into a dedicated handler

### 19. `intlCache` grows unboundedly

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/calendar.ts`, line 61

```typescript
const intlCache = new Map<string, Intl.DateTimeFormat>();
```

Module-level cache with no eviction. In practice, timezone strings are from a fixed set so this is bounded, but it's
technically a memory leak if arbitrary timezone strings are passed.

### 20. `dbCalendarToCalendarItem` omits `ctag` field

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/calendar.ts`, line 133

The converter function maps `calendars` rows to `CalendarItem` but drops the `ctag` field. This is intentional
(ctag is internal), but the type should document this.

### 21. SQL formatting with embedded newlines

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/calendar.ts`, lines 456-457, 465-466,
1044-1045

```typescript
sql`${schema.events.rrule}
IS NOT NULL`
```

The template literal has a line break in the middle of the SQL expression. While SQLite handles this fine, it makes the
code harder to read and could confuse linters.

## Architecture

### 22. `resolveCalendarForEvents` grants team members default `'read'` even without explicit shares

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/get-calendar.ts`, line 36

```typescript
const permission = home.calendar.checkPermission(calendarId, user.email, memberships.teamIds);
return {calendar: home.calendar, permission: permission || 'read'};
```

For team calendars, if `checkPermission` returns `null` (no explicit share), the code defaults to `'read'`. This means
all team members always have at least read access to all team calendars. This is documented behavior but the fallback
is implicit rather than explicit.

### 23. Route definitions missing Elysia `params` schema

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/calendar.ts`

None of the route definitions include a `params` schema for the URL parameters (`:ownerId`, `:calId`, `:from`, `:to`,
`:id`). Elysia supports `params` validation which would ensure type safety and reject malformed parameters before the
handler runs.

### 24. `notifySharedCalendarUsers` resolves users by email but `targetId` might be a team

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/calendar/share-propagation.ts`, lines 21-23

```typescript
if (parsed.type === 'user') {
    const user = await getUserByEmail(share.targetId);
```

When `parsed.type === 'user'`, the code treats `share.targetId` as an email address (calls `getUserByEmail`). But
`parseOwnerId` returns `type: 'user'` for anything that's not `team_` prefixed, including emails. This works because
share targets are emails (not user IDs), but the semantics are confusing: `parseOwnerId` is designed for owner IDs,
not email addresses.

## Positive Patterns

- **Timezone-aware recurrence expansion**: The `utcToLocal` / `localToUtcSeconds` approach correctly handles DST
  transitions by working in wall-clock space and converting back
- **RRULE constraint on linked events**: `constrainRRule` prevents organizer updates from extending beyond attendee
  truncations -- a subtle but important correctness guarantee
- **Linked event guard**: `updateEvent` correctly limits what attendees can modify on linked copies
- **SSE coverage**: Comprehensive event types for all mutations including invitations and RSVP
- **CalDAV readiness**: etag, ctag, uid, uri, and sequence fields are maintained for future CalDAV integration
- **Push-based sharing**: Consistent with the Drive ACL pattern, using the share registry for unknown users
- **Permission resolution**: `checkPermission` correctly resolves the most permissive matching share (additive model)

## Recommendations

### P0 (Critical)

1. **Fix `event-range` all-calendars route access control** (issue #5): Either remove the cross-owner all-calendars
   endpoint or add per-calendar permission filtering. This leaks event details to `free-busy` users.

2. **Add range validation for `from`/`to`** (issue #8): Validate `from >= 0`, `to > from`, and add a maximum range
   cap to prevent DoS via unbounded RRULE expansion.

### P1 (Important)

3. **Replace empty `.catch(() => {})` with `.catch(console.error)`** (issue #6): At minimum log notification delivery
   failures.

4. **Add null checks for `organizerEventId!`** (issue #7): Protect against corrupted event data crashing the server.

5. **Add unique constraints on `shared_calendars`** (issue #13) and `(parentEventId, recurrenceDate)` (issue #14).

6. **Validate `ownerId` on shared calendar routes** (issues #3, #4): Use `params.ownerId` consistently or remove it
   from the route path.

7. **Add input length limits** (issue #9): Max length on calendar name, color format validation, RRULE complexity cap.

### P2 (Nice to have)

8. **Extract `truncateRRule` to shared package** (issue #17): DRY across backend and frontend.

9. **Add time-range filter on exception queries** (issue #12): Performance improvement for calendars with many
   exceptions.

10. **Add `params` schemas to Elysia routes** (issue #23): Better type safety and automatic validation.

11. **Refactor `Calendar` class** (issue #18): Extract recurrence expansion and timezone utilities.

12. **Fix SQL template literal formatting** (issue #21): Remove embedded newlines in SQL expressions.
