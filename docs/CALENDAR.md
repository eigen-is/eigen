# Calendar & CalDAV

> **TLDR**: A calendar resource **is** its VCALENDAR bytes, and those bytes live in `calendar.db` — the `ics` BLOB of its `resources` row, written in the same transaction as the `events` rows that project it. The blob is the truth; every other column is a projection of it and rebuilds from it. A CalDAV GET therefore returns the exact bytes a client PUT, unknown properties, `VALARM` details and all, and the ETag is the hash of those very bytes. `apps/api/src/lib/caldav/` serves RFC 4791 at `/dav/calendars/:ownerId/:calendarId/`, the CardDAV twin plus recurrence and timezones. Sharing is push-based at `free-busy`/`read`/`write`; team calendars are off until an admin enables them. The same store speaks **iMIP** (RFC 6047) for off-server invitations. The domain lives in `apps/api/src/lib/calendar/`, the format in `apps/api/src/lib/ical/`.

## Storage model

```
eigen.calendar/
  calendar.db      ← the resources themselves (one VCALENDAR per row as a BLOB) + the calendar metadata
```

Per Home, not Drive: `data/home/{userId}/eigen.calendar/` and `data/team/{teamId}/eigen.calendar/`. Like contacts and unlike mail, every write goes through the API process; nothing else opens this database, so there are no fs-watchers and nothing to reconcile.

**One resource is one series.** The stored bytes hold that UID's master VEVENT, one override VEVENT per stored exception, and the VTIMEZONE block of every TZID those events reference. A cancelled occurrence rides as an `EXDATE` on the master, never as a `STATUS:CANCELLED` override VEVENT (Thunderbird omits those from its next PUT, and a full-replace prune would read that as "the client removed the exception" and resurrect the occurrence). A PUT carrying two UIDs is refused.

**Names.** Eigen mints `<uuid>.ics` for every resource it creates — a REST create, an import, an inbound invitation — because a UID is its author's string and may carry `/`, `..` or quotes. A CalDAV client's chosen name is kept verbatim: `sanitizeEventUri` is `sanitizeResourceUri(raw, '.ics')` (`lib/core/blob-store.ts`), which NFC-normalizes and then applies `isSafePathSegment` (`lib/core/path-utils.ts`, the one rule CardDAV resource names, calendar ids and mail draft ids all take) plus the `.ics` suffix; anything else is a 400. A uri is unique **as written** within its calendar, and NFC is the only fold there is, because macOS clients send the same name in NFD form in a URL. Case is not folded: a PUT under a case variant of a stored name creates a second resource.

**A calendar id is a row id**, client-chosen through MKCALENDAR, sanitized by the same predicate (`sanitizeCalendarId`) and unique as written — `calendarIdTaken` is an exact match, so `Work` and `work` are two calendars. A create is one insert inside the write lock, so two creates of one id cannot both read the name as free.

**What a calendar may be called.** `validateCalendarProps` (`calendar.ts`) is the one rule `createCalendar` and `updateCalendar` hold, so REST, MKCALENDAR and PROPPATCH all inherit it rather than each spelling their own: a trimmed name longer than `CALENDAR_NAME_MAX_LENGTH` (200, shared FE/BE in `packages/lib/src/constants/calendar.ts`) is a 400, and so is a color that is not a `#` followed by three, six or eight hex digits — Apple writes the eight-digit form, so all three lengths are valid.

### What lives in the stored bytes

Everything an author wrote, plus the per-event state Eigen owns, which rides as `X-EIGEN-*` properties inside the VEVENT (`EIGEN` in `lib/ical/ical-parse.ts` is the one spelling of every name; ical.js lowercases them).

| Line | Carries | Who sets it |
|---|---|---|
| `X-EIGEN-EVENT-ID` | the `events` row id of this VEVENT | every write; minted when no stored resource claims one |
| `X-EIGEN-CREATED-BY` | the user id that first wrote the resource | the acting user of a create, or of a PUT nobody wrote before |
| `X-EIGEN-ORGANIZER-EVENT` | the organizer's own event id, on an attendee's linked copy | `stampInvitationLink`, from the relay envelope or a DKIM-aligned iMIP sender |
| `X-EIGEN-ORGANIZER-USER` | that organizer's owner id (`external_<address>` for an iMIP sender) | the same, never the body |
| `X-EIGEN-COLOR` | the per-event color, which iCalendar has no home for | an HTTP save |
| `X-EIGEN-IMPORTED-ORGANIZER` | the `ORGANIZER` address an imported file was filed under | the import, once, on a resource nobody wrote before |
| `X-EIGEN-EXDATE;X-EIGEN-EVENT-ID=<id>;X-EIGEN-SEQ=<n>[;X-EIGEN-DTSTAMP=<utc>]` | one per `EXDATE`: the value is that occurrence's recurrence key, the parameters its exclusion row's id, its SEQUENCE, and the stamp of the message that cancelled it | `addExclusion`, and `restampResource` for an `EXDATE` a client wrote |

**Incoming stamps are never trusted.** `parseIcs` is the untrusted reader and its result type cannot name a single `X-EIGEN-*` fact, so a forged event id, creator, color or organizer link has nowhere to land and `data.organizer.userId` comes back empty. `restampResource` strips every `X-EIGEN-*` property **and parameter, at every level, group prefixes included** (`stripEigenStamps`), then copies the server-owned lines back from the **stored** resource, matched on UID plus recurrence key — never by string equality on a `RECURRENCE-ID` or an `EXDATE` value, both of which clients rewrite freely between TZID, UTC and comma-joined forms. One stored id belongs to one VEVENT: a second claimant gets a fresh one. A resource nobody wrote before is the only one that takes the caller's own trusted stamps. `stripEigenStamps` also runs on the iMIP body; the whole-file export, the other place a `.ics` leaves the Home, drops the same lines a different way — it splices the stored text and skips every line whose property name `isEigenName` recognizes (`lib/ical/blocks.ts`), because a spliced file is never re-serialized. A CalDAV GET serves the stamps to the owner's own clients on purpose.

### Schema (`schema.ts`)

| Table | Role |
|---|---|
| `calendars` | **Database-only.** `name`, `color`, `isDefault` (the auto-created primary, cannot be deleted), `visible`, `shares` (JSON `CalendarShare[]`), `ctag` (bumps on any resource change, the CalDAV collection tag) and `syncGen` (clock-seeded when the row is created, so a calendar recreated at a deleted id never reissues a generation a client has seen) |
| `resources` | One row per stored resource: `id`, `calendarId`, `uri`, `uid`, **`ics`** (the stored bytes — the truth), `etag` (SHA-256 of those bytes), `resourceCtag` (the calendar's ctag at this resource's last change — the sync-delta key) and `hasUnindexedRecurrence`. Unique on `(calendarId, uri)` and on `(calendarId, uid)` |
| `events` | One row per VEVENT **and per exclusion** of a resource, the resource's own facts projected: the identity (`uid`, `sequence`), the times (`startTime`, `endTime`, `allDay`, `rrule`, `timezone`), `status`, `title`/`description`/`location`, `data` (JSON: reminders, attendees, organizer, url, color), the recurrence-exception link (`parentEventId` + `recurrenceDate`) and the invitation link (`organizerEventId` + `organizerUserId`) |
| `resource_tombstones` | `{calendarId, uri, deletedAtCtag}` — the sync-collection 404 rows, keyed on `(calendarId, uri)`, so a resource re-created under a deleted name drops its own removal and no href is ever both a 200 and a 404 in one delta |
| `shared_calendars` | **Database-only**, recipient side: `ownerUserId` + `calendarId` point back at the owner's row, `calendarName`/`calendarColor` are cached copies, `permission` is the resolved level, and `color`/`visible` are the recipient's local overrides |

`CALENDAR_DB_CONFIG` (`db-config.ts`) is at `currentVersion: 2`. v2 carries `calendars` and `shared_calendars` over — the only rows no resource's bytes hold, and the ones other Homes point at through a share grant — reshaping each in place through an `INSERT … SELECT` that re-seeds every carried `syncGen` from the clock, so every sync token minted before it is refused; everything else v1 created is dropped and recreated in the blob shape. The config also sets `synchronous: 'FULL'` ([DATABASE.md § Pragmas](DATABASE.md#pragmas)): the resources themselves live in these rows, so an acknowledged CalDAV PUT must survive a power loss.

### Projection, and what is not one

| | Lives in | Rebuilds from the bytes |
|---|---|---|
| An event, its overrides, its exclusions, its alarms, and every other line its author wrote | the `ics` blob of its `resources` row | it *is* the truth — the bytes a CalDAV GET serves back |
| The event row ids, the creator, the color, the invitation link, and each exclusion's id and SEQUENCE | the `X-EIGEN-*` lines inside those same bytes | yes — which is why an event id survives a projection rebuild |
| `uid`, `etag`, `hasUnindexedRecurrence`, every `events` row | the other columns of `resources`, and `events` | yes, by `rebuildProjection` |
| A calendar's name, color, visibility, default flag, `shares`, `ctag` and `syncGen`; `resource_tombstones`; the shared-with-me list and its local overrides | `calendars`, `resource_tombstones`, `shared_calendars` | no — database-only |

`rebuildProjection` (`calendar.ts`) is the tool and the proof: it parses every resource's blob and rewrites `uid`, `etag`, `hasUnindexedRecurrence` and every `events` row from it in one transaction, leaving the ctags, the generation, the tombstones and the share grants exactly as they were. Its caller today is the test that pins the contract (`rebuildProjection` in `test/calendar/resource-store.test.ts`); the next projected column is added by altering the table and calling it.

## The write path

`Calendar` (`calendar/calendar.ts`) holds what must be one per Home — the database handle, the write lock, the byte counter and the broadcast batch — plus the calendar CRUD and the commit seams; `dav-store.ts`, `resource-store.ts`, `events.ts`, `invitations.ts`, `shares.ts`, `occurrences.ts` and `transfer.ts` are plain functions over it.

**One lock, and one line for why it exists.** bun:sqlite is synchronous, so a transaction is already atomic and serial; `writeLock` (a `Semaphore(1)`, the shape `MaildirStore.storeLock` and contacts both have) is there for the async gaps a write path holds between a check and its commit — the quota lookup, an invitation fan-out — so a racing `If-Match` PUT loses *inside* the lock rather than after it. Reads take no lock and there is nothing to drain.

**One write function, and it owns the order.** `writePrepared` (`calendar/dav-store.ts`) takes a `PreparedResource` — the serialized text, its bytes, their hash and the rows they project to, all computed once by `prepareResource` — so the bytes a refusal judged are the bytes that land. It holds both ceilings right before the commit: `EVENT_MAX_BYTES` on the bytes that would land, then `enforceHomeDataQuota` when the Home is metered, crediting the resource this one replaces. `writeResource` is the wrapper that prepares and writes in one call, which is what every event mutation goes through; a CalDAV PUT prepares first, because it has preconditions to evaluate against the prepared rows before it commits to writing them.

`commitResource` (`calendar.ts`) is the single index-write seam and one transaction: the calendar `ctag` bump, the `resources` upsert with its blob, a delete-and-reinsert of every `events` row of that resource, and the tombstone clear by `uri` (`indexResource`, `resource-store.ts`). The byte delta is read *inside* that transaction and applied to `eventsBytes` after it returns, because a rollback would otherwise leave the delta applied — the counter rule both DAV domains follow. `purgeResource` is the same shape in reverse: one transaction bumps the ctag, deletes the `resources` row (its `events` rows cascade) and writes the tombstone. A throw anywhere leaves the previous bytes readable through `getResource` and the projection exactly as it was; there is no second store to fall out of step with the first.

**Init** seeds `eventsBytes` from `SUM(length(ics))` and creates the default calendar when the Home has none, with a clock-seeded `syncGen` (`nextSyncGen(undefined, Date.now())`, `lib/core/blob-store.ts`: `max(stored + 1, now in seconds)`). Metering (`meteredIngest`) is switched on at the end, because the quota lookup goes through `getHome`.

**An HTTP save is a patch of what moved; a CalDAV PUT is a full replace.** The submitted form restates WHEN the event is on every save, so `updateEvent` (`calendar/events.ts`) diffs the submitted instants and the all-day flag against the stored row — the one reading that knows the end of an event stating a `DURATION` or no end at all — and hands `patchEvent` only the bounds that really moved. `patchEvent` (`lib/ical/ical-component.ts`) then writes a time property only when an instant or the all-day flag moved, or when the stored zone is one Eigen can name and the save names another. A save restating the same instants writes no `DTSTART`, `DTEND` or VTIMEZONE whatever zone it labelled them with, so a `DTSTART:…Z` or a client's own `TZID=` form survives a title edit. A written `DTEND` removes the `DURATION` that stated the length instead (RFC 5545 §3.6.1). A zone-only re-spelling is **not** scheduling-significant: SEQUENCE holds and no guest is mailed a reschedule. Everything else is patched property by property — an `ATTENDEE`'s own line is touched rather than the list re-emitted, so `CUTYPE`, `RSVP`, `SCHEDULE-STATUS` and every `X-` parameter a client hung on it survive an Eigen edit.

**The linked-copy rule on PUT.** A stored resource carrying `X-EIGEN-ORGANIZER-EVENT` is a copy of somebody else's event, which its holder may re-alarm and nothing more: the PUT keeps the **stored** component and adopts only the incoming `VALARM`s, matched on UID plus recurrence key and stripped of their own Eigen lines. That is the server-set stamp talking, where the web edit lock (`isInvitationFromOthers`) is the *address* rule — an `ORGANIZER` address is the client's own to spell, and Apple Calendar and Thunderbird write the account's own address on every event they create with guests.

**SEQUENCE, DTSTAMP, LAST-MODIFIED** (`touch`). `LAST-MODIFIED` is always set to now. `DTSTAMP` is set from the applying message's stamp (clamped to the receiver's clock + 24 h, RFC 5546 § 2.1.5) or from the clock — but never by a local edit on a linked copy, where `DTSTAMP` is the organizer's revision stamp the next message is ordered against. `SEQUENCE` bumps only when the change is scheduling-significant, the actor is the organizer, and the VEVENT lists attendees; a submitted `sequence` — an attendee copy mirroring the organizer's number — wins over the rule.

**Delete, move, calendar delete.** Deleting one *occurrence* is a write of its master's resource (an `EXDATE` plus its stamp), never a resource delete. Deleting an occurrence that is **already** cancelled is the inverse and puts it back: `removeExclusion` drops the `EXDATE`, and where a client cancelled that instance as a `STATUS:CANCELLED` override VEVENT rather than an `EXDATE` it removes the VEVENT, so both spellings of a cancellation undo the same way. `moveEvent` re-homes a resource inside the Home as **one transaction**: the source calendar bumps and tombstones the old uri, the target bumps, clears any tombstone on the target uri and re-points the `resources` row and its `events` rows. A uri the target already holds becomes a fresh `<uuid>.ics`; a UID the target already holds is a 409; a lone recurrence occurrence cannot be moved. `deleteCalendar` is one transaction too: the calendar's bytes are summed for the counter, the row is deleted, its resources and their event rows cascade, and its `resource_tombstones` are deleted beside them — no cascade reaches those, and a calendar recreated at the id would otherwise inherit the 404 rows.

## CalDAV surface

`apps/api/src/lib/caldav/` serves RFC 4791, mounted in `app.ts` beside `carddavRouter`. Every route is `authenticateBasic` (app password → primary-password fallback, shared `protocol-auth.ts`) + `requireSelf`.

```
PROPFIND  /dav/                                        current-user-principal
PROPFIND  /dav/principals/:ownerId/                    principal props (calendar-home-set + addressbook-home-set)
PROPFIND  /dav/calendars/:ownerId/                     calendar home (Depth 0|1)
PROPFIND  /dav/calendars/:ownerId/*                    home / one calendar / one resource (Depth 0|1)
GET       /dav/calendars/:ownerId/:calId/:uri          the stored bytes verbatim (text/calendar), quoted content-hash ETag
PUT       /dav/calendars/:ownerId/:calId/:uri          create/replace — preconditions, UID, re-stamping, ceiling, quota
DELETE    /dav/calendars/:ownerId/:calId/:uri          404 unknown · 412 stale If-Match
DELETE    /dav/calendars/:ownerId/:calId/              the calendar itself — 204 · 404 unknown · 403 the default one
REPORT    /dav/calendars/:ownerId/:calId/              calendar-query · calendar-multiget · sync-collection
MKCALENDAR/dav/calendars/:ownerId/:calId/              create at the client-chosen id — 201 + Location · 405 when taken
PROPPATCH /dav/calendars/:ownerId/:calId/              displayname + calendar-color
```

**GET is the stored bytes.** The resource *is* those bytes, so an `.ics` a client wrote comes back property for property — `VALARM` details, `ATTACH`, `RDATE`, `CATEGORIES`, unknown `X-` properties and `RANGE=THISANDFUTURE` included — with the `X-EIGEN-*` lines the store added, which the owner's own clients are the only readers of.

**PUT answers no ETag when the stored bytes are not the client's bytes.** Re-stamping and the adopted alarms both rewrite the body, so the response carries a validator only when the serialized resource equals the request body (RFC 4791 § 5.3.4); otherwise the client must re-read. A PUT of what is already stored is judged on the **bytes** the row holds, and commits nothing, so no ctag moves and no other client is sent back for a resource that never moved.

**Preconditions are evaluated inside the write lock**, against the state the write overwrites, so two racing `If-Match` PUTs serialize and the loser gets a 412. A UID another resource in the calendar owns → 409 `C:no-uid-conflict` carrying that resource's `DAV:href`; a PUT that changes an existing resource's own UID → the bare 409 element. A body over `EVENT_MAX_BYTES` (5 MiB) → 413 `C:max-resource-size`, bounded before buffering and again on the bytes that would land; the collection advertises the same number as `C:max-resource-size` so a client can size a resource first. A body that will not parse, carries a UID that is empty, over 255 characters or unprintable, or holds an event ending before it starts → 403 `valid-calendar-data`; one holding two UIDs, naming one UID twice as a master, or holding a VEVENT the parser had to skip → 403 `valid-calendar-object-resource`; one holding no VEVENT at all → 403 `supported-calendar-component`. The three preconditions are the three `InvalidReason` values `dav/write-result.ts` maps. A PUT under a calendar that does not exist → 409 (RFC 4918 § 9.7.1). A quota refusal → 507.

**PROPFIND honors the requested prop list** via the shared core in `lib/dav/propfind.ts` (the CardDAV twin uses the same): requested props we have come back in the 200 propstat, unknown ones in a 404 propstat echoing their namespace (omitted under `Brief: t` / `Prefer: return=minimal`), a bodyless PROPFIND stays allprop, and member rows carry an empty `resourcetype`. The calendar collection advertises a `C:calendar` resourcetype, displayname, the ownership props (Apple clients treat every resource as read-only without them), `ICAL:calendar-color`, `CS:getctag`, `D:sync-token`, `supported-calendar-component-set` (VEVENT), `C:max-resource-size`, and a `supported-report-set` listing exactly the three REPORTs that exist.

### The three REPORTs

- **`calendar-multiget`** — hrefs → etag + `C:calendar-data`. Hrefs are percent-decoded before matching and percent-encoded on every emission, capped at `MULTIGET_HREF_LIMIT` (500) and **deduped per resource** through `normalizeResourceUri`, so a client listing one resource under both Unicode forms cannot make us retain two copies of its bytes. Missing-but-in-collection comes back as a 404 row on the resource href, unresolvable as a 404 echoing the original.
- **`calendar-query`** — a filter naming a component Eigen does not store matches nothing; otherwise the VEVENT `time-range` is answered from the index. It **over-reports on purpose**: a resource whose recurrence the index cannot expand (`hasUnindexedRecurrence` — a stripped sub-daily or out-of-range rule, or an `RDATE`) rides along in every window rather than lose an occurrence. Every other filter element is parsed past (see Known limits), so no filter ever narrows the answer. The window itself does: the range read behind it treats a cancelled occurrence as no occurrence, so a resource whose only instance inside the window is cancelled — by an `EXDATE` or by a `STATUS:CANCELLED` override — is not matched by it.
- **`sync-collection`** (RFC 6578) — generation-stamped tokens `urn:eigen:sync:<syncGen>-<ctag>`, emitted and parsed in `lib/dav/sync-token.ts`. The delta is `resourceCtag > since` as 200 rows plus tombstones as 404 rows; the tombstone primary key and the commit's tombstone-clear together guarantee no href is both in one response. A token whose generation is stale (the calendar was recreated at the same id) **or whose ctag is ahead** of the collection → 403 `D:valid-sync-token`, sabre's status, which clients key their full resync on — an empty delta under a *lower* token would stall that client permanently.

**The byte budget.** One REPORT serves at most `REPORT_DATA_BUDGET_BYTES` (32 MiB) of calendar data. A resource past the remaining budget still gets a row, carrying its etag and a **404 propstat for `<C:calendar-data/>`** (RFC 4918 § 9.1), which the client then multigets — a silently truncated collection would lose events instead.

**Not supported** (each answered with a superset, never a refusal): the `<C:comp>`/`<C:prop>` projection of `calendar-data`, `<C:expand>`, `<C:limit-recurrence-set>`, `prop-filter` / `param-filter` / `text-match` in a `calendar-query`, and `<D:limit><D:nresults>` on a `sync-collection`. `MKCOL` creates no calendar here; `MKCALENDAR` does. OPTIONS and the `Basic realm="Eigen DAV"` challenge live in `app.ts`, one combined header for the whole `/dav` tree.

### Serialization and parsing

`ICAL.Component.toString()` is the one serializer, so folding, escaping and parameter quoting are ical.js's problem and an Eigen edit leaves every property it did not touch as the client wrote it. `buildResource(events)` assembles a VCALENDAR from projected rows (the REST create path), while `patchEvent` / `putOverride` / `addExclusion` / `removeExclusion` edit a stored component **in place**.

- Every referenced TZID gets a generated VTIMEZONE (RFC 5545 §3.6.5): `lib/ical/vtimezone.ts` builds it from `Intl` offset data, compressing transitions to two open-ended RRULE observances when the zone's DST rule is regular and emitting one observance per transition otherwise. A definition a property still names is the client's own and is never rewritten; one nothing references any more is dropped; new blocks go in **front** of the VEVENTs, because a client reads the file top to bottom.
- `RECURRENCE-ID` names the ORIGINAL occurrence, computed from the master via `computeOccurrenceTimes`, in the master's TZID form — never the exception's moved `startTime`, which would orphan the override.
- An end instant the stored zone's wall clock cannot name — the second pass through a repeated hour — is written as a UTC `DTEND` beside the TZID `DTSTART` (RFC 5545 allows it), so the duration survives.
- On the read side there are two entry points and one trust rule: `parseIcs(text)` for bytes a stranger wrote, `projectResource(component)` for a resource the store itself wrote (adding the stamps, `CREATED`/`LAST-MODIFIED` and `hasUnindexedRecurrence` on top of the same projection). `parseResource(ics)` is the only place a stored `.ics` becomes a component tree.
- A valid IANA TZID resolves through `Intl` whether or not the file defines a VTIMEZONE — the path the builder computes its wall times with — so identical bytes name one instant and a repeated hour resolves to its first pass. A UTC `Z` value is exact; only a TZID `Intl` rejects resolves through the file's own VTIMEZONE; a genuinely floating datetime maps its wall components via `Date.UTC`, never through the server's zone.
- `RECURRENCE-ID` / `EXDATE` → `recurrenceDate` keys are wall-clock dates: TZID-form values key on their own wall components (RFC 5545 canonical), UTC-`Z` values convert the instant to the **series** timezone, floating and `DATE` values keep their raw components. The series timezone is resolved per UID from that UID's master; a master that named no TZID keeps its series in UTC, which is a resolved answer and not a missing one.
- The end of an event is its `DTEND`, or its `DURATION` when it names one (RFC 5545 §3.6.1, which Apple and Outlook both emit), through `ICAL.Event.endDate`. A VEVENT with neither keeps the hour a timed row is drawn as and the day an all-day row is.
- An `EXDATE` becomes a synthetic cancelled row, taking its id and SEQUENCE from the `X-EIGEN-EXDATE` stamp beside it, and the master's SEQUENCE when a client wrote that `EXDATE` itself. One occurrence is one cancelled row, however many `EXDATE` values in however many forms name it.
- A VEVENT the parser cannot read is skipped and counted rather than failing the file; each caller answers for its own surface (a PUT refuses the payload, a preview counts it in `dropped`, an import in `failed`). Each VEVENT is wrapped in an `ICAL.Event` constructed with `{ exceptions: [] }`, which skips ical.js's per-VEVENT sibling scan — quadratic over a whole file (20 000 events: 17 s).
- `ATTENDEE` / `ORGANIZER` values are URIs, so the `mailto:` scheme is stripped case-insensitively; a surviving prefix would match no address in any comparison.

Regression nets, under `apps/api/src/test/`: `caldav/caldav.test.ts` (protocol), `caldav/caldav-roundtrip.test.ts` (serialization/parse round-trips, TZ-pinned floating tests), `caldav/caldav-client-sync.test.ts` (client-faithful sync flows), `caldav/ical-imip.test.ts` (iMIP scoping), `ical/ical-parse.test.ts` (multi-series files), `ical/ical-component.test.ts` (kitchen-sink fidelity under a patch, the SEQUENCE rule, stamp trust), `ical/vtimezone.test.ts` (generator vs `Intl`), `calendar/dav-store.test.ts` (the DAV store seam, the ceilings, the move rules), `calendar/resource-store.test.ts` (the store helpers and the projection rebuild), `calendar/calendar-migration.test.ts` (v2, the rows it carries over, and migration/schema index parity), `calendar/calendar-restart.test.ts` (a reopen over the same database), `calendar/calendar-replay-guard.test.ts` and `calendar/calendar-inbound-request.test.ts` (the ordering guard and the inbound decision), `calendar/calendar-timezone.test.ts` (occurrence keying), `calendar/calendar-quota.test.ts`, `calendar/calendar-transfer*.test.ts`.

## Sharing

**Permissions**: `free-busy` (time blocks only), `read` (full details), `write` (can edit).

Push-based propagation — when shares change, `share-propagation.ts` resolves targets and writes to the recipient's `shared_calendars`. See [ACL.md](ACL.md#share-propagation).

**Team calendars are opt-in, not opt-out.** A `TeamHome` is constructed with settings defaulting to `{ calendar: { enabled: false } }`, and the `TeamHome.calendar` getter throws 404 while that flag is false — so a fresh team has no calendar until an admin turns it on from the Admin app team detail page (via `PUT /team/:ownerId/settings`).

Once enabled, the team calendar is auto-synced into each member's `shared_calendars` when `GET /calendar/:ownerId/shared` is called. The default member permission is `read`; to grant `write` or `free-busy`, an org admin sets shares on the team's calendar (`{targetId: 'team_{teamId}', permission: 'write'}`) — listing, creating, changing and deleting a team home's calendars takes the same admin that enables the calendar, while a member's `write` share is event-level and the team's events stay on membership. Permission is resolved via `checkPermission()` and re-synced on every fetch. While disabled, `syncTeamCalendars` catches the 404 and removes stale entries from members' `shared_calendars`. The app shows them in a separate "Team Calendars" section, on the same `SharedCalendar` infrastructure.

## Invitations

An organizer creates an event with `data.attendees[]` → the server writes a linked copy into each attendee's default calendar → attendees RSVP → status propagates back. All server-side, no email needed between Eigen Homes.

**Linked events** are ordinary resources in the attendee's calendar whose VEVENTs carry `X-EIGEN-ORGANIZER-EVENT` and `X-EIGEN-ORGANIZER-USER`, projected into the `organizerEventId`/`organizerUserId` columns (indexed for lookup) and into `data.organizer` + `data.organizerEventId`. DB-level detection is an equality lookup on `(organizerEventId, organizerUserId)` restricted to masters (`findLinkedEvent`, which adds `parentEventId IS NULL` so an exception never answers for the series it inherits its link from); application-level detection is `isInvitationFromOthers(event, home.user.email)`.

**Propagation** (`invite-propagation.ts`):

- Create or update with attendees: diff old vs new → add, remove or update the linked copies, plus SSE notifications.
- One occurrence ("edit this event", which is a create or update of an override): every message names the **series'** event id as `organizerEventId` plus the occurrence's recurrence key, never the override row's own id — the guest holds one linked series, and an exception on it inherits the series' link. The guest's receiver attaches it through `applyInvitationException`, the same function an iMIP `REQUEST` carrying a `RECURRENCE-ID` takes, and a cancelled override travels as a removal of that instance (`cancelInvitationOccurrence`). A guest's mail carries the `RECURRENCE-ID` of the ORIGINAL instant, which only the series knows once the override has moved — hence `serializeEventForImip`'s `series` argument. The guests of the series are the guests of the occurrence: an override naming none of its own inherits the series' list rather than reading as an occurrence nobody is invited to, because a stored VEVENT cannot tell a client that did not restate the list apart from one that emptied it. So an occurrence edit reaches a guest who already holds the series as an update of that occurrence — never as a second invitation to it.
- A guest added to a whole series gets the exceptions it already holds, right after the invitation that files the series and only to that guest: every override travels as an update of its occurrence and every cancelled one as a removal of it, the messages a later occurrence edit or cancel sends anyway. The guest's fresh copy holds nothing for those keys, so the ordering guard takes each. Without them a moved occurrence renders at its original slot and one the organizer deleted renders at all.
- Delete by the organizer: cancel every attendee copy.
- Delete by an attendee: treated as a decline, and only for an attendee — the deleting user's address has to be in the event's `attendees` (case-insensitively), or the row is just deleted: a file or a CalDAV client can hang any `ORGANIZER` on an event, and a REPLY for a meeting the user was never invited to would reach a stranger. An organizer known by address only — every organizer a CalDAV PUT or a parsed `.ics` names — takes the iMIP `REPLY` path, because in-app propagation has no Home to address.
- Self-invite prevention: the organizer's own address is skipped during propagation.
- Unknown email: added to the share registry for reconciliation on signup.

**A series-wide edit carries the fields an override never claimed.** Patching a master walks the overrides beside it in the same resource — one resource, one write: for `title`, `description` and `location`, an override whose value equals the master's value *before* the edit follows the master, and one that set its own keeps it. Times never follow. Guests run the same rule when the master's update reaches them, so an occurrence that was only moved is renamed everywhere without a message of its own.

**RSVP**: an attendee calls `PUT .../events/:id/rsvp` with `{status, scope?, recurrenceDate?, remove?}`.

- `scope='all'` (default): updates the attendee's status on the linked event and propagates to the organizer.
- `scope='this'` + `recurrenceDate`: writes a recurrence exception with a per-occurrence attendee status and propagates (the organizer gets an exception too). With `remove: true`, an exclusion instead — the occurrence is hidden and a decline propagates.
- `scope='this-and-following'` + `recurrenceDate` + `remove: true`: truncates the linked event's rrule and propagates a series-wide decline.
- `remove: true` without a scope: deletes the whole linked event (same as DELETE, propagates a decline).

A copy that **is** one occurrence of a series the guest does not hold answers for that occurrence: its default-scope RSVP and its delete both name its own `RECURRENCE-ID` key, so the organizer's receiver lands on the override that holds that occurrence's guest list rather than on a series whose own list may name nobody. The iMIP `REPLY` names it by construction, from the stored `RECURRENCE-ID`.

**The rrule constraint**: when an organizer updates a recurring invited event, `constrainRRule` keeps the incoming rule from extending past any local truncation the attendee made, so "delete this and following" is not undone by an organizer edit.

**The linked-event guard**: attendees can only change `data.reminders` and `data.color` on a linked copy; title, time, description, location and rrule changes are dropped by `updateEvent`. Detection is `isInvitationFromOthers()` from `@workspace/lib/calendar` — **not** the DB column — comparing the stored organizer address with the Home user's, case-insensitively; an owner with no address of its own never matches, so a team calendar keeps a member-organized CalDAV event locked (a team Home's synthetic user has an empty address, [ROADMAP.md](ROADMAP.md)). A stored organizer on its own means nothing: Apple Calendar and Thunderbird write `ORGANIZER:mailto:<the account's own address>` on every event they create with guests, and that event is the owner's own — editable by that client, by the web app and by the API, and its delete cancels for the guests instead of declining. One rule, every caller: the `updateEvent` guard and its fan-out, `deleteEvent`, `rsvp()`, the inbound iMIP `REPLY` lookup, and the calendar app's detail and edit dialogs. The edit dialog mirrors the guard (`EventFormFields`' `detailsDisabled`) so those fields are disabled rather than silently dropped on save; the calendar select stays live, because moving a linked copy goes through `moveEvent()`, and it is what **Save** waits for — on a linked copy the button appears only once the select has moved, so a dialog that could change nothing offers **Close** alone. In a shared calendar the viewer does not own, the owner's address is not at hand — so the dialogs pass none and the event reads as locked, while the server would accept the write.

**`organizer` and `organizerEventId` are server-owned**: `EventDataSchema` (`routes/calendar.ts`) has no field for either, so an HTTP edit keeps the stored pair whatever `data` the client posts back. On the file side they are `X-EIGEN-*` lines, which an incoming body can never spell.

### The inbound decision

Every inbound REQUEST — relayed from another Eigen Home, or carried by a DKIM-aligned iMIP mail — takes **one** decision, `decideInboundRequest`, inside the write lock and Home-wide by UID, so two concurrent deliveries can never file two masters for one UID.

1. **Update.** A stored event already linked to an organizer wins, *provided* the sender is the organizer that copy is linked to — a co-attendee cannot hijack an invitation. A REQUEST carrying a `RECURRENCE-ID` attaches as an exception; a full update would collapse the series. The relay states that key as its payload's `recurrenceDate`, so one decision serves both transports with no branch of its own.
2. **Adopt.** A stored master nobody linked is claimed only when the resource's own organizer address — the `X-EIGEN-IMPORTED-ORGANIZER` stamp, else its `ORGANIZER` — equals the verified sender. The file keeps its identity: same resource, same row ids, with the link stamped in and the guest list taken from the message. An occurrence-only REQUEST for a series nobody organizes here yet is dropped.
3. **Create**, in the default calendar, but only when the body's `ORGANIZER` *is* the sender: a new invitation is attributed to its sender, so the two must agree. A REQUEST naming one occurrence of a series this Home does not hold files as a **standalone event** that keeps its `RECURRENCE-ID` — the only durable record of which occurrence it answers for, and what a later update or cancellation of that occurrence finds, since the copy *is* that instance rather than an exception on a series. A Home with no default calendar is dropped.

**An occurrence copy gives way to the series.** A later REQUEST for the whole series — the organizer widening the invitation — passes the ordering guard against the occurrence copy's own revision first, and only then replaces it: the standalone resource is purged and the series written in its place, in that order inside one gate hold, so nothing the guest holds is dropped before the replacement is certain to file. The guest's own reminders and color carry over, the two fields a linked copy lets them keep; their PARTSTAT does not, because the guest list of the new resource is the one the message states. The organizer's override for that occurrence follows right behind it as an exception and carries the list the organizer holds for it, so the answer they already gave stands. A cancellation naming that occurrence deletes the copy outright rather than excluding an instance from it, since it has no series to exclude one from.

A Home is never its own organizer: a relayed message naming this Home's own id is dropped, because adopting it would make its own event a linked copy of itself.

**The ordering guard.** `isNewerRevision` (RFC 5546 § 2.1.5) orders on SEQUENCE first and `DTSTAMP` second, against the revision the **stored resource** holds for that occurrence (`storedRevision`: the VEVENT's own numbers, or for a cancelled occurrence the `X-EIGEN-EXDATE` stamp beside its `EXDATE`, falling back to the master's SEQUENCE when a client wrote that `EXDATE`). A strictly lower SEQUENCE always loses. With equal SEQUENCEs an equal-or-newer `DTSTAMP` is applied as the redelivery it is — the stamp has one-second resolution, so two revisions inside one second are indistinguishable — and when **either** side carries no stamp there is nothing to order by, so the message is applied for the same reason. A redelivery then patches to nothing, which costs no ctag bump and tells the user nothing twice. An incoming stamp more than 24 hours ahead of the receiver's clock is clamped to now, or it would outrank every genuine update that follows it at the same SEQUENCE.

**Fire-and-forget receivers never raise.** An inbound message the store will not keep — over `EVENT_MAX_BYTES`, or over the storage budget — is dropped and logged rather than thrown: the mail it rode in on has already landed, the remaining VEVENTs of the message still file, and there is nobody to answer a 413 or a 507 to.

**SSE events**: `calendar:invite-received`, `calendar:invite-updated`, `calendar:invite-cancelled`, `calendar:invite-rsvp`.

## iMIP (Email-Based Calendar Invitations)

iMIP carries invitations between Eigen users and external parties over email (RFC 6047), layered on the invitation system above: external attendees get mail instead of in-app linked copies.

### Outbound flow (Eigen → external)

- **Create with external attendees**: `invite-propagation.ts` detects attendees with no Eigen account and calls `composeInviteEmail()` → `sendMail()`. Sends `METHOD:REQUEST`.
- **Update**: `composeUpdateEmail()` → an updated `METHOD:REQUEST`. **Cancel**: `composeCancelEmail()` → `METHOD:CANCEL`.
- **Attendee RSVP**: `composeRsvpReply()` → `METHOD:REPLY`, from `rsvp()` and from `deleteEvent()` (a delete is a decline). A `scope:'this'` RSVP carries a `RECURRENCE-ID` for the original instant, so the organizer applies the PARTSTAT to that occurrence and not to the series.
- **The body is projected, never the stored bytes.** `serializeEventForImip` builds a fresh VCALENDAR from the row, so it carries no `X-EIGEN-*` line by construction, and `stripEigenStamps` runs over it anyway. **No `VALARM` ever travels with a message**: the organizer's reminders are their own, and an `email` one would ship as `ACTION:EMAIL` naming the organizer as its `ATTENDEE`, so every guest's client would mail the organizer at the trigger. The `URL` stays — guests seeing the link is the point. A REQUEST asks each guest to reply (`RSVP=TRUE`) and rides the organizer along as an accepted attendee (RFC 5546).

### Inbound flow (external → Eigen)

- **Mail delivery hook**: inside `Mail.mailboxDeliver` (`lib/mail/mail-domain.ts`). Once the raw bytes are appended to INBOX the message is parsed and scanned for a `text/calendar` part; if there is one, `processInboundImip(home, parsedMail)` runs. This is **blocking on purpose**, so a client reacting to the new-mail SSE already finds the event. The surrounding `try`/`catch` only logs: a malformed invite never fails the delivery.
- **Sender authentication**: every mutation binds to the message `From:`, and the verdict about that sender is **computed at the delivery seam and handed to the calendar**. `mailboxDeliver` calls `verifyImipSender` (`lib/mail/imip-auth.ts`) with the parsed `Authentication-Results`, our own authserv-id and the `From:` domain, and passes the `{ verified, reason }` it answers into `processInboundImip`, which acts on a verified one and logs the reason otherwise. Only delivered mail carries our MTA's stamp, so only that path can produce a verdict — a `.eml` a user imports never reaches the calendar at all. A verdict is `verified` when the message carries an `Authentication-Results` header written by our own verifying MTA (authserv-id equal to `getMailDomain()`) recording a `dkim=pass` whose `header.d`/`header.i` domain is DMARC-relaxed-aligned with the `From:` domain. `verifyImipSender` reads only the topmost header stamped with our authserv-id, because OpenDKIM prepends its result and strips pre-existing ones with that id (`AuthservID` + `RemoveARFrom` in `docker/postfix/entrypoint.sh`), so a header beneath it is a stale hop or a forgery. Any other case fails closed: the part is not processed, one info line is logged with the reason, and the invite stays visible as a normal calendar attachment. An operator fronting Eigen with an MTA that writes no such header has automatic iMIP off by design, and every invite arrives as a plain attachment. Internal Eigen↔Eigen invitations never take this path.
- **An organizer message this Home's own address signed is dropped.** A REQUEST or CANCEL whose verified sender is the recipient's own address is their own mail coming back — an invitee address that forwards to them, a list they are on. Acting on it would let them seize their own event as somebody else's copy, after which every CalDAV PUT on it is reduced to alarms. A REPLY from one's own address is legitimate and is still processed.
- **`METHOD:REQUEST`** takes the one inbound decision above (`receiveImipRequest`), with `organizerUserId = external_<sender>`.
- **`METHOD:CANCEL`** removes the linked event (`removeInvitation`); one carrying a `RECURRENCE-ID` cancels just that instance (`cancelInvitationOccurrence`), under the same ordering guard, and the cancelled occurrence records the CANCEL's SEQUENCE and stamp in its `X-EIGEN-EXDATE`.
- **`METHOD:REPLY`** moves PARTSTAT on the organizer's own master (`receiveAttendeeStatus`), or onto that instance's exception for an occurrence REPLY (`receiveRsvpForOccurrence`). A REPLY may only set the status of the attendee who sent it, only invited attendees are processed (exception-aware: someone can be invited to a single occurrence only), and a REPLY never resurrects an occurrence the organizer deleted.

### `external_` prefix convention

External organizers have no Eigen user id, so `organizerUserId` is `external_{organizerEmail}` — mirroring the `team_{teamId}` convention. `isExternalOwnerId()` routes an RSVP to email instead of in-app propagation.

### `imip.ts` module

`apps/api/src/lib/calendar/imip.ts` — pure functions, no DB access:

| Function | Purpose |
|---|---|
| `composeInviteEmail()` | `OutboundMail` for `METHOD:REQUEST` (new invite) |
| `composeUpdateEmail()` | `OutboundMail` for `METHOD:REQUEST` (update) |
| `composeCancelEmail()` | `OutboundMail` for `METHOD:CANCEL` |
| `composeRsvpReply()` | `OutboundMail` for `METHOD:REPLY` |
| `summarizeCalendarInvite()` | read-time `CalendarInvite` summary for the message payload |
| `processInboundImip()` | dispatch inbound iMIP methods to calendar operations |

### Mail UI widget

`apps/mail/src/components/mail/calendar-invite-widget.tsx` renders inline in `email-detail.tsx` for any attachment whose `contentType` starts with `text/calendar`; such parts are excluded from the normal attachment list. The widget is purely presentational: `Mail.messageGet` summarizes each calendar part through the canonical parser into `Attachment.calendarInvite`, and `null` means unparseable ICS, rendered as an explicit error card.

## Recurrence

- RRULE strings are stored and transmitted as-is (no conversion layer).
- Expansion runs in memory per query via the `rrule` package; **expanded occurrences are never stored**.
- **Exceptions** are override VEVENTs in the same resource, projected to rows with `parentEventId` + `recurrenceDate`. A cancellation is an `EXDATE`, projected to a `status: 'cancelled'` row.
- **Occurrence keys are wall-clock dates** (`YYYY-MM-DD` in the series' timezone). A substituted modified occurrence renders with the exception's **stored** `recurrenceDate` — never the UTC date of its possibly-moved `startTime` — so the FE can round-trip `occurrenceDate` into a `scope='this'` RSVP.
- **A series-wide edit travels as a delta.** The edit dialog opens on the occurrence the user clicked but saves on the master, so "All events in series" sends only what changed: the master's start and end shift by the dialog's own delta (dialog time minus the clicked occurrence's time), and a title, description or location rides along only when the user retyped it — otherwise an override's own title would become the series'. `seriesEditFromOccurrence` (`packages/lib/src/core/calendar/calendar-utils.ts`) is that patch, and the master it shifts comes from `useEvent`.
- **A range read is bounded by its window**, never by the size of the Home: it loads the non-recurring events that overlap the window, the masters that start at or before its end (rrule never steps back before DTSTART, so a later one has no occurrence inside it), and the exceptions of those masters plus any exception whose own times overlap — which is how an occurrence moved *into* the window shows there. The masters ride into the exception query as a subquery, because one bound variable per master would pass SQLite's cap on a large calendar. A cancelled occurrence is dropped from the answer, and so is the parent occurrence any exception replaces.

### Recurrence limits

`lib/ical/recurrence-limits.ts` bounds what expansion can be asked to do, because `rrule.between` walks occurrence by occurrence from dtstart to the query window on the single shared event loop:

- **Sub-daily rules are rejected**: `HOURLY`/`MINUTELY`/`SECONDLY` are refused at the API write boundary with a 400 and silently stripped at the untrusted-ICS boundary, where a hard error would be the wrong answer. A `SECONDLY` rule starting a year before its window measured ~74 s. No mainstream client emits sub-daily recurrence.
- **A recurring dtstart must fall in 1900–2200.** Same two seams, same reasoning; the worst case inside the range is ~110k steps.
- **Materialized occurrences cap** at `MAX_OCCURRENCES` (10 000) per expansion.
- **Query windows are clamped**, not rejected, to a 5-year span — the range reads' own bound, in `calendar/occurrences.ts`.

A rule the projection stripped stays in the stored bytes, and the resource is flagged `hasUnindexedRecurrence` so a time-range REPORT answers with it for every window.

## All-day events, intervals and zone-less rendering

`startTime`/`endTime` of an all-day event are midnight UTC and `endTime` is exclusive (the day after the last day); the frontend must use the UTC date portion and never convert to local time.

`createEvent`/`updateEvent` reject `endTime < startTime` with a 400 and the put seam refuses the same interval with a 403 `valid-calendar-data`, so REST, import and CalDAV PUT all answer it alike. Inbound iMIP bypasses them, so it **clamps** a reversed interval to zero duration at the parse boundary: an emailed invite is fire-and-forget, and dropping it over a malformed interval is worse than showing a zero-length event — the same degrade-don't-reject policy the parser applies to a malformed rrule or TZID. Zero duration stays legal (RFC 5545 §3.6.1). Because all-day uses an exclusive end, one invariant covers timed and all-day alike.

`timezone` is nullable: only the create/edit dialogs always store one, so API-, CalDAV- and iMIP-created events routinely carry `null` (all-day events store `null` by design). `formatEventWhen` therefore takes the fallback zone as a **required** argument:

- **Browser** (`EventDetailCard`, `calendar-invite-widget.tsx`) passes `viewerTimeZone()` — the runtime's own zone, which is what the month/week grid lays events out in. Any other choice makes the detail dialog name a different clock time than the slot the grid drew.
- **API** (`imip.ts`) has no viewer and must not borrow the server's zone, so invitation mail renders a zone-less timed event in UTC and appends `(UTC)`. An event with a stored zone renders in that zone, unlabelled; the attached `.ics` carries the TZID either way.

All-day events take neither fallback: `formatEventWhen` pins them to UTC, because their bounds are midnight UTC and the date portion is the answer. A stored TZID `Intl` rejects takes the same fallback as no zone at all — the case `normalizeTimezone` writes as `null` at ingestion, after first resolving a Windows zone name (Outlook's `W. Europe Standard Time`) through the CLDR `windowsZones` table beside it (`packages/lib/src/core/calendar/windows-zones.ts`, the `territory="001"` rows, imported by the API through the same React-free deep path). A name neither `Intl` nor that table knows stays `null`: the file's own VTIMEZONE still gives the parser its instants, but an `X-LIC-LOCATION` inside that block is never read, so nothing recovers an IANA name from it ([ROADMAP.md](ROADMAP.md)).

## Quotas

Two ceilings guard every calendar write. `EVENT_MAX_BYTES` (5 MiB, `calendar/resource-store.ts`) is the whole-resource safety ceiling — the domain's own, as `CARD_MAX_BYTES` is contacts' — checked on a PUT body before buffering and again on the bytes that would land. Beyond it, calendar shares the **home data** storage budget with mail and contacts: `writePrepared` runs `enforceHomeDataQuota(ownerId, addBytes, creditBytes)` inside the write lock and before the commit, crediting the size of the stored resource it replaces so every rewrite goes through the edit grace. `Calendar.size()` answers from the in-memory `eventsBytes` counter that init seeds with `SUM(length(ics))` and every write, delete and calendar delete moves by delta, so a device sync costs no query per resource. A projection over budget is a 507 — raised directly on REST, returned as the typed `quota` result on a CalDAV PUT (which `davPutResponse` turns into a 507) and on an import (which names how many events landed first). An inbound invitation over budget is **dropped while the mail still lands**, because a fire-and-forget receiver has nobody to answer a 507 to. A move re-points one row and a delete removes one, so neither is metered. The whole rule — the edit grace and its headroom, the unmetered-Home case, and how the admin Users page sizes a Home nobody has loaded — is in [QUOTA.md](QUOTA.md).

## iCalendar import / export

The whole-file counterpart to the per-resource DAV surface: one route exports stored resources as one `.ics`, two import one. `apps/api/src/lib/calendar/transfer.ts` holds both halves as plain functions over the `Calendar` facade, like the contacts and mail siblings.

```
POST /calendar/:ownerId/export             { calendarId, ids? }                             → text/calendar attachment
POST /calendar/:ownerId/import?calendarId= the .ics file as the raw body                    → { imported, skipped, failed }
POST /calendar/:ownerId/import-from-drive  { calendarId, sourceOwnerId, sourceMountId, … }  → the same counts
```

All three are `requireNonGuest`, and `resolveTransferCalendar` decides the Home: a **team** home is the only one here that is not the caller's own, reached with `read` access for an export and `write` for an import — the same access `createEvent` takes. Any other owner is refused rather than resolved, because the file would be read out of, or written into, another user's Home and only the relay crosses Homes. `free-busy` may learn *when* a calendar is busy, never what it says, so it is no read access here either.

**Caps.** `ICS_MAX_BYTES` (5 MiB) lives in `packages/lib/src/constants/calendar.ts`, shared FE/BE so a surface refuses an oversize file before uploading it. The server's own ceilings sit in `apps/api/src/lib/core/transfer.ts` with the other whole-file transfer limits: `ICS_IMPORT_MAX_EVENTS` (10 000) and `ICS_IMPORT_MAX_WRITTEN_BYTES` (8 × `ICS_MAX_BYTES`). `/import` reads the body itself (`parse: 'none'`) through `readBoundedBodyBytes`; `/import-from-drive` reads its source through the shared `readImportSourceBytes`, so the ACL decides what a user may read and a name or mime `isIcsFile` does not recognize is a 400 (`NOT_A_CALENDAR_FILE`, spelled once for every whole-file transfer). Both routes exempt themselves from the server idle timeout (`server?.timeout(request, 0)`), because a file of a thousand events writes a resource apiece before either answers.

**Import moves components, so every line the author wrote lands as written.** `Calendar.importEvents(calendarId, bytes)` owns the decode as its mail and contacts siblings do: iCalendar is UTF-8 (RFC 5545 §3.1), so another encoding is a 400 "File is not UTF-8 encoded" and bytes ical.js refuses a 400 `NOT_A_CALENDAR_FILE`, both with nothing written. The event ceiling is counted twice — once on the `BEGIN:VEVENT` lines of the decoded text, before ical.js builds a tree per VEVENT, and again on what the parser returned — because one master can hold ~37 000 `RECURRENCE-ID` VEVENTs inside `ICS_MAX_BYTES`, so a ceiling on masters alone bounds nothing. A `.ics` may be a stream of several VCALENDAR objects (RFC 5545 §3.4), and the whole stream is **grouped by UID** first: a file may spell a master in one object and its overrides in the next. A VEVENT naming no UID gets a minted one.

Each series is then assembled as its own resource — the VTIMEZONE blocks it references, the master, its overrides — and written through the **CalDAV PUT seam** under a fresh `<uuid>.ics` with `If-None-Match: *`:

- **Scheduling is the one thing an import takes out.** Every `ATTENDEE` line is dropped (a `VALARM`'s own `ATTENDEE` stays — that is the alarm's recipient, not a guest), and the `ORGANIZER` is removed and kept as one inert `X-EIGEN-IMPORTED-ORGANIZER` that the inbound-REQUEST rule matches a verified sender against. `METHOD` is ignored. An attendee list on an imported event would send a REQUEST on every edit and a CANCEL on delete to addresses the file's author chose, and would be the row a forged iMIP REPLY matches by UID. An imported invitation is a plain event — alarms, `ATTACH`, `CATEGORIES`, unknown `X-` properties and every other line included.
- **UID uniqueness is Home-wide for an import.** The `import` option of `putResource` widens the holder lookup from "this calendar" to the whole Home, where a device sync — the other caller of that seam — syncs one calendar and owns only that one. A UID any calendar of the Home already holds comes back a `uid-conflict` and counts as `skipped` — which is what makes a partial import retryable: the series already written skip, and a retry finishes the file.
- A UID that is empty, longer than 255 characters or carrying a control character is `failed`: it travels into etags and sync deltas, so it has to be storable. An override group the file holds no master for is `failed`, one per orphan. A series the put seam refuses for any other reason is `failed` and the file continues.
- Past `ICS_IMPORT_MAX_WRITTEN_BYTES` the run stops with a 413 naming how many events landed, and past the storage budget with a 507 doing the same — a series is one resource, so a VTIMEZONE the file defines once is copied into every series that names it, and a file well inside its own byte ceiling can ask for many times its size on disk.
- The whole file runs inside `Calendar.withBatchedEvents()`, so a thousand series cost one list-level broadcast instead of one per series.

**Export is a text splice of the stored lines, not a parse and re-serialize.** `exportEvents` orders the resources by the earliest start among the rows asked for, reads each one's `ics` blob — one row at a time, since the whole calendar's bytes in one query is the read that would not scale — and lifts out its `VTIMEZONE` and `VEVENT` blocks through `spliceBlocks` (`lib/ical/blocks.ts`), dropping every line whose property name `isEigenName` recognizes. A splice rather than `parse → toString`, because ical.js rewrites parameter quoting and order on every line it re-emits, and bytes the store only projected were never Eigen's to rewrite; only Eigen's own lines carry an Eigen name, so dropping those lines whole *is* the strip. The first definition of a TZID wins, so two resources naming one zone carry it once. The result is **one VCALENDAR**, never a concatenation of objects, because many readers take only the first object of a stream. Without `ids` the whole calendar is exported; with them, the resources those ids belong to — an exclusion or an override names the series it is part of — and an unknown id is a 404. A one-event export is named after the event's own title, otherwise after the calendar, clamped to 200 characters and sanitized by `contentDisposition`.

**Where a user starts an import.** From the calendar itself, and from anywhere an `.ics` is a file. In the calendar app every calendar row's kebab (`apps/calendar/src/components/calendar-sidebar.tsx`) carries **Import events…** beside **Export calendar** — for an own calendar, and for a team calendar the viewer may write in — which opens the shared `FileImportPicker` (a device upload posts the bytes through `useImportCalendarFromDevice`, a Drive pick goes through `useImportCalendar`'s Drive path) with that calendar as the target, the same shape the contacts list's **Import contacts…** takes. Elsewhere the file is the start: a Drive row, a mail attachment chip, a chat or card attachment, and the quick look's own footer. The registry row is `import-calendar` ("Import to Calendar", `packages/lib/src/core/file-actions.ts`), offered for a downloadable `.ics` under `ICS_MAX_BYTES` and hidden for a guest, whose import the route refuses. Unlike the contacts and mail rows it cannot just run: it needs a target, so `useFileActionRunner` opens `ImportToCalendarPicker` (`packages/ui/src/components/calendar/import-to-calendar-picker.tsx`), which lists the viewer's own calendars through `useCalendars` under **My Calendars** and, under **Team Calendars**, the calendars a team home owns and the viewer may write in — a calendar shared out of another *user's* home is no target, because the route refuses it ([ROADMAP.md](ROADMAP.md)) — preselects the viewer's own default calendar, and offers **New calendar** with a name field defaulting to the file name without its extension. Every option carries the home it lives in, and that home rides with the file as `ownerId`: it is the home the route writes into and the one whose event queries go stale. Until the list arrives the select is disabled and reads "Loading calendars…", so the dialog never opens on **New calendar** and then moves under the user. The picker runs the whole action through one hook, `useImportToCalendar` (`hooks/use-transfer.ts`): `useCreateCalendar` first when the target is a new calendar, then `useImportCalendar`. A create that succeeded is remembered for the life of the dialog, so a retry after a failed import imports into it rather than making a second calendar of the same name; a new calendar that took no events at all is deleted again, and the file the picker was opened on rides in as a `FileImportSource`.

Where the bytes come from is one derivation for every import: `importSourceOf(subject)` (`packages/lib/src/core/file-subject.ts`) answers the `DriveImportSource` for a file at a Drive location and the download URL for anything else.

## API routes

`apps/api/src/routes/calendar.ts`; `ownerId` can be a user id or `team_{teamId}`:

```
GET    /calendar/:ownerId/calendars
POST   /calendar/:ownerId/calendars
PUT    /calendar/:ownerId/calendars/:calId        (includes shares)
DELETE /calendar/:ownerId/calendars/:calId
GET    /calendar/:ownerId/event-range/:from/:to   (all calendars)
GET    /calendar/:ownerId/calendars/:calId/event-range/:from/:to
GET    /calendar/:ownerId/calendars/:calId/events/:id  (one stored row, not an occurrence)
POST   /calendar/:ownerId/calendars/:calId/events
PUT    /calendar/:ownerId/calendars/:calId/events/:id
DELETE /calendar/:ownerId/calendars/:calId/events/:id
PUT    /calendar/:ownerId/calendars/:calId/events/:id/move   (re-home to {targetCalendarId})
PUT    /calendar/:ownerId/calendars/:calId/events/:id/rsvp   (attendee RSVP)
GET    /calendar/:ownerId/calendars/:calId/access
GET    /calendar/:ownerId/shared                  (shared-with-me list, auto-syncs team calendars)
PUT    /calendar/:ownerId/shared/:id              (local prefs)
DELETE /calendar/:ownerId/shared/:id
GET    /calendar/:ownerId/shared-with-me          (pull: what has owner shared with me?)
POST   /calendar/:ownerId/export                  ({calendarId, ids?})
POST   /calendar/:ownerId/import?calendarId=      (raw .ics body)
POST   /calendar/:ownerId/import-from-drive       ({calendarId} + the Drive source)
```

Team calendar settings (enable/disable, member permission) are managed via the team router, not the calendar router:

```
GET    /team/:ownerId/settings                     (includes calendar.enabled)
PUT    /team/:ownerId/settings                     (update: {calendar: {enabled}})
```

The event-range endpoints return `CalendarEventOccurrence[]` — expanded occurrences with an `occurrenceDate` field. A `free-busy` caller gets time blocks only, with cancelled occurrences excluded so their existence and time do not leak.

**Two access rules, one router.** Administering a team home's calendars — listing them, creating, changing and deleting one — takes the team-admin rule (`resolveAdministeredCalendar` → `requireTeamAdmin`), because a team admin is who sets a team calendar's shares; the listing alone lets a member of that team through their membership instead (`resolveListedCalendar`). Every event route takes the calendar share (`checkCalendarAccess`), so a member's `write` share is event-level and the team's events stay on membership. A non-team `ownerId` is the caller's own or a 403.

**A REST bound is never tighter than what the put seam stores.** `routes/calendar.ts` caps the ids and keys Eigen mints — a calendar id, a target calendar id, a recurrence key, a color — at 512 characters, and everything a client may spell for itself — a title, description, location, `RRULE`, `URL`, an attendee address or display name — at `EVENT_MAX_BYTES`, with the list bounds sized the same way (a file holds no more lines than it holds bytes). A shorter bound would leave an event a CalDAV client legitimately stored uneditable from the web app. A calendar name takes the domain's own `CALENDAR_NAME_MAX_LENGTH`.

## Types

```typescript
type CalendarShare = { targetId: string; permission: 'free-busy' | 'read' | 'write' }
type CalendarItem = { id, name, color, isDefault, visible, ctag, shares: CalendarShare[] | null, createdAt, updatedAt }
type CalendarOption = { id, name, color, ownerId }   // one calendar a viewer may write in, with the home it lives in
type CalendarEvent = { id, calendarId, uid, uri, title, description, location, startTime, endTime, allDay, rrule, timezone, parentEventId, recurrenceDate, status, sequence, etag, data, createByUserId, createdAt, updatedAt }
type CalendarEventOccurrence = CalendarEvent & { occurrenceDate: string }
type FreeBusyBlock = { startTime, endTime, allDay, status: 'confirmed' | 'tentative' }
type SharedCalendar = { id, ownerUserId, calendarId, calendarName, calendarColor, permission, color, visible, createdAt, updatedAt }
type Attendee = { email, name?, status: 'pending'|'accepted'|'declined'|'tentative', role: 'required'|'optional' }
type EventData = { reminders?: Reminder[], attendees?: Attendee[], organizer?: { userId, email, name? }, organizerEventId?, url?, color? }
```

Defined in `packages/lib/src/types/calendar.ts`. `CalendarEvent.uri` and `.etag` are the resource's, joined onto every event row of that file.

## Frontend hooks

All in `packages/lib/src/core/calendar/hooks/use-calendar.ts`:

| Hook | Purpose |
|---|---|
| `useCalendars(ownerId)` | list calendars for an owner |
| `useCreateCalendar(ownerId)` | create calendar |
| `useUpdateCalendar(ownerId)` | update calendar (name/color/shares/visible) |
| `useDeleteCalendar(ownerId)` | delete calendar |
| `useEvents(ownerId, from, to)` | all events in a range (all calendars) |
| `useEvent(ownerId, calId, id)` | one stored row — the master an edit dialog opened on an occurrence saves on |
| `useCreateEvent(ownerId)` / `useUpdateEvent(ownerId)` / `useDeleteEvent(ownerId)` | the event mutations |
| `useMoveEvent(ownerId)` | re-home one event to another calendar |
| `useCalendarAccess(ownerId, calId)` | calendar shares (with `write` permission) |
| `useAllSharedCalendarEvents(sharedCalendars, from, to)` | parallel queries for every visible shared calendar |
| `useSharedCalendars(ownerId)` | shared-calendar list (triggers the team sync) |
| `useSharedCalendarLabel(sharedCalendars)` | how one shared calendar reads in a list, owner included |
| `useCalendarOptions(ownerId, calendars, sharedCalendars)` | every calendar the viewer may write in, as `CalendarOption[]` |
| `useUpdateSharedCalendar(ownerId)` / `useDeleteSharedCalendar(ownerId)` | local prefs / remove entry |
| `useRsvp(ownerId)` | RSVP mutation |

The transfer hooks live beside them in `use-transfer.ts`: `useImportCalendar` takes a `FileImportSource` plus the target home and `calendarId` in its mutation variables and reports the three counts in one toast, `useImportToCalendar` wraps it with the create-then-import the picker needs, and `useExportCalendar` downloads one calendar, or the events an `ids` selection names, as one `.ics`. `isTransferableCalendarHome` is the predicate beside them for which homes a transfer route resolves.

**Query keys**: `calendarKeys`, `ownerId`-scoped — `all > owner(ownerId) > calendars/events/shared`. The SSE handler in `packages/lib/src/core/calendar/sse-handlers.ts` routes events to the invalidation functions.

## SSE events

Defined in `packages/lib/src/types/sse.ts`:

| Event | Trigger |
|---|---|
| `calendar:calendar-created` | calendar created |
| `calendar:calendar-updated` | calendar updated (name/color/shares) |
| `calendar:calendar-deleted` | calendar deleted |
| `calendar:event-created` | resource created |
| `calendar:event-updated` | resource updated |
| `calendar:event-deleted` | resource deleted |
| `calendar:events-changed` | one bulk write (a whole-file import) stands for every per-resource event it held back |
| `calendar:shared` / `calendar:unshared` | calendar shared with / unshared from a user |
| `calendar:invite-received` / `-updated` / `-cancelled` / `-rsvp` | the invitation lifecycle |

An announcement reaches the owner's own tabs **and** every Home the calendar is shared with (`notifySharedCalendarUsers`). A PUT of bytes that were already stored commits nothing and therefore announces nothing.

## Known limits

- **A calendar can grow past what one `.ics` imports back.** The export joins every stored resource into one string in memory and nothing bounds it, while both import routes bound one file ([ROADMAP.md](ROADMAP.md)).
- **Partial retrieval and filtering are answered as supersets.** A `calendar-data` projection, `expand`, `limit-recurrence-set`, a `prop-filter`/`text-match` and a `sync-collection` `nresults` limit are all parsed past, so a client that asked for a narrow answer pays the full bytes ([ROADMAP.md](ROADMAP.md)).
- **`RANGE=THISANDFUTURE` on a `RECURRENCE-ID` degrades to a single-instance edit**, and `RDATE`-added occurrences never appear in a range read — mainstream clients split such series into new UIDs. The stored bytes keep both, and the resource is flagged so a time-range REPORT still returns it.
- **A sub-daily or out-of-range rule is stripped from the projection, not from the stored bytes**: the event draws as a single occurrence while the bytes a client GETs still carry the rule.
- **A REST event update carries no `expectedEtag`**, where the contacts twin answers 412 on a mismatch, so two web clients editing one event last-write-win ([ROADMAP.md](ROADMAP.md)).
- **A CalDAV PUT fans nothing out**: the guests of an event a client created are not mailed until the owner touches it in the web app ([ROADMAP.md](ROADMAP.md)).
- **An iMIP invitation mail carries one VEVENT**, so an external guest invited to a series gets the master alone, without the override VEVENTs and `EXDATE`s RFC 5546 expects beside it; an Eigen guest gets them as occurrence messages ([ROADMAP.md](ROADMAP.md)).

## Client setup

The same credential story as CardDAV and IMAP: HTTP Basic auth with an app password (the primary-password fallback fails under 2FA). Point clients at `https://<domain>/` (or `/.well-known/caldav`, redirected to `/dav/` at the Caddy edge) with the Eigen email as username. The device-setup how-to is the help-center article [connect/calendar-client](../apps/index/src/data/support/connect/calendar-client.md). The **Integrations** page (`apps/space/src/routes/_auth.services.tsx`) surfaces a CalDAV address card beside CardDAV, IMAP and WebDAV: the discovery root, the calendar home, and one address per own calendar (`useCalendars`), because a client such as Thunderbird subscribes per collection and never revisits the home for a calendar created after it connected.

## Where the code lives

- **`apps/api/src/lib/calendar/`** — the domain, split Mount-style: `calendar.ts` (the `Calendar` facade — the write lock, the database handle, the commit seams, the byte counter and the announcements; every sibling call goes through it) with sibling modules of plain functions over it: `dav-store.ts` (the CalDAV store seam — the row reads, `putResource`/`deleteResource`, the `prepareResource` + `writePrepared` pair `writeResource` wraps, and the row projection), `events.ts` (create, update, delete and move, plus the locked internals every other sibling writes an event through), `invitations.ts` (every inbound scheduling message and every RSVP), `shares.ts`, `occurrences.ts` (the range reads), `transfer.ts` (whole-file export and import), `get-calendar.ts` (access resolution, the Drive `get-drive.ts` analogue). Beside them: `resource-store.ts` (what a resource means as columns — `sanitizeCalendarId`, `sanitizeEventUri`, `resourceBytes`, `readCalendarTotalSize`, `indexResource`, `EVENT_MAX_BYTES` — over the domain-neutral half both DAV domains share in `lib/core/blob-store.ts`: `normalizeResourceUri`, `sanitizeResourceUri`, `computeResourceEtag`, the rebuild generation `nextSyncGen`, the `BroadcastBatch` and the store result types, none of which knows SQL), `share-propagation.ts`, `invite-propagation.ts`, `imip.ts`, `recurrence.ts`, `event-input.ts`, `mappers.ts`, `types.ts` (the inbound payload shapes), `schema.ts`, `db-config.ts`, `sse-events.ts`.
- **`apps/api/src/lib/ical/`** — the format itself, read and written by every surface that meets an `.ics` (the store, iMIP, import, export, quick look, CalDAV): `ical-parse.ts` (the two readers, the `EIGEN` names, the address and key helpers), `ical-component.ts` (build, patch, re-stamp, strip), `blocks.ts` (the VTIMEZONE/VEVENT splice an export joins files with), `vtimezone.ts`, `wall-clock.ts`, `recurrence-limits.ts`, behind an `index.ts` barrel.
- **`apps/api/src/lib/caldav/`** — the protocol layer only: `caldav-router.ts`, `discovery.ts`, `propfind.ts`, `proppatch.ts`, `report.ts`, `resource.ts`, `xml-builder.ts`, `xml-parser.ts`. The shared XML envelope and principal props live in `dav/xml.ts`, the PROPFIND prop selection in `dav/propfind.ts`, the store-result → HTTP mapping both write surfaces take in `dav/write-result.ts`, the sync-token grammar and the `valid-sync-token` refusal in `dav/sync-token.ts`, the href shapes and the multiget resolver in `dav/href.ts`, the OPTIONS header and realm in `app.ts`.
- **`apps/api/src/routes/calendar.ts`** — thin REST bindings, the transfer routes included.
- **`packages/lib/src/core/calendar/`** — FE hooks + SSE handlers, `calendar-utils.ts` (`formatEventWhen`, `rruleToText`, `viewerTimeZone`, `normalizeTimezone`, `isInvitationFromOthers`, `isSeriesOccurrence`, `truncateRRule`), `windows-zones.ts` (the CLDR table `normalizeTimezone` resolves an Outlook zone name through, which the API imports through the same deep path) and `preview-lines.ts` (the method labels an `.ics` quick look shows); shared types in `packages/lib/src/types/calendar.ts`.
- **`packages/ui/src/components/calendar/`** — what draws an event outside the calendar app too: `EventDetailCard` (one event, read-only, from data alone — the detail dialog's body and the `.ics` quick look's card, [PREVIEWS.md](PREVIEWS.md)), `AttendeeList` beside it, and `ImportToCalendarPicker`.

Storage layout: [STORAGE.md](STORAGE.md). Database inventory: [DATABASE.md](DATABASE.md). Quotas: [QUOTA.md](QUOTA.md).
