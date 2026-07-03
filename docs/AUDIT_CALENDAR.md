# Deep-dive: `calendar.ts`, CalDAV, and iMIP

_Companion to [AUDIT.md](AUDIT.md). Scope: `apps/api/src/lib/calendar/` (calendar.ts 1633 LOC, imip.ts,
invite-propagation.ts, share-propagation.ts, get-calendar.ts), `lib/caldav/` (1278), `lib/contacts/`,
`routes/calendar.ts` (302), `routes/contacts.ts`._

`calendar.ts` is the second-largest file in the repo. **Grade: B-.** The subsystem is well-structured
and idiomatic — vetted libraries for parsing/expansion/XML, consistent output escaping, clean
cross-home relay discipline, strong test coverage. But three real security/robustness gaps land in the
untrusted-input paths this system explicitly exposes (email iMIP + shared calendars), and the god file
carries pure helpers that want to be extracted.

## P1 findings

### Cross-calendar write escalation (IDOR) [certain]

The event routes check permission on `calId` but mutate by `eventId`:

```ts
// routes/calendar.ts:199-220 (PUT / DELETE)
const { permission } = await checkCalendarAccess(user, params.ownerId, params.calId);
if (permission !== 'write') throw new ApiError(403, 'Write permission required');
return updateEventAt(params.ownerId, params.id, body, user);   // keyed on id, not calId
```

`updateEvent` (calendar.ts:605) and `deleteEvent` (calendar.ts:703) do `getEventById(id)` and **never
verify** `existing.calendarId === calId`. Failure scenario: Bob shares calendar A (write) with Alice.
Alice enumerates event ids from any of Bob's calendars she can read (team calendars grant implicit
read to all members, get-calendar.ts:40), then `PUT /calendar/bob/calendars/{A}/events/{event-in-B}`.
`checkCalendarAccess(A)` returns `write`; the update runs against B. **One write-share on a single
calendar grants write/delete/cancel across every calendar in that owner's home.** For teams, a member
with write on the team default calendar can edit all other team calendars. **Fix:** thread `calId`
through `updateEventAt`/`deleteEventAt` and assert `existing.calendarId === calId` (throw 404, matching
`createEvent`, which is already `calId`-scoped).

### Unvalidated IANA timezone → stored crash [certain]

`createEvent` (calendar.ts:392) and inbound iMIP (ical-parse.ts:73 → imip.ts:184) store the ICS `TZID`
parameter **verbatim**. Every later consumer feeds it to `Intl.DateTimeFormat({ timeZone })`, which
throws `RangeError` on any non-IANA value:

- `getIntlFormatter` (calendar.ts:145) — recurrence expansion / range fetch → **500 on the whole
  event-range fetch**.
- `formatDateTimeInTZ` (ical-serialize.ts:52) — CalDAV GET/REPORT + outbound iMIP crash for _any_ event.
- `formatEventWhen` (packages/lib/src/core/date.ts:62) — `composeRsvpReply` throws inside `rsvp()`
  (calendar.ts:1366) → the attendee **cannot RSVP**.

Not just adversarial: Outlook routinely emits Windows zone names like `W. Europe Standard Time`
(confirmed `RangeError`), and `ical-parse.ts` takes `getParameter('tzid')` raw. A single real Outlook
invite can permanently break a user's calendar view and CalDAV sync. **Fix:** validate once at
parse/create (`Intl.supportedValuesOf('timeZone')` membership, or a guarded `try/catch` that nulls
invalid zones) so an unknown TZID degrades to floating/UTC instead of a persistent crash.

### Inbound iMIP trusts ICS-declared identities [likely]

`processInboundImip(home, mail)` (imip.ts:158) is reached from fully untrusted inbound email
(mail.ts:29) and never inspects `mail.from`/the envelope sender. For `METHOD:REPLY` (imip.ts:221) it
finds the recipient's organized event by UID and applies each ICS attendee's `PARTSTAT` — so anyone who
knows an event UID (every external attendee receives it in the invite `.ics`) can email a forged REPLY
marking a _different_ attendee accepted/declined. For `METHOD:REQUEST` (imip.ts:190) it sets
`organizerUserId = external_{ICS ORGANIZER email}` from the ICS body, injecting events attributed to a
spoofed organizer. The caller already has `parsed.from` (mail.ts:31); the function signature just drops
it. **Fix:** pass the authenticated sender into `processInboundImip` and require the REPLY's attendee /
REQUEST's organizer email to match the envelope From before mutating.

## P2 findings

### CalDAV `calendar-query` time-range parsed with `new Date()` → empty REPORT [likely]

`xml-parser.ts:52` does `new Date(start)` where the CalDAV `<C:time-range start="20260401T000000Z">`
attribute is RFC 5545 basic format. `new Date('20260401T000000Z')` is **Invalid Date**;
`getRawEventsInRange` then compares against NaN bounds and `rrule.between(Invalid, Invalid)` returns
`[]`, so a windowed `calendar-query` returns nothing. Apple Calendar / DAVx5 lean on time-range queries
for initial sync, and only `calendar-multiget` is tested. **Fix:** convert the basic format explicitly
before `new Date`.

### Unbounded recurrence expansion (DoS) [likely]

Routes pass `from`/`to` straight through (calendar.ts:147) with no magnitude limit, and
`expandRecurrence` / `getRawEventsInRange` call `rule.between(from, to, true)` with no cap.
`RRule.parseString` accepts `FREQ=SECONDLY`/`MINUTELY` and rules with neither `UNTIL` nor `COUNT`. An
authenticated user creates such an event and requests `event-range/0/253402300799`; `getEventsInRange`
runs synchronously and materializes billions of occurrences, blocking the single event loop for all
users. Reachable cross-user via the read-permitted range route against a victim's recurring event.
**Fix:** clamp the queried window server-side (e.g. ≤ a few years) and/or pass a `count` ceiling to
expansion.

## P3 findings

- **`sql` template literals mangled across lines** (calendar.ts:342, 771, 1472) render as
  `unixepoch\n  ()` — a Biome-formatting artifact that reads as broken (SQLite tolerates it). Collapse
  to single-line `sql` fragments.
- **Duplicated wall-clock-dtstart construction** — the `utcToLocal → Date.UTC → new RRule` block is
  copy-pasted between `expandRecurrence` (calendar.ts:1490) and `computeOccurrenceTimes` (1575). A
  shared `wallClockRule(event)` in the proposed `recurrence.ts` removes it.
- **`getEventsInRange` returns cancelled standalone events** (calendar.ts:751, no status filter); only
  the free-busy route strips them. Confirm it's intentional.
- **`deleteEvent` non-null assert** `existing.data.organizerEventId!` (calendar.ts:714) — a linked event
  with `organizer` but missing `organizerEventId` passes `undefined` to `propagateDecline`.

## Duplication

Beyond the wall-clock block: the `const { eventCtag: _ctag, ...rest } = event` strip recurs
(calendar.ts:454, 695, 699); the four `dbRowTo*` mappers are idiomatic boilerplate. `escapeXml` vs
`escapeICal*` vs `escapeHtml` are correctly kept separate per output context — not duplication. No
cross-file logic duplication of concern.

## Decomposition proposal for `calendar.ts`

The dir already sets the extraction precedent (`imip.ts`, `invite-propagation.ts`,
`share-propagation.ts` are pure/cross-home logic pulled out of the class). Extend it by pulling the
**pure, module-level** clusters — but keep the interlocked CRUD+invitation core intact.

### Responsibility inventory

| Lines | Responsibility | Purity |
|---|---|---|
| 109-139 | Etag hashing (`computeEtag`) | pure |
| 141-198 | Timezone math (`getIntlFormatter`, `utcToLocal`, `localToUtc`) | pure |
| 200-260 | Row→domain mappers (`dbEventToCalendarEvent`, …) | pure |
| 262-368 | Class init + Calendar CRUD | class |
| 370-843 | Event CRUD + range/CalDAV reads | class |
| 845-1062 | Shared-calendar state (most independent instance group) | class |
| 1064-1448 | Invitations / RSVP | class |
| 1450-1479 | Internal (`destruct`, `getException`, `incrementCtag`) | class |
| 1481-1633 | Recurrence expansion (`expandRecurrence`, `constrainRRule`, `computeOccurrenceTimes`) | pure |

### Coupling

Two clusters are already pure and `this`-free: the **timezone helpers** (141-198) and the **recurrence
functions** (1481-1633) — they depend only on `rrule` + each other. The row mappers (200-260) and
`computeEtag` are likewise pure. The class methods share a tight private core (`incrementCtag`,
`touchEvent`, `getEventById`, `getException`, `computeEtag`). **Events and Invitations/RSVP are
inseparable** — `rsvpForOccurrence`/`removeOccurrence` call `createEvent`/`getException`/`touchEvent`;
`rsvp` calls `deleteEvent`/`removeThisAndFuture`. The **shared-calendar** cluster (845-1062) is the most
independent instance group (only `this.db` + `home.broadcast/notifications`).

### Split order (each compiles + is independently reviewable)

1. **`calendar/recurrence.ts`** — the tz helpers (141-198) + `expandRecurrence`/`constrainRRule`/
   `computeOccurrenceTimes` (1481-1633). ~230 LOC out, zero class coupling, purely mechanical. Do
   first; it also removes the wall-clock duplication.
2. **`calendar/mappers.ts`** — `computeEtag` + the four `dbRowTo*` mappers (109-139, 200-260). ~90 LOC,
   pure.
3. _(Optional, only if further reduction is wanted)_ a `SharedCalendars` helper holding a `db`/`home`
   ref for methods 845-1062, composed by `Calendar` (like `Contacts`/`Maildir` sit under `Home`). This
   is **borderline against "flat and direct"** — a second class over the same DB — so present it as
   optional, not default.

Steps 1+2 alone drop `calendar.ts` by ~320 lines to ~1300 while keeping the cohesive DB class intact.

### What should NOT be split

The Events + Invitations/RSVP methods (370-843, 1064-1448) must stay in one class: they share the
`incrementCtag`/`touchEvent`/`getEventById`/`getException`/`computeEtag` bookkeeping and mutate the
same table with interlocked etag/ctag/sequence updates. Splitting them forces exporting private helpers
or duplicating the ctag/etag dance — exactly the service-layer indirection CODE-STANDARDS forbids.
Extract only the pure modules.

## Strengths

- **Libraries over homegrown for the dangerous surfaces:** `ical.js` (parse), `rrule` (expansion),
  `fast-xml-parser` (CalDAV XML — doesn't expand DTD entities, so no XXE / billion-laughs on the REPORT
  path).
- **Consistent output escaping:** `escapeXml` on every CalDAV value, `escapeICalText`/`escapeICalParamValue`
  (CRLF + quote stripping) on iCal, `escapeHtml` on email. Injection is well-covered on serialize.
- **Parse crashes are contained:** `parseIcs` is wrapped in try/catch at both callers (resource.ts:46,
  mail.ts:33), so a malformed `.ics` drops the invite rather than 500-ing delivery.
- **Replay protection:** `receiveInvitationUpdate` drops `sequence <= linked.sequence`
  (calendar.ts:1139); `ical-parse.ts:86` coerces non-numeric SEQUENCE to 0 so NaN can't bypass the
  guard.
- **Cross-home discipline is clean:** propagation/relay never calls `getHome` for another user's
  writes; `notifySharedCalendarUsers` deliberately skips team fan-out with a rationale comment.
- **Contacts store structured JSON** (no vCard parser attack surface) and sanitize the avatar filename
  (contacts.ts:298).

## Debt themes

1. **Untrusted input reaches typed internals without boundary validation** — TZID and iMIP identities
   both violate CODE-STANDARDS' "validate at system boundaries." The email/CalDAV seams are exactly
   those boundaries, and they're where the validation is thinnest.
2. **Permission checked on one identifier, action performed on another** — the `calId`-vs-`eventId`
   split (the IDOR) is the classic confused-deputy shape; worth an audit pass for the same pattern
   elsewhere.
3. **`calendar.ts` accretion** — pure helpers never got pulled out the way `imip.ts`/`*-propagation.ts`
   were; the two-step extraction above closes that gap.

## Out of scope, noted for the relevant owners

- The CalDAV serializer emits `DTSTART;TZID=` without a `VTIMEZONE` component (ical-serialize.ts:98) —
  interop-risky regardless of the TZID crash above.
- `/mail/deliver/:email` is the untrusted-iMIP vector; sender restrictions there are finding 1 in
  [AUDIT.md](AUDIT.md).

---

_Postscript 2026-07-03: decomposition executed on `refactor/calendar-split` (merged ed3b3ba6) — `recurrence.ts` + `mappers.ts` extracted, calendar.ts 1685→1367 LOC. Deviation: the wall-clock dedup landed as a `wallClockDate(date, tz)` primitive (4 sites) instead of the proposed `wallClockRule` (2 sites). Events+RSVP kept in-class and `SharedCalendars` skipped, per the doc._
