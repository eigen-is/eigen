# Search Index

> **TLDR**: The **backend search infrastructure** consumed by the
> [command palette](PROPOSAL_COMMAND_PALETTE.md). SQLite FTS5 full-text search. **Where the
> index physically lives is an open decision** — one database per Home, or one per scope (per
> mount, plus mail and calendar). This proposal documents both, with a working lean toward
> per-scope, for a review round to settle. Each domain indexes its text on write; the search
> endpoint returns results **grouped by kind** — the palette renders one section per group.
> Future: optional hybrid keyword + vector search. **No UI here — the palette is the only
> consumer.**

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

| Domain   | What's indexed                          | Source already text?            |
|----------|-----------------------------------------|---------------------------------|
| Mail     | Subject, sender, short body preview     | Yes — in the mail database      |
| Drive    | File and folder names                   | Yes — in mount metadata         |
| Calendar | Event title, description, location      | Yes — in the calendar database  |
| Chat     | Message content, author                 | Yes — in the per-room database  |
| Docs     | Document body text                      | No — extract from Yjs state     |
| Stickies | Card titles and descriptions            | No — extract from Yjs state     |
| Slides   | Slide text                              | No — extract from Yjs state     |
| Sheets   | Cell text values                        | No — extract from Yjs state     |

The first four are already plain text in SQLite. The four collaborative types store content as
binary Yjs state and need text extraction — see [Content extraction](#content-extraction-from-collaborative-documents).

Contacts are deliberately **not** indexed — they are few and already fully cached on the
frontend, so the command palette filters them client-side (see [Response shape](#response-shape)).

## Approach: SQLite FTS5

FTS5 is SQLite's built-in full-text search module. It's the right fit:

- Already using SQLite everywhere — zero new dependencies; FTS5 is compiled into Bun's SQLite
- Fast — sub-millisecond queries on the data volumes a self-hosted deployment sees
- Built-in relevance ranking (`bm25()`), snippet extraction, and prefix queries
- Per-file databases match Eigen's existing data-isolation model

## Search index location

The index uses SQLite FTS5 (above). **Where it physically lives — and how many database files
there are — is an open decision.** Two options are on the table; this section documents both.
The rest of the proposal is drafted against Option B (the current lean), with the differences
collected at the end of this section.

### Option A — one index per Home

A single `search.db` per Home — one per user, one per team — holding every domain's content in
one FTS table, discriminated by a `kind` column.

**For:**

- The storage unit matches the access unit. Search is always Home-wide, and so is the index —
  no cross-scope merge. Per-kind result groups come from one table, and the cross-kind Top Hit
  ranks on native, comparable `bm25()`.
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

### Option B — one index per scope

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

- Search is Home-wide, so every query fans out across all enabled scopes. Same-kind results
  from different mounts must be merged by rank fusion (Reciprocal Rank Fusion), because
  `bm25()` is comparable only within one index. Real recurring per-query work.
- More open file handles per Home; a Home-level coordinator is needed to gather and merge.
- The cross-kind Top Hit is a rank-fusion approximation, not a native ranking.

### How much it matters

The gap is small at one mount — a typical solo user — where the two are nearly identical for
Drive. It widens with multi-mount teams: Option A then avoids a cross-mount merge on every
keystroke, while Option B avoids query-time filtering and lifecycle bookkeeping. The deciding
factor is how mounts are expected to be used — as long-lived, enable/disable/archive-able
project spaces (favours B) or as a mostly-static single space (A and B converge).

### What the choice pins down downstream

Whichever option is chosen, most of this proposal is identical — the FTS5 content-table
structure, index-on-write, Yjs extraction, the grouped response, and the wire types do not
change. The decision only pins down:

- **The `SearchIndex` service** — Option A: one instance on `Home`. Option B: one instance per
  scope, plus a Home-level coordinator that merges.
- **The query path** — Option A: per-kind queries against one database. Option B: fan-out
  across scopes, then a rank-fusion merge of same-kind results.
- **Lifecycle cleanup** — Option A: an explicit delete-by-mount on mount removal. Option B: the
  mount's index is disposed with the mount.
- **File count** — Option A: one `search.db` per Home. Option B: one per mount, plus mail and
  calendar.

### Status

**Open — to be settled in a later review round.** Working lean: Option B, for the mount-
lifecycle fit. The sections below are drafted against Option B; under Option A, substitute the
four points above.

## Index structure

Every `search.db` has the same structure, built on FTS5's **external-content-table** pattern:

- A **content table** — one row per indexed item: its kind (`file`, `chat`, `mail`, `event`),
  the source item's id, the searchable title and body text, a small metadata blob (domain
  fields used to render a result), and a timestamp. A uniqueness constraint on kind + item id
  makes re-indexing an idempotent upsert.
- An **FTS5 virtual table** indexing only the title and body.
- **Triggers** keeping the FTS table in sync on every insert, update, and delete.

Under Option B a mount's index holds `file` and `chat` rows (a chat room is a file in the
mount), while the mail and calendar indexes hold a single kind each; under Option A all kinds
share one table. Either way the `kind` column drives per-kind queries and the grouped response.
Each database is versioned through the standard `ManagedDatabase` migration mechanism.

### The SearchIndex service

`SearchIndex` wraps one `search.db`. It exposes **upsert**, **delete**, and **query**.

Under Option B it is instantiated **per scope** — a `Mount` owns its `SearchIndex`, the mailbox
owns one, the calendar owns one — and a thin **Home-level coordinator** drives a search across
scopes: it enumerates the Home's enabled mounts plus mail and calendar, queries each scope's
index, and merges the results (see [Search API](#search-api)). Under Option A there is a single
`SearchIndex` on `Home` and no coordinator. Either way the route handler stays thin.

**Query sanitization matters.** FTS5 has its own query grammar (`AND`/`OR`/`NOT`, quoting,
column qualifiers). Raw user input can't be passed through — stray punctuation falls through as
a qualifier or an unbalanced quote and throws at the SQLite layer. The query method strips
metacharacters, phrase-quotes each token, appends a prefix-match wildcard, and joins tokens —
so arbitrary typed input is always a safe, sensible query.

## Indexing strategy

**Index on write.** Each domain hooks into its existing mutation flow and writes to the index
after its own database write. The index stays current without a separate sync job.

| Write                                            | Indexed into                       |
|--------------------------------------------------|------------------------------------|
| An email is added or deleted                     | the mail index                     |
| An event is created or updated                   | the calendar index                 |
| A file or folder is created, renamed, or deleted | the (mount's) index                |
| A chat message is posted or edited               | the (host mount's) index           |
| A doc / stickies / slides / sheets snapshot      | the (host mount's) index           |

(Under Option A, every row above writes the one per-Home index.) Each domain writes the metadata
blob shaped to fit its result kind — mail emits sender, mailbox, and received time; drive and
the collaborative types emit owner, mime type, and a subtitle; calendar emits start time,
location, and calendar name; chat emits chat id, owner, chat title, and sent time. The query
side reads those fields back to build the typed result.

A **one-time backfill** populates the index by walking each domain's data. Under Option B it
runs per scope, so it parallelizes naturally and a single corrupt scope can be rebuilt alone.

## Content extraction from collaborative documents

Docs, stickies, slides, and sheets store their content as binary Yjs state, not text. The
server has no DOM, so extraction walks the Yjs structure directly. **Each Eigen file type
stores content under a different Yjs shape**, so extraction is per-type:

- **Docs** — a rich-text XML fragment; walk it and collect the text nodes
- **Stickies** — a map of cards; collect each card's title and description
- **Slides** — a map of objects; collect the text of the text objects
- **Sheets** — a JSON snapshot of cell data; collect the rendered cell values

Extraction runs during **snapshot creation**, which already happens periodically (roughly every
hundred edits) — acceptable staleness, and it avoids re-extracting on every keystroke. Under
Option B the mount's own `SearchIndex` is reachable directly from the snapshot code; under
Option A the Home's index reference must be threaded down to it. Extraction failures must never
block the snapshot itself — they're caught and logged.

## Search API

A single owner-scoped endpoint:

- **`GET /search/:ownerId`** — takes a query string, an optional kind filter (used by the
  palette's prefix scopes, e.g. `mail:`), and a per-kind result cap. It validates access the
  same way the Drive and Calendar routes do (owner is the caller, or the caller is a member of
  the team), then runs the query and returns the grouped response.

Internally the query path depends on the storage option. Under Option B a Home-level coordinator
queries every **enabled** mount index plus the mail and calendar indexes — one capped query per
kind per scope — and merges: same-kind results from different mounts (files, chats) are fused by
rank position (Reciprocal Rank Fusion) into one ranked group; mail and calendar are
single-scope and rank natively with `bm25()`. Under Option A the same grouped result comes from
per-kind queries against the one index, ranked natively throughout.

When the user is browsing a team workspace, the owner is the team, so the same endpoint searches
the team's data under the standard team-access check.

### Response shape

The response is **grouped by kind** — a separate array for files, mail, events, and chats, each
already ranked and capped. This mirrors how the palette renders search results: one fixed
section per kind. The frontend drops each group straight into its section — no client-side
bucketing — and only the cross-kind Top Hit needs logic that spans groups. This is identical
under either storage option.

Grouping by *kind* (not by mount) is deliberate: it stays stable as a user adds mounts, where a
mount-keyed shape would not. Items shared with the user appear inside their kind's group, flagged
by a non-self owner — not as a separate group. Chat is part of the shape from day one but stays
empty until chat indexing ships (Phase 3).

Each hit is a typed variant — file, mail, event, chat — carrying a `kind` discriminator the
frontend's row components switch on. Same discipline as `SSEvent`, `HomeMessage`, and the
notification center: no untyped JSON bag at the seam, no casts on the frontend. Contacts are
**not** in the response — the palette serves people from its own cached frontend provider.

Presentation fields — icon, ranking score, result group — are deliberately **not** on the wire.
They belong to the [command palette](PROPOSAL_COMMAND_PALETTE.md), which projects each search
hit into its own result model by adding them on the frontend. Keeping them off the wire leaves
the endpoint portable to other consumers (a future per-app search page). The shared wire types
live in the lib package and are imported by both sides.

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
| 1     | The `search.db` schema and `DatabaseConfig`, the `SearchIndex` service (per the chosen storage option), the `/search` route returning the grouped shape, index-on-write hooks for **metadata** (mail, calendar, drive names), and a one-time backfill — the milestone where the palette's search lights up | M–L |
| 2     | Content extraction for docs, stickies, slides, and sheets — hook into snapshot creation                  | M      |
| 3     | Chat message indexing — index message content                                                            | S      |
| 4     | Shared data — make items shared with the user searchable                                                 | S–M    |
| 5     | Semantic / vector search (future, opt-in)                                                                | L      |

Phase 1 is the **prerequisite track** the command palette depends on — see that proposal's phase
table. It can be built in parallel with the palette's frontend-only phases. After Phase 1 the
palette searches metadata (filenames, subjects, titles); each later phase deepens what's
searchable with no change to the palette's frontend. The storage-layout decision (above) should
be settled before Phase 1 starts.

## File structure

```
apps/api/src/lib/search/
  schema.ts               # the content table (Drizzle)
  db-config.ts            # the search DatabaseConfig — FTS5 virtual table + sync triggers
  search-index.ts         # the SearchIndex service — upsert, delete, query
  search-coordinator.ts   # Option B only — enumerate enabled scopes, query, rank-fuse, group
  yjs-extract.ts          # per-type text extraction from Yjs state (server-safe, no DOM)

apps/api/src/routes/
  search.ts               # the GET /search/:ownerId endpoint

packages/lib/src/types/
  search.ts               # shared wire types — the search-hit variants + grouped response shape
```

## Key decisions

- **Index storage layout — OPEN.** One index per Home, or one per scope (per mount, plus mail
  and calendar). Both options, with honest pros and cons, are weighed in
  [Search index location](#search-index-location); the choice is deferred to a review round.
  Working lean: per scope, for the mount-lifecycle fit.
- **Content table + FTS5 virtual table** — kind, ids, and metadata stay in a regular table;
  only title and body are full-text indexed; triggers keep them in sync.
- **Index on write** — each domain indexes through its existing mutation flow; no separate sync
  job. A one-time backfill covers pre-existing data.
- **Content extraction on snapshot** — collaborative-document text is extracted when a snapshot
  is created (already periodic), not per edit. Acceptable staleness for far less work.
- **Response grouped by kind** — a separate ranked, capped array per kind, mirroring the
  palette's sections; each hit a typed variant. Presentation fields stay off the wire. Identical
  under either storage option.
- **No cross-home search for v1** — items shared from other users are searchable in a later
  phase, via local metadata indexing and/or query federation.
- **FTS5 first, vectors later** — keyword search is sufficient for v1; semantic search is an
  opt-in enhancement that must never be required.
