# TODO: Timezone-Aware Recurrence Expansion

## Problem

Recurring events drift by 1 hour across DST boundaries. A weekly event at "Monday 23:30 CET" becomes "Tuesday 00:30
CEST" after the spring clock change, because recurrence expansion happens in UTC.

## Root Cause

`expandRecurrence()` creates RRule with `dtstart` as a UTC timestamp. RRule generates occurrences at fixed UTC offsets,
ignoring DST transitions in the user's timezone.

## Fix

### 1. Add `timezone` field to events

Schema (`apps/api/src/lib/calendar/schema.ts`):

```typescript
timezone: text('timezone'),  // e.g. "Europe/Amsterdam"
```

### 2. Add `luxon` dependency

Required by the `rrule` package for `tzid` support.

### 3. Expand with `tzid`

In `expandRecurrence()` (`apps/api/src/lib/calendar/calendar.ts`):

```typescript
const rule = new RRule({
    ...RRule.parseString(event.rrule),
    dtstart,
    tzid: event.timezone ?? undefined,
});
```

### 4. Set timezone on creation

Frontend sends `Intl.DateTimeFormat().resolvedOptions().timeZone` when creating events. Propagate through
`receiveInvitation` so linked copies preserve the organizer's timezone.

### 5. Plumbing

- `CreateEventSchema` / `UpdateEventSchema` — add optional `timezone` field
- `createEvent()` / `receiveInvitation()` — store timezone
- `computeOccurrenceTimes()` — use timezone-aware expansion
- `truncateRRule()` — no change needed (UNTIL is already UTC)

## CalDAV compliance

This matches RFC 5545: `DTSTART;TZID=Europe/Amsterdam:20260316T233000`. The timezone belongs to DTSTART, recurrence
expands in that timezone. Already have CalDAV-ready fields (uid, etag, sequence, ctag) — this completes the picture.
