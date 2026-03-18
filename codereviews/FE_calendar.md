# Frontend Code Review: Calendar App

## Summary

The Calendar app is a feature-rich implementation with month and week views, recurring event support (RRULE presets),
calendar sharing, team calendars, event invitations with RSVP, and attendee management. The architecture closely
follows Eigen conventions. The main concerns are: duplicated helper functions across files, the `useEffect` dependency
on `calendarOptions` causing excessive resets, missing end-time validation in the edit dialog, the `as any` casts on
Eden Treaty calls, and some accessibility gaps in the custom time picker.

Total files reviewed: 22 app source files, 4 packages/lib hook/handler files, 2 type files.

## Architecture Compliance

### Hooks usage -- PASS
All data fetching and mutations use hooks from `packages/lib/src/core/calendar/hooks/use-calendar.ts`. No direct
`useQuery` / `useMutation` calls exist in any `apps/calendar/` component.

### Query keys -- PASS
`calendarKeys` follows the hierarchical pattern. Invalidation functions are exported and reused in SSE handlers and
mutation callbacks.

### SSE handlers -- PASS
`sse-handlers.ts` handles all 12 calendar-related SSE event types (calendar CRUD, event CRUD, sharing,
invite lifecycle).

### Layout -- PASS
Uses `AppShell` with sidebar, `ColumnLayout` + `Column` for the main view. Toolbar follows the `<Toolbar>` pattern.

### Route guards -- PASS
`_auth.tsx` redirects unauthenticated users. The index route redirects to the month view with the current date range.

### Type safety -- PARTIAL
The hooks file (`use-calendar.ts`) has extensive `as any` casts on the Eden Treaty API calls (lines 56, 57, 69, 83,
95, 108, 121, 134, 146, 161, 228). This effectively disables type safety for the entire calendar API surface.

## Issues Found

### Critical

None.

### Important

**I1. `useEffect` in `create-event-dialog.tsx` resets form on every `calendarOptions` change (line 102)**
The `useEffect` on line 74 has `calendarOptions` in its dependency array. `calendarOptions` is a new array reference
on every render (created via `useMemo` depending on `calendars`, `sharedCalendars`, and `ownerId`). Any change to
calendars or shared calendars (e.g., toggling visibility in the sidebar) while the create dialog is open will reset all
form fields to their defaults, silently discarding user input.

File: `apps/calendar/src/components/create-event-dialog.tsx`, lines 74-102.

Fix: Move the default-calendar lookup out of the effect, or memoize the default calendar ID separately and only depend
on `open` and `defaultDate`.

**I2. Same `useEffect` dependency issue in `edit-event-dialog.tsx` (line 136)**
The effect on line 108 depends on `calendarOptions` and `eventOwnerId`, which are both derived values that change
reference on every render. This causes the edit form to reset whenever the calendar list changes.

File: `apps/calendar/src/components/edit-event-dialog.tsx`, lines 108-136.

**I3. Edit dialog does not enforce `endTime > startTime` for timed events**
The `handleStartTimeChange` in `edit-event-dialog.tsx` (line 240) blindly sets `endTime = addMinutes(newStart, 30)`.
But when the user manually changes `endTime` directly, there is no `minTime` prop on the end-time `TimeSelect`
(line 285, contrast with create-event-dialog line 203 which passes `minTime={getMinEndTime()}`). The user can set
`endTime` before `startTime`, which would submit a negative-duration event.

File: `apps/calendar/src/components/edit-event-dialog.tsx`, line 285.

Fix: Pass `minTime` to the end-time `TimeSelect` in the edit dialog, matching the create dialog.

**I4. Duplicated `truncateRRule` function**
`truncateRRule` is defined identically in both `edit-event-dialog.tsx` (lines 56-65) and `event-detail-dialog.tsx`
(lines 84-93). This duplicated logic should live in `calendar-utils.ts`.

File: `apps/calendar/src/components/edit-event-dialog.tsx`, lines 56-65;
`apps/calendar/src/components/event-detail-dialog.tsx`, lines 84-93.

**I5. Duplicated `toLocalDateString` and time-formatting functions**
`toLocalDateString` is defined in both `create-event-dialog.tsx` (lines 31-36) and `edit-event-dialog.tsx`
(lines 43-48). `toTimeString` / `toLocalTimeString` are similarly duplicated. These belong in `calendar-utils.ts`.

**I6. `as any` casts throughout `use-calendar.ts` disable type safety**
Almost every API call in the hooks file uses `as any` casts. For example:
```typescript
const response = await (calendarApi({ownerId}).calendars as any)({id}).put(data as any);
```
This removes all compile-time checks for request/response shapes.

File: `packages/lib/src/core/calendar/hooks/use-calendar.ts`, lines 56, 69, 83, 95, 108, 121, 134, 146, 161, 228.

Fix: This likely indicates the Eden Treaty types for the calendar routes are not properly inferred. Investigate the
Elysia route definitions and fix the type chain so the casts can be removed.

**I7. `setTimeout` delay for `isLoading` reset**
Multiple dialogs use `setTimeout(() => setIsLoading(false), 350)` (e.g., `calendar-config-dialog.tsx` line 88,
`shared-calendar-config-dialog.tsx` line 65, `create-event-dialog.tsx` line 160, `edit-event-dialog.tsx` line 236).
This artificial delay means the loading state lingers 350ms after the operation completes. If the user clicks quickly,
they could trigger a second submission during this window because the form is not truly disabled -- the mutation has
already finished.

Fix: Use the mutation's own `isPending` state instead of manual `isLoading` state.

### Minor

**M1. `redirect` uses `as any` type assertion in `routes/index.tsx` (line 12)**
```typescript
throw redirect({ to: '/view/$mode/$from/$to', params: {mode: 'month', from: String(from), to: String(to)} } as any);
```
This suppresses a type error in the redirect params.

File: `apps/calendar/src/routes/index.tsx`, line 12.

**M2. No keyboard accessibility for day cells in month/week views**
Day cells are `<div>` elements with `onClick` but no keyboard handlers, `tabIndex`, or ARIA roles. Users cannot
navigate or select days with the keyboard.

File: `apps/calendar/src/components/month-view.tsx`, lines 80-86;
`apps/calendar/src/components/week-view.tsx`, lines 76-79.

**M3. `TimeSelect` uses magic scroll delay of 100ms**
Line 94 of `time-select.tsx` uses `setTimeout(..., 100)` to scroll the active time slot into view after the popover
opens. This is fragile; a slow render could leave the scroll position wrong.

File: `apps/calendar/src/components/time-select.tsx`, line 94.

**M4. Missing `useEffect` dependency warnings**
`time-select.tsx` line 117: the `useEffect` depends on `[open, value]` but references `filteredTimeSlots` (which
changes when `minTime` changes). If `minTime` changes while the popover is open, the scroll position will not update.

File: `apps/calendar/src/components/time-select.tsx`, lines 91-117.

**M5. `event.timezone` property accessed but not in CalendarEvent type**
`edit-event-dialog.tsx` line 191 references `event.timezone`, which exists on the `CalendarEvent` type but line 313
uses it for display. This works, but the expression
`event.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone` silently falls back to local timezone when the
event has no stored timezone, which could show misleading timezone info for imported events.

**M6. Recurring event edit: "this-and-following" creates new event without attendees context**
In `edit-event-dialog.tsx` lines 218-229, the `this-and-following` action truncates the parent RRULE and creates a new
standalone event. The new event carries the current `attendees` and `data`, but since it's a brand-new event (not a
linked copy), the invitation propagation may not trigger correctly for attendees who already have linked copies.

File: `apps/calendar/src/components/edit-event-dialog.tsx`, lines 218-229.

**M7. `CalendarCheckbox` in sidebar uses raw `<button>` without ARIA label**
The checkbox button in `calendar-sidebar.tsx` lines 26-42 has no `aria-label` or `aria-checked` attribute.

File: `apps/calendar/src/components/calendar-sidebar.tsx`, lines 26-42.

**M8. No loading state for shared calendar events**
`useAllSharedCalendarEvents` returns an `isLoading` flag, but the main view (`_auth.view.$mode.$from.$to.tsx` line 44)
does not use it. Only `isLoading` from own events controls the spinner. If shared events are still loading, the view
renders without them, then pops them in when they arrive, causing a visual flash.

File: `apps/calendar/src/routes/_auth.view.$mode.$from.$to.tsx`, lines 43-44.

**M9. `getEventsForDay` performance: O(n) per day per render**
For each day cell in the month or week view, `getEventsForDay` iterates over *all* events in the range. With 42 day
cells (month view) and many events, this is O(42 * n). A single pre-computed Map<dateKey, events[]> would be O(n).

File: `apps/calendar/src/components/calendar-utils.ts`, lines 66-78.

**M10. No error toast or user feedback on failed event save/delete**
All catch blocks only `console.error` the error. The user sees no indication that a save or delete failed.

Files: `create-event-dialog.tsx` line 158, `edit-event-dialog.tsx` line 234, `event-detail-dialog.tsx` (errors
silently swallowed in handleDelete), `calendar-config-dialog.tsx` lines 85, 99.

## UX/UI Quality

**Good:**
- Clean month and week views with today highlighting.
- Invite status visualization (dashed border for pending, opacity for declined) is intuitive.
- RSVP buttons with scope selection for recurring events.
- Recurrence picker with context-aware presets (weekday name, ordinal, month).
- Time picker with duration display relative to start time.
- Calendar sidebar with color checkboxes and hover-reveal edit buttons.
- Shared and team calendars properly separated in sidebar sections.
- Color picker for own and shared calendars.
- All-day event handling correctly uses UTC date portion.

**Needs attention:**
- No drag-to-create or drag-to-resize events in the week view (common calendar UX expectation).
- No "more events" popover in month view -- clicking "N more" has no special action.
- Week view has no hour grid or time-positioned event blocks; events are simply listed vertically, which removes
  temporal context. This is more of a "day list" than a true week view.
- No way to create a custom RRULE beyond the presets (e.g., "every 2 weeks", "every 3rd Monday").
- No reminder/notification UI despite `Reminder` type being defined.
- No unsaved-changes warning in event dialogs.

## Recommendations

1. **Extract shared utilities**: Move `truncateRRule`, `toLocalDateString`, `toLocalTimeString` into
   `calendar-utils.ts` and import from there.
2. **Fix the `useEffect` dependencies** in create and edit dialogs to prevent form resets. Extract the default calendar
   lookup into a separate `useMemo` and only depend on `open` in the reset effect.
3. **Add `minTime` to the edit dialog's end-time picker** to prevent negative-duration events.
4. **Replace manual `isLoading` state with mutation `isPending`** across all dialogs. Remove the `setTimeout` pattern.
5. **Fix the Eden Treaty type chain** for calendar routes so the `as any` casts can be removed.
6. **Add error toasts** using the shared Toaster for failed saves, deletes, and RSVP actions.
7. **Add ARIA attributes** to custom interactive elements (day cells, calendar checkboxes).
8. **Pre-compute events-per-day** in a `useMemo` Map to improve rendering performance for large event sets.
9. **Consider a proper hour-grid week view** with time-positioned event blocks for better temporal context.
10. **Add custom RRULE builder** for recurrence intervals beyond the preset list.
