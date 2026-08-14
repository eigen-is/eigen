# Proposal: CardDAV — contacts as vCard files + address-book sync

> **TLDR**: Add CardDAV (RFC 6352) so iOS/macOS Contacts, DAVx⁵, and Thunderbird sync Eigen contacts two-way, using the same Basic-auth app-password setup CalDAV already has. The enabling move (decided 2026-08-14): restructure contact storage to **mimic mail, not calendar** — one `.vcf` file per contact under `eigen.contacts/cards/`, files are the source of truth, and `contacts.db` becomes a rebuildable index the way `MailDB` indexes the maildir. That makes round-trip fidelity perfect by construction (a DAV GET returns the exact bytes a client PUT, unknown properties and all) and turns the contacts store into plain files you can grep, back up, and import anywhere. Existing contact books are **dropped, not migrated** (decided — they are seed-scale on eigen.is, and zero export code beats carrying a legacy path forever): a **v2 migration on `contacts.db`** drops the v1 tables and creates the index shape in place, the emptied book reseeds like a new account, and the existing avatar-cleanup pass sweeps the orphans. The protocol layer is a near-clone of `apps/api/src/lib/caldav/` minus its two hard parts (recurrence, VTIMEZONE): a `/dav/addressbooks/:ownerId/…` router, `addressbook-home-set` discovery, `addressbook-multiget`/`addressbook-query`/`sync-collection` REPORTs backed by the calendar's ctag + tombstone pattern, and content-hash ETags. Labels ride as `CATEGORIES` (membership truth moves into the file; the `labels` table keeps name + color). Photos ride as inline `PHOTO` (canonical in the file; `avatars/*.webp` becomes a derived cache). REST routes and the Contacts app are untouched. ~1 day for the storage relayout, ~1.5–2 days for the protocol surface; the phases are sequential.

## Goals

1. **Contacts sync to real devices.** Add an Eigen account to iOS/macOS Contacts, DAVx⁵ (Android), or Thunderbird and get two-way sync — create on the phone, it appears in the app; edit in the app, it lands on the phone. Same credential story as CalDAV/IMAP: Basic auth via `authenticateBasic` (`apps/api/src/lib/auth/protocol-auth.ts` — app password with primary-password fallback).
2. **Fidelity by construction.** A client's vCard survives Eigen untouched: unknown properties (`IMPP`, `URL`, `X-*`, extra `TEL` types Eigen doesn't model) round-trip because the stored file *is* the DAV resource. No regenerate-and-pray serializer.
3. **Contacts become portable files.** `eigen.contacts/cards/*.vcf` on disk mirrors what `eigen.mail/Maildir` did for mail: standard format, greppable, restorable, exportable with `cp`.
4. **CalDAV-grade incremental sync.** `sync-collection` (RFC 6578) with ctag + tombstones, copied from the calendar implementation, so clients pull deltas, not full books.

## Non-goals

- **Team or shared address books.** Contacts are per-Home personal data today and CalDAV is `requireSelf`-only too (`caldav-router.ts:36`); the layout leaves room (`cards/` is one book, siblings possible) but v1 ships exactly one book per user.
- **A global address list.** Team-member suggestions stay REST-side (`useContactSuggestions`); exposing the org directory over CardDAV is a different feature with different ACL questions.
- **Multiple address books, MKADDRESSBOOK.** One fixed book named "Contacts"; MKADDRESSBOOK/MKCOL → 403.
- **vCard 4.0 output.** Serve 3.0 (what iOS prefers and every client accepts), accept 3.0 and 4.0 on PUT. Stored bytes keep whatever version the client sent.
- **Real `addressbook-query` filtering.** v1 answers query REPORTs with the full card set and lets the client filter — the same permissive-superset stance the CalDAV handlers already take on PROPFIND prop lists. iOS and DAVx⁵ drive sync through `sync-collection` + `multiget` anyway.
- **Mapping Apple group vCards to labels.** Apple's Contacts creates groups as separate `X-ADDRESSBOOKSERVER-KIND:group` cards; v1 stores them verbatim (fidelity) but hides them from the app's contact list. Label mapping for them is deferred; DAVx⁵'s default per-contact `CATEGORIES` mode maps to labels in v1.
- **Fetching remote `PHOTO;VALUE=URI` images.** Kept verbatim in the file, never fetched server-side (SSRF), no thumbnail.

## Current state (recap)

**Contacts is DB-canonical.** `apps/api/src/lib/contacts/` stores structured rows in `eigen.contacts/contacts.db` (`db-config.ts`, version 1): `contacts` (firstName, lastName, eigenId, `data` JSON with email[]/phone[]/company/jobTitle/address[]/birthday/notes/avatar — `schema.ts:5-16`), `labels` (name + color), and a junction table. The `Contacts` class (`contacts.ts:48`) does CRUD + SSE, seeds "yourself" and optionally the org owner on init (`:67-109`), guards self-deletion (`:156-163`), and pushes profile changes through the home relay when you edit your own card (`:166-181`). Avatars are webp thumbnails in `eigen.contacts/avatars/` written by `uploadAvatar` (`:291-309`), referenced by URL string in `contact.avatar`. REST surface: `apps/api/src/routes/contacts.ts:42-168`. No `uri`, no `etag`, no tombstones, no raw-format storage — none of the DAV plumbing exists on this domain yet.

**CalDAV is the protocol template.** `apps/api/src/lib/caldav/` (~1.5k lines) serves RFC 4791 at `/dav/calendars/:ownerId/…`: thin Elysia router (`caldav-router.ts`), discovery chain `PROPFIND /dav/` → `current-user-principal` → principal props with `calendar-home-set` (`discovery.ts`, `xml-builder.ts:66-71`), collection PROPFIND, PROPPATCH, GET/PUT/DELETE with `If-Match`/`If-None-Match` ETag preconditions (`resource.ts:35-45`), and REPORTs including `sync-collection` with `urn:eigen:sync:<ctag>` tokens and the RFC 6578 invalid-token error that forces a clean full resync (`report.ts:126-167`, `:143`). The calendar schema carries the sync bookkeeping this proposal copies: per-collection `ctag` (`calendar/schema.ts:11`), per-resource `etag` (`:37`) + `eventCtag` (`:46`), and an `event_tombstones` table `{uri, deletedAtCtag}` (`:59-69`). URI comes from the request path, UID from the payload (`resource.ts:85-101`). Client setup is manual-URL today — there is no `/.well-known/caldav` anywhere in the API.

**Mail is the storage template.** `MaildirStore` (`apps/api/src/lib/mail/maildir-store.ts`) treats files under `eigen.mail/Maildir` as the source of truth and `MailDB` as a rebuildable index, reconciled by `syncMailbox` (`:248`) under a one-slot semaphore so a reconcile never straddles a mutation's fs+db pair (`:26-28`). It fs-watches the maildir (`:55-66`) because an out-of-process writer (Postfix) delivers into it — a reason contacts don't have.

**Format-freeze context.** eigen.is is live and storage formats are generally frozen, but Reinder ruled (2026-08-14) that contacts are exempt: the storage format may change freely **and existing contact data may be dropped** where that keeps the code clean. Contact books on eigen.is today are essentially the auto-seeded rows (`addYourself` + org owner) plus a handful of manual entries, and re-adding those is cheaper than carrying a row-to-vCard export path forever. Dropping still needs a mechanism, though — populated `contacts.db` files exist on eigen.is, so the cleanup rides a normal v2 schema upgrade (see Design § 1).

## Alternatives considered

1. **DB stays canonical, vCards regenerated on GET** — rejected. Lossy by construction: the first Eigen-side edit after a phone sync strips every property Eigen doesn't model, and two-way sync then propagates the damage back to the client's address book. A server that corrupts client data on round-trip is worse than no server.
2. **DB canonical + raw vCard sidecar column (the calendar's `icsBlob` model)** — workable, but the merge discipline ("regenerate owned properties, splice unknown ones from the sidecar") is fiddly, and the reasons calendar needs DB-canonical rows — time-range queries, recurrence expansion, iMIP cross-linking — don't exist for contacts. It also keeps contacts locked inside SQLite instead of making them portable files.
3. **Files as truth, index DB derived (the mail model)** — **chosen** (directed by Reinder). Fidelity is free, the storage story matches mail, and the index keeps list/search/labels fast. Cost: a one-time storage relayout, priced in Phase 1 — and with the data-drop ruling, no migration at all.

## Design

### 1 — Storage relayout: `cards/` + rebuildable index (Phase 1)

```
eigen.contacts/
  cards/<contactId>.vcf    ← source of truth, one vCard per contact
  avatars/<contactId>.webp ← derived thumbnail cache (web UI)
  contacts.db              ← rebuildable index + sync bookkeeping
```

- **Cleaned by a v2 upgrade, in place** (`db-config.ts`): eigen.is homes already carry `contacts.db` files with data, so the cleanup goes through the machinery built for exactly this — `CONTACTS_DB_CONFIG` bumps to `currentVersion: 2`, and the v2 migration drops the v1 tables/indexes and creates the new index shape. `ManagedDatabase` applies pending migrations sequentially on first open (`managed-database.ts:128-152`), so existing homes upgrade the moment they load contacts, the emptied book reseeds through the normal fresh-account path (`contacts.ts:82-106`), and the avatar-cleanup pass already in `init` (`:108`) sweeps the now-orphaned webp files. The v1 migration block stays verbatim (fresh homes run v1 then v2 — one empty-table create/drop at home creation, harmless); `schema.ts` describes only the new shape, as the pattern already has it. No new filename, no filesystem special-casing.
- **Index schema**: `contacts` becomes an index of the files — keeps `id` (doubles as the resource name, `<id>.vcf`), `firstName`/`lastName` (sort), `eigenId`, `data` JSON (parsed projection for fast list), `updatedAt`; gains `etag` (SHA-256 hex of the file bytes), `mtime` + `size` (the reconcile fast path), `uid` (vCard UID, unique per book), and `isGroup` (hides `KIND:group` cards from the app). The `data` projection stores the **avatar URL string only, never photo bytes** — base64 `PHOTO` payloads stay in the files and must never leak into the index or the list response. New: a one-row `book` table carrying `ctag`, and `contact_tombstones` `{uri, deletedAtCtag}` — both straight copies of the calendar pattern (`calendar/schema.ts:11`, `:59-69`). `labels` and the junction table keep their shape; the junction becomes derived data, rebuilt from each card's `CATEGORIES` on parse.
- **Etag = content hash.** The resource is the bytes, so the etag is a hash of the bytes — simpler and more honest than the calendar's field-hash `computeEtag`, and it makes reconcile trivially able to detect out-of-band file edits.
- **Reconcile on open, no watchers.** `reconcileIndex()` runs at init: list `cards/` and compare **mtime + size** against values stored in the index — the clean case (always, in practice) is one directory listing plus stats, zero file reads, zero parses. Only entries whose stat drifted get read, hashed, and re-parsed; rows whose file vanished get tombstoned; `ctag` bumps only if something actually changed. Unlike mail there is **no out-of-process writer** (Postfix is why mail fs-watches), so no watchers — every in-process mutation updates file + index together under a one-slot `Semaphore`, exactly `MaildirStore.storeLock`'s job (`maildir-store.ts:26-28`). If a rebuild ever loses tombstones, the ctag bump invalidates outstanding sync-tokens and clients do a clean full resync via the existing invalid-token path (`report.ts:143`) — degraded, never wrong.

### 2 — vCard parse/serialize (Phase 1)

`apps/api/src/lib/carddav/vcard-parse.ts` + `vcard-serialize.ts`, mirroring the scope and hand-rolled style of `ical-parse.ts`/`ical-serialize.ts` (same content-line grammar: unfolding, parameters, escaping — no new dependency).

- **Parse** → structured `Contact` projection for the index: `N`/`FN` → firstName/lastName (prefer `N`, fall back to splitting `FN`), `EMAIL`/`TEL` → arrays, `ORG`/`TITLE`, `ADR` components → `Address`, `BDAY` → birthday, `NOTE` → notes, `CATEGORIES` → labels, `UID`, `X-EIGEN-ID` → eigenId, `KIND`/`X-ADDRESSBOOKSERVER-KIND` → isGroup. Parse is for the *index*; the file keeps everything.
- **Serialize** is property-preserving: an Eigen-side edit parses the existing file, replaces only the properties Eigen owns (the list above), keeps every other property verbatim and order-stable, and writes back. A contact created in the app gets a minimal clean vCard 3.0 with `UID` + `X-EIGEN-ID`.
- **`X-EIGEN-ID` linkage with fallback.** The eigenId ↔ user link rides as an X-property. Clients are *supposed* to round-trip unknown properties but some strip them, so reconcile re-derives the link by email match (the same signal `getMe`/`addYourself` key on, `contacts.ts:358-366`) when the property is missing.

### 3 — `Contacts` class refit, same public surface (Phase 1)

`addContact`/`updateContact`/`deleteContact`/`getContacts`/`getContactById`/`getMe` and the label methods keep their signatures — `routes/contacts.ts`, the hooks, and the Contacts app change **zero lines**. Internally every write becomes serialize → write file → update index row + etag → bump ctag → SSE, under the mutation semaphore; deletes remove the file, tombstone the uri, bump ctag.

New DAV-facing methods (so the protocol handlers stay as thin as `caldav/resource.ts`): `listCards()`, `getCardBytes(uri)`, `putCard(uri, bytes)` (parse/validate → write verbatim bytes → index → ctag → SSE), `deleteCard(uri)`. `putCard` on your own card still fires the profile push `updateContact` does today (`contacts.ts:166-181`), but the own-email guarantee (silently prepending your account email) stays app-side only — rewriting a client's payload would break the verbatim-bytes contract, and the `X-EIGEN-ID`/email rematch keeps the link alive without it. `deleteCard` on your own card → 403, mirroring `deleteContact` (`:156-163`).

**Photos:** inline `PHOTO` in the file is canonical. A DAV PUT with an inline photo gets decoded and thumbnailed via the existing `generateImagePreview` pipeline into the cache; an app-side avatar upload keeps the `uploadAvatar` API and additionally rewrites the `PHOTO` property. Cache files are named `<contactId>-<hash8>.webp` (first 8 chars of the photo hash), so a changed photo changes the URL — preserving the natural cache-busting today's random filenames give against the route's 15-minute cache headers (`routes/contacts.ts:157`), with `cleanupAvatarImages` sweeping superseded files as it already does. `contact.avatar` stays a URL string for the FE, now always pointing at the derived cache. Remote-URI photos: verbatim in file, ignored by the cache (see Non-goals).

### 4 — CardDAV protocol surface (Phase 2)

`apps/api/src/lib/carddav/` mirroring `caldav/` file-for-file, mounted in `app.ts` next to `caldavRouter`:

- **Router** at `/dav/addressbooks/:ownerId/…` — `authenticateBasic` + `requireSelf` on every route, wildcard path parsing, ~150 lines like `caldav-router.ts`.
- **Discovery**: add the `CARD` namespace (`urn:ietf:params:xml:ns:carddav`) to the shared `xml-builder.ts` `NS` string and extend `principalProps` with `<CARD:addressbook-home-set>/dav/addressbooks/:userId/</CARD:addressbook-home-set>` — one principal serves both protocols; clients only read the props they know. Book collection props: `<CARD:addressbook/>` resourcetype, displayname "Contacts", `getctag`, `sync-token`, `supported-address-data` (vCard 3.0).
- **Resources**: GET returns the stored bytes verbatim (`text/vcard; charset=utf-8`, quoted etag); PUT/DELETE copy the `If-Match`/`If-None-Match` precondition logic from `resource.ts:35-45`; PUT validates by parsing but stores the client's bytes untouched; resource name from the path, UID from the payload, per the CalDAV precedent (`resource.ts:85-101`). PUT bodies over a 1 MiB constant → 413 (photos are the only legitimate bulk).
- **REPORTs**: `addressbook-multiget` (hrefs → etag + `CARD:address-data` per card), `addressbook-query` (full-set superset response, see Non-goals), and `sync-collection` copied from `report.ts:126-167` including tombstone 404-rows and the invalid-token full-resync error.
- **Well-known** (small broken-window fix bundled here): `GET`/`PROPFIND /.well-known/carddav` **and** `/.well-known/caldav` → 301 `/dav/` — iOS account setup probes these on the bare domain, and CalDAV never had it either. Deploy note: the front proxy (Caddy) must forward both paths to the API — one line in the site config, goes on the deploy checklist.

### 5 — Labels ↔ CATEGORIES

Membership truth moves into the file (`CATEGORIES:Friends,Work`) — otherwise the junction table and the file are two sources of one fact and every DAV rewrite risks drift. The `labels` table remains the *definition* store (id, name, **color** — color has no vCard home). Consequences, all mechanical: parse rebuilds the junction from `CATEGORIES`, auto-creating unknown label names with a color picked from `EIGEN_COLORS`; label rename rewrites `CATEGORIES` in member files (their etags change — correct, clients must re-fetch); label delete removes the category from member files; app-side label assignment is just another owned-property edit through the serializer.

## Performance invariants

The avatar chain is genuinely hot — `useResolvedUser` sits behind nearly every rendered avatar in every app and reads the full contact list (`packages/lib/src/core/public/hooks/use-resolved-user.ts:15`) — and home init is latency-sensitive. The files-as-truth design must not leak file I/O or payload weight into those paths:

- **REST reads never touch `.vcf` files.** `getContacts`/`getContactById`/suggestions serve from the SQLite index exactly as they serve from tables today — same query count, same shapes. Files are opened only on writes and on DAV GET/multiget (streamed straight out, no parse).
- **No photo bytes in the index, list responses, or SSE events — ever.** The index `data` projection carries the avatar URL string; base64 `PHOTO` blobs live only in the files. This is the one place the design could silently multiply the `useContacts()` payload by ~1000×, so it's an invariant, not a preference.
- **Parsing and hashing happen at write time only.** Etag, projection, label links, and the thumbnail are computed when a card changes (rare, human-initiated) and stored; no request-time recomputation anywhere.
- **Reconcile's clean case is stat-only.** One directory listing + mtime/size comparison on home open — no reads, no hashes, no parses unless something actually drifted. At contact-book scale that is sub-millisecond noise next to what home init already does.
- **DAV sync answers come from the index.** `sync-collection` and PROPFIND Depth:1 are pure SQLite (uris, etags, tombstones); only multiget/GET stream file bytes, and those are the requests whose payload *is* the file.
- **Avatar serving is byte-identical to today**: small cached webp + the existing 15-minute cache headers; thumbnail generation stays per-write and capped by the 1 MiB PUT limit.

## Phased rollout

- **Phase 1 — storage relayout** (~1 day): vCard parse/serialize + unit tests, index schema v2 (drop-and-recreate migration), `Contacts` refit with semaphore + reconcile, photo/label plumbing. Ships alone and near-invisible: REST behaviour and the app are unchanged (`contacts.test.ts` passes as-is), but existing books reset to the seeded state.
- **Phase 2 — protocol surface** (~1.5–2 days): `carddav/` router + discovery + resources + REPORTs, `CARD` namespace in `xml-builder.ts`, well-known redirects, integration tests, real-client verification, docs (`docs/CONTACTS.md` with a CardDAV section, AGENTS.md table row, HELP-CENTER device-setup article alongside the CalDAV one).
- **Deferred**: team/shared books, org directory (GAL), Apple group-card ↔ label mapping, real `addressbook-query` filters, vCard 4.0 output.

## Verification gate

- **vCard unit tests**: folding/unfolding, parameter and value escaping, `N`↔`FN` mapping, `ADR` components, `CATEGORIES`, inline `PHOTO`, and the load-bearing one — *byte-preserving round-trip of unknown properties* through a parse → owned-property edit → serialize cycle.
- **Reset + rebuild tests**: opening a `contacts.db` at schema version 1 with populated rows applies the v2 migration, leaves no v1 tables, and reseeds cleanly (yourself + org owner as `.vcf` files); a fresh home reaches the same end state; an index rebuilt from `cards/` alone reproduces identical projections, labels, and etags.
- **Existing suites unchanged**: `contacts.test.ts` green with zero edits — the proof the refit kept the public surface.
- **CardDAV integration tests** mirroring `caldav.test.ts` + `caldav-client-sync.test.ts`: discovery chain, PUT/GET byte identity, If-Match 412s, self-delete 403, multiget, sync-collection delta + tombstone + invalid-token resync, group-card hidden from REST list.
- **Performance invariants as tests**: the contacts list response for a card with an embedded photo contains the URL string and no base64 payload; a clean reconcile re-parses zero files (assert the parse counter stays at 0 on a second init over an unchanged book).
- **Real clients** (per [VERIFICATION.md](VERIFICATION.md)): DAVx⁵, iOS Contacts, Thunderbird — create/edit/delete in both directions, phone-created contact appears in the app with labels and photo, app edit reaches the phone with the client's X-properties intact.
- `bun run check`.

## Risks and caveats

- **The deploy resets every user's contact book** to the seeded state — decided, not accidental. eigen.is books are seed-scale today; anyone with manual entries re-adds them (or syncs them back from a phone once CardDAV is live). Say so in the release note.
- **Index/file divergence** is the structural risk of any files+index design. The semaphore makes in-process pairs atomic-enough; reconcile-on-open plus content-hash etags catches everything else. Worst degradation is a ctag bump → clients full-resync.
- **Sync-token invalidation on rebuild** — deliberate and safe (RFC 6578 defines the recovery), but a pathological reconcile loop would make clients re-download the book repeatedly; the ctag only bumps when something actually drifted.
- **Clients that strip `X-EIGEN-ID`** downgrade the user-link to email matching; a contact whose email also changed in the same client edit loses the link until re-matched. Acceptable: the link only powers profile-push and self-guards, and the same edit via REST has the id.
- **Label renames fan out** file rewrites + etag bumps across every member card; fine at contact-book scale.
- **`PROPFIND` prop-list permissiveness** (returning the fixed superset regardless of the request body) is inherited from CalDAV — it has survived real clients there, but a new client that chokes on unrequested props would need the proper prop-filtering both protocols currently skip.

## Decisions (2026-08-14)

1. **Files as truth, mail model** — directed by Reinder mid-review; the fidelity and portability arguments close the case. The calendar's DB-canonical + `icsBlob` model stays calendar-only.
2. **Existing contact data is dropped, not migrated** (Reinder, 2026-08-14) — and the drop rides the normal `ManagedDatabase` upgrade: a v2 migration on `contacts.db` drops the v1 tables and creates the index shape in place, then the book reseeds like a new account. No export code, no new filename, no init-time filesystem special-casing — eigen.is homes with populated v1 files clean themselves on first open.
3. **`CATEGORIES` is label-membership truth**; the `labels` table keeps definitions (color). One fact, one home.
4. **Inline `PHOTO` is canonical**, `avatars/*.webp` demoted to derived cache.
5. **One address book, vCard 3.0 output, `requireSelf`-only** — matching CalDAV's current scope.
6. **No fs-watchers** — contacts have no out-of-process writer; reconcile-on-open covers manual disk surgery.
