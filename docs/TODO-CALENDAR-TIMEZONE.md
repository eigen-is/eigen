# TODO: Timezone-Aware Calendar Events

## Problem

Two related issues:

1. **Recurring event DST drift:** A weekly event at "Monday 23:30 CET" becomes "Tuesday 00:30 CEST" after the spring
   clock change, because `expandRecurrence()` uses UTC-only timestamps. RRule generates occurrences at fixed UTC
   offsets, ignoring DST transitions.

2. **No timezone metadata on events:** Events store Unix timestamps (seconds since epoch) with no timezone context.
   This works for single-timezone usage but breaks when:
   - Users travel or collaborate across timezones
   - CalDAV sync requires `DTSTART;TZID=...` (RFC 5545)
   - Shared calendars display events in the viewer's timezone

## Root Cause

`expandRecurrence()` in `calendar.ts` creates an RRule with `dtstart` as a plain UTC `Date`. The `rrule` package
treats this as UTC and generates all occurrences at fixed UTC offsets, ignoring DST transitions in the user's local
timezone.

The frontend creates timestamps using `new Date(\`${startDate}T${startTime}\`)` which uses **local time** (browser
timezone), then converts to Unix seconds. This means `startTime`/`endTime` in the DB are correct UTC timestamps, but
the original timezone intent is lost — there's no way to know "this was meant to be 09:00 Amsterdam time."

## Scope

This fix is **backend + plumbing only** with minimal frontend changes. The timezone field is set automatically from
the browser — no timezone picker UI needed now (see Future section for Google Calendar-style picker).

---

## Fix

### 1. Add `timezone` column to events

Schema (`apps/api/src/lib/calendar/schema.ts`):

```typescript
timezone: text('timezone'),  // IANA timezone, e.g. "Europe/Amsterdam"
```

Update `db-config.ts` v1 DDL to include:
```sql
timezone TEXT,
```

Data is throwaway during dev — no migration needed.

Add to types (`packages/lib/src/types/calendar.ts`):
```typescript
// In CalendarEvent:
timezone: string | null

// In CreateEventInput:
timezone?: string | null

// In UpdateEventInput:
timezone?: string | null
```

Update `dbEventToCalendarEvent()` to map `timezone`.

### 2. Add `luxon` dependency

The `rrule` package requires `luxon` for `tzid` support. It uses luxon's `DateTime` internally to convert between
timezone-aware and UTC times during recurrence expansion.

```
bun add luxon
bun add -d @types/luxon
```

**Note:** `luxon` is only used server-side by `rrule`. No frontend dependency needed.

### 3. Fix `expandRecurrence()` — use `tzid`

Current code:
```typescript
const dtstart = new Date(event.startTime * 1000);
const rule = new RRule({
    ...RRule.parseString(event.rrule),
    dtstart,
});
```

Fixed:
```typescript
const dtstart = new Date(event.startTime * 1000);
const rule = new RRule({
    ...RRule.parseString(event.rrule),
    dtstart,
    tzid: event.timezone ?? undefined,
});
```

When `tzid` is set, `rrule` uses luxon to expand occurrences in that timezone, correctly handling DST transitions.
When `tzid` is `undefined` (null timezone, all-day events, or old events), it falls back to UTC — same behavior as
before.

### 4. Fix `computeOccurrenceTimes()` — use timezone-aware expansion

Current `computeOccurrenceTimes()` expands recurrence without timezone. It needs the same `tzid` treatment:

```typescript
function computeOccurrenceTimes(parent: CalendarEvent, recurrenceDate: string): {startTime: number; endTime: number} {
    const duration = parent.endTime - parent.startTime;
    const dtstart = new Date(parent.startTime * 1000);
    const occDate = new Date(recurrenceDate + 'T00:00:00Z');

    if (parent.rrule) {
        const rule = new RRule({
            ...RRule.parseString(parent.rrule),
            dtstart,
            tzid: parent.timezone ?? undefined,
        });
        const dayStart = new Date(occDate);
        const dayEnd = new Date(occDate);
        dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
        const matches = rule.between(dayStart, dayEnd, true);
        if (matches.length > 0) {
            const startTime = Math.floor(matches[0].getTime() / 1000);
            return {startTime, endTime: startTime + duration};
        }
    }

    // Fallback: place dtstart's time-of-day onto the occurrence date
    const startTime = Math.floor(occDate.getTime() / 1000) +
        dtstart.getUTCHours() * 3600 + dtstart.getUTCMinutes() * 60 + dtstart.getUTCSeconds();
    return {startTime, endTime: startTime + duration};
}
```

### 5. Fix `formatOccurrenceDate()` — timezone-aware date key

Current code uses `getUTCFullYear()`/`getUTCMonth()`/`getUTCDate()` to format occurrence dates. When `rrule` expands
with `tzid`, the returned `Date` objects are UTC representations of the local time. This is correct — the `rrule`
package returns UTC dates where the UTC values represent the wall-clock time in the specified timezone. No change
needed to `formatOccurrenceDate()`.

However, for **non-recurring events**, `getEventsInRange()` builds `occurrenceDate` from `new Date(evt.startTime * 1000)`
using `getUTCFullYear()`/`getUTCMonth()`/`getUTCDate()`. This is **wrong for timed events** — a 23:30 CET event has
UTC time 22:30, so `getUTCDate()` returns the correct UTC date, but the user sees it on the wrong calendar day if
their timezone is ahead of UTC. This is a pre-existing bug that this plan doesn't need to fix now (the frontend
already handles display correctly using local time via `new Date(e.startTime * 1000)` + `getDate()`), but worth
noting. The `occurrenceDate` is only used as a key for exception matching, not for display.

### 6. Set timezone on event creation

**Frontend** (`create-event-dialog.tsx`, `edit-event-dialog.tsx`):

The browser knows the user's timezone. Send it automatically on create:

```typescript
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

await createEvent.mutateAsync({
    // ... existing fields
    timezone,
});
```

On edit: preserve existing `event.timezone` if not changed. The timezone field is **not user-editable** in the initial
implementation — it's auto-detected. See Future section for the picker UI.

**Route schemas** (`apps/api/src/routes/calendar.ts`):

Add to `CreateEventSchema` and `UpdateEventSchema`:
```typescript
timezone: t.Optional(t.Nullable(t.String())),
```

**`createEvent()`** — store timezone:
```typescript
// In the insert:
timezone: input.timezone ?? null,
```

**`updateEvent()`** — preserve or update timezone:
```typescript
const timezone = input.timezone !== undefined ? (input.timezone ?? null) : (existing.timezone ?? null);
// Include in the update SET clause
```

### 7. Propagate timezone through invitations

The timezone belongs to the **event**, not the user. Linked copies must preserve the organizer's timezone so
recurrence expands identically.

**`receiveInvitation()`** — add `timezone` to payload and store it:
```typescript
// In payload type:
timezone: string | null;
// In insert:
timezone: payload.timezone,
```

**`receiveInvitationUpdate()`** — add `timezone` to payload and update it:
```typescript
// In payload type:
timezone?: string | null;
// In update SET:
timezone: payload.timezone ?? linked.timezone,
```

**`invite-propagation.ts`** — pass `event.timezone` through:
```typescript
// In propagateInvitation, receiveInvitation call:
timezone: event.timezone,

// In propagateInvitation, receiveInvitationUpdate call:
timezone: event.timezone,
```

**`reconciliation.ts`** — pass timezone in `pullPendingInvitations`:
```typescript
timezone: event.timezone,
```

### 8. Include timezone in `computeEtag()`

The timezone affects how the event behaves. Changing timezone = different event semantically.

```typescript
function computeEtag(event: {
    // ... existing fields
    timezone?: string | null;
}): string {
    const hash = createHash('md5');
    hash.update(JSON.stringify({
        // ... existing fields
        timezone: event.timezone,
    }));
    return hash.digest('hex');
}
```

### 9. All-day events — no timezone needed

All-day events store `startTime`/`endTime` as UTC midnight boundaries (e.g., `2026-03-21T00:00:00Z` to
`2026-03-22T00:00:00Z`). They don't have a "time" that drifts with DST. The frontend already handles this correctly
by using `getUTCFullYear()`/`getUTCMonth()`/`getUTCDate()` for all-day events.

`timezone` should be `null` for all-day events. The frontend should not send timezone when `allDay` is true:

```typescript
timezone: allDay ? null : Intl.DateTimeFormat().resolvedOptions().timeZone,
```

CalDAV all-day events use `VALUE=DATE` (no timezone): `DTSTART;VALUE=DATE:20260321`. This aligns.

---

## CalDAV Compliance

This matches RFC 5545 `DTSTART;TZID=Europe/Amsterdam:20260316T233000`. The timezone belongs to DTSTART, recurrence
expands in that timezone.

| CalDAV Concept | Implementation | Notes |
|---|---|---|
| `DTSTART;TZID=...` | `timezone` column | IANA timezone string, same format as CalDAV |
| `DTSTART;VALUE=DATE` | `allDay=true`, `timezone=null` | All-day events have no timezone |
| `VTIMEZONE` component | Not stored | Generated from IANA ID at CalDAV export time |
| `RRULE` expansion in timezone | `rrule` + `tzid` param | `rrule` package handles this via luxon |
| `UNTIL` in RRULE | Stays UTC | RFC 5545: UNTIL is always UTC when DTSTART has TZID |

Already have CalDAV-ready fields (`uid`, `etag`, `sequence`, `ctag`) — timezone completes the picture.

---

## Comparison with Existing Sharing/Propagation

| Aspect | Calendar Sharing | Event Invites | **Timezone** |
|---|---|---|---|
| **What propagates** | `shared_calendars` entry | Full event copy | Timezone is part of the event copy |
| **Impact on shared calendars** | Viewer sees events in their own timezone | Linked copy preserves organizer's timezone | Shared calendar events use organizer's timezone for recurrence |
| **Cross-timezone scenario** | Viewer in NYC sees Amsterdam event at correct local time (timestamps are UTC) | Same — linked copy has UTC timestamps | Recurrence expands correctly: "every Monday 09:00 Amsterdam" stays 09:00 Amsterdam even across DST |

The timezone field propagates automatically through existing invite mechanisms because it's just another event field.
No changes to SSE events, registry, or reconciliation logic needed — only the data passed through needs the field.

---

## UI Integration

### Phase 1 (this plan): Auto-detect, no picker

- `create-event-dialog.tsx`: Auto-send `Intl.DateTimeFormat().resolvedOptions().timeZone` — no visible UI change
- `edit-event-dialog.tsx`: Preserve existing timezone, auto-set if creating new
- `event-detail-dialog.tsx`: Optionally show timezone if it differs from the viewer's local timezone (small text
  like "Europe/Amsterdam" next to the time)
- `week-view.tsx` / `month-view.tsx`: No changes — already display using `new Date(event.startTime * 1000)` which
  shows in browser's local timezone

### Phase 2 (future): Timezone picker (Google Calendar-style)

As shown in the reference screenshots, Google Calendar has a "Time zone" link next to "All day" that opens a dialog
with:
- "Use separate start and end time zones" checkbox
- Timezone selector dropdown (searchable, shows offset + name)
- "Use current time zone" button

For Eigen, this would be:
- Add a "Time zone" link/button next to the "All day" checkbox in create/edit dialogs
- Opens a popover/dialog with a searchable timezone `Select` component
- Pre-filled with auto-detected timezone
- Separate start/end timezones are a CalDAV feature (`DTSTART;TZID=...` / `DTEND;TZID=...`) — defer to CalDAV phase

This is **not in scope** for this plan. The auto-detect approach covers 95% of use cases. The picker is needed when:
- Creating an event in a different timezone than your current one (e.g., booking a meeting room in another office)
- Travel planning (event in destination timezone)

---

## Implementation Steps

### Step 1: Schema + types

| File | Change |
|---|---|
| `apps/api/src/lib/calendar/schema.ts` | Add `timezone` column |
| `apps/api/src/lib/calendar/db-config.ts` | Add `timezone TEXT` to v1 DDL |
| `packages/lib/src/types/calendar.ts` | Add `timezone` to `CalendarEvent`, `CreateEventInput`, `UpdateEventInput` |
| `apps/api/src/lib/calendar/calendar.ts` | Update `dbEventToCalendarEvent()`, `computeEtag()` |

### Step 2: Backend — recurrence + storage

| File | Change |
|---|---|
| `apps/api/src/lib/calendar/calendar.ts` | Fix `expandRecurrence()` with `tzid`, fix `computeOccurrenceTimes()`, store timezone in `createEvent()`/`updateEvent()` |
| `apps/api/src/routes/calendar.ts` | Add `timezone` to `CreateEventSchema`/`UpdateEventSchema` |

### Step 3: Invite propagation

| File | Change |
|---|---|
| `apps/api/src/lib/calendar/calendar.ts` | Add `timezone` to `receiveInvitation()`/`receiveInvitationUpdate()` payloads |
| `apps/api/src/lib/calendar/invite-propagation.ts` | Pass `event.timezone` in propagation calls |
| `apps/api/src/lib/share/reconciliation.ts` | Pass `event.timezone` in `pullPendingInvitations()` |

### Step 4: Frontend

| File | Change |
|---|---|
| `apps/calendar/src/components/create-event-dialog.tsx` | Send `timezone` from `Intl.DateTimeFormat()` |
| `apps/calendar/src/components/edit-event-dialog.tsx` | Preserve/send `timezone` |
| `apps/calendar/src/components/event-detail-dialog.tsx` | Optionally display timezone if different from viewer's |

### Step 5: Dependency

Install `luxon` + `@types/luxon` in `apps/api` (ask user first — never run install commands directly).

---

## Edge Cases

| Case | Behavior |
|---|---|
| **Old events without timezone** | `timezone` is null → `tzid` is undefined → RRule falls back to UTC. Same as current behavior. |
| **All-day events** | `timezone` set to null. No DST drift possible (midnight-to-midnight UTC boundaries). |
| **Shared calendar across timezones** | Events display in viewer's local timezone (via `new Date(ts * 1000)`). Recurrence expands correctly per organizer's timezone. |
| **Timezone change on existing recurring event** | Update stores new timezone. Future expansions use new timezone. Past occurrences are already materialized as exceptions — unaffected. |
| **User travels to new timezone** | New events get new timezone automatically. Old events keep their original timezone. Correct behavior. |
| **Linked event (invite) timezone** | Preserves organizer's timezone. Attendee's recurrence expands identically. |
| **`truncateRRule()`** | No change needed. UNTIL is UTC per RFC 5545. |

---

## File Inventory

### Modified — backend
- `apps/api/src/lib/calendar/schema.ts` — add `timezone` column
- `apps/api/src/lib/calendar/db-config.ts` — add `timezone TEXT` to DDL
- `apps/api/src/lib/calendar/calendar.ts` — `dbEventToCalendarEvent`, `computeEtag`, `expandRecurrence`, `computeOccurrenceTimes`, `createEvent`, `updateEvent`, `receiveInvitation`, `receiveInvitationUpdate`
- `apps/api/src/routes/calendar.ts` — add `timezone` to create/update schemas
- `apps/api/src/lib/calendar/invite-propagation.ts` — pass `timezone` through
- `apps/api/src/lib/share/reconciliation.ts` — pass `timezone` in `pullPendingInvitations`

### Modified — shared types
- `packages/lib/src/types/calendar.ts` — add `timezone` to `CalendarEvent`, `CreateEventInput`, `UpdateEventInput`

### Modified — frontend
- `apps/calendar/src/components/create-event-dialog.tsx` — send timezone
- `apps/calendar/src/components/edit-event-dialog.tsx` — preserve/send timezone
- `apps/calendar/src/components/event-detail-dialog.tsx` — optional timezone display

### New dependency
- `luxon` + `@types/luxon` in `apps/api`
