# CalDAV

> **TLDR:** `apps/api/src/lib/caldav/` serves RFC 4791 at `/dav/calendars/:ownerId/`, the protocol layer only. The calendar store under it decides every write ([CALENDAR.md](CALENDAR.md)), and `apps/api/src/lib/dav/` holds what it shares with CardDAV. Not obvious from the code: a GET returns the stored bytes verbatim, and a PUT answers an ETag only when it kept the client's own bytes. A copy of somebody else's event takes only its alarms from a PUT. Every filter Eigen can't apply is answered with a superset, never a refusal.

## CalDAV serves the owner's own calendars

Every route runs `authenticateBasic` (an app password, then the primary-password fallback, which a 2FA user can't take) and `requireSelf`. So a client sees the user's own calendars only. A team calendar and a calendar someone shared are web-only, and the Integrations page (`apps/space/src/routes/_auth.services.tsx`) lists no address for them.

A client finds the server at `/.well-known/caldav`, which the Caddy edge redirects to `/dav/`. The Integrations page also lists one address per calendar, because a client such as Thunderbird subscribes per collection and never revisits the home for a calendar made later. How to connect a device is the help-center article [connect/calendar-client](../apps/index/src/data/support/connect/calendar-client.md).

OPTIONS and the `Basic realm="Eigen DAV"` challenge live in `app.ts`, one header for the whole `/dav` tree. `MKCALENDAR` creates a calendar at the client's chosen id and answers 405 when it is taken. `MKCOL` creates nothing. Deleting the default calendar is a 403.

## Eigen names what it creates, and keeps a client's name as written

A REST create, an import and an inbound invitation all get a minted `<uuid>.ics`, because a UID is its author's string and may carry `/`, `..` or quotes. A CalDAV client's own name goes through `sanitizeEventUri`, the shared segment rule in `lib/core/blob-store.ts` over `isSafePathSegment` (`lib/core/path-utils.ts`). Anything else is a 400.

NFC is the only fold, because macOS clients send the same name in NFD form in a URL. Case is not folded: a PUT under `Event.ics` beside `event.ics` makes a second resource. A calendar id is client-chosen through MKCALENDAR and takes the same rule, so `Work` and `work` are two calendars. `validateCalendarProps` (`calendar/calendar.ts`) is the one rule for a calendar's name and color, so REST, MKCALENDAR and PROPPATCH can't drift apart.

## GET serves the stored bytes, and PUT answers an ETag only for bytes it kept

A resource is its bytes, so a GET returns them property for property, with the `X-EIGEN-*` lines the store added. The owner's own clients are the only readers of those. The ETag is the hash of the bytes the GET served.

A PUT often stores other bytes than it received. The store re-stamps the Eigen lines, and a linked copy keeps its own component. RFC 4791 § 5.3.4 lets the response carry an ETag only when the stored text equals the request body. Otherwise there is none, and the client re-reads. A PUT of what is already stored is judged on the bytes, commits nothing and moves no ctag, so no other client is sent to resync.

## A PUT is judged inside the write lock

`putResource` (`calendar/dav-store.ts`) evaluates every precondition inside the write lock, against the state it would overwrite. Two racing `If-Match` PUTs serialize there, and the loser gets a 412.

The body is bounded at `EVENT_MAX_BYTES` before it is buffered, so a hostile PUT can't park up to the server's 1 GB body cap on the heap. The collection advertises the same number as `C:max-resource-size`. A UID another resource of the calendar holds is a 409 naming that resource's href. A body that won't parse, holds two UIDs, or holds no VEVENT is a 403 with the RFC 4791 precondition that broke. `dav/write-result.ts` is the one table from store result to HTTP status, shared with CardDAV.

**A copy of somebody else's event takes only its alarms.** When the stored resource carries `X-EIGEN-ORGANIZER-EVENT`, the PUT keeps the stored component and adopts only the incoming `VALARM`s, matched on UID plus recurrence key. The rule reads the server's stamp, not the `ORGANIZER` address. Apple Calendar and Thunderbird write the account's own address as `ORGANIZER` on every event they create with guests, so the address alone proves nothing ([CALENDAR-INVITATIONS.md](CALENDAR-INVITATIONS.md#an-attendee-may-re-alarm-a-copy-and-nothing-more)).

A PUT fans nothing out: the guests of an event a device created get no invitation until the owner edits it in the web app ([ROADMAP.md](ROADMAP.md)).

## PROPFIND answers the props asked for

The shared core in `dav/propfind.ts` returns the requested props it has, and echoes unknown ones in a 404 propstat unless the client sent `Brief: t` or `Prefer: return=minimal`. A bodyless PROPFIND is allprop. A collection advertises the ownership and privilege props, because Apple clients read editability from them and treat a server without them as read-only (`dav/xml.ts`). Its `supported-report-set` lists exactly the three REPORTs that exist.

## A time-range query over-reports rather than lose an occurrence

`calendar-query` answers a VEVENT `time-range` from the projected index. A resource whose recurrence the index can't expand, a stripped rule or an `RDATE` (`hasUnindexedRecurrence`), rides along in every window. A filter naming a component Eigen doesn't store matches nothing. Every other filter element is parsed past, so no filter narrows the answer. The window does: a cancelled occurrence is no occurrence, so a resource whose only instance in the window is cancelled is not matched.

`calendar-multiget` decodes each href before matching and re-encodes it on output. It caps a request at `MULTIGET_HREF_LIMIT` and dedupes hrefs per resource through the NFC key, so a client listing one resource in both Unicode forms can't make the server hold its bytes twice.

## A sync token carries the calendar's generation

`sync-collection` (RFC 6578) tokens read `urn:eigen:sync:<syncGen>-<ctag>` (`dav/sync-token.ts`). The delta is every resource whose `resourceCtag` is past the token, plus the tombstones past it as 404 rows. A tombstone is keyed on its uri and a write clears it, so no href is both a 200 and a 404 in one response.

`syncGen` is seeded from the clock when a calendar row is created, so a calendar recreated at a deleted id never reissues a generation a client has seen. A token with a stale generation, or a ctag ahead of the collection, gets 403 `D:valid-sync-token`. That is sabre's status, which clients key their full resync on. An empty delta under an unknown token would stall that client forever.

## A REPORT past its byte budget still lists every resource

One REPORT serves at most `REPORT_DATA_BUDGET_BYTES` (32 MiB) of calendar data (`dav/report-row.ts`). A resource past the budget still gets its row, with its etag and a 404 propstat for `calendar-data` (RFC 4918 § 9.1), and the client multigets it next. A silently truncated collection would lose events instead.

Partial retrieval is answered whole: a `calendar-data` projection, `expand`, `limit-recurrence-set` and a `sync-collection` `nresults` limit are all parsed past. A client that asked for less pays the full bytes ([ROADMAP.md](ROADMAP.md)).

## Tests

Under `apps/api/src/test/`: `caldav/caldav.test.ts` for the protocol, `caldav/caldav-roundtrip.test.ts` for serialize-and-parse fidelity, `caldav/caldav-client-sync.test.ts` for sync flows as real clients run them, and `calendar/dav-store.test.ts` for the store seam, the ceilings and the move rules.

## See also

- [CALENDAR.md](CALENDAR.md): the store every write lands in
- [ICALENDAR.md](ICALENDAR.md): how the bytes are read and written
- [CONTACTS.md](CONTACTS.md): the CardDAV twin
- [WEBDAV.md](WEBDAV.md): the drive's DAV surface
