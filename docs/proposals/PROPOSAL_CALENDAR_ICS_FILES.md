# Proposal: Calendar events as `.ics` files, `calendar.db` as the index

> **TLDR**: Calendar is the last Eigen domain whose truth lives only in SQLite columns. Mail is a Maildir plus `mail.db`, contacts are `cards/*.vcf` plus `contacts.db`, but calendar is `calendar.db` and nothing else, with a vestigial `icsBlob` column that was never wired up. This proposal moves calendar onto the same model: **one `.ics` file per UID under `eigen.calendar/<calendarId>/`, the file is the source of truth, and `calendar.db` becomes a rebuildable index** plus the calendar-level metadata that has no iCalendar home (calendar rows, shares, tombstones, sync generation, recovery journals). Round-trips become lossless by construction: a CalDAV GET returns the exact bytes a client PUT, unknown properties, `VALARM`s and `X-` props included, and the ETag is a hash of the file. Every Eigen-side mutation goes load file → mutate the ical.js component → serialize → atomic write → index, under a per-calendar lock, so Eigen edits preserve what it does not model. Per-event state Eigen owns (organizer link, creator, event id) rides in the file as server-stamped `X-EIGEN-*` properties that a PUT cannot remove, so a from-scratch rebuild loses nothing per event. **No backward compatibility** (decided 2026-09-03): existing calendar data is dropped, not migrated; a v-next migration recreates `calendar.db` empty and every calendar starts fresh. The shared file+index mechanics (atomic write, pending-write journal, dirty set, stat-only reconcile, full rebuild) come out of `contacts/` into one core module both domains use; this is the third copy of the pattern, so it gets extracted, not cloned. Cost: the `Calendar` class is synchronous today and becomes async, which ripples mechanically through routes, the home relay, iMIP and propagation. Roughly two weeks of agent time in four sequential phases.

## Goals

1. **Files are the truth, everywhere.** Every user-facing domain (drive, mail, contacts, calendar) ends up as standard files on disk with SQLite as an index. Backups, restores, exports and manual inspection use `cp`, `grep` and any iCalendar tool; a corrupt or lost `calendar.db` is a rebuild, not data loss.
2. **Fidelity by construction.** A client's VEVENT survives Eigen untouched. Today `ical-parse.ts` keeps only what the columns model and `ical-serialize.ts` re-synthesises the rest on GET, so `VALARM` details, `ATTACH`, `RDATE`, `CATEGORIES`, `X-APPLE-*`, `X-MOZ-*` and `RANGE=THISANDFUTURE` are silently dropped or degraded. With the file as the resource there is no regenerate step to lose them.
3. **ETag and PUT semantics fall out of the file.** ETag is a hash of the stored bytes (the contacts `computeCardEtag` recipe). PUT is a full-resource replace because the resource *is* the file; the hand-built full-replace emulation in `resource.ts` (`syncExceptionEvents` prune, re-read ETag after the exception sync) goes away.
4. **One file+index core.** Mail, contacts and calendar all need atomic writes, torn-write recovery, a stat-only reconcile and a full rebuild. Contacts has the best version. Extract it once and use it twice.

## Non-goals

- **Migrating existing calendar data.** Decided 2026-09-03: current calendars, events, shares and linked invitations are dropped. Users recreate what they need; connected CalDAV clients get a full resync (the sync generation rotates, RFC 6578 recovery path). No export tool, no dual-read path, no legacy branch.
- **Changing the REST surface or the calendar app.** Routes keep their shapes and the FE keeps its types (`CalendarEvent`, `CalendarEventOccurrence`, `CreateEventInput`, `UpdateEventInput`). What changes is how the backend stores and reads; see Design § 6 for the one visible consequence (event ids become deterministic).
- **Changing the invitation model.** Linked copies in attendee calendars, server-side RSVP propagation, iMIP for external addresses, share propagation and team calendars all keep their semantics. They change writers, not behaviour.
- **Calendar import and feed subscriptions.** That is [PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md). This proposal makes it simpler (a feed refresh becomes "write these files, index them") and the two should not ship in the same branch.
- **A generic WebDAV file layer or exposing the `.ics` files through drive.** `eigen.calendar` stays a container the way `eigen.contacts` and `eigen.mail` do.
- **Full RFC 5545 semantics for properties Eigen does not model.** They round-trip verbatim; Eigen does not render them. `RDATE` and `RANGE=THISANDFUTURE` stay unsupported in the *index* (occurrence expansion), exactly as today, but are no longer destroyed on the way through.

## Current state (recap)

**Calendar is DB-canonical.** `apps/api/src/lib/calendar/calendar.ts` (`class Calendar`, ~1.6k lines) reads and writes `eigen.calendar/calendar.db` through Drizzle. `events` rows carry the iCalendar identity (`uid`, `uri`, `etag`, `sequence`), the times, `rrule` + `timezone`, `status`, the text fields, a `data` JSON (reminders, attendees, organizer, `organizerEventId`, url, notes, colour), the exception link (`parentEventId` + `recurrenceDate`), the invitation link (`organizerEventId` + `organizerUserId`), `createByUserId`, `eventCtag`, and an `icsBlob` column that CALENDAR.md documents as never written and never read. Exceptions are separate rows. Deletes are hard, with `event_tombstones` as the only trace. Calendar-level state is `calendars` (name, colour, default, visible, ctag, `shares` JSON) and `shared_calendars` (the recipient-side view of a share). See [CALENDAR.md](../CALENDAR.md) § Storage.

**Every `Calendar` method is synchronous.** `bun:sqlite` is sync, so `createEvent`, `updateEvent`, `deleteEvent`, `moveEvent`, `rsvpForOccurrence`, `receiveInvitation*`, `removeInvitation`, `cancelInvitationOccurrence`, `receiveShare`, `removeShare` and the calendar CRUD all return values directly. Only `init` and `destruct` are async. Callers outside the class: `routes/calendar.ts`, `caldav/resource.ts` + `caldav/proppatch.ts`, `calendar/imip.ts`, `home/home-relay.ts` (the cross-home invitation and share paths) and `share/reconciliation.ts`.

**The CalDAV layer regenerates.** `caldav/resource.ts` `handleGet` calls `eventsToIcs(master + exceptions)` and serves the result; `handlePut` runs `parseIcs`, upserts the master via the public mutations and `syncExceptionEvents` reconciles override VEVENTs against exception rows with a full-replace prune. `ical-parse.ts` uses ical.js; `ical-serialize.ts` is hand-written (229 lines including the `vtimezone.ts` generator). Cancelled occurrences are emitted as `EXDATE` and parsed back to cancelled rows so Thunderbird's PUT does not resurrect them. This is careful work that exists *because* the stored shape and the wire shape differ.

**Contacts already did this move.** `apps/api/src/lib/contacts/` (`card-store.ts`, `dav-store.ts`, `reconcile.ts`, `contacts.ts`) is the reference: one file per resource, `LocalFilesystem.writeAtomic` (temp → fsync → rename), a one-slot `Semaphore(1)` write lock, `pending_card_writes` journal + in-memory `dirtyCards` set with fail-closed reads, `commitCard` as the single index-write transaction, stat-only `reconcileIndex` on a healthy book and full `rebuildIndex` that rotates `syncGen`. The design rationale and the "honest contract" (what the index re-derives vs what it owns) are in [CONTACTS.md](../CONTACTS.md) and [PROPOSAL_CARDDAV.md](PROPOSAL_CARDDAV.md). The parts that are contact-specific (avatar cache, labels, the self card) are interleaved with the generic parts; nothing has been extracted yet.

## Alternatives considered

- **Write the raw bytes into the vestigial `icsBlob` column and treat that as the truth.** Cheapest route to round-trip fidelity: no file layout, no reconcile, no async ripple. Rejected because it leaves calendar as the one domain whose data is not on disk in a standard form, which is the actual goal, and because a BLOB-in-SQLite truth cannot be repaired, restored or inspected with anything but Eigen. It would also make the eventual move to files a second migration.
- **Files, but keep `Calendar` synchronous with `node:fs` sync writes.** Avoids touching every caller. Rejected: it blocks the event loop on fsync (a few ms on a busy disk, on every event write, inside the request path), it diverges from `LocalFilesystem.writeAtomic` and from contacts, and the async ripple is mechanical (the routes already `await resolveCalendar`).
- **Keep columns as truth and make the serializer lossless by storing an "unknown properties" JSON sidecar per event.** This is the same amount of parse/merge work with none of the file benefits, and every new property Eigen learns to model is a schema change. Rejected.
- **Clone `contacts/card-store.ts` into `calendar/` and adapt.** Fastest to build, and exactly the third-copy smell AGENTS.md names. Rejected in favour of a shared core (Design § 1), with contacts as the regression net for the extraction.
- **One file per calendar (a whole VCALENDAR with every VEVENT).** Matches how `.ics` exports look. Rejected: CalDAV resources are per UID, atomic replace of a growing file on every edit is O(calendar), and a torn write loses everything.

## Design

### 1 — Shared file+index core (Phase 0)

Extract the domain-neutral half of `contacts/card-store.ts` + `reconcile.ts` + the write-path scaffolding in `contacts.ts` into `apps/api/src/lib/core/indexed-file-store.ts`:

- `writeResourceFile(fs, path, bytes)`: temp → fsync → rename via `LocalFilesystem.writeAtomic`, temp-file cleanup at init (`cleanupTempCardFiles` generalised).
- `computeResourceEtag(bytes)`: SHA-256 hex, quoted at the DAV edge.
- The pending-write journal contract: a `pending_writes` table shape `{uri, key, recordedAt}` and the `record → write → commit(clears) / on failure markDirty` sequence, with the in-memory dirty set and `ensureDrained()` fail-closed read gate.
- The reconcile skeleton: list directory entries, compare `(mtime, size)` with the index, hand changed and new entries to a domain `indexResource(uri, bytes)` callback and removed ones to a `dropResource(uri)` callback; the full rebuild that clears and re-indexes every file and rotates `syncGen`.
- `sanitizeResourceUri` and `uriKeyOf` (case + NFC fold), currently contact-named.

Contacts is refit onto the core in the same phase with zero behaviour change; the existing contacts and CardDAV suites gate it. The contact-specific pieces (labels, the avatar cache, the self card, quota) stay in `contacts/`. This phase lands on its own branch before any calendar work starts.

### 2 — Storage layout (Phase 1)

```
eigen.calendar/
  <calendarId>/<uri>.ics      ← source of truth, one VCALENDAR per UID: master VEVENT + override VEVENTs + VTIMEZONEs
  calendar.db                 ← index over the files + calendar-level metadata
```

`<calendarId>` is the existing calendar id (client-chosen through MKCALENDAR, sanitised by `sanitizeCalendarId`, or a UUID). `<uri>` is the CalDAV resource name, client-chosen on PUT and `<uid>.ics` for Eigen-created events, sanitised the way card uris are. Team calendars use the same layout under `data/team/<teamId>/eigen.calendar/`. Deleting a calendar removes its directory after the index rows.

`calendar.db` (`db-config.ts`, one new version that drops the old tables and creates the new shape; existing rows are lost by decision):

| Table | Role |
|---|---|
| `calendars` | **Authoritative.** `id`, `name`, `color`, `isDefault`, `visible`, `ctag`, `syncGen`, `shares` JSON, timestamps. Unchanged in meaning; gains `syncGen`. |
| `shared_calendars` | **Authoritative.** The recipient-side share rows, unchanged. |
| `events` | **Derived.** One row per VEVENT in the files (master and each override): the same columns as today minus `icsBlob`, plus `mtime` + `size` for the stat reconcile, `fileUri` (the file this row came from) and `etag` (hash of the file bytes, identical on the master and its exception rows). Everything here re-derives from the files. |
| `event_tombstones` | **Authoritative.** `{uri, calendarId, deletedAtCtag}`, unchanged. Keyed by `(calendarId, uri)` so a re-created resource clears its own tombstone. |
| `pending_writes` | **Authoritative.** The crash-recovery journal from § 1. |

The honest contract, stated the way CONTACTS.md states it: a rebuild from the files alone reproduces every `events` row, every etag and every occurrence. What it cannot reproduce is calendar names, colours, shares, the ctag and the tombstones, so a rebuild rotates `syncGen` and CalDAV clients resync in full.

### 3 — What lives in the file

Eigen writes RFC 5545 for everything it models and `X-EIGEN-*` for what it owns and iCalendar has no property for. All of it is inside the VEVENT, so one file is self-describing.

| Eigen field | In the file |
|---|---|
| `title`, `description`, `location`, `startTime`/`endTime`/`allDay`, `rrule`, `timezone`, `status`, `sequence`, `uid` | `SUMMARY`, `DESCRIPTION`, `LOCATION`, `DTSTART`/`DTEND` (TZID form, `VALUE=DATE` for all-day), `RRULE`, the `TZID` parameter + generated `VTIMEZONE`, `STATUS`, `SEQUENCE`, `UID`. Same as `ical-serialize.ts` emits today. |
| exception link (`parentEventId` + `recurrenceDate`) | An override VEVENT in the same file with `RECURRENCE-ID` naming the original occurrence (the existing `computeOccurrenceTimes` rule). A cancelled occurrence is an `EXDATE` on the master, no override VEVENT, exactly as today. |
| `data.attendees[]` with status + role | `ATTENDEE;PARTSTAT=…;ROLE=…;CN=…:mailto:…` |
| `data.organizer` | `ORGANIZER;CN=…:mailto:…` plus `X-EIGEN-ORGANIZER-USER:<userId>` |
| `data.organizerEventId` / `organizerEventId` + `organizerUserId` columns | `X-EIGEN-ORGANIZER-EVENT:<id>` and the same `X-EIGEN-ORGANIZER-USER`. Their presence is the "this is a linked copy" discriminator that `findLinkedEvent` and the `updateEvent` guard use today. |
| `data.reminders[]` | One `VALARM` each: `ACTION:DISPLAY` for `notification`, `ACTION:EMAIL` for `email`, `TRIGGER:-PT<minutes>M`. Client-written `VALARM`s with other shapes round-trip verbatim and are ignored by the index. |
| `data.url`, `data.color` | `URL`, `COLOR` (RFC 7986) |
| `data.notes` | `X-EIGEN-NOTES` (there is no second free-text property; `DESCRIPTION` is taken). |
| `createByUserId` | `X-EIGEN-CREATED-BY:<userId>` |
| `id` | Not stored; derived, see § 6. |

**Server-owned properties are re-stamped on PUT.** A CalDAV client may not know or may strip `X-EIGEN-*`. On every PUT, after parsing the client's bytes, the store copies `X-EIGEN-ORGANIZER-USER`, `X-EIGEN-ORGANIZER-EVENT` and `X-EIGEN-CREATED-BY` from the previously stored VEVENT with the same UID (and per override, the same `RECURRENCE-ID`) into the new component before writing. A client can therefore never turn a linked invitation into an ordinary event by accident, which is the property the current `updateEvent` guard protects. This is the one place the stored bytes differ from the PUT bytes, and the response ETag is the hash of what was stored.

### 4 — Parse and serialize through ical.js, both ways

`ical-parse.ts` already parses with ical.js. The hand-written serializer is replaced by building or mutating an `ICAL.Component` and calling `toString()`, so that an Eigen-side edit of a client-created event changes only the properties it touches and leaves the rest as the client wrote them. `vtimezone.ts` stays; its output is inserted as a `VTIMEZONE` component. Line folding, escaping and parameter quoting become ical.js's problem instead of ours.

The index projection (`indexResource(uri, bytes)` from § 1) is `parseIcs` followed by the existing row mappers; `parseIcs` grows the `X-EIGEN-*` and `VALARM` readers and drops nothing it does not need, because it no longer has to.

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

`commitEvent` is the single index-write seam. It replaces *all* rows whose `fileUri` matches (master plus overrides) with the freshly projected set, which is what makes "PUT is a full-resource replace" free: an override the client removed is simply not in the new projection. Cross-home writes (`receiveInvitation*`, `removeInvitation`, `rsvpForOccurrence` on the organizer's copy) are ordinary mutations on the *recipient's* `Calendar` and go through the same seam there. `moveEvent` is a file rename between calendar directories plus a row update inside one commit; the source calendar gets a tombstone as today.

`deleteEvent` is: tombstone row + delete file + delete rows, in that order inside the lock, with the journal covering the window between file removal and commit.

Every public method becomes `async`. The callers (`routes/calendar.ts`, `caldav/resource.ts`, `caldav/proppatch.ts`, `calendar/imip.ts`, `home/home-relay.ts`, `share/reconciliation.ts`, `calendar/invite-propagation.ts`, `calendar/share-propagation.ts`) gain an `await` each. This is mechanical and TypeScript finds every site (a missing `await` on a now-Promise return breaks the return type, and the "think about every `await`" rule in AGENTS.md applies to the fire-and-forget propagation paths, which keep their `.catch()`).

### 6 — Reads, occurrences and ids

Reads never touch a file. `getEventsInRange`, `getEventsByUid`, free/busy, `getEventsWithAttendee` and recurrence expansion all run on the `events` index exactly as today; the only new read gate is `ensureDrained()` at the top of each public read, as in contacts. CalDAV GET is the one read that serves bytes, and it reads the file (the index only supplies the etag for the header).

**Ids become deterministic** so that a rebuild from files yields the same ids the FE and linked copies already hold: master `id = sha256(calendarId + '\0' + uid)` truncated to 32 hex, exception `id = sha256(calendarId + '\0' + uid + '\0' + recurrenceDate)`. Ids stay opaque strings on the wire, `CalendarEvent.id` keeps its type, and `parentEventId` on an exception row is the master's derived id. `organizerEventId` in a linked copy points at the organizer's derived id, which is stable across rebuilds on the organizer's side too. The alternative (stamp a random id into the file as `X-EIGEN-ID` and read it back) was rejected: one more server-owned property to re-stamp, and no benefit once ids are derivable.

Because `uri` is client-chosen and `uid` is what identifies the file's content, the index keeps the existing `(calendarId, uri)` unique constraint and the `(calendarId, uid)` index; a PUT whose UID is already stored under a different uri is a 409 exactly as `resource.ts` does now.

### 7 — CalDAV surface after the move

`caldav/resource.ts` shrinks to what `carddav/` looks like: `handleGet` reads the file and serves it verbatim with the quoted hash ETag; `handlePut` validates the payload (`parseIcs` must succeed, exactly one UID, the existing recurring-dtstart and interval guards), checks `If-Match`/`If-None-Match` against the stored hash, re-stamps server-owned properties, and calls one `Calendar.putResource(calendarId, uri, bytes)` that runs the § 5 sequence; `handleDelete` maps to `deleteEvent`. `syncExceptionEvents` and the ETag re-read are deleted. `report.ts` (`calendar-multiget`, `calendar-query`, `sync-collection`) reads the index as today; `sync-collection` tokens gain the `syncGen` prefix the CardDAV twin uses so a rebuilt calendar forces the RFC 6578 recovery.

Invitation fan-out on a CalDAV PUT keeps its current trigger: after `putResource` projects the rows, the same attendee diff that `createEvent`/`updateEvent` run today decides what to propagate.

### 8 — Reconcile and rebuild

`Calendar.init` runs the § 1 reconcile per calendar directory: stat-only against `events.mtime/size`, re-indexing only changed files, dropping rows whose file is gone, and the full rebuild (rehash every file, drop tombstones, bump ctag, rotate `syncGen`) when the `calendars` row for a directory is missing or on demand. There are no fs-watchers, for the same reason contacts has none: nothing writes these files out of process. A user who edits a file by hand sees it on the next open.

### 9 — What stays out of the file, deliberately

Calendar name, colour, default flag, visibility, the share list and the recipient-side `shared_calendars` rows are calendar-level, not event-level, and stay in `calendar.db`. iCalendar has `X-WR-CALNAME`/`X-APPLE-CALENDAR-COLOR` conventions for exports, but writing them into every event file would put one fact in N places. The calendar-level facts are small, few and already survive through the existing `settings.json`/share-propagation paths; they are not worth a second file format.

## Performance invariants

- **Range and occurrence reads are index-only.** Zero file reads on any REST GET, `calendar-query`, `sync-collection` or free/busy.
- **One write is one file plus one transaction.** A mutation touches exactly the file for its UID and the rows of that file. A calendar with 10k events costs the same per edit as one with 10.
- **Reconcile on open is stat-only.** One `readdir` per calendar directory and an `(mtime, size)` compare; no parse unless a file changed. A cold open of a 10k-event calendar is a directory listing plus one indexed query.
- **The write lock is per `Calendar`, not global.** Two Homes never wait on each other; a fan-out to 26 attendees takes 26 independent locks.
- **Files are small.** A VEVENT with a dozen overrides and two VTIMEZONEs is a few KB; `CARD_MAX_BYTES`-style cap of 1 MiB per resource on PUT (a real recurring series with hundreds of overrides is well under 200 KB).

## Phased rollout

| Phase | Scope | Gate |
|---|---|---|
| 0 | Extract `core/indexed-file-store.ts` from contacts; refit contacts onto it. No calendar changes. | Contacts + CardDAV suites green, byte-identical vCard behaviour, `CONTACTS.md` pointer updated. Own branch, merged before phase 1 starts. |
| 1 | Storage relayout: new `calendar.db` version, `<calendarId>/<uri>.ics` files, ical.js serializer, `X-EIGEN-*` mapping, deterministic ids, `Calendar` write seam + async ripple, reconcile/rebuild. CalDAV still regenerates through the parsed rows (the file is written, the DAV layer does not yet serve it). | `calendar.test.ts`, `calendar-invites.test.ts`, `calendar-timezone.test.ts`, `team-calendar-share.test.ts`, `ical-imip.test.ts` green against the new store; a new `calendar-store.test.ts` covering torn-write recovery, reconcile-on-open, rebuild + `syncGen` rotation and the id derivation. |
| 2 | CalDAV serves and stores bytes: verbatim GET, hash ETag, `putResource`, re-stamp on PUT, `syncGen` sync tokens, `resource.ts` simplification. | `caldav.test.ts`, `caldav-roundtrip.test.ts`, `caldav-client-sync.test.ts` green; the new fidelity test from § 4. |
| 3 | Real-client verification against the local Docker edge (see [VERIFICATION.md](../VERIFICATION.md)): macOS/iOS Calendar, Thunderbird, DAVx⁵. Create, edit, delete an occurrence, undo-delete, RSVP, a client-side alarm, a moved series. | A written matrix in the branch report with the observed round-trip bytes for each client. Docs pass: `CALENDAR.md` § Storage and § CalDAV rewritten to present tense, `STORAGE.md` layout tree, the AGENTS.md storage row, the ROADMAP row. |

Phases are sequential. Phase 1 is the large one (the `Calendar` class is 1.6k lines and every mutation moves onto the seam); phases 0 and 2 are each a few days; phase 3 is a day plus whatever the clients turn up. Total is on the order of two weeks of agent time, about twice the contacts move, because of the extra writers and the exception model.

## Verification gate

Before the branch is called done:

- `bun run check` green, including the new store and fidelity tests.
- A PUT/edit/GET fidelity probe with a kitchen-sink VEVENT (every property in § 4's list) shows byte-for-byte preservation of everything Eigen does not model.
- Kill the API between the file rename and the index commit (the `EIGEN_STORAGE_FAULT`-style dev hook, see the create/open resilience work) and confirm the next open re-indexes the file, serves it, and the ETag matches the bytes.
- `rm calendar.db`, restart, confirm every event, exception and occurrence is back, and that a connected CalDAV client resyncs in full rather than ghosting deletions.
- An organizer edit on a linked-invitation event PUT by a client that stripped `X-EIGEN-*` still propagates, and the linked copy still refuses attendee-side edits of organizer fields.
- Each phase's review runs under the Review Standard in [WORKING-METHOD.md](../WORKING-METHOD.md).

## Risks and caveats

- **The async ripple is wide but shallow.** Every `Calendar` call site changes. TypeScript catches them all; the risk is a fire-and-forget path that used to be sync and silently becomes an unawaited Promise. The propagation modules already run fire-and-forget with `.catch()`; the review checks every new `await`.
- **Clients that rewrite the whole VEVENT.** Apple and Thunderbird preserve unknown properties; some clients (older Outlook connectors, some Android apps) re-emit only what they know. The re-stamp rule in § 3 protects Eigen-owned links; anything else a client drops is that client's behaviour, and today it is dropped by us regardless.
- **Deterministic ids leak nothing but must be stable.** Changing the derivation later would orphan every `organizerEventId` link. The recipe is fixed in `packages/lib/src/core/calendar/` next to the other id helpers and covered by a test that pins sample outputs.
- **Two truths during phase 1.** Between phases 1 and 2 the file is written but CalDAV still serves regenerated bytes. This is fine (the regenerate path is what runs today) but the phase-1 review must confirm the file and the projection agree, which is what the reconcile test proves.
- **Feed subscriptions land after this.** [PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md) was written against the row model (`applyFeedSnapshot` with `(uid, recurrenceDate)` identity). It needs a short rewrite to "write files, index them" once phase 1 has merged; the bulk-transaction requirement becomes "one lock acquisition, N files, one commit".
- **Calendar search** ([SEARCH.md](../SEARCH.md) § Remaining) is unaffected: an `events_fts` table over the index is derived data and rebuilds with it.

## Decisions (2026-09-03)

- **No backward compatibility.** Existing calendar data is dropped by a `calendar.db` version bump that recreates the schema. No migration, no export, no dual read.
- **Files, not `icsBlob`.** The vestigial column is removed rather than revived.
- **One file per UID**, master plus overrides plus VTIMEZONEs, under `eigen.calendar/<calendarId>/<uri>.ics`.
- **Eigen-owned per-event state rides in the file** as `X-EIGEN-*` and is re-stamped on PUT; calendar-level state stays in the index.
- **Deterministic ids** derived from `(calendarId, uid[, recurrenceDate])`.
- **Extract the file+index core from contacts first** (phase 0) rather than clone it.
- **`Calendar` goes async.**

## Open questions

- `data.notes` as `X-EIGEN-NOTES` vs folding notes into `DESCRIPTION` and dropping the field. The FE shows them as separate boxes today; keep the field unless the calendar app wants to merge them.
- Whether `ACTION:EMAIL` alarms written by a client should trigger Eigen's mail reminder path, or only Eigen-written ones. Proposal: only what the index projects, which is any `VALARM` with `ACTION:EMAIL` and a `TRIGGER` in the `-PT<n>M` form; anything else round-trips and does nothing.
- Per-resource size cap: 1 MiB proposed; the CardDAV cap is 5 MiB because of inline photos, calendar has no equivalent payload.
