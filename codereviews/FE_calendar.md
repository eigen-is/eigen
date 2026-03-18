# Frontend Review: Calendar App

**Scope:** `apps/calendar/`, `packages/lib/src/core/calendar/`
**Reviewed:** 2026-03-18

Total files reviewed: 15 app source files (components, routes, main), 4 packages/lib files (hooks, SSE handlers,
index, types), 1 CSS file, 1 generated route tree.

## Critical Issues

**C1. `getEventsForDay` silently drops timed events that span midnight** *(new)*
For non-all-day events, the function only checks whether the event's *start* time falls on the given day. A timed event
from 11 PM to 2 AM the next day will only appear on the first day, not the second. Multi-day timed events (e.g., a
conference from 9 AM Monday to 5 PM Wednesday) will only appear on Monday. The all-day branch correctly does range
overlap, but the timed branch does not.

File: `apps/calendar/src/components/calendar-utils.ts:73-76`

Impact: Events silently invisible on days they span. Users may miss appointments.

Fix: Use the same range-overlap check for timed events:
```typescript
const startMs = e.startTime * 1000;
const endMs = e.endTime * 1000;
const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
const dayEnd = dayStart + 86400000;
return startMs < dayEnd && endMs > dayStart;
```

**C2. `RecurrencePicker` receives UTC-parsed date, producing wrong weekday presets in western timezones** *(new)*
Both `create-event-dialog.tsx:227` and `edit-event-dialog.tsx:309` pass `startDate={new Date(startDate)}` where
`startDate` is a `YYYY-MM-DD` string. Per the ECMAScript spec, `new Date("2024-03-15")` is parsed as UTC midnight.
In any timezone west of UTC (all Americas), `.getDay()` returns the *previous* day because UTC midnight is still the
prior evening locally. This means the RecurrencePicker shows the wrong weekday name in presets ("Weekly on Thursday"
when the user selected Friday) and generates an RRULE with the wrong `BYDAY` value.

Files: `apps/calendar/src/components/create-event-dialog.tsx:227`,
`apps/calendar/src/components/edit-event-dialog.tsx:309`

Impact: Recurring events created in western timezones will repeat on the wrong day of the week.

Fix: Append `T00:00:00` (local midnight) instead of bare date: `new Date(startDate + 'T00:00:00')`.

**C3. "This and following" delete is a no-op for recurrence exceptions** *(new)*
In `event-detail-dialog.tsx:170`, the expression `event.rrule || (isException && event.parentEventId ? null : null)`
always evaluates to `null` when `event.rrule` is `null`. Recurrence exceptions don't carry the parent's RRULE, so this
branch never truncates the parent series. The user chooses "This and following events", the dialog closes, and nothing
happens -- no events are deleted or truncated.

File: `apps/calendar/src/components/event-detail-dialog.tsx:167-174`

Impact: Silent data loss -- user believes future occurrences were deleted but they were not.

Fix: When the event is an exception (`event.parentEventId` is set), fetch the parent event's RRULE from the server or
pass it via props. Alternatively, call an API endpoint that handles the truncation server-side.

## Important Issues

**I1. `useEffect` in `create-event-dialog.tsx` resets form on `calendarOptions` change** *(previous -- confirmed)*
The reset effect at line 74 depends on `calendarOptions` (line 102). `calendarOptions` is recomputed via `useMemo` on
every calendars/sharedCalendars change, and because the memo produces a new array, the effect fires. Toggling any
calendar's visibility in the sidebar while the create dialog is open resets all form fields.

File: `apps/calendar/src/components/create-event-dialog.tsx:74-102`

Fix: Compute the default calendar ID in a separate `useMemo`, and only depend on `[open, defaultDate]` in the effect.

**I2. Same `useEffect` dependency issue in `edit-event-dialog.tsx`** *(previous -- confirmed)*
The effect at line 108 depends on `[event, open, calendarOptions, eventOwnerId]`. Any calendar list change while
editing will reset all fields to the event's original values, discarding user edits.

File: `apps/calendar/src/components/edit-event-dialog.tsx:108-136`

Fix: Same approach -- only depend on `[event?.id, open]` for the reset, lookup calendar key in a separate memo.

**I3. Edit dialog missing `minTime` on end-time picker** *(previous -- confirmed)*
The create dialog passes `minTime={getMinEndTime()}` to the end-time `TimeSelect` (line 203), but the edit dialog
does not (line 285). Users can set end time before start time and submit a negative-duration event.

File: `apps/calendar/src/components/edit-event-dialog.tsx:285`

Fix: Add `minTime={addMinutes(startTime, 15)}` to the end-time `TimeSelect`.

**I4. 11 `as any` casts in `use-calendar.ts` disable type safety for the entire API surface** *(previous -- confirmed)*
Every API call except `useCalendars`, `useSharedCalendars`, and the simple `calendarApi({ownerId}).shared` calls uses
`as any` casts. This covers calendar CRUD, event CRUD, RSVP, shared calendar events, and access checks -- effectively
the entire calendar API layer.

File: `packages/lib/src/core/calendar/hooks/use-calendar.ts` -- lines 56, 69, 83, 95, 108, 121, 134, 146, 161, 194,
227

Fix: Fix the Elysia route definitions or Eden Treaty typings for nested parameterized paths so the types flow correctly.

**I5. Duplicated `truncateRRule` function** *(previous -- confirmed)*
Identical implementation in `edit-event-dialog.tsx:56-65` and `event-detail-dialog.tsx:84-93`.

Fix: Move to `calendar-utils.ts`.

**I6. Duplicated `toLocalDateString` and `toTimeString` / `toLocalTimeString` functions** *(previous -- confirmed)*
`toLocalDateString` is defined in `create-event-dialog.tsx:31-36` and `edit-event-dialog.tsx:43-48`. Similarly,
`toTimeString` (create-event-dialog.tsx:38-40) and `toLocalTimeString` (edit-event-dialog.tsx:50-54) do the same thing
with different names. Meanwhile, `calendar-utils.ts` already has `toISODateString` which does the exact same thing.

Fix: Delete the duplicates and use `toISODateString` from `calendar-utils.ts`. Add a `toTimeString` export there.

**I7. `setTimeout(() => setIsLoading(false), 350)` pattern across all dialogs** *(previous -- confirmed)*
Present in: `create-event-dialog.tsx:160`, `edit-event-dialog.tsx:236`, `calendar-config-dialog.tsx:88`,
`shared-calendar-config-dialog.tsx:65`. The loading state persists 350ms after the mutation completes, creating a
window where the mutation is done but the UI is still "loading". The button is disabled during this time, but it also
means the dialog stays open with a stale "Saving..." label after success.

Fix: Use the mutation's `isPending` state directly instead of manual `isLoading` state.

**I8. `handleNonRecurringDelete` and `handleRecurringDeleteConfirm` have no error handling** *(new)*
In `event-detail-dialog.tsx:186-190`, `handleNonRecurringDelete` calls `deleteEvent.mutateAsync` without a try/catch.
If the delete fails, an unhandled rejection is thrown, the dialog closes via `setShowDeleteDialog(false)` (which runs
before the await), but `onOpenChange(false)` is never reached, leaving the detail dialog in an inconsistent state.
Similarly, `handleRecurringDeleteConfirm` at line 206-212 has no try/catch.

File: `apps/calendar/src/components/event-detail-dialog.tsx:186-190, 206-212`

Fix: Wrap in try/catch and show an error toast on failure.

**I9. No error feedback anywhere -- zero toast calls in the entire app** *(previous -- expanded)*
A `grep` for `toast` across `apps/calendar/src/` returns zero results. Every `catch` block only calls
`console.error`. The user receives no visible indication when any operation fails (create, update, delete, RSVP,
calendar config, shared calendar config).

Fix: Import `toast` from the shared Toaster and call `toast.error()` in every catch block.

## Minor Issues

**M1. `redirect` uses `as any` in `routes/index.tsx:11`** *(previous -- confirmed)*
```typescript
throw redirect({ to: '/view/$mode/$from/$to', params: {...} } as any);
```
This suppresses a type error in the redirect params. Likely the same Eden Treaty/TanStack Router inference issue.

File: `apps/calendar/src/routes/index.tsx:11`

**M2. `import` path uses `src/` prefix in `routes/index.tsx:2`** *(new)*
```typescript
import { getMonthRange } from 'src/components/calendar-utils';
```
This uses a non-standard `src/` import prefix instead of the relative `../components/calendar-utils` pattern used
everywhere else in the app. It works due to bundler configuration but is inconsistent with the rest of the codebase.

File: `apps/calendar/src/routes/index.tsx:2`

**M3. `interface` used instead of `type` in `__root.tsx:6`** *(new)*
The `MyRouterContext` is declared as `interface` rather than `type`, contrary to the project's "always `type` over
`interface`" rule in CONTRIBUTING.md. Same in `main.tsx:23` but that one is inside a `declare module` block, which
requires `interface`.

File: `apps/calendar/src/routes/__root.tsx:6`

**M4. No keyboard accessibility for day cells** *(previous -- confirmed)*
Day cells in both `month-view.tsx:80-86` and `week-view.tsx:76-79` are `<div>` elements with `onClick` but no
`tabIndex`, `role`, `onKeyDown`, or ARIA attributes. A `grep` for `aria-` and `role=` across the entire app source
returns zero results. Users cannot navigate or interact with the calendar using keyboard alone.

Files: `apps/calendar/src/components/month-view.tsx:80-86`,
`apps/calendar/src/components/week-view.tsx:76-79`

**M5. `CalendarCheckbox` has no ARIA attributes** *(previous -- confirmed)*
The custom checkbox button at `calendar-sidebar.tsx:27-42` has no `aria-label`, `aria-checked`, or `role="checkbox"`.
Screen readers will announce it as an unlabeled button.

File: `apps/calendar/src/components/calendar-sidebar.tsx:25-42`

Fix: Add `role="checkbox"`, `aria-checked={checked}`, and `aria-label` with the calendar name.

**M6. Event items in month/week views have no ARIA roles** *(new)*
Event `<div>` elements with `onClick` handlers (month-view.tsx:102-115, 117-134; week-view.tsx:86-99, 109-131) lack
`role="button"` and keyboard handlers. They are not reachable or activatable via keyboard.

**M7. `TimeSelect` uses `setTimeout(..., 100)` for scroll-into-view** *(previous -- confirmed)*
The scroll delay at `time-select.tsx:94-115` is fragile. If the popover renders slowly, the scroll will happen before
the content is laid out.

File: `apps/calendar/src/components/time-select.tsx:94`

Fix: Use `requestAnimationFrame` or a `MutationObserver` / `ResizeObserver` instead of a fixed timeout.

**M8. `TimeSelect` `useEffect` missing `filteredTimeSlots` dependency** *(previous -- confirmed)*
The scroll effect at `time-select.tsx:91-117` depends on `[open, value]` but reads `filteredTimeSlots`. If `minTime`
changes while the popover is open (e.g., the start time is adjusted), the scroll position won't update to match the
new filtered list.

File: `apps/calendar/src/components/time-select.tsx:91-117`

**M9. `TimeSelect` `commitInput` does not enforce `minTime`** *(new)*
The `commitInput` function at `time-select.tsx:119-129` validates the format with `isValidTime` but does not check
whether the entered time is >= `minTime`. A user can type "01:00" into the end-time field and bypass the `minTime`
constraint that the dropdown respects.

File: `apps/calendar/src/components/time-select.tsx:119-129`

Fix: After format validation, also check `timeToMinutes(formattedTime) >= minMinutes` when `minTime` is set.

**M10. No loading state for shared calendar events** *(previous -- confirmed)*
`useAllSharedCalendarEvents` returns `isLoading`, but the main view at `_auth.view.$mode.$from.$to.tsx:44` does not
use it. Only `isLoading` from own events gates the spinner. Shared events pop in after load, causing a visual flash.

File: `apps/calendar/src/routes/_auth.view.$mode.$from.$to.tsx:43-44`

Fix: Combine both loading states: `isLoading || sharedEventsLoading`.

**M11. `getEventsForDay` O(n) per day per render** *(previous -- confirmed)*
Called once per day cell inside the render loop in `month-view.tsx:70` (up to 42 cells) and `week-view.tsx:71` (7
cells). Each call iterates all events. With 42 cells and 200 events, that is 8,400 iterations per render.

File: `apps/calendar/src/components/calendar-utils.ts:66-78`

Fix: Pre-compute a `Map<dateKey, CalendarEventOccurrence[]>` in a `useMemo` at the view level and look up per day.

**M12. `RecurringActionDialog` initial `selected` state does not reset on reopen** *(new)*
The `useState<RecurringAction>(availableOptions[0])` at line 25 sets the initial value once. When the dialog is closed
and reopened, `selected` retains its previous value because React preserves state for mounted components. If the user
previously selected "This and following events" and reopens the dialog, that option will still be pre-selected instead
of resetting to "This event".

File: `apps/calendar/src/components/recurring-action-dialog.tsx:25`

Fix: Add a `useEffect` that resets `selected` to `availableOptions[0]` when `open` becomes true.

**M13. Timezone display silently falls back to local timezone** *(previous -- confirmed)*
In `edit-event-dialog.tsx:313`:
```typescript
(event.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone).split('/').pop()
```
When the event has no stored timezone (`null`), this displays the user's local timezone as if it were the event's
timezone, which could be misleading for events created by others in different timezones.

File: `apps/calendar/src/components/edit-event-dialog.tsx:313`

**M14. `moveEvent` deletes parent event unconditionally** *(new)*
In `edit-event-dialog.tsx:183`, when moving an event to a different calendar, the code deletes
`event.parentEventId || event.id`. If the event being edited is a recurrence exception (has `parentEventId`), this
deletes the *entire parent series* rather than just the exception.

File: `apps/calendar/src/components/edit-event-dialog.tsx:171-184`

Impact: Moving a single occurrence of a recurring event to another calendar deletes the entire series from the source
calendar.

Fix: Detect whether the event is part of a series and handle accordingly (cancel the single occurrence, create in new
calendar).

**M15. `doSave` uses `event.data` spread which can accumulate stale fields** *(new)*
In `edit-event-dialog.tsx:190`:
```typescript
const data = {...event.data, attendees: attendees.length > 0 ? attendees : undefined};
```
This spreads all of `event.data` (which may include `organizer`, `organizerEventId`, `url`, `notes`, `color`,
`reminders`) and only overrides `attendees`. Fields like `reminders` or `color` that the user may have changed via
other means will be sent back as-is, but there is no UI to edit them, so stale values persist silently.

File: `apps/calendar/src/components/edit-event-dialog.tsx:190`

## Observations

**Architecture compliance:**
- Hooks pattern: PASS -- all data fetching uses hooks from `packages/lib/src/core/calendar/hooks/use-calendar.ts`.
  No direct `useQuery`/`useMutation` in app components.
- Query keys: PASS -- `calendarKeys` follows the hierarchical pattern with exported invalidation functions.
- SSE handlers: PASS -- `sse-handlers.ts` handles all 12 calendar SSE event types correctly, routing each to the
  appropriate invalidation function.
- Layout: PASS -- `AppShell` with sidebar, `ColumnLayout` + `Column`, `Toolbar` pattern.
- Route guards: PASS -- `_auth.tsx` with `beforeLoad` redirect.

**UX strengths:**
- Clean month view with today highlighting and overflow ("N more") indicator.
- Invite status visualization is intuitive -- dashed border for pending, reduced opacity for declined.
- RSVP buttons with scope selection for recurring events ("this" or "all").
- Context-aware recurrence presets based on the selected date (correct weekday, ordinal, month name).
- Time picker shows duration relative to start time.
- Calendar sidebar separates "My Calendars", "Shared with me", and "Team Calendars" clearly.
- Color override for shared and team calendars.
- All-day event handling correctly uses UTC date portion throughout.

**UX gaps:**
- Week view is a flat vertical list, not a time-grid. Events are not positioned by their time on an hour axis. This
  removes the key advantage of a week view -- seeing temporal overlap and density at a glance.
- No drag-to-create or drag-to-resize events.
- "N more" in month view is not clickable/expandable.
- No custom RRULE builder beyond presets (no "every 2 weeks", "every N days", etc.).
- No reminder/notification UI despite the `Reminder` type being fully defined in
  `packages/lib/src/types/calendar.ts`.
- No unsaved-changes warning when closing event dialogs with modifications.
- No multi-day timed event spanning visualization (events only show on start day).
