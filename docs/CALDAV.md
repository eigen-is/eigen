# CalDAV

> **TLDR:** CalDAV is how a calendar app on a phone or a desktop, such as Apple Calendar or Thunderbird, syncs a user's Eigen calendars. `apps/api/src/lib/caldav/` serves it (RFC 4791) at `/dav/calendars/:ownerId/`, and it is the protocol layer only: the calendar store under it decides every write ([CALENDAR.md](CALENDAR.md)), and `apps/api/src/lib/dav/` holds what it shares with CardDAV.

CalDAV is WebDAV applied to calendars: HTTP with a few extra methods, such as PROPFIND to read properties and REPORT to query. A client signs in with HTTP Basic, normally with an app password the user makes for it on the Integrations page. It first finds the principal, the URL that stands for the account (`/dav/principals/:ownerId/`). The principal names the calendar home, and the home lists one collection per calendar. Inside a collection each event series is one resource, an `.ics` file the client reads with GET and writes with PUT. That resource is the stored text [CALENDAR.md](CALENDAR.md) describes, so CalDAV has no storage of its own: it answers from the store's rows.

Three words carry the sync. An ETag is a fingerprint of a resource's bytes. A client sends it back in `If-Match`, so its write fails rather than overwrite a change it has not seen. A ctag is a counter on a collection that moves on every change, so a client learns in one request whether anything changed. A sync token names a point in a collection's history, and a `sync-collection` REPORT answers with what changed since then.

The sections go from connecting to syncing: who can reach which calendar, how a resource is named, what GET and PUT answer, how a PUT is judged, how a request body is read, then PROPFIND, the queries, the sync token and the size bound on a REPORT. Three things in them surprise people:

- A GET returns the stored bytes as they are, and a PUT answers with an ETag only when it kept the client's own bytes ([§ GET serves the stored bytes](#get-serves-the-stored-bytes-and-put-answers-an-etag-only-for-bytes-it-kept)).
- On a linked copy, the event an invitation puts in an attendee's own calendar ([CALENDAR.md](CALENDAR.md)), a device can change only its alarms ([§ A PUT is judged inside the write lock](#a-put-is-judged-inside-the-write-lock)).
- A query filter Eigen can't apply is answered with too many results, so no client misses an event; only a filter element in another namespace is refused ([§ A time-range query over-reports](#a-time-range-query-over-reports-rather-than-lose-an-occurrence)).

## CalDAV serves the owner's own calendars

Every route runs `authenticateBasic`, which calls `verifyProtocolAuth` (`lib/auth/protocol-auth.ts`), the app-password check CalDAV, CardDAV, WebDAV and Dovecot share. It is described with Dovecot, its one caller from outside the API ([IMAP.md § Dovecot asks the API whether a password is right](IMAP.md#dovecot-asks-the-api-whether-a-password-is-right)). Every route also runs `requireSelf`. So a client sees the user's own calendars only. A team calendar and a calendar someone shared are web-only, and the Integrations page (`apps/space/src/routes/_auth.services.tsx`) lists no address for them.

A client finds the server at `/.well-known/caldav`, which the Caddy edge redirects to `/dav/`. The Integrations page also lists one address per calendar, because a client such as Thunderbird subscribes per collection and never revisits the home for a calendar made later. How to connect a device is the help-center article [connect/calendar-client](../apps/index/src/data/support/connect/calendar-client.md).

OPTIONS lives in `app.ts` and the `Basic realm="Eigen DAV"` challenge in `lib/core/errors.ts`, one header for the whole `/dav` tree. `MKCALENDAR` creates a calendar at the client's chosen id and answers 405 when it is taken. `MKCOL` creates nothing. Deleting the default calendar is a 403.

## Eigen names what it creates, and keeps a client's name as written

A REST create, an import and an inbound invitation all get a minted `<uuid>.ics`, because a UID is its author's string and may carry `/`, `..` or quotes. A CalDAV client's own name goes through `sanitizeEventUri`, the shared segment rule in `lib/core/blob-store.ts` over `isSafePathSegment` (`lib/core/path-utils.ts`). Anything else is a 400.

NFC is the only fold, because macOS clients send the same name in NFD form in a URL. Case is not folded: a PUT under `Event.ics` beside `event.ics` makes a second resource. A calendar id is client-chosen through MKCALENDAR and takes the same rule, so `Work` and `work` are two calendars. `validateCalendarProps` (`calendar/calendar.ts`) is the one rule for a calendar's name and color, so REST, MKCALENDAR and PROPPATCH can't drift apart.

## GET serves the stored bytes, and PUT answers an ETag only for bytes it kept

A resource is its bytes, so a GET returns them property for property, with the `X-EIGEN-*` lines the store added. The owner's own clients are the only readers of those. The ETag is the hash of the bytes the GET served.

A PUT often stores other bytes than it received. The store re-stamps the Eigen lines, and a linked copy keeps its own component. RFC 4791 § 5.3.4 lets the response carry an ETag only when the stored text equals the request body. Otherwise there is none, and the client re-reads. A PUT of what is already stored is judged on the bytes, commits nothing and moves no ctag, so no other client is sent to resync.

## A PUT is judged inside the write lock

`putResource` (`calendar/dav-store.ts`) evaluates every precondition inside the write lock, against the state it would overwrite. Two racing `If-Match` PUTs serialize there, and the loser gets a 412.

The body is bounded at `EVENT_MAX_BYTES` before it is buffered, so a hostile PUT can't park up to the server's 1 GB body cap on the heap. The collection advertises the same number as `C:max-resource-size`. A UID another resource of the calendar holds is a 409 naming that resource's href. A body that won't parse, holds two UIDs, or holds no VEVENT is a 403 with the RFC 4791 precondition that broke. `dav/write-result.ts` is the one table from store result to HTTP status, shared with CardDAV.

**A copy of somebody else's event takes only its alarms.** When the stored resource carries `X-EIGEN-ORGANIZER-EVENT`, the PUT keeps the stored component and adopts only the incoming `VALARM`s, matched on UID plus recurrence key. The rule reads the server's stamp, not the `ORGANIZER` address. Apple Calendar and Thunderbird write the account's own address as `ORGANIZER` on every event they create with guests, so the address alone proves nothing ([CALENDAR.md](CALENDAR.md#an-attendee-may-re-alarm-a-copy-and-nothing-more)).

A PUT fans nothing out ([CALENDAR.md § The organizer's writes fan out](CALENDAR.md#the-organizers-writes-fan-out-and-only-the-organizers)): the guests of an event a device created get no invitation until the owner edits it in the web app ([ROADMAP.md](ROADMAP.md)).

## A request body is read by namespace, and a malformed one is a 400

PROPFIND, REPORT, MKCALENDAR and PROPPATCH bodies reach `parseXml` (`apps/api/src/lib/core/xml.ts`) as bytes, so a UTF-16 body reads like UTF-8, and a DOCTYPE is refused before Bun sees it: Bun applies an ATTLIST default to every element, and a 1 MiB body of them costs seconds and gigabytes. Every element is matched by namespace and local name, never by prefix, because each client binds its own: Apple writes `A:` for `DAV:`, DAVx⁵ a default namespace. So a `getetag` in another namespace is an unknown prop, and a REPORT root in another namespace is not a REPORT.

A body that is not well-formed, binds no prefix or carries a DOCTYPE is a 400 on every route, as RFC 4918 asks, and so is one whose root is not the method's: `DAV:propfind` for PROPFIND, CalDAV's `mkcalendar` for MKCALENDAR, `DAV:propertyupdate` for PROPPATCH. Guessing what it meant (allprop, the defaults) would answer a question nobody asked. The discovery PROPFINDs on `/dav/` and the principal serve the same props whatever the body names, and still check it. Bun's parser is strict, and each of these is malformed too: whitespace before `<?xml`, a trailing NUL, invalid UTF-8 in a body that declares no encoding, and an encoding Bun can't read, such as windows-1252. A blank body keeps its meaning: allprop for PROPFIND, the defaults for MKCALENDAR, nothing for PROPPATCH. A blank REPORT is a 400, because a default would dump every event's etag. Hrefs, sync tokens and text-match values are trimmed, since a client that indents its body indents inside them too. Attribute values are read as written, untrimmed. MKCALENDAR and PROPPATCH read `displayname` and `calendar-color` from every `set`, so a later one wins.

## PROPFIND answers the props asked for

The shared core in `dav/propfind.ts` returns the requested props it has, and echoes unknown ones in a 404 propstat, by the name and namespace they were asked with, unless the client sent `Brief: t` or `Prefer: return=minimal`. Every unknown prop is echoed in every row, so a prop asked twice counts once, more than 1,000 distinct props is a 400, a request whose 404 echo would pass 64 KiB is a 400 (each echoed prop repeats its namespace URI, so one long URI declared once would be written a thousand times per row), and rows that miss the same props share one 404 propstat, built once per request. A bodyless PROPFIND is allprop. A collection advertises the ownership and privilege props, because Apple clients read editability from them ([CARDDAV.md § Apple needs write privileges on the book](CARDDAV.md#apple-needs-write-privileges-on-the-book)). Its `supported-report-set` lists exactly the three REPORTs that exist.

## A time-range query over-reports rather than lose an occurrence

`calendar-query` answers a VEVENT `time-range` from the projected index. A resource whose recurrence the index can't expand, a stripped rule or an `RDATE` (`hasUnindexedRecurrence`), rides along in every window. A filter naming a component Eigen doesn't store matches nothing. A `UID` `text-match` on the VEVENT, the shape a lookup by UID sends, answers only the resources whose UID matches. The calendar's resource rows are read without their bytes and filtered in JS, so a lookup returns one resource, not the collection, but still reads every row. It is a substring match, ASCII case-folded unless the client names `i;octet`, and `negate-condition` inverts it. Every other filter element, and a text-match in any other collation, is parsed past and narrows nothing. A filter element in another namespace, or a `filter` in one, alone or beside the CalDAV `filter`, is the exception: it is no CalDAV filter, so it is a 403 `supported-filter`, as in CardDAV, rather than an answer of every event. A `calendar-query` with no filter at all matches every event. The window narrows too: a cancelled occurrence is no occurrence, so a resource whose only instance in the window is cancelled is not matched.

`calendar-multiget` decodes each href before matching and re-encodes it on output. It caps a request at `MULTIGET_HREF_LIMIT` and dedupes hrefs per resource through the NFC key, so a client listing one resource in both Unicode forms can't make the server hold its bytes twice.

## A sync token carries the calendar's generation

`sync-collection` (RFC 6578) tokens read `urn:eigen:sync:<syncGen>-<ctag>` (`dav/sync-token.ts`). The delta is every resource whose `resourceCtag` is past the token, plus the tombstones past it as 404 rows. A tombstone is keyed on its uri and a write clears it, so no href is both a 200 and a 404 in one response.

`syncGen` is seeded from the clock when a calendar row is created, so a calendar recreated at a deleted id never reissues a generation a client has seen. A token with a stale generation, or a ctag ahead of the collection, gets 403 `D:valid-sync-token`. That is sabre's status, which clients key their full resync on. An empty delta under an unknown token would stall that client forever.

## A REPORT past its byte budget still lists every resource

One REPORT serves at most `REPORT_DATA_BUDGET_BYTES` (32 MiB) of calendar data (`dav/report-row.ts`). A resource past the budget still gets its row, with its etag and a 404 propstat for `calendar-data` (RFC 4918 § 9.1), and the client multigets it next. A silently truncated collection would lose events instead.

Partial retrieval is answered whole: a `calendar-data` projection, `expand`, `limit-recurrence-set` and a `sync-collection` `nresults` limit are all parsed past. A client that asked for less pays the full bytes ([ROADMAP.md](ROADMAP.md)).

## Tests

Under `apps/api/src/test/`: `caldav/caldav.test.ts` for the protocol, `caldav/caldav-roundtrip.test.ts` for serialize-and-parse fidelity, `caldav/caldav-client-sync.test.ts` for sync flows as real clients run them, and `calendar/dav-store.test.ts` for the store interface, the ceilings and the move rules.

## See also

- [CALENDAR.md](CALENDAR.md): the store every write lands in, and how the bytes are read and written
- [CARDDAV.md](CARDDAV.md): the CardDAV twin
- [WEBDAV.md](WEBDAV.md): the drive's DAV surface
