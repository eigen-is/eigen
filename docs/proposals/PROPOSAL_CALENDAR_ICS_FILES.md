# Proposal: Calendar events as `.ics` files, `calendar.db` as the index

> **TLDR**: Calendar's event content lives in SQLite columns. Mail is a Maildir plus `mail.db`, contacts are `cards/*.vcf` plus `contacts.db`, but calendar is `calendar.db` and nothing else, with a vestigial `icsBlob` column that was never wired up. This proposal moves calendar onto the same model: **one `.ics` file per UID under `eigen.calendar/<calendarId>/`, the file is the source of truth, and `calendar.db` becomes an index** plus authoritative metadata (calendar rows, shares, tombstones, sync generation, recovery journal). CalDAV GET returns the stored file bytes and the ETag hashes those bytes. PUT re-stamping and Eigen edits may reserialize the component: preserving unmodeled properties is a semantic fidelity goal, not byte-for-byte preservation of the client's input. Every Eigen-side mutation goes load file → mutate the ical.js component → serialize → atomic write → index, under a per-Home write lock. Per-event state Eigen owns (the event id, the invitation link, the creator) rides in the file as server-stamped `X-EIGEN-*` properties; complete rebuildability still needs the recurrence and recovery decisions in the audit below. **No backward compatibility** (decided 2026-09-03): existing calendar data is dropped, not migrated; a `calendar.db` version bump recreates the schema empty and every calendar starts fresh. The proposed shared file+index mechanics come out of `contacts/` into a core module both domains use. The async conversion reaches routes, the home relay, iMIP and share propagation. The original two-week estimate is provisional, not an evidence-backed commitment.

**Review status (2026-09-06): worthwhile direction, not implementation-ready.** Small factual corrections are applied below; unresolved design choices are recorded in [Audit findings](#audit-findings-2026-09-06). No implementation is included.

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

- **Write the raw bytes into the vestigial `icsBlob` column and treat that as the truth.** Cheapest route to round-trip fidelity: no file layout, no reconcile, no async ripple. SQLite tools could inspect and export the stored ICS without Eigen, but it would not be independently accessible as standard files, which is this proposal's additional goal. It would also make an eventual move to files a second storage change.
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
- The pending-write journal contract: calendar entries, dirty keys and all commit/drop predicates are scoped by `(calendarId, canonicalUri)`, not URI alone; two calendars may contain the same resource name. The `record → write → commit(clears) / on failure markDirty` sequence covers single-resource replacement. Move and collection-delete recovery need additional intent, specified before implementation.
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

**Server-owned properties are re-stamped on PUT.** A CalDAV client may not know or may strip `X-EIGEN-*`. Incoming server-owned values are not trusted, including on resource creation: discard them before copying trusted `X-EIGEN-ID`, `X-EIGEN-ORGANIZER-USER`, `X-EIGEN-ORGANIZER-EVENT` and `X-EIGEN-CREATED-BY` from the stored VEVENT with the same UID (and per override, the same `RECURRENCE-ID`), or issuing new server-owned values. Re-stamping preserves identity; it does not replace the attendee-side field restrictions enforced by `updateEvent`. Serialization can also change folding, casing and quoting. If the stored representation differs from the PUT body, omit validators from the successful PUT response; the client retrieves the stored representation and its hash ETag afterward ([RFC 9110 § 9.3.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.4), [RFC 4791 § 5.3.4](https://www.rfc-editor.org/rfc/rfc4791.html#section-5.3.4)).

**The linked-copy discriminator becomes the stamp, not `ORGANIZER`.** The index sets `data.organizer` and the two organizer columns only from `X-EIGEN-ORGANIZER-USER`, which Eigen stamps when it creates a linked copy (`receiveInvitation*`, inbound iMIP) and which a client PUT carrying an `ORGANIZER` that is not the Home's own address and no stamp also receives (as `external_<email>`, the iMIP convention). An `ORGANIZER` equal to the Home's own address is an organizer-side event and leaves the columns null. This replaces today's rule, under which any `ORGANIZER`, the user's own included, locks the row.

### 4 — Parse and serialize through ical.js, both ways

`ical-parse.ts` already parses with ical.js. The hand-written serializer is replaced by building or mutating an `ICAL.Component` and calling `toString()`, so that an Eigen-side edit of a client-created event changes only the properties it touches and leaves the rest as the client wrote them. `vtimezone.ts` stays; its output is inserted as a `VTIMEZONE` component. Line folding, escaping and parameter quoting become ical.js's problem instead of ours.

The index projection (`indexResource(uri, bytes)` from § 1) is `parseIcs` followed by the existing row mappers; `parseIcs` grows the `X-EIGEN-*` readers and drops nothing it does not need, because it no longer has to. The parse-time degradations (`isOutOfRangeRecurrenceStart`, `isSubDailyRrule`) keep applying to the projection only; the file keeps the client's bytes.

`serializeEventForImip` currently accepts only a projected `CalendarEvent`, not a stored component. Preserving stored properties through iMIP requires an explicit component/snapshot input through its callers and the inbound invitation paths. Scheduling messages are not the CalDAV resource with only `METHOD` added: REQUEST, REPLY and CANCEL need their existing organizer, attendee and occurrence scoping, and must not export local identity/link stamps as the recipient's own state. See the audit before changing this seam.

The `caldav-roundtrip.test.ts` suite stays the gate for the parse side. A new fidelity test PUTs a VEVENT full of properties Eigen does not model (`ATTACH`, `CATEGORIES`, `X-APPLE-STRUCTURED-LOCATION`, an `AUDIO` `VALARM`, `RDATE`), edits the title through the REST route, and asserts the GET body still carries every one of them.

### 5 — The `Calendar` write path

Every mutation runs the § 1 sequence under a one-slot per-`Calendar` write lock (one `Semaphore(1)` per Home calendar service, the same scope contacts uses):

```
drainDirty()                         already inside the lock; do not reacquire it through ensureDrained()
load stored component (if any)        the file for this uid, or a fresh VCALENDAR
mutate                                set the properties this mutation owns; re-stamp X-EIGEN-*
serialize                             ICAL.Component.toString() with VTIMEZONEs
recordPendingWrite(uri)               journal row
writeResourceFile                     temp → fsync → rename
commitEvent(calendarId, uri, rows)    one transaction: replace this resource's rows, ctag bump, tombstone clear, pending clear
  on failure: markDirty(uri), rethrow
```

`commitEvent` is the single index-write seam. It replaces *all* rows whose `(calendarId, fileUri)` matches (master plus overrides and synthesized exclusions) with the freshly projected set: an override the client removed is absent from the new projection. Cross-home writes (`receiveInvitation*`, `removeInvitation`, `rsvpForOccurrence` on the organizer's copy) are ordinary mutations on the *recipient's* `Calendar` and go through the same seam there. `moveEvent` must preserve ids and create a source tombstone, but a file rename and SQLite commit are not one atomic operation; its recovery contract remains open.

`deleteEvent` is: tombstone row + delete file + delete rows, in that order inside the lock, with the journal covering the window between file removal and commit.

Every public method becomes `async`. The callers (`routes/calendar.ts`, `calendar/get-calendar.ts`, `caldav/caldav-router.ts`, `caldav/resource.ts`, `caldav/proppatch.ts`, `calendar/imip.ts`, `home/home-relay.ts`, `share/reconciliation.ts`, `calendar/share-propagation.ts`, the demo seeder and the tests) need an await/return audit. TypeScript catches many value-use errors, but not every ignored Promise or async callback passed to a void-returning API. Internal calls also need a non-reentrant lock boundary; propagation retains explicit failure handling and runs after the local commit and lock release.

### 6 — Reads and ids

Healthy REST reads remain index-only: `getEventsInRange`, `getEventsByUid`, `getEventsWithAttendee`, free/busy redaction and recurrence expansion use `events`. Recovery through `ensureDrained()` can read files. CalDAV GET and every REPORT requesting `calendar-data` must read the stored resource, not regenerate it from rows; metadata-only REPORTs remain index-only. A resource read must return bytes and ETag from the same committed revision, including when a write is in flight.

**Ids stay random UUIDs and live in the file.** `X-EIGEN-ID` is the identity the index, the routes, the FE and every `organizerEventId` link use, so a rebuild reads the same ids back and nothing that holds one goes stale. A rebuild that meets an id already claimed by another file in the same Home (a hand-copied file) treats the second file as a copy: it mints a fresh id, rewrites the file and logs it.

**One file per `(calendarId, uid)`.** The index keeps the `(calendarId, uri)` unique key and adds a unique `(calendarId, uid)` over master rows; a PUT whose UID is already stored under a different uri in the same calendar is a 409, the check `carddav/resource.ts` already makes for vCard UIDs and CalDAV lacks today (today it silently creates a second row).

### 7 — CalDAV surface after the move

`caldav/resource.ts` becomes a thin protocol adapter. GET serves the stored bytes and quoted hash ETag. PUT bounds and validates the resource, then passes the bytes, actor and conditional headers to `Calendar.putResource`; DELETE passes its preconditions to the store too. The store checks `If-Match`/`If-None-Match`, URI/UID conflicts and linked-copy edit restrictions, and re-stamps server-owned properties **inside the write lock**, against the revision it will replace. Handler-side checks would race once file writes introduce awaits. A transformed PUT omits response validators as described in § 3. `syncExceptionEvents` is replaced by one resource-level projection commit. `report.ts` selects resources from the index but reads files whenever `calendar-data` is requested. The sync token gains a generation component (`urn:eigen:sync:<gen>-<ctag>`); its survival and invalidation contract is an audit blocker, not just a formatting change.

CalDAV scheduling behaviour needs an explicit decision. Today `handlePut` passes `userId` as creator metadata but does not pass the optional `user` argument to `createEvent`/`updateEvent`, so those calls do not trigger their invitation fan-out. Adding it in `putResource` would be a behaviour change, not preservation of an existing trigger.

### 8 — Reconcile and rebuild

`Calendar.init` runs the § 1 reconcile per calendar directory: stat-only against `events.mtime/size`, re-indexing only changed files, dropping rows whose file is gone, and the full rebuild (rehash every file, drop tombstones, bump ctag, rotate `syncGen`) when the `calendars` row for a directory is missing or on demand. There are no fs-watchers, for the same reason contacts has none: nothing writes these files out of process. A user who edits a file by hand sees it on the next open.

### 9 — What stays out of the file, deliberately

Calendar name, colour, default flag, visibility, the share list and the recipient-side `shared_calendars` rows are calendar-level, not event-level, and stay in `calendar.db`. iCalendar has `X-WR-CALNAME`/`X-APPLE-CALENDAR-COLOR` conventions for exports, but writing them into every event file would put one fact in N places. The calendar-level facts are small and few, and the ones that matter to another Home (name, colour, permission) already travel to the recipient's `shared_calendars` row through `propagateCalendarShare`; they are not worth a second file format.

## Performance invariants

- **Healthy range and occurrence reads are index-only.** REST range/free-busy reads and metadata-only REPORTs avoid file reads; recovery and REPORTs requesting `calendar-data` do not.
- **One write is one file plus one transaction.** A mutation touches exactly the file for its UID and the rows of that file. A calendar with 10k events costs the same per edit as one with 10.
- **Reconcile on open is stat-only.** One `readdir` per calendar directory, one `stat` per file and an `(mtime, size)` compare; no parse unless a file changed. A cold open of a 10k-event calendar is 10k stats and one indexed query, the same shape contacts has.
- **The write lock is per `Calendar`, not global.** Two Homes never wait on each other; a fan-out to 26 attendees takes 26 independent locks.
- **Typical files are small, not guaranteed small.** Preserved inline `ATTACH` data and large exception sets can approach the 20 MiB PUT limit. Bound serialized stored size and projection work on every ingress/write path, including iMIP and reconciliation; enforce limits before journaling or filesystem mutation. Budget total storage and REPORT output separately from the per-resource limit.

## Phased rollout

| Phase | Scope | Gate |
|---|---|---|
| 0 | Extract `core/indexed-file-store.ts` from contacts; refit contacts onto it. No calendar changes. | Contacts + CardDAV suites green, byte-identical vCard behaviour, `CONTACTS.md` pointer updated. Own branch, merged before phase 1 starts. |
| 1 | Storage relayout: new `calendar.db` version, `<calendarId>/<uri>` files, ical.js serializer, `X-EIGEN-*` mapping, `Calendar` write seam + async ripple, reconcile/rebuild. CalDAV still regenerates through the parsed rows (the file is written, the DAV layer does not yet serve it). | `test/calendar/{calendar,calendar-invites,calendar-timezone,team-calendar-share}.test.ts` and `test/caldav/ical-imip.test.ts` green against the new store; a new `test/calendar/calendar-store.test.ts` covering torn-write recovery, reconcile-on-open, rebuild + `syncGen` rotation and id preservation across rebuild and move. |
| 2 | CalDAV serves and stores bytes: verbatim GET, hash ETag, `putResource`, re-stamp on PUT, `syncGen` sync tokens, the UID-under-one-uri 409, `resource.ts` simplification. | `test/caldav/{caldav,caldav-roundtrip,caldav-client-sync}.test.ts` green; the new fidelity test from § 4. |
| 3 | Real-client verification against the local Docker edge ([docker/LOCAL-TESTING.md](../../docker/LOCAL-TESTING.md) § Testing CalDAV): macOS/iOS Calendar, Thunderbird, DAVx⁵. Create, edit, delete an occurrence, undo-delete, RSVP, a client-side alarm, a moved series, and an organizer-side event with invitees created from the client (the § 3 discriminator change). | A written matrix in the branch report with the observed round-trip bytes for each client. Docs pass: `CALENDAR.md` § Storage and § CalDAV rewritten to present tense, `STORAGE.md` layout tree, the AGENTS.md storage row, the ROADMAP row. |

Phases are sequential. The original estimate was roughly two weeks of agent time, but the audit exposes missing recovery, recurrence-state and scheduling work. Re-estimate after those contracts and the deployment boundary are agreed; neither the shared extraction nor real-client verification has a justified fixed duration yet.

## Verification gate

Before the branch is called done:

- `bun run check` green, including the new store and fidelity tests.
- A PUT/edit/GET fidelity probe with a kitchen-sink VEVENT (every property in § 4's list) shows semantic preservation of unedited properties, parameters and subcomponents. GET bytes equal the stored file and match its ETag; REPORT `calendar-data` carries the same resource. Repeat through the real edit dialog, not only a title-only REST request. A sub-daily `RRULE` survives in the resource while the index still holds one occurrence.
- Kill the API between the file rename and the index commit (an `EIGEN_STORAGE_FAULT`-style dev hook, see `storage/fault-storage.ts`) and confirm the next open re-indexes the file, serves it, and the ETag matches the bytes.
- `rm calendar.db`, restart, confirm every event, exception and occurrence is back under its old id, and that a connected CalDAV client resyncs in full rather than ghosting deletions.
- An organizer edit on a linked-invitation event PUT by a client that stripped `X-EIGEN-*` still propagates, and the linked copy still refuses attendee-side edits of organizer fields.
- Each phase's review runs under the Review Standard in [WORKING-METHOD.md](../WORKING-METHOD.md).

## Risks and caveats

- **eigen.is is live.** The version bump empties every user's calendar on deploy. Pick the moment and announce it; the decision to drop the data is made, the timing is not.
- **The async ripple changes ordering as well as types.** Review ignored Promises, nested public calls, read/write snapshots and propagation after commit; TypeScript alone cannot prove these safe.
- **Clients that rewrite the whole VEVENT.** Apple and Thunderbird preserve unknown properties; some clients (older Outlook connectors, some Android apps) re-emit only what they know. The re-stamp rule in § 3 protects Eigen-owned state; anything else a client drops is that client's behaviour, and today it is dropped by us regardless.
- **The id lives in the file.** `X-EIGEN-ID` is the only identity, so the re-stamp rule is load-bearing: a PUT that reaches the store without it would mint a new id and orphan every link. The re-stamp runs inside `putResource`, not in the DAV handler, so no second writer can skip it.
- **The discriminator change is a behaviour change.** Today any `ORGANIZER` locks a row; after § 3 only a stamped or foreign one does. That fixes client-created organizer-side events and is what phase 3 tests first, because it is the path Apple Calendar takes for every event with invitees.
- **Phase 1 does not meet the final fidelity contract.** CalDAV still serves a regenerated representation rather than the stored bytes. A file hash is a valid strong validator only if every change to that served representation also changes the validator; regeneration and index-only bookkeeping must not undermine that relationship. Prefer deploying storage and DAV read cutover together; an independently deployed intermediate phase needs its own representation/validator contract and transformed-PUT handling before the destructive schema change ships.
- **Feed snapshots need their own commit contract.** [PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md) was written against one row transaction. One lock acquisition, N file writes and one SQLite commit do not make an atomic snapshot across a crash. Do not treat the later adaptation as a mechanical rewrite.
- **Calendar search** ([SEARCH.md](../SEARCH.md) § Remaining) is unaffected: an `events_fts` table over the index is derived data and rebuilds with it.

## Audit findings (2026-09-06)

The storage direction is useful, but the following are unresolved design blockers, not implementation details already covered by contacts. The corrections above address protocol/read-path facts; they do not settle these choices.

| Area | Finding and required decision |
|---|---|
| **Rebuild fidelity** | An `EXDATE` carries neither an exception's random id nor its `SEQUENCE`, attendee state, creator or timestamps. Today `removeOccurrence` preserves an existing exception's state and `cancelInvitationOccurrence` compares its sequence (`calendar/calendar.ts:1304-1310,1454-1487`). Turning it into EXDATE alone loses that state on the next projection, even before a rebuild. Specify durable per-exclusion state while retaining client-compatible EXDATE behaviour, and its survival when clients strip server properties. Also map event timestamps explicitly and classify `eventCtag` as regenerated sync bookkeeping, not a file-derived fact. The current "every row and id" claim is not yet met. |
| **Resource identity** | Resource uniqueness must not depend on having a master row: [RFC 4791 § 4.1](https://www.rfc-editor.org/rfc/rfc4791.html#section-4.1) allows override-only resources. Define resource identity separately from projected event-row identity, how the existing required `uri` field works after exception URIs disappear, and UID immutability on replacement. Duplicate UIDs need the `CALDAV:no-uid-conflict` precondition response with the conflicting href, not an unexplained bare 409. Never use an external iMIP UID directly as a filename; retain the UID in content and choose a safe resource name. |
| **Move/delete recovery** | Deleting calendar rows before its directory (§ 2) conflicts with rebuilding directories that lack rows (§ 8): a crash in between resurrects the deleted calendar. A move also needs source/destination intent so recovery does not misclassify the moved id as a copied file. Specify recoverable ordering for both and distinguish whole-resource deletion from deleting one exception. Atomic replacement already fsyncs, but `LocalFilesystem.rename`/`unlink` do not fsync directories; process-kill recovery alone does not establish power-loss durability. |
| **Database-loss recovery** | Incrementing a generation held only in a lost DB cannot guarantee a new generation. Contacts seeds a fresh book with `syncGen = 1` (`contacts/db-config.ts`) and its rebuild fallback can reuse `2` (`contacts/reconcile.ts`); copying that recipe does not meet the proposed `rm calendar.db` gate. Require a non-reused generation after history loss and define recovery of calendar directories with missing metadata, including default selection and sharing. Backups must include the authoritative DB and recovery journals, not only ICS files. |
| **Editing a lossy projection** | The real edit dialog submits times, timezone, `rrule` and all projected `data` even when only the title changed (`apps/calendar/src/components/edit-event-dialog.tsx:151-166`). Mutating every submitted field would erase a preserved sub-daily rule projected as null, rebuild rich alarms from simplified reminders, and discard attendee parameters. Define semantic change detection and property/parameter-level updates against the stored component. Also decide how CalDAV time-range selection avoids false negatives for preserved but unindexed recurrence: `getRawEventsInRange` currently selects only projected occurrences. A title-only REST probe does not establish ordinary UI fidelity. |
| **Invitation boundaries** | The current inbound iMIP and Home relay payloads carry projected fields, so switching only the serializer cannot preserve unknown content end-to-end (`calendar/imip.ts:185-281`, `calendar/invite-propagation.ts:41-63,108-125`). Define the snapshot transport and method-specific output, local-stamp handling, and post-commit side effects. A foreign `ORGANIZER` is not sufficient to infer an external linked copy: another Eigen user or a team/shared-calendar organizer needs different identity handling, and the proposed rule does not supply `organizerEventId` for RSVP lookup. Keep identity classification distinct from permission to edit organizer fields. |
| **Shared-core contract** | Contacts is a useful reference, not a proof of the proposed stronger guarantees. Its startup recovery logs a failed dirty card and removes it from the in-memory dirty set while retaining the journal (`contacts/contacts.ts:412-423`); its resource read obtains the row before an unlocked async file read (`contacts/dav-store.ts:76-85`). A zero-behaviour-change extraction cannot simultaneously fix those contracts. Define calendar's recovery failure policy and coherent read boundary explicitly. Atomic writes already live in core, and mail's reconciliation is materially different; the broad journal/rebuild abstraction is not justified merely by counting three domains. |

Code references in this table are relative to `apps/api/src/lib/` unless explicitly rooted at `apps/`. These findings leave the recorded no-migration decision intact. Production cutover still needs a maintenance window, a recoverable pre-deploy backup and a coherent rollback boundary; this does not require implementing a legacy reader or export feature.

## Recommendation

1. **Yes to the direction; no to implementing the current draft unchanged.** CalDAV fidelity loss is real, and independent standard files are a useful self-hosting benefit. Resolve the audit blockers before committing to the storage rewrite; architectural symmetry alone is not enough to justify its recovery complexity.
2. **Fix the `ORGANIZER` lock separately.** This is a focused behaviour bug, not a reason to wait for new storage. Do not simply remove organizer parsing globally: iMIP and attendee-side protections depend on it, and identity must be resolved in context.
3. **Narrow phase 0 rather than making a broad framework a prerequisite.** Reuse existing atomic-write and DAV primitives. Extract additional orchestration only where the calendar design demonstrates the same contract; contacts-specific policies stay in contacts.
4. **If this storage move is approved, settle it before implementing the feed store.** That avoids writing the persistence path twice, but does not make feed refresh a trivial N-file transaction or require all import work to wait indefinitely.
5. **If fidelity is the immediate priority, raw ICS in SQLite is a legitimate smaller alternative.** It still needs correct component editing and protocol semantics, but avoids dual-store recovery. Choose files for independent file access and recovery value, not because fidelity requires them. The relative effort is not yet measured.

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

- **`data.notes` and `data.color`.** They remain public `EventData` fields, and linked-copy edits explicitly preserve colour; no calendar-app writer does not prove no API consumer. Dropping them would conflict with the unchanged-REST/types non-goal. Decide their file mapping before implementation, or approve removal separately. RFC 5545 `COMMENT` is a candidate for notes; RFC 7986 `COLOR` uses CSS3 colour names rather than Eigen's hex values.
- **What the index does with client `VALARM`s.** Nothing in Eigen fires alarms today (no scheduler job, the calendar app does not read `reminders`), so the projection is bookkeeping. Proposal: keep the current `{type, minutes}` projection for `DISPLAY`/`EMAIL` alarms with a `-PT<n>M` trigger and ignore the rest; revisit when something consumes it.
- **A per-calendar metadata file.** Writing name, colour and shares to `<calendarId>/calendar.json` would make the rebuild total and the honest contract trivial. Proposal: no, match contacts (labels and the book row stay in the index there too) and keep one pattern; revisit if a lost `calendar.db` ever happens in practice.
