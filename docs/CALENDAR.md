# Calendar

> **TLDR:** Each user, and each team that turns it on, has calendars of events in one SQLite database per Home. An event is kept as the iCalendar text that was written for it, plus Eigen's own `X-EIGEN-*` lines, and that text is the truth. Beside it the database keeps extracted fields such as title, start and end, so the app can query fast, and those can be rebuilt from the text at any time. The store is `apps/api/src/lib/calendar/`, the iCalendar reading and writing is `apps/api/src/lib/ical/`, the web app is `apps/calendar/`, and the CalDAV server has [CALDAV.md](CALDAV.md).

A user has one or more calendars, and each calendar holds events. A calendar can be shared with other users and with teams. A team can have calendars too, once an admin turns that on. Guests have no calendar.

An event gets in and out in four ways. The web app talks to the REST routes in `apps/api/src/routes/calendar.ts`. A calendar client such as Apple Calendar or Thunderbird syncs over CalDAV. An invitation travels between Eigen users directly, and to and from everyone else by mail. That mail format is iMIP (RFC 6047): a mail that carries a small iCalendar file. And a whole `.ics` file can be imported or exported.

All of it lives in one file per Home, `eigen.calendar/calendar.db`. A Home is the data folder of one user or one team ([STORAGE.md](STORAGE.md#a-home-is-loaded-on-demand-and-dropped-when-idle)), so there is one database per owner, not one per calendar. The calendars are rows in its `calendars` table.

The truth for an event is its iCalendar text (RFC 5545, the `.ics` format): a `VCALENDAR` wrapper with one `VEVENT` block per event inside. Eigen stores that text as it was written, plus its own `X-EIGEN-*` lines, in the `ics` column of a row in the `resources` table. A resource is one such stored file, the unit a CalDAV client reads and writes. It holds one series: an event with all its repeats. When someone changes a single occurrence of a series, iCalendar writes the changed occurrence as an extra `VEVENT`, called an override, and it lives in the same resource. Keeping the text as written means nothing a client sent is lost. A reminder setting or a property Eigen has never heard of goes back to that client unchanged on its next sync.

The text sits in a database column and not in `.ics` files on disk, for two reasons. One transaction writes the text together with everything derived from it, so a crash can't leave the two disagreeing. And only the API process opens the database, so there are no watchers and nothing to reconcile, unlike mail, where Dovecot changes the files too ([IMAP.md](IMAP.md)).

Parsing iCalendar text for every "what happens this week" would be slow. So each write also fills the `events` table: one row per `VEVENT` and one per cancelled occurrence, with the title, the start and end, the repeat rule and the guests as columns. The resource row has a few derived columns of its own. Together these are the projection. None of it is truth, because all of it can be thrown away and computed again from the stored text.

Two more terms come back in every section. A stamp is an `X-EIGEN-*` line Eigen adds to the text for a fact iCalendar has no field for, such as who created the event. A linked copy is the event an invitation puts in a guest's own calendar: an ordinary resource with a stamp that names the organizer's event.

The sections run in this order: how an event is stored and written, time zones, repeats, sharing and quota, invitations between Eigen users, invitations by mail, import and export. Four things in them surprise people:

- No client can write a stamp, and an invitation's link to its organizer is a stamp, never the `ORGANIZER` address ([§ Eigen's own facts ride as X-EIGEN- lines](#eigens-own-facts-ride-as-x-eigen--lines-no-client-can-write)).
- A web save patches only what moved, while a CalDAV PUT replaces the file ([§ A web save patches what moved](#a-web-save-patches-what-moved-and-a-caldav-put-replaces-the-file)).
- A repeat is expanded on every read and never stored ([§ Recurrence is expanded per read](#recurrence-is-expanded-per-read-never-stored)).
- An invitation by mail acts only for a sender our own mail server verified ([§ Inbound iMIP](#inbound-imip-acts-only-on-a-sender-our-own-mta-verified)).

## The stored bytes are the event, and every column is a projection

A resource row holds the bytes a client wrote, `VALARM` details and unknown properties included, and the SHA-256 of those bytes is its etag. A CalDAV GET serves them back verbatim ([CALDAV.md](CALDAV.md#get-serves-the-stored-bytes-and-put-answers-an-etag-only-for-bytes-it-kept)). How a resource and a calendar are named is in [CALDAV.md](CALDAV.md#eigen-names-what-it-creates-and-keeps-a-clients-name-as-written).

The `events` rows, `uid`, `etag` and `hasUnindexedRecurrence` are projected from the bytes. `rebuildProjection` (`calendar.ts`) rewrites all of them from the blobs in one transaction, and `apps/api/src/test/calendar/resource-store.test.ts` pins that contract. A new projected column is added by altering the table and calling it.

Some facts no VCALENDAR can hold live only in the database: a calendar's name, color, visibility, default flag, `shares`, `ctag` and `syncGen`, the `resource_tombstones` a sync delta reports as removals, and the recipient-side `shared_calendars`. See `schema.ts` and [DATABASE.md](DATABASE.md). Because the events themselves live in these rows, the database runs synchronous FULL ([DATABASE.md § A database that holds the truth runs synchronous FULL](DATABASE.md#a-database-that-holds-the-truth-runs-synchronous-full)).

## One resource holds one series

A resource holds one UID, the id iCalendar gives a series. Under it sit the master VEVENT, which carries the repeat rule, one override VEVENT per edited occurrence, and a VTIMEZONE, the definition of a time zone, for every TZID they name. A PUT carrying two UIDs is refused, or a second UID's overrides would hang off the first master.

Eigen cancels one occurrence with an `EXDATE` on the master, never with a `STATUS:CANCELLED` override. Thunderbird omits such an override from its next PUT, and the full replace would read that as "the client removed the exception" and bring the occurrence back. Cancelling a moved occurrence replaces its override with an `EXDATE` too, and the cancelled row keeps the override's id. Deleting an occurrence that is already cancelled puts it back, whichever of the two spellings a client used, and sends the guests nothing.

## Eigen's own facts ride as `X-EIGEN-*` lines no client can write

iCalendar has no place for a row id, a creator, a color or an invitation link, so they ride inside the VEVENT as `X-EIGEN-*` properties, spelled once in `EIGEN` (`lib/ical/ical-parse.ts`):

| Line | Carries |
|---|---|
| `X-EIGEN-EVENT-ID` | the `events` row id, so an id survives a projection rebuild |
| `X-EIGEN-CREATED-BY` | the user who first wrote the resource |
| `X-EIGEN-ORGANIZER-EVENT`, `-USER` | the invitation link on an attendee's copy ([§ A linked copy is an ordinary resource](#a-linked-copy-is-an-ordinary-resource-with-the-organizers-stamp)) |
| `X-EIGEN-COLOR` | the per-event color |
| `X-EIGEN-IMPORTED-ORGANIZER` | the organizer an imported file named |
| `X-EIGEN-EXDATE` | beside each `EXDATE`: the exclusion's row id, SEQUENCE and message stamp |

**An incoming stamp is never trusted.** `parseIcs` is the reader for bytes a stranger wrote, and its result type can't name an Eigen fact, so a forged one has nowhere to land. On a PUT, `restampResource` strips every Eigen property and parameter at every level, then copies the stamps back from the stored resource. It matches on UID plus recurrence key, never on the raw `RECURRENCE-ID` or `EXDATE` text, which clients rewrite between TZID, UTC and comma-joined forms. Only a resource nobody wrote before takes the caller's own stamps. Nothing that leaves the Home carries a stamp, except a CalDAV GET to the owner's own clients.

## Every write takes one lock and one function

bun:sqlite already makes a transaction atomic and serial. `Calendar.writeLock` exists for the async gaps between a check and its commit, such as the quota lookup, so a racing `If-Match` PUT loses inside the lock. Reads take no lock.

Every resource write ends in `Calendar.writeResource`. It takes a `PreparedResource` computed once (`resource-store.ts`), so the bytes the checks judged are the bytes that land. It checks `EVENT_MAX_BYTES` (5 MiB), then the Home's storage budget, then commits. The commit is one transaction: the ctag bump, the blob, a delete-and-reinsert of the resource's `events` rows, and clearing any tombstone at that uri. A throw anywhere leaves the old bytes and the old projection in place. `purgeResource` is the same in reverse.

`Calendar` holds what must be one per Home: the database, the lock, the byte counter and the broadcast batch. The domain logic is plain functions over it in the sibling modules.

`moveEvent` re-homes a resource between two calendars of one Home in one transaction, so no window shows it in both. A lone occurrence can't be moved, a UID the target holds is a 409, and a uri the target holds becomes a fresh name. `deleteCalendar` deletes the calendar's tombstones itself, since no cascade reaches them and a calendar recreated at that id would inherit them.

## A web save patches what moved, and a CalDAV PUT replaces the file

The web form restates every field on every save. So `updateEvent` (`events.ts`) diffs the submitted times against the stored row, and `patchEvent` (`lib/ical/ical-component.ts`) writes only the properties that really changed. A title edit leaves a client's own `DTSTART` spelling, its `DURATION` and its VTIMEZONE alone. Each `ATTENDEE` line is patched in place, so `CUTYPE`, `RSVP` and every `X-` parameter a client set survive. Re-spelling the same instants in another zone changes bytes but is not a reschedule, so no guest is mailed.

A CalDAV PUT replaces the whole resource, under the preconditions and the linked-copy rule in [CALDAV.md](CALDAV.md#a-put-is-judged-inside-the-write-lock).

`touch` owns the revision fields. `LAST-MODIFIED` is always now. `DTSTAMP` is the applying message's stamp or the clock, but a local edit never moves it on an attendee's copy, where it orders the organizer's next message. `SEQUENCE` bumps only when the organizer makes a scheduling change to an event with attendees. An attendee copy takes the organizer's number instead, because a bump of its own would outrank the organizer's next update.

The web app sends no etag on an update, so two tabs editing one event last-write-win ([ROADMAP.md](ROADMAP.md)).

## ical.js is the one serializer, and an edit touches only what it changes

`ICAL.Component.toString()` writes every resource, so folding, escaping and parameter quoting are ical.js's problem. `buildResource` assembles a new VCALENDAR from rows, for a REST create and for an iMIP message about a whole series. Every other write edits the stored component in place (`patchEvent`, `putOverride`, `addExclusion`, `removeExclusion` in `ical-component.ts`), so every property Eigen didn't touch stays as the client wrote it.

A written `DTEND` removes the `DURATION` that stated the length before it, since RFC 5545 §3.6.1 allows one or the other. An end instant that falls in the second pass of a repeated hour can't be named in the stored zone's wall clock. It is written as a UTC `DTEND` beside the TZID `DTSTART`, which RFC 5545 allows, so the duration survives.

## Eigen writes a VTIMEZONE for every zone it names

Without a VTIMEZONE, strict parsers (ical.js included) read a TZID's wall times as floating (RFC 5545 §3.6.5). `vtimezone.ts` builds one from `Intl` offset data. A zone with a regular DST rule compresses to two open-ended RRULE observances, and an irregular one gets one observance per transition.

A definition a property still names is the client's own and is never rewritten. One nothing references any more is dropped. New blocks go in front of the VEVENTs, because a client reads the file top to bottom and a TZID met before its definition is floating to it. `apps/api/src/test/ical/vtimezone.test.ts` checks the generator against `Intl`.

## Two readers, one trust rule

`parseIcs(text)` reads bytes a stranger wrote and can't hold a stamp ([§ Eigen's own facts ride as X-EIGEN- lines](#eigens-own-facts-ride-as-x-eigen--lines-no-client-can-write)). `projectResource(component)` reads a resource the store wrote and adds the stamps on top of the same projection. `parseResource` is the only place a stored `.ics` becomes a component tree, so nothing else imports ical.js for one.

A VEVENT the parser can't read is skipped and counted rather than failing the file. Each caller answers for its own surface: a PUT refuses the payload, the quick look counts it in `dropped`, an import in `failed`. Each VEVENT is wrapped in an `ICAL.Event` built with `{ exceptions: [] }`, which skips ical.js's scan for sibling exceptions. That scan is quadratic over a whole file: 20,000 events took 17 s.

## A time resolves through Intl before the file's own VTIMEZONE

A valid IANA TZID resolves through `Intl` even when the file defines a VTIMEZONE for it. That is the path the builder computes its wall times with, so identical bytes name one instant, and a repeated hour resolves to its first pass. A UTC value is exact.

A TZID `Intl` doesn't know goes through `propTzid` (`ical-parse.ts`). It tries the Windows zone table first, because Outlook writes names like `W. Europe Standard Time` (`normalizeTimezone`, over the CLDR rows in `packages/lib/src/core/calendar/windows-zones.ts`). Then it tries the `X-LIC-LOCATION` of the file's VTIMEZONE, where libical writes the IANA name beside a TZID no standard knows. When neither resolves, the stored `timezone` is `null`, and the file's own VTIMEZONE still gives the parser its instants. A floating time maps its wall components through `Date.UTC`, never through the server's zone.

## Recurrence is expanded per read, never stored

An `RRULE` is stored as written and expanded in memory per query. An override is a VEVENT in the same resource, projected with `parentEventId` and `recurrenceDate`. An override keeps its stored occurrence key even after it moved, because the frontend sends that key back in a `scope='this'` RSVP.

A range read (`occurrences.ts`) is bounded by its window, not by the size of the Home. It loads the single events overlapping the window, the masters starting before its end (a rule never steps back before DTSTART), and their overrides plus any override moved into the window.

The edit dialog opens on an occurrence but "All events in series" saves on the master. So `seriesEditFromOccurrence` (`packages/lib/src/core/calendar/calendar-utils.ts`) sends a delta. The master's times shift by what the user moved, and a text field travels only when retyped. A series-wide text edit also reaches every override that still carried the master's old value; one that set its own keeps it.

## A RECURRENCE-ID names the original occurrence

An override's `RECURRENCE-ID` and an `EXDATE` both name the occurrence the series would have had, computed from the master in the master's own DTSTART form, value type included. It is never the override's moved start, and never `VALUE=DATE` because the override was toggled to all day. Either would match no occurrence and orphan the override (RFC 5545 §3.8.4.4).

## An occurrence is keyed by its wall-clock date in the series' zone

An occurrence key is a `YYYY-MM-DD` date. Expansion runs in wall-clock space, so an override must key to the same date to attach to its occurrence. A TZID `RECURRENCE-ID` or `EXDATE` keys on its own wall components, the RFC 5545 canonical form. A UTC value converts to the series' zone first, because a timed series crossing midnight UTC has a UTC day one off. Floating and `DATE` values keep their raw components. The series zone comes from each UID's master, and a master with no TZID keeps its series in UTC. `apps/api/src/test/calendar/calendar-timezone.test.ts` pins the keying.

Each `EXDATE` becomes a synthetic cancelled row. Its id and SEQUENCE come from the `X-EIGEN-EXDATE` stamp beside it, or the master's SEQUENCE when a client wrote the `EXDATE` itself. One occurrence is one row, however many forms name it.

An event ends at its `DTEND`, or at its `DURATION` when it names one, as Apple and Outlook both write. A timed VEVENT with neither is drawn as one hour, an all-day one as one day.

## Expansion is bounded because it walks from DTSTART

`rrule.between` steps from DTSTART to the window on the shared event loop. A `SECONDLY` rule starting a year back stalled it for about 74 s. So `recurrence-limits.ts` bounds what a rule may ask, before it is stored:

- A sub-daily rule is a 400 at the REST boundary. In a parsed `.ics` it is stripped from the projection, because refusing a whole file or invite over it is worse.
- A recurring DTSTART must fall between 1900 and 2200.
- One expansion yields at most `MAX_OCCURRENCES`, and a query window is clamped to five years.

A stripped rule stays in the stored bytes. The event draws as one occurrence, and `hasUnindexedRecurrence` makes a CalDAV time-range query return it for every window. An `RDATE` takes the same flag, and a `RANGE=THISANDFUTURE` override degrades to a single-instance edit.

## An all-day event is midnight UTC with an exclusive end

An all-day event's bounds are midnight UTC, and `endTime` is the day after the last day. The frontend reads the UTC date and never converts it. With an exclusive end, one invariant covers both kinds: `endTime < startTime` is a 400 over REST and a 403 on a PUT, and a zero-length event is legal. Inbound iMIP clamps a reversed interval to zero instead, because dropping an emailed invite is worse than showing it short.

`timezone` is nullable: only the web dialogs always set one. So `formatEventWhen` takes the fallback zone as a required argument. The browser passes `viewerTimeZone()`, the zone the grid draws in, so the detail dialog names the slot the grid shows. Invitation mail has no viewer and must not borrow the server's zone, so it renders a zone-less event in UTC and says so.

## Sharing is pushed, and team calendars are off by default

A share grants `free-busy` (time blocks only), `read` or `write`. When shares change, `share-propagation.ts` writes the calendar into each named recipient's `shared_calendars` ([ACL.md § Share Propagation](ACL.md#share-propagation)). A `free-busy` reader gets blocks with cancelled occurrences left out, so their existence doesn't leak.

A `TeamHome` starts with `{ calendar: { enabled: false } }`, and its `calendar` getter throws 404 until an admin enables it from the Admin app. Members get the team calendar in their `shared_calendars` at `read` on each `GET /calendar/:ownerId/shared`. A share on the team calendar upgrades them. While it is disabled, that sync removes the stale entries.

Two access rules guard a team home's calendars in `routes/calendar.ts`. Creating, changing and deleting one takes an org admin or the owner (`requireTeamAdmin`, since teams have no roles), because the admin sets a team calendar's shares. Any member may list them. Every event route takes the calendar share instead (`checkCalendarAccess`), so a member's `write` share is event-level. A non-team `ownerId` must be the caller's own.

REST bounds are never tighter than what a PUT may store. The ids Eigen mints cap at 512 characters, and every field a client spells caps at `EVENT_MAX_BYTES`, or an event a CalDAV client stored would be uneditable in the web app.

## Calendar shares the home data budget

Calendar counts against the home data quota with mail and contacts ([QUOTA.md](QUOTA.md)). `Calendar.size()` answers from the in-memory `eventsBytes`, so a device sync costs no query per resource. Each commit reads its delta inside its transaction and applies it after, so a rolled-back write moves nothing. A rewrite is credited the bytes it replaces, so a shrinking edit is never refused. A move and a delete are not metered. An inbound invitation over budget is dropped while its mail still lands, because a fire-and-forget receiver has nobody to answer a 507 to.

## Every write is announced to every Home that sees the calendar

A change broadcasts a `calendar:*` event ([SSE.md](SSE.md)) to the owner's tabs and to each Home the calendar is shared with. A PUT of bytes already stored commits nothing and announces nothing. An import holds its per-resource events and sends one `calendar:events-changed` at the end. The frontend hooks and the SSE handler that invalidates them are in `packages/lib/src/core/calendar/`.

## A linked copy is an ordinary resource with the organizer's stamp

An organizer's event with attendees puts a linked copy into each Eigen attendee's default calendar over the home relay, and mails everyone else an iMIP invitation (RFC 6047). Out is `invite-propagation.ts`, in is `invitations.ts`, mail is `imip.ts`. The copy is a resource whose VEVENTs carry `X-EIGEN-ORGANIZER-EVENT` and `X-EIGEN-ORGANIZER-USER`, projected to the indexed `organizerEventId` and `organizerUserId` columns. `findLinkedEvent` looks a copy up by that pair among masters only, because an override inherits the link and would otherwise answer for its series.

Only a trusted transport sets the link: the relay envelope, or a verified iMIP sender. `EventDataSchema` (`routes/calendar.ts`) has no field for the organizer, so a web save keeps the stored one whatever it posts back. An iMIP organizer has no Eigen id, so its `organizerUserId` is `external_<address>`, the way a team is `team_<id>`. `isExternalOwnerId` sends such an organizer's RSVP by mail instead of over the relay.

## An attendee may re-alarm a copy and nothing more

On a linked copy, `updateEvent` keeps changes to reminders and color and drops the rest. The edit dialog disables the same fields (`detailsDisabled`), so a save never drops them silently. The calendar select stays live, because moving the copy to another calendar is allowed.

Whether an event is somebody else's invitation is `isInvitationFromOthers` (`packages/lib/src/core/calendar/calendar-utils.ts`). It compares the stored organizer address with the Home user's, case-insensitively. A stored `ORGANIZER` alone means nothing: Apple Calendar and Thunderbird write the account's own address on every event they create with guests, and that event is the owner's own. The guard, `deleteEvent`, `rsvp()`, the inbound REPLY lookup and both calendar dialogs all use this one rule. A CalDAV PUT reads the stamp instead ([CALDAV.md](CALDAV.md#a-put-is-judged-inside-the-write-lock)).

On a calendar another user shared, both dialogs compare with that owner's address, which `usePublicUser` resolves. A team Home has no address, so the dialogs ask for none, and on a team calendar the rule reads Eigen's organizer stamp (`organizerEventId`), as a CalDAV PUT does: an event a member organized carries only the member's address and stays the team's own.

## The organizer's writes fan out, and only the organizer's

A create or update with attendees diffs the old list against the new one, then adds, updates or cancels each copy. Only the organizer fans out, because a guest's own SEQUENCE bump would outrank the organizer's next update. An Eigen user gets a copy over the home relay. Anyone else, and any guest-role user, gets an iMIP mail and a share registry entry, so their account reconciles on signup ([ACL.md § Share Registry](ACL.md#share-registry)). The acting user's own address is skipped. So is the calendar owner's, when a collaborator with write access invites them: the event already sits in the owner's calendar, so the owner is marked accepted instead of getting a copy.

When the organizer deletes, every copy is cancelled. A team Home has no address to send a CANCEL from, so an outside guest of a team event gets none, and the skip is logged ([ROADMAP.md](ROADMAP.md)). When an attendee deletes, it is a decline, but only if their address is in the event's attendees. A file or a CalDAV client can hang any `ORGANIZER` on an event, and a decline would then reach a stranger. An organizer known only by address, as every organizer a PUT or a file names is, gets the decline as an iMIP REPLY.

## An occurrence message names the series

A guest holds one linked series, and an override on it inherits the series' link. So every message about one occurrence names the series' event id plus the occurrence key, never the override's own row id. The receiver attaches it through `applyInvitationException`, the same path an iMIP REQUEST with a `RECURRENCE-ID` takes. The `RECURRENCE-ID` names the original instant, which only the series knows once the override has moved.

An override that states no guests inherits the series' list (`heldAttendees`, the one reading every sender and the RSVP path share). A stored VEVENT can't tell a client that didn't restate the list from one that emptied it, and reading it as empty would cancel that occurrence for every guest. Deleting such an override cancels it for the series' guests. A guest added to a series then gets every existing override as an update and every cancelled occurrence as a removal, or their copy would show a moved occurrence at its old slot.

A series-wide edit of the title, description or location reaches each override that still carried the master's old value. Guests run the same rule, so a moved occurrence is renamed everywhere without a message of its own.

## An RSVP names its scope

`PUT .../events/:id/rsvp` takes `{status, scope?, recurrenceDate?, remove?}`:

| Scope | Effect |
|---|---|
| `all` (default) | the attendee's status on the whole copy |
| `this` + `recurrenceDate` | an override with that status; with `remove`, an exclusion and a decline |
| `this-and-following` + `remove` | the copy's rule is truncated and a series-wide decline goes out |
| `remove` alone | the copy is deleted, as a decline |

`constrainRRule` (`recurrence.ts`) keeps an organizer's later update from extending the rule past a guest's truncation, so "delete this and following" survives the next edit. A copy that is one occurrence of a series the guest doesn't hold answers for that occurrence: its RSVP names its own `RECURRENCE-ID`, so it lands on the organizer's override that holds that occurrence's guests.

## Every inbound REQUEST takes one locked decision

A REQUEST relayed from another Home ([SCALABILITY.md](SCALABILITY.md)) and one mailed over iMIP both go through `decideInboundRequest`. It runs inside the write lock and looks up the UID Home-wide, so two concurrent deliveries can't file two masters for one UID.

1. **Update.** A stored copy linked to an organizer takes the message, but only when the sender is that organizer, so a co-attendee can't hijack it. A REQUEST for one occurrence attaches as an override, since a full update would collapse the series.
2. **Adopt.** A stored master nobody linked is claimed when its own organizer address equals the verified sender. `X-EIGEN-IMPORTED-ORGANIZER` wins over the `ORGANIZER` line here. The resource keeps its row ids and gains the link and the message's guest list.
3. **Create** in the default calendar, only when the body's `ORGANIZER` is the sender. A REQUEST for one occurrence of a series this Home doesn't hold files as a standalone event that keeps its `RECURRENCE-ID`, the only record of which occurrence it answers for.

A relayed message naming this Home as its own organizer is dropped, because adopting it would make an event a linked copy of itself.

**An occurrence copy gives way to the series.** When the organizer later invites the guest to the whole series, the standalone copy is purged and the series written in its place, inside one lock hold. The guest's reminders and color carry over. A CANCEL for that occurrence deletes the copy outright, since there is no series to exclude it from.

## Revisions are ordered, and a redelivery is applied as one

`isNewerRevision` (RFC 5546 § 2.1.5) compares SEQUENCE first, then `DTSTAMP`. The stored side is what the resource holds for that occurrence (`storedRevision`); a cancelled one reads the stamp beside its `EXDATE`. A lower SEQUENCE always loses. At equal SEQUENCE an equal or newer stamp is applied, and so is a message when either side has no stamp. `DTSTAMP` has one-second resolution, so such a message is a redelivery, and a redelivery patches to nothing: no ctag moves and the user is told nothing twice. A stamp more than 24 hours ahead of the receiver's clock is clamped to now, or it would outrank every genuine update at the same SEQUENCE.

Receivers never raise. A message over `EVENT_MAX_BYTES` or the storage budget is logged and dropped, because the mail it rode in on has landed and nobody is waiting for a 413 or a 507.

## iMIP mail carries the projected event, never the stored bytes

`imip.ts` composes REQUEST (with an "updated" banner for an update), CANCEL and REPLY. `serializeEventForImip` builds a fresh VCALENDAR from the rows, so no Eigen stamp can leak, and strips them anyway. A series travels whole: one VCALENDAR with the master, an `EXDATE` per cancelled occurrence and an override per edited one (RFC 5546). A message about one occurrence carries that occurrence alone.

**No `VALARM` ever travels.** The organizer's reminders are their own, and an email reminder would ship as `ACTION:EMAIL` naming the organizer, so every guest's client would mail the organizer at the trigger. The `URL` stays, since guests seeing the link is the point. A REQUEST asks each guest to reply (`RSVP=TRUE`) and lists the organizer as an accepted attendee. A CANCEL carries `STATUS:CANCELLED` and lists as its attendees exactly the guests it goes to (RFC 5546 § 3.2.5), because a cancelled occurrence holds no guest list and a removed guest is no longer on the event's. A CANCEL for a moved occurrence carries its moved times, the slot the guests last saw, while its `RECURRENCE-ID` names the original. An override that states no guests goes out with the series' list, as Eigen reads it ([§ An occurrence message names the series](#an-occurrence-message-names-the-series)). Its stored VEVENT stays without one: writing the list into it would freeze it, and a guest later added to the series would be missing from that occurrence.

## Inbound iMIP acts only on a sender our own MTA verified

`Mail.mailboxDeliver` (`lib/mail/mail-domain.ts`) scans a delivered message for a `text/calendar` part after the INBOX append ([MAIL.md](MAIL.md)). It waits for the calendar, so a client reacting to the new-mail event already finds the change. A failure is only logged and never fails the delivery.

Every change binds to the `From:` address, so the delivery computes a verdict with `verifyImipSender` (`lib/mail/imip-auth.ts`). A sender is verified when the topmost `Authentication-Results` header stamped with our own authserv-id records a `dkim=pass` for a domain aligned with the `From:` domain. OpenDKIM prepends its result and strips older ones with our id (`docker/postfix/entrypoint.sh`), so a header below it is a stale hop or a forgery. Anything else fails closed and the invite stays a plain attachment. An imported `.eml` never reaches the calendar, and an operator whose MTA writes no such header has automatic iMIP off. A message is acted on for its first `IMIP_MAX_EVENTS` (50) events only, since more is a mailed export, not a scheduling message.

A REQUEST or CANCEL from the recipient's own address is dropped. It is their own mail coming back through a forward or a list, and acting on it would turn their own event into somebody else's copy. A REPLY from one's own address is still processed.

REQUEST takes the [locked decision](#every-inbound-request-takes-one-locked-decision) with `external_<sender>` as the organizer. CANCEL removes the copy, or one occurrence of it under the ordering rule. REPLY moves PARTSTAT on the organizer's master or on that occurrence's override. It only sets the sender's own status, only for an invited attendee, and never brings back an occurrence the organizer deleted.

## The mail app draws an invite from the server's summary

`Mail.messageGet` summarizes each calendar part through the same parser into `Attachment.calendarInvite`, and `calendar-invite-widget.tsx` (`apps/mail/`) draws it inline instead of in the attachment list. A `null` summary is an unparseable file and draws as an error card.

## Import replays each series through putResource, as a device sync does

`Calendar.importEvents` (`transfer.ts`) takes a whole `.ics`, which must be UTF-8 (RFC 5545 §3.1). The event cap counts every VEVENT, not every master, because one master can hold 37,000 overrides inside `ICS_MAX_BYTES`. It is counted on the text before ical.js builds a tree, and again on what the parser returned. A file may spread one UID over several VCALENDAR objects, so VEVENTs are grouped by UID first.

Each series is written as its own resource through `putResource`, the path a CalDAV PUT takes ([CALDAV.md](CALDAV.md#a-put-is-judged-inside-the-write-lock)), under a fresh `<uuid>.ics`. UID uniqueness is Home-wide for an import, and a UID any calendar already holds counts as `skipped`. That makes a failed import retryable: a retry skips what landed and finishes the file. A written-bytes cap stops the run with a 413, because a VTIMEZONE the file defines once is copied into every series that names it.

**An import takes the scheduling out.** Every guest `ATTENDEE` is dropped, and the `ORGANIZER` becomes an inert `X-EIGEN-IMPORTED-ORGANIZER`. Otherwise the first edit would mail addresses the file's author chose, and a forged iMIP REPLY could match the event by UID. The imported organizer can still claim the event by sending a real invitation ([Adopt](#every-inbound-request-takes-one-locked-decision)).

## An import needs a target calendar

The file routes reach only the caller's own home and team homes, because only the home relay crosses into another user's Home. So a calendar another user shared is no target ([ROADMAP.md](ROADMAP.md)). An export takes `read` and an import `write`, and `free-busy` is no read here.

The "Import to Calendar" file action opens `ImportToCalendarPicker` (`packages/ui/src/components/calendar/`). It offers the viewer's own calendars, the team calendars they may write in, or a new one. `useImportToCalendar` deletes a new calendar again when it took no events, and a retry reuses the one it made.

## Export splices the stored lines

`exportEvents` lifts the `VTIMEZONE` and `VEVENT` blocks out of each stored resource as text (`spliceBlocks`, `blocks.ts`) and drops every line with an Eigen name. It never parses and re-serializes, because ical.js rewrites parameter quoting and order, and bytes Eigen only stored are not Eigen's to rewrite. The result is one VCALENDAR, never a concatenation, because many readers take only the first object of a stream. Nothing bounds the size of a whole-calendar export ([ROADMAP.md](ROADMAP.md)).

## See also

- [CALDAV.md](CALDAV.md): the CalDAV protocol and client setup
- [QUOTA.md](QUOTA.md), [DATABASE.md](DATABASE.md), [STORAGE.md](STORAGE.md), [ACL.md](ACL.md)
- [CONTACTS.md](CONTACTS.md): the contacts store on the same blob-store shape
- [MAIL.md](MAIL.md): the delivery route that feeds inbound iMIP
- [SCALABILITY.md](SCALABILITY.md): the home relay
- [PREVIEWS.md](PREVIEWS.md): the `.ics` quick look
- [EXPORT.md](EXPORT.md): why this export is not a document export
