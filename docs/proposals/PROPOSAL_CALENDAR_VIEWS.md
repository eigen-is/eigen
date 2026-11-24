# Calendar views: a time grid, month bars, a schedule list and drag

Status: approved by the owner, 24 November 2026: views, navigation and the sidebar's mini month first; the event card and quick create last, in the same program, once the owner has seen previews (see Rulings). The research screenshots live outside the repo, in the gitignored `.superpowers/ui-reference/calendar/` (`eigen/`, `google/`, `apple/`, `inspo/` with `FINDINGS.md`).

## Why

Calendar works, but its views are the weakest part of it. Week view is seven lists, not a time grid: you can't see how long a meeting is, that three overlap at 14:00, or where the gaps are. Month view is close to Google's but hides events and draws a three-day trip as three separate pills. On a phone, month shows times without titles and week cuts titles to one or two letters. People who leave Google Calendar expect the grid, drag, and a card next to the event. The research says the same thing from the other side: the top complaints about calendars are a month view that hides events behind "+N more", overlaps you can't read, and rigid navigation.

## What we saw

- Eigen today: month grid with up to four events per day and "N more"; a list-per-day week; centered modals for event details and for New event; no day view, no mini month, no now line, no drag, no shortcuts.
- Bugs: "N more" opens New event, because the click bubbles to the day cell. Switching Month to Week from November lands on 26 Oct, because the month's focus is the 1st and the 1st is a Sunday. The URL holds unix timestamps (`/view/$mode/$from/$to`), so no view knows which day the user was looking at.
- Google: day, 4 days, week, month, schedule and year. Mini month, now line with a dot, past events dimmed, multi-day bars spanning days, unanswered invites as outlines, a peek card beside the event, quick create beside the slot, "N more" as a day list.
- Apple: calmer events (a tint, a left bar, colored text), the current time as a red label in the hour gutter, weekends a shade dimmer, an inspector panel instead of a modal.
- Loved elsewhere (Notion Calendar, Fastmail, Fantastical, Amie, Proton): mini month beside the grid, keyboard shortcuts, drag to create with a 15-minute snap, month cells with real titles, a pale fill with a strong left bar, declined struck through and unanswered dashed.

## Rulings (owner, 24 November 2026)

- Only navigation and views change. What opens when you click an event (today's detail dialog) and the Edit event and New event dialogs look as they do now. Clicking an empty slot or day, or dragging a range, opens today's New event dialog with the times filled in.
- The event card and quick create next to the event come after the views, in the same program: the owner first sees the context and previews of how they could work, then rules. They are what Google, Apple, Outlook and Notion Calendar do, but no other Eigen app opens an item that way, so it is an Eigen-wide choice.
- The sidebar lists the views as `SidebarItem`s with `to`, as Contacts, Mail and the other apps do, so on a phone the back-to-sidebar flow works the same everywhere. The mini month goes in the sidebar too.

## Goals

- A real time grid for day, 3 days and week: duration, overlap and gaps visible at a glance.
- A month view that shows titles, draws multi-day events as one bar per week row, and lists the rest of a day on "N more".
- Drag to create, move and resize, through the same save path and etag rules as Edit event.
- A schedule list, and every view in the sidebar.
- Keyboard shortcuts.
- Event colors in the one color treatment stickies and comments already use.

## Non-goals

Time-zone rails, natural-language entry, tasks on the calendar, availability sharing, a year view, weather, continuous scrolling, drag on touch. Good ideas, each its own row later.

## Anti-goals

- A second copy of anything that exists: color treatment, drag lifecycle, recurrence scopes, save logic.
- Cache surgery for optimistic display; the list stays the one source of truth.
- A redesign that hurts reading for the sake of novelty (HEY's vertical text, iOS 18's "riot of shapes").

## Constraints

- No new API route, migration or npm package. None is needed: keyboard shortcuts use `@tanstack/react-hotkeys` through a hook in lib, which already depends on it, so calendar's `package.json` gains nothing; drag uses our own pointer code.
- Every write carries the etag and goes through the recurring this / following / all choice ([CALENDAR.md](../CALENDAR.md)).
- Times stay 24-hour (owner's ruling). Weeks start on Monday until the week-start setting lands.
- Pages are `ColumnLayout` + `Column` with the `toolbar` prop. App components hold no queries, mutations or toasts.

## Approaches

1. **Rewrite the views in place, one shared time grid, pure layout in lib (chosen).** One `TimeGrid` component serves day, 3 days and week; month keeps its own component. Overlap packing, lane allocation, time-to-pixel and drag math are pure functions in `packages/lib/src/core/calendar/`, unit-tested, because happy-dom has no layout. Fits the house rules and keeps every fact in one module.
2. **A calendar library (FullCalendar, react-big-calendar).** Fast to a first grid, but a large package, its own look and its own drag, and our color, popover and save rules would have to be bent around it. Needs the owner's yes and works against consistency.
3. **Patch the list week view (taller items, a duration bar).** Small, but it never shows overlap or gaps, and drag can't land on a list. Doesn't meet the goal.

## Design

### Shared pieces

- **Color surface.** `colorSurface(color)` in `packages/ui/src/lib/color-surface.ts`, beside `cn`, returns `{ className, style }`: a lightened fill with readable text in light mode, a 14% wash with a 2px inset stripe in the indicator color in dark mode. One tint for every surface: it replaces the two written-out copies in `notes/note-card.tsx` (0.25) and `note-card-content.tsx` (0.5), so a sticky looks the same on the board and open. Calendar events use it too. The color math stays in `lib/constants/colors.ts`, which gains `indicatorColor(color)`; `commentIndicatorColor` calls it. A user's arbitrary hex is its own indicator. A function, not a CSS class, because a base-layer `box-shadow` would lose to NoteCard's `shadow-md`, and utility classes let state classes replace a fill through `cn`.
- **Event states** layer after the surface, in `eventSurfaceClasses` (today's `eventPillStateClasses`): pending = dashed outline in the event's color on the background; declined = faded and struck through; free/busy = faded and not clickable; past = dimmed, listed first so the others win.
- **Pointer drag.** `useHandleDrag` moves from `components/vector/tools/` to `packages/ui/src/hooks/use-pointer-drag.ts` (one gesture at a time, pointer capture, travel threshold, Escape cancels). Vector's three callers adopt it; calendar is its fourth user instead of a fourth hand-written drag lifecycle.
- **Recurrence scopes.** `RECURRENCE_SCOPES` / `RecurrenceScope` in `lib/types/calendar.ts`, replacing `RECURRING_ACTIONS` in `recurring-action-dialog.tsx` and the inline union in `useRsvp`.
- **One save path.** `useSaveOccurrence` (new, lib) saves an occurrence at a scope with its etag. Edit event and a drop both save through it. `invalidateEventList` returns its refetch promise, so a write settles once the list shows it.

### Pure modules in lib

- `calendar-view.ts`: view modes, `WEEK_STARTS_ON`, `viewDays`, `viewRange`, `stepFocus` (31 Jan steps to 28 Feb), `viewTitle`, `parseDayKey`, `calendarEventLink`. Replaces `getMonthRange`, `getWeekRange`, `getDaysInRange` and the toolbar's private Monday math.
- `calendar-layout.ts`: `eventDaySpan`, `inAllDayLane` (all-day, or timed for 24 hours or more), `allocateLanes` (one function for month rows and the all-day lane), `layoutTimedEvents` (split per day, cluster, first free column, widen right while free), `monthWeekLayout`, `SNAP_MINUTES = 15`, `slotAt`, and the drag math: `movedTimes`, `resizedTimes` (at least 15 minutes), `rescheduleScopes`. A move steps UTC days for an all-day event and local days for a timed one; whether a series occurrence changed day is judged in the series' own zone. Positions are wall-clock minutes, so a DST day keeps 09:00 at 09:00. All-day events place by UTC date, timed by local day.

### URL

`/view/$mode/$date`, with `$date` the focused local day (`YYYY-MM-DD`) and `mode` one of `day | 3day | week | month | schedule`. Switching mode keeps the day, which fixes the month-to-week jump at its cause. `/` takes `?date&eventId` and redirects to the default view. The two inbound links, Mail's "View in Calendar" and the notification resolver, build `/calendar/?date=…&eventId=…` through `calendarEventLink`. Old `/view/month/<from>/<to>` bookmarks hit the not-found page; no compatibility route.

### Views

- **Time grid** (`time-grid.tsx`, replaces `week-view.tsx`): hour gutter, an all-day lane with spanning bars, blocks placed from `layoutTimedEvents` (title, time and place lines by height, a resize strip at the bottom on a fine pointer), a now line across today with the time in the gutter, scrolled to an hour before now when today is visible and to 07:00 otherwise, weekend columns dimmed, past events dimmed.
- **Month**: week rows as CSS grids, multi-day bars from `monthWeekLayout`, as many lanes as the row's measured height fits, "N more" as a real popover trigger listing the day, the date number links to day view, an empty cell opens today's New event dialog on that day.
- **Schedule**: days with events as dot, time, title and place rows; an empty state when there are none.
- **Sidebar**: one `SidebarItem` per view (Day, 3 days, Week, Month, Schedule) with `to` and params, active on its route, replacing today's "View month" and "View week" `onClick` items. Each keeps the focused day. Below them a mini month: the focused month with today and the focused range marked, its own month steps, a click on a day opens it in the current view.
- **Week start** slots in later by swapping the `WEEK_STARTS_ON` constant for a reader of a `calendar.weekStart` field in the existing settings JSON.

### Cards and dialogs

Last in the program (see Rulings). While the views are built, a click on an event opens today's `EventDetailDialog`, and a click on an empty slot or day, or a drag over a range, opens today's `CreateEventDialog` with the times filled in (an `initial` prop beside `defaultDate`). What follows is the draft the previews start from.


- **Peek card** (`event-detail.tsx`, renamed from `event-detail-dialog.tsx`, one instance at the route): today's body in a `Popover` anchored to the clicked element through `PopoverAnchor virtualRef`, the pattern `comment-hover-card.tsx` uses. A deep link and a phone keep today's `Dialog`. The sub-dialogs (confirm, recurring choice, Edit event) stay as they are.
- **Quick create**: a "(No title)" draft in the default calendar's color is the anchor; title input (Enter saves), the when line, a calendar select when there is more than one, and More options into `CreateEventDialog` with what was typed. A phone opens `CreateEventDialog` directly.
- **No hover preview.** Click already opens the peek beside the event, chips keep their native `title` tooltip for truncated text, and a second floating card on a surface that also takes clicks and drags would need rules against the drag, the peek, quick create and the day list.

### Drag

Why not dnd-kit, as slides and stickies use: [LAYOUT.md](../LAYOUT.md#reordering-uses-dnd-kit-moving-between-lists-uses-native-drag-placing-uses-a-pointer-drag) gives dnd-kit to reordering in place (the slides rail, a stickies column) and native drag to moving between lists. A calendar drag is neither: it places a block on a continuous time axis and resizes it, which is what vector's handles do. dnd-kit has no resize, so calendar would need its own pointer code beside it anyway, and adding it to calendar's `package.json` needs the owner's yes. So the rule gains a third line, placing and resizing on a surface uses `usePointerDrag`, and LAYOUT.md says so. What the three share is one fact: the travel before a press becomes a drag, today 5px in slides and stickies (`activationConstraint`) and in `use-drag-scroll.ts`. It becomes one `DRAG_THRESHOLD_PX = 5` in lib that they and `usePointerDrag`'s default read. Vector's handles keep their own smaller thresholds on purpose, as they go live from the first move.


- Mouse and pen only, from `DRAG_THRESHOLD_PX`; below it a press is a click. A block's body moves, its bottom strip resizes, an empty column creates a range, a month chip moves by days. The scroller nudges near its edge. Escape cancels. A click after a real drag is swallowed.
- Only where `useCanReschedule` (new, lib) allows: not free/busy, not someone else's invitation, not a read-only calendar.
- A drop mounts a small host bound to the event's owner, as `EditEventDialog` is (owner's choice): it loads the series master when the choice needs it, asks this / following / all, and asks "Send update emails to guests?" when the event has guests (owner: as Google; Cancel snaps back). A landing draws the block at its new place until the write settles. A single event saves at once. A series occurrence asks this / following / all first, through `RecurringActionDialog`. The etag is the current list copy's at submit time; a this-and-following split holds the etag its first write answered, as Edit event does, since the occurrence leaves the list.
- A 412 reloads and toasts through the hook's existing error path; a direct drop snaps back to the reloaded event, and the recurring choice stays open so the next OK sends the reloaded etag.
- Not in this round: drag between all-day and timed, drag on touch, drag to create in month view.

### Keyboard

`t` today, `j` / `k` and Left / Right to step, `d` day, `x` 3 days, `w` week, `m` month, `a` schedule, `c` create. Off while a dialog or the peek is open (`useDialogOpen`).

## Units

Each unit lands with its tests, CALENDAR.md lines, help article and CHANGELOG lines. U2, U4, U12 and U13 touch different files and run in parallel; U3 waits for U2, which edits the same views.

| Unit | What | Wave |
|---|---|---|
| U1 | "N more" lists the day (extract `event-chip.tsx`, add `month-day-popover.tsx`) | A |
| U2 | URL model `/view/$mode/$date`, `calendar-view.ts`, inbound links, and the sidebar's view items (was U9); fixes the month-to-week jump | A |
| U3 | `colorSurface` and `indicatorColor`; stickies, card and calendar adopt one tint; screenshots of stickies and calendar at 0.25, 0.35 and 0.5, light and dark, for the owner to pick | A, after U1 |
| U4 | `calendar-layout.ts` with its tests | A |
| U12 | `useSaveOccurrence`, `RecurrenceScope` (also the API's copies); Edit event adopts; the stale-write suite must pass unchanged | A |
| U13 | `usePointerDrag` promoted; vector adopts; one `DRAG_THRESHOLD_PX` that slides and stickies read too; LAYOUT.md's drag rule gains the surface line | A |
| U6 | Time grid for day, 3 days and week; deletes `week-view.tsx` | B |
| U7 | Month rewrite: spanning bars, measured lanes, date link | B, after U6 |
| U8 | Schedule view | B |
| U14 | Drag or click to create: opens today's New event dialog with the range | after U13, U6 |
| U15 | Drag to move and resize | after U12, U13, U6, U7 |
| U16 | Keyboard shortcuts | after U6, U8 |
| U10 | Mini month in the sidebar | after U2 |
| U11 | Event card and quick create: context and previews to the owner, then the build the owner rules | last |

Highest risk: U12 (it changes Edit event's save path) and U15. U6 is the largest; its all-day lane can split off.

## Owner's answers (24 November 2026)

1. Default view: week on a desktop, 3 days on a phone.
2. Dragging one occurrence of a series to another day offers only "This event", because moving the series start leaves `BYDAY` on the old weekday. Another time on the same day keeps this / following / all.
3. Keyboard shortcuts are on by default, as in Google, and off while a dialog is open.
4. A pending invitation is a dashed outline in the event's color; a declined one is faded and struck through.
5. One tint for every color surface: a sticky on the board, an open sticky and a calendar event look the same. Its strength, between 0.25 and 0.5, is picked from U3's screenshots.
6. The mini month goes in the sidebar (U10). If it is built on shadcn's `Calendar`, that adds `react-day-picker` with `date-fns`, a new package, asked right before U10.

Taken unless the owner says otherwise: 3 days is fixed (not 2 to 7), the schedule shows 28 days a step, drag on touch is a ROADMAP row.

## Found on the way

- The Monday rule lives in lib's range functions, `WEEKDAY_HEADERS` and the toolbar's title; U2 makes it one constant.
- A notification for an all-day invitation carries only its start time, so west of UTC its link lands on the day before. Accepted as rare: fixing it changes the stored tag.
