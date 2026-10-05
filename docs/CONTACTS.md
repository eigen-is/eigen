# Contacts

> **TLDR:** Contacts is one personal address book per user. A contact is kept as the vCard text that was written for it, converted to 3.0 if it came as 4.0, and that text is the truth. The domain is `apps/api/src/lib/contacts/`, the vCard reading and writing is `apps/api/src/lib/vcard/` and the web app is `apps/contacts/`. Label membership lives in each card's `CATEGORIES`, so a rename rewrites every member card. Every write, from the web app, a device or an import, goes through one function under one lock. The protocol side is [CARDDAV.md](CARDDAV.md).

Each user has exactly one book, and no team or guest has one. A card gets in and out in three ways. The web app talks to the REST routes in `apps/api/src/routes/contacts.ts`. A contacts app on a phone or a desktop syncs over CardDAV. And a whole `.vcf` file can be imported or exported. Mail compose, the share dialogs and chat also suggest people from the book (`useContactSuggestions`).

The book is one database per user, `eigen.contacts/contacts.db` in their home folder, with the photos the web app serves in `eigen.contacts/avatars/`. A card is vCard text (RFC 6350, the `.vcf` format), stored as it was written so that nothing a device sent is lost. A 4.0 card is converted to 3.0 first, the version every client reads. Listing and searching a book by parsing every card would be slow, so each write also fills columns with the names, the emails and the rest. Those columns are the projection: none of them is truth, because all of them can be computed again from the stored text. The calendar works the same way ([CALENDAR.md](CALENDAR.md)).

The sections cover how a card is stored and written, the events a write sends, labels, photos, the book's size, import and export, the web app's writes, and the user's own card, the one that links the book to an Eigen account.

## A contact is its vCard bytes

The `vcard` column of a `contacts` row holds the card exactly as it was stored. The names, the `uid`, the `data` JSON, the `etag` and the label junction are a projection of those bytes, written in the same transaction. So a CardDAV GET returns the bytes a client PUT, unknown properties and all, and body and ETag can never disagree. `rebuildProjection` (`contacts.ts`) proves the claim: it rebuilds every projected column from the blobs, and `contacts/contacts-store.test.ts` pins it.

Some facts no card carries, so they live only in the database: label ids and colors, the server-owned `eigenId` self-link, the one-row `book` (the `ctag`, the `syncGen` and the `ownerSeeded` latch) and the delete tombstones. The schema is `schema.ts`.

The database runs `synchronous: 'FULL'` ([DATABASE.md](DATABASE.md#a-database-that-holds-the-truth-runs-synchronous-full)), because the cards themselves live in these rows. An acknowledged PUT must survive a power loss, and a book writes little enough that it costs nothing.

A book is personal. `resolveContacts` (`get-contacts.ts`) requires the caller to be the owner, so no team holds a book and none is shared. There are no file watchers either: unlike mail, nothing outside the API writes the book ([MAIL.md](MAIL.md)).

## Every card write goes through one function, under one lock

bun:sqlite makes a transaction atomic by itself. `writeLock` exists for the async gaps between a check and its commit: the quota lookup and the avatar derivation. A racing `If-Match` PUT must lose inside the lock, not after it. Reads take no lock.

`writeCard` (`contacts.ts`) owns the order. First the card ceiling and the storage quota judge the bytes, then the avatar rendition is derived, then one transaction commits. A 413 or a 507 therefore leaves neither a row nor a webp behind. The commit bumps the book `ctag`, upserts the row, rebuilds the label junction and clears any tombstone for that name. `purgeCard` is the reverse: one transaction deletes the row and writes the tombstone, then the card's own avatar is unlinked.

The byte delta is read inside the transaction and applied to the counter after it. A rollback would otherwise leave the delta applied.

## An event goes out after the lock is released

The store emits nothing. `putCard`, `deleteCard` and `deleteContact` announce once `writeLock.run` returns, naming the row id the store result carries. Reading the id back after the lock could race a delete and lose the event. `addContact` and `updateContact` announce inside the lock, with the id they already hold. The calendar announces from the same place.

A whole-file import runs inside `withBatchedEvents`, which holds the per-card events and closes on one `contacts:changed`. That event carries no ids, because every contact event invalidates the owner's whole list anyway. It fires from a `finally`, so the cards committed before a failure still reach open tabs. A device sync is one request per card, so nothing server-side spans it. There the client collapses the burst: `handleContactsSSEvent` (`packages/lib/src/core/contacts/sse-handlers.ts`) debounces the list invalidation by 250 ms per owner.

## Label membership lives in the card's CATEGORIES

If the junction were the truth, it and the blob would hold one fact twice, and every DAV rewrite could drift. So the `labels` table holds only definitions: id, name and color, since a color has no vCard home. Each write parses every `CATEGORIES` line of the card, because external clients split them, and rebuilds the junction from them.

A category with no matching label mints one, keyed on the normalized name (NFC, trimmed, lowercase) with a color hashed from that key. A DAV write can therefore emit `contacts:label-created`. REST label writes enforce the same unique key and answer a duplicate with 409.

A rename rewrites `CATEGORIES` in every member card, so their etags change and clients re-fetch them. `rewriteCardCategories` (`labels.ts`) runs inside the transaction that renames the label row, so the label and its members move together under one `ctag` bump. A member card that won't parse is skipped with a warning. A label delete strips the category the same way. A name typed in a REST create or rename is capped at `LABEL_NAME_MAX_LENGTH` (100 characters) and answers 422 past it, because the rename skips the per-card size check. A label minted from `CATEGORIES` keeps any length, and an update that keeps its name, such as a color change, still saves.

## The avatars folder is a second source of truth, not a cache

The inline `PHOTO` in the card is canonical. `avatars/` holds the webp the web UI serves, named `<contactId>-<hash8>.webp` after the embedded bytes' hash. A changed photo gets a new name, and the sweep reclaims the old one. The `data.avatar` projection holds only that URL. **Photo bytes never enter the projection, a list response or an SSE event**, because base64 photos would multiply the list payload many times over.

An upload is staged before the contact exists. It becomes two siblings, each encoded from the pristine upload: the 512 px webp Eigen serves, with alpha and animation, and an Apple-safe embed. The embed is JPEG, PNG for alpha, or GIF for animation. Apple Contacts decodes no webp. A save embeds the staged bytes verbatim into `PHOTO` and promotes the webp under the hash name. A later write that finds that name present keeps it, so a phone re-PUTting the card for a name edit does not replace the first-generation webp.

That makes `avatars/` a second source of truth, not a cache. The served webp can carry animation and alpha the Apple-safe `PHOTO` lost, so a backup archives the directory ([BACKUP.md](BACKUP.md)). A `PHOTO;VALUE=uri` stays in the card and is never fetched server-side, to rule out SSRF.

## A book's size is two in-memory counters

`Contacts.size()` answers `cardsBytes + avatarsBytes`. Both are seeded at init and moved by delta at every commit, purge and avatar write. A `SUM` per metered write would make a device sync of N cards cost O(N²). Contacts share the home data budget with mail and calendar ([QUOTA.md](QUOTA.md)). `writeCard` credits the size of the card being replaced, so a rewrite that shrinks a card is never refused.

Metering switches on at the very end of init. The quota lookup opens the Home, and during init that would await the init doing the write.

## Import replays each card through the CardDAV PUT

`transfer.ts` holds both halves of the whole-file `.vcf` transfer. Import splits the file with `splitVCards` and writes each card through `putCard` under a fresh `<uuid>.vcf` name with `If-None-Match: *`. A UID is not a safe resource name (Apple writes `…:ABPerson`). An imported card is therefore metered, quota-checked and stored byte-faithfully by the same code a device sync takes. A card with no `UID` gets one minted. An imported card never claims the self-link, because nobody inspects an imported card one by one (`import: true` on `putCard`).

The file is decoded as strict UTF-8, because a lenient decode would store replacement characters in every accented name and serve them to devices. Both import routes lift the server idle timeout, since a whole book answers nothing until its last card lands.

Duplicates are skipped, never merged. A card is skipped when its `UID` is already in the book, or its first email is one any contact already has, including earlier cards in the same file. Group cards are skipped too. A card that won't parse or that `putCard` refuses counts as failed, and the file continues. Only a quota refusal stops the run, with a 507 naming how many cards went in, because every later card would fail the same way. The cases are pinned in `contacts/contacts-transfer.test.ts`.

Export reads one row at a time, since the whole book's bytes in one query would not scale. It drops every `X-EIGEN-*` line, because the self-link carries the account's id. A whole-book export leaves out group cards, to match import.

## The web app writes with the etag it loaded

A REST update carries the `etag` its form loaded in the body, and a delete carries it as a query parameter. Both are required. A mismatch is a 412, which the hook answers by reloading the list and telling the user, so two tabs can't last-write-win. The etag is the same content hash CardDAV quotes. The edit form (`contact-edit.tsx`) re-seeds from a sync only while it is clean. With unsaved edits it keeps them and asks "changed elsewhere, reload?", as Drive's editor does. After a 412 it re-seeds anyway, because the toast has said the card was reloaded (`isStaleWrite`).

A REST field bound is never tighter than what a CardDAV PUT may store (`routes/contacts.ts`). A tighter bound would make a card a device stored uneditable in the web app.

A REST save is a full replacement, but `mergeVCard` (`vcard/serialize.ts`) diffs by value, so unchanged lines keep their bytes. Changing one email, phone or address is a dropped line plus an appended one. When one save drops exactly one line of a property and appends exactly one value, the new line inherits the old one's params and group, like `TYPE=WORK` or an `item1.X-ABLabel`. Any other shape has no unambiguous pairing, so the new values append bare.

## Your own card is linked by X-EIGEN-ID

Init adds the user's own card and, once, the org owner's. The `ownerSeeded` latch stops a deleted owner card from coming back. The user's card carries `X-EIGEN-ID` with their user id, and the server-owned `eigenId` column holds the link. At most one row holds it.

An update keeps the row's link and writes `X-EIGEN-ID` back when a client strips it. A create claims the link only when no row holds it yet, by carrying the user's `X-EIGEN-ID`, or their email on a card with no `X-EIGEN-ID` at all. A foreign id never claims (`selfClaimRank`, `dav-store.ts`). Editing their own card renames the user across the org and sets their avatar (`pushUserProfile`). Deleting it is refused: REST answers 400, CardDAV 403 ([CARDDAV.md](CARDDAV.md#a-refused-self-delete-lists-the-card-again)).

## See also

- [CARDDAV.md](CARDDAV.md): the protocol surface, sync and the client quirks
- [STORAGE.md](STORAGE.md) and [DATABASE.md](DATABASE.md): where `eigen.contacts/` sits
- [PREVIEWS.md](PREVIEWS.md): the Drive quick look of a `.vcf` file
- The help-center article [connect/contacts-client](../apps/index/src/data/support/connect/contacts-client.md)
