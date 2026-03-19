# FE Code Review: Calendar

## Summary

The Calendar frontend is a well-organized React application with TanStack Router + TanStack Query, following most Eigen
patterns. The sidebar, month view, week view, event dialogs, and RSVP flows are cleanly implemented. The hooks live in
`packages/lib/` as required. However, there are several pattern violations: `as any` cast, missing `ownerId` in query
keys, missing error feedback on mutations, `useQuery`/`useMutation` used correctly in lib hooks but with some gaps,
and date/time handling that uses local time in places where UTC would be expected.

## Critical Issues

### 1. Query keys missing `ownerId` -- stale data when switching contexts

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/calendar/hooks/use-calendar.ts`, lines 14-22

```typescript
export const calendarKeys = {
    all: ['calendar'] as const,
    calendars: () => [...calendarKeys.all, 'calendars'] as const,
    calendarList: () => [...calendarKeys.calendars(), 'list'] as const,
    events: () => [...calendarKeys.all, 'events'] as const,
    eventRange: (from: number, to: number) => [...calendarKeys.events(), {from, to}] as const,
    // ...
    sharedCalendars: () => [...calendarKeys.all, 'shared'] as const,
};
```

Per CLAUDE.md: "Query keys must include `ownerId` for any owner-scoped data. Without it, switching between personal
and team contexts serves stale cached data from the wrong owner."

The `calendarList`, `eventRange`, and `sharedCalendars` keys do not include `ownerId`. If a user views team calendar
data and then switches to personal, the cached data from the team context could be served.

The `calendarEvents` key correctly includes `ownerId` and `calendarId`, but the others are owner-agnostic.

**Impact**: Stale data displayed when switching between personal and team calendar views.

**Fix**: Add `ownerId` to `calendarList`, `eventRange`, and `sharedCalendars` keys:

```typescript
calendarList: (ownerId: string) => [...calendarKeys.calendars(), ownerId, 'list'] as const,
eventRange: (ownerId: string, from: number, to: number) => [...calendarKeys.events(), ownerId, {from, to}] as const,
sharedCalendars: (ownerId: string) => [...calendarKeys.all, 'shared', ownerId] as const,
```

### 2. `as any` in index route redirect

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/routes/index.tsx`, line 11

```typescript
throw redirect({
    to: '/view/$mode/$from/$to',
    params: {mode: 'month', from: String(from), to: String(to)},
} as any);
```

Per CLAUDE.md: "Never use `as any` -- fix the type at the source."

This `as any` is used to work around TanStack Router's type system not recognizing the dynamic route params. The fix is
to properly type the redirect target using TanStack Router's `createFileRoute` type inference.

### 3. Multiple mutations missing error feedback

Per CLAUDE.md: "Every mutation needs error feedback -- wrap `mutateAsync` in try/catch with `toast.error()`, or use
the `onError` callback. Never swallow errors by catching and returning null."

**Violations**:

a) **Sidebar toggle mutations** (`calendar-sidebar.tsx`, lines 181, 223, 255):

```typescript
onChange={() => updateCalendar.mutate({id: cal.id, visible: !cal.visible})}
onToggle={() => updateSharedCalendar.mutate({id: sc.id, visible: !sc.visible})}
```

These use `.mutate()` (not `.mutateAsync()`) with no `onError` callback. If the toggle fails, the user sees no
feedback.

b) **RSVP mutations** (`event-detail-dialog.tsx`, lines 220, 228, 299):

```typescript
rsvp.mutate({calendarId: event.calendarId, eventId, status: pendingRsvpStatus});
rsvp.mutate({calendarId: event.calendarId, eventId: event.id, status});
```

RSVP calls use `.mutate()` with no error handling. A failed RSVP silently does nothing.

c) **Calendar config dialog** (`calendar-config-dialog.tsx`, lines 85-86, 98-99):

```typescript
} catch (error) {
    console.error('Error saving calendar:', error);
}
```

Errors are logged to console but no `toast.error()` is shown to the user.

d) **Shared calendar config dialog** (`shared-calendar-config-dialog.tsx`, lines 62-63, 74-75):
Same pattern: `console.error()` without `toast.error()`.

e) **Delete handlers in event-detail-dialog** (`event-detail-dialog.tsx`, lines 124-183):
The `handleDelete` and `handleNonRecurringDelete` functions use `await` on `mutateAsync` but have no try/catch and
no error handling at all. If deletion fails, the dialog closes anyway.

**Fix**: Add `toast.error()` in all catch blocks, add `onError` callbacks to `.mutate()` calls.

## Pattern Violations

### 4. `useEvents` hook response uses type assertion

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/calendar/hooks/use-calendar.ts`, line 84

```typescript
return (response.data || []) as CalendarEventOccurrence[];
```

Multiple hooks use `as CalendarEventOccurrence[]` and `as CalendarItem[]` type assertions on the response data. Eden
Treaty should provide type safety from the Elysia route definitions. If the types don't match, the assertion masks the
mismatch rather than fixing it at the source.

### 5. `getMonthRange` and `getWeekRange` use local time for range calculation

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/calendar-utils.ts`, lines 5-26

```typescript
const from = Math.floor(new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime() / 1000);
const to = Math.floor(new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 23, 59, 59).getTime() / 1000);
```

These functions compute Unix timestamps from local time, meaning the `from` and `to` parameters sent to the server
depend on the user's browser timezone. The server queries events with `startTime <= to AND endTime >= from` where
`startTime`/`endTime` are UTC timestamps. For users in UTC+12 or UTC-12, the range mismatch could be up to 12 hours,
potentially missing events at the boundaries. This is partially mitigated by the server padding recurring event
expansion by +/-1 day, but non-recurring events near the boundary could be missed.

### 6. `formatEventTime` uses local time for display without timezone context

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/calendar-utils.ts`, lines 86-95

```typescript
export function formatEventTime(event: CalendarEventOccurrence): string {
    if (event.allDay) return '';
    const d = new Date(event.startTime * 1000);
    const h = d.getHours();
```

Event times are displayed in the browser's local timezone (`getHours()`). If the event was created in a different
timezone, the displayed time is silently converted. For timed events, this is correct behavior (showing in local time),
but the event's `timezone` field is never used for display context.

### 7. `getEventsForDay` mixes UTC and local time

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/calendar-utils.ts`, lines 66-77

For all-day events, the function correctly uses `Date.UTC()` to compare against UTC timestamps. But for timed events,
it uses `new Date(day.getFullYear(), day.getMonth(), day.getDate())` which is local time. The `day` parameter comes
from `getDaysInRange` which also uses local `Date` objects. This inconsistency means timed events near midnight could
appear on the wrong day depending on the user's timezone.

### 8. `RecurrencePicker` preset values include `RRULE:` prefix from `rrule` library

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/recurrence-picker.tsx`, line 47

```typescript
value: new RRule({freq: Frequency.DAILY}).toString(),
```

`RRule.toString()` returns strings like `RRULE:FREQ=DAILY`. The backend `RRule.parseString()` expects the string
without the `RRULE:` prefix. The backend stores and transmits rrule strings without the prefix (see
`calendar.ts:1151` where `result.replace(/^RRULE:/, '')` strips it). When the frontend sends a preset value,
it includes the prefix, which the backend's `RRule.parseString()` may or may not handle depending on the rrule library
version.

**Fix**: Strip `RRULE:` prefix from preset values, or ensure the backend handles both formats.

## Security Concerns

### 9. No sanitization on event title/description before display

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/event-detail-dialog.tsx`, line 239

```typescript
<DialogTitle className="text-xl">{event.title}</DialogTitle>
```

React auto-escapes JSX content, so XSS via HTML injection is not a concern. However, very long titles or descriptions
with control characters could break the UI layout. The description uses `whitespace-pre-wrap` (line 272) which
faithfully renders whitespace, meaning a description with thousands of newlines would create a very tall dialog.

### 10. Calendar access check could be bypassed via `calendarOptions` in EditEventDialog

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/edit-event-dialog.tsx`, lines 78-86

The `calendarOptions` list includes shared calendars with `write` permission. When moving an event to a different
calendar, the `moveEvent` function creates a new event on the target and deletes from the source. The backend enforces
permissions, so this is not a true bypass, but the frontend allows the user to attempt operations that may fail.

## Data Integrity

### 11. `doSave` in edit-event-dialog doesn't await `moveEvent` correctly for 'this-and-following'

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/edit-event-dialog.tsx`, lines 219-231

For `'this-and-following'` action:

```typescript
if (event.rrule) {
    const truncated = truncateRRule(event.rrule, occDate);
    await updateEvent.mutateAsync({id: parentId, calendarId: event.calendarId, rrule: truncated});
}
await createEvent.mutateAsync({
    calendarId: event.calendarId,
    ...updates,
});
```

If the first `updateEvent` succeeds (truncating the parent's rrule) but the second `createEvent` fails, the user
loses the "following" events with no way to recover. There's no transaction or rollback mechanism.

### 12. `handleDelete` in event-detail-dialog has no error feedback

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/event-detail-dialog.tsx`, lines 124-183

The entire `handleDelete` function has no try/catch or error handling. If any of the `mutateAsync` calls reject, the
error bubbles up unhandled (the `finally` block still runs, closing the dialog):

```typescript
} finally {
    setShowRecurringDeleteDialog(false);
    onOpenChange(false);
}
```

The dialog closes regardless of success or failure, giving the user no indication that the delete failed.

### 13. Event edit loses `data.organizer` information

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/edit-event-dialog.tsx`, line 191

```typescript
const data = {...event.data, attendees: attendees.length > 0 ? attendees : undefined};
```

When saving, the `data` object spreads `event.data` and overrides `attendees`. However, for the `'this'` action
(creating an exception), the entire event is re-created with this data object. The backend's `createEvent` doesn't
set `organizerEventId`/`organizerUserId` on exceptions created this way, which could disconnect the exception from
the linked event chain.

### 14. `useEffect` dependency arrays include object references

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/create-event-dialog.tsx`, line 103

```typescript
}, [open, defaultDate, defaultCalendarId, calendarOptions]);
```

`calendarOptions` is a `useMemo` result that changes reference on every render when `calendars` or `sharedCalendars`
change. This causes the `useEffect` to re-run and reset form state whenever calendar data is refetched, potentially
clearing user input while the dialog is open.

**Fix**: Use a ref to track whether the dialog just opened, and only reset on open transitions.

## Code Quality

### 15. Duplicated helper functions across files

- `toLocalDateString()`: defined in both `create-event-dialog.tsx` (line 32) and `edit-event-dialog.tsx` (line 44)
- `truncateRRule()`: defined in both `edit-event-dialog.tsx` (line 57) and `event-detail-dialog.tsx` (line 84)
- `toLocalTimeString()` / `toTimeString()`: similar functions with different names in create vs edit dialogs

**Fix**: Extract to `calendar-utils.ts` or a shared package.

### 16. Large component files

- `event-detail-dialog.tsx`: 395 lines handling detail view, RSVP, delete, recurring actions, and edit delegation
- `edit-event-dialog.tsx`: 397 lines handling form state, recurring actions, calendar moves, and time management
- `calendar-sidebar.tsx`: 293 lines handling three sections and three dialogs

### 17. `isLoading` state with `setTimeout` cleanup

**Files**: `create-event-dialog.tsx` line 162, `edit-event-dialog.tsx` line 238, `calendar-config-dialog.tsx` line 88,
`shared-calendar-config-dialog.tsx` line 65

```typescript
} finally {
    setTimeout(() => setIsLoading(false), 350);
}
```

This pattern delays resetting `isLoading` by 350ms for visual feedback. But if the component unmounts before the
timeout fires (e.g., dialog closes), it causes a React "update on unmounted component" warning. The `onOpenChange`
call (which closes the dialog) happens before `setIsLoading(false)`.

**Fix**: Use a ref to track mount state, or use TanStack Query's `isPending` from the mutation instead of manual
`isLoading` state.

### 18. `currentDate` derived from URL params can produce unexpected dates

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/routes/_auth.view.$mode.$from.$to.tsx`, lines 34-41

```typescript
const currentDate = useMemo(() => {
    const midTs = (from + to) / 2;
    const mid = new Date(midTs * 1000);
    if (viewMode === 'month') {
        return new Date(mid.getFullYear(), mid.getMonth(), 1);
    }
    return mid;
}, [from, to, viewMode]);
```

For month view, `currentDate` is derived by taking the midpoint of the `from`/`to` range and extracting the month.
If the range crosses a month boundary (which it always does because `getMonthRange` includes days from adjacent months),
the midpoint should be in the correct month. However, for ranges that are asymmetric or manually crafted URLs, this
could produce the wrong month.

### 19. Inconsistent use of `Boolean(allDay)` vs `allDay`

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/edit-event-dialog.tsx`

- Line 179: `allDay: Boolean(updates.allDay)` -- explicit coercion
- Line 214: `allDay: Boolean(allDay)` -- explicit coercion
- Line 229: `allDay: Boolean(allDay)` -- explicit coercion
- Line 197: `allDay,` -- no coercion

`allDay` is already a `boolean` from `useState<boolean>`, so `Boolean()` is redundant. Its inconsistent use suggests
uncertainty about the type.

### 20. RecurringActionDialog default selection doesn't reset

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/components/recurring-action-dialog.tsx`, line 25

```typescript
const [selected, setSelected] = useState<RecurringAction>(availableOptions[0]);
```

The `selected` state initializes to `availableOptions[0]` but doesn't reset when the dialog reopens. If the user
selects "this-and-following", closes the dialog, and reopens it, "this-and-following" is still selected instead of
the default first option.

**Fix**: Add `useEffect` to reset `selected` when `open` changes.

## Architecture

### 21. No mobile-responsive layout

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/calendar/src/routes/_auth.view.$mode.$from.$to.tsx`

```typescript
<ColumnLayout>
    <Column id="calendar-main" width="flex" toolbar={...}>
```

The calendar uses a single `Column` with `width="flex"`. There's no `mobileColumn` prop on `ColumnLayout`, and no
detail column for mobile. The month and week views render full grids that would be very small on mobile screens.
Per `LAYOUT.md`, `mobileColumn` should control which column is visible on mobile.

### 22. No keyboard navigation

The calendar views don't support keyboard navigation. Users cannot use arrow keys to navigate between days or Tab to
move between events. The recurrence picker and time select components are mouse-only beyond the basic input fields.

### 23. `useAllSharedCalendarEvents` creates parallel queries without deduplication

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/calendar/hooks/use-calendar.ts`, lines 154-173

```typescript
const results = useQueries({
    queries: visibleShared.map(sc => ({...})),
});
```

This creates one query per visible shared calendar. If a user has 10 shared calendars, this fires 10 parallel API
requests every time the date range changes. There's no batching or deduplication.

## Positive Patterns

- **Hooks in `packages/lib/`**: All data hooks are correctly placed in
  `packages/lib/src/core/calendar/hooks/use-calendar.ts`, not in the app
- **SSE handler coverage**: All 12 calendar SSE event types are handled with appropriate cache invalidation
- **Theme tokens**: Colors use `text-muted-foreground`, `bg-accent`, `bg-primary`, `text-primary-foreground` etc.
  consistently. No hardcoded gray/blue values found
- **Invite status UI**: Pending invitations shown with dashed borders, declined with opacity -- clear visual
  distinction
- **Calendar visibility toggle**: Clean UX with colored checkboxes that toggle calendar visibility without opening a
  dialog
- **Time select component**: Good UX with duration display, 15-minute intervals, scroll-to-current, and keyboard input
- **Recurrence picker**: Smart presets based on the selected date (e.g., "Monthly on the third Wednesday")
- **Shared calendar separation**: Sidebar correctly separates personal shared, team, and own calendars
- **Contact autosuggest for attendees and shares**: Reuses the shared `ContactAutosuggest` component

## Recommendations

### P0 (Critical)

1. **Add `ownerId` to all query keys** (issue #1): `calendarList`, `eventRange`, and `sharedCalendars` must include
   `ownerId` to prevent stale data when switching between personal and team contexts.

2. **Add error feedback to all mutations** (issue #3): Add `toast.error()` to catch blocks in config dialogs, add
   `onError` callbacks to `.mutate()` calls for sidebar toggles and RSVP.

3. **Add try/catch to `handleDelete`** (issue #12): Deletion failures currently close the dialog silently.

### P1 (Important)

4. **Remove `as any` from index route** (issue #2): Fix the redirect typing.

5. **Fix `useEffect` resetting form on calendar data refetch** (issue #14): Use an open-transition guard.

6. **Fix `RecurringActionDialog` default reset** (issue #20): Reset `selected` when dialog opens.

7. **Strip `RRULE:` prefix from recurrence picker values** (issue #8): Ensure consistency with backend format.

8. **Fix date/time boundary handling** (issues #5, #7): Use UTC-based range calculation or pad ranges.

### P2 (Nice to have)

9. **Extract duplicated helpers** (issue #15): Move `toLocalDateString`, `truncateRRule`, etc. to shared utilities.

10. **Replace `setTimeout` loading pattern** (issue #17): Use TanStack Query's `isPending` instead of manual state.

11. **Add mobile-responsive layout** (issue #21): Use `mobileColumn` prop for proper mobile experience.

12. **Add keyboard navigation** (issue #22): Arrow key navigation in calendar views.

13. **Remove redundant `Boolean()` coercions** (issue #19): Clean up type handling.

14. **Remove type assertions on Eden Treaty responses** (issue #4): Fix types at the route definition level.
