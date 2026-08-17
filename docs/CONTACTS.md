# Contacts & CardDAV

> **TLDR**: Contacts follow the **mail model, not the calendar model** — one vCard file per contact under
> `eigen.contacts/cards/*.vcf` is the source of truth, and `contacts.db` is a rebuildable index over those
> files (plus the sync/label metadata that lives only in the DB). That makes round-trips lossless by
> construction: a CardDAV GET returns the exact bytes the client PUT, unknown properties and all. The
> `apps/api/src/lib/carddav/` layer serves RFC 6352 at `/dav/addressbooks/:ownerId/…`, a near-clone of the
> CalDAV layer minus recurrence and timezones, with the same Basic-auth app-password story. One address book
> per user named "Contacts", vCard 3.0 on disk and on the wire, `requireSelf`-only. The domain lives in
> `apps/api/src/lib/contacts/`; the app UI and REST surface are unchanged.

## Storage model — files as truth

```
eigen.contacts/
  cards/<uri>.vcf               ← source of truth, one vCard per contact (filename = CardDAV resource name)
  avatars/<id>-<hash8>.webp     ← derived photo cache (web UI) + staged uploads
  contacts.db                   ← index over the cards + authoritative sync/label metadata
```

**The honest contract** (`contacts.db` is index *plus* authoritative metadata, not a disposable cache): what
the index **projects re-derives from `cards/` alone** — the card row's names, the `data` JSON projection,
the content-hash `etag`, and label *membership* (each card's `CATEGORIES`). What the DB **owns** lives
nowhere else and survives in backups: label ids + colors, the one-row `book` (`ctag`, `syncGen`,
`ownerSeeded`), the `contact_tombstones` log, and the two crash-recovery journals. A rebuild that starts from
`cards/` alone therefore reproduces identical projections, etags and category membership, but loses the
authoritative half — so any from-scratch rebuild **rotates `syncGen`** (below), forcing clients into a full
resync rather than trusting a counter that reset under them.

The index is reshaped for this by a **v2 migration** on `contacts.db` (`db-config.ts`, `currentVersion: 4`)
that **drops the v1 tables** and creates the cards-as-truth shape; the emptied book reseeds through the normal
fresh-account path (yourself, plus the org owner if `onboarding.autoAddOwnerContact`). v3 heals an early
tombstone column, v4 adds the two recovery journals — both pure additive migrations. See the reset-on-deploy
note at the end: existing contact data is **dropped, not migrated** (a decided trade — eigen.is books are
seed-scale, and zero export code beats carrying a legacy path forever).

### Index schema (`schema.ts`)

| Table | Role |
|---|---|
| `contacts` | The card index: `id` (random app PK — REST identity + avatar-cache key), `uri`/`uriKey` (client-chosen resource name + its case/NFC-folded key, both unique), `uid` (vCard UID, unique per book, immutable), `firstName`/`lastName`, `eigenId` (server-owned self-link), `isGroup`, `data` JSON projection (**avatar URL only, never photo bytes**), `etag` (SHA-256 of the file bytes), `cardCtag` (book ctag at this card's last change — the sync-delta key, **NOT NULL**), `mtime` + `size` (the reconcile fast path) |
| `book` | One row: `ctag` (bumps on any card change), `syncGen` (rebuild generation), `ownerSeeded` (one-shot latch so a deleted owner contact never resurrects) |
| `contact_tombstones` | `{uri, uriKey, deletedAtCtag}` — the sync-collection 404 rows. Keyed by `uri` (PK), so a re-created card clears its own tombstone and no href is ever both a 200 and a 404 in one response |
| `labels` | Label *definitions*: `id`, `name`, `nameKey` (normalized, unique), `color` |
| `contacts_to_labels` | Junction, **derived** — rebuilt from each card's `CATEGORIES` on parse |
| `pending_card_writes` / `pending_label_renames` | The two durable recovery journals (below) |

## The Contacts class — write path

`apps/api/src/lib/contacts/contacts.ts` (`class Contacts`) keeps the REST method signatures
(`addContact`/`updateContact`/`deleteContact`/`getContacts`/`getContactById`/`getMe` + the label methods) and
adds the CardDAV store seam. Every mutation serializes through a one-slot `writeLock` (`Semaphore(1)`) — the
same job `MaildirStore.storeLock` does — so a file+index pair never straddles a reconcile or a racing write.

**Atomic, fail-closed writes.** Each card write goes temp file → `fsync` → rename via
`LocalFilesystem.writeAtomic` (the one place in the API that fsyncs — the maildir delivery precedent), then a
single SQLite transaction (`commitCard`) commits the index row, label junction, `cardCtag`, book `ctag` and
tombstone changes together. The exact sequence every mutation runs: `drainDirty()` → `enforceCardBudget` (the
quota gate, *before* any intent is recorded) → `recordCardWrite(uri)` → `writeCardFile` → (photo cache) →
`commitCard` inside `try/catch`, and on any failure `markCardDirty(uri)` + rethrow. `commitCard` is the single
index-write seam: ctag bump, junction rebuild (`syncCardLabels`), tombstone clear by `uriKey`, and the
pending-write clear, all in one transaction.

**Two failure windows, two guards.** If the index step throws *after* a successful rename, the uri is marked
in an in-memory `dirtyCards` set and the book **fails closed**: the next public call — mutation *or read* —
runs `ensureDrained()`/`drainDirty()` and re-indexes that card before observing the index, so no read is ever
served past a torn write. Process death takes `dirtyCards` with it, which is what `pending_card_writes` is
for: a uri recorded there before its file was renamed and cleared inside the commit that settled the pair; a
survivor means the pair never completed, so `recoverPendingWork` at init re-indexes it. This covers the one
case a stat-only reconcile cannot see — a replacement carrying the very same `mtime` and `size`.
`pending_label_renames` `{labelId, oldName, newName}` is the label-fan-out twin (see Labels below). Init
drains both before anything is served.

## Reconcile vs. rebuild

`init` brings the index in line with `cards/` before seeding: `reconcileIndex()` on a healthy book
(`indexIsIntact()` — the `book` row exists), or `rebuildIndex()` when the authoritative bookkeeping is gone.

- **`reconcileIndex` is stat-only** (the always-in-practice case, spec Performance invariant): one directory
  listing plus a `(mtime, size)` comparison against the index — zero file reads, zero parses. Only entries
  whose stat drifted get read, hashed and re-parsed; rows whose file vanished get tombstoned; the `ctag` bumps
  only if something actually changed. `cardParseCount` stays at `0` on a second init over an unchanged book
  (a pinned test).
- **`rebuildIndex` full-rehashes** every card — it runs when the book row is missing or on demand after manual
  disk surgery, and it catches the same-`stat` replacement (a selective `cp -p` restore) that the stat-only
  pass is blind to. It clears the index, re-derives every row, drops all tombstones, bumps `ctag`, and
  **rotates `syncGen`** (`syncGen + 1`) — a rebuilt book can't honour old sync tokens, so the rotation forces
  every client through the RFC 6578 recovery instead of silently telling them "nothing changed" while
  gap-deletions become ghosts.

There are **no fs-watchers**: unlike mail (Postfix delivers out of process), contacts have no out-of-process
writer, so every in-process mutation updates file + index together under the lock, and reconcile-on-open plus
the explicit `rebuildIndex` cover manual disk edits.

## CardDAV surface

`apps/api/src/lib/carddav/` mirrors `caldav/` file-for-file, mounted in `app.ts` next to `caldavRouter`. Every
route is `authenticateBasic` (app password → primary-password fallback, shared `protocol-auth.ts`) +
`requireSelf`.

```
PROPFIND /dav/addressbooks/:ownerId              addressbook home collection
PROPFIND /dav/addressbooks/:ownerId/*            home / the one book / a single card (Depth 0|1)
GET      /dav/addressbooks/:ownerId/contacts/:uri  stored bytes verbatim (text/vcard), quoted content-hash ETag
PUT      /dav/addressbooks/:ownerId/contacts/:uri  create/replace — transcode, preconditions, UID, quota
DELETE   /dav/addressbooks/:ownerId/contacts/:uri  404 unknown · 403 own card · 412 stale If-Match
REPORT   /dav/addressbooks/:ownerId/contacts/     addressbook-multiget · addressbook-query · sync-collection
MKCOL / MKADDRESSBOOK                             → 403 (one fixed book, spec Non-goals)
```

**One book, `contacts`.** The URL segment is `contacts`, the displayname "Contacts"; any other book name is a
404, and there is no `MKADDRESSBOOK`. The wildcard decodes to at most two segments (book + optional card
name); a third segment or a malformed percent-escape is a 400.

**Discovery** is edge + principal chain. `/.well-known/carddav` redirects to `/dav/` at the Caddy edge (the
CalDAV twin — no API route). From there: `PROPFIND /dav/` → `current-user-principal` →
`/dav/principals/:userId/` whose `principalProps` carry **both** `calendar-home-set` *and*
`CARD:addressbook-home-set` → `/dav/addressbooks/:userId/`. One principal serves both protocols; a client
reads only the props it knows. The book collection advertises: `CARD:addressbook` resourcetype, displayname
"Contacts", `getctag`, `sync-token`, `supported-address-data` (vCard 3.0), `max-resource-size` (5 MiB), and a
`supported-report-set` listing exactly the three REPORTs that exist. **OPTIONS + realm live in `app.ts`, not
the cloned dir**: one combined header for the whole `/dav` tree, `DAV: 1, 2, 3, calendar-access, addressbook`
(clients check for the `addressbook` token before trusting the account), and the 401 realm is the
protocol-neutral `Basic realm="Eigen DAV"`.

**vCard 3.0, with a 4.0→3.0 transcode at PUT.** The book is 3.0 on disk and on the wire (what iOS and DAVx⁵
speak, and every client accepts). Thunderbird 102+ PUTs `VERSION:4.0` regardless, and 4.0 bytes served
verbatim lose the photo on iOS, so `transcodeTo30` rewrites a 4.0 card before storage: `VERSION`, `PHOTO`
`data:`-URI → `ENCODING=b`, `tel:`-scheme `TEL` unwrapped, ISO-basic `BDAY` → extended form, numeric `PREF` →
`TYPE=PREF`; every construct with no 3.0 equivalent rides through verbatim. The response ETag hashes the
stored (3.0) bytes, so a 4.0 client re-converges on its next fetch. The **verbatim-bytes contract holds
exactly for 3.0 clients** and semantically for 4.0 ones.

**ETag = content hash.** The resource *is* the bytes, so the etag is the SHA-256 hex of the file — simpler and
more honest than the calendar's field-hash, and it lets reconcile detect out-of-band edits trivially.

**Preconditions inside the lock.** `If-Match`/`If-None-Match` are **not** checked handler-side (the CalDAV
code is race-free only because nothing awaits between check and write — a property an async file write loses).
`putCard`/`deleteCard` evaluate them *inside* the `writeLock`, against the state the write overwrites, so two
racing `If-Match` PUTs serialize and the loser gets a typed precondition result → 412. UID is required and
immutable: a PUT changing an existing resource's UID, or a UID already owned by another resource, → 412
`CARDDAV:no-uid-conflict` (never a raw constraint 500). Oversize → 413 `CARDDAV:max-resource-size`
(`CARD_MAX_BYTES` = 5 MiB). The client-chosen name becomes a filename, so `sanitizeCardUri` runs before any
store call: NFC-normalized, leading alphanumeric, then only `A-Za-z0-9._@-` (excludes `/`, `..`, leading dots,
control chars), ≤ 200 chars, must end `.vcf`; a case/NFC-colliding name can't alias one file. Anything else →
400.

### The three REPORTs

- **`addressbook-multiget`** — hrefs → etag + `CARD:address-data` per card. Hrefs are **percent-decoded**
  before matching and **percent-encoded** on every emission (the WebDAV convention the CalDAV template skips,
  safe there only because its uris are server-generated). Capped at 500 hrefs and **deduped per resource** so a
  repeated href can't amplify the response.
- **`addressbook-query`** — real **match-only** server-side filtering (RFC 6352 § 8.6: clients treat every
  returned card as a match). The engine (`query-filter.ts`) evaluates `prop-filter` / `param-filter` /
  `is-not-defined` / `text-match` (with negation and equals/contains/starts-with/ends-with) under `anyof` /
  `allof`, in-memory over every parsed card (group cards included — DAV sees the whole book). Exactly the two
  RFC-required collations are supported (`i;ascii-casemap`, `i;unicode-casemap`); an unsupported collation →
  403 `CARDDAV:supported-collation`, an unmappable filter → 403 `CARDDAV:supported-filter`, never a superset.
  Results honour the client `limit` then a server cap of 1000 (truncate + log, never unbounded assembly).
- **`sync-collection`** (RFC 6578) — generation-stamped tokens `urn:eigen:sync:<syncGen>-<ctag>`. The delta is
  `cardCtag > sinceCtag` as 200 rows plus tombstones as 404 rows. A token whose generation is **stale** (index
  rebuilt) **or whose ctag is ahead** of the current book → 412 `D:valid-sync-token`, forcing the full
  comparison that heals ghost deletions. (The ctag-ahead case is the live CalDAV bug this design must not
  inherit — the calendar answers a post-rebuild future token with an empty delta and a *lower* token,
  permanently stalling that client.)

**Partial `address-data`.** When a query or multiget asks for a property subset (RFC 6352 § 10.4.2), the row
serves the AST projected down to that subset plus the mandatory skeleton (`address-data.ts`); a full request,
or a card that won't parse, serves the whole bytes.

**Request bounds.** REPORT bodies are capped at 1 MiB (enforced in the router *before* the body reaches the
XML parser), multiget hrefs at 500, query results at 1000.

Reads touch `.vcf` files only where the payload *is* the card: `PROPFIND` Depth 1 is pure SQLite (uris, etags,
tombstones), and so is `sync-collection` — unless the client also requests `address-data`, in which case each
changed row streams its file bytes (as multiget does). GET / multiget / query always stream file bytes. Query
filtering runs over a small book on a rare request, never on an app hot path.

## Labels ↔ CATEGORIES

Membership truth lives **in the file** (`CATEGORIES:Friends,Work`) — otherwise the junction and the file are
two sources of one fact and every DAV rewrite risks drift. The `labels` table is the *definition* store (id,
name, **color** — color has no vCard home). Parse aggregates **every** `CATEGORIES` line of a card (external
clients legitimately split them) and rebuilds the junction, auto-creating an unknown label name via a
conflict-safe upsert keyed on the **normalized name** (`nameKey` = NFC + trim + lowercase, uniquely indexed)
with a deterministic color (FNV-1a hash of the key into `EIGEN_ACCENT_COLORS`). A DAV write that creates a
label emits `LABEL_CREATED` too (label and contact caches invalidate separately), and REST `addLabel` /
`updateLabel` enforce the same uniqueness (duplicate normalized name → 409).

**Rename fans out.** A label rename rewrites `CATEGORIES` in every member file (their etags change — correct,
clients must re-fetch). The fan-out is owed from the moment the row changes, so the intent is durable from that
same moment: `pending_label_renames` is written in the same transaction that renames the row and cleared only
once every member card is rewritten; a crash mid-fan-out leaves unreached files stat-clean (no reconcile can
find them), so the record is the only thing that can, and `updateLabel`/`deleteLabel`/`addLabel` each resume a
pending rename first. Label delete strips the category from member files; the junction rows cascade with the
label row.

## Photos

Inline `PHOTO` in the file is **canonical**; `avatars/` is a **derived cache**. Cache files are named
`<contactId>-<hash8>.webp` (`avatarCacheName` — first 8 chars of the embedded photo's hash), so a changed
photo yields a new filename and the sweep reclaims the superseded one. The index `data.avatar` projection
carries only that URL string — **base64 `PHOTO` bytes never enter the index, the list response, or an SSE
event** (the one place the design could silently multiply the list payload by ~1000×, so it's an invariant).

The app side keeps `uploadAvatar` as a pure staging endpoint (a file in, a webp URL out, before the contact
even exists) — but it now stages a **first-generation sibling pair** from the pristine upload: the 512px webp
Eigen serves (`<uuid>.webp`, alpha and animation preserved) and an Apple-safe embed (`<uuid>.embed.<ext>` —
JPEG q80 for opaque stills, PNG for alpha, animated GIF for animated sources with a 2 MiB fallback to
first-frame JPEG, since Apple Contacts decodes only JPEG/BMP/PNG/GIF, never webp). Save embeds the staged
embed bytes **verbatim** into `PHOTO` and promotes the sibling webp into the cache under
`avatarCacheName(contactId, embedBytes)` — the exact name a reindex derives from the card, so a reconcile
that finds it present keeps the promoted copy (never re-derives over it), while any change to the embedded
bytes yields a new name and the missing-cache paths regenerate from the embed (one generation older —
accepted; it's what an external DAV PUT gets anyway). A DAV PUT carrying an inline photo is decoded and
thumbnailed into the same hash-named webp cache (`cacheCardPhoto`, animation and alpha carried through);
`prepareCardRow` regenerates a missing cache from the file's inline photo on reconcile/rebuild. Remote
`PHOTO;VALUE=uri` images are kept verbatim in the file and **never fetched server-side** (SSRF, spec
Non-goals). Staged orphans — both siblings — are swept by `cleanupAvatarImages`.

## Quotas

Two ceilings guard the PUT path. `CARD_MAX_BYTES` (5 MiB) is the whole-vCard safety ceiling — checked on the
raw body before any parse and re-checked on the stored bytes (413 / `max-resource-size`). Beyond it, contacts
share the **mail + contacts** storage budget: `enforceCardBudget` runs `enforceContactsIngest`, crediting the
size of the card being replaced, and a projection over budget → 507. `Contacts.size()` answers from in-memory
byte counters (`cardsBytes + avatarsBytes`), so contact growth is always exact. The mail half of the budget is
an O(N) recursive maildir walk, so it is **memoized per user for 15 s** (`mailSizeCache`,
`config/enforcement.ts`): an initial device sync that PUTs hundreds of cards pays at most one walk, and the
contacts half stays live. REST avatar upload shares the one cache (accepted drift — only recently-delivered
mail can read stale, bounded by the same window).

## Client setup

Same credential story as CalDAV/IMAP: HTTP Basic auth, app password (primary-password fallback fails under
2FA). Point clients at `https://<domain>/` (or `/.well-known/carddav` discovery) with the Eigen email as
username. The device-setup how-to is the help-center article
[connect/contacts-client](../apps/index/src/data/support/connect/contacts-client.md) (Apple Contacts on
macOS/iOS, DAVx⁵ on Android). The **Integrations** page (`apps/space/src/routes/_auth.services.tsx`) surfaces a
CardDAV address card next to CalDAV/IMAP/WebDAV, carrying the address-book URL.

## Caveats & decisions

- **Apple group cards.** Apple Contacts creates groups as separate `X-ADDRESSBOOKSERVER-KIND:group` cards.
  v1 stores them **verbatim** (fidelity) but hides them from the app's contact list (`isGroup`). Known
  cosmetic consequence: an Apple-created group card renders as a **blank contact** in DAVx⁵'s default
  per-contact `CATEGORIES` mode and in Thunderbird (Mozilla bug 1807394). Mapping group cards to labels is
  deferred.
- **The deploy resets every contact book** to the seeded state (yourself + org owner) — decided, not
  accidental. The v2 migration drops v1 data; eigen.is books are seed-scale, and anyone with manual entries
  re-adds them or syncs them back from a phone once CardDAV is live. Say so in the release note.
- **SSE under bulk sync.** An initial device sync PUTs hundreds of cards, each broadcasting a contact event and
  a full-list refetch. Accepted for v1 at contact-book scale (TanStack coalesces refetches). The **named
  fallback**, if real-device testing shows churn, is a trailing-edge debounce (~1 s) of contact SSE during DAV
  write bursts — not implemented.
- **Self-link.** The `eigenId` ↔ user link rides as `X-EIGEN-ID`. It is server-owned in the index (accepted
  only when it equals the account owner's id; at most one row per book), and a rematch on the account owner's
  own email restores it when a client strips the property. Only a client edit that strips the property *and*
  changes the email in one go loses the link until the user re-saves their profile.

## Where the code lives

- **`apps/api/src/lib/contacts/`** — the domain: `contacts.ts` (the `Contacts` class), `card-store.ts` (the
  file/key helpers — `sanitizeCardUri`, `writeCardFile`, `avatarCacheName`, `uriKeyOf`), `schema.ts`,
  `db-config.ts`, `sse-events.ts`.
- **`apps/api/src/lib/carddav/`** — the protocol layer: `carddav-router.ts`, `discovery.ts`, `resource.ts`,
  `report.ts`, `query-filter.ts`, `address-data.ts`, the vCard modules (`vcard-ast.ts`, `vcard-parse.ts`,
  `vcard-serialize.ts`, `vcard-transcode.ts`), and `xml-builder.ts`/`xml-parser.ts`. The shared XML envelope,
  principal props, OPTIONS header and realm live in `caldav/xml-builder.ts` + `app.ts`.
- **`apps/api/src/routes/contacts.ts`** — thin REST bindings (unchanged by the refit beyond conditional-write
  etags).
- **`packages/lib/src/core/contacts/`** — FE hooks + SSE handlers; shared types in
  `packages/lib/src/types/contact.ts`.

Storage layout: [STORAGE.md](STORAGE.md). Database inventory: [DATABASE.md](DATABASE.md). Full design history
and the folded review passes: [PROPOSAL_CARDDAV.md](PROPOSAL_CARDDAV.md).
