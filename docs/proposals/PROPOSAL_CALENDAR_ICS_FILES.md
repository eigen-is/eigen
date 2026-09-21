# Proposal: Calendar events as `.ics` files, `calendar.db` as the index

> **TLDR**: Calendar's event content lives in SQLite columns. Mail is a Maildir plus `mail.db`, contacts are `cards/*.vcf` plus `contacts.db`, but calendar is `calendar.db` and nothing else, with a vestigial `icsBlob` column that was never wired up. This proposal moves calendar onto the same model: **one `.ics` file per UID under `eigen.calendar/<calendarId>/`, the file is the source of truth, and `calendar.db` becomes an index** plus authoritative metadata (calendar rows, shares, tombstones, sync generation, recovery journal). CalDAV GET returns the stored file bytes and the ETag hashes those bytes. PUT re-stamping and Eigen edits may reserialize the component: preserving unmodeled properties is a semantic fidelity goal, not byte-for-byte preservation of the client's input. Every mutation goes load file → mutate the ical.js component → serialize → atomic write → index, under a per-Home write lock. Per-event state Eigen owns (the event id, the invitation link, the creator, an exclusion's sequence) rides in the file as server-stamped `X-EIGEN-*` properties, so a rebuild from the files alone reads back every id, every link and every occurrence. **No backward compatibility** (decided 2026-09-03): existing calendar data is dropped, not migrated; a `calendar.db` version bump recreates the schema empty and every calendar starts fresh. The shared file+index mechanics come out of `contacts/` into a core module the two single-writer domains use; mail shares the primitives and the principle, not the module (see [Single writer](#single-writer-what-the-three-domains-can-share)). The async conversion reaches routes, the home relay, iMIP and share propagation. Once the bytes are the truth, `.ics` export rides the same `FileSubject` and `FILE_ACTIONS` machinery vCards use ([Files everywhere](#files-everywhere-import-export-and-quick-look)). The original two-week estimate is provisional, not an evidence-backed commitment; size it as an L.

**Review status (2026-09-21): design settled, no implementation yet.** The route is files directly, not `icsBlob` first, and the seven storage questions this proposal used to leave open are answered in the Design sections and summarized in [Settled design questions](#settled-design-questions). No code implements any of it.

## Goals

1. **Files are the truth, everywhere.** Every user-facing domain (drive, mail, contacts, calendar) ends up as standard files on disk with SQLite as an index. Backups, restores, exports and manual inspection use `cp`, `grep` and any iCalendar tool. A corrupt or lost `calendar.db` costs the calendar-level metadata (names, colors, shares, tombstones) and a full client resync, never an event; today it costs every event.
2. **Fidelity by construction.** A client's VEVENT survives Eigen untouched. Today `ical-parse.ts` keeps only what the columns model and `ical-serialize.ts` re-synthesizes the rest on GET, so `VALARM` details, `ATTACH`, `RDATE`, `CATEGORIES`, `URL`, `COLOR`, `COMMENT`, every `X-` property and `RANGE=THISANDFUTURE` are silently dropped or degraded. The parse-time degradations (a sub-daily `RRULE` or an out-of-range `DTSTART` collapses to a single event) are written back to the client too, because GET re-serializes the degraded row. With the file as the resource there is no regenerate step to lose any of it.
3. **ETag and PUT semantics fall out of the file.** ETag is a hash of the stored bytes (the contacts `computeCardEtag` recipe). PUT is a full-resource replace because the resource *is* the file; the hand-built full-replace emulation in `caldav/resource.ts` (`syncExceptionEvents` prune, re-read ETag after the exception sync) goes away.
4. **One file+index core for the single-writer domains.** Contacts and calendar both need atomic writes, torn-write recovery, a stat-only reconcile and a full rebuild. Contacts has the working version. Extract it once and use it twice. Mail meets the same principle with different mechanics, because Dovecot writes its files too.

## Non-goals

- **Migrating existing calendar data.** Decided 2026-09-03: current calendars, events, shares and linked invitations are dropped. Users recreate what they need; connected CalDAV clients get a full resync (the sync generation rotates, RFC 6578 recovery path). No export tool, no dual-read path, no legacy branch.
- **Changing the REST surface or the calendar app.** Routes keep their shapes and the FE keeps its types (`CalendarEvent`, `CalendarEventOccurrence`, `CreateEventInput`, `UpdateEventInput`), and event ids stay the random UUIDs they are today. The one exception is `data.notes`, which has no reader or writer anywhere and leaves `EventData` and the route schema with this work; `data.color` is live and rides in the file (§ 3).
- **Changing the invitation model.** Linked copies in attendee calendars, server-side RSVP propagation, iMIP for external addresses, share propagation and team calendars all keep their semantics. They change writers, not behavior, and both invitation transports stay projected (§ 4).
- **Calendar import and feed subscriptions.** That is [PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md). This proposal makes it simpler (a feed refresh becomes "write these files, index them") and the two should not ship in the same branch.
- **A generic WebDAV file layer or mounting `eigen.calendar` in drive.** `eigen.calendar` stays a container the way `eigen.contacts` and `eigen.mail` do. A loose `.ics` that sits in Drive, in a mail or in a chat is a different thing and is in scope: [Files everywhere](#files-everywhere-import-export-and-quick-look).
- **Full RFC 5545 semantics for properties Eigen does not model.** They round-trip verbatim; Eigen does not render them. `RDATE` and `RANGE=THISANDFUTURE` stay unsupported in the *index* (occurrence expansion), exactly as today, but are no longer destroyed on the way through.

## Current state (recap)

**Calendar is DB-canonical.** `apps/api/src/lib/calendar/calendar.ts` (`class Calendar`, 1.8k lines) reads and writes `eigen.calendar/calendar.db` through Drizzle. `events` rows carry the iCalendar identity (`uid`, `uri`, `etag`, `sequence`), the times, `rrule` + `timezone`, `status`, the text fields, a `data` JSON (reminders, attendees, organizer, `organizerEventId`, url, notes, color), the exception link (`parentEventId` + `recurrenceDate`, a `YYYY-MM-DD` text key), the invitation link (`organizerEventId` + `organizerUserId` columns), `createByUserId`, `eventCtag`, and an `icsBlob` column that CALENDAR.md documents as never written and never read. Exceptions are separate rows with their own uri (`<uid>-exc-<date>.ics`). Deletes are hard, with `event_tombstones` as the only trace. `(calendarId, uri)` is the only unique key; `(calendarId, uid)` is a plain index. Calendar-level state is `calendars` (name, color, default, visible, ctag, `shares` JSON) and `shared_calendars` (the recipient-side view of a share, with the owner's name and color copied in). The whole container lives on the local filesystem under the Home directory (`home.getLocalDatabase`), never on a drive mount or S3, the same as `eigen.contacts`. See [CALENDAR.md](../CALENDAR.md) § Storage.

**Nearly every `Calendar` method is synchronous.** `bun:sqlite` is sync, so every mutation, every read and most of the calendar CRUD return values directly; only `init`, `destruct`, `updateCalendar` and `deleteCalendar` are async. Free/busy is not a method; the `/event-range` route redacts occurrences to `FreeBusyBlock` for a `free-busy` share. Callers outside the class: `routes/calendar.ts` (via `calendar/get-calendar.ts`), `caldav/caldav-router.ts`, `caldav/resource.ts` + `caldav/proppatch.ts`, `calendar/imip.ts`, `home/home-relay.ts` (the receiving end of every cross-home invitation and share message), `share/reconciliation.ts`, `calendar/share-propagation.ts` (`checkPermission`) and the demo seeder. `calendar/invite-propagation.ts` only sends relay messages and never touches the class.

**The CalDAV layer regenerates.** `caldav/resource.ts` `handleGet` calls `eventsToIcs(master + exceptions)` and serves the result; `handlePut` runs `parseIcs`, upserts the master via the public mutations and `syncExceptionEvents` reconciles override VEVENTs against exception rows with a full-replace prune, then re-reads the ETag. `ical-parse.ts` uses ical.js; `ical-serialize.ts` is hand-written (229 lines, plus the 174-line `vtimezone.ts` generator) and also hosts `serializeEventForImip`. Canceled occurrences are emitted as `EXDATE` and parsed back to canceled rows so Thunderbird's PUT does not resurrect them; the parser gives each of those synthetic rows the master's `SEQUENCE`. A PUT is capped at `EVENT_MAX_BYTES` (20 MiB), and `MAX_URI_LENGTH` caps the decoded uri with a comment saying an event uri is a DB column, never a filename. Nothing checks that a UID is stored under one uri only, and `handlePut` passes no `user`, so a CalDAV PUT never fans out invitations. This is careful work that exists *because* the stored shape and the wire shape differ.

**The linked-copy lock is `isInvitationFromOthers`.** That shared helper (`packages/lib/src/core/calendar/calendar-utils.ts`) compares a stored `ORGANIZER` address with the Home owner's, case-insensitively, and `updateEvent` uses it to discard every input except reminders and color on an attendee-side copy. `parseIcs` sets `data.organizer` from any `ORGANIZER` property, including the user's own address as Apple Calendar writes it on an event with invitees, which is why the comparison is on the address and not on the property's presence. `findLinkedEvent` and the RSVP relay look linked copies up by the `organizerEventId` + `organizerUserId` columns, and `moveEvent` re-homes an event under the same id.

**Contacts already did this move.** `apps/api/src/lib/contacts/` (`card-store.ts`, `dav-store.ts`, `reconcile.ts`, `contacts.ts`) is the reference: one file per resource, `LocalFilesystem.writeAtomic` (temp → fsync → rename → directory fsync), a one-slot `Semaphore(1)` write lock per `Contacts` instance, `pending_card_writes` journal + in-memory `dirtyCards` set with the fail-closed `ensureDrained()` read gate, `commitCard` as the single index-write transaction, `purgeCard` as the unlink-then-commit delete, stat-only `reconcileIndex` at `init` and full `rebuildIndex` that rotates `syncGen`. The rationale and the "honest contract" are in [CONTACTS.md](../CONTACTS.md). The contact-specific parts (avatar cache, labels, the self card, `cardsBytes` quota metering) are interleaved with the generic ones; nothing has been extracted yet.

**One writer.** Every write to `eigen.calendar` and `eigen.contacts` goes through the API process: REST, CalDAV and CardDAV are all in-process, and nothing else opens those folders. Mail is the one domain with a second, out-of-process writer: Postfix delivers through the API (`POST /mail/deliver/:to`), but Dovecot reads and writes the same Maildir directly (`docker/dovecot/dovecot.conf`, `mail_location = maildir:~/Maildir`), which is why `MaildirStore` carries `fs.watch` handles and a full readdir diff and the other two do not.

**Backups already cover the container.** Per-home backup ([BACKUP.md](../BACKUP.md)) walks the whole home (`backup/snapshot-home.ts`), so the `.ics` files are archived with no backup-side code, and `calendar.db` is in `HOME_DATABASES` and copied through `VACUUM INTO`. A restore does not preserve file mtimes (`backup/capture.ts`, `backup/archive.ts`).

## Alternatives considered

- **Write the raw bytes into the vestigial `icsBlob` column and treat that as the truth.** Cheapest route to round-trip fidelity: no file layout, no reconcile, no async ripple. But the bytes would not be independently accessible as standard files, which is this proposal's additional goal, and an eventual move to files would be a second storage change. Rejected: see [Two-step option](#two-step-option-icsblob-first-files-later).
- **Files, but keep `Calendar` synchronous with `node:fs` sync writes.** Avoids touching every caller. Rejected: it blocks the event loop on fsync (a few ms on a busy disk, on every event write, inside the request path), it diverges from `LocalFilesystem.writeAtomic` and from contacts, and the async ripple is mechanical (the routes already `await resolveCalendar`).
- **Keep columns as truth and make the serializer lossless by storing an "unknown properties" JSON sidecar per event.** This is the same amount of parse/merge work with none of the file benefits, and every new property Eigen learns to model is a schema change. Rejected.
- **Clone `contacts/card-store.ts` into `calendar/` and adapt.** Fastest to build, and exactly the third-copy smell AGENTS.md names. Rejected in favour of a shared core (§ 1), with contacts as the regression net for the extraction.
- **One file per calendar (a whole VCALENDAR with every VEVENT).** Matches how `.ics` exports look. Rejected: CalDAV resources are per UID, atomic replace of a growing file on every edit is O(calendar), and a torn write loses everything.
- **Deterministic ids derived from `(calendarId, uid[, recurrenceDate])` instead of storing the id in the file.** Saves one server-stamped property. Rejected: `moveEvent` re-homes an event under the same id, every attendee copy points at the organizer's id, and the FE carries ids in route params, so an id that changes on a move would orphan every link or force a cross-home fan-out per move.
- **Cancelled occurrences as `STATUS:CANCELLED` override VEVENTs instead of `EXDATE`.** Lossless for the exclusion's own state. Rejected: Thunderbird drops such overrides on its next PUT and the full-replace read resurrects the occurrence, which is why the `EXDATE` rule exists at all.
- **Naming a resource after its UID, sanitized or hashed.** Rejected: sanitizing silently rewrites the name a client addresses the resource by, and a hash leaves no operator able to find an event in the directory by eye.

## Design

### 1 — Shared file+index core (Phase 0)

Extract the domain-neutral half of `contacts/card-store.ts` + `reconcile.ts` + the write-path scaffolding in `contacts.ts` into `apps/api/src/lib/core/indexed-file-store.ts`:

- `writeResourceFile(fs, path, bytes)`: temp → fsync → rename → directory fsync via `LocalFilesystem.writeAtomic`, temp-file cleanup at init (`cleanupTempCardFiles` generalized). `rename`, `unlink` and `delete` route through `LocalFilesystem.syncDir` too, so a name change is as durable as an atomic replace.
- `computeResourceEtag(bytes)`: SHA-256 hex, quoted at the DAV edge.
- `nextSyncGen(stored)`: `Math.max((stored ?? 0) + 1, Math.floor(Date.now() / 1000))`, the one generation rule both domains use (§ 8).
- The pending-write journal: entries, dirty keys and every commit/drop predicate are scoped by `(calendarId, uriKey)`, not URI alone, because two calendars may hold the same resource name. `record → write → commit(clears) / on failure markDirty` covers a single-resource replacement, and covers a move and a calendar delete too, because both are shaped into one rename (§ 5). There is no second intent table.
- The reconcile skeleton: `readdir`, `stat` each entry, compare `(mtime, size)` with the index, hand changed and new entries to a domain `indexResource(uri, bytes)` callback and removed ones to `dropResource(uri)`, dropping vanished keys before indexing new ones; plus the full rebuild that re-indexes every file and rotates `syncGen`.
- `sanitizeCardUri` and `uriKeyOf` (case + NFC fold) generalized to take the required extension, so calendar passes `.ics` where contacts passes `.vcf`. Both are thin wrappers over `isSafePathSegment` (`core/path-utils.ts`), already the one rule for a client-chosen name that becomes a path segment.

The core has two consumers, contacts and calendar, and is named and scoped as such. Mail is deliberately not one: its mutation unit is a rename that changes identity-bearing path components (`setFlags` rewrites the `:2,` suffix, `move` relocates between mailbox directories), it has no per-resource ETag, ctag or sync generation, and its reconcile exists for a foreign writer rather than for crash recovery.

Contacts is refit onto the core here with zero behavior change; the contacts and CardDAV suites gate it, and the contact-specific pieces stay in `contacts/`. Two contacts fixes land as their own units *after* that extraction, so its gate stays meaningful: the `nextSyncGen` fix for the reused generation, and the `no-uid-conflict` response that names its href (§ 6). Calendar states its own recovery policy rather than inheriting one: a resource whose commit failed stays dirty and fails reads closed until the next drain succeeds, and a read takes bytes and ETag from one committed revision. This phase lands on its own branch before any calendar work starts.

### 2 — Storage layout (Phase 1)

```
eigen.calendar/
  <calendarId>/<uri>          ← source of truth, one VCALENDAR per UID: master VEVENT + override VEVENTs + VTIMEZONEs
  calendar.db                 ← index over the files + calendar-level metadata
```

`<calendarId>` is the existing calendar id (client-chosen through MKCALENDAR, sanitized by `sanitizeCalendarId`, or a UUID). `<uri>` is the CalDAV resource name including its `.ics` suffix. **Eigen-minted names are always `<uuid>.ics`, never the UID**: a UID is the author's string, so once it names a file one carrying `/` or `..` is a traversal, 300 bytes of it is an `ENAMETOOLONG`, and two files sharing a UID collide. `Calendar.importEvents` already mints exactly that name and says why; `receiveInvitation`, which builds `${payload.uid}.ics` today, and the DAV creation path join it. Overrides live inside the master's file, so the separate `<uid>-exc-<date>.ics` exception uris go away. Team calendars use the same layout under `data/team/<teamId>/eigen.calendar/`.

**Both path segments are client input and become filenames.** Today `uri` is a percent-decoded, length-capped DB column (`caldav/resource.ts`) and `calendarId` is sanitized at MKCALENDAR only (`caldav/proppatch.ts`), not on a PUT into an existing id. The store validates both at its own seam, on every entry path (CalDAV, REST, iMIP, relay, reconcile): `isSafePathSegment` plus the required `.ics` suffix, with the case + NFC fold `uriKeyOf` deciding identity. A name that passes is kept verbatim; one that fails is a 400 at the DAV edge, never a rewrite, because the client addresses the resource by the name it chose. `isSafePathSegment` is ASCII-only, so a non-ASCII resource name is a 400; CardDAV has shipped that rule against real clients, which name resources with UUIDs, and phase 3's matrix settles whether CalDAV clients are equally well-behaved.

`calendar.db` gets one new version that drops the old tables and creates the shape below (`db-config.ts`; existing rows are lost by decision). `currentVersion` is `1` today and [PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md) claims 2 for its additive `subscription` column: this proposal lands first and owns 2, with `subscription` created as part of the new `calendars` shape, so the import work adds no migration of its own.

| Table | Role |
|---|---|
| `calendars` | **Authoritative.** `id`, `name`, `color`, `isDefault`, `visible`, `ctag`, `syncGen`, `shares` JSON, timestamps. Unchanged in meaning; gains `syncGen`. |
| `shared_calendars` | **Authoritative.** The recipient-side share rows, unchanged. |
| `resources` | **Derived.** One row per file, the shape of the contacts `contacts` table: `calendarId`, `uriKey`, `uri`, `uid`, `etag` (hash of the bytes), `mtime`, `size`, unique on `(calendarId, uriKey)` and on `(calendarId, uid)`. Every file fact lives here and nowhere else. |
| `events` | **Derived.** One row per VEVENT the file projects (master, each override, each exclusion), hanging off its resource row by `(calendarId, uriKey)`: today's columns minus `icsBlob`, plus `hasUnindexedRecurrence` (§ 7). No event row carries an mtime, a size or an etag of its own. |
| `event_tombstones` | **Authoritative.** `{uri, calendarId, deletedAtCtag}`, unchanged. Keyed by `(calendarId, uri)` so a re-created resource clears its own tombstone. |
| `pending_writes` | **Authoritative.** The crash-recovery journal from § 1, keyed by `(calendarId, uriKey)`. |

The honest contract, stated the way CONTACTS.md states it: a rebuild from the files alone reproduces every resource, every `events` row, every id, every etag and every occurrence. What it cannot reproduce is calendar names, colors, shares, the ctag and the tombstones, so a rebuild rotates `syncGen` and CalDAV clients resync in full.

### 3 — What lives in the file

Eigen writes RFC 5545 for everything it models and `X-EIGEN-*` for what it owns and iCalendar has no property for. All of it is inside the VCALENDAR, so one file is self-describing.

| Eigen field | In the file |
|---|---|
| `id` | `X-EIGEN-ID:<uuid>`, on the master and on every override. The random UUID Eigen mints today, minted for any VEVENT that arrives without one. |
| `title`, `description`, `location`, `startTime`/`endTime`/`allDay`, `rrule`, `timezone`, `status`, `sequence`, `uid` | `SUMMARY`, `DESCRIPTION`, `LOCATION`, `DTSTART`/`DTEND` (TZID form, `VALUE=DATE` for all-day), `RRULE`, the `TZID` parameter + generated `VTIMEZONE`, `STATUS`, `SEQUENCE`, `UID`. Same as `ical-serialize.ts` emits today. |
| exception link (`parentEventId` + `recurrenceDate`) | An override VEVENT in the same file with `RECURRENCE-ID` naming the original occurrence (the existing `computeOccurrenceTimes` rule); `parentEventId` is the master's `X-EIGEN-ID`. |
| a cancelled occurrence | `EXDATE` on the master stays authoritative for *which* occurrences are excluded, as today, and beside it one `X-EIGEN-EXDATE;X-EIGEN-SEQ=<n>[;TZID=…][;VALUE=DATE]:<the EXDATE's own value>` per exclusion carries the `SEQUENCE` the RFC 5546 replay guard in `cancelInvitationOccurrence` compares. A missing stamp falls back to the **master's** sequence, which is what the parser already does; a stamp whose value has no `EXDATE` is dropped, because the client undid that deletion. Exclusion rows mint a fresh id per projection, and a cancelled exclusion's attendee list is not preserved: its only reader falls back to the master's. |
| `data.attendees[]` with status + role | `ATTENDEE;PARTSTAT=…;ROLE=…;CN=…:mailto:…` |
| `data.organizer` | `ORGANIZER;CN=…:mailto:…` |
| `organizerEventId` + `organizerUserId` columns | `X-EIGEN-ORGANIZER-EVENT:<id>` and `X-EIGEN-ORGANIZER-USER:<userId or external_…>` |
| an imported event's original organizer | `X-EIGEN-IMPORTED-ORGANIZER:<address>`, one inert line. An import drops every `ATTENDEE` and turns `ORGANIZER` into this, so an imported event is a plain own event: editable, it mails nobody, and the user may add guests and become its organizer. § 6 matches a later inbound REQUEST against this line. |
| `data.reminders[]` | One `VALARM` each: `ACTION:DISPLAY` for `notification`, `ACTION:EMAIL` for `email`, `TRIGGER:-PT<minutes>M`, and an `EMAIL` alarm Eigen writes also carries the `SUMMARY`, `DESCRIPTION` and `ATTENDEE` RFC 5545 § 3.6.6 requires. Client-written `VALARM`s of other shapes round-trip verbatim; the index projects `{type, minutes}` from them as today. |
| `data.url` | `URL` |
| `data.color` | `X-EIGEN-COLOR:#rrggbb`, copied from the stored resource on a PUT that stripped it. Not RFC 7986 `COLOR`, which takes CSS3 names where Eigen stores hex, so the standard mapping would round-trip a lie. |
| `createByUserId` | `X-EIGEN-CREATED-BY:<userId>` |
| `createdAt`, `updatedAt` | `CREATED` and `LAST-MODIFIED`, which the serializer already writes and the parser starts reading. `eventCtag` is regenerated sync bookkeeping the index owns, not a file fact. |

**Server-owned properties are re-stamped on PUT.** A CalDAV client may not know or may strip `X-EIGEN-*`. Incoming server-owned values are never trusted, including on resource creation: discard them before copying the trusted `X-EIGEN-ID`, `X-EIGEN-ORGANIZER-USER`, `X-EIGEN-ORGANIZER-EVENT`, `X-EIGEN-COLOR` and `X-EIGEN-CREATED-BY` from the stored VEVENT with the same UID (and per override, the same `RECURRENCE-ID`), or issuing new ones. Re-stamping preserves identity; it does not replace the attendee-side field restrictions `updateEvent` enforces. Serialization can also change folding, casing and quoting, so a PUT whose stored representation differs from its body omits validators from the response and the client re-reads the stored bytes and their hash ETag ([RFC 9110 § 9.3.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.4), [RFC 4791 § 5.3.4](https://www.rfc-editor.org/rfc/rfc4791.html#section-5.3.4)).

**The edit lock stays the address rule, and a stamp is not a permission.** `isInvitationFromOthers` keeps its job on both sides of the wire: an event is someone else's invitation exactly when a stored `ORGANIZER` address is not the Home owner's. `X-EIGEN-ORGANIZER-EVENT` and `X-EIGEN-ORGANIZER-USER` carry only the link, so `findLinkedEvent` and the RSVP relay survive a rebuild. They are set from the trusted message fields (the relay envelope, `external_<email>` for iMIP) and never from a received body, and on a PUT they come from the stored resource. Identity classification and permission to edit organizer fields stay separate questions.

### 4 — Parse and serialize through ical.js, both ways

`ical-parse.ts` already parses with ical.js. The hand-written serializer is replaced by building or mutating an `ICAL.Component` and calling `toString()`, so an Eigen-side edit of a client-created event changes only the properties it touches and leaves the rest as the client wrote them. `vtimezone.ts` stays; its output is inserted as a `VTIMEZONE` component. Line folding, escaping and parameter quoting become ical.js's problem instead of ours.

The index projection (`indexResource(uri, bytes)` from § 1) is `parseIcs` followed by the existing row mappers; `parseIcs` grows the `X-EIGEN-*` readers and drops nothing it does not need, because it no longer has to. The parse-time degradations (`isOutOfRangeRecurrenceStart`, `isSubDailyRrule`) keep applying to the projection only and set `hasUnindexedRecurrence` where they bite; the file keeps the client's bytes.

**Both invitation transports stay projected.** `serializeEventForImip` keeps its `CalendarEvent` input and the relay payloads keep their projected fields, so no stored bytes cross a Home boundary in either direction and no local stamp can leak into an external organizer's mailbox. The receiving Home builds its own file from the payload and stamps the link from the envelope (§ 3). There is no scheduling-ICS builder and no ICS on the relay. A test pins that no outgoing iMIP message, relay message or export carries an `X-EIGEN-` line.

The `caldav-roundtrip.test.ts` suite stays the gate for the parse side. A new fidelity test PUTs a VEVENT full of properties Eigen does not model (`ATTACH`, `CATEGORIES`, `X-APPLE-STRUCTURED-LOCATION`, an `AUDIO` `VALARM`, `RDATE`), edits the title through the real edit dialog, and asserts the GET body still carries every one.

### 5 — The `Calendar` write path

Every mutation runs the § 1 sequence under a one-slot per-`Calendar` write lock (one `Semaphore(1)` per Home calendar service, the scope contacts uses):

```
drainDirty()                            already inside the lock; do not reacquire it through ensureDrained()
load stored component (if any)          the file for this resource, or a fresh VCALENDAR
mutate                                  set only the properties this mutation changes; re-stamp X-EIGEN-*
serialize                               ICAL.Component.toString() with VTIMEZONEs
recordPendingWrite(calendarId, uriKey)  journal row
writeResourceFile                       temp → fsync → rename → directory fsync
commitResource(calendarId, uriKey, ...) one transaction: resource row + its event rows, ctag bump, tombstone clear, pending clear
  on failure: markDirty(key), rethrow
```

`commitResource` is the single index-write seam. It replaces *all* rows of that resource (master plus overrides and exclusions) with the freshly projected set, so an override the client removed is absent from the new projection. Cross-home writes (`receiveInvitation*`, `removeInvitation`, `rsvpForOccurrence` on the organizer's copy) are ordinary mutations on the *recipient's* `Calendar` and go through the same seam there.

**Filesystem first, database second.** Every single-resource write and delete touches the file before the index, the order `purgeCard` uses, and a crash between the two is recovered by the reconcile's vanished-file and new-file branches rather than by a new mechanism. `deleteEvent` records the pending write, unlinks, then commits tombstone + row delete + ctag + pending clear in one transaction.

**Deleting a calendar renames its directory first.** `deleteCalendar` renames `<calendarId>` to `.<calendarId>.deleting-<uuid>` — a leading dot, so `sanitizeCalendarId` can never produce it and no reconcile pass adopts it — fsyncs the parent, commits the row delete, then removes the directory, with an init sweep for leftovers. Before the rename there are both a directory and a row; after it there is nothing left to resurrect, which is what keeps § 8's recreate rule off a half-finished delete. CalDAV `DELETE` on a collection reaches the same method.

**`moveEvent` is one rename.** Both calendar directories sit on one filesystem, so the move is a single `rename` under the ordinary journal with both keys recorded, never a copy and never two files. Recovery drops vanished keys before it indexes new ones, so the id inside the file survives the window and § 6's "an id already claimed is a copy" rule cannot fire on it. There is no `pending_moves` table.

**A refused directory fsync logs and continues.** `rename`, `unlink` and `delete` go through `syncDir`, and contacts gains that at one fsync per delete. On NFS, CIFS and some FUSE mounts the fsync is refused; the calendar path warns and carries on, as the mail delivery path does, because failing an operation that already happened is worse than the degraded guarantee.

**An HTTP save is a patch; a CalDAV PUT is a full replace.** The edit dialog submits title, times, `allDay`, description, location, `rrule`, `timezone` and the whole `data` on every save, and stamps `viewerTimeZone()` onto a zone-less event (`apps/calendar/src/components/edit-event-dialog.tsx`, `doSave`). Writing all of that into the stored component would rewrite an `RRULE` from a projection that nulls preserved sub-daily and out-of-range rules, rebuild rich `VALARM`s from a `{type, minutes}` pair and drop every `ATTENDEE` parameter the projection does not model. So `Calendar.updateEvent` compares each submitted field with the **index row** — which *is* the projection of the file, so the diff costs no re-parse — and opens the component to write only the properties whose value changed. The precedent is in that method already: it keeps the stored `organizer` and `organizerEventId` whenever the call carries a `user`, because those are server-owned and absent from the HTTP schema. Two carve-outs: never write `RRULE` when the incoming value is null and the component holds one, and replace the `VALARM` set only when the projected reminder list differs. An attendee edit touches that attendee's property (`PARTSTAT`, `ROLE`, `CN`) or adds and removes whole properties, never re-emitting the list. `SEQUENCE` bumps only when a scheduling-significant property changed (`DTSTART`, `DTEND`, `RRULE`, `EXDATE`, `STATUS`, the attendee set) **and** the event has attendees **and** the actor is the organizer; `LAST-MODIFIED` and `DTSTAMP` bump on every change of bytes; `CREATED` never moves.

**Calendar bytes count against the Home quota.** Nothing meters calendar storage today, and the import ceiling is per call rather than per Home. Files give a number to meter, so the store tracks its bytes the way `Contacts` tracks `cardsBytes`: a write over quota is refused with the answer contacts gives, and an inbound invitation over quota is not stored, while the iMIP mail still arrives.

Every public method becomes `async`, so every caller listed in [Current state](#current-state-recap) needs an await/return audit: TypeScript catches many value-use errors, but not every ignored Promise or async callback passed to a void-returning API. Internal calls also need a non-reentrant lock boundary; propagation retains explicit failure handling and runs after the local commit and lock release.

### 6 — Reads and ids

Healthy REST reads remain index-only: `getEventsInRange`, `getEventsByUid`, `getEventsWithAttendee`, free/busy redaction and recurrence expansion use `events`. Recovery through `ensureDrained()` can read files. CalDAV GET and every REPORT requesting `calendar-data` must read the stored resource, not regenerate it from rows; metadata-only REPORTs remain index-only. A resource read returns bytes and ETag from the same committed revision, including when a write is in flight.

**Ids stay random UUIDs and live in the file.** `X-EIGEN-ID` is the identity the index, the routes, the FE and every `organizerEventId` link use, so a rebuild reads the same ids back and nothing that holds one goes stale. A rebuild that meets an id already claimed by another file in the same Home (a hand-copied file) treats the second as a copy: it mints a fresh id, rewrites the file and logs it.

**Resource identity is `(calendarId, uriKey)`, separate from event-row identity.** One `resources` row per file with `events` rows hanging off it, so no row *is* the resource and an override-only resource — which [RFC 4791 § 4.1](https://www.rfc-editor.org/rfc/rfc4791.html#section-4.1) allows — is ordinary rather than representable by accident. The unique `(calendarId, uid)` makes a UID single-resource per calendar. A PUT whose UID is already stored under a different `uriKey`, and a PUT that changes a stored resource's UID, are refused **inside the write lock** with `409` and a `CALDAV:no-uid-conflict` body naming the conflicting `DAV:href`. CardDAV gets the same answer in the same pass; it emits a bare `<CARD:no-uid-conflict/>` at 412 today.

**An inbound REQUEST for a stored UID is adopted in place, never twinned.** Inbound iMIP looks its UID up across the whole Home. A stored resource that is not already a linked copy is adopted — same name, same id, stamped `X-EIGEN-ORGANIZER-EVENT` and `X-EIGEN-ORGANIZER-USER` — only when the organizer it carries matches the DKIM-aligned sender: the `X-EIGEN-IMPORTED-ORGANIZER` line for an imported event, the stored `ORGANIZER` otherwise. Any other REQUEST for a UID the Home already holds is dropped, so a second master under one UID is never written.

### 7 — CalDAV surface after the move

`caldav/resource.ts` becomes a thin protocol adapter. GET serves the stored bytes and quoted hash ETag. PUT bounds and validates the resource, then passes the bytes, actor and conditional headers to `Calendar.putResource`; DELETE passes its preconditions to the store too. The store checks `If-Match`/`If-None-Match`, the § 6 conflicts and the linked-copy edit restrictions, and re-stamps server-owned properties **inside the write lock**, against the revision it will replace; handler-side checks would race once file writes introduce awaits. `syncExceptionEvents` is replaced by one resource-level projection commit, and `report.ts` selects from the index but reads files whenever `calendar-data` is requested.

**The sync token gains a generation: `urn:eigen:sync:<gen>-<ctag>`**, the grammar `carddav/xml-builder.ts` already uses. CalDAV's `formatSyncToken` carries only a ctag today, with a comment saying the CalDAV index is never rebuilt, which is exactly what this move ends. A token of another generation gets the `<D:valid-sync-token/>` 403 both reports already give a token they cannot honor, so only the grammar and the comparison are new.

**A time-range REPORT over-reports rather than under-reports.** `getRawEventsInRange` stays index-only, and every row flagged `hasUnindexedRecurrence` is returned for every time-range query on its calendar. [RFC 4791 § 7.8](https://www.rfc-editor.org/rfc/rfc4791.html#section-7.8) requires a `DAV:response` for each object that matched the filter and does not forbid extra ones, while the occurrence expansion the same section asks for is precisely what Eigen cannot do for a rule it does not index, so a superset is the only index-only answer that never loses an event. The web calendar keeps showing such an event as the single occurrence it projects.

**A CalDAV PUT still sends no invitations.** `handlePut` passes no `user` to `createEvent`/`updateEvent` today, so a PUT never fans out, and that stays true here: turning it on sends real mail and belongs in its own change with its own verification round. A test pins the behavior, and the client matrix records what Apple Calendar and Thunderbird do on their own ([Follow-ups](#follow-ups)).

### 8 — Reconcile and rebuild

`Calendar.init` runs the § 1 reconcile per calendar directory: stat-only against `resources.mtime/size`, re-indexing only changed files, dropping rows whose file is gone, and the full rebuild (rehash every file, drop tombstones, bump ctag, rotate `syncGen`) on demand. There are no fs-watchers, for the same reason contacts has none: nothing writes these files out of process, so a hand edit shows on the next open and the `(mtime, size)` compare can be trusted outright. The first open after a per-home restore is the exception to "no parse": restore does not preserve mtimes, so every file re-hashes once, and a matching hash updates the row's `mtime` without a ctag bump, a tombstone change or a `syncGen` rotation. A restore therefore costs one parse pass and no client resync.

**A generation is never reused.** Both domains call `nextSyncGen` (§ 1), which takes the greater of `stored + 1` and the wall clock in seconds, so a rebuild that finds no row still produces a generation no client has seen. Contacts computes `(book?.syncGen ?? 1) + 1` today, which yields 2 both for a first rebuild on a healthy book and for one that lost the book row; that live bug goes with the shared helper. A repeated generation would let a client feed a token from the old history into a delta computed against the new one and silently keep events the server no longer has. The rule assumes the host clock does not move backwards across the restore.

**A calendar directory with no `calendars` row is recreated from the directory.** The directory name becomes the id and the name; when that name is a UUID the calendar is called "Recovered calendar", numbered when there are several. It gets the palette default color, `visible`, not default, no shares. When no calendar of the Home ends up default, the alphabetically first takes it, because `receiveInvitation` throws without a default. Shares, names and colors are lost with the database and no per-calendar metadata file softens that; `CALENDAR.md` states it in the honest contract.

### 9 — What stays out of the file, deliberately

Calendar name, color, default flag, visibility, the share list and the recipient-side `shared_calendars` rows are calendar-level, not event-level, and stay in `calendar.db`. iCalendar has `X-WR-CALNAME`/`X-APPLE-CALENDAR-COLOR` conventions for exports, but writing them into every event file would put one fact in N places, and a sidecar per calendar would be a second source of truth for a handful of fields. The calendar-level facts are small and few, and the ones that matter to another Home (name, color, permission) already travel to the recipient's `shared_calendars` row through `propagateCalendarShare`.

## Single writer: what the three domains can share

The recovery machinery splits by what it defends against, and the split decides what can be shared.

| Need | Defends against | Mail | Contacts | Calendar |
|---|---|---|---|---|
| Atomic write (temp → fsync → rename → directory fsync) | a torn file | owed ([ROADMAP.md](../ROADMAP.md), Maildir durability row) | `writeAtomic` | `writeAtomic` |
| One-slot write lock | two in-process writers interleaving | `Semaphore(1)` per store | `Semaphore(1)` per book | `Semaphore(1)` per `Calendar` |
| Pending-write journal, dirty set, fail-closed read gate | the API dying between the file write and the index commit | none; the delivered file is the intent and the next full scan indexes it | yes | yes |
| Stat-only reconcile on open | a missed index commit, a hand edit | no; full readdir diff instead | yes | yes |
| `fs.watch` plus full readdir diff | a foreign writer (Dovecot) | yes | no | no |
| Per-resource hash ETag, ctag, `syncGen` | DAV sync clients | none (IMAP has UIDs, and they are Dovecot's) | yes | yes |
| Full rebuild from files | a lost index | yes, with one exception for fast-saved drafts ([IMAP.md](../IMAP.md)) | yes | yes |

So the domains are consistent at three levels, and only the last one is per domain:

1. **The contract.** Standard files are the truth, SQLite is an index that rebuilds from them, and each domain's doc states in one table what the database owns that the files cannot reproduce (the "honest contract" in [CONTACTS.md](../CONTACTS.md)).
2. **The primitives.** `LocalFilesystem.writeAtomic`, `syncDir`, `Semaphore(1)`, `ManagedDatabase`, one path-segment validator for client-chosen names, and shared FE/BE byte ceilings.
3. **The store.** Contacts and calendar share `core/indexed-file-store.ts`. Mail keeps `MaildirStore`, whose on-disk protocol is Maildir++ and whose second writer is a fact of IMAP.

A single writer makes the calendar design cheaper in three places: no watcher coherence, no races against an external mutation, and a reconcile that can trust `(mtime, size)`.

## Files everywhere: import, export and quick look

A standard file that belongs to a domain gets six verbs wherever it turns up, through one `FileSubject` and one `FILE_ACTIONS` registry: a quick look in Drive, as a mail part and in chat and cards; an import; an export of one item; an export of the collection. `.vcf` set the pattern ([PREVIEWS.md](../PREVIEWS.md), [CONTACTS.md](../CONTACTS.md)) and `.eml` and `.ics` follow it. State today:

| | Quick look (Drive, mail part, chat) | Import into the domain | Export one item | Export the collection |
|---|---|---|---|---|
| `.vcf` | yes | yes (`/contacts/:ownerId/import`, `import-from-drive`) | yes | yes (`/contacts/:ownerId/export`) |
| `.eml` | yes | yes (`/mail/:ownerId/import`, `import-from-drive`) | yes (`/mail/:ownerId/message/:id/download`) | no |
| `.ics` | yes | yes (`/calendar/:ownerId/import`, `import-from-drive`) | no | no |

So the `.ics` gap is export, and export is where the storage move pays. Today the only `.ics` egress is CalDAV GET and it is lossy, so an export route built now would ship a lossy artifact and be rebuilt later. With the file as the truth, exporting one event is a byte copy of its resource and exporting a calendar is a concatenation of VEVENTs and VTIMEZONEs under one VCALENDAR; both strip every `X-EIGEN-*` property, pinned by the test that guards the invitation transports (§ 4).

Import gains too. Today an import drops `data.organizer` and `data.attendees`, because a stored organizer locks the event and an organizer-less event with attendees mails a REQUEST on the next edit to a list the file's author chose. With the component in the file, an import keeps every line except scheduling: `ATTENDEE` lines are dropped and `ORGANIZER` becomes one inert `X-EIGEN-IMPORTED-ORGANIZER` (§ 3), so the imported event is a plain own event, and a later genuine invitation for the same UID is adopted in place rather than twinned (§ 6). Import targets stay the Home's own calendars; team and shared calendars stay ROADMAP rows, because both are cross-home writes.

## Performance invariants

- **Healthy range and occurrence reads are index-only.** REST range/free-busy reads, metadata-only REPORTs and time-range REPORTs avoid file reads; recovery and REPORTs requesting `calendar-data` do not. An edit diffs against the index row, so it too parses nothing.
- **One write is one file plus one transaction.** A mutation touches exactly the file for its resource and the rows of that file. A calendar with 10k events costs the same per edit as one with 10.
- **Reconcile on open is stat-only.** One `readdir` per calendar directory, one `stat` per file and an `(mtime, size)` compare against `resources`; no parse unless a file changed. A cold open of a 10k-event calendar is 10k stats and one indexed query, the same shape contacts has. The first open after a restore re-hashes every file once (§ 8).
- **The write lock is per `Calendar`, not global.** Two Homes never wait on each other; a fan-out to 26 attendees takes 26 independent locks.
- **Typical files are small, not guaranteed small.** Preserved inline `ATTACH` data and large exception sets can approach the 20 MiB PUT limit. Bound serialized size and projection work on every ingress path, including iMIP and reconciliation, before journaling or touching the filesystem. Per-Home total storage is the quota of § 5; REPORT output is budgeted separately.

## Phased rollout

| Phase | Scope | Gate |
|---|---|---|
| 0 | Extract `core/indexed-file-store.ts` from contacts; refit contacts onto it. Then, as separate units, the `nextSyncGen` fix and the CardDAV `no-uid-conflict` href. No calendar changes. | Contacts + CardDAV suites green, byte-identical vCard behavior on the extraction itself, `CONTACTS.md` pointer updated. Own branch, merged before phase 1 starts. |
| 1 | Storage relayout: new `calendar.db` version, `<calendarId>/<uri>` files, the `resources` table, ical.js serializer, `X-EIGEN-*` mapping, the patch-vs-replace edit rule, `Calendar` write seam + async ripple, recovery ordering, reconcile/rebuild, quota metering. CalDAV still regenerates through the parsed rows. | `test/calendar/{calendar,calendar-invites,calendar-timezone,team-calendar-share}.test.ts` and `test/caldav/ical-imip.test.ts` green against the new store; a new `test/calendar/calendar-store.test.ts` covering torn-write recovery, reconcile-on-open, rebuild + `syncGen` rotation, calendar-delete and move recovery, and id preservation across both. |
| 2 | CalDAV serves and stores bytes: verbatim GET, hash ETag, `putResource`, re-stamp on PUT, `<gen>-<ctag>` sync tokens, the UID 409 with its href, `hasUnindexedRecurrence` in time-range selection, `resource.ts` simplification. | `test/caldav/{caldav,caldav-roundtrip,caldav-client-sync}.test.ts` green; the fidelity test from § 4; a test pinning that a PUT sends no invitations. |
| 3 | Real-client verification against the local Docker edge ([docker/LOCAL-TESTING.md](../../docker/LOCAL-TESTING.md) § Testing CalDAV): macOS/iOS Calendar, Thunderbird, DAVx⁵. Create, edit, delete an occurrence, undo-delete, RSVP, a client-side alarm, a moved series, an organizer-side event with invitees created from the client, a non-ASCII resource name, and a real external invitation answered from each client. | A written matrix in the branch report with the observed round-trip bytes per client, and what each client mails by itself. Docs pass: `CALENDAR.md` § Storage and § CalDAV, the `STORAGE.md` layout tree, the [ARCHITECTURE.md](../ARCHITECTURE.md) § Backend storage row, the ROADMAP rows this work closes. |

Phases are sequential. The original estimate was roughly two weeks of agent time; re-estimate once phase 0 has measured the extraction.

## Verification gate

Before the branch is called done:

- `bun run check` green, including the new store and fidelity tests.
- A PUT/edit/GET fidelity probe with a kitchen-sink VEVENT shows semantic preservation of unedited properties, parameters and subcomponents. GET bytes equal the stored file and match its ETag; REPORT `calendar-data` carries the same resource. The edit runs through the real edit dialog. A sub-daily `RRULE` survives in the resource while the index still holds one occurrence, and the resource still comes back from a time-range REPORT.
- Kill the API between the file rename and the index commit (an `EIGEN_STORAGE_FAULT`-style dev hook, see `storage/fault-storage.ts`) and confirm the next open re-indexes the file, serves it, and the ETag matches the bytes. Repeat for a calendar delete and an event move.
- `rm calendar.db`, restart, confirm every event, exception and occurrence is back under its old id, that the calendars return under their directory names with "Recovered calendar" where the name was a UUID and one of them default, and that a connected CalDAV client resyncs in full rather than ghosting deletions.
- An organizer edit on a linked-invitation event PUT by a client that stripped `X-EIGEN-*` still propagates, and the linked copy still refuses attendee-side edits of organizer fields.
- Each phase's review runs under the Review Standard in [WORKING-METHOD.md](../WORKING-METHOD.md).

## Risks and caveats

- **eigen.is is live.** The version bump empties every user's calendar on deploy. Pick the moment and announce it; the decision to drop the data is made, the timing is not.
- **The async ripple changes ordering as well as types.** Review ignored Promises, nested public calls, read/write snapshots and propagation after commit; TypeScript alone cannot prove these safe.
- **Clients that rewrite the whole VEVENT.** Apple and Thunderbird preserve unknown properties; some clients (older Outlook connectors, some Android apps) re-emit only what they know. The re-stamp rule in § 3 protects Eigen-owned state; anything else a client drops is that client's behavior, and today it is dropped by us regardless.
- **A client that strips `X-` properties loses exclusion sequences.** The `EXDATE` survives, so the occurrence stays hidden, but the next projection falls back to the master's sequence — what the parser does today — and a stale redelivered CANCEL can then re-hide an occurrence a newer REQUEST restored.
- **The id lives in the file.** `X-EIGEN-ID` is the only identity, so the re-stamp rule is load-bearing: a PUT that reaches the store without it would mint a new id and orphan every link. The re-stamp runs inside `putResource`, not in the DAV handler, so no second writer can skip it.
- **Phase 1 does not meet the final fidelity contract.** CalDAV still serves a regenerated representation rather than the stored bytes, and a file hash is a valid strong validator only if every change to that representation also changes the validator. Storage and DAV read cutover therefore deploy together.
- **Feed snapshots need their own commit contract.** [PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md) was written against one row transaction. One lock acquisition, N file writes and one SQLite commit do not make an atomic snapshot across a crash.
- **The rebuild pass inherits the TZID parse cost.** `parseIcs` is superlinear on a file naming a TZID it does not define, because ical.js caches a lookup hit and never a miss. A rebuild parses every stored file, so the miss memo of that ROADMAP row should land with this work.
- **Calendar search** ([SEARCH.md](../SEARCH.md) § Remaining) is unaffected: an `events_fts` table over the index is derived data and rebuilds with it.

## Follow-ups

- **Carry the stored component in invitations if a CalDAV PUT ever fans out.** Both transports stay projected (§ 4) because nothing unmodeled reaches an event with guests today. A PUT that fans out would be the first source of one, and that is when cross-home fidelity becomes worth a strip-at-one-boundary builder. ROADMAP row.
- **A client PUT that changes only the own `PARTSTAT` on a linked copy should be an RSVP.** Phase 3 observes it before anything is built: if Apple Calendar and Thunderbird mail their own REPLY to a server without scheduling, nothing is needed; if they do not, the finding goes to Reinder with the matrix rather than a blind fix.
- **The alias and team-calendar lock rows stay in ROADMAP.** `isInvitationFromOthers` answers by address; no alias list exists and a team Home has no address of its own, so an event organized from an alias, and one a member organizes on a team calendar, stay locked. What a team's "own address" is, is a permission decision rather than a lookup.

## Settled design questions

| Question | Answer |
|---|---|
| An `EXDATE` carries no sequence, so what keeps a cancelled occurrence's replay guard? | One `X-EIGEN-EXDATE;X-EIGEN-SEQ` beside each `EXDATE`, falling back to the master's sequence; no per-exclusion id, because nothing holds one (§ 3). |
| What is a resource, when RFC 4791 allows override-only ones and an external UID must never name a file? | `(calendarId, uriKey)` in a `resources` table with `events` rows hanging off it; Eigen mints `<uuid>.ics`, a client name is validated or 400, and a duplicate UID is a 409 `no-uid-conflict` with its `DAV:href` in both protocols (§ 2, § 6). |
| What order survives a crash, when a delete and a move touch both a directory and the database? | Filesystem first, database second, recovered by the reconcile: a calendar delete renames its directory to a dotted, never-adoptable name before committing, a move is one rename under the ordinary journal, and every name change fsyncs its directory (§ 5). |
| How does a generation held only in a lost database become a new one? | `nextSyncGen(stored) = max(stored + 1, unix seconds)`, shared with contacts, and a `urn:eigen:sync:<gen>-<ctag>` token. A directory without a row is recreated from its name; shares, names and colors are lost (§ 7, § 8). |
| How does an edit avoid writing the lossy projection back over the component? | An HTTP save is a patch, a PUT a full replace: `updateEvent` diffs against the index row and writes only what changed. Time-range selection stays index-only and over-reports `hasUnindexedRecurrence` rows (§ 5, § 7). |
| What crosses a Home boundary, and what decides that an event is someone else's? | Both transports stay projected and the receiving Home builds its own file (§ 4). The lock stays `isInvitationFromOthers`; the organizer stamps carry the link only, from trusted message fields (§ 3). |
| Which of contacts' contracts does calendar inherit? | None implicitly: the extraction is zero-behavior-change, the two contacts fixes land after it, and calendar states its own failure policy and read boundary (§ 1, § 6). |

## Two-step option: `icsBlob` first, files later

**Not chosen.** The route is files directly. Step 1 would not have saved the hard work (component editing, the stamps, per-exclusion state and the patch-vs-replace edit rule are needed either way), it would have changed the storage under live CalDAV clients twice with a real-client verification round each time, and its two advantages are available without it: existing data could have been kept by a one-off conversion at the version bump (offered and declined, see Decisions), and staying synchronous only postpones the async flip. The section stays as the record of the alternative.

Step 1 makes the raw ICS bytes the truth inside `calendar.db`: one VCALENDAR per UID in `icsBlob` on the master row, columns as the index over it. The stamps, the ical.js round-trip serializer, in-place component editing, and CalDAV GET serving the bytes verbatim with a hash ETag are all built exactly as in the file design. What it does not need: phase 0, the file store, the stat reconcile and rebuild pass, `syncGen` rotation, the recovery ordering of § 5, and the async flip. Backward compatibility would have been nearly free, because the column already exists and is NULL on every row. Step 2 would have written each blob out as `eigen.calendar/<calendarId>/<uri>` in a loop. Rough relative effort, unmeasured, from a sizing against the contacts build: the file design is about 8 to 11 agent-sessions and step 1 alone about half that. What step 1 gives up until step 2: standard `.ics` files an operator can read, back up or move without Eigen, and the symmetry with mail and contacts.

## Decisions

Reinder's rulings:

- **Files directly.** No `icsBlob` intermediate step. Mail, contacts and calendar follow one contract: standard files are the truth, SQLite is the index, and a loose `.ics`, `.eml` or `.vcf` can be previewed, imported and exported wherever it turns up.
- **No one-off conversion either.** Serializing today's rows to files at the version bump was offered as a cheap way to keep events and their ids, and declined: the drop stands. Linked invitation copies in other Homes lose their organizer event along with everything else, the same fresh start every calendar gets.
- **No backward compatibility (2026-09-03).** Existing calendar data is dropped by a `calendar.db` version bump that recreates the schema. No migration, no export, no dual read.

Design decisions of this proposal (2026-09-03, revised on review; the storage questions settled 2026-09-21):

- **One file per UID**, master plus overrides plus VTIMEZONEs, under `eigen.calendar/<calendarId>/<uri>`, named `<uuid>.ics` when Eigen mints it and kept verbatim when a validated client chose it.
- **Resource identity is `(calendarId, uriKey)`** in its own `resources` table; `events` rows hang off it, and a UID is unique per calendar with a 409 `no-uid-conflict` carrying its href.
- **Eigen-owned per-event state rides in the file** as `X-EIGEN-*` and is re-stamped on PUT; calendar-level state stays in the index, and there is no per-calendar metadata file. Ids stay random UUIDs read back on rebuild; exclusions carry a sequence but no id.
- **The edit lock stays `isInvitationFromOthers`**, the address rule; the organizer stamps carry the link only and come from trusted message fields.
- **Both invitation transports stay projected.** No scheduling-ICS builder, no bytes on the relay.
- **An HTTP save is a patch, a CalDAV PUT is a full replace**, and a CalDAV PUT sends no invitations.
- **Filesystem first, database second**, with the reconcile as recovery, a dotted rename for a calendar delete, one rename for a move, and `syncDir` on every name change.
- **One `nextSyncGen` for both domains**, and `urn:eigen:sync:<gen>-<ctag>` for CalDAV.
- **`data.notes` is removed** from `EventData` and the route schema; **`data.color` rides as `X-EIGEN-COLOR`**. **Calendar bytes count against the Home quota**, the way `cardsBytes` does.
- **Extract the file+index core from contacts first** (phase 0) rather than clone it. Two consumers, contacts and calendar; mail is not one. **`Calendar` goes async.**

## Open questions

- **What the index does with client `VALARM`s.** Nothing in Eigen fires alarms today (no scheduler job, the calendar app does not read `reminders`), so the projection is bookkeeping. Proposal: keep the current `{type, minutes}` projection for `DISPLAY`/`EMAIL` alarms with a `-PT<n>M` trigger and ignore the rest; revisit when something consumes it.
