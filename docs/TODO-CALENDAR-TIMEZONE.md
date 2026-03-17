# Calendar Timezone Implementation

Timezone-aware recurring events to prevent DST drift. Completed.

## Architecture

Events store an IANA `timezone` field (e.g. `Europe/Amsterdam`). Recurring events expand in wall-clock space to prevent DST drift.

**Key design decision:** We do NOT use `rrule`'s built-in `tzid` parameter — it's broken server-side (returns ambiguous "fake UTC" dates, comparison behavior depends on server `TZ`). Instead, we manually convert UTC ↔ wall-clock using `Intl.DateTimeFormat` (zero dependencies) and feed `rrule` plain UTC dates.

### Wall-clock conversion (no luxon, no Temporal)

Two helpers in `calendar.ts` replace what luxon previously did:

- `utcToLocal(epochSeconds, tz)` — UTC epoch → local {year,month,day,hour,minute,second} via `Intl.DateTimeFormat.formatToParts()`
- `localToUtcSeconds(tz, year, month, day, hour, minute, second)` — local components → UTC epoch via offset estimation + verification

### Recurrence expansion flow

1. Convert event's UTC `startTime` → wall-clock components in event's timezone
2. Create a "fake UTC" `Date` with those wall-clock values as UTC
3. Feed to `RRule` without `tzid` (pure UTC mode)
4. Get back "fake UTC" occurrence dates
5. Convert each occurrence's wall-clock components back to real UTC via `localToUtcSeconds`
6. Filter to requested range

Same pattern in `computeOccurrenceTimes()` for per-occurrence RSVP/cancellation.

## Files

- `apps/api/src/lib/calendar/schema.ts` — `timezone` column
- `apps/api/src/lib/calendar/calendar.ts` — `utcToLocal`, `localToUtcSeconds`, `expandRecurrence`, `computeOccurrenceTimes`, `computeEtag`
- `apps/api/src/lib/calendar/invite-propagation.ts` — passes `timezone` through invites
- `apps/api/src/routes/calendar.ts` — `timezone` in create/update schemas
- `packages/lib/src/types/calendar.ts` — `timezone: string | null` on `CalendarEvent`
- `apps/calendar/src/components/create-event-dialog.tsx` — auto-sends `Intl.DateTimeFormat().resolvedOptions().timeZone`
- `apps/calendar/src/components/edit-event-dialog.tsx` — preserves existing timezone
- `apps/calendar/src/components/event-detail-dialog.tsx` — displays timezone (muted)
- `apps/api/src/test/calendar-timezone.test.ts` — 16 tests covering DST drift, invite propagation, backward compat

## Rules

- All-day events: `timezone = null` (UTC midnight boundaries, no drift)
- Old events without timezone: fall back to UTC expansion (backward compat)
- Timezone propagates through invites — attendee's recurrence expands identically to organizer's
- Timezone changes affect `etag`

## Future

- Timezone picker UI (Google Calendar-style) for creating events in a different timezone than the browser's
