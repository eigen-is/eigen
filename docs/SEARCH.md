# Search

> **TLDR:** Full-text search is SQLite FTS5 inside each domain's own database, with no search service: `emails_fts` in `mail.db`, and `paths_fts` (names) plus `paths_content_fts` (bodies) in every mount's `metadata.db`. One route, `GET /search/:ownerId`, fans out and returns `{ mail, file }`. Three things are not obvious from the code: a `bm25()` score is never compared across two indexes, so the final file list sorts by recency; the `contentDirty` bit on `paths` is the reindex queue; and a document's body comes from the same readers export and preview use. Calendar events and contacts have no index. Finding a match inside the open document is [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md).

## Each index lives in the database it indexes

Every FTS5 table is an external-content table over its source (`content='<source>'`) with three `AFTER INSERT / DELETE / UPDATE` triggers. The triggers write the index in the same transaction as the source row, so the index can't drift from it, and deleting a scope (a mount, the mail directory) takes its index along. Creating an index is an ordinary migration that ends with `INSERT INTO <fts> SELECT … FROM <source>`, the backfill for existing rows: `mail.db` v3 in `apps/api/src/lib/mail/db-config.ts`, `metadata.db` v2 (names) and v6 (bodies) in `apps/api/src/lib/mount/db-config.ts`.

Contacts have no index. The palette caches them and filters on the client.

## Query text becomes prefix phrases

FTS5 reads punctuation as operators, so raw input never reaches `MATCH`. `sanitizeFtsQuery` (`apps/api/src/lib/core/fts.ts`) turns every run of non-letters and non-digits into a space, phrase-quotes each token and appends a prefix wildcard: `q3 budget!` becomes `"q3"* "budget"*`. Mail, drive and comment search all go through it.

## A search ranks ids first and hydrates them after

Every search runs in two passes. Pass 1 is raw SQL: the FTS join ranks by `bm25()` and returns ids only. Pass 2 selects those ids again through Drizzle and restores the rank order from an id-keyed map. The split exists because a raw `sql` result gets no Drizzle column conversion, so a `mode: 'timestamp'` column would not come back as a `Date`.

## Mail matches the whole body, a draft only its preview

`emails_fts` covers the subject, the sender and recipient columns and `textShort`, tokenized `porter unicode61`. Received mail stores its whole plain text in `textShort`. The list view cuts it to `MAIL_PREVIEW_CHARS` (200) at the response, so search still matches the full body. A draft save writes `textShort` already cut to 200 characters, so a draft is found only by its opening. The UPDATE trigger has no column gate, because a draft save rewrites several indexed columns at once.

## A mail filter narrows before the index ranks

`MailDB.searchMail` (`apps/api/src/lib/mail/maildb.ts`) applies `from` and `to` first: a `LIKE` over the sender and recipient columns picks the candidate ids, and the FTS pass ranks only those. That gives exact recall at any selectivity, with no over-fetched candidate pool. A filter with no text term is a query on its own and ranks by date.

Trash and Junk are left out unless the caller names a mailbox. `Mail.search` (`apps/api/src/lib/mail/mail-domain.ts`) canonicalizes the names first, because the filter compares the stored value exactly.

## Inside one mount, a name match outranks a body match

`searchPaths` (`apps/api/src/lib/mount/search-index.ts`) queries `paths_fts` for names and `paths_content_fts` for bodies, each ranked by its own `bm25()`. It lists the name hits first, then the body-only hits, deduped by id, and cuts to the limit. So a file whose name matches always makes the cut before one that matched only on its body.

Both passes skip trashed rows and the mount root. Both also exclude `docContainerDescendantIds` (`mount/helpers.ts`), every path inside an Eigen container: its `data.db`, embedded media and comment chats. `getPathsByMimeType` uses the same fragment, so search and the Drive UI hide the same rows.

The `paths_fts` UPDATE trigger fires only when the name changes, so the frequent writes (size, hash, thumbnail, trash, ACL) never churn the FTS shadow tables.

## Across mounts and homes, files sort by recency

A `bm25()` score is comparable only within one index. So `Drive.search` (`apps/api/src/lib/drive/drive.ts`) merges each mount's results and sorts them by `updatedAt`. That sort runs even for a single mount, so the name-first order decides which files make the cut but not the order they come back in.

`teams=1` goes through `aggregateFileSearch` (`lib/drive/aggregate.ts`), which adds each of the caller's team homes through `pullDriveSearch` on the home relay, dedupes by path id and sorts by recency again. A team home that fails to answer is left out. Mail stays personal, and items other users shared into the home are not searched.

## Body text lives in its own table

`path_content(pathId, body)` holds the extracted text and `paths_content_fts` indexes it. The body is not a column on `paths`, because every folder listing reads that row. An `AFTER DELETE ON paths` trigger removes the content row with its path.

## Documents are extracted by the readers export and preview use

`extractText` (`apps/api/src/lib/search/extract-text.ts`) picks its branch by container type, and uses the mime only for a real container, because an upload's `mimeType` is whatever the caller sent.

- Docs, sheets, slides and drawings extract in the document-transform Worker at background priority, under its 30 s deadline ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)). `extract-render.ts` runs the `*FromDoc` readers of the [document content layer](DOCUMENT-CONTENT-LAYER.md), so search's idea of a document's text can't drift from what export and preview show, and a heavy extract never blocks the event loop. A sheet indexes its stored display values, with no recalc.
- Slides and drawings share one collector, `collectCanvasText`. It walks each element kind's `searchText` in `sceneReadingOrder`, the order the find bar's `searchScene` uses, so the index and the find bar agree on what a canvas says.
- Stickies and chat are light reads on the main thread: card and column text, and the newest chat messages.
- A plain-text or code file qualifies through `isSearchableTextFile`. Its first 100 KB come through `mount.readBytes` with a limit, so a huge file is never read whole. An `.ics` indexes its raw text too.

Each body is capped at `CONTENT_INDEX_MAX_BYTES` (`search/limits.ts`, about 100 KB), so one huge file can't dominate the index. The Worker collectors cut to that UTF-8 byte budget at a code-point boundary. The preview renderers and the export pipeline are not reused: the first emits capped HTML, the second embeds media and can densify a sparse sheet.

## A .vcf indexes its cards, an .eml nothing

A `.vcf` is mostly base64 photo, and a name folded across lines isn't there to match. So `extractVCardText` runs the vCard preview job ([PREVIEWS.md](PREVIEWS.md#a-vcf-preview-never-fetches-a-photo)) and indexes each card's name, emails, company and job title. It inherits that job's limits. A file over `VCARD_MAX_BYTES`, or one the decoder refuses, indexes as empty instead of staying dirty for every later drain, and cards past `VCARD_PREVIEW_MAX_CARDS` are not indexed.

It runs the job itself rather than reading through `getVCardPreview`. That cache is keyed by file version and serves the old body while it regenerates, and an index built from an older version's cards would stay wrong with nothing to correct it. The price is that an uploaded `.vcf` builds its cards twice: once on the drain, once on first view.

An `.eml` is not searchable under any of its mimes. Its raw body is headers, boundaries and base64, and what a reader sees of it is the payload the quick look builds ([PREVIEWS.md](PREVIEWS.md#the-eml-payload-is-where-a-message-is-made-safe)).

## The dirty bit is the reindex queue

`paths.contentDirty` is the queue, with no side table and no staged copy: a reindex reads live state, and the bit folds many edits into one extract. The producers set it:

- a container's `data.db` sync, through the `onSync` callback in `mount/document-db.ts`. It fires for every storage backend, where a hook on the S3 upload queue would skip local mounts. `markContainerContentDirty` marks the parent container, and only for `data.db`, so a `comments.db` sync doesn't re-extract.
- a plain-text or code file write, in `mount.ts`
- `copyPath`, because a byte-copied container fires no `onSync`
- the v6 migration, which marks every existing container and text file

A new row calls `markDirty`. An existing row bumps its generation before the write that sets the bit and calls `kick()` after it.

## The queue extracts a path at most once per two minutes

`ContentReindexQueue` (`apps/api/src/lib/mount/content-reindex-queue.ts`) is the read-side twin of the S3 `UploadQueue`: one drain loop per mount, batches of 100, and a timer set for when the earliest capped row comes due, with no process-wide poll. A path re-extracts at most once per `CONTENT_REINDEX_CAP_SECONDS` (120 s). The cap stops a long edit session or a busy chat from re-extracting a big body on every 30-second sync.

A successful extract writes `path_content` and clears the bit, unless a write landed while it ran. A per-path in-memory generation fences the clear, so the newer content keeps the bit and re-extracts after the cap. A failed extract is logged, stamps `contentIndexedAt` and keeps the bit, so a storage hiccup retries after the cap instead of dropping the file from body search. Mount teardown aborts the in-flight read and waits for the extract with a bounded timeout. The drain stops at the abort without stamping the row, and the leftover dirty rows drain on the next mount open.

## The route is self-only and returns domain types

`GET /search/:ownerId` (`apps/api/src/routes/search.ts`) refuses guests and anyone but the owner. `sources` narrows against the shared `SearchSource` union (`packages/lib/src/types/search.ts`), so the two ends can't drift. The response carries the canonical `EmailSummary` and `DrivePath`, so an app renders hits with its existing row components. No score crosses the wire.

## The client caches per owner and events invalidate it

`useSearchQuery` (`packages/lib/src/core/search/`) caches for 30 s under keys that start with the owner, so `invalidateSearchOwner` drops them all. The palette's mail and file providers each debounce and ask for their own source, and the file provider always passes `teams=1`.

Every mail SSE event invalidates search, and so does every Drive event that can change an indexed name: created, uploaded, deleted, renamed, trashed and restored. A move does not, because it changes neither the name nor the body. The content reindex emits no event: search is a live query over an eventually consistent index, so a push would buy nothing.

## Comment threads have their own index

Each container's `comments.db` carries `comments_fts`, served by the collab comments route rather than by `/search`. The find bar's palette section reads it ([IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md#comment-threads-are-searched-on-the-server)). What it indexes is in [COMMENTS.md](COMMENTS.md#search-reads-a-recomputed-tail-of-each-thread).

## See also

- [ROADMAP.md](ROADMAP.md): calendar search, full chat history, items shared into the home
- [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md): the Worker, its deadlines and the background quota
- [PREVIEWS.md](PREVIEWS.md): the vCard job the `.vcf` extract reuses
- [HELP-CENTER.md](HELP-CENTER.md): the palette's help search, which runs on the client
