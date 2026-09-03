# Proposal: Calendar events as `.ics` files, `calendar.db` as the index

> **TLDR**: Calendar is the last Eigen domain whose truth lives only in SQLite columns. Mail is a Maildir plus `mail.db`, contacts are `cards/*.vcf` plus `contacts.db`, but calendar is `calendar.db` and nothing else, with a vestigial `icsBlob` column that was never wired up. This proposal moves calendar onto the same model: **one `.ics` file per UID under `eigen.calendar/<calendarId>/`, the file is the source of truth, and `calendar.db` becomes a rebuildable index** plus the calendar-level metadata that has no iCalendar home (calendar rows, shares, tombstones, sync generation, recovery journal). Round-trips become lossless by construction: a CalDAV GET returns the bytes a client PUT, unknown properties, `VALARM`s and `X-` props included, and the ETag is a hash of the file. Every Eigen-side mutation goes load file → mutate the ical.js component → serialize → atomic write → index, under a per-Home write lock, so Eigen edits preserve what Eigen does not model. Per-event state Eigen owns (the event id, the invitation link, the creator) rides in the file as server-stamped `X-EIGEN-*` properties that a PUT cannot remove, so a from-scratch rebuild reproduces every row and every id. **No backward compatibility** (decided 2026-09-03): existing calendar data is dropped, not migrated; a `calendar.db` version bump recreates the schema empty and every calendar starts fresh. The shared file+index mechanics (atomic write, pending-write journal, dirty set, stat-only reconcile, full rebuild) come out of `contacts/` into one core module both domains use; calendar would be the third copy of the pattern, so it gets extracted, not cloned. Cost: the `Calendar` class is synchronous today and becomes async, which ripples mechanically through routes, the home relay, iMIP and share propagation. Roughly two weeks of agent time in four sequential phases.

## Goals

1. **Files are the truth, everywhere.** Every user-facing domain (drive, mail, contacts, calendar) ends up as standard files on disk with SQLite as an index. Backups, restores, exports and manual inspection use `cp`, `grep` and any iCalendar tool. A corrupt or lost `calendar.db` costs the calendar-level metadata (names, colours, shares, tombstones) and a full client resync, never an event; today it costs every event.
2. **Fidelity by construction.** A client's VEVENT survives Eigen untouched. Today `ical-parse.ts` keeps only what the columns model and `ical-serialize.ts` re-synthesises the rest on GET, so `VALARM` details, `ATTACH`, `RDATE`, `CATEGORIES`, `URL`, `COLOR`, `COMMENT`, every `X-` property and `RANGE=THISANDFUTURE` are silently dropped or degraded. The parse-time degradations (a sub-daily `RRULE` or an out-of-range `DTSTART` collapses to a single event) are written back to the client too, because GET re-serialises the degraded row. With the file as the resource there is no regenerate step to lose any of it.
3. **ETag and PUT semantics fall out of the file.** ETag is a hash of the stored bytes (the contacts `computeCardEtag` recipe). PUT is a full-resource replace because the resource *is* the file; the hand-built full-replace emulation in `caldav/resource.ts` (`syncExceptionEvents` prune, re-read ETag after the exception sync) goes away.
4. **One file+index core.** Mail, contacts and calendar all need atomic writes, torn-write recovery, a stat-only reconcile and a full rebuild. Contacts has the best version. Extract it once and use it twice.

## Non-goals

- **Migrating existing calendar data.** Decided 2026-09-03: current calendars, events, shares and linked invitations are dropped. Users recreate what they need; connected CalDAV clients get a full resync (the sync generation rotates, RFC 6578 recovery path). No export tool, no dual-read path, no legacy branch.
- **Changing the REST surface or the calendar app.** Routes keep their shapes and the FE keeps its types (`CalendarEvent`, `CalendarEventOccurrence`, `CreateEventInput`, `UpdateEventInput`). Event ids stay the random UUIDs they are today. What changes is how the backend stores and reads. The two `EventData` fields nothing writes (`notes`, `color`) are an open question, not a goal.
- **Changing the invitation model.** Linked copies in attendee calendars, server-side RSVP propagation, iMIP for external addresses, share propagation and team calendars all keep their semantics. They change writers, not behaviour.
- **Calendar import and feed subscriptions.** That is [PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md). This proposal makes it simpler (a feed refresh becomes "write these files, index them") and the two should not ship in the same branch.
- **A generic WebDAV file layer or exposing the `.ics` files through drive.** `eigen.calendar` stays a container the way `eigen.contacts` and `eigen.mail` do.
- **Full RFC 5545 semantics for properties Eigen does not model.** They round-trip verbatim; Eigen does not render them. `RDATE` and `RANGE=THISANDFUTURE` stay unsupported in the *index* (occurrence expansion), exactly as today, but are no longer destroyed on the way through.

## Current state (recap)

**Calendar is DB-canonical.** `apps/api/src/lib/calendar/calendar.ts` (`class Calendar`, 1.6k lines) reads and writes `eigen.calendar/calendar.db` through Drizzle. `events` rows carry the iCalendar identity (`uid`, `uri`, `etag`, `sequence`), the times, `rrule` + `timezone`, `status`, the text fields, a `data` JSON (reminders, attendees, organizer, `organizerEventId`, url, notes, colour), the exception link (`parentEventId` + `recurrenceDate`, a `YYYY-MM-DD` text key), the invitation link (`organizerEventId` + `organizerUserId` columns), `createByUserId`, `eventCtag`, and an `icsBlob` column that CALENDAR.md documents as never written and never read. Exceptions are separate rows with their own uri (`<uid>-exc-<date>.ics`). Deletes are hard, with `event_tombstones` as the only trace. `(calendarId, uri)` is the only unique key; `(calendarId, uid)` is a plain index. Calendar-level state is `calendars` (name, colour, default, visible, ctag, `shares` JSON) and `shared_calendars` (the recipient-side view of a share, with the owner's name and colour copied in). The whole container lives on the local filesystem under the Home directory (`home.getLocalDatabase`), never on a drive mount or S3, the same as `eigen.contacts`. See [CALENDAR.md](../CALENDAR.md) § Storage.

**Nearly every `Calendar` method is synchronous.** `bun:sqlite` is sync, so `createEvent`, `updateEvent`, `deleteEvent`, `moveEvent`, `rsvpForOccurrence`, the three `receiveInvitation*` methods, `removeInvitation`, `cancelInvitationOccurrence`, `receiveShare`, `removeShare`, the reads and most of the calendar CRUD return values directly. Only `init`, `destruct`, `updateCalendar` and `deleteCalendar` are async. Free/busy is not a method; the `/event-range` route redacts occurrences to `FreeBusyBlock` for a `free-busy` share. Callers outside the class: `routes/calendar.ts` (via `calendar/get-calendar.ts`), `caldav/caldav-router.ts`, `caldav/resource.ts` + `caldav/proppatch.ts`, `calendar/imip.ts`, `home/home-relay.ts` (the receiving end of every cross-home invitation and share message), `share/reconciliation.ts`, `calendar/share-propagation.ts` (`checkPermission`) and the demo seeder. `calendar/invite-propagation.ts` only sends relay messages and never touches the class.

**The CalDAV layer regenerates.** `caldav/resource.ts` `handleGet` calls `eventsToIcs(master + exceptions)` and serves the result; `handlePut` runs `parseIcs`, upserts the master via the public mutations and `syncExceptionEvents` reconciles override VEVENTs against exception rows with a full-replace prune, then re-reads the ETag. `ical-parse.ts` uses ical.js; `ical-serialize.ts` is hand-written (229 lines, plus the 174-line `vtimezone.ts` generator) and also hosts `serializeEventForImip`. Cancelled occurrences are emitted as `EXDATE` and parsed back to cancelled rows so Thunderbird's PUT does not resurrect them. A PUT is capped at `EVENT_MAX_BYTES` (20 MiB). There is no check that a UID is stored under one uri only. This is careful work that exists *because* the stored shape and the wire shape differ.

**The linked-copy discriminator is `data.organizer`.** `updateEvent` treats any row whose `data.organizer` is set as an attendee-side copy and discards every input except reminders and colour. `parseIcs` sets `data.organizer` from any `ORGANIZER` property, including the user's own address as Apple Calendar writes it on an event with invitees, so a client-created organizer-side event is locked against its own client's later PUTs. `findLinkedEvent` and the RSVP relay look linked copies up by the `organizerEventId` + `organizerUserId` columns, and `moveEvent` re-homes an event under the same id.

**Contacts already did this move.** `apps/api/src/lib/contacts/` (`card-store.ts`, `dav-store.ts`, `reconcile.ts`, `contacts.ts`) is the reference: one file per resource, `LocalFilesystem.writeAtomic` (temp → fsync → rename → directory fsync), a one-slot `Semaphore(1)` write lock per `Contacts` instance, `pending_card_writes` journal + in-memory `dirtyCards` set with the fail-closed `ensureDrained()` read gate, `commitCard` as the single index-write transaction, stat-only `reconcileIndex` on a healthy book at `init` and full `rebuildIndex` that rotates `syncGen`. The design rationale and the "honest contract" (what the index re-derives vs what it owns) are in [CONTACTS.md](../CONTACTS.md) and [PROPOSAL_CARDDAV.md](PROPOSAL_CARDDAV.md). The parts that are contact-specific (avatar cache, labels, the self card) are interleaved with the generic parts; nothing has been extracted yet.

## Alternatives considered

- **Write the raw bytes into the vestigial `icsBlob` column and treat that as the truth.** Cheapest route to round-trip fidelity: no file layout, no reconcile, no async ripple. Rejected because it leaves calendar as the one domain whose data is not on disk in a standard form, which is the actual goal, and because a BLOB-in-SQLite truth cannot be repaired, restored or inspected with anything but Eigen. It would also make the eventual move to files a second migration.
- **Files, but keep `Calendar` synchronous with `node:fs` sync writes.** Avoids touching every caller. Rejected: it blocks the event loop on fsync (a few ms on a busy disk, on every event write, inside the request path), it diverges from `LocalFilesystem.writeAtomic` and from contacts, and the async ripple is mechanical (the routes already `await resolveCalendar`).
- **Keep columns as truth and make the serializer lossless by storing an "unknown properties" JSON sidecar per event.** This is the same amount of parse/merge work with none of the file benefits, and every new property Eigen learns to model is a schema change. Rejected.
- **Clone `contacts/card-store.ts` into `calendar/` and adapt.** Fastest to build, and exactly the third-copy smell AGENTS.md names. Rejected in favour of a shared core (Design § 1), with contacts as the regression net for the extraction.
- **One file per calendar (a whole VCALENDAR with every VEVENT).** Matches how `.ics` exports look. Rejected: CalDAV resources are per UID, atomic replace of a growing file on every edit is O(calendar), and a torn write loses everything.
- **Deterministic ids derived from `(calendarId, uid[, recurrenceDate])` instead of storing the id in the file.** Saves one server-stamped property. Rejected: `moveEvent` re-homes an event under the same id, every attendee copy points at the organizer's id (`organizerEventId`, looked up by `findLinkedEvent` and the RSVP relay), and the FE carries ids in route params, so an id that changes on a move would orphan every link or force a cross-home fan-out per move. A derivation without the calendar id collides when the same UID sits in two calendars of one Home, which `(calendarId, uri)` allows today.

## Design

### 1 — Shared file+index core (Phase 0)

Extract the domain-neutral half of `contacts/card-store.ts` + `reconcile.ts` + the write-path scaffolding in `contacts.ts` into `apps/api/src/lib/core/indexed-file-store.ts`:

- `writeResourceFile(fs, path, bytes)`: temp → fsync → rename via `LocalFilesystem.writeAtomic`, temp-file cleanup at init (`cleanupTempCardFiles` generalised).
- `computeResourceEtag(bytes)`: SHA-256 hex, quoted at the DAV edge.
- The pending-write journal contract: a `pending_writes` table shape `{uri, key, recordedAt}` and the `record → write → commit(clears) / on failure markDirty` sequence, with the in-memory dirty set and `ensureDrained()` fail-closed read gate.
- The reconcile skeleton: `readdir` the resource directory, `stat` each entry, compare `(mtime, size)` with the index, hand changed and new entries to a domain `indexResource(uri, bytes)` callback and removed ones to a `dropResource(uri)` callback; the full rebuild that clears and re-indexes every file and rotates `syncGen`.
- `sanitizeCardUri` and `uriKeyOf` (case + NFC fold) generalised to take the required extension, so calendar passes `.ics` where contacts passes `.vcf`.

Contacts is refit onto the core in the same phase with zero behaviour change; the existing contacts and CardDAV suites gate it. The contact-specific pieces (labels, the avatar cache, the self card, quota) stay in `contacts/`. This phase lands on its own branch before any calendar work starts.

### 2 — Storage layout (Phase 1)

```
eigen.calendar/
  <calendarId>/<uri>          ← source of truth, one VCALENDAR per UID: master VEVENT + override VEVENTs + VTIMEZONEs
  calendar.db                 ← index over the files + calendar-level metadata
```

`<calendarId>` is the existing calendar id (client-chosen through MKCALENDAR, sanitised by `sanitizeCalendarId`, or a UUID). `<uri>` is the CalDAV resource name including its `.ics` suffix, client-chosen on PUT and `<uid>.ics` for Eigen-created events, sanitised the way card uris are. Overrides live inside the master's file, so the separate `<uid>-exc-<date>.ics` uris exception rows carry today go away. Team calendars use the same layout under `data/team/<teamId>/eigen.calendar/`. Deleting a calendar removes its directory after the index rows.

`calendar.db` (`db-config.ts`, one new version that drops the old tables and creates the new shape; existing rows are lost by decision):

| Table | Role |
|---|---|
| `calendars` | **Authoritative.** `id`, `name`, `color`, `isDefault`, `visible`, `ctag`, `syncGen`, `shares` JSON, timestamps. Unchanged in meaning; gains `syncGen`. |
| `shared_calendars` | **Authoritative.** The recipient-side share rows, unchanged. |
| `events` | **Derived.** One row per VEVENT in the files (master and each override): the same columns as today minus `icsBlob`, plus `mtime` + `size` for the stat reconcile, `fileUri` (the file this row came from; the master and its overrides share it) and `etag` (hash of the file bytes, identical on the master and its exception rows). Everything here re-derives from the files. |
| `event_tombstones` | **Authoritative.** `{uri, calendarId, deletedAtCtag}`, unchanged. Keyed by `(calendarId, uri)` so a re-created resource clears its own tombstone. |
| `pending_writes` | **Authoritative.** The crash-recovery journal from § 1. |

The honest contract, stated the way CONTACTS.md states it: a rebuild from the files alone reproduces every `events` row, every id, every etag and every occurrence. What it cannot reproduce is calendar names, colours, shares, the ctag and the tombstones, so a rebuild rotates `syncGen` and CalDAV clients resync in full.

### 3 — What lives in the file

Eigen writes RFC 5545 for everything it models and `X-EIGEN-*` for what it owns and iCalendar has no property for. All of it is inside the VEVENT, so one file is self-describing.

| Eigen field | In the file |
|---|---|
| `id` | `X-EIGEN-ID:<uuid>`, on the master and on every override. The random UUID Eigen mints today, minted for any VEVENT that arrives without one. |
| `title`, `description`, `location`, `startTime`/`endTime`/`allDay`, `rrule`, `timezone`, `status`, `sequence`, `uid` | `SUMMARY`, `DESCRIPTION`, `LOCATION`, `DTSTART`/`DTEND` (TZID form, `VALUE=DATE` for all-day), `RRULE`, the `TZID` parameter + generated `VTIMEZONE`, `STATUS`, `SEQUENCE`, `UID`. Same as `ical-serialize.ts` emits today. |
| exception link (`parentEventId` + `recurrenceDate`) | An override VEVENT in the same file with `RECURRENCE-ID` naming the original occurrence (the existing `computeOccurrenceTimes` rule); `parentEventId` is the master's `X-EIGEN-ID`. A cancelled occurrence is an `EXDATE` on the master, no override VEVENT, exactly as today. |
| `data.attendees[]` with status + role | `ATTENDEE;PARTSTAT=…;ROLE=…;CN=…:mailto:…` |
| `data.organizer` (attendee-side copies only) | `ORGANIZER;CN=…:mailto:…` plus `X-EIGEN-ORGANIZER-USER:<userId or external_…>` |
| `organizerEventId` + `organizerUserId` columns | `X-EIGEN-ORGANIZER-EVENT:<id>` and the same `X-EIGEN-ORGANIZER-USER`. |
| `data.reminders[]` | One `VALARM` each: `ACTION:DISPLAY` for `notification`, `ACTION:EMAIL` for `email`, `TRIGGER:-PT<minutes>M`. An `EMAIL` alarm Eigen writes also carries the `SUMMARY`, `DESCRIPTION` and `ATTENDEE` RFC 5545 § 3.6.6 requires. Client-written `VALARM`s with other shapes round-trip verbatim; the index projects `{type, minutes}` from them as `parseIcs` does today. |
| `data.url` | `URL` |
| `data.notes`, `data.color` | See Open questions; neither has a writer in the calendar app today. |
| `createByUserId` | `X-EIGEN-CREATED-BY:<userId>` |

**Server-owned properties are re-stamped on PUT.** A CalDAV client may not know or may strip `X-EIGEN-*`. On every PUT, after parsing the client's bytes, the store copies `X-EIGEN-ID`, `X-EIGEN-ORGANIZER-USER`, `X-EIGEN-ORGANIZER-EVENT` and `X-EIGEN-CREATED-BY` from the previously stored VEVENT with the same UID (and per override, the same `RECURRENCE-ID`) into the new component before writing; an override that has no stored twin gets a fresh `X-EIGEN-ID`, and a PUT that creates the resource gets one plus `X-EIGEN-CREATED-BY`. A client can therefore never turn a linked invitation into an ordinary event by accident, which is the property the current `updateEvent` guard protects. This is the one place the stored bytes differ from the PUT bytes, and the response ETag is the hash of what was stored.

**The linked-copy discriminator becomes the stamp, not `ORGANIZER`.** The index sets `data.organizer` and the two organizer columns only from `X-EIGEN-ORGANIZER-USER`, which Eigen stamps when it creates a linked copy (`receiveInvitation*`, inbound iMIP) and which a client PUT carrying an `ORGANIZER` that is not the Home's own address and no stamp also receives (as `external_<email>`, the iMIP convention). An `ORGANIZER` equal to the Home's own address is an organizer-side event and leaves the columns null. This replaces today's rule, under which any `ORGANIZER`, the user's own included, locks the row.

### 4 — Parse and serialize through ical.js, both ways

`ical-parse.ts` already parses with ical.js. The hand-written serializer is replaced by building or mutating an `ICAL.Component` and calling `toString()`, so that an Eigen-side edit of a client-created event changes only the properties it touches and leaves the rest as the client wrote them. `vtimezone.ts` stays; its output is inserted as a `VTIMEZONE` component. Line folding, escaping and parameter quoting become ical.js's problem instead of ours.

The index projection (`indexResource(uri, bytes)` from § 1) is `parseIcs` followed by the existing row mappers; `parseIcs` grows the `X-EIGEN-*` readers and drops nothing it does not need, because it no longer has to. The parse-time degradations (`isOutOfRangeRecurrenceStart`, `isSubDailyRrule`) keep applying to the projection only; the file keeps the client's bytes.

`serializeEventForImip` keeps its signature and produces the outbound iMIP body from the stored component with the `METHOD` set, so federation and CalDAV serve the same bytes.

The `caldav-roundtrip.test.ts` suite stays the gate for the parse side. A new fidelity test PUTs a VEVENT full of properties Eigen does not model (`ATTACH`, `CATEGORIES`, `X-APPLE-STRUCTURED-LOCATION`, an `AUDIO` `VALARM`, `RDATE`), edits the title through the REST route, and asserts the GET body still carries every one of them.

### 5 — The `Calendar` write path

Every mutation runs the § 1 sequence under a one-slot per-`Calendar` write lock (one `Semaphore(1)` per Home calendar service, the same scope contacts uses):

```
ensureDrained()                       fail-closed: re-index any dirty uri first
load stored component (if any)        the file for this uid, or a fresh VCALENDAR
mutate                                set the properties this mutation owns; re-stamp X-EIGEN-*
serialize                             ICAL.Component.toString() with VTIMEZONEs
recordPendingWrite(uri)               journal row
writeResourceFile                     temp → fsync → rename
commitEvent(uri, rows)                one transaction: replace the file's event rows, ctag bump, tombstone clear, pending clear
  on failure: markDirty(uri), rethrow
```

`commitEvent` is the single index-write seam. It replaces *all* rows whose `fileUri` matches (master plus overrides) with the freshly projected set, which is what makes "PUT is a full-resource replace" free: an override the client removed is simply not in the new projection. Cross-home writes (`receiveInvitation*`, `removeInvitation`, `rsvpForOccurrence` on the organizer's copy) are ordinary mutations on the *recipient's* `Calendar` and go through the same seam there. `moveEvent` is a file rename between calendar directories plus a row update inside one commit; ids do not change, and the source calendar gets a tombstone as today.

`deleteEvent` is: tombstone row + delete file + delete rows, in that order inside the lock, with the journal covering the window between file removal and commit.

Every public method becomes `async`. The callers (`routes/calendar.ts`, `calendar/get-calendar.ts`, `caldav/caldav-router.ts`, `caldav/resource.ts`, `caldav/proppatch.ts`, `calendar/imip.ts`, `home/home-relay.ts`, `share/reconciliation.ts`, `calendar/share-propagation.ts`, the demo seeder and the tests) gain an `await` each. This is mechanical and TypeScript finds every site (a missing `await` on a now-Promise return breaks the return type, and the "think about every `await`" rule in AGENTS.md applies to the fire-and-forget propagation paths, which keep their `.catch()`).

### 6 — Reads and ids

Reads never touch a file. `getEventsInRange`, `getEventsByUid`, `getEventsWithAttendee`, the free/busy redaction and recurrence expansion all run on the `events` index exactly as today; the only new read gate is `ensureDrained()` at the top of each public read, as in contacts. CalDAV GET is the one read that serves bytes, and it reads the file (the index only supplies the etag for the header).

**Ids stay random UUIDs and live in the file.** `X-EIGEN-ID` is the identity the index, the routes, the FE and every `organizerEventId` link use, so a rebuild reads the same ids back and nothing that holds one goes stale. A rebuild that meets an id already claimed by another file in the same Home (a hand-copied file) treats the second file as a copy: it mints a fresh id, rewrites the file and logs it.

**One file per `(calendarId, uid)`.** The index keeps the `(calendarId, uri)` unique key and adds a unique `(calendarId, uid)` over master rows; a PUT whose UID is already stored under a different uri in the same calendar is a 409, the check `carddav/resource.ts` already makes for vCard UIDs and CalDAV lacks today (today it silently creates a second row).

### 7 — CalDAV surface after the move

`caldav/resource.ts` shrinks to what `carddav/` looks like: `handleGet` reads the file and serves it verbatim with the quoted hash ETag; `handlePut` validates the payload (`parseIcs` must succeed, exactly one UID, the existing `EVENT_MAX_BYTES` and uri-length caps), checks `If-Match`/`If-None-Match` against the stored hash, re-stamps server-owned properties, and calls one `Calendar.putResource(calendarId, uri, bytes)` that runs the § 5 sequence; `handleDelete` maps to `deleteEvent`. `syncExceptionEvents` and the ETag re-read are deleted. `report.ts` (`calendar-multiget`, `calendar-query`, `sync-collection`) reads the index as today; the sync token gains the `syncGen` prefix the CardDAV twin uses (`urn:eigen:sync:<gen>-<ctag>` instead of `urn:eigen:sync:<ctag>`) so a rebuilt calendar forces the RFC 6578 recovery.

Invitation fan-out on a CalDAV PUT keeps its current trigger: after `putResource` projects the rows, the same attendee diff that `createEvent`/`updateEvent` run today decides what to propagate.

### 8 — Reconcile and rebuild

`Calendar.init` runs the § 1 reconcile per calendar directory: stat-only against `events.mtime/size`, re-indexing only changed files, dropping rows whose file is gone, and the full rebuild (rehash every file, drop tombstones, bump ctag, rotate `syncGen`) when the `calendars` row for a directory is missing or on demand. There are no fs-watchers, for the same reason contacts has none: nothing writes these files out of process. A user who edits a file by hand sees it on the next open.

### 9 — What stays out of the file, deliberately

Calendar name, colour, default flag, visibility, the share list and the recipient-side `shared_calendars` rows are calendar-level, not event-level, and stay in `calendar.db`. iCalendar has `X-WR-CALNAME`/`X-APPLE-CALENDAR-COLOR` conventions for exports, but writing them into every event file would put one fact in N places. The calendar-level facts are small and few, and the ones that matter to another Home (name, colour, permission) already travel to the recipient's `shared_calendars` row through `propagateCalendarShare`; they are not worth a second file format.

## Performance invariants

- **Range and occurrence reads are index-only.** Zero file reads on any REST GET, `calendar-query`, `sync-collection` or free/busy.
- **One write is one file plus one transaction.** A mutation touches exactly the file for its UID and the rows of that file. A calendar with 10k events costs the same per edit as one with 10.
- **Reconcile on open is stat-only.** One `readdir` per calendar directory, one `stat` per file and an `(mtime, size)` compare; no parse unless a file changed. A cold open of a 10k-event calendar is 10k stats and one indexed query, the same shape contacts has.
- **The write lock is per `Calendar`, not global.** Two Homes never wait on each other; a fan-out to 26 attendees takes 26 independent locks.
- **Files are small.** A VEVENT with a dozen overrides and two VTIMEZONEs is a few KB; the existing `EVENT_MAX_BYTES` cap (20 MiB) stays on PUT and is never approached (a real recurring series with hundreds of overrides is well under 200 KB).

## Phased rollout

| Phase | Scope | Gate |
|---|---|---|
| 0 | Extract `core/indexed-file-store.ts` from contacts; refit contacts onto it. No calendar changes. | Contacts + CardDAV suites green, byte-identical vCard behaviour, `CONTACTS.md` pointer updated. Own branch, merged before phase 1 starts. |
| 1 | Storage relayout: new `calendar.db` version, `<calendarId>/<uri>` files, ical.js serializer, `X-EIGEN-*` mapping, `Calendar` write seam + async ripple, reconcile/rebuild. CalDAV still regenerates through the parsed rows (the file is written, the DAV layer does not yet serve it). | `test/calendar/{calendar,calendar-invites,calendar-timezone,team-calendar-share}.test.ts` and `test/caldav/ical-imip.test.ts` green against the new store; a new `test/calendar/calendar-store.test.ts` covering torn-write recovery, reconcile-on-open, rebuild + `syncGen` rotation and id preservation across rebuild and move. |
| 2 | CalDAV serves and stores bytes: verbatim GET, hash ETag, `putResource`, re-stamp on PUT, `syncGen` sync tokens, the UID-under-one-uri 409, `resource.ts` simplification. | `test/caldav/{caldav,caldav-roundtrip,caldav-client-sync}.test.ts` green; the new fidelity test from § 4. |
| 3 | Real-client verification against the local Docker edge ([docker/LOCAL-TESTING.md](../../docker/LOCAL-TESTING.md) § Testing CalDAV): macOS/iOS Calendar, Thunderbird, DAVx⁵. Create, edit, delete an occurrence, undo-delete, RSVP, a client-side alarm, a moved series, and an organizer-side event with invitees created from the client (the § 3 discriminator change). | A written matrix in the branch report with the observed round-trip bytes for each client. Docs pass: `CALENDAR.md` § Storage and § CalDAV rewritten to present tense, `STORAGE.md` layout tree, the AGENTS.md storage row, the ROADMAP row. |

Phases are sequential. Phase 1 is the large one (the `Calendar` class is 1.6k lines and every mutation moves onto the seam); phases 0 and 2 are each a few days; phase 3 is a day plus whatever the clients turn up. Total is on the order of two weeks of agent time, about twice the contacts move, because of the extra writers and the exception model.

## Verification gate

Before the branch is called done:

- `bun run check` green, including the new store and fidelity tests.
- A PUT/edit/GET fidelity probe with a kitchen-sink VEVENT (every property in § 4's list) shows byte-for-byte preservation of everything Eigen does not model, and a PUT with a sub-daily `RRULE` reads back as the client wrote it while the index still holds one occurrence.
- Kill the API between the file rename and the index commit (an `EIGEN_STORAGE_FAULT`-style dev hook, see `storage/fault-storage.ts`) and confirm the next open re-indexes the file, serves it, and the ETag matches the bytes.
- `rm calendar.db`, restart, confirm every event, exception and occurrence is back under its old id, and that a connected CalDAV client resyncs in full rather than ghosting deletions.
- An organizer edit on a linked-invitation event PUT by a client that stripped `X-EIGEN-*` still propagates, and the linked copy still refuses attendee-side edits of organizer fields.
- Each phase's review runs under the Review Standard in [WORKING-METHOD.md](../WORKING-METHOD.md).

## Risks and caveats

- **eigen.is is live.** The version bump empties every user's calendar on deploy. Pick the moment and announce it; the decision to drop the data is made, the timing is not.
- **The async ripple is wide but shallow.** Every `Calendar` call site changes. TypeScript catches them all; the risk is a fire-and-forget path that used to be sync and silently becomes an unawaited Promise. The propagation modules already run fire-and-forget with `.catch()`; the review checks every new `await`.
- **Clients that rewrite the whole VEVENT.** Apple and Thunderbird preserve unknown properties; some clients (older Outlook connectors, some Android apps) re-emit only what they know. The re-stamp rule in § 3 protects Eigen-owned state; anything else a client drops is that client's behaviour, and today it is dropped by us regardless.
- **The id lives in the file.** `X-EIGEN-ID` is the only identity, so the re-stamp rule is load-bearing: a PUT that reaches the store without it would mint a new id and orphan every link. The re-stamp runs inside `putResource`, not in the DAV handler, so no second writer can skip it.
- **The discriminator change is a behaviour change.** Today any `ORGANIZER` locks a row; after § 3 only a stamped or foreign one does. That fixes client-created organizer-side events and is what phase 3 tests first, because it is the path Apple Calendar takes for every event with invitees.
- **Two truths during phase 1.** Between phases 1 and 2 the file is written but CalDAV still serves regenerated bytes. This is fine (the regenerate path is what runs today) but the phase-1 review must confirm the file and the projection agree, which is what the reconcile test proves.
- **Feed subscriptions land after this.** [PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md) was written against the row model (`applyFeedSnapshot` with `(uid, recurrenceDate)` identity). It needs a short rewrite to "write files, index them" once phase 1 has merged; the bulk-transaction requirement becomes "one lock acquisition, N files, one commit".
- **Calendar search** ([SEARCH.md](../SEARCH.md) § Remaining) is unaffected: an `events_fts` table over the index is derived data and rebuilds with it.

## Recommendation

1. **Build it, but not next.** The fidelity loss is a real bug for CalDAV users (alarms, attachments, categories, URLs and every `X-` property are dropped, and degraded recurrence rules are written back), and files-as-truth is the storage story every other domain already tells. Neither is urgent enough on its own to jump the queue.
2. **Fix the `ORGANIZER` lock now, standalone.** `parseIcs` sets `data.organizer` from any `ORGANIZER`, the user's own address included, so a client-created event with invitees is locked by the `updateEvent` guard against its own client's later edits. That is a one-module fix with a test and does not wait for this proposal.
3. **Do phase 0 on its own merits.** The contacts extraction is a refactor with a regression net and no calendar dependency; it can land on any quiet day.
4. **Run phases 1 to 3 before calendar import, not after.** [PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md) is written against the row model; building it first and then moving to files means writing the feed store twice.
5. **If the two weeks are not available, `icsBlob` as truth is the honest fallback.** It needs the same ical.js serializer, merge-on-edit and re-stamp rule, but skips the store extraction, the async ripple, reconcile and the journal, and gets most of the fidelity win for roughly half the effort. It gives up the files-on-disk principle, which is the reason this proposal rejects it.

## Decisions (2026-09-03)

Reinder's rulings:

- **No backward compatibility.** Existing calendar data is dropped by a `calendar.db` version bump that recreates the schema. No migration, no export, no dual read.

Design decisions of this proposal (revised on review the same day):

- **Files, not `icsBlob`.** The vestigial column is removed rather than revived.
- **One file per UID**, master plus overrides plus VTIMEZONEs, under `eigen.calendar/<calendarId>/<uri>`.
- **Eigen-owned per-event state rides in the file** as `X-EIGEN-*` and is re-stamped on PUT; calendar-level state stays in the index.
- **Ids stay random UUIDs**, stored as `X-EIGEN-ID` and read back on rebuild. A derived id was considered and rejected (see Alternatives).
- **The linked-copy discriminator is the `X-EIGEN-ORGANIZER-USER` stamp**, never a bare `ORGANIZER`.
- **Extract the file+index core from contacts first** (phase 0) rather than clone it.
- **`Calendar` goes async.**

## Open questions

- **`data.notes` and `data.color`.** Neither has a writer in the calendar app; `notes` has no reader either, `color` has one (`getCalendarColor` falls through to the calendar colour). Proposal: drop both from `EventData` in phase 1 rather than invent `X-EIGEN-*` homes for dead fields. If notes come back, RFC 5545 `COMMENT` is the property; if per-event colour comes back, `X-EIGEN-COLOR`, since RFC 7986 `COLOR` takes a CSS3 colour name and Eigen stores hex.
- **What the index does with client `VALARM`s.** Nothing in Eigen fires alarms today (no scheduler job, the calendar app does not read `reminders`), so the projection is bookkeeping. Proposal: keep the current `{type, minutes}` projection for `DISPLAY`/`EMAIL` alarms with a `-PT<n>M` trigger and ignore the rest; revisit when something consumes it.
- **A per-calendar metadata file.** Writing name, colour and shares to `<calendarId>/calendar.json` would make the rebuild total and the honest contract trivial. Proposal: no, match contacts (labels and the book row stay in the index there too) and keep one pattern; revisit if a lost `calendar.db` ever happens in practice.
