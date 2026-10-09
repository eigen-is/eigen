# Document Transform Workers

> **TLDR:** Every CPU-heavy document transform runs in a one-shot Bun Worker, a separate thread that serves one job and then exits, behind one bounded runner in `apps/api/src/lib/document/transform/`. The runner queues the jobs and admits a new one only while the predicted wait allows. The transforms are the collab and `.vcf`/`.eml`/`.ics` previews, the HTML, PDF, XLSX and DOCX exports, the xlsx and docx import and convert, and the search extract. The main thread keeps access checks, cache coordination, storage I/O, media prep and the import commit. Only transferred `ArrayBuffer`s and plain data cross. Not obvious from the code: one Worker runs at a time because memory is the limit, a Worker never serves a second job, and overload answers 503 with no main-thread fallback.

The API is one process, and one event loop serves every route, collab socket and event stream in it. Rendering a big sheet or deck holds that loop for seconds and freezes all of them for every user, so the work moves to a Worker thread ([§ `async` does not leave the event loop](#async-does-not-leave-the-event-loop)). A collab job reads the stored Yjs updates from the document's `data.db` ([COLLAB.md](COLLAB.md)), never the live document in memory. Read this doc before you add a transform or change a limit.

## `async` does not leave the event loop

Awaiting a preview only suspends the caller. Yjs materialization, formula recalc, HTML rendering, sanitizing and ExcelJS or zip work still run on the request thread, and they stall every other API, WebSocket, SSE, mail and sync task. On the main thread a cold heavy-sheet preview stalled the event loop for 14.1 s. In the Worker the worst loop delay is 9 ms and the health route's p95 stays at 0.3 ms. Image and video thumbnails have their own Worker (`lib/shared/thumbnail-worker.ts`).

## Every transform takes one main-thread path

`run-transform.ts` is the single main-thread entry for every transform. It checks admission, captures the source, applies the kind's limits, surfaces warnings and maps failures, so a new operation is a thin wrapper plus a pure converter in the Worker. `worker.ts` dispatches on a closed switch over the request union, so nothing in a message can pick a module or a path. It loads each format module lazily, so a doc preview never evaluates the sheet engine or ExcelJS.

A job carries one of two sources (`protocol.ts`). A collab job carries the compressed Yjs blobs `captureCollabSource` copies out of `data.db` in a SELECT-only transaction ([DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md#a-reader-takes-a-ydoc-never-a-mount)). A bytes job, an import or a `.vcf`, `.eml` or `.ics` preview, carries the file's bytes. A bytes preview returns its typed payload as a JSON string.

The callers and what they render are in [PREVIEWS.md](PREVIEWS.md), [EXPORT.md](EXPORT.md) and [SEARCH.md](SEARCH.md).

## Only buffers and plain data cross the boundary

The Worker receives transferred `ArrayBuffer`s (Yjs blobs, upload bytes, file bytes, media buffers) and clone-safe metadata. It never gets a `Mount`, a database, a `Y.Doc`, a storage handle, a callback or a class instance.

Errors come back as a small typed code plus an optional HTTP status, never a cloned `Error`. So an import's 400 and 413 survive the boundary, and a converter that fails to load is a 500, because a broken install is not a bad upload. The runner shape-checks every response (`isValidResponse`), so a half-valid one becomes a structured failure instead of a promise that never settles.

## The Worker graph stays light

A module the Worker imports must never statically reach `preview/preview-cache.ts`. That would drag sharp and the sheet engine into every Worker, and it is why `document/media.ts` (light, both sides) and `export/media.ts` (screen previews, main thread) are separate files. sharp itself loads lazily, only for a docx with an SVG to draw its PNG fallback from.

Inside the Worker graph `ApiError` comes from `core/errors`, never the `core` barrel. The barrel pulls auth, the home relay and ExifTool into the Worker bundle: 10.3 MB against 4.7 MB. `buildfordocker` (`apps/api/package.json`) bundles each Worker entry, and that bundle is how purity is checked. Production runs `src/index.ts` directly, and ExcelJS, JSZip and mammoth stay external in `node_modules`.

## A capture is always the whole document

The snapshot flush deletes every update with `id <= lastUpdateId` in the same transaction that inserts the snapshot (`collab/collabDocument.ts`). So the newest snapshot plus the newer updates is the complete state, and the capture reads nothing else. A blob that fails to decode is skipped with a `corrupt-blobs-skipped` warning, as on a live load.

## One Worker runs at a time

Memory is the limit, not cores: one ExcelJS or Yjs heap exists at a time. A Bun Worker isolates the event loop, not the address space, so a native out-of-memory still takes the API down. The sheet cell cap fires only after ExcelJS has loaded the workbook ([EXPORT.md](EXPORT.md#zip-guards-run-before-the-parser-inflates-anything)). So concurrency 1, the one-shot lifetime, the zip guards and the output byte guards are all load-bearing.

## Admission is bounded by predicted wait

The queue holds 16 jobs at two priorities. Foreground is a user waiting. Background is the search extract and a stale preview's regeneration. A queued request holds its HTTP connection open, so foreground admission is capped by predicted wait, the summed admission costs of the queued and active jobs (at most 120 s), not by queue length alone. Background work may hold at most 8 of the 16 slots, so a mass reindex can't starve users. A dropped background job is safe: the next preview request enqueues it again, and so does the `contentDirty` bit, the flag on a `paths` row that marks its body for the search reindex ([SEARCH.md](SEARCH.md)).

`TRANSFORM_LIMITS` (`runner.ts`) gives each kind a kill deadline and an admission cost. The deadline bounds a runaway. The main-thread prep a caller reports as `prepMs` spends from it for every kind, so a preview's media lookup shortens its deadline as an export's media does, and a job whose prep spent it all times out without spawning a Worker. The cost is what a job is expected to take from the queue. It is keyed by kind, not document type, so the bytes previews run under the same `preview` row as the collab ones.

Admission is checked before the expensive preparation: the Yjs capture, export media, upload copies, the convert source read. A refused job pays for nothing. It gets a readable 503 ("The server is busy…"), which `useExportDocument` shows verbatim.

Costs under-predict a slow job. If every admitted job runs to its deadline, a foreground connection can wait 8 to 10 minutes, but it still ends in a result or an error, never a hang. A queued job holds its full payload rather than a closure that prepares it at start. That is bounded in practice, and the refactor waits for a trigger in [ROADMAP-POST-1.md](ROADMAP-POST-1.md).

## A Worker serves one job, then dies

The runner terminates the Worker after every outcome: success, structured failure, deadline, crash, cancellation, shutdown. `gracefulShutdown` closes the runner before the mount teardown, so no result races it.

The measurements behind the choice: a spawn costs 2 to 4 ms, and the real cost is module evaluation, 0.3 to 0.8 s per job. A terminated heavy Worker leaves 5 to 7 MB of RSS behind, where a reused one stays flat. But a warm Worker running mixed jobs turned a sheets preview followed by a slides preview into a 127 s render and 10.6 GB of extra RSS, suspected to be shared isomorphic-dompurify jsdom state. A one-shot Worker can't reach that state, and a warm pool has to rule it out first.

## A failure never falls back to the main thread

Not after a timeout, a crash, an overload or a module that fails to load. A fallback would bring back the server-wide freeze this layer exists to remove.

- A recalc failure returns the replayed values with a `recalc-failed` warning and never fails the job. Only an export recalcs ([SHEETS.md](SHEETS.md#the-editor-computes-on-write-the-server-only-what-nobody-computed)).
- Sanitizing runs inside the Worker. Every HTML preview and export body goes through `sanitizeExportHtml` ([EXPORT.md](EXPORT.md#the-sanitizer-keeps-only-data-references-because-a-browser-fetches), [PREVIEWS.md](PREVIEWS.md#no-preview-body-may-fetch-a-url-the-file-chose)). The `.eml` preview uses the mail reader's DOMPurify config plus hooks of its own that strip every reference but an inlined raster image and every CSS fetch, and it forbids more tags, such as `svg` and `video` (`apps/api/src/lib/preview/eml-preview.ts`).
- The import commit stays on the main thread ([EXPORT.md](EXPORT.md#an-import-writes-nothing-until-the-worker-succeeds)).

## The runner logs one line per job, overload included

Each job logs its kind, type, format, priority, queue depth and wait, the main-thread capture and media-prep time, startup, transform and total time, input and output bytes, the outcome and its warning codes. The main-thread times are there because a fast Worker behind slow preparation is not a successful offload. A refused admission logs its reason and the queue state. No line carries document content, upload bytes or HTML.

`apps/api/src/test/transform-benchmark.ts` measures latency, event-loop delay, health-route latency and RSS on heavy fixtures. It is not a test: run it from `apps/api` with `bun src/test/transform-benchmark.ts [--memory]`. Its gates are a health p95 under 150 ms, a loop p99 under 100 ms and no single delay over 250 ms. Output bytes are pinned by the goldens in `src/test/document/document-transform.test.ts`, and runner behavior in `document-transform-runner.test.ts`.

## See also

- [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md): the readers the Worker runs
- [PREVIEWS.md](PREVIEWS.md), [EXPORT.md](EXPORT.md), [SEARCH.md](SEARCH.md): what each operation renders
