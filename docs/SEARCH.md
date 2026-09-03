# Search

> **TLDR**: Full-text search is SQLite FTS5 living **inside each canonical database** — no separate
> `search.db`, no search service. Mail indexes headers and preview text in `mail.db`; every Drive
> mount indexes file **names** and extracted **body content** in its own `metadata.db`. One route,
> `GET /search/:ownerId`, fans out and returns `{ mail, file }`. Calendar events, standalone chat
> history and data shared into the home by other people are not indexed yet.

## What is searchable

| Scope | Index | Contents |
|---|---|---|
| Mail | `emails_fts` in `mail.db` | subject, sender, recipients, body preview |
| Drive names | `paths_fts` in each mount's `metadata.db` | file and folder names |
| Drive bodies | `paths_content_fts` in the same `metadata.db` | docs, sheets, slides, stickies, chat, plus plain-text and code files |

Contacts are deliberately not indexed — the palette caches them and filters client-side.

## Inline FTS5, one index per scope

Every domain's own SQLite file owns its FTS5 virtual table. This is the plain SQLite pattern:
an external-content table (`content='<source>'`, `content_rowid='rowid'`) plus three
`AFTER INSERT / DELETE / UPDATE` triggers that maintain the index in the same transaction as the
canonical write. Consequences worth knowing:

- Creating the index is an ordinary migration step — `mail.db` v3, mount `metadata.db` v2 (names)
  and v6 (bodies). Each migration closes with `INSERT INTO <fts> SELECT … FROM <source>`, which is
  the one-time backfill for existing rows.
- The index cannot drift from its source, and deleting a scope (a mount, the mail directory) takes
  its index with it. There is nothing to clean up.
- `bm25()` is comparable only *within* one index. Merging across mounts therefore never sorts on
  score — see below.

Query text is sanitised by the shared `sanitizeFtsQuery` in `apps/api/src/lib/core/fts.ts`: FTS5
grammar characters are replaced with spaces, each token is phrase-quoted, and a prefix wildcard is
appended (`q3 budget!` → `"q3"* "budget"*`).

## Mail

`mail.db` v3 adds `emails_fts` over seven columns (`subject`, `fromShort`, `fromAddress`,
`toShort`, `toAddress`, `recipientsAll`, `textShort`), tokenised `porter unicode61`. Its UPDATE
trigger fires unconditionally, because a draft edit rewrites several indexed columns at once.
`textShort` is stored in full for the index; the 200-character truncation happens at the response
seam, not in the database.

`MailDB.searchMail` (`apps/api/src/lib/mail/maildb.ts`) runs in two passes. **Pass 1** narrows to
candidate ids through `mail.db`'s own indexed columns when `from` / `to` is set (exact recall at any
selectivity), then the FTS join ranks `ORDER BY bm25(emails_fts), e.date DESC, e.id DESC` and
returns **ids only** — raw `sql` results get no Drizzle column conversion. **Pass 2** re-selects
those ids through Drizzle so `mode: 'timestamp'` columns come back as `Date`, with an id-keyed map
restoring rank order.

`Trash` and `Junk` are excluded by default; naming a mailbox explicitly searches it.
`MailDomain.search` canonicalises mailbox names first, so callers may pass any casing.

## Drive: names and bodies

`Mount.searchPaths` is a thin facade over `apps/api/src/lib/mount/search-index.ts`, which runs the
same two-pass shape as mail but over **two** FTS tables:

- **Pass 1a — names** against `paths_fts`. Its UPDATE trigger is gated on
  `WHEN old.name IS NOT new.name`, so the frequent writes (size, hash, thumbnail, `trashedAt`, ACL,
  details) never churn the FTS shadow tables.
- **Pass 1b — bodies** against `paths_content_fts`, joined back to `paths` through `path_content`.
- **Merge**: name hits first, then body-only hits, deduped by id. The name boost is structural,
  not a fused score — a filename match always outranks a body-only match.
- **Pass 2** hydrates through Drizzle and maps rows to `DrivePath`.

Both passes skip trashed rows and the mount root, and both apply the shared
`docContainerDescendantIds` recursive CTE from `mount/helpers.ts`. That CTE lists every path
descended from a doc / sheets / slides / stickies / chat container, so container internals —
`data.db`, embedded media, embedded comment chats — never surface. The same fragment backs
`getPathsByMimeType`, so search and the Drive UI hide exactly the same rows.

`Drive.search` (`apps/api/src/lib/drive/drive.ts`) fans out over the home's own mounts, then sorts
the merged set by `updatedAt DESC` before slicing to the limit: `bm25()` cannot be compared across
mount indexes, so recency is the cross-mount tiebreak.

## The drive content index

`metadata.db` v6 adds a `path_content(pathId, body)` table with a sibling external-content
`paths_content_fts` over it. Body text is deliberately **not** a column on `paths` — that row is
read by every folder listing. An `AFTER DELETE ON paths` trigger drops the content row with its
path, so lifecycle is automatic.

**Extraction.** `apps/api/src/lib/search/extract-text.ts` dispatches on mime type. The four collab
types (doc, sheets, slides, vector) extract inside the one-shot document-transform Worker — the background
`extract-text` op runs `lib/search/extract-render.ts` over the same `*FromDoc` readers of the
[document content layer](DOCUMENT-CONTENT-LAYER.md) that preview and export use, so search's idea of
"document text" cannot drift from them, and a heavy extraction never blocks the event loop (own 30 s
deadline, background queue quota — see [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)). Thin collectors
flatten each shape (ProseMirror JSON → text, the **sparse** `celldata` display values), cut to the
`CONTENT_INDEX_MAX_BYTES` UTF-8 byte budget (~100 KB) at a code-point boundary. A deck and a drawing
are the same document, so **one** collector serves both: `collectCanvasText` walks each element kind's
own `searchText` in reading order — frame by frame, then z-order inside a frame — which is
`searchScene`'s rule, so the index and the in-document find bar cannot disagree about what a canvas
says.
Stickies and chat stay light main-thread reads (`readStickiesContent`, `readChatContent` — card and
column text; chat is relational, not Yjs, and takes the **newest** ~100 KB by paging backwards on
`createdAt`). Plain files are eligible via the canonical `isSearchableTextFile` and read through
`mount.readRange` so a huge file is never slurped. The preview generators and the export pipeline are
both avoided on purpose: the first emits capped HTML, the second embeds media and can densify a
sparse sheet.

**Queue.** The `contentDirty` bit on `paths` *is* the queue — no side table, no staged copy, since a
reindex re-reads live state and the bit coalesces many edits into one extract. Producers set it and
tell the queue (`markDirty` — or, for rows that already exist, a generation bump *before* the
bit-setting write plus `kick()` after it):

- containers, from the storage-agnostic `onSync` callback in `mount/document-db.ts` (fires for
  `local`, `local-key` and `s3` alike — hooking the S3-only upload queue would silently skip local
  backends). `markContainerContentDirty` marks the *parent* container and only for `data.db`, so a
  sibling `comments.db` sync does not trigger a re-extract;
- plain text and code files, at the file-write seams in `mount.ts`;
- `copyPath`, because a byte-copied container fires no `onSync`;
- the v6 migration itself, which marks every existing container and text file.

`ContentReindexQueue` (`apps/api/src/lib/mount/content-reindex-queue.ts`) is the read-side mirror of
the S3 `UploadQueue`: one drain loop per mount, batches of 100, self-timed to when the earliest
capped row comes due — no process-wide poll. A container is re-extracted at most once per
`CONTENT_REINDEX_CAP_SECONDS` (120 s), which is what stops a two-hour edit session or an
append-heavy chat re-indexing a big body on every 30-second sync. A successful extract upserts
`path_content` and clears the bit — unless a write landed while the extract ran: a per-path in-memory
generation, bumped by every producer before the bit-setting write, fences the clear, so the newer
content keeps the bit and re-extracts after the cap window. A throw is logged, stamps
`contentIndexedAt` and **keeps** the bit, so a transient storage hiccup retries after the cap instead
of dropping the doc from body search. Mount teardown awaits the in-flight extract with a bounded timeout; leftover dirty rows
replay on the next mount open.

## Route and frontend

`GET /search/:ownerId` (`apps/api/src/routes/search.ts`) takes `q`, `sources`, `mailbox`, `from`,
`to`, `limit` (max 50) and `teams`. It is self-only (`requireNonGuest` + `requireSelf`). `sources`
is narrowed against the shared `SearchSource` union (`'mail' | 'file'`) in
`packages/lib/src/types/search.ts`, so backend and frontend cannot drift. The response is grouped by
kind — `SearchResponse { mail: EmailSummary[]; file: DrivePath[] }` — using the canonical domain
types, so app views can render search hits with their existing row components. No relevance score
crosses the wire.

`teams=1` routes the file source through `aggregateFileSearch` (`lib/drive/aggregate.ts`), which
adds every team the caller belongs to via `pullDriveSearch` on the home relay, dedupes by path id
and re-sorts by recency. Mail stays personal.

On the frontend, `packages/lib/src/core/search/` holds `useSearchQuery` (30 s `staleTime`, `enabled`
guard, `AbortSignal` threaded through Eden), `searchKeys` (keyed by owner and every query
parameter) and `invalidateSearchOwner`. The command palette's `mail-search` and `file-search`
providers are the consumers; each debounces and asks for its own source only.

SSE invalidation calls `invalidateSearchOwner` from every mail mutation event and from every Drive
event that can change an indexed name: folder/file created, file uploaded, folder/file deleted, path
renamed, trashed, restored. `DRIVE_PATH_MOVED` is deliberately **not** in that list — a move changes
neither the name nor the body. Content reindexing emits no SSE either: search is a live per-query
fetch over an eventually-consistent index, so a push would buy nothing.

## Boundary: this index versus the find bar

This subsystem answers **"which file contains it"**. Finding *where inside the open document* a term
sits — the `⌘F` find bar, the palette's `doc:` scope, the `?q=` deep link — is a different system
with different indexes, described in [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md). Comment search
belongs there too: per-container `comments.db` carries its own `comments_fts`, served by the collab
comments route, not by `/search`.

## Remaining

- **Calendar.** `calendar.db` has no `events_fts`. It is the last unsearchable domain and follows
  the same pattern — one virtual table, three triggers, a populate step. Tracked in
  [ROADMAP.md](ROADMAP.md).
- **Standalone chat history.** Drive search sees only the newest ~100 KB of a room. Full history
  needs a per-room `messages_fts`, which belongs with in-document search.
- **Shared data.** `Drive.search` covers the caller's own mounts, and `teams=1` adds their team
  homes. Items other users shared *into* the home are still not searchable — that needs either
  local indexing of shared-path metadata or query-time federation across homes.
- **Semantic / vector search.** Deferred. If it lands it should be hybrid (FTS5 narrows, vectors
  re-rank) and always optional — FTS5 has to stand alone.
