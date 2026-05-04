# Calendar TODO

Follow-ups for the calendar domain. See `docs/CALENDAR.md` for architecture.

Status: Calendar is the last domain still on the numeric Unix-second wire
format. Every other domain emits `Date` end-to-end via Eden's reviver.

---

## Outstanding

### 1. Align wire format with the rest of the codebase (`Date`, not `number`)

**Symptom:** Calendar is the only domain that emits raw Unix-second `number` on
the wire and types its shared TS surface as `number`. Every other domain
(chat, mail, drive, drive editor, notifications, contacts, collab, waitlist)
emits `Date` end-to-end. The mismatch causes a real seconds-vs-milliseconds
ambiguity bug at the API boundary and forces every Calendar consumer to
remember "this domain is in seconds, multiply by 1000."

**Why it matters:** It's a footgun, not a fire — but it's the largest single
deviation from the project-wide convention. New contributors hit it; existing
code is full of `* 1000` / `/ 1000` defensive math.

**Why a previous plan was rejected (2026-05-03):** The first attempt
(`docs/superpowers/plans/2026-05-03-date-time-wire-format.md`, deleted) tried
to fix this by emitting ISO 8601 strings typed as `string` *across all
domains*. That plan was wrong: Eden Treaty's response reviver auto-parses ISO
strings back into `Date` at runtime, so typing as `string` would create a
fresh type/runtime mismatch in the seven sweep domains (which were already
correct end-to-end via Eden's reviver). The right shape is to align Calendar
with the rest, not the rest with Calendar.

**Fix sketch:**

1. **Schema** (`apps/api/src/lib/calendar/schema.ts`) — switch column
   annotations to `integer(name, { mode: 'timestamp' })` on `events.startTime`,
   `events.endTime`, and `createdAt`/`updatedAt` on `events`, `calendars`,
   `sharedCalendars`. Same INTEGER storage; only the Drizzle wrapper changes.
   No DDL migration. Also add `.notNull()` to the `createdAt`/`updatedAt`
   columns: they have a `default(sql\`(unixepoch())\`)` so they're never null
   in practice, but Drizzle's `$inferSelect` types them as nullable today —
   that's the broken window the `as number` casts paper over. Leave
   `eventTombstones.deletedAtCtag` and `events.eventCtag` as raw `integer` —
   they're counters, not timestamps.

2. **Mappers** (the three `dbEventToCalendarEvent` / `dbCalendarToCalendarItem`
   / `dbRowToSharedCalendar` bodies in `apps/api/src/lib/calendar/calendar.ts`)
   — drop the `as number` casts. With `.notNull()` from step 1 plus
   `mode: 'timestamp'`, Drizzle returns `Date` directly; no coalescing needed.

3. **Shared types** (`packages/lib/src/types/calendar.ts`) — flip
   `startTime`/`endTime`/`createdAt`/`updatedAt` from `number` → `Date` on
   `CalendarItem`, `CalendarEvent`, `CalendarEventOccurrence`, `FreeBusyBlock`,
   `CreateEventInput`, `UpdateEventInput`, `SharedCalendar`.

4. **Route schemas** (`apps/api/src/routes/calendar.ts`) — body fields
   `t.Number()` → `t.Date()` on `CreateEventSchema` / `UpdateEventSchema`.
   Path-param range bounds (`/event-range/:from/:to`) stay `t.Numeric()`.

5. **Migrate the internal math to `Date`, end-to-end** —
   `expandRecurrence`, `computeOccurrenceTimes`, `utcToLocal` /
   `localToUtcSeconds` currently take/return Unix seconds. Don't introduce
   boundary-conversion helpers (single-use abstraction; CODE-STANDARDS.md
   §"Don't extract single-use helpers"). Instead: track durations as
   `durationMs = endTime.getTime() - startTime.getTime()` locally, replace
   `+ 86400` with `+ 86400_000`, drop `Math.floor(date.getTime() / 1000)`
   pairings, change `utcToLocal(epochSeconds: number, tz)` to
   `utcToLocal(date: Date, tz)`. The wall-clock math already goes through
   `Date.UTC(...)` internally, so this deletes `* 1000` / `/ 1000` lines
   rather than adding them. The wall-clock-aware RRule expansion is delicate;
   land the type flip and the math migration as separate commits so a
   bisect can isolate any DST regression.

**Watch for (gotchas the rejected plan missed):**

- **Drizzle WHERE clauses** at `calendar.ts:497–498, 757–758` —
  `lte(schema.events.startTime, to)` / `gte(schema.events.endTime, from)`
  with numeric `from`/`to`. After the schema flip the column type is `Date`,
  so wrap: `lte(schema.events.startTime, new Date(to * 1000))`.
- **Sort comparator** at `calendar.ts:841` —
  `results.sort((a, b) => a.startTime - b.startTime)` becomes Date
  arithmetic. Use `.getTime()`.
- **`computeOccurrenceTimes`** at `calendar.ts:1586–1652` — heavy seconds
  arithmetic on `parent.startTime`/`parent.endTime`. Returns a numeric
  `{ startTime, endTime }` pair fed back into `createEvent`. Per step 5,
  flip its signature to return `{ startTime: Date, endTime: Date }` and
  rewrite the math on `Date`; don't add a numeric→Date wrapper at the seam.
- **`computeEtag`** at `calendar.ts:69–99` — accepts `startTime: number`,
  `endTime: number`. Six callers pass these from `input.*` / `existing.*`.
  After the type flip, all six fail typecheck. Either change the signature
  or convert at call sites.
- **`new Date(evt.startTime * 1000)`** at `calendar.ts:799, 830` — for
  occurrence-date computation. Becomes `new Date(evt.startTime)`.
- **CalDAV `ParsedEvent`** (`apps/api/src/lib/caldav/ical-parse.ts`) —
  `startTime`/`endTime` are numeric Unix seconds, fed into
  `calendar.createEvent`/`updateEvent` from four `caldav/resource.ts` call
  sites: `:62, 86` (master event update + create) and `:155, 166` (exception
  update + create inside `syncExceptionEvents`). ParsedEvent's shape ripples;
  either flip ParsedEvent to `Date` too, or convert at the four call sites.
- **CalDAV serialiser** (`apps/api/src/lib/caldav/ical-serialize.ts`) — the
  `formatDateUTC` / `formatDateTimeUTC` / `formatDateTimeInTZ` helpers all
  take Unix seconds. Per step 5, change them to take `Date` rather than
  wrapping at every call site. With `.notNull()` from step 1 the
  `?? 0` fallbacks at lines 114–116 also disappear.
- **iMIP** (`apps/api/src/lib/calendar/imip.ts:22, 40`) — calls
  `formatEventWhen(event.startTime, event.endTime, ...)`. The shared helper at
  `packages/lib/src/core/date.ts:55–84` currently takes seconds (`startEpoch`,
  `endEpoch`); flip its signature to take `Date` and drop the internal
  `* 1000`. iMIP is the only external caller besides Calendar's own usage.
- **Cross-instance invitation propagation**
  (`apps/api/src/lib/calendar/invite-propagation.ts:48–49, 116–117`) —
  `sendToHome(...)` payloads ship `startTime`/`endTime` between Eigen
  instances. Receiver types in `calendar.ts:33–63`
  (`ReceiveInvitationPayload`, `InvitationUpdatePayload`) declare these as
  `number`. This is a *separate* internal RPC wire format from the public
  REST surface; decide whether it stays numeric (cleaner for internal use) or
  flips with the rest. Plan in lockstep so a deploy that mixes old/new
  versions doesn't break invitations.
- **Frontend callsites** — at minimum:
  `packages/lib/src/core/date.ts` (`formatEventWhen` signature),
  `packages/lib/src/core/calendar/calendar-utils.ts`,
  `packages/lib/src/core/calendar/use-calendar.ts`,
  `apps/calendar/src/components/{create,edit,event-detail}-event-dialog.tsx`,
  `apps/calendar/src/components/{week,month}-view.tsx`,
  `apps/calendar/src/routes/_auth.view.$mode.$from.$to.tsx`. Search for
  `* 1000` / `/ 1000` on calendar fields.
- **Tests** — ~100 epoch literals across `apps/api/src/test/calendar.test.ts`,
  `calendar-timezone.test.ts`, `calendar-invites.test.ts`,
  `team-calendar-share.test.ts`. Mechanical sweep; bake in the `* 1000`
  conversion or rewrite as `new Date(...)`.

**Mapper-name correction:** the third Calendar mapper is `dbRowToSharedCalendar`
(not `dbSharedCalendarToSharedCalendar` as the rejected plan claimed).

**Driver convention:** see `project_date_wire_convention` memory note for the
canonical Date end-to-end pattern this brings Calendar in line with.

---

## Done

- **2026-05-04** — Drive editor (`editor.ts`, `inline-edit.ts`) aligned to the
  Date convention. Three `.toISOString()` calls dropped, body schema switched
  from `t.String()` to `t.Date()`, conflict comparison switched to
  `Date.getTime()`. Shared types (`EditorContent`, `EditorSaveResult`) and FE
  prop types flipped from `string` → `Date`. (Not a Calendar change, but it
  removed the second-largest deviation from the convention and motivates this
  TODO.)
