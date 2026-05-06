# Calendar TODO

Follow-ups for the calendar domain. See `docs/CALENDAR.md` for architecture.

Status: Calendar is now aligned with the project-wide Date end-to-end
convention. No outstanding wire-format work.

---

## Outstanding

- **Mixed test date-construction styles in `apps/api/src/test/calendar.test.ts`** —
  pre-existing tests use epoch-second literals like `new Date(1741773600 * 1000)`
  (e.g. lines 116-117, 129-130, 148-149), while newer tests use ISO literals like
  `new Date('2026-03-10T09:00:00Z')`. Harmonise on ISO literals (carries human
  meaning) in a separate cleanup commit.
- **Redundant `new Date(from * 1000)` constructions** in
  `apps/api/src/lib/calendar/calendar.ts` — `getRawEventsInRange` (~lines 486-488)
  and `getEventsInRange` (~lines 751-752) both materialise `fromDate`/`toDate`
  from path-param numbers, then pass the original numeric `from`/`to` into
  `expandRecurrence` (~lines 1484-1485) which materialises them again. Three
  constructions of the same dates. Cleanest fix: have `expandRecurrence` accept
  `Date` parameters and lift the conversion to the route handler.
- **`apps/api/src/lib/caldav/xml-parser.ts:54-55`** converts CalDAV time-range
  start/end from ISO → seconds, then `caldav/report.ts:50` passes those seconds
  into `getRawEventsInRange` which converts back to `Date`. Pre-existing; have
  the parser emit `Date` directly.

---

## Done

- **2026-05-06** — Calendar wire format migrated to `Date` end-to-end.
  Schema columns gained `mode: 'timestamp'` + `.notNull()` (storage unchanged,
  no DDL migration); shared types (`CalendarItem`, `CalendarEvent`,
  `FreeBusyBlock`, `CreateEventInput`, `UpdateEventInput`, `SharedCalendar`)
  flipped from `number` to `Date`; `expandRecurrence`,
  `computeOccurrenceTimes`, `utcToLocal` and the renamed `localToUtc`
  operate on `Date` end-to-end; CalDAV (`ical-parse.ts`,
  `ical-serialize.ts`), iMIP (`imip.ts`), routes (`t.Date()` on body),
  `formatEventWhen`, frontend dialogs/views, and ~80 test sites all flipped.
  Path-param time bounds (`/event-range/:from/:to`) remain `t.Numeric()` per
  Elysia constraint, with conversion at the WHERE-clause seam.
- **2026-05-04** — Drive editor (`editor.ts`, `inline-edit.ts`) aligned to the
  Date convention. Three `.toISOString()` calls dropped, body schema switched
  from `t.String()` to `t.Date()`, conflict comparison switched to
  `Date.getTime()`. Shared types (`EditorContent`, `EditorSaveResult`) and FE
  prop types flipped from `string` → `Date`. (Not a Calendar change, but it
  removed the second-largest deviation from the convention and motivates this
  TODO.)
