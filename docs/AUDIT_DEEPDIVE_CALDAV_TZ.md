# Deep-dive: CalDAV timezone + recurrence correctness (audit #8, #9, #24 + new bugs)

> **Status (2026-07-12):** verified, no production code changed. Two independent verification passes
> converged. This feeds **pending Unit 4** of the audit fix pass (calendar tz: #7/#8/#9/#24). All claims
> below are test-proven unless marked *(reading only)*.
>
> **Branch:** `fix/api-audit-2026-07` (HEAD `08bda417`, Units 1–2 landed).
> **Original audit:** `docs/AUDIT_API_2026_07.md` (findings #8, #9, #24; "spend more time" item #3).
> **Sibling deep-dives:** `AUDIT_DEEPDIVE_UPLOAD_QUEUE.md`, `AUDIT_DEEPDIVE_COLLAB_YJS.md`, `AUDIT_DEEPDIVE_MAILPARSER.md`.

## How to resume this cold

1. Read `AGENTS.md` + `docs/CODE-STANDARDS.md` + `docs/CALENDAR.md`.
2. Read the calendar/CalDAV layer: `apps/api/src/lib/caldav/` (`ical-parse.ts`, `ical-serialize.ts`,
   `caldav-router.ts`, `report.ts`, `resource.ts`), `apps/api/src/lib/calendar/` (`calendar.ts`,
   `recurrence.ts`, `imip.ts`, `mappers.ts`).
3. The red regression tests are preserved in `docs/superpowers/api-audit-deepdive-tests/`:
   `audit-caldav-tz-verify.test.ts` (the comprehensive one — 9 red, covers every finding here),
   `caldav-tz-audit.test.ts` + `calendar-fanout-etag-audit.test.ts` (the sibling pass, also committed at
   worktree `@c05e1549`). Copy into `apps/api/src/test/` and run:
   `cd apps/api && bun test --preload ./src/test/preload.ts --concurrency 1 src/test/audit-caldav-tz-verify.test.ts`.
4. Line numbers below may have drifted — **locate by symbol name**.

## Root cause that ties most of these together

**Occurrence keys are wall-clock dates everywhere in expansion/keying, but several parse and serialize
paths compute dates from the UTC instant.** For a timed recurring event whose occurrence start crosses
midnight UTC (evening events in the Americas, small-hours events east of UTC), the UTC date is one day
off the wall-clock date, so edits/cancellations attach to the wrong occurrence or duplicate. Fixes for
#8, finding 2, and finding 5 should land together.

---

## #8 — RECURRENCE-ID keyed by UTC date vs wall-clock EXDATE/expansion — **REAL (P1-adjacent)**

**Where:** `caldav/ical-parse.ts` RECURRENCE-ID derives its date from `rid.toJSDate()` + `getUTC*`
(~:99-104). EXDATE in the same file uses wall-clock components `exVal.year/month/day` (~:200-203).
Occurrence keying: `calendar/recurrence.ts` `occurrenceDateToString` (~:130), operating in wall-clock space.

**Symptom / failure scenario:** PUT a daily/weekly 23:00 `America/New_York` series (with VTIMEZONE, as
every real client sends), then a second PUT adding an EXDATE, a `STATUS:CANCELLED` override, and a
retitled override (both keyed `RECURRENCE-ID;TZID=America/New_York:...T230000`). Observed: EXDATE cancels
the correct day; but the RECURRENCE-ID overrides are stored keyed to the **UTC date (+1 day)**, so the
cancellation kills the wrong day (the intended instance still renders) and the modification produces a
**duplicate** (two events at the same instant). One client edit corrupts up to **three** occurrences on
a daily series (the +1-day mis-key lands on a valid neighbor). The trigger boundary shifts by an hour
across DST, so a 19:30 NY series flips between correct and corrupt within one series across November.

**Verdict:** real, exactly as the audit described the "inconsistency within one file," and higher impact
than the audit implied. **Fix adds real value.**

**Fix direction (refined — the audit's version is incomplete):** the audit says "derive `recurrenceDate`
from `rid.year/month/day` components." That fixes the dominant TZID + floating + DATE forms but **misses
UTC-`Z`-form** RECURRENCE-ID/EXDATE (which Exchange-lineage clients emit, and which Eigen itself emits for
tz-null exceptions — see finding below). Correct fix: when the `ICAL.Time` resolves to a real zone (UTC or
a VTIMEZONE), convert the instant to the **event's timezone** wall date (use the existing `utcToLocal` in
`recurrence.ts`); use raw components only for floating/DATE. Apply identically to EXDATE.

**Test:** `audit-caldav-tz-verify.test.ts` › "#8 RECURRENCE-ID vs EXDATE keying" (also `caldav-tz-audit.test.ts`
"modified occurrence attaches to the right instance" / "cancelled occurrence disappears").

---

## #9 — attendee editing a linked event runs the organizer fan-out — **REAL, worse than audit (P1)**

**Where:** attendee guard `calendar/calendar.ts` (~:414-421) correctly localizes an attendee's edit to
reminders/color. But the organizer block (~:507-515) still runs `incrementSequence(id)` +
`propagateInvitation(...)`. Spoofing happens in `imip.ts` `composeUpdateEmail` → `withOrganizer()` (~:77-87).
Replay guard that causes the data loss: `calendar.ts` ~:968 (`payload.sequence <= linked.sequence`).

**Symptom / failure scenario:** Alice invites Bob (internal) + Carol (external). Bob toggles a reminder on
his linked copy through the app. Observed:
1. Bob's linked-copy SEQUENCE bumps 0 → 1.
2. An iMIP `METHOD:REQUEST` "Updated invitation" is sent to Carol with **`ORGANIZER` = Bob** (attendee
   spoofed as organizer).
3. **The kill-shot (both passes found this independently, not in the audit):** because Bob's SEQUENCE now
   outran the organizer's, when Alice later makes a *real* change (rename), `receiveInvitationUpdate`'s
   RFC 5546 replay guard drops it (`payload.sequence <= linked.sequence`). **Bob silently stops receiving
   the organizer's updates after a single reminder toggle.** This is internal data-desync, not just spam.

Internal co-attendees no-op via `findLinkedEvent` miss (confirmed). CalDAV `handlePut` calls `updateEvent`
without `user`, so this fires only via app routes.

**Verdict:** real; severity raised from "spoofed mail + hygiene" to data-desync. **Fix adds high value.**

**Fix direction (audit's is correct and complete):** gate the ~:507 propagate/`incrementSequence` block on
the organizer case — skip when `existing.data?.organizer` is set (mirror the ~:414 discriminator). RSVP
propagation lives in its own path and is unaffected.

**Test:** `audit-caldav-tz-verify.test.ts` › "#9 attendee edit fan-out" (three assertions: no SEQUENCE bump,
no spoofed iMIP, organizer's next update still lands); also `calendar-fanout-etag-audit.test.ts`.

---

## NEW #A — inbound iMIP single-occurrence REQUEST destroys the attendee's whole series — **P1 (not in audit)**

**Where:** `calendar/imip.ts` `processInboundImip` REQUEST branch.

**Symptom / failure scenario:** an external organizer (Google/Outlook) moves **one** occurrence of a
recurring meeting — they send a lone VEVENT carrying a `RECURRENCE-ID` and a bumped SEQUENCE. Eigen feeds
it into `receiveInvitationUpdate` as a *full-event* update: the master's `rrule` becomes null and its start
moves to the exception's time. Observed: an 8-week series collapses to a single moved event
(`{"rrule":null,"start":"2026-04-08T15:00:00Z"}`).

**Impact:** every Eigen user attending an external recurring meeting loses the entire series the **first
time** the organizer reschedules any single instance. This is the single highest-likelihood × blast-radius
bug found in the whole exercise, and it is **not in the original audit**.

**Verdict:** real, test-proven. Highest priority.

**Fix direction:** when `parsed.recurrenceDate` is set, REQUEST must create/update an **exception** on the
linked event (times from the parsed VEVENT, keyed per the #8 fix) instead of calling
`receiveInvitationUpdate`. Only a master-VEVENT REQUEST (no RECURRENCE-ID) should touch the master.

**Test:** `audit-caldav-tz-verify.test.ts` › "hunt: iMIP exception-only REQUEST".

---

## NEW #B — inbound iMIP single-occurrence CANCEL deletes the whole series — **P1 (not in audit)**

**Where:** `calendar/imip.ts` `processInboundImip` CANCEL branch — `parsed.recurrenceDate` is ignored and
`removeInvitation(uid, …)` drops the entire linked event.

**Symptom / failure scenario:** organizer cancels one occurrence of an 8-occurrence series → 0 rows remain.

**Verdict:** real, test-proven. Same family as #A.

**Fix direction:** when `parsed.recurrenceDate` is set, CANCEL must create a **cancelled exception** on the
linked event, not `removeInvitation`. Only a master-VEVENT CANCEL should delete the series.

**Test:** `audit-caldav-tz-verify.test.ts` › "hunt: iMIP single-occurrence CANCEL".

---

## NEW #C — RECURRENCE-ID serialized from the moved startTime → orphan override — **P2, timezone-independent (not in audit)**

**Where:** `caldav/ical-serialize.ts` (~:126-137).

**Symptom / failure scenario:** a "move this occurrence" edit round-trips with a `RECURRENCE-ID` computed
from the exception's **moved** startTime rather than its original occurrence time. The RECURRENCE-ID then
matches no occurrence; Apple/Thunderbird treat it as an orphan and render the original slot too. Proven with
a **pure-UTC** fixture — so this hits plain weekly meetings, not just offset-timezone events.

**Verdict:** real, test-proven. **Fix adds value.**

**Fix direction:** serialize RECURRENCE-ID from `computeOccurrenceTimes(master, recurrenceDate)` (in the
master's TZID form), not from `event.startTime`.

**Test:** `caldav-tz-audit.test.ts` › "RECURRENCE-ID round-trip" (RED); also covered by
`audit-caldav-tz-verify.test.ts` #8b echo round-trip.

---

## NEW #D — CalDAV re-PUT never deletes stale exceptions → "undo delete occurrence" doesn't stick — **P2 (not in audit)**

**Where:** `caldav/resource.ts` `syncExceptionEvents` (~:131-182) only **upserts**; it never deletes
exceptions absent from the PUT body.

**Symptom / failure scenario:** PUT with an EXDATE (occurrence hidden), then PUT without it (Apple's "undo
delete occurrence"). The cancelled exception row survives the full-resource replace, so the occurrence stays
hidden forever and the next GET re-teaches the cancellation to the client.

**Verdict:** real, test-proven. **Fix adds value.**

**Fix direction:** a CalDAV PUT is a full-resource replace — `syncExceptionEvents` should delete stored
exceptions of the master that are absent from the PUT payload.

**Test:** `audit-caldav-tz-verify.test.ts` › "hunt: EXDATE removal on re-PUT"; `caldav-tz-audit.test.ts`
"EXDATE-undo".

---

## NEW #E — FE RSVP scope='this' duplicates exception rows via UTC-date occurrenceDate — **P2, no CalDAV needed (not in audit)**

**Where:** `calendar/calendar.ts` `getEventsInRange` (~:656) re-keys a substituted modified occurrence with
`occurrenceDateToString(modEvt.startTime)` — the **UTC date** — instead of the exception's stored wall-clock
`recurrenceDate`. The FE (`event-detail-dialog.tsx` ~:182) round-trips that rendered `occurrenceDate` into
its next `scope:'this'` RSVP.

**Symptom / failure scenario:** Bob RSVPs `scope:'this'` on a wall-date-crossing occurrence (key `2026-06-02`);
it renders back with `occurrenceDate: 2026-06-03`; his next RSVP for the same occurrence sends `2026-06-03`,
misses `getException`, and creates a **second** exception row for one occurrence. Exists today with zero
CalDAV involvement.

**Verdict:** real, test-proven. **Fix adds value** (shares the #8 root cause).

**Fix direction:** render substituted occurrences with the exception's stored `recurrenceDate`
(`exc.recurrenceDate`), not the UTC date of its startTime.

**Test:** `audit-caldav-tz-verify.test.ts` › "hunt: rendered occurrenceDate of a modified occurrence";
`calendar-fanout-etag-audit.test.ts` "occurrenceDate drift".

---

## #24 — computeEtag omits timezone — **CONFIRMED (P3)**

**Where:** `calendar/calendar.ts` `rsvpForOccurrence` (~:1099-1109) and `removeThisAndFuture` (~:1259-1269)
omit `timezone` from the etag basis, while create/update include it. Etag helper: `calendar/mappers.ts`.

**Symptom:** the same event content hashes differently across paths → a byte-identical repeat RSVP flips the
exception's etag → one spurious CalDAV client re-download. `rsvpForOccurrence` shows the effect today;
`removeThisAndFuture` always changes `rrule` so it's effect-free but drift-prone.

**Verdict:** confirmed divergent; low impact. **Fix is a fine two-line consistency cleanup, do it while in
the file — but it is the least valuable item here** (the audit's P3 placement is honest). Side observation:
exceptions from `rsvpForOccurrence`/`removeOccurrence`/`syncExceptionEvents` are stored with `timezone: null`,
which is why they serialize to UTC (Z) forms and feed #8/#C.

**Fix direction:** add `timezone` to the etag basis at both sites; also pass the parent's `timezone` when
creating exception rows.

**Test:** `calendar-fanout-etag-audit.test.ts` › "#24" (RED) + a green control proving etags still change on
real changes.

---

## Also found (RFC / hygiene)

- **NEW #F — no VTIMEZONE emitted** (`ical-serialize.ts` `wrapInVCalendar`/`eventsToIcs`): TZIDs are
  referenced with no VTIMEZONE block (RFC 5545 §3.6.5 violation). Apple/Google/Thunderbird tolerate IANA
  names, **but Eigen's own ical.js-based parser reads the wall time as *floating* in the receiver's server
  timezone** — so Eigen↔Eigen iMIP federation shifts the instant unless event-tz == server-tz. Medium; also
  the root of the next item. Fix: emit VTIMEZONE blocks per referenced TZID (needs a small IANA→VTIMEZONE
  generator from Intl offsets). Test: `caldav-tz-audit.test.ts` "VTIMEZONE round-trip".
- **NEW #G — floating/unresolvable-TZID datetimes parsed through the server's local timezone**
  (`ical-parse.ts`, `ICAL.Time.toJSDate()` on a floating zone): the same ICS keys `2026-02-11` on
  Amsterdam/UTC/Tokyo servers but `2026-02-12` on a New York server; applies to `startTime` too, not just
  RECURRENCE-ID. **Prod (Hetzner, European TZ) is safe by accident.** Fix: parse floating datetimes as UTC
  (map components via `Date.UTC`).
- *(reading only)* `RANGE=THISANDFUTURE` on RECURRENCE-ID and RDATE are ignored by the parser
  (instance-range edits degrade to single-instance; RDATE-added occurrences never appear). Low — mainstream
  clients split series into new UIDs. `syncExceptionEvents` also drops the parsed exception's `sequence`.

## Cleared (checked, not findings)

DST-boundary expansion of CalDAV-created events (NY spring-forward, Amsterdam fall-back, ambiguous/nonexistent
times — existing suite covers these), EXDATE;TZID and DATE-form EXDATE on first PUT, all-day recurring across
DST, wall-clock DTSTART regeneration, TEXT escaping/folding round-trip (emoji, 200-char lines), the
linked-event edit guard itself, Bun's Intl midnight rendering (no 24:00 hazard).

## Suggested landing order for Unit 4

1. **#A + #B** (iMIP instance-scoping) — highest impact, well-scoped in `imip.ts`.
2. **#9** (one-line organizer-fanout guard) — kills spoofed iMIP + the update-drop desync.
3. **#8 + #C + #E + #24** (the occurrence-keying family) — land together; convert UTC-Z to event-tz wall
   date, serialize RECURRENCE-ID from occurrence times, render exceptions by stored key, include timezone in
   etag, give exception rows the parent's timezone.
4. **#D** (delete stale exceptions on PUT), then **#F/#G** (emit VTIMEZONE / parse floating as UTC).

Bring the preserved red tests in as the net; they go green as each fix lands. No frozen-format impact and no
schema migration is required for any of these.
