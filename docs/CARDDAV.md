# CardDAV

> **TLDR:** CardDAV is how a contacts app on a phone or a desktop syncs a user's one address book. Eigen serves it (RFC 6352) at `/dav/addressbooks/:ownerId/contacts/`. The protocol layer is `apps/api/src/lib/carddav/`, a near twin of `caldav/` that shares `lib/dav/`. The book is vCard 3.0 in storage and on the wire. The storage model is in [CONTACTS.md](CONTACTS.md).

CardDAV is the address-book twin of CalDAV, and [CALDAV.md](CALDAV.md) explains the words both use: principal, collection, resource, ETag, ctag and sync token. A client such as Apple Contacts, Thunderbird or DAVx⁵ on Android signs in with an app password, finds the principal, and syncs one collection, the book. Each card is one resource, a `.vcf` file holding the vCard text that [CONTACTS.md](CONTACTS.md) stores, so CardDAV has no storage of its own.

The sections cover the routes and discovery, the privileges Apple needs, the 3.0 transcode, how a PUT is judged, sync and REPORTs. Five things in them surprise people:

- Apple treats every card as read-only unless the book says the user may write it ([§ Apple needs write privileges](#apple-needs-write-privileges-on-the-book)).
- A vCard 4.0 PUT is rewritten to 3.0 before it is stored, so its answer carries no ETag ([§ The book is vCard 3.0](#the-book-is-vcard-30-so-a-40-put-is-transcoded)).
- `If-Match` and `If-None-Match` are checked inside the store's write lock, never in the handler ([§ A PUT parses before the lock](#a-put-parses-before-the-lock-and-decides-inside-it)).
- A refused delete of the user's own card comes back on the next sync ([§ A refused self-delete](#a-refused-self-delete-lists-the-card-again)).
- Apple's group cards are stored but never shown ([§ Group cards](#group-cards-are-stored-but-not-shown)).

## One principal serves both CalDAV and CardDAV

Every route authenticates with HTTP Basic through `verifyProtocolAuth`, the app-password check every protocol shares. It is described with Dovecot, its one caller from outside the API ([IMAP.md § Dovecot asks the API whether a password is right](IMAP.md#dovecot-asks-the-api-whether-a-password-is-right)). Each handler calls `resolveContacts` first, before it reads the body, so a stranger's request never costs a parse. The shape clients depend on:

```
PROPFIND /dav/addressbooks/:ownerId/*               home, the book, or one card (Depth 0 or 1)
GET      /dav/addressbooks/:ownerId/contacts/:uri   the stored bytes, with the content-hash ETag
PUT      /dav/addressbooks/:ownerId/contacts/:uri   create or replace
DELETE   /dav/addressbooks/:ownerId/contacts/:uri   404 unknown, 403 your own card, 412 stale If-Match
REPORT   /dav/addressbooks/:ownerId/contacts/       multiget, query, sync-collection
MKCOL, MKADDRESSBOOK                                403: one fixed book
```

Discovery runs from the edge. Caddy redirects `/.well-known/carddav` to `/dav/`. `PROPFIND /dav/` names the principal, and its props (`principalProps`, `lib/dav/xml.ts`) carry both `calendar-home-set` and `addressbook-home-set`. A client reads only the props it knows. The `OPTIONS` header lives in `app.ts` for the whole `/dav` tree and includes the `addressbook` token, because clients check for it before they trust the account. The 401 realm is the neutral `Eigen DAV` (`lib/core/errors.ts`).

The book's segment is `contacts` and its displayname "Contacts". Any other book name is a 404. `PROPFIND` returns only the props asked for, through the shared core in `lib/dav/propfind.ts`.

## Apple needs write privileges on the book

Apple Contacts reads editability from `current-user-privilege-set` and `owner`. Without them it treats every card as read-only. macOS then saves each edit as a new card with a fresh UID, so the server fills with duplicates while the Mac shows one contact. `ownershipProps` (`lib/dav/xml.ts`) serves both props on the home and the book, for CardDAV and CalDAV alike. The privileges are truthful, because only the owner ever reaches the book. `carddav/carddav.test.ts` pins them.

## The book is vCard 3.0, so a 4.0 PUT is transcoded

iOS and DAVx⁵ speak 3.0, and every client accepts it. Thunderbird 102+ PUTs `VERSION:4.0` anyway, and 4.0 bytes served back lose the photo on iOS. So `transcodeTo30` (`vcard/transcode.ts`) rewrites a 4.0 card before storage. Constructs with no 3.0 form pass through unchanged.

The ETag is the SHA-256 of the stored bytes, hashed once at the write and stored beside them, so a GET hashes nothing. A transcoded body is not the one the client sent. The PUT then answers with no ETag (RFC 4918 § 9.7.2), and the client re-fetches. The self-link restoring a stripped `X-EIGEN-ID` gets the same answer ([CONTACTS.md](CONTACTS.md#your-own-card-is-linked-by-x-eigen-id)). Bytes round-trip exactly for 3.0 clients, and in meaning for 4.0 ones.

## A PUT parses before the lock and decides inside it

`putCard` (`contacts/dav-store.ts`) checks the body ceiling, transcodes and parses before it takes the lock. None of that depends on stored state, so a 5 MiB parse makes no other writer wait. `If-Match` and `If-None-Match` are evaluated inside the lock, against the row the write replaces. Two racing `If-Match` PUTs serialize, and the loser gets 412. The calendar store does the same in the same place.

A UID is required and can't change. A UID another card owns is a 409 `no-uid-conflict` naming that card's href, never a raw constraint error. `parseVCardLines` refuses a second `BEGIN:VCARD`, so one PUT is one card.

The resource name is client-chosen, so `sanitizeCardUri` runs before any store call. It folds to NFC, because macOS sends names in NFD, and one card must not answer under two spellings. Case is not folded. Then `isSafePathSegment` (`lib/core/path-utils.ts`), the rule every client-chosen segment in Eigen takes, applies with a `.vcf` suffix. Anything else is a 400.

## A sync token carries the book's generation

Tokens have the grammar and the generation rules of CalDAV's ([CALDAV.md § A sync token carries the calendar's generation](CALDAV.md#a-sync-token-carries-the-calendars-generation)), because one handler answers `sync-collection` for both (`lib/dav/sync-collection.ts`). The delta is every row whose `cardCtag` is past the token, plus tombstones as 404 rows. Tombstones are keyed by name, so a re-created card clears its own, and no href is both a 200 and a 404.

A stale token gets 403 `valid-sync-token`, and that full resync is what heals ghost deletions.

## REPORTs answer from the database, within bounds

A metadata-only answer, like a `PROPFIND` Depth 1 or a plain `sync-collection`, reads the uri, the etag and the byte length and never touches the blob. Only a row that serves `address-data` reads its bytes.

- **`addressbook-multiget`** decodes hrefs before matching and encodes every emitted one. More than 500 hrefs is a 400, and duplicates collapse to one row.
- **`addressbook-query`** filters in memory over every card, group cards included (`query-filter.ts`). RFC 6352 is match-only: clients treat every returned card as a match. So an unsupported collation or filter is a 403, never a superset. Results stop at the client's limit or 1000.
- **Partial `address-data`** serves only the asked properties plus the skeleton the RFC requires (`address-data.ts`).

A REPORT body is capped at 1 MiB before it reaches the XML parser, which reads it as CalDAV's are read: by namespace, with a malformed body a 400 ([CALDAV.md § A request body is read by namespace](CALDAV.md#a-request-body-is-read-by-namespace-and-a-malformed-one-is-a-400)). A filter element outside the CardDAV namespace is one Eigen can't map, so it is a 403 `supported-filter`. The card data one REPORT serves has CalDAV's byte budget, and a card past it still gets its row ([CALDAV.md § A REPORT past its byte budget still lists every resource](CALDAV.md#a-report-past-its-byte-budget-still-lists-every-resource)).

## A refused self-delete lists the card again

A user deleting their own card gets a 403. Thunderbird drops the card from its view before the request and ignores the 403. So the refusal also bumps the book `ctag` and re-stamps the card, leaving its bytes alone. The next `sync-collection` lists it as a changed row, and a client that dropped it downloads it again. Other clients pay one extra re-fetch.

## Group cards are stored but not shown

Apple Contacts writes each group as a separate `X-ADDRESSBOOKSERVER-KIND:group` card. Eigen stores it verbatim and serves it over DAV, but the web app's list hides it (`isGroup`), and import and export skip it. Group cards are not mapped to labels. DAVx⁵ in its default `CATEGORIES` mode and Thunderbird show such a card as a blank contact (Mozilla bug 1807394).

## See also

- [CONTACTS.md](CONTACTS.md): the storage model, the write path and labels
- [CALDAV.md](CALDAV.md): the CalDAV twin
- Tests: `apps/api/src/test/carddav/` for the protocol, `apps/api/src/test/contacts/dav-store.test.ts` for the store
- Setup for users, including Thunderbird not animating a GIF photo: [connect/contacts-client](../apps/index/src/data/support/connect/contacts-client.md)
