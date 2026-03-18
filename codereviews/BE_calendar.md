# Backend Review: Calendar (RRULE, Sharing, Scheduling)

**Scope:** `apps/api/src/lib/calendar/`, `apps/api/src/routes/calendar.ts`
**Reviewed:** 2026-03-18

## Summary

The Calendar domain handles per-user and per-team SQLite calendars, RRULE-based recurrence expansion with
timezone-aware DST handling, push-based calendar sharing, invitation propagation with linked event copies,
per-occurrence RSVP, and CalDAV-readiness (uid, uri, etag, ctag, sequence). The code spans seven domain files
(~1200 lines) plus one route file, backed by four test files.

The timezone-aware recurrence expansion is well-engineered. The `utcToLocal`/`localToUtcSeconds` pair with its
double-verify DST correction is solid. The linked event guard, self-invite prevention, and idempotent invitation
receipt are good defensive patterns. However, there are authorization gaps, missing validation, a calendar-deletion
data leak, and several behavioral inconsistencies in range queries and propagation.

**Files reviewed:**

| File | Lines | Purpose |
|------|-------|---------|
| `apps/api/src/lib/calendar/calendar.ts` | 1198 | Core Calendar class, RRULE expansion, timezone conversion |
| `apps/api/src/lib/calendar/schema.ts` | 59 | Drizzle schema (calendars, events, shared_calendars) |
| `apps/api/src/lib/calendar/db-config.ts` | 72 | DB config + v1 migration |
| `apps/api/src/lib/calendar/get-calendar.ts` | 72 | Access resolution + team calendar sync |
| `apps/api/src/lib/calendar/share-propagation.ts` | 119 | Push shares to recipients + SSE notifications |
| `apps/api/src/lib/calendar/invite-propagation.ts` | 153 | Push invites to attendees, RSVP propagation |
| `apps/api/src/lib/calendar/sse-events.ts` | 93 | SSE event builders |
| `apps/api/src/routes/calendar.ts` | 195 | API routes (thin) |
| `packages/lib/src/types/calendar.ts` | 130 | Shared types |

## Critical Issues

**1. `resolveCalendarForEvents` hardcodes write access for all team members**

`resolveCalendarForEvents()` returns `permission: 'write'` for every team member, regardless of the team calendar's
actual share configuration. The `syncTeamCalendars()` function correctly resolves per-calendar permissions (defaulting
to `read`), and the frontend sidebar reflects these. But `resolveCalendarForEvents()` bypasses all of this:

```typescript
if (parsed.type === 'team') {
    const memberships = await getMemberships(user.id);
    if (!memberships.teamIds.includes(parsed.id)) {
        throw new ApiError(403, 'Not a member of this team');
    }
    const home = await getHome(ownerId);
    return {calendar: home.calendar, permission: 'write'};
}
```

A team admin who sets a team calendar to `read` or `free-busy` via shares expects restricted access. But any team
member can still create, update, and delete events via the events API because the route checks
`if (permission !== 'write') throw new ApiError(403, ...)` -- and the hardcoded `'write'` always passes.

**File:** `apps/api/src/lib/calendar/get-calendar.ts:29-35`
**Impact:** Authorization bypass. Team calendar share permissions are cosmetic only.
**Fix:** Resolve actual permission via `checkPermission()` (like the non-team path does), defaulting to `read` for
members without explicit shares. Mirror the logic from `syncTeamCalendars()` line 63.
**Status:** Previously reported (issue #8 as Important). Elevated to Critical after verifying that team calendar
permission settings are completely unenforced on write operations.

---

**2. `deleteCalendar` does not propagate share removal or cancel invitations**

When a calendar with active shares is deleted, the calendar and its events are removed via CASCADE, but:

1. Recipients' `shared_calendars` entries become orphaned -- they still reference the deleted calendar and will
   appear in the sidebar until the next `syncTeamCalendars` refresh (which only handles team calendars, not
   individual shares).
2. Events with attendees are cascade-deleted without calling `propagateCancellation()`, so attendees keep stale
   linked copies in their calendars forever.

```typescript
public deleteCalendar(id: string): void {
    const existing = this.getCalendarById(id);
    if (!existing) throw new ApiError(404, 'Calendar not found');
    if (existing.isDefault) throw new ApiError(400, 'Cannot delete default calendar');

    this.db.delete(schema.calendars).where(eq(schema.calendars.id, id)).run();
    this.home.notify(buildCalendarEvent(SSEventType.CALENDAR_DELETED, {calendarId: id, title: existing.name}));
    // No share propagation. No invitation cancellation.
}
```

**File:** `apps/api/src/lib/calendar/calendar.ts:245-252`
**Impact:** Data integrity. Shared calendar entries and linked invitation copies become permanently orphaned.
**Fix:** Before deleting, iterate the calendar's events to propagate cancellations for any with attendees, then
call `propagateCalendarShare()` with empty new shares to trigger `removeShare()` on all recipients.
**Status:** New finding.

---

**3. `access` endpoint leaks share list to `free-busy` users**

The `/calendar/:ownerId/calendars/:calId/access` endpoint returns the full shares array to any user with *any*
permission level, including `free-busy`:

```typescript
.get("/calendar/:ownerId/calendars/:calId/access", async ({params, user}) => {
    const {calendar} = await resolveCalendarForEvents(user, params.ownerId, params.calId);
    const calData = calendar.getCalendarById(params.calId);
    if (!calData) throw new ApiError(404, 'Calendar not found');
    return {ownerUserId: params.ownerId, shares: calData.shares || []};
}, {auth: true})
```

The `CalendarShare` array contains `targetId` values, which are email addresses for user shares and `team_{id}` for
team shares. A user with only `free-busy` access (meant to see time blocks only, no details) can enumerate
everyone the calendar is shared with, including their email addresses and permission levels.

**File:** `apps/api/src/routes/calendar.ts:165-170`
**Impact:** Information disclosure. The `free-busy` permission level's privacy guarantee is violated.
**Fix:** Check permission level and return an empty shares array (or 403) for `free-busy` users. Only `write`
or possibly `read` users should see the share list.
**Status:** New finding.

## Important Issues

**4. No validation of RRULE strings on create/update**

RRULE strings from the client are stored as-is with no validation. A malformed RRULE (e.g., `FREQ=BANANAS` or
syntactically invalid strings) is stored successfully but will throw when `RRule.parseString()` is called during
`getEventsInRange()`. Since `expandRecurrence()` has no try/catch, one corrupted event makes the entire calendar's
range queries fail with a 500 error.

The impact is amplified by invite propagation: a malformed RRULE created by the organizer is propagated to all
attendees' calendars via `receiveInvitation()`, corrupting their calendars too.

**File:** `apps/api/src/lib/calendar/calendar.ts:256-311` (createEvent), `calendar.ts:336-401` (updateEvent)
**Impact:** A single bad RRULE poisons all range queries for the affected calendar and all invited attendees.
**Fix:** Validate with `RRule.parseString()` in a try/catch at create/update time, returning 400 for invalid rules.
Additionally, wrap `expandRecurrence()` in a try/catch to gracefully skip corrupted events during range queries.
**Status:** Previously reported (issue #3). Confirmed after tracing the full code path including invite propagation.

---

**5. Recurring event range query loads all recurring events without date filtering**

The `getEventsInRange()` method loads *all* recurring events and *all* exceptions from the database, regardless of
the query range:

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

For a user with many recurring events (some with UNTIL dates years in the past) and accumulated exceptions,
every range query pays the cost of loading all of them. The recurring events are then individually expanded --
`expandRecurrence()` will return empty arrays for past-UNTIL events, but the DB roundtrip and object allocation
still happen.

**File:** `apps/api/src/lib/calendar/calendar.ts:442-457`
**Impact:** Performance degradation proportional to total historical recurring events/exceptions, not the query range.
**Fix:** For recurring events: while you cannot pre-filter fully (infinite recurrences have no end), you can exclude
events whose UNTIL/COUNT makes their last occurrence precede `rangeFrom`. For exceptions: filter by
`startTime <= to AND endTime >= from`, or by matching parent event IDs from the recurring results.
**Status:** Previously reported as two separate issues (#10 and #12 in the prior review). Consolidated here as they
share the same root cause -- the queries have no range predicates.

---

**6. `updateEvent` returns stale sequence number**

When `updateEvent()` is called on an event with attendees, it increments the sequence number *after* reading the
event to return:

```typescript
this.incrementCtag(existing.calendarId);
const updated = this.getEventById(id)!;   // <-- reads here (sequence = N)
// ...
if (user && updated.data?.attendees?.length) {
    this.incrementSequence(id);            // <-- increments here (sequence = N+1)
    const withSequence = this.getEventById(id)!;
    propagateInvitation(this.home, withSequence, user, oldAttendees, ...);
}
return updated;                            // <-- returns stale (sequence = N)
```

The returned event has `sequence: N` while the database has `sequence: N+1`. The propagated invitation gets the
correct sequence, but the API caller receives the stale value. If the frontend caches this response, the displayed
sequence is wrong until the next refetch.

**File:** `apps/api/src/lib/calendar/calendar.ts:386-401`
**Impact:** API returns incorrect data. Stale sequence in response may cause CalDAV interop issues.
**Fix:** Move `incrementSequence()` before the `getEventById()` that produces the return value, or re-read after.

**Status:** New finding.

---

**7. `shared-with-me` endpoint has no authorization check on ownerId**

Any authenticated user can call `GET /calendar/{anyUserId}/shared-with-me`, which calls `getHome(params.ownerId)`
without verifying the caller's relationship with that owner. While the result is filtered to only show calendars
shared with the caller (via `getSharedWith(user.email, teamIds)`), the endpoint allows probing whether a user ID
exists: non-existent IDs produce a 404 from `getHome()`, while existing IDs return an empty array.

The call also triggers `getHome()` for an arbitrary user, initializing their Home singleton and calendar database
if not already loaded.

**File:** `apps/api/src/routes/calendar.ts:173-177`
**Impact:** User ID enumeration. Unnecessary Home initialization for arbitrary users.
**Fix:** Either validate that `params.ownerId` has shared something with the caller before calling `getHome()`,
or restructure so the caller queries their own shared_calendars table for entries from that owner.
**Status:** Previously reported (issue #1). Confirmed. Impact assessment remains the same -- the data returned is
correctly filtered, so this is Important rather than Critical.

---

**8. `from/to` validation uses falsy check, rejects valid timestamps**

```typescript
const from = Number(params.from);
const to = Number(params.to);
if (!from || !to) throw new ApiError(400, 'Invalid from/to parameters');
```

`Number("0")` produces `0`, which is falsy. Unix timestamp `0` (1970-01-01) is rejected. More importantly,
negative timestamps (pre-epoch dates) are also truthy, so they pass validation but may produce unexpected behavior.
The correct check is `Number.isNaN(from) || Number.isNaN(to)`.

**File:** `apps/api/src/routes/calendar.ts:106-108`, `calendar.ts:114-116`
**Impact:** Valid range queries rejected. Inconsistent validation.
**Fix:** Replace `!from || !to` with `Number.isNaN(from) || Number.isNaN(to)`. Optionally add `from >= to` check.
**Status:** Previously reported (issue #7). Confirmed.

---

**9. No `startTime < endTime` validation**

Neither the route schemas nor the Calendar class validate that `endTime > startTime`. A client can create events
with negative duration. `expandRecurrence()` computes `eventDuration = event.endTime - event.startTime`, which
becomes negative, producing occurrences where `endTime < startTime`.

**File:** `apps/api/src/routes/calendar.ts:46-59` (CreateEventSchema), `apps/api/src/lib/calendar/calendar.ts:256`
**Impact:** Invalid data stored. Negative-duration occurrences in range queries.
**Fix:** Add `endTime > startTime` validation in `CreateEventSchema` and `UpdateEventSchema`, or as a guard in
`createEvent()`/`updateEvent()`. For all-day events, `endTime` should be at least one day after `startTime`.
**Status:** Previously reported (issue #6). Confirmed.

---

**10. Recurring vs. non-recurring range filtering is inconsistent**

Non-recurring events use an overlap check: `startTime <= to AND endTime >= from`. This correctly includes events
that started before the range but extend into it.

Recurring event occurrences use a start-time-only check. The non-timezone path uses `rule.between(rangeStart,
rangeEnd, true)`, which only matches occurrences whose dtstart falls within the range. The timezone path filters
with `ts >= rangeFrom && ts <= rangeTo`. Both miss occurrences that start before `rangeFrom` but whose
`endTime` (= `ts + eventDuration`) extends into the range.

For example: a recurring 3-hour meeting that starts at 23:00 on the day before the range would be included as a
non-recurring event (overlap check passes) but missed as a recurring occurrence (start time is before range).

**File:** `apps/api/src/lib/calendar/calendar.ts:1081`, `calendar.ts:1100-1102`
**Impact:** Recurring events spanning the range boundary are missing from results while equivalent non-recurring
events are returned. Inconsistent behavior.
**Fix:** In the timezone path, change the filter to `ts + eventDuration >= rangeFrom && ts <= rangeTo`. In the
non-timezone path, adjust `rangeStart` backward by `eventDuration` before calling `rule.between()`, then filter
the results.
**Status:** New finding.

---

**11. `notifySharedCalendarUsers` does not notify team members**

The team notification code in `notifySharedCalendarUsers` is commented out:

```typescript
} else if (parsed.type === 'team') {
    // for teams, we really on staletime refresh at FE
}
```

Team members do not receive real-time SSE notifications when events change on team-shared calendars. They see
updates only on the next frontend stale-time refresh.

Note: `propagateCalendarShare()` (a different function in the same file) *does* resolve team members and propagate
to them. The inconsistency is that share changes are real-time but event changes are not.

**File:** `apps/api/src/lib/calendar/share-propagation.ts:25-29`
**Impact:** Degraded real-time experience for team calendar users. Inconsistent behavior between share propagation
(real-time) and event notifications (delayed).
**Fix:** Uncomment and implement team member resolution, or document this as intentional with a rationale.
**Status:** Previously reported (issue #4). Confirmed. Added observation about the inconsistency with
`propagateCalendarShare`.

---

**12. `parseOwnerId` used on email-based `targetId` in `notifySharedCalendarUsers`**

`CalendarShare.targetId` is either an email address (for user shares) or `team_{id}` (for team shares). The code
passes it to `parseOwnerId()`, which is designed for owner ID strings (UUID or `team_`-prefixed):

```typescript
for (const share of shares) {
    const parsed = parseOwnerId(share.targetId);
    if (parsed.type === 'user') {
        const user = await getUserByEmail(share.targetId);
```

For email addresses, `parseOwnerId` detects the `@` and returns `{type: 'user', id: email.toLowerCase()}`.
Then `getUserByEmail(share.targetId)` is called with the original (possibly mixed-case) email. This works because
`getUserByEmail` lowercases internally, and `parseOwnerId` happens to route emails to the `user` branch.

However, `parseOwnerId` was not designed for this use case. If its email detection logic ever changes, this code
would silently break (e.g., the UUID regex check at line 24 of `owner.ts` would reject the email-derived `id`
and return `{type: 'user', id: ''}`).

**File:** `apps/api/src/lib/calendar/share-propagation.ts:20-24`
**Impact:** Fragile code coupling. Correct by coincidence.
**Fix:** Replace `parseOwnerId` with a direct check: `share.targetId.startsWith('team_')`.
**Status:** Previously reported (issue #5). Confirmed after tracing through `parseOwnerId` in
`packages/lib/src/types/owner.ts`.

---

**13. No unique constraint on `shared_calendars(ownerUserId, calendarId)`**

The `shared_calendars` table has no unique constraint on `(ownerUserId, calendarId)`. The code handles this with
check-then-insert logic in `receiveShare()` and `ensureSharedEntry()`, but without a unique constraint, concurrent
share propagations to the same target could create duplicate entries.

While SQLite's single-writer model makes this unlikely in normal operation, the async nature of share propagation
(fire-and-forget from the mutation handler) means two propagation tasks could interleave their read-check and
insert operations across different event loop ticks.

**File:** `apps/api/src/lib/calendar/schema.ts:48-59`, `apps/api/src/lib/calendar/db-config.ts:57-68`
**Impact:** Potential duplicate shared calendar entries in edge cases.
**Fix:** Add a unique index: `CREATE UNIQUE INDEX idx_shared_owner_cal ON shared_calendars(ownerUserId, calendarId)`.
Update `receiveShare()` to use `INSERT ... ON CONFLICT ... DO UPDATE`.
**Status:** Previously reported (issue #18). Confirmed.

## Minor Issues

**14. `shared` endpoint ignores `ownerId` parameter**

The `GET /calendar/:ownerId/shared` endpoint declares an `ownerId` path parameter but never uses it:

```typescript
.get("/calendar/:ownerId/shared", async ({user}) => {
    return syncTeamCalendars(user);
}, {auth: true})
```

It always operates on the authenticated user's data. `GET /calendar/anyone/shared` returns the caller's own shared
calendars. This is not a security issue (it never leaks other users' data), but the semantic mismatch could confuse
API consumers and is inconsistent with other calendar endpoints that use `ownerId`.

**File:** `apps/api/src/routes/calendar.ts:182-184`
**Impact:** Misleading API contract. No functional impact.
**Fix:** Either use `ownerId` (with appropriate authorization) or remove it from the route pattern.
**Status:** Previously reported (issue #2). Downgraded from Critical to Minor after confirming no security impact.

---

**15. MD5 used for etag computation**

`createHash('md5')` is used for etag generation. MD5 is cryptographically broken, and while etags are not a
security mechanism (this is change detection, not authentication), security scanners commonly flag MD5 usage.

**File:** `apps/api/src/lib/calendar/calendar.ts:43`
**Impact:** Security scanner noise. No actual vulnerability.
**Fix:** Replace with `createHash('sha256')` or a simpler non-crypto hash. Alternatively, use a counter-based
etag (the ctag pattern already exists for calendars).
**Status:** Previously reported (issue #11). Confirmed.

---

**16. SQL template literals split across lines**

Multi-line SQL template literals with `IS NOT NULL` on a new line appear in three places:

```typescript
sql`${schema.events.rrule}
IS NOT NULL`,
```

```typescript
sql`${schema.calendars.ctag}
+ 1`,
```

These work because SQLite treats whitespace as token separators, but they appear to be accidental line breaks
from auto-formatting. They reduce readability.

**File:** `apps/api/src/lib/calendar/calendar.ts:445-446`, `454-455`, `1033-1034`
**Impact:** Readability.
**Fix:** Keep on single lines: `` sql`${schema.events.rrule} IS NOT NULL` ``.
**Status:** Previously reported (issue #13). Confirmed.

---

**17. Non-null assertion on optional `organizerEventId`**

```typescript
const organizerEventId = event.data.organizerEventId!;
```

`EventData.organizerEventId` is typed as `string | undefined`. The non-null assertion is safe because the code
has already verified `event.data?.organizer` exists (line 954), and invite propagation always sets both fields
together. However, the assertion obscures this implicit coupling.

**File:** `apps/api/src/lib/calendar/calendar.ts:963`
**Impact:** Defensive coding concern. No runtime risk in current code paths.
**Fix:** Add an explicit guard: `if (!event.data.organizerEventId) throw new ApiError(500, 'Missing organizer
event ID')`.
**Status:** Previously reported (issue #16). Confirmed.

---

**18. Typo in comment**

```typescript
// for teams, we really on staletime refresh at FE
```

Should be "we rely on stale-time refresh at FE".

**File:** `apps/api/src/lib/calendar/share-propagation.ts:26`
**Status:** Previously reported (issue #15). Confirmed.

---

**19. `getEventsWithAttendee` performs full table scan with JS-side filtering**

This method loads all non-linked events, maps them to typed objects, then filters in JavaScript by parsing the
JSON `data` column:

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

Used in share reconciliation when a new user signs up. Performance degrades linearly with total event count.

**File:** `apps/api/src/lib/calendar/calendar.ts:854-864`
**Impact:** Performance concern. Currently only used during reconciliation (infrequent), so low practical impact.
**Fix:** Use SQLite's JSON functions: `WHERE json_each(data, '$.attendees') ...` or add a `LIKE` pre-filter
on the data column to reduce the candidate set.
**Status:** Previously reported (issue #9). Downgraded from Important to Minor after confirming it is only used
during reconciliation, not in hot paths.

## Observations

**Timezone handling is well-engineered.** The `utcToLocal()` / `localToUtcSeconds()` pair correctly handles DST
transitions using `Intl.DateTimeFormat` with a verify-and-correct pattern. The `intlCache` avoids repeated
allocations. The approach of converting to wall-clock time, letting `rrule.js` operate in that space, and converting
back avoids the known issues with rrule.js's built-in (and broken) TZID support.

**Error isolation in async propagation is appropriate.** All fire-and-forget propagation calls (invites, shares,
SSE notifications) use `.catch(console.error)` or `.catch(() => {})`, preventing secondary failures from crashing
the primary mutation response. This is correct for the fire-and-forget pattern.

**Transaction usage is inconsistent but acceptable.** `updateAttendeeStatus()` uses a transaction for its
read-modify-write cycle. `rsvpForOccurrence()` does not, despite doing a similar read-check-write pattern.
SQLite's single-writer model makes this safe in practice, but the inconsistency is worth noting.

**CalDAV readiness is forward-looking.** The `uid`, `uri`, `etag`, `ctag`, and `sequence` fields are correctly
maintained and would ease future CalDAV server integration. The `constrainRRule` function correctly prevents
organizer updates from extending beyond an attendee's local RRULE truncation.

**The `resolveCalendar` function for non-team user IDs always returns the caller's own calendar** (line 22:
`getHome(parsed.type === 'team' ? ownerId : user.id)`). This means the ownerId parameter is effectively ignored
for user-type IDs on the calendar CRUD routes (`GET /calendars`, `POST /calendars`, `PUT /calendars/:calId`,
`DELETE /calendars/:calId`). This appears intentional -- calendar management is always self-directed, while
cross-user access goes through `resolveCalendarForEvents` -- but it means the API contract is looser than it
appears.

**The `propagateCalendarShare` function calls `getTeamMembers` twice** for team shares in the worst case: once in
the initial loop (line 65) to collect user IDs, and again in the permission resolution loop (line 93) to check
membership. With N team shares, this results in 2N calls to `getTeamMembers`. Each call queries the auth database.
This is not a bug but could be optimized with caching.

**Edge cases handled well:**
- Self-invite prevention (organizer email skipped during propagation)
- Linked event guard (attendees restricted to reminders/color changes only)
- RRULE constraint on invitation updates (attendee truncation preserved)
- Idempotent invitation receipt (returns existing ID if already exists)
- Calendar ctag increment on all event mutations
- Default calendar protection (cannot delete)

## Test Coverage

Four test files in `apps/api/src/test/`:

| Test file | Coverage area |
|-----------|---------------|
| `calendar.test.ts` | CRUD, RRULE storage, recurrence expansion, exceptions, this-and-following, sharing, free-busy, cross-user isolation |
| `calendar-invites.test.ts` | Invite propagation, RSVP, update propagation, cancellation, linked event guard, self-invite prevention, per-occurrence RSVP, rrule constraint |
| `team-calendar-share.test.ts` | Team calendar sharing, membership-based access, team settings, disabled calendar |
| `calendar-timezone.test.ts` | Timezone storage, DST drift prevention (Amsterdam, US), timezone propagation via invites, occurrence RSVP with timezone, backward compat |

**Missing test coverage:**
- Malformed RRULE strings (create, expand, propagate)
- `startTime > endTime` events
- `from=0` in range queries (rejected by falsy check)
- Deleting a calendar with active shares (orphaned shared_calendars entries)
- Deleting a calendar with invited events (orphaned linked copies)
- Access endpoint information disclosure for free-busy users
- Team calendar permission enforcement (write hardcoding bypass)
- Concurrent share propagation (duplicate shared_calendars entries)
- Recurring occurrence spanning range boundary (missed due to start-time-only filter)
