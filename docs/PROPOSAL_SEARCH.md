# Search Index

> **Status — v1 (mail + drive name search) shipped on `main`.** Search is implemented as
> inline FTS5 directly inside each canonical scope DB — no separate `search.db`, no
> `SearchIndex` abstraction. Mail: `apps/api/src/lib/mail/maildb.ts` (`MailDB.searchMail`)
> + `apps/api/src/lib/mail/db-config.ts` v3 (the `emails_fts` virtual table + 3 sync
> triggers + initial populate). Drive: `apps/api/src/lib/mount/mount.ts`
> (`Mount.searchPaths` + the `docContainerDescendantIds` recursive-CTE exclusion fragment)
> + `apps/api/src/lib/mount/db-config.ts` v2 (the `paths_fts` virtual table + 3 sync
> triggers + initial populate) + `apps/api/src/lib/drive/drive.ts` (`Drive.search` mount
> fan-out). Shared: `apps/api/src/lib/core/fts.ts` (`sanitizeFtsQuery`) +
> `apps/api/src/routes/search.ts` (`GET /search/:ownerId`) +
> `packages/lib/src/core/search/` (FE hook + keys + invalidate) +
> `packages/lib/src/types/search.ts` (`SearchSource` union shared with the BE).
>
> **Shipped — mail:**
> - External-content FTS5 (`content='emails'`, `content_rowid='rowid'`) over the seven
>   indexable email columns (`subject`, `fromShort`, `fromAddress`, `toShort`,
>   `toAddress`, `recipientsAll`, `textShort`); three AFTER INSERT/DELETE/UPDATE triggers
>   keep the index in sync atomically with mail writes.
> - `MailDB.searchMail`: two-pass FTS5 JOIN+hydrate (raw `sql` JOIN returns ranked ids,
>   Drizzle re-fetches the rows so `mode: 'timestamp'` columns come back as `Date`).
>   Filter-first narrowing on `from` / `to` via mail.db's own indexed columns, default
>   mailbox exclusion (`Trash`, `Junk`), `bm25() + date DESC` ordering, and
>   `sanitizeFtsQuery` prefix-wildcard tokenisation.
>
> **Shipped — drive:**
> - `paths_fts` virtual table in `mounts/*/metadata.db` v2 over `name`; three triggers
>   keep it in sync, with the UPDATE trigger **gated on `WHEN old.name IS NOT new.name`**
>   so the common writes (size / hash / thumbnail / trashedAt / acl / details) don't
>   churn the FTS shadow tables. Mail's UPDATE trigger fires unconditionally because
>   drafts mutate multiple indexed columns; drive indexes only `name`, so the gate is
>   safe.
> - `Mount.searchPaths`: same two-pass JOIN+hydrate shape as `MailDB.searchMail`.
>   Excludes trashed rows, the root folder (no useful result), and — via the shared
>   `docContainerDescendantIds` recursive-CTE fragment — every path descended from a
>   doc / stickies / slides / sheets / chat container. The same CTE fragment is reused
>   by `Mount.getPathsByMimeType` for UI consistency: container internals (`data.db`,
>   embedded media, embedded chats) are never shown in the drive UI and now never appear
>   in search.
> - `Drive.search` fans out across the home's mounts, sorts the merged set by
>   `updatedAt DESC` (cross-mount tiebreak; `bm25()` is not comparable across different
>   mount indexes), then slices to the requested limit.
> - `sanitizeFtsQuery` lifted into `apps/api/src/lib/core/fts.ts` now that two domains
>   share it.
>
> **Shipped — endpoint + FE:**
> - `GET /search/:ownerId?q&sources&mailbox&from&to&limit` returns
>   `SearchResponse { mail: EmailSummary[]; file: DrivePath[] }`. `sources` is narrowed
>   against the shared `SearchSource` union (`'mail' | 'file'`) so backend and frontend
>   never drift.
> - `useSearch` hook with `searchKeys` query keys (includes `ownerId`), 30s `staleTime`,
>   `enabled` guard, AbortSignal threaded through Eden Treaty.
> - SSE: `invalidateSearchOwner` wired into every mail mutation event AND every drive
>   event that touches the indexed name (`DRIVE_FOLDER_CREATED`, `DRIVE_FILE_CREATED`,
>   `DRIVE_FILE_UPLOADED`, `DRIVE_FOLDER_DELETED`, `DRIVE_FILE_DELETED`,
>   `DRIVE_PATH_RENAMED`, `DRIVE_PATH_TRASHED`, `DRIVE_PATH_RESTORED`).
>   `DRIVE_PATH_MOVED` is deliberately excluded — moves don't change `name`.
> - Test coverage: 26 mail-side tests (Windows-skipped due to maildir watcher races) +
>   12 drive-side tests covering the FTS5 schema, name find, rename re-index, trash
>   removal, root exclusion, eigendoc-internals exclusion, and the endpoint surface.
>
> **Shipped — drive content index (Phase 2 — metadata.db v6):**
> - A `path_content(pathId, body)` table with a sibling external-content `paths_content_fts`
>   FTS5 over it, in each mount's `metadata.db` (v6) — separate from `paths_fts` so large body
>   text never churns the name index. An `AFTER DELETE ON paths` trigger drops the content row
>   with its path.
> - Six body types: **doc / slides / sheets / stickies / chat** (via the shared `lib/document/`
>   loaders + new `readStickiesContent` / `readChatContent`) and **plaintext / code files** (raw
>   capped read, gated by `isSearchableTextFile`). Per-file cap ~100 KB (`CONTENT_INDEX_MAX_BYTES`);
>   chat indexes the **newest** ~100 KB of messages.
> - Durable + regenerable: a body write sets `contentDirty=1` (plaintext at the file-write seam;
>   containers via the storage-agnostic `onSync`; copies + the v6 backfill mark explicitly). The bit
>   on `paths` IS the queue — no separate table, no staged copy (a reindex re-reads live state, and
>   the bit coalesces edits). Each mount's `ContentReindexQueue` (read-side mirror of the S3
>   `UploadQueue`) drains it off the request path: kick-on-mark + a cap self-timer, no global poller,
>   replays on mount open. Drain = `extractText` → upsert `path_content` → clear the bit + stamp
>   `contentIndexedAt` (2-min per-container re-extract cap). Extraction never throws to the loop.
> - `Mount.searchPaths` queries BOTH FTS tables and ranks **name hits above body-only hits**,
>   reusing the same `docContainerDescendantIds` exclusion so container internals never surface.
>   No SSE: search is a live per-query fetch (`useSearch`, 30 s `staleTime`) and the index is
>   eventually consistent within the cap, so a push-invalidation buys nothing.
> - **Shipped — comment-thread FTS:** each container's `comments.db` gained v3 `recentText` +
>   `comments_fts` (the per-card comment index behind `GET /collab/:o/:m/:p/comments/search`),
>   owned by [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md).
> - **Out of scope (comments-next follow-up):** the drive-wide comment **fold** (folding a
>   container's `recentText` into `path_content.body` so a board is findable drive-wide by its
>   card comments), per-room `messages_fts` (full chat history / in-document search), calendar,
>   shared-with-me, vector.
>
> **Index location: Option C — inline FTS in the canonical per-scope DB.** Mail's FTS
> lives inside `mail.db`; drive's lives inside each mount's `metadata.db`; calendar will
> do the same on `calendar.db` when it ships. Cross-domain query fan-out is the route's
> job; same-kind ranking is native `bm25()` within each scope; cross-mount (within-kind)
> tiebreak is recency.
>
> **Deferred (post-v1):** calendar event indexing; shared-with-me search; vector / semantic
> search; the drive-wide comment **fold** (folding a container's `recentText` into
> `path_content.body`) + per-room `messages_fts` (in-document search). Each later phase
> replicates the inline-FTS pattern in its domain DB — additive write-path + route source per
> kind, no palette change required. (Document body indexing — **Phase 2** — is now **shipped**;
> see the drive content index block above.)
>
> **In-document search is a separate surface** — searching *within* the open document (jump to a
> sticky / cell / heading / message) and the command palette's "current document" scope are
> specified in [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md). This document owns
> the drive-*wide* content index that makes a document findable by its body; that one owns
> finding a location *inside* the doc you already have open. They share the per-type text
> extractors but use different indexes and different UIs.
>
> **Documented divergence from the original proposal:** Drafts are indexed at `textShort`
> granularity (the 200-char preview), matching received mail. If full-body draft search
> becomes important, add a `bodyFull` column to `emails` (NULL for non-drafts) and
> include it in the FTS column list — pure addition.
>
> **Known shortcomings:** `from:` / `to:` operators accept any token — no email-shape
> validation, so a typo silently misses rather than warns. Drive search has no
> filter operators (e.g. `type:doc`, `in:folder`) — name-only ranked search.

> **TLDR**: The **backend search infrastructure** consumed by the
> [command palette](PROPOSAL_COMMAND_PALETTE.md). SQLite FTS5 full-text search — **inline FTS5
> virtual table inside each canonical scope DB** (mail.db for mail, metadata.db for drive,
> etc.). Each domain indexes its text on write via triggers; the search endpoint returns results
> **grouped by kind** — the palette renders one section per group. Each kind is ranked within
> itself by `bm25()`; cross-kind ordering is structural, not a fused score. Future: optional
> hybrid keyword + vector search. **No UI here — the palette is the only consumer.**

## Problem statement

The [command palette](PROPOSAL_COMMAND_PALETTE.md) needs fast, ranked full-text search across
Mail, Drive, Docs, Chat, Stickies, Slides, Sheets, and Calendar. Today there is none: each
domain stores its text in its own SQLite database, and the content of collaborative documents is
binary Yjs state that can't be searched without server-side text extraction.

Requirements:

- Cover data the user owns **and** data shared with them
- Self-hosted — no external search services
- **Ranked results, grouped by kind** — the palette renders a section per kind (files, mail,
  events, chats), each ranked on its own; only the single promoted "Top Hit" compares across kinds

## What's searchable

| Domain   | What's indexed                          | Source already text?                  |
|----------|-----------------------------------------|---------------------------------------|
| Mail     | Subject, sender, recipients (To and CC), short body preview | Yes — in the mail database     |
| Drive    | File and folder names                   | Yes — in mount metadata               |
| Drive (file bodies) | Body of plain-text / code files (`.txt`, `.md`, `.json`, source) | Yes — raw bytes, capped read (Phase 2) |
| Calendar | Event title, description, location      | Yes — in the calendar database        |
| Chat     | Message content, author                 | Yes — in the per-room database        |
| Docs     | Document body text                      | No — extract from Yjs state           |
| Stickies | Card titles and descriptions            | No — extract from Yjs state (small loader) |
| Slides   | Slide text                              | No — extract from Yjs state           |
| Sheets   | Cell text values                        | No — extract from Yjs state           |

The first four are already plain text in SQLite. The collaborative types store content as binary
Yjs state and need text extraction — see [Content extraction](#content-extraction-from-collaborative-documents).
Stickies needs only a small dedicated content loader (it does *not* have to wait for full stickies
export). Chat is the outlier: its content is already plain text in a relational `messages` table,
not Yjs — its body is folded into the same content index as the latest ~100 KB of messages
(see [Phase 2](#phase-2--body-content-indexing-worked-design)).

> **Two search surfaces, one set of extractors.** This document indexes document *bodies* into a
> drive-wide content index so a file is **findable** by what it contains. Finding *where inside the
> open document* a term appears — and the command palette's "current document" scope that fronts it
> — is a different feature, specified in
> [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md). The two reuse the same per-type
> text extraction but write to different indexes (drive `metadata.db` vs. the per-document DB) and
> render in different UIs.

Contacts are deliberately **not** indexed — they are few and already fully cached on the
frontend, so the command palette filters them client-side (see [Response shape](#response-shape)).

## Approach: SQLite FTS5

FTS5 is SQLite's built-in full-text search module. It's the right fit:

- Already using SQLite everywhere — zero new dependencies; FTS5 is compiled into Bun's SQLite
- Fast — sub-millisecond queries on the data volumes a self-hosted deployment sees
- Built-in relevance ranking (`bm25()`), snippet extraction, and prefix queries
- Per-file databases match Eigen's existing data-isolation model

## Search index location

**Option C — inline FTS in the canonical per-scope DB.** Each domain's primary SQLite file
owns its own FTS5 virtual table. Mail's `emails_fts` lives inside `mail.db`; drive's
`paths_fts` lives inside each mount's `metadata.db` (file/folder names, with extracted Yjs
content joining later — see Phase 2); calendar's will live inside `calendar.db`. There is
no separate `search.db` file.

This is the SQLite-native FTS5 pattern: external content (`content='<source-table>'`,
`content_rowid='rowid'`) with three triggers maintaining the index synchronously, in the same
transaction as the canonical write. The route fans out across enabled scopes and merges
same-kind results; `bm25()` stays comparable within each scope (the unit it ranks against).

**Why not one index per Home (Option A):** the storage unit would no longer match the access
unit, kind discrimination would need a column in a multi-kind table, and the Home-level index
would be the single point of failure for all of search.

**Why not one separate `search.db` per scope (Option B):** the abstraction adds a service
layer with no callers beyond a single domain each, the canonical DB and the index can drift, and lifecycle bookkeeping doubles. The original proposal leaned B; the
mail v1 implementation initially shipped B before being collapsed to C.

**Lifecycle:** the FTS table is part of the canonical DB's schema and versioning. Adding it is
a normal `ManagedDatabase` migration step (one CREATE per FTS table + one CREATE per trigger
+ one INSERT to populate from existing rows). Deleting a scope (a mount, the mail directory)
takes its index with it; there is no cleanup to remember.

**Cross-scope queries:** the search route's coordinator calls each enabled scope's
`searchX(opts)` method in parallel and assembles the grouped response — `{ mail, file }` today,
gaining `events` / `chats` groups when calendar and chat indexing ship (Phases 3–4). Same-kind
results from multiple mounts (files, chats) are combined by rank position; mail and calendar
are single-scope and rank natively.

The original Options A and B are documented below for the record — both were considered and
both abandoned in favour of Option C.

### Option A — one index per Home (rejected)

A single `search.db` per Home — one per user, one per team — holding every domain's content in
one FTS table, discriminated by a `kind` column.

**For:**

- The storage unit matches the access unit. Search is always Home-wide, and so is the index —
  no cross-scope merge, and per-kind result groups come from one table. (One table does *not*,
  however, buy a meaningful cross-kind ranking — see
  [Ranking and cross-kind merging](#ranking-and-cross-kind-merging).)
- One schema, one file, one migration history, one rebuild — one thing to reason about and back up.
- One open database handle per Home.

**Against:**

- A mount's lifecycle doesn't map onto storage. Disabled mounts must be filtered out on every
  query; deleting a mount needs an explicit "remove all rows for this mount" cleanup; nothing
  structurally prevents orphaned rows.
- The index is a Home-level service, but collaborative content is indexed from snapshot-creation
  code that only holds the mount — the index reference must be threaded down to it.
- A corrupt index disables all search for that Home until it is rebuilt.
- Every domain writes one file — mild write contention (WAL makes this minor).

### Option B — one separate `search.db` per scope (rejected)

One `search.db` per Drive mount (`mounts/{mountId}/search.db`), one for mail, one for calendar.
All share a single `DatabaseConfig` — one schema and one migration definition, instantiated per
scope, exactly as Eigen already does for mount `metadata.db` (one `MOUNT_DB_CONFIG`, many
mounts, each self-versioning on open). Many database *files*, but one schema.

**For:**

- Mounts are project-scoped lifecycle units (enable, disable, archive, read-only). Per-mount
  storage maps onto that: a disabled mount's index is simply not queried; an archived mount's
  index is naturally frozen; a deleted mount takes its index with it — no cleanup, no orphans.
- Collaborative content is indexed locally — the snapshot code already holds the mount, so its
  index is reachable without threading a Home service down.
- Blast radius and rebuild are per scope; a mail-only or calendar-only index is trivial to
  reason about.

**Against:**

- Search is Home-wide, so every query fans out across all enabled scopes, and same-kind
  results from different mounts must then be combined per query — `bm25()` is comparable only
  within one index, so the combine cannot just sort on score. Real recurring per-query work.
- More open file handles per Home; a Home-level coordinator is needed to gather and merge.
- A service abstraction with no callers beyond a single domain each adds lifecycle bookkeeping
  with no structural payoff; the canonical DB and its separate index can drift.

## Index structure

Each domain's canonical DB gains an FTS5 virtual table over the columns it wants searchable.
For mail (the v1 implementation):

```sql
CREATE VIRTUAL TABLE emails_fts USING fts5(
    subject, fromShort, fromAddress, toShort, toAddress, recipientsAll, textShort,
    content='emails',
    content_rowid='rowid',
    tokenize='porter unicode61'
);
```

Three triggers (`AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE`) keep the index in sync. The
search method (`MailDB.searchMail`, `Mount.searchPaths`, etc.) is a two-pass query —
first the FTS5 JOIN returns ranked ids, then Drizzle hydrates the rows so `mode: 'timestamp'`
column conversion runs:

```sql
-- Pass 1: id-only, FTS-ranked
SELECT e.id FROM emails_fts
JOIN emails e ON e.rowid = emails_fts.rowid
WHERE emails_fts MATCH ?
ORDER BY bm25(emails_fts), e.date DESC LIMIT ?
```

Then in TS: `db.select().from(emails).where(inArray(id, rankedIds))` rebuilds the rows in
rank order via an id-keyed Map.

Query sanitisation (FTS5 grammar protection) is shared: `sanitizeFtsQuery` lives in
`apps/api/src/lib/core/fts.ts` and is used by both `MailDB.searchMail` and
`Mount.searchPaths`.

## Indexing strategy

**Index on write.** Each domain hooks into its existing mutation flow and writes to the index
after its own database write. The index stays current without a separate sync job.

| Write                                            | Indexed into                       |
|--------------------------------------------------|------------------------------------|
| An email is added or deleted                     | the mail index                     |
| An event is created or updated                   | the calendar index                 |
| A file or folder is created, renamed, or deleted | the (mount's) index                |
| A chat message is posted or edited               | the (host mount's) index           |
| A doc / slides / sheets snapshot                 | the (host mount's) index           |

Each domain populates the index with the FTS text plus any structured filter columns for its
kind (mail: from/to/mailbox; calendar: calendar id; files: TBD). With inline FTS5 + triggers
(Option C), writes to the canonical table automatically keep the index in sync — no separate
index write in the mutation flow is needed. Display data for a hit comes from the canonical
store at query time, not from the index — the index stays small and the response uses the
**canonical domain type** for each kind (e.g. an `EmailSummary` for a mail hit), exactly what
the mail listing endpoint returns.

For mail the v3 migration's closing `INSERT INTO emails_fts SELECT ... FROM emails` serves as
the **one-time backfill** for pre-existing rows. New domains follow the same pattern — the
migration step populates the FTS table from existing canonical rows on upgrade.

## Content extraction from collaborative documents

Docs, slides, and sheets store their content as binary Yjs state, not plain text. Rather than
write a second Yjs decoder, extraction **reuses the shared content loaders** in
`apps/api/src/lib/document/` — the modules that already turn each file type's Yjs state into a
structured form for preview and export, so search's notion of "document text" can't drift from
theirs. `apps/api/src/lib/search/extract-text.ts` (`extractText`) dispatches per type over a thin
text collector (ProseMirror JSON → text, `DeckData` → text, `Sheet[]` → cell text), capped at
`CONTENT_INDEX_MAX_BYTES` (~100 KB). It skips the full HTML export, which embeds fonts and base64
images, flattens CSS, and sanitises — wasted work for an index that only wants words.

**Stickies** and **chat** need no export pipeline: `readStickiesContent`
(`lib/document/stickies.ts`) walks each card's `title` / `description`, and `readChatContent`
(`lib/document/chat.ts`) reads the latest ~100 KB of the relational `messages` table — both slot
into the same `extractText` dispatch.

> **Refined 2026-06-08 — see [Phase 2 — body-content indexing](#phase-2--body-content-indexing-worked-design) below.**
> Reading the current code corrected two things in the sketch above (the `export/*/content.ts`
> loaders it names don't exist — the real shared loaders are in `lib/document/`; and extraction
> should hook the storage-agnostic `onSync` seam, not snapshot-creation alone) and extended
> Phase 2 to index plain text / code file bodies.

## Phase 2 — body-content indexing (worked design)

> Worked out 2026-06-08 from reading the current code. Refines [Content extraction](#content-extraction-from-collaborative-documents)
> above and **corrects two things in it**: the `export/{doc,slides,sheets}/content.ts` loaders it
> names **do not exist** — the real shared loaders live in `apps/api/src/lib/document/`; and
> extraction should hook the **storage-agnostic `onSync`** seam, not snapshot-creation alone (and
> explicitly **not** the S3-only upload queue). It also **extends** Phase 2 beyond Yjs documents to
> index the **body of plain text / code files**, which Phase 1b indexes by name only. No
> backward-compat constraint — the content index is regenerable, so it is populated on write and
> backfilled once.

**What gets indexed**

| Kind | Body source | Notes |
|------|-------------|-------|
| Docs (`.eigendoc`) | full ProseMirror text, all blocks | *not* capped at the preview's first-20-blocks |
| Slides (`.eigenslides`) | text of all slide objects, all slides | *not* capped at the preview's first-8-slides |
| Sheets (`.eigensheets`) | display values of all non-empty cells | sparse-`celldata` walk — see grid cliff below |
| Stickies (`.eigenstickies`) | card `title` + `description` for every card, plus column titles | new small `readStickiesContent` loader — does *not* need full stickies export |
| Chat (`.eigenchat`) | the **latest ~100 KB** of message text (+ author), newest-first | relational `messages` table, not Yjs — `readChatContent` query; see [chat](#chat-extraction-latest-100-kb) below |
| Text / code files | raw file body | eligibility via the canonical `getTextPreviewMode` (`packages/lib/src/constants/preview.ts`); capped read |

Deferred: uploaded **binary** docs (PDF / Office — need real text extractors) and semantic / vector
(Phase 6). Stickies and chat are **now in Phase 2 scope** (above): stickies needs only a small
dedicated loader, and chat is already relational text, so neither has to wait. The separate
*in-document* chat message FTS (full history, for searching within an open chat) is owned by
[IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md), not this index.

**Extraction — reuse the loaders, not the preview renderers, not the export.** The reusable kernel
is the shared content loaders `readEigendocContent()` / `readSheetsContent()` / `readSlidesContent()`
(`apps/api/src/lib/document/{doc,sheets,slides}.ts`), all built on `loadYjsState` and already shared
by export and preview — so search's notion of "document text" can't drift from theirs. A new thin
`extractText(mount, path)` sits on top:

- **doc** — ProseMirror JSON → plain text (all blocks)
- **slides** — concatenate every slide's text objects
- **sheets** — iterate the **sparse `celldata`** and concatenate display values; skip formulas, use the stored `.v`
- **stickies** — new `readStickiesContent(mount, path)`: load the Yjs state, walk `getMap('tasks')` for each card's `title` + `description` and `getMap('columns')` for column titles. Plain string fields — no `instanceof` needed, same duck-typing the `slides.ts` loader already uses
- **chat** — new `readChatContent(mount, path)`: open the container's `data.db` (`CHAT_ROOM_DB_CONFIG`), query `messages` newest-first (`ORDER BY createdAt DESC` with `deletedAt IS NULL`), accumulate `content` (+ `authorEmail`) until the cap. Relational, not Yjs — but it slots into the same `extractText` dispatch and the same sweep pipeline as the Yjs types. See [chat extraction](#chat-extraction-latest-100-kb)
- **text / code files** — `mount.readFile(pathId)` then `.text()`, **capped** via `readRange` (there is *no* size guard today — must not slurp a 500 MB file)

Two traps this avoids, both confirmed in the code:

- The **preview generators** (`apps/api/src/lib/preview/*`) are the wrong tool: they cap hard (first
  20 blocks / 8 slides / 1 sheet) and emit display **HTML**. Reuse the loaders *under* them, not the
  generators.
- The **full export** is the wrong tool: it base64-embeds media, shells out to WeasyPrint, and for
  sheets can call `celldataToData()` which **materializes a dense grid** — a sparse-but-large sheet
  (one cell at row 1 000 000) blows up memory. The extractor must never densify; iterate `celldata`.

**Per-file cap.** Extract at most ~100 KB of text per file (≈16k tokens). Far larger than the preview
caps (so content on slide 9 / row 200 is findable), but bounded so the FTS shadow tables and
extraction cost stay predictable. For the bounded types (doc / slides / sheets / stickies) the cap is
a simple stop-after-100 KB walk; for chat the cap selects *which* messages (newest first) — see below.

#### Chat extraction (latest 100 KB)

Chat is the one body source that grows without bound and is **append-heavy** — a busy room
accumulates messages forever, and the most recent ones are the most relevant for "find the chat that
mentioned X". So `readChatContent` extracts the **latest ~100 KB**, not the first:

- Open the container's `data.db` with `CHAT_ROOM_DB_CONFIG` (the same handle preview/export would
  use — chat's `data.db` is a relational `ManagedDatabase`, **not** a Yjs doc).
- `SELECT content, authorEmail FROM messages WHERE deletedAt IS NULL ORDER BY createdAt DESC` and
  accumulate text until the ~100 KB cap, then stop. This reads the tail cheaply via the existing
  `createdAt` index — no full-table scan, no densification.
- Concatenate newest→oldest; order inside the FTS document doesn't affect `bm25()` matching.

This is deliberately the **drive-wide** view of a chat — enough to surface the file in global search
by its recent content. Searching the *full* history of an open chat (every message, however old) is
the job of the per-room `messages_fts` in [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md);
the two indexes are complementary, and once that per-room FTS exists the drive-wide collector may
read its tail instead of re-querying `messages`.

**Storage — a separate content FTS table, not a column on `paths`.** Keep `paths_fts` (name,
trigger-maintained, instant) exactly as Phase 1b shipped it. Add a **separate `paths_content_fts`** in
the mount `metadata.db`, keyed by path id and populated by the reindex worker — deliberately **not**
an extra column on `paths` and **not** external-content over `paths`: the `paths` row is hot (every
folder listing SELECTs it), and large body blobs there would bloat those reads. A dedicated table
keeps big text off the hot path. `Mount.searchPaths` queries both tables, merges ids, and ranks a
name match above a body-only match (`bm25()` within each; the name boost is structural). A little
per-path bookkeeping (`contentIndexedAt` + the source `updatedAt` or a content hash) lets the worker
skip unchanged files and detect staleness.

**Trigger — the storage-agnostic `onSync`, not the S3 queue.** Verified `onSync` semantics: it is
called by `ManagedDatabase.sync()` **only when dirty** (`total_changes() !== lastSyncedChanges`), from
(1) the 30s auto-sync timer while the container is open, (2) `flush()` (e.g. just after create), and
(3) `close()`. It fires for **all three storage types** (`local`, `local-key`, `s3`) — only the
callback *body* differs (`mount.ts:1230` vs `1250`). The **upload queue is S3-only** (`isRemote`,
`mount.ts:174`), so hooking *it* would silently skip both local backends; `onSync` is the universal
seam.

- **Containers** (doc / sheet / slide / **stickies / chat**): mark-for-reindex inside the `onSync`
  callback. Chat's `data.db` is a relational `ManagedDatabase` (`CHAT_ROOM_DB_CONFIG`), so it drives
  `onSync` exactly like a Yjs container — the seam is storage-agnostic, not Yjs-specific, so a new
  chat message re-marks the chat file for re-extraction with no chat-specific plumbing.
- **Plain files**: no `onSync` (they are not `ManagedDatabase`s) — mark in the file write-path
  (`Mount.createFile` / `createFileFromTemp` / `updatePath`).
- `onSync` re-fires ~every 30s during active editing, so the mark is a cheap idempotent dirty-bit and
  the **worker rate-limits** re-extraction of the same container (skip if recently indexed; prefer
  when idle) — otherwise a 2-hour session re-extracts a big sheet hundreds of times.
- Extraction is cheapest while the container is still open (the local temp is present). A **closed S3
  container** must be re-downloaded via `openDatabase` to read it (the same cost preview / export
  already pay), so the worker should drain promptly rather than let closed-S3 docs backlog.

**Durability — dirty-flag + per-mount self-scheduled drain (as built).** On a durable write, set
`contentDirty = 1` (cheap, same `metadata.db`). The bit IS the queue. Each mount owns a
`ContentReindexQueue` (`apps/api/src/lib/mount/content-reindex-queue.ts`) — the read-side mirror of the
S3 `UploadQueue` — that drains dirty rows off the request path: load → `extractText` (capped) → upsert
`path_content` → clear the bit + stamp `contentIndexedAt`. It is kicked when a bit is set, self-times
the next pass to when the earliest capped row comes due, and replays on mount open. Crash-safe via the
persisted bit, self-healing, and backfill is simply "mark all dirty" once. Notes on the shape:

- **No global `scheduleInterval` poll** — the original recommendation; rejected because it turned
  per-mount work into a server-wide loop that woke every tick with nothing to do.
- **Fire-and-forget at the seam** — rejected: no replay; one failed extraction leaves a file unindexed
  until it happens to be edited again.
- **Not the *full* `UploadQueue`** (backoff / reconcile of staged copies / per-destination semaphore) —
  unlike an upload, whose staged bytes are the *only* copy until the PUT acks, a search index is
  **regenerable**, so the queue stays minimal: no staged copy, no attempt/backoff columns, a failed
  extract is logged and the row marked done (it re-indexes on the next edit).

**Lifecycle.** Delete clears the content row — an `AFTER DELETE` trigger on `paths` keeps it atomic
(the content table is keyed by path id). Trash and move need nothing: search already excludes
`trashedAt IS NOT NULL`, and a move changes neither name nor body (mirrors the existing
`DRIVE_PATH_MOVED` SSE exclusion). No reindex SSE: search is a live per-query fetch (`useSearch`,
30 s `staleTime`) over an index that is eventually consistent within the cap, so push-invalidation of
freshly-indexed content buys nothing.

**Comments — making a board/doc findable by its card comments (designed here; built in the
comments-next step).** Per-card comment threads are embedded `.eigenchat` containers
(`<parent>/chat/<card>.eigenchat/data.db`), kept out of the drive UI and `paths_fts` by the
`docContainerDescendantIds` CTE — so a board is not currently findable by what its comments say. Rather
than fan out across every thread DB at extract time, reuse the parent's existing `comments.db`
(`CommentIndex`, one per container, already open and written on every comment post):

- **`COMMENT_INDEX_DB_CONFIG` v3** gives each `comments` row (one per thread, keyed by `chatName`) a
  `recentText` column holding the **latest ~8 KB** of that thread's messages (append-and-trim,
  newest-first) plus a `comments_fts` external-content FTS5 over it (3 triggers; the UPDATE gated on
  `WHEN old.recentText IS NOT new.recentText` so the frequent metadata writes — `status`,
  `lastActivityAt` — don't churn the shadow). Additive and **regenerable** (a one-time backfill replays
  each thread's tail), so it respects the frozen-format rule exactly as `paths_content_fts` does.
- **Maintenance** rides the seam that already exists: `ChatRoom.postMessage`'s embedded branch updates
  `comments.db` via `updateCommentIndex` — there it also appends to `recentText` (trim to the ~8 KB cap)
  and marks the **parent** container `contentDirty`, so the next sweep re-folds.
- **The fold (this proposal):** when the sweep extracts a doc / stickies container, after its own body
  it reads the parent's `comments.db` `recentText` in one in-memory query (newest-active threads first,
  inside the same ~100 KB per-file budget) and appends it to the parent's `path_content.body`. The board
  then surfaces in the Files section for a term that appears only in a card's comment.
- **Searching the comments themselves** ("find the card whose comments mention X") is a single
  `comments_fts MATCH` on that same in-memory `comments.db`; that surface lives in the current-document
  scope and is specced in [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md). The per-room
  `messages_fts` there stays the mechanism for **standalone** chat history; comment threads are served
  by this `comments.db` aggregate, not a per-thread index.

**Resolved (2026-06-26 — ready to build).**

- **Type scope:** docs / sheets / slides / **stickies** / **chat** + plaintext / code (stickies via a
  small dedicated loader; chat as the latest ~100 KB of messages). Only uploaded binary docs
  (PDF / Office) and semantic / vector stay deferred.
- **Per-file cap:** ~100 KB; for chat that means the newest ~100 KB.
- **Durability + driver:** the persisted `contentDirty` bit on `paths` IS the queue (set at the write
  seams; no separate table — a reindex re-reads live state so there is nothing to freeze, and the bit
  coalesces edits). Each mount owns a self-scheduled `ContentReindexQueue` that drains it, built as the
  read-side mirror of the S3 `UploadQueue`: kicked when a bit is set, self-times the next pass, replays
  on mount open. Chosen over a server-wide `scheduleInterval` poll (turned per-mount work global, woke
  with nothing to do) and over fire-and-forget (no replay).
- **Rate-limit:** re-extract any one container at most once per **2 min** (the cap reads
  `contentIndexedAt`); the queue self-times the next drain to exactly when the earliest capped row comes
  due. The dirty bit coalesces the ~30 s `onSync` re-marks; the cap stops an append-heavy chat or a long
  edit session from re-extracting a big body each flush.
- **Staleness key:** none beyond the bit. `contentDirty` is set only on real writes (`onSync` fires only
  when the doc actually changed; plaintext/code marked in the file-write path), so it is already
  change-gated — a separate `updatedAt` / content-hash compare would be redundant. `contentIndexedAt`
  exists only to drive the 2-min cap.
- **`paths_content_fts` shape:** external-content FTS5 over a small `path_content(pathId, body)` table
  (FTS holds only the index; the body lives in `path_content`, cleanly pathId-keyed for upsert/delete;
  `snippet()` stays available later). An `AFTER DELETE` trigger on `paths` clears the content row.
- **Migration:** mount `metadata.db` → **v6**.

## Search API

A single owner-scoped endpoint:

- **`GET /search/:ownerId`** — takes a query string, an optional kind filter (used by the
  palette's prefix scopes, e.g. `mail:`), and a per-kind result cap. It validates access the
  same way the Drive and Calendar routes do (owner is the caller, or the caller is a member of
  the team), then runs the query and returns the grouped response.

Internally the route fans out across enabled scopes — one capped query per kind per scope —
and combines same-kind results from different mounts into one group per kind; mail and calendar
are single-scope. How the combine and cross-kind ordering work — and why neither uses a fused
`bm25()` score — is set out in [Ranking and cross-kind merging](#ranking-and-cross-kind-merging).

When the user is browsing a team workspace, the owner is the team, so the same endpoint searches
the team's data under the standard team-access check. (Phase: deferred — the shipped `/search`
route — mail + drive name + drive content — is personal-owner only.)

### Response shape

The response is **grouped by kind** — a separate ranked, capped array per kind (`mail` and `file`
today; `events` / `chats` added when those phases ship). This mirrors how the palette renders
search results: one fixed section per kind. The frontend drops each group straight into its
section — no client-side bucketing — and only the cross-kind Top Hit needs logic that spans groups.

Grouping by *kind* (not by mount) is deliberate: it stays stable as a user adds mounts, where a
mount-keyed shape would not. Items shared with the user appear inside their kind's group, flagged
by a non-self owner — not as a separate group. The shipped shape is `{ mail, file }`; the `events`
and `chats` groups are added when calendar and chat indexing ship (Phases 3–4).

Each hit is the canonical domain type for its kind (`EmailSummary` for mail, `DrivePath` for
files, the canonical event/chat types for those). The grouping (`response.mail` vs
`response.file`) discriminates; frontend row components can be exactly the components per-app
views already use for those types. Same discipline as `SSEvent` / `HomeMessage` — no untyped
JSON bag at the seam, no casts. Contacts are **not** in the response — the palette serves
people from its own cached frontend provider.

Non-serialisable presentation (icons, React, the palette's rank score, the section grouping)
stays off the wire. Display data, however, **is** the canonical type — that is exactly what
makes the endpoint reusable: per-app in-app search (Mail's, Drive's) can render its existing
row components against the `EmailSummary[]` / `DrivePath[]` this endpoint returns. The shared
wire types live in the lib package and are imported by both sides.

## Ranking and cross-kind merging

Turning matches into a useful order is the hard part of search. These constraints are real, and
the model follows from them.

**`bm25()` ranks well only within one index.** SQLite FTS5's `bm25()` depends on collection-wide
statistics — the document count, each term's document frequency (IDF), and the average document
length. Those differ per index, so a `bm25()` value from the mail index and one from the
calendar index — or from two different mount indexes — sit on different, incomparable scales.
`bm25()` is a *within-one-index, within-one-query* ranking signal, never an absolute or
cross-index quality measure.

**One shared index does not fix this.** Putting every kind in one FTS5 table (Option A) does put
scores on one scale — but it *miscalibrates* that scale. `bm25()`'s length normalization assumes
a roughly homogeneous corpus; mixing ~10-word calendar notes with multi-thousand-word document
bodies makes the average-length parameter meaningless, and the result systematically favors
short items (notes, subjects, filenames) over long bodies regardless of true relevance. It also
degrades within-kind ordering, since each kind is then ranked against global statistics rather
than its own. One scale, but a skewed one — comparable numbers, not a meaningful ranking.

**Reciprocal Rank Fusion does not merge cross-kind results.** RRF combines several ranked lists
by summing `1 / (k + rank)` over the lists each item appears in; its power is rewarding
*consensus* — an item ranked highly by several lists at once. But Eigen's sources hold
**disjoint items**: a mail hit exists only in the mail list, a file only in its mount's list.
With disjoint lists every item appears in exactly one list, so its RRF score collapses to a
single `1 / (k + rank)` term — RRF degenerates to "interleave by rank position, discard match
quality." Every list's #1 ties, every #2 ties; a perfect match in one kind cannot beat a
mediocre top result of another. RRF is therefore **not** used to merge cross-kind or cross-mount
results. Its legitimate use is hybrid search (see *Future: semantic / vector search* below) —
fusing the lexical (`bm25()`) and vector rankings of *the same corpus*, where an item genuinely
appears in both lists.

**The model.** Each scope's index ranks its own kind with its own, well-calibrated `bm25()` —
good *within* a kind. Cross-kind ordering is then handled structurally, never by a fused number:

- Results are returned **grouped by kind**; the palette renders one section per kind, each in
  its kind's `bm25()` order. No cross-kind score is needed for this.
- The one cross-kind decision — the promoted **Top Hit** — is made by the palette from
  **structural match-quality signals**, which *are* comparable across kinds precisely because
  they are not statistical: whether the query exactly equals the result's title, is a prefix of
  it, or has all its terms in the title (versus only the body). A confident smart-parse (an
  email address, a URL) can also take the Top Hit. When nothing clears a confidence threshold,
  no Top Hit is shown — the user just sees the sectioned results. macOS Spotlight and Raycast
  behave this way.
- Same-kind results from **different mounts** are combined the same way — structural
  match-quality first; a plain rank-position interleave is at most a last-resort tiebreak among
  otherwise-equal results, never the primary signal.
- **No numeric relevance score crosses the wire.** The palette derives what it needs — section
  order is the within-kind rank, and title-match quality is computed from the `title` already
  returned. Consistent with presentation and ranking being the palette's concern.

The honest consequence: a single trustworthy ranking over genuinely heterogeneous content is
deliberately *not* attempted from one lexical score. Doing that well is a hard IR problem
(field-weighted scoring, learning-to-rank, embeddings) outside this proposal's scope. The
lightweight FTS5 design keeps `bm25()` to within-kind ranking and resolves cross-kind
structurally.

## Searching shared data

Items shared *with* the user live in another user's data, so they are not in this Home's own
index. Searching shared data is a **later phase**:

- **Shared filenames** can come earlier — the shared-path metadata the Home already holds
  (name, owner, mount, mime type) can be indexed locally.
- **Shared document content** and **shared calendar events** need query-time federation — the
  search also reaching the indexes of the Homes that own the user's shared items. This interacts
  with the relay/sharding seam and is deferred past the palette's first release.

## Frontend

The command palette is the only consumer of `/search/:ownerId`. Its frontend search provider is
a single debounced query against this endpoint; the response arrives already grouped by kind, so
each group maps straight to a palette section. Per-kind result rendering and navigation live in
the palette. See [PROPOSAL_COMMAND_PALETTE.md](PROPOSAL_COMMAND_PALETTE.md).

This endpoint is the *drive-wide* surface: it answers "which of my documents contain X". The
complementary surface — "where **inside** the open document is X", plus the palette's "current
document" scope that fronts it — is a separate provider and a separate set of indexes, specified in
[IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md). It does *not* go through
`/search/:ownerId`.

## Future: semantic / vector search

FTS5 keyword search handles the large majority of self-hosted search needs — known-item lookup,
subject and name search, exact keywords. Embeddings add value in narrower cases: semantic
matches without keyword overlap, natural-language queries, and cross-language retrieval. They
are a compelling **opt-in v2 enhancement**, not a v1 requirement, and must never be mandatory —
FTS5 has to work standalone.

If added, the shape is **hybrid search**: FTS5 does a fast first pass to narrow candidates, then
vector similarity re-ranks them, with a tunable weighting between the two. With embeddings
disabled, the query is pure FTS5.

**Embedding models** (2026) — several run efficiently on CPU:

| Model                | Size (quantized) | Notes                                                      |
|----------------------|------------------|------------------------------------------------------------|
| EmbeddingGemma-300M  | ~200 MB          | Best-in-class small model; ONNX; 100+ languages — recommended |
| Qwen3-Embedding-0.6B | ~400 MB          | Long context, flexible output dimensions                   |
| all-MiniLM-L6-v2     | ~80 MB           | Tiny, fast, well-understood — minimal-resource fallback    |

**Runtime** — recommended: in-process ONNX inference (Transformers.js) with EmbeddingGemma-300M.
No sidecar, no native extensions; the model file ships in the image or downloads on first use.
The alternative is an Ollama sidecar, which makes sense for deployments that already run Ollama
or that also want small-LLM features later (query expansion, summarization) — Eigen would talk
to it over HTTP. Small LLMs are not needed for search itself, v1 or v2.

**Vector storage** — keep vectors alongside the FTS content table so indexing stays a single
atomic operation per database.

What not to do:

- Don't bundle an LLM in the Docker image — too large, not everyone wants it
- Don't make embeddings mandatory — FTS5 must stand alone
- Don't run LLM inference inside the Bun process — too slow, blocks the event loop; sidecar only
- Don't store vectors in a separate database — keep them with the FTS content

## Implementation plan

| Phase | Scope                                                                                                   | Effort |
|-------|---------------------------------------------------------------------------------------------------------|--------|
| 1a    | Mail v3 migration (CREATE VIRTUAL TABLE + triggers + populate), `MailDB.searchMail` two-pass JOIN+hydrate, the `/search` route, index-on-write via FTS triggers. **Shipped — see status block.** | M |
| 1b    | Drive name indexing — mount metadata.db v2 (`paths_fts` + 3 triggers, UPDATE gated on `name` change), `Mount.searchPaths`, `Drive.search` mount fan-out, `/search` route extended with a `file` source, eigendoc-internals exclusion. **Shipped — see status block.** | M |
| 2     | Body-content indexing — docs / slides / sheets / **stickies** / **chat** (thin text collectors over the `lib/document/` loaders; stickies gets a small new loader; chat extracts the latest ~100 KB from its relational `messages` table) **plus plain text / code file bodies**, written to a sibling `paths_content_fts` table, populated by a dirty-flag + sweep worker hooked on the storage-agnostic `onSync` (not the S3-only upload queue). **Shipped — see status block.** ([worked design](#phase-2--body-content-indexing-worked-design)). | M |
| 3     | In-document / in-chat message FTS — per-room `messages_fts` over the **full** chat history (for searching within an open chat). Owned by [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md); listed here because it shares the FTS pattern. | S |
| 4     | Calendar event indexing — `calendar.db` gains an `events_fts` + same trigger shape                       | S      |
| 5     | Shared data — make items shared with the user searchable                                                 | S–M    |
| 6     | Semantic / vector search (future, opt-in)                                                                | L      |

Phases 1a, 1b, and **2** are **shipped** — the inline FTS5 mail index, the drive name index, and
the drive **content** index are all live, and the `/search` route returns `{ mail, file }`. The
command palette consumes both. Each later phase deepens what's searchable with no change to the
palette's frontend. Phases 3–6 follow the same inline-FTS pattern (Option C) — one virtual table +
triggers per domain.

**Stickies content** is now in Phase 2 (above): it needs only a small dedicated
`readStickiesContent` loader, so it no longer waits for full stickies export.

**Build order (historical).** All three tracks shipped: the in-document *actions* cleanup, this
drive-wide content index (Phase 2), and in-document content search
([IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md)).

## File structure

```
apps/api/src/lib/core/
  fts.ts                  # shared sanitizeFtsQuery — used by both mail and drive

apps/api/src/lib/mail/
  db-config.ts            # mail.db migrations including v3 (emails_fts + triggers)
  maildb.ts               # MailDB.searchMail (JOIN against emails_fts)

apps/api/src/lib/mount/
  db-config.ts            # mount metadata.db migrations including v2 (paths_fts + triggers,
                          #   UPDATE gated on name change)
  search-index.ts         # searchPaths (name + body FTS, name-over-body rank), upsertPathContent,
                          #   getContentDirtyPaths, markContainerContentDirty — the content-index
                          #   internals; reuses the shared docContainerDescendantIds exclusion CTE
  mount.ts                # thin Mount.searchPaths + content-index facades that delegate to
                          #   search-index.ts

apps/api/src/lib/drive/
  drive.ts                # Drive.search — fan out across mounts, recency tiebreak

apps/api/src/lib/<future-domain>/   # calendar, chat each follow the same shape
  db-config.ts            # adds the domain's FTS5 virtual table + triggers in a migration
  <domain>db.ts           # search<X> method joining canonical rows with FTS

apps/api/src/routes/
  search.ts               # GET /search/:ownerId — sources narrowed against SearchSource

packages/lib/src/core/search/
  keys.ts                 # TanStack query keys
  hooks/use-search.ts     # the debounced query hook + AbortSignal
  hooks/invalidate.ts     # invalidateSearchOwner — used by SSE handlers

packages/lib/src/types/
  search.ts               # SearchResponse { mail, file } + SearchSource union shared with BE
```

Note: `apps/api/src/lib/search/` was reintroduced in Phase 2 for the drive content index — it
holds only `extract-text.ts` (the per-type text collectors + `extractText` dispatch). The reindex
worker is not here: it lives beside the upload queue as
`apps/api/src/lib/mount/content-reindex-queue.ts` (per-mount, mirroring `UploadQueue`). The old
`SearchIndex` service + `search_content` schema remain gone: search is still per-domain inline FTS,
and `lib/search/` holds only body-extraction helpers, not a search-index abstraction.

## Key decisions

- **Index storage layout — Option C, inline FTS in each canonical scope DB.** Each domain's
  primary SQLite file owns its own FTS5 virtual table; no separate `search.db`. The previous
  options A (one index per Home) and B (one separate `search.db` per scope) are kept in the
  doc for the record — both were considered, both abandoned. Inline is the SQLite-native
  pattern, removes a service abstraction, and eliminates the index-drift failure mode.
- **Cross-kind ranking is structural, not score-fused.** Each kind is ranked within itself by
  `bm25()`; the cross-kind Top Hit is decided by structural match-quality (exact / prefix /
  all-query-terms-in-title), not a fused numeric score — `bm25()` is not cross-index comparable
  and RRF degenerates on disjoint result sets. No relevance score crosses the wire. See
  [Ranking and cross-kind merging](#ranking-and-cross-kind-merging).
- **Inline FTS5 virtual table** — each domain's canonical DB gains a virtual FTS5 table over
  its searchable columns, plus three AFTER INSERT/DELETE/UPDATE triggers to keep it in sync
  atomically. No separate content table; the canonical rows are the content.
- **Index on write via triggers** — AFTER INSERT/DELETE/UPDATE triggers on the canonical table
  maintain the FTS index atomically; no separate index write in the mutation flow, no separate
  sync job. The closing `INSERT INTO <fts> SELECT ... FROM <source>` in each migration is the
  backfill for pre-existing rows — no separate backfill step.
- **Content extraction reuses the shared content loaders** — collaborative text is pulled from the
  same `lib/document/` readers that preview and export sit on — *not* a separate Yjs walker, and
  *not* the capped HTML the preview generators emit — by a thin text collector, run off the request
  path via a dirty-flag + sweep worker on the storage-agnostic `onSync` seam. (As built 2026-08:
  the three collab types extract inside the document-transform Worker — `lib/search/extract-render.ts`
  behind the background `extract-text` op, over the `*FromDoc` readers; the Mount-side `read*Content`
  loaders were deleted. Stickies/chat stay light main-thread reads via `readStickiesContent` /
  `readChatContent`.) Stickies and chat are in Phase 2 (chat = latest ~100 KB of messages); only
  binary docs and semantic search are deferred.
- **Response grouped by kind** — a separate ranked, capped array per kind, mirroring the
  palette's sections; each group holds the canonical domain type for that kind (so per-app
  in-app search can reuse the endpoint); non-serialisable presentation stays off the wire.
- **No cross-home search for v1** — items shared from other users are searchable in a later
  phase, via local metadata indexing and/or query federation.
- **FTS5 first, vectors later** — keyword search is sufficient for v1; semantic search is an
  opt-in enhancement that must never be required.
