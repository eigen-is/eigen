# Proposal: Off-thread Document Transforms

> **Status:** Proposed
> **Date:** 2026-08-03
> **Scope:** Server-side preview generation first, then reuse for document exports and imports

## Summary

Move CPU-heavy document transforms from the Bun main thread into bounded, one-shot Bun Workers. Keep request
authentication, Drive/Mount access, cache coordination, storage I/O, and live collaborative-document mutation on the
main thread. Transfer only clone-safe primitives and `ArrayBuffer`s.

The first implementation should target eigensheets preview generation because it currently combines every expensive
stage in one request-thread call:

```
load Yjs state -> parse snapshot -> replay ops -> recalculate -> resolve conditional formatting
    -> render HTML -> sanitize HTML
```

The same worker runner and message protocol can then execute sheet HTML/XLSX export, the HTML stage of PDF export,
and XLSX import parsing/recalculation. Eigendoc and eigenslides transforms can adopt it afterward.

The recommended execution model is:

- one persistent in-process runner;
- one-shot Bun Workers that are terminated after each job;
- one active document worker by default, configurable after measurement;
- a bounded, priority-aware queue;
- no fallback to main-thread execution when a worker fails;
- compressed Yjs database blobs as the preview/export handoff, not materialized `Sheet[]` or `Y.Doc` objects.

One-shot workers match the existing thumbnail worker model and reclaim ExcelJS, Yjs, DOM, and formula-engine heaps
after large jobs. A warm pool can be reconsidered only if measured startup cost becomes significant.

## Problem

An `async` function still runs JavaScript on Bun's main event loop. Awaiting preview generation prevents only the
calling function from progressing; it does not move Yjs reconstruction, formula evaluation, HTML rendering, or
sanitization to another thread.

This is especially visible for eigensheets. `generateEigensheetsPreview()` runs the whole pipeline on the request
thread. `readSheetsContent()`:

1. synchronously reads persisted Yjs snapshots and updates from SQLite;
2. decompresses and applies those updates into a `Y.Doc`;
3. parses the sheet snapshot;
4. replays pending operation batches;
5. may recalculate the full workbook.

`renderSheetsHtml()` then builds a formula engine and conditional-format resolver over all sheets and renders the
first sheet, and the preview generator sanitizes the result.

The stale-while-revalidate preview cache improves response latency after the first cached version, but background
regeneration still runs on the main thread and can pause unrelated API, WebSocket, SSE, mail, and sync work.

The current preview cap is also incomplete. Sheets are limited to the first worksheet, but that worksheet can still
contain millions of cells and produce an enormous JSON/HTML response. Off-thread rendering protects the event loop
from the transform, but not from cloning, caching, and sending an unbounded result. The sheet preview itself therefore
also needs a row/column/cell budget.

Exports and imports contain the same classes of work:

| Operation | Main-thread CPU today |
|-----------|-----------------------|
| Sheet preview | Yjs reconstruction, op replay, optional recalc, conditional formatting, HTML, sanitization |
| Sheet HTML export | Same materialization path, full-workbook HTML, sanitization |
| Sheet PDF export | Same HTML path; WeasyPrint is already an external subprocess |
| Sheet XLSX export | Same materialization path, ExcelJS workbook construction and ZIP compression |
| XLSX import | ZIP guards, ExcelJS parsing, mapping, engine recalc, snapshot serialization |
| Eigendoc preview/export | Yjs reconstruction, ProseMirror conversion, lowlight, static HTML, sanitization |
| DOCX import/export | OOXML parsing or generation plus ZIP work |
| Slides preview/export | Yjs reconstruction, deck conversion, HTML, sanitization |

Image and video thumbnail generation is already off-thread through `thumbnail-worker.ts`; it should remain separate.

## Goals

- Keep the API event loop responsive while a heavy preview, export, or import runs.
- Reuse one execution mechanism and one typed protocol across preview, export, and import.
- Move the complete sheet reconstruction pipeline off-thread, not only the final HTML renderer.
- Preserve current HTTP routes, response bodies, filenames, cache behavior, and persisted-document semantics.
- Bound CPU concurrency, queued work, preview output size, execution time, and retained memory.
- Preserve the XLSX guards: the decompressed-size guards that run before ExcelJS materializes a workbook, and the
  cell-count guard that today runs only after `workbook.xlsx.load()`.
- Keep worker failures isolated from cache writes and live Yjs mutation.
- Make queueing, main-thread preparation time, worker time, and failures observable.

## Non-goals

- A durable distributed job queue.
- An asynchronous export UI with polling or notifications.
- Moving Drive ACL checks or Mount ownership into workers.
- Replacing the existing thumbnail worker.
- Exporting unpersisted live editor state. Transforms continue to use the last persisted collaborative state.
- Making imports fully atomic across Yjs state and extracted media; this proposal preserves the current contract.
- Moving WeasyPrint into a Worker. It is already off-process and non-blocking from JavaScript's perspective.

## Proposed Architecture

### Main-thread and worker boundary

The boundary should be below document materialization and above storage ownership:

```
Main thread
  route authorization / ACL
  preview cache lookup and in-flight deduplication
  Mount resolves data.db and makes its local ManagedDatabase available
  short SQLite transaction captures compressed Yjs blobs
  storage reads prepare media buffers or preview URLs where needed
  runner admits a bounded job
                    |
                    | transferable ArrayBuffers + plain metadata
                    v
One-shot document Worker
  decompress and apply Yjs state
  convert Yjs roots to document data
  parse sheet snapshot and replay ops
  recalculate when required
  render / sanitize / convert / serialize
                    |
                    | transferable ArrayBuffer or bounded string result
                    v
Main thread
  preview cache write and response
  export headers and response
  or import commit into the live Y.Doc plus media writes
```

Workers must never receive `Mount`, `ManagedDatabase`, `DrivePath`, `StorageFile`, `Y.Doc`, schema instances,
callbacks, or class instances. Those objects either own process-local resources or are expensive/non-deterministic to
structured-clone.

### Capture compressed Yjs state

`loadYjsState()` currently combines two responsibilities:

- selecting the latest snapshot and subsequent updates from SQLite;
- decompressing and applying those blobs to a `Y.Doc`.

Split it into reusable parts:

1. `readYjsStatePayload(managedDb)` selects the latest compressed snapshot and the required subsequent compressed
   updates. Today's transaction in `replayYjsState()` is not short — it wraps zstd decompression and `Y.applyUpdate`
   for every row; the capture transaction keeps only the SELECTs and buffer copies, which shrinks main-thread
   blocking on its own. It returns standalone byte buffers plus update IDs used for diagnostics.
2. `materializeYjsState(payload)` decompresses and applies the payload to a new `Y.Doc`.
3. Existing `loadYjsState()` composes those functions for callers that still need main-thread materialization.
4. The document Worker calls `materializeYjsState()` and then the existing document-specific conversion code.

The selected blobs must be copied into standalone `ArrayBuffer`s before transfer. The Worker receives ownership via
the `postMessage` transfer list, avoiding a second structured-clone copy.

Capture always selects the newest snapshot plus the updates with `id > snapshot.lastUpdateId`. Today's loader has one
branch capture cannot replicate: when the snapshot blob fails to decompress, it re-selects **all** updates. The two
are equivalent only because the snapshot flush deletes every update with `id <= lastUpdateId` in the same transaction
that inserts the snapshot (`collabDocument.ts`), so "all updates" is always exactly the captured set. State this
pruning invariant in a comment next to `readYjsStatePayload()` and pin it with a corrupt-snapshot Worker test.

This boundary is preferable to sending `Sheet[]` because sending materialized sheets would leave Yjs decompression,
snapshot parsing, operation replay, and optional recalculation on the main thread. It would also clone the largest
in-memory representation in the pipeline.

It is also preferable initially to passing the live SQLite path to a Worker. A direct path requires a read lease that
prevents `ManagedDatabase.close()`, remote temp cleanup, restore eviction, and database replacement while a Worker has
another SQLite connection open. Compressed blob capture avoids that lifecycle expansion. If instrumentation shows the
short SQLite capture itself exceeds the event-loop budget, a read-lease API can be proposed separately.

Corruption behavior must remain unchanged: live reads log and skip corrupt blobs, while snapshot restore remains
fail-loud. Worker results should return skipped-blob warnings so the main thread can emit the same diagnostics.

### Worker protocol

Use a closed discriminated union shared by the runner and Worker. Do not send arbitrary module names or function
names across the boundary.

Conceptually:

```ts
type DocumentTransformRequest =
    | { kind: 'preview'; documentType: EigenDocumentType; source: YjsStatePayload; media: PreviewMedia[] }
    | { kind: 'export'; documentType: EigenDocumentType; format: ExportFormat; source: YjsStatePayload; media: ExportMedia[] }
    | { kind: 'import'; sourceFormat: 'xlsx' | 'docx'; targetType: 'eigensheets' | 'eigendoc'; data: ArrayBuffer };

type DocumentTransformResponse =
    | { ok: true; result: PreviewResult | ExportWorkerResult | ImportCommitPayload; warnings: TransformWarning[] }
    | { ok: false; error: TransformError };
```

The actual union should narrow fields by document type and format so impossible combinations do not compile.

`TransformError` should contain a small stable code, an HTTP status where relevant, and a safe message. Do not try to
structured-clone `ApiError` or native `Error` instances. XLSX `400` and `413` behavior must survive the boundary;
unexpected Worker failures map to a server error.

Large binary inputs and outputs use `ArrayBuffer` transfer lists:

- compressed Yjs blobs;
- uploaded XLSX/DOCX bytes;
- media bytes;
- generated XLSX/DOCX files;
- UTF-8 snapshot JSON where returning an object graph would be expensive.

Preview HTML may remain a string after the new preview budget makes it small. Full HTML exports should preferably be
returned as UTF-8 `ArrayBuffer`s so the main thread can send them without a large string clone.

### Runner and Worker lifetime

Add one process-wide document-transform runner. It owns admission and Worker lifecycle but no document logic. It is
deliberately named "runner", not "scheduler" — `lib/scheduler/` already owns periodic jobs. The closest existing
shape to stay consistent with is `ContentReindexQueue` (`lib/mount/content-reindex-queue.ts`): self-scheduled drain,
bounded `close()`.

Recommended initial policy:

| Setting | Initial value | Reason |
|---------|---------------|--------|
| Active document Workers | 1 | Prevent concurrent ExcelJS/Yjs heaps from exhausting small self-hosted servers |
| Queue length | 16 descriptors | Bound work and make overload explicit |
| Worker lifetime | One job | Reclaim large JS/native heaps and isolate module state |
| Preview transform deadline | 30 seconds | A preview should fail rather than monopolize the host |
| Export/import transform deadline | 120 seconds | Heavy but user-requested work; PDF subprocess keeps its existing deadline |

Concurrency may later be configurable from 1 to a small hard maximum after memory benchmarks. It should not default
to CPU count: a legal XLSX can consume much more memory than a typical request, so cores are not the limiting resource.

The queue should have two priorities:

1. Foreground: first preview cache miss, export, import, and conversion.
2. Background: stale preview regeneration and, if adopted later, search reindexing.

FIFO applies within a priority. Background work starts only when no foreground job is waiting. Existing preview
in-flight maps continue to deduplicate identical cache generations before they enter the runner.

Admission must happen before preparing large media or import payloads where practical. The queue should hold small job
descriptors or preparation closures, not sixteen detached workbooks. Import routes retain the current compressed upload
size check; a later streaming change could spool accepted uploads to a temp file before Worker admission.

Admission is bounded by predicted wait, not only queue length. These routes stay synchronous, so a queued request
holds its HTTP connection open; with one active Worker and 120-second deadlines, the last job in a full queue of
sixteen could wait roughly half an hour, which looks like a hung server. Reject new foreground work with `503` when
the queue is full or when the summed deadlines of active plus queued foreground jobs exceed 120 seconds. The `503`
body must be a short human-readable message ("The server is busy, please try again in a moment") because
`useExportDocument` shows the raw response text in its error toast. `Retry-After` may be set for API callers, but
browsers ignore it on `fetch()`, so no client behavior may depend on it. Stale preview regeneration can be dropped
because a later request can enqueue it again. Never silently run the transform on the main thread as an overload
fallback; that would reintroduce the server-wide freeze this proposal is intended to remove.

Each Worker is terminated after success, structured failure, timeout, cancellation, or `onerror`. A timed-out or
crashed Worker leaves no preview cache file and no import mutation. The runner starts the next queued job in a new
Worker.

### Preview output budget

Off-thread work is not sufficient if a Worker returns hundreds of megabytes of HTML for the main thread to cache,
JSON-encode, and send.

Keep the existing document caps and add a sheet budget:

| Type | Preview budget |
|------|----------------|
| Eigendoc | First 20 top-level blocks |
| Eigenslides | First 8 slides |
| Eigensheets | First sheet, at most 200 rows by 50 columns and 10,000 rendered cells |

The exact sheet dimensions should be confirmed against real fixtures before implementation, but the result must have
a hard cell budget. At the default dimensions the cell budget never binds (200 × 50 = 10,000); it is an independent
ceiling so tuning rows or columns against fixtures cannot silently remove the bound. Render from the top-left of the used range and append the existing truncated marker whenever rows,
columns, cells, or additional sheets are omitted. The renderer may still construct a cross-sheet resolver so
conditional-format formula references remain correct for displayed cells.

Add a final preview-result byte guard as defense in depth. Exceeding it must produce a small, valid truncated preview
or a controlled preview failure, never a partially sliced HTML string.

Changing the preview budget or Worker renderer output requires bumping the text-preview format version so existing
cache entries regenerate.

## Operation Flows

### Eigensheets preview

1. `getOrCacheText()` retains cache lookup, stale-while-revalidate, and in-flight deduplication.
2. On generation, the main thread resolves `data.db`, opens/reuses its `ManagedDatabase`, and captures compressed Yjs
   blobs.
3. The runner transfers those blobs to a Worker.
4. The Worker reconstructs Yjs, reads snapshot/ops, replays, conditionally recalculates, renders the bounded first-sheet
   view, sanitizes it, and returns the body.
5. The main thread writes the existing `{ body, mode }` cache envelope and responds as it does today.

No sheet object graph crosses the Worker boundary.

The Worker preserves `readSheetsContent()`'s recalc fallback: when recalculation throws, it serves the replayed
values and returns a warning instead of a failure — a preview or export must never fail because recalc hiccuped.

### Sheet exports

The same Yjs source payload drives every format:

| Format | Worker work | Main-thread work |
|--------|-------------|------------------|
| HTML | Materialize, recalc, full render, sanitize, wrap, UTF-8 encode | Headers and response |
| PDF | Materialize, recalc, full render, sanitize, wrap | Spawn/await existing WeasyPrint subprocess, headers and response |
| XLSX | Materialize, recalc, ExcelJS construction and ZIP generation | Headers and response |

PDF layout is already outside the main process. Only its blocking HTML preparation moves to the Worker.

### XLSX import and conversion

1. Main thread performs ACL and compressed upload size checks.
2. The accepted upload `ArrayBuffer` transfers to the Worker.
3. The Worker performs existing declared-size and streamed actual-size ZIP guards before ExcelJS load.
4. The Worker parses XLSX, maps it to sheets, recalculates, removes dense `data`, and serializes the lean snapshot.
5. The Worker returns UTF-8 snapshot JSON as an `ArrayBuffer` plus warnings.
6. The main thread converts the buffer to a string without parsing it.
7. The main thread commits the trusted Worker snapshot to the live collaborative `Y.Doc` in one transaction.

The transaction clears pending ops exactly as `writeSheetsToYjs()` does today.

The Drive conversion route (`/convert/:targetType`) currently has no input bound of its own — it reads an
already-stored file whose size was only limited at upload time. Give it the same explicit size check before buffering
the stored file.

Add a `writeSheetsSnapshotToYjs(doc, snapshotJson)` helper for this commit. `writeSheetsToYjs()` can compose it after
`JSON.stringify(sheets)`, while the import path uses it directly. This avoids parsing a huge `Sheet[]` and immediately
serializing it again on the main thread.

The destination document must not be created or mutated before the Worker succeeds. Worker failure therefore leaves
the source and target unchanged. The final Yjs transaction remains on the main thread and should be timed separately;
if it is itself too slow, a later phase can return a Yjs update, but applying a large update to the live doc will always
have some main-thread cost.

### Eigendoc and eigenslides

After the sheet path is proven, reuse the same source payload and runner:

- Preview Workers reconstruct Yjs, convert roots to ProseMirror/deck data, apply current compact caps, render, and
  sanitize. Preview media is passed as a plain name-to-URL map prepared from Mount metadata.
- HTML export Workers render and sanitize the full document. Main-thread storage I/O resolves media; exact media
  buffers can be transferred so base64 encoding happens in the Worker.
- DOCX export can run `@turbodocx/html-to-docx` in the Worker after HTML generation. Its package remains externalized
  and available from runtime `node_modules` as it is today.
- DOCX import parsing, ProseMirror-to-Yjs conversion, and image extraction run in the Worker. The main thread applies
  the returned Yjs update to the live document and writes extracted images through Mount.
- Slides PDF keeps WeasyPrint on the main-thread orchestration side after Worker HTML generation.

Do not make a document Worker spawn thumbnail Workers. Media preparation stays in the main-thread orchestrator and
continues using the existing globally capped thumbnail path.

### Search extraction

Sheet search currently calls `readSheetsContent()` and can block the event loop even though reindexing is background
work. Once preview/export/import are stable, search can use a low-priority `extract-text` Worker operation over the same
Yjs payload. It is explicitly outside the first rollout. The durable `contentDirty` flag must only clear after a
successful Worker result.

## Import Commit Boundary

Import Workers perform pure conversion only. They must not know owner IDs, mount IDs, ACLs, destination paths, or live
collaboration providers.

The main thread remains responsible for:

- rechecking that the destination still exists and is writable before commit;
- applying a trusted snapshot string or Yjs update to the current live `Y.Doc`;
- creating destination documents for Drive conversion only after successful parsing;
- storing extracted DOCX media;
- broadcasting the existing collaboration/Drive events;
- mapping safe Worker errors to API responses.

This keeps a Worker crash from leaving a partially parsed document in shared state.

## Cancellation and Shutdown

- A queued job whose request is aborted should be removed before payload preparation.
- A foreground export/import Worker whose request disconnects may be terminated because its result has no cache value.
- A preview regeneration may finish after disconnect because its result populates a content-addressed cache entry.
- Server shutdown stops admission, rejects queued work, waits a short grace period for active work, then terminates the
  Worker. Mount/database shutdown begins after document jobs release their main-thread preparation references.

Because the initial design transfers captured blobs rather than a live database path, active Workers do not hold Mount
or `ManagedDatabase` leases during shutdown.

## Failure and Security Rules

- Never fall back to the main thread after Worker timeout, crash, queue overflow, or module-load failure.
- Keep current import size, decompressed-byte, and cell-count limits. Off-thread execution is not a reason to weaken
  them. Note the cell-count limit only fires after ExcelJS has materialized the workbook, so a legal file inside the
  size guards can still build a multi-gigabyte heap first — a core reason concurrency stays at one, Workers are
  one-shot, and the child-process executor remains the escape hatch.
- Worker messages are internal discriminated unions; user input cannot select a module or filesystem path.
- Sanitize preview/export HTML inside the Worker before returning it. Previews and exports use different sanitizer
  configurations and need separate parity tests: previews call DOMPurify with only `FORCE_BODY: true`, while exports
  go through `sanitizeExportHtml()` — the call-scoped `restrictToDataRefs` SSRF hook plus per-surface options
  (`ADD_ATTR: ['target']` for sheets HTML, `ADD_DATA_URI_TAGS: ['img']` for docs). The hook is added and removed
  around each call, so one-shot Worker module state keeps it correct.
- Do not log document content, upload bytes, rendered HTML, or media data. Log operation type, document type, format,
  sizes, timings, and an internal job ID.
- Bun Workers isolate the event loop, not the process address space. A native or whole-process OOM can still take down
  the API. One-shot lifetime, concurrency one, XLSX guards, queue bounds, and output bounds remain mandatory.
- If adversarial import memory remains unacceptable after measurement, run import transforms in a child-process
  executor using the same logical protocol. That is stronger isolation but not required for the preview-first phase.

## Build and Deployment

Add the document Worker as an explicit `bun build --splitting` entry next to `src/index.ts` and
`thumbnail-worker.ts`. Spawn it through `new Worker(new URL(..., import.meta.url).href)` so source development and the
Docker build use the same path pattern.

Use dynamic imports inside the Worker operation switch for large format-specific modules such as ExcelJS and
Turbodocx. A sheet preview should not evaluate DOCX code, and a document preview should not load ExcelJS.

Externalized dependencies remain installed in runtime `node_modules`. Note the Docker container currently executes
the TypeScript source directly (`docker/api/Dockerfile` runs `bun run src/index.ts`); the `buildfordocker` output is
copied into the image but is not the entrypoint. Before writing the production check, confirm which artifact
production actually executes and point the Worker smoke tests at that artifact — running them against both source and
the built output is cheap insurance either way. The production check must verify at least one operation that loads
each externalized family from the Worker, rather than only checking that the Worker file exists.

## Observability

Record these fields for every job:

- job ID, kind, document type, and format;
- foreground/background priority;
- queue depth and queue wait time;
- main-thread source-capture and media-preparation time;
- transferred input bytes;
- Worker startup, transform, and total time;
- output bytes;
- outcome: success, controlled document error, timeout, crash, cancellation, or overload;
- skipped corrupt Yjs blobs;
- Worker termination/restart count.

Add an event-loop delay probe to the benchmark harness. A fast Worker time with a multi-second source-capture pause is
not a successful offload; preparation and commit times need their own measurements.

## Rollout Plan

### Phase 0: Fixtures and baseline

- Add a representative heavy sheet fixture with formulas, conditional formatting, multiple sheets, and a long op
  history.
- Record current end-to-end preview time, longest event-loop delay, health-route latency, peak RSS, generated HTML
  size, and cache size.
- Add golden output assertions before refactoring the Yjs loader or renderer.

### Phase 1: Shared runner and sheet preview

- Split Yjs blob capture from materialization while preserving existing `loadYjsState()` behavior.
- Add the typed protocol, bounded runner, one-shot Worker, timeout handling, and build entry.
- Move full eigensheets preview materialization/rendering/sanitization into the Worker.
- Add the sheet row/column/cell budget and final output-size guard.
- Keep current preview cache, stale-while-revalidate, and in-flight maps.
- Bump the preview cache format version.

This phase directly fixes the reported server freeze and proves the boundary with the highest-value operation.

### Phase 2: Sheet exports and imports

- Move sheet HTML generation and XLSX generation into Worker operations.
- Use Worker-generated HTML before the existing WeasyPrint PDF subprocess.
- Move XLSX guards, parsing, mapping, recalc, and snapshot serialization into the Worker.
- Keep the import commit on the main thread and verify it separately for event-loop delay.

### Phase 3: Eigendoc and eigenslides

- Move compact preview materialization/rendering to the Worker.
- Move full HTML generation and sanitization for HTML/PDF exports.
- Move DOCX conversion and parsing where runtime dependency tests pass.
- Have DOCX import return a ready Yjs update plus extracted media, so ProseMirror-to-Yjs conversion also remains in
  the Worker; the main thread only applies the update to the live document and writes media.
- Transfer media buffers/URLs through type-specific payloads while Mount I/O stays on the main thread.

### Phase 4: Secondary work and tuning

- Consider low-priority search extraction.
- Tune concurrency only from measured memory and latency data.
- Consider a recycled warm pool if startup/module evaluation is material and memory remains stable.
- Consider a child-process executor for untrusted imports if thread-level memory isolation is insufficient.

## Validation

### Contract and golden tests

- Direct and Worker sheet previews produce equivalent sanitized HTML for existing fixtures, except for the intentional
  new preview cap/truncated marker.
- HTML, PDF input HTML, XLSX, DOCX, and imported snapshots retain existing output-level assertions and round trips.
- Current content types, filenames, `Content-Disposition`, error statuses, and preview JSON shape do not change.
- Corrupt Yjs snapshot/update behavior matches the current live-read behavior, including the corrupt-snapshot case
  that depends on the update-pruning invariant described in the capture section.
- Recalc failure inside the Worker serves replayed values with a warning; it never fails the preview or export.
- Sanitizer parity is asserted per configuration: the preview config and the export config each get their own suite.
- Existing XLSX decompression-bomb and max-cell tests run through the Worker route, not only the pure parser.

### Runner tests

- At most the configured number of Workers is active.
- Foreground work runs before queued background work; FIFO holds within a priority.
- Queue overflow is deterministic and never invokes document code on the main thread.
- Transferable inputs are detached from the sender and outputs reconstruct correctly.
- Timeout, `onerror`, malformed response, cancellation, and shutdown all terminate the Worker and release the slot.
- A Worker crash during import performs no Yjs mutation.

### Preview cache tests

- First cache miss waits for one Worker result.
- Concurrent misses for the same cache key share one generation.
- A stale cached result returns immediately while one low-priority regeneration is queued.
- A failed regeneration leaves the stale file available and writes no corrupt current-version entry.
- The new sheet budget always emits valid HTML and a truncated marker when content is omitted.

### Responsiveness benchmark

On the checked-in heavy fixture, while a cold sheet preview and a sheet XLSX export run:

- health-route p95 latency remains below 150 ms on the reference development machine;
- p99 event-loop delay remains below 100 ms and no single delay exceeds 250 ms;
- WebSocket ping/SSE delivery continues during the transform;
- output matches the golden result;
- active document transforms never exceed the configured limit;
- cache-hit preview latency does not regress materially.

Absolute transform duration may increase slightly because of Worker startup. Event-loop responsiveness and bounded
memory take priority over fastest single-job completion.

### Memory benchmark

- Repeat a large preview, XLSX export, and XLSX import enough times to expose retained Worker state.
- Verify each one-shot Worker terminates and file descriptors return to baseline.
- Verify post-job RSS stabilizes rather than growing linearly.
- Measure the combined peak of one document Worker plus the existing thumbnail Worker limit during media-heavy export.

## Alternatives Considered

### Yielding with `setImmediate` or chunking loops

This can reduce individual pauses but requires invasive changes throughout Yjs, formula-engine, DOM, ExcelJS, and ZIP
libraries. Third-party synchronous work still blocks. It is not a complete solution.

### Move only `renderSheetsHtml()`

Rejected. `readSheetsContent()` still performs Yjs reconstruction, snapshot parsing, operation replay, and optional
recalculation on the main thread. Sending `Sheet[]` also clones the largest object graph.

### Pass the live SQLite path to the Worker

Potentially useful later, but not the first implementation. It needs an explicit read lease across remote temp files,
database close, restore, and replacement. Capturing compressed blobs keeps the initial lifecycle local and testable.

### Persistent warm Worker pool

Not initially. It improves startup cost but retains large module caches and risks heap growth after ExcelJS/Yjs/DOM
jobs. One-shot Workers match the existing thumbnail pattern. If profiling justifies warmth, recycle a Worker after a
small job count or any memory-heavy operation rather than keeping it indefinitely.

### Child processes for every transform

They provide stronger crash and memory isolation but have higher startup/IPC cost and a larger deployment surface.
Bun Workers are sufficient to solve event-loop blocking. Keep the protocol transport-neutral enough that imports can
move to child processes later if needed, without implementing both transports now.

### Durable asynchronous exports

Useful for very long-running jobs, but it requires job persistence, result storage, polling/notifications, expiry, and
new frontend states. It does not remove the need for off-thread execution and is outside this proposal.

## Expected Code Changes

Likely implementation surface:

```
apps/api/src/lib/document/transform/
  protocol.ts             # Clone-safe request/result unions
  runner.ts               # Bounded queue and one-shot Worker lifecycle
  worker.ts               # Operation dispatch with lazy imports
  collab-source.ts        # Main-thread compressed Yjs payload capture

apps/api/src/lib/collab/yjs-loader.ts
  # Split DB capture from Yjs materialization

apps/api/src/lib/preview/eigensheets-preview.ts
apps/api/src/lib/preview/preview-cache.ts
apps/api/src/lib/export/export-document.ts
apps/api/src/lib/import/import-document.ts
apps/api/src/routes/drive.ts
  # Size check on the conversion route
apps/api/package.json
  # Add Worker build entry
```

Format-specific pure conversion functions should remain in their current `preview/`, `export/`, `import/`, and
`document/` modules. The Worker dynamically imports those functions; the new directory owns execution, not a second
copy of document logic.

After implementation, update [PREVIEWS.md](PREVIEWS.md), [EXPORT.md](EXPORT.md), and relevant testing/deployment docs
with the as-built behavior. PREVIEWS.md has already drifted from the code (the text cache filename now carries the
`f2` format tag, `getCollabPreviewData` was renamed `getCollabPreview`, stale-while-revalidate is undocumented) — fix
that drift in the same pass.

## Decision Points

Recommended decisions for implementation sign-off:

1. **Execution model:** bounded runner plus one-shot Bun Workers.
2. **Initial concurrency:** one active document transform, queue length sixteen, foreground admission additionally
   bounded by predicted wait (120 seconds of summed deadlines).
3. **Source boundary:** compressed persisted Yjs blobs captured in a short main-thread transaction.
4. **First delivery:** eigensheets preview, including a bounded first-sheet view.
5. **Failure policy:** controlled error or stale preview; never main-thread fallback.
6. **Reuse order:** sheet HTML/PDF/XLSX export and XLSX import before docs/slides.
7. **API contract:** keep synchronous preview/export/import routes for this program.

## Definition of Done

- A cold heavy-sheet preview no longer causes server-wide event-loop stalls beyond the benchmark budget.
- The entire sheet materialization and render pipeline runs in the Worker.
- Preview output is bounded even when the first worksheet is extremely large.
- Queue, concurrency, timeout, cancellation, and Worker crash behavior are tested.
- Existing preview/export/import contracts and output-level tests pass.
- The Docker build contains and successfully executes the Worker entry with externalized dependencies.
- `bun run check` passes.
- PREVIEWS/EXPORT documentation reflects the final implementation.
