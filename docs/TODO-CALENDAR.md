# Calendar TODO

Follow-ups for the calendar domain. See `docs/CALENDAR.md` for architecture.

Status: Calendar is now aligned with the project-wide Date end-to-end
convention. No outstanding wire-format work.

---

## Outstanding

(none)

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
  Elysia constraint, with conversion at the WHERE-clause seam. Net diff is
  negative (-27 lines).
- **2026-05-04** — Drive editor (`editor.ts`, `inline-edit.ts`) aligned to the
  Date convention. Three `.toISOString()` calls dropped, body schema switched
  from `t.String()` to `t.Date()`, conflict comparison switched to
  `Date.getTime()`. Shared types (`EditorContent`, `EditorSaveResult`) and FE
  prop types flipped from `string` → `Date`. (Not a Calendar change, but it
  removed the second-largest deviation from the convention and motivates this
  TODO.)
