# iCalendar Format, Import and Export

> **TLDR:** `apps/api/src/lib/ical/` reads and writes iCalendar for every surface that meets an `.ics`: the calendar store, CalDAV, iMIP, import, export and the quick look. Whole-file import and export sit in `apps/api/src/lib/calendar/transfer.ts`. Not obvious from the code: ical.js is the one serializer, and an edit touches only what it changes. A time resolves through `Intl` before the file's own VTIMEZONE. An occurrence is keyed by its wall-clock date in the series' zone, and a rule is bounded before anything expands it. The store around it: [CALENDAR.md](CALENDAR.md).

## ical.js is the one serializer, and an edit touches only what it changes

`ICAL.Component.toString()` writes every resource, so folding, escaping and parameter quoting are ical.js's problem. `buildResource` assembles a new VCALENDAR from rows, which only a REST create needs. Every other write edits the stored component in place (`patchEvent`, `putOverride`, `addExclusion`, `removeExclusion` in `ical-component.ts`), so every property Eigen didn't touch stays as the client wrote it.

A written `DTEND` removes the `DURATION` that stated the length before it, since RFC 5545 §3.6.1 allows one or the other. An end instant that falls in the second pass of a repeated hour can't be named in the stored zone's wall clock. It is written as a UTC `DTEND` beside the TZID `DTSTART`, which RFC 5545 allows, so the duration survives.

## Eigen writes a VTIMEZONE for every zone it names

Without a VTIMEZONE, strict parsers (ical.js included) read a TZID's wall times as floating (RFC 5545 §3.6.5). `vtimezone.ts` builds one from `Intl` offset data. A zone with a regular DST rule compresses to two open-ended RRULE observances, and an irregular one gets one observance per transition.

A definition a property still names is the client's own and is never rewritten. One nothing references any more is dropped. New blocks go in front of the VEVENTs, because a client reads the file top to bottom and a TZID met before its definition is floating to it. `apps/api/src/test/ical/vtimezone.test.ts` checks the generator against `Intl`.

## A RECURRENCE-ID names the original occurrence

An override's `RECURRENCE-ID` and an `EXDATE` both name the occurrence the series would have had, computed from the master in the master's own DTSTART form, value type included. It is never the override's moved start, and never `VALUE=DATE` because the override was toggled to all day. Either would match no occurrence and orphan the override (RFC 5545 §3.8.4.4).

## Two readers, one trust rule

`parseIcs(text)` reads bytes a stranger wrote, and its result can't hold an `X-EIGEN-*` fact ([CALENDAR.md](CALENDAR.md#eigens-own-facts-ride-as-x-eigen--lines-no-client-can-write)). `projectResource(component)` reads a resource the store wrote and adds the stamps on top of the same projection. `parseResource` is the only place a stored `.ics` becomes a component tree, so nothing else imports ical.js for one.

A VEVENT the parser can't read is skipped and counted rather than failing the file. Each caller answers for its own surface: a PUT refuses the payload, the quick look counts it in `dropped`, an import in `failed`. Each VEVENT is wrapped in an `ICAL.Event` built with `{ exceptions: [] }`, which skips ical.js's scan for sibling exceptions. That scan is quadratic over a whole file: 20,000 events took 17 s.

## A time resolves through Intl before the file's own VTIMEZONE

A valid IANA TZID resolves through `Intl` even when the file defines a VTIMEZONE for it. That is the path the builder computes its wall times with, so identical bytes name one instant, and a repeated hour resolves to its first pass. A UTC value is exact.

A TZID `Intl` doesn't know goes through `propTzid` (`ical-parse.ts`). It tries the Windows zone table first, because Outlook writes names like `W. Europe Standard Time` (`normalizeTimezone`, over the CLDR rows in `packages/lib/src/core/calendar/windows-zones.ts`). Then it tries the `X-LIC-LOCATION` of the file's VTIMEZONE, where libical writes the IANA name beside a TZID no standard knows. When neither resolves, the stored `timezone` is `null`, and the file's own VTIMEZONE still gives the parser its instants. A floating time maps its wall components through `Date.UTC`, never through the server's zone.

## An occurrence is keyed by its wall-clock date in the series' zone

Expansion runs in wall-clock space, so an override must key to the same date to attach to its occurrence. A TZID `RECURRENCE-ID` or `EXDATE` keys on its own wall components, the RFC 5545 canonical form. A UTC value converts to the series' zone first, because a timed series crossing midnight UTC has a UTC day one off. Floating and `DATE` values keep their raw components. The series zone comes from each UID's master, and a master with no TZID keeps its series in UTC. `apps/api/src/test/calendar/calendar-timezone.test.ts` pins the keying.

Each `EXDATE` becomes a synthetic cancelled row. Its id and SEQUENCE come from the `X-EIGEN-EXDATE` stamp beside it, or the master's SEQUENCE when a client wrote the `EXDATE` itself. One occurrence is one row, however many forms name it.

An event ends at its `DTEND`, or at its `DURATION` when it names one, as Apple and Outlook both write. A timed VEVENT with neither is drawn as one hour, an all-day one as one day.

## Expansion is bounded because it walks from DTSTART

`rrule.between` steps from DTSTART to the window on the shared event loop. A `SECONDLY` rule starting a year back stalled it for about 74 s. So `recurrence-limits.ts` bounds what a rule may ask:

- A sub-daily rule is a 400 at the REST boundary. In a parsed `.ics` it is stripped from the projection, because refusing a whole file or invite over it is worse.
- A recurring DTSTART must fall between 1900 and 2200.
- One expansion yields at most `MAX_OCCURRENCES`, and a query window is clamped to five years.

A stripped rule stays in the stored bytes. The event draws as one occurrence, and `hasUnindexedRecurrence` makes a CalDAV time-range query return it for every window. An `RDATE` takes the same flag, and a `RANGE=THISANDFUTURE` override degrades to a single-instance edit.

## Import replays each series through the PUT seam

`Calendar.importEvents` (`transfer.ts`) takes a whole `.ics`, which must be UTF-8 (RFC 5545 §3.1). The event cap counts every VEVENT, not every master, because one master can hold 37,000 overrides inside `ICS_MAX_BYTES`. It is counted on the text before ical.js builds a tree, and again on what the parser returned. A file may spread one UID over several VCALENDAR objects, so VEVENTs are grouped by UID first.

Each series is written as its own resource through the CalDAV PUT seam under a fresh `<uuid>.ics`. UID uniqueness is Home-wide for an import, and a UID any calendar already holds counts as `skipped`. That makes a failed import retryable: a retry skips what landed and finishes the file. A written-bytes cap stops the run with a 413, because a VTIMEZONE the file defines once is copied into every series that names it.

**An import takes the scheduling out.** Every guest `ATTENDEE` is dropped, and the `ORGANIZER` becomes an inert `X-EIGEN-IMPORTED-ORGANIZER`. Otherwise the first edit would mail addresses the file's author chose, and a forged iMIP REPLY could match the event by UID. The imported organizer can still claim the event by sending a real invitation ([CALENDAR-INVITATIONS.md](CALENDAR-INVITATIONS.md#every-inbound-request-takes-one-locked-decision)).

## An import needs a target calendar

The file routes reach only the caller's own home and team homes, because only the home relay crosses into another user's Home. So a calendar another user shared is no target ([ROADMAP.md](ROADMAP.md)). An export takes `read` and an import `write`, and `free-busy` is no read here.

The "Import to Calendar" file action opens `ImportToCalendarPicker` (`packages/ui/src/components/calendar/`). It offers the viewer's own calendars, the team calendars they may write in, or a new one. `useImportToCalendar` deletes a new calendar again when it took no events, and a retry reuses the one it made.

## Export splices the stored lines

`exportEvents` lifts the `VTIMEZONE` and `VEVENT` blocks out of each stored resource as text (`spliceBlocks`, `blocks.ts`) and drops every line with an Eigen name. It never parses and re-serializes, because ical.js rewrites parameter quoting and order, and bytes Eigen only stored are not Eigen's to rewrite. The result is one VCALENDAR, never a concatenation, because many readers take only the first object of a stream. Nothing bounds the size of a whole-calendar export ([ROADMAP.md](ROADMAP.md)).

## See also

- [CALENDAR.md](CALENDAR.md): the store these bytes live in
- [CALDAV.md](CALDAV.md): the protocol that reads and writes them
- [PREVIEWS.md](PREVIEWS.md): the `.ics` quick look
- [EXPORT.md](EXPORT.md): why this export is not a document export
