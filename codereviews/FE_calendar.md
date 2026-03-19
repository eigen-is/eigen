# Frontend Review: Calendar App

**Scope:** `apps/calendar/`, `packages/lib/src/core/calendar/`
**Reviewed:** 2026-03-19

Total files reviewed: 15 app source files (components, routes, main), 4 packages/lib files (hooks, SSE handlers,
index, types), 1 CSS file, 1 generated route tree.

## Critical Issues

**C1. `RecurrencePicker` in edit dialog receives UTC-parsed date, producing wrong weekday presets in western timezones**
In `edit-event-dialog.tsx:310`, the RecurrencePicker receives `startDate={new Date(startDate)}` where `startDate` is a
`YYYY-MM-DD` string. Per ECMAScript spec, `new Date("2024-03-15")` is parsed as UTC midnight. In any timezone west of
UTC (all Americas), `.getDay()` returns the *previous* day because UTC midnight is still the prior evening locally. This
means the RecurrencePicker shows the wrong weekday in presets ("Weekly on Thursday" when the user selected Friday) and
generates an RRULE with the wrong `BYDAY` value.

The create dialog was fixed (line 228 uses `'T00:00:00'` suffix), but the edit dialog was missed.

File: `apps/calendar/src/components/edit-event-dialog.tsx:310`

Impact: Recurring events edited in western timezones will repeat on the wrong day of the week.

Fix: Change to `new Date(startDate + 'T00:00:00')` to force local-time parsing, matching the create dialog.

**C2. "This and following" delete is a no-op for recurrence exceptions**
In `event-detail-dialog.tsx:170`, the expression `event.rrule || (isException && event.parentEventId ? null : null)`
always evaluates to `null` when `event.rrule` is `null`. Recurrence exceptions don't carry the parent's RRULE, so the
`this-and-following` branch never truncates the parent series. The user chooses "This and following events", the dialog
closes, and nothing happens -- no events are deleted or truncated.

File: `apps/calendar/src/components/event-detail-dialog.tsx:167-174`

```typescript
} else if (action === 'this-and-following') {
    const parentId = event.parentEventId || event.id;
    const occDate = parseOccurrenceDate(event.occurrenceDate);
    const rrule = event.rrule || (isException && event.parentEventId ? null : null);
    if (rrule) {
        const truncated = truncateRRule(rrule, occDate);
        await updateEvent.mutateAsync({id: parentId, calendarId: event.calendarId, rrule: truncated});
    }
```

Impact: Silent failure -- user believes future occurrences were deleted but they persist.

Fix: When the event is an exception (`event.parentEventId` is set), the parent's RRULE must be retrieved. Either fetch
the parent event from the server, pass the parent RRULE via props, or call an API endpoint that handles the truncation
server-side.

**C3. Query keys for `useCalendars`, `useEvents`, and `useSharedCalendars` do not include `ownerId`**
Per CLAUDE.md's "Common Pitfalls": "Query keys must include `ownerId` for any owner-scoped data." Three hooks violate
this:

- `useCalendars(ownerId)` uses `calendarKeys.calendarList()` = `['calendar', 'calendars', 'list']`
- `useEvents(ownerId, from, to)` uses `calendarKeys.eventRange(from, to)` = `['calendar', 'events', {from, to}]`
- `useSharedCalendars(ownerId)` uses `calendarKeys.sharedCalendars()` = `['calendar', 'shared']`

None include `ownerId`. If the app ever needs to switch between personal and team calendar contexts, the cache will
serve stale data from the wrong owner.

File: `packages/lib/src/core/calendar/hooks/use-calendar.ts:14-22`

Impact: Currently mitigated because the calendar app only displays the current user's calendars, with shared/team events
fetched via `useAllSharedCalendarEvents` (which does scope by ownerId in `calendarEvents` keys). However, this pattern
will silently break if team calendar editing is added, or if the same user has multiple home contexts.

Fix: Add `ownerId` to `calendarList`, `eventRange`, and `sharedCalendars` key factories:

```typescript
calendarList: (ownerId: string) => [...calendarKeys.calendars(), ownerId, 'list'] as const,
eventRange: (ownerId: string, from: number, to: number) => [...calendarKeys.events(), ownerId, {from, to}] as const,
sharedCalendars: (ownerId: string) => [...calendarKeys.all, 'shared', ownerId] as const,
```

## Important Issues

**I1. `useEffect` in `create-event-dialog.tsx` resets form on `calendarOptions` change**
The reset effect at line 75 depends on `calendarOptions` (line 103). `calendarOptions` is recomputed via `useMemo` on
every calendars/sharedCalendars change, and because the memo produces a new array reference each time, the effect fires.
Toggling any calendar's visibility in the sidebar while the create dialog is open resets all form fields.

File: `apps/calendar/src/components/create-event-dialog.tsx:75-103`

Fix: Compute the default calendar ID in a separate `useMemo`, and only depend on `[open, defaultDate]` in the effect.
Use a `ref` to access the latest `calendarOptions` without adding it as a dependency.

**I2. Same `useEffect` dependency issue in `edit-event-dialog.tsx`**
The effect at line 109 depends on `[event, open, calendarOptions, eventOwnerId]`. Any calendar list change while
editing will reset all fields to the event's original values, discarding user edits in progress.

File: `apps/calendar/src/components/edit-event-dialog.tsx:109-137`

Fix: Only depend on `[event?.id, open]` for the reset. Look up the calendar key in a ref or separate memo.

**I3. Missing error feedback in `calendar-config-dialog.tsx` and `shared-calendar-config-dialog.tsx`**
Four `catch` blocks use `console.error` instead of `toast.error`:

- `calendar-config-dialog.tsx:86`: `console.error('Error saving calendar:', error)`
- `calendar-config-dialog.tsx:99`: `console.error('Error deleting calendar:', error)`
- `shared-calendar-config-dialog.tsx:63`: `console.error('Error updating shared calendar:', error)`
- `shared-calendar-config-dialog.tsx:75`: `console.error('Error removing shared calendar:', error)`

Per CLAUDE.md: "Every mutation needs error feedback -- wrap `mutateAsync` in try/catch with `toast.error()`, or use the
`onError` callback. Never swallow errors by catching and returning null."

Fix: Replace `console.error(...)` with `toast.error(...)` and import `toast` from sonner.

**I4. `handleNonRecurringDelete` and `handleRecurringDeleteConfirm` have no error handling**
In `event-detail-dialog.tsx:186-190`, `handleNonRecurringDelete` calls `deleteEvent.mutateAsync` without a try/catch.
If the delete fails, an unhandled rejection is thrown. Similarly, `handleRecurringDeleteConfirm` at line 206-212 has
no try/catch, and `handleDelete` at lines 124-183 only has a `finally` block with no `catch`.

File: `apps/calendar/src/components/event-detail-dialog.tsx:124-212`

Impact: Network errors during delete/RSVP operations will produce unhandled promise rejections with no user feedback.

Fix: Wrap in try/catch and show `toast.error()` on failure.

**I5. RSVP `.mutate()` calls (fire-and-forget) have no error handling**
Three RSVP calls use `.mutate()` without `onError`:

- `event-detail-dialog.tsx:220`: `rsvp.mutate({...})` (scoped RSVP for recurring)
- `event-detail-dialog.tsx:228`: `rsvp.mutate({...})` (scoped RSVP, "all" scope)
- `event-detail-dialog.tsx:299`: `rsvp.mutate({...})` (inline RSVP for non-recurring)

None provide an `onError` callback, so a failed RSVP silently disappears. The dialog closes immediately via
`onOpenChange(false)` before the mutation completes.

File: `apps/calendar/src/components/event-detail-dialog.tsx:220, 228, 299`

Fix: Either use `mutateAsync` with try/catch, or pass `{onError: () => toast.error('Failed to update RSVP')}`.

**I6. Duplicated `truncateRRule` function**
Identical implementation in `edit-event-dialog.tsx:57-66` and `event-detail-dialog.tsx:84-93`.

Fix: Move to `calendar-utils.ts` and import from there.

**I7. Duplicated `toLocalDateString` / `toTimeString` / `toLocalTimeString` functions**
`toLocalDateString` is defined in both `create-event-dialog.tsx:32-37` and `edit-event-dialog.tsx:44-49`. Similarly,
`toTimeString` (create) and `toLocalTimeString` (edit) do the same thing with different names. `calendar-utils.ts`
already exports `toISODateString` which does the exact same thing as all of them.

Fix: Delete the duplicates and import `toISODateString` from `calendar-utils.ts`. Add a `toTimeString` export there.

**I8. `setTimeout(() => setIsLoading(false), 350)` pattern across all dialogs**
Present in: `create-event-dialog.tsx:161`, `edit-event-dialog.tsx:237`, `calendar-config-dialog.tsx:88`,
`shared-calendar-config-dialog.tsx:65`. The manual loading state persists 350ms after the mutation completes, creating a
window where the mutation is done but the UI still shows "Saving..." and the button is disabled.

Fix: Use the mutation's `isPending` state directly instead of manual `isLoading` state. Remove the `setTimeout` calls.

**I9. `moveEvent` in edit dialog deletes parent series unconditionally**
In `edit-event-dialog.tsx:184`, when moving an event to a different calendar:

```typescript
await deleteEventOnSource.mutateAsync({id: event.parentEventId || event.id, calendarId: event.calendarId});
```

If the event is a recurrence exception (`parentEventId` is set), this deletes the *entire parent series* instead of
just the single occurrence.

File: `apps/calendar/src/components/edit-event-dialog.tsx:172-185`

Impact: Moving a single occurrence of a recurring event to another calendar silently deletes all other occurrences.

Fix: Check for `isRecurring || isException` and handle accordingly (cancel the single occurrence on the source, create
the new event on the target calendar).

**I10. Edit dialog `handleStartTimeChange` always overwrites end time**
In `edit-event-dialog.tsx:241-244`:

```typescript
const handleStartTimeChange = (newStart: string) => {
    setStartTime(newStart);
    setEndTime(addMinutes(newStart, 30));
};
```

Unlike the create dialog's smarter logic (which preserves end time when it remains valid), the edit dialog always
forces end = start + 30 minutes on any start time change. If the user has a 2-hour event and adjusts the start time by
15 minutes, the end time jumps to start + 30, losing the intended duration.

File: `apps/calendar/src/components/edit-event-dialog.tsx:241-244`

Fix: Use the same logic as the create dialog -- only update end time if it would become invalid (before start + 15).

## Minor Issues

**M1. `redirect` uses `as any` in `routes/index.tsx:11`**
```typescript
throw redirect({ to: '/view/$mode/$from/$to', params: {...} } as any);
```

This suppresses a type error in the redirect params, likely from TanStack Router type inference not resolving the
layout route params correctly.

File: `apps/calendar/src/routes/index.tsx:11`

**M2. `import` path uses `src/` prefix in `routes/index.tsx:2`**
```typescript
import { getMonthRange } from 'src/components/calendar-utils';
```
This uses a non-standard `src/` import prefix instead of the relative `../components/calendar-utils` pattern used
everywhere else in the app. It works due to bundler configuration but is inconsistent.

File: `apps/calendar/src/routes/index.tsx:2`

**M3. `interface` used instead of `type` in `__root.tsx:6`**
`MyRouterContext` is declared as `interface` rather than `type`, contrary to the project's "always `type` over
`interface`" rule in CONTRIBUTING.md.

File: `apps/calendar/src/routes/__root.tsx:6`

**M4. No keyboard accessibility for day cells**
Day cells in both `month-view.tsx:80-86` and `week-view.tsx:76-79` are `<div>` elements with `onClick` but no
`tabIndex`, `role`, `onKeyDown`, or ARIA attributes. Event items (`<div>` with `onClick`) likewise lack
`role="button"` and keyboard handlers.

Files: `apps/calendar/src/components/month-view.tsx:80-86`,
`apps/calendar/src/components/week-view.tsx:76-79`

**M5. `CalendarCheckbox` has no ARIA attributes**
The custom checkbox button at `calendar-sidebar.tsx:25-42` has no `aria-label`, `aria-checked`, or `role="checkbox"`.
Screen readers will announce it as an unlabeled button.

File: `apps/calendar/src/components/calendar-sidebar.tsx:25-42`

Fix: Add `role="checkbox"`, `aria-checked={checked}`, and `aria-label` with the calendar name.

**M6. `TimeSelect` uses `setTimeout(..., 100)` for scroll-into-view**
The scroll delay at `time-select.tsx:94-115` is fragile. If the popover renders slowly, the scroll happens before
content layout is complete.

File: `apps/calendar/src/components/time-select.tsx:94`

Fix: Use `requestAnimationFrame` or a `ResizeObserver` instead of a fixed timeout.

**M7. `TimeSelect` `useEffect` missing `filteredTimeSlots` dependency**
The scroll effect at `time-select.tsx:91-117` depends on `[open, value]` but reads `filteredTimeSlots`. If `minTime`
changes while the popover is open, the scroll position won't update to match the new filtered list.

File: `apps/calendar/src/components/time-select.tsx:91-117`

**M8. `TimeSelect` `commitInput` does not enforce `minTime`**
The `commitInput` function at `time-select.tsx:119-129` validates format with `isValidTime` but does not check whether
the entered time is >= `minTime`. A user can manually type a time that bypasses the dropdown's minimum constraint.

File: `apps/calendar/src/components/time-select.tsx:119-129`

Fix: After format validation, also check `timeToMinutes(formattedTime) >= minMinutes` when `minTime` is set.

**M9. No loading state for shared calendar events**
`useAllSharedCalendarEvents` returns `isLoading`, but the main view at `_auth.view.$mode.$from.$to.tsx:44` does not
use it. Only `isLoading` from own events gates the spinner. Shared events pop in after load, causing a visual flash.

File: `apps/calendar/src/routes/_auth.view.$mode.$from.$to.tsx:43-44`

Fix: Combine both loading states: `isLoading || sharedEventsLoading`.

**M10. `getEventsForDay` O(n) per day per render**
Called once per day cell inside the render loop in `month-view.tsx:70` (up to 42 cells) and `week-view.tsx:71` (7
cells). Each call iterates all events. With 42 cells and 200 events, that is 8,400 iterations per render.

File: `apps/calendar/src/components/calendar-utils.ts:66-77`

Fix: Pre-compute a `Map<dateKey, CalendarEventOccurrence[]>` in a `useMemo` at the view level and look up per day.

**M11. `RecurringActionDialog` initial `selected` state does not reset on reopen**
The `useState<RecurringAction>(availableOptions[0])` at line 25 sets the initial value once. When the dialog is closed
and reopened, `selected` retains its previous value because React preserves state for mounted components.

File: `apps/calendar/src/components/recurring-action-dialog.tsx:25`

Fix: Add a `useEffect` that resets `selected` to `availableOptions[0]` when `open` becomes true.

**M12. Timezone display silently falls back to local timezone**
In `edit-event-dialog.tsx:314`:
```typescript
(event.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone).split('/').pop()
```
When the event has no stored timezone (`null`), this displays the user's local timezone as if it were the event's
timezone, which could be misleading for events created by others in different timezones.

File: `apps/calendar/src/components/edit-event-dialog.tsx:314`

**M13. `doSave` in edit dialog spreads stale `event.data` fields**
In `edit-event-dialog.tsx:191`:
```typescript
const data = {...event.data, attendees: attendees.length > 0 ? attendees : undefined};
```

This spreads all of `event.data` (including `reminders`, `color`, `url`, `notes`) and only overrides `attendees`.
Fields that may have been changed externally will be sent back stale. There is no UI to edit `reminders`, `color`,
`url`, or `notes`, so they are silently persisted without the user being aware.

File: `apps/calendar/src/components/edit-event-dialog.tsx:191`

**M14. Sidebar toggle mutations use `.mutate()` without error handling**
In `calendar-sidebar.tsx`, visibility toggles use fire-and-forget `.mutate()`:

- Line 181: `updateCalendar.mutate({id: cal.id, visible: !cal.visible})`
- Line 223: `updateSharedCalendar.mutate({id: sc.id, visible: !sc.visible})`
- Line 255: `updateSharedCalendar.mutate({id: sc.id, visible: !sc.visible})`

None provide `onError` callbacks, so toggle failures are silent.

File: `apps/calendar/src/components/calendar-sidebar.tsx:181, 223, 255`

## Observations

**Previous issues resolved since last review:**

- C1 (previous) `getEventsForDay` now correctly uses range-overlap logic for timed events (lines 73-75).
- I3 (previous) Edit dialog end-time picker now passes `minTime={addMinutes(startTime, 15)}` (line 286).
- I4 (previous) All `as any` casts removed from `use-calendar.ts`. Type casts are now narrowly scoped `as Type`
  assertions on API responses, which is acceptable when Eden Treaty inference doesn't fully resolve.

**Architecture compliance:**
- Hooks pattern: PASS -- all data fetching uses hooks from `packages/lib/src/core/calendar/hooks/use-calendar.ts`.
  No direct `useQuery`/`useMutation` in app components.
- Query keys: PARTIAL PASS -- `calendarKeys` follows the hierarchical pattern with exported invalidation functions,
  but three key factories omit `ownerId` (see C3).
- SSE handlers: PASS -- `sse-handlers.ts` handles all 12 calendar SSE event types correctly, routing each to the
  appropriate invalidation function. Covers calendar CRUD, event CRUD, sharing, and invite lifecycle events.
- Layout: PASS -- `AppShell` with sidebar, `ColumnLayout` + `Column`, `Toolbar` pattern.
- Route guards: PASS -- `_auth.tsx` with `beforeLoad` redirect.
- No `as any` in hooks: PASS (was FAIL in previous review).
- Error feedback: PARTIAL FAIL -- `create-event-dialog.tsx` and `edit-event-dialog.tsx` use `toast.error()`, but
  `calendar-config-dialog.tsx`, `shared-calendar-config-dialog.tsx`, and `event-detail-dialog.tsx` do not.
- Theme tokens: PASS -- no hardcoded colors found; uses `text-muted-foreground`, `bg-accent`, `border`, etc.

**UX strengths:**
- Clean month view with today highlighting and overflow ("N more") indicator.
- Invite status visualization -- dashed border for pending, reduced opacity for declined.
- RSVP buttons with scope selection for recurring events ("this" or "all").
- Context-aware recurrence presets based on the selected date (correct weekday, ordinal, month name).
- Time picker shows duration relative to start time with next-day wrapping support.
- Calendar sidebar separates "My Calendars", "Shared with me", and "Team Calendars" clearly.
- Color override for shared and team calendars.
- All-day event handling correctly uses UTC date portion throughout.
- Writable shared calendars appear in the calendar picker for event creation/editing.
- Linked event guard hides attendee editor for invited events (only organizer can modify).

**UX gaps:**
- Week view is a flat vertical list, not a time-grid. Events are not positioned by their time on an hour axis. This
  removes the key advantage of a week view -- seeing temporal overlap and density at a glance.
- No day view.
- No drag-to-create or drag-to-resize events.
- "N more" in month view is not clickable/expandable.
- No custom RRULE builder beyond presets (no "every 2 weeks", "every N days", etc.).
- No reminder/notification UI despite the `Reminder` type being fully defined in
  `packages/lib/src/types/calendar.ts`.
- No unsaved-changes warning when closing event dialogs with modifications.
- No multi-day timed event spanning visualization in month view (events show on each day they span, but without a
  visual continuation bar connecting the days like Google Calendar does).

## File Index

| File                                                             | Purpose                                           |
|------------------------------------------------------------------|---------------------------------------------------|
| `apps/calendar/src/main.tsx`                                     | App entry point, router setup                     |
| `apps/calendar/src/routes/__root.tsx`                            | Root layout with AppShell + sidebar               |
| `apps/calendar/src/routes/_auth.tsx`                             | Auth guard with redirect                          |
| `apps/calendar/src/routes/index.tsx`                             | Index redirect to month view                      |
| `apps/calendar/src/routes/login.tsx`                             | Login page                                        |
| `apps/calendar/src/routes/_auth.view.$mode.$from.$to.tsx`        | Main calendar view (month/week)                   |
| `apps/calendar/src/components/calendar-sidebar.tsx`              | Sidebar with calendar list, visibility toggles    |
| `apps/calendar/src/components/calendar-toolbar.tsx`              | Navigation toolbar (today, prev, next, view mode) |
| `apps/calendar/src/components/calendar-utils.ts`                 | Date range helpers, event filtering, formatting   |
| `apps/calendar/src/components/month-view.tsx`                    | Month grid with event rendering                   |
| `apps/calendar/src/components/week-view.tsx`                     | Week list view with event rendering               |
| `apps/calendar/src/components/create-event-dialog.tsx`           | New event form                                    |
| `apps/calendar/src/components/edit-event-dialog.tsx`             | Edit event form with recurring support            |
| `apps/calendar/src/components/event-detail-dialog.tsx`           | Event detail view with RSVP, delete, edit actions |
| `apps/calendar/src/components/recurrence-picker.tsx`             | RRULE preset picker                               |
| `apps/calendar/src/components/recurring-action-dialog.tsx`       | "This / This and following / All" scope chooser   |
| `apps/calendar/src/components/time-select.tsx`                   | Time picker with duration display                 |
| `apps/calendar/src/components/attendee-editor.tsx`               | Invite attendees by email/contact search          |
| `apps/calendar/src/components/calendar-config-dialog.tsx`        | Calendar name/color/sharing editor                |
| `apps/calendar/src/components/shared-calendar-config-dialog.tsx` | Shared calendar color/access settings             |
| `apps/calendar/src/components/calendar-share-editor.tsx`         | Share permission editor (email + teams)           |
| `packages/lib/src/core/calendar/hooks/use-calendar.ts`           | All calendar TanStack Query hooks                 |
| `packages/lib/src/core/calendar/sse-handlers.ts`                 | SSE event handler with cache invalidation         |
| `packages/lib/src/types/calendar.ts`                             | Shared TypeScript types                           |
| `docs/CALENDAR.md`                                               | Calendar architecture documentation               |
