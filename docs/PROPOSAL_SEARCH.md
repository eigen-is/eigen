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
> **Index location: Option C — inline FTS in the canonical per-scope DB.** Mail's FTS
> lives inside `mail.db`; drive's lives inside each mount's `metadata.db`; calendar will
> do the same on `calendar.db` when it ships. Cross-domain query fan-out is the route's
> job; same-kind ranking is native `bm25()` within each scope; cross-mount (within-kind)
> tiebreak is recency.
>
> **Deferred (post-v1):** Document body indexing (Yjs content extraction for docs /
> slides / sheets / stickies via export loaders); chat message indexing; calendar event
> indexing; shared-with-me search; vector / semantic search. Each later phase replicates
> the inline-FTS pattern in its domain DB — additive write-path + route source per kind,
> no palette change required.
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
| Calendar | Event title, description, location      | Yes — in the calendar database        |
| Chat     | Message content, author                 | Yes — in the per-room database        |
| Docs     | Document body text                      | No — extract from Yjs state           |
| Stickies | Card titles and descriptions            | No — deferred (needs stickies export) |
| Slides   | Slide text                              | No — extract from Yjs state           |
| Sheets   | Cell text values                        | No — extract from Yjs state           |

The first four are already plain text in SQLite. The collaborative types store content as binary
Yjs state and need text extraction — see [Content extraction](#content-extraction-from-collaborative-documents).
Stickies content waits for stickies export to ship (also below).

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
`searchX(opts)` method in parallel and assembles `{ mail, files, events, chats }`. Same-kind
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
search method (`MailDB.searchMail`, future `Mount.searchFiles`, etc.) is a two-pass query —
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
write a second Yjs decoder, content extraction **reuses the export pipeline's content loaders** —
the modules that already turn each file type's Yjs state into a structured form:

- **Docs** — `export/doc/content.ts` produces ProseMirror JSON (already shared with preview)
- **Slides** — `export/slides/content.ts` produces `DeckData`
- **Sheets** — `export/sheets/content.ts` produces `Sheet[]`

These loaders are server-side and DOM-free — the same code path the document, slides, and sheets
export already runs in Bun. Search adds only a **thin text collector** on top: a small per-type
walk that pulls the words out of the structured form (ProseMirror JSON → text, `DeckData` →
text, `Sheet[]` → cell text). The hard part — decoding each file type's distinct Yjs shape — is
delegated to code that already exists, is tested, and is shared with export and preview, so
search's notion of "document text" can't drift from theirs. Search does **not** run the full
HTML export: that stage embeds fonts and base64 images, flattens CSS, and sanitises — all wasted
work for an index that only wants words.

**Stickies** have no export pipeline yet, so there is no content loader to reuse. Stickies
*content* is therefore indexed **later** — once stickies export ships and brings an
`export/stickies/content.ts` loader, the same thin-collector approach applies to it. Until then
a stickies file contributes only its metadata (the file name) to the index.

Extraction runs during **snapshot creation**, which already happens periodically (roughly every
hundred edits) — acceptable staleness, and it avoids re-extracting on every keystroke. With
inline FTS5 (Option C), the mount's own FTS table is reachable directly from the snapshot code
without threading a separate service reference. Extraction failures must never block the
snapshot itself — they're caught and logged.

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
the team's data under the standard team-access check. (Phase: deferred — the initial mail slice
is personal-owner only.)

### Response shape

The response is **grouped by kind** — a separate array for files, mail, events, and chats, each
already ranked and capped. This mirrors how the palette renders search results: one fixed
section per kind. The frontend drops each group straight into its section — no client-side
bucketing — and only the cross-kind Top Hit needs logic that spans groups.

Grouping by *kind* (not by mount) is deliberate: it stays stable as a user adds mounts, where a
mount-keyed shape would not. Items shared with the user appear inside their kind's group, flagged
by a non-self owner — not as a separate group. Chat is part of the shape from day one but stays
empty until chat indexing ships (Phase 3).

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
| 2     | Content extraction for docs, slides, and sheets — a thin text collector over the export content loaders, hooked into snapshot creation; lands inside the same `paths_fts` (additional column) or a sibling `paths_text` table. | M |
| 3     | Chat message indexing — index message content                                                            | S      |
| 4     | Calendar event indexing — `calendar.db` gains an `events_fts` + same trigger shape                       | S      |
| 5     | Shared data — make items shared with the user searchable                                                 | S–M    |
| 6     | Semantic / vector search (future, opt-in)                                                                | L      |

Phases 1a and 1b are **shipped** — the inline FTS5 mail index and the drive name index are
both live, and the `/search` route returns `{ mail, file }`. The command palette consumes
both. Each later phase deepens what's searchable with no change to the palette's frontend.
Phases 2–6 follow the same inline-FTS pattern (Option C) — one virtual table + triggers per
domain.

**Stickies content** joins when stickies export ships and brings an `export/stickies/content.ts`
loader — at that point the Phase 2 thin-collector approach extends to stickies. That work is
tracked with stickies export, not scoped here.

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
  mount.ts                # Mount.searchPaths (JOIN against paths_fts) + docContainerDescendantIds
                          #   recursive-CTE fragment shared with getPathsByMimeType

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

Note: `apps/api/src/lib/search/` no longer exists. The previous `SearchIndex` service +
`search_content` schema were collapsed into per-domain inline FTS.

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
- **Content extraction reuses the export loaders** — collaborative text is pulled from the
  export pipeline's Yjs content loaders (not a separate Yjs walker) by a thin text collector,
  run at snapshot creation rather than per edit. Stickies wait for stickies export.
- **Response grouped by kind** — a separate ranked, capped array per kind, mirroring the
  palette's sections; each group holds the canonical domain type for that kind (so per-app
  in-app search can reuse the endpoint); non-serialisable presentation stays off the wire.
- **No cross-home search for v1** — items shared from other users are searchable in a later
  phase, via local metadata indexing and/or query federation.
- **FTS5 first, vectors later** — keyword search is sufficient for v1; semantic search is an
  opt-in enhancement that must never be required.
