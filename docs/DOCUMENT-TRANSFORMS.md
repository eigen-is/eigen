# Document Transforms

> **TLDR:** Every CPU-heavy document transform runs in a one-shot child process, a separate Bun process that serves one job under a memory limit and is then killed, behind one bounded runner in `apps/api/src/lib/document/transform/`. The runner queues the jobs and admits a new one only while the predicted wait allows. The transforms are the collab and `.vcf`/`.eml`/`.ics` previews, the HTML, PDF, XLSX, DOCX and PPTX exports, the xlsx, docx and pptx import and convert, and the search extract. The main thread keeps access checks, cache coordination, storage I/O, media prep and the import commit. Only buffers and plain data cross, as copies.

The API is one process, and one event loop serves every route, collab socket and event stream in it. Rendering a big sheet or deck holds that loop for seconds and freezes all of them for every user, so the work moves off it ([§ `async` does not leave the event loop](#async-does-not-leave-the-event-loop)). It moves into a process rather than a thread because a heap that runs out of memory takes its whole process down ([§ A transform runs in a child process](#a-transform-runs-in-a-child-process-because-an-out-of-memory-aborts-its-process)). A collab job reads the stored Yjs updates from the document's `data.db` ([COLLAB.md](COLLAB.md)), never the live document in memory. Read this doc before you add a transform or change a limit.

Not obvious from the code: one child runs at a time because memory is the limit, a child never serves a second job, a death after the child took its job is that job running out of memory, and overload answers 503 with no main-thread fallback.

## `async` does not leave the event loop

Awaiting a preview only suspends the caller. Yjs materialization, formula recalc, HTML rendering, sanitizing, xlsx and docx reading and writing, and zip work still run on the request thread, and they stall every other API, WebSocket, SSE, mail and sync task. On the main thread a cold heavy-sheet preview stalled the event loop for 14.1 s. In the child the same preview's worst loop delay is 30 ms. Image and video thumbnails have their own Worker thread (`lib/shared/thumbnail-worker.ts`).

## Every transform takes one main-thread path

`run-transform.ts` is the single main-thread entry for every transform. It checks admission, captures the source, applies the kind's limits, surfaces warnings and maps failures, so a new operation is a thin wrapper plus a pure converter in the child. `child.ts` dispatches on a closed switch over the request union, so nothing in a message can pick a module or a path. It loads each format module lazily, so a doc preview never evaluates the sheet engine or ExcelJS.

A job carries one of two sources (`protocol.ts`). A collab job carries the compressed Yjs blobs `captureCollabSource` copies out of `data.db` in a SELECT-only transaction ([DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md#a-reader-takes-a-ydoc-never-a-mount)). A bytes job, an import or a `.vcf`, `.eml` or `.ics` preview, carries the file's bytes. A bytes preview returns its typed payload as a JSON string. The child reads no config, so a job carries what it needs: a docx import the public origin, a pptx import (`SlidesImportJob`) the upload cap as its pictures' byte budget and, for Import slides…, the open deck's frame to fit the slides into, read on the main thread from the deck's `meta`. A Convert passes none, so the reader picks the slide size nearest the file's and writes it into the update's `meta`. A document import hands its counted warnings back to its caller with the update, because a pptx import answers with a summary of them ([EXPORT.md](EXPORT.md#a-pptx-import-adds-slides-and-leaves-a-box-where-it-cant-draw)).

The callers and what they render are in [PREVIEWS.md](PREVIEWS.md), [EXPORT.md](EXPORT.md) and [SEARCH.md](SEARCH.md).

## A transform runs in a child process, because an out-of-memory aborts its process

When JSC cannot allocate an object, an array or a string it often aborts or faults the whole process. An `ArrayBuffer`, a string past its maximum length and, at some limits, an object fail with a catchable `RangeError: Out of memory` instead. A Bun Worker is a thread of the API's process and Bun gives it no heap limit of its own, so a document too big for memory killed the API with it: reproduced in `oven/bun:1.4.2-slim`, the production base image. A child process dies alone, and the API answers the job.

The runner spawns `process.execPath` on `child.ts` with Bun's IPC channel (`serialization: 'advanced'`, so `ArrayBuffer`s and `Map`s arrive as themselves) and the child's stdout and stderr inherited, so its logs land in the API's. The child gets a minimal environment, what its graph reads: `PATH`, `TMPDIR`, `NODE_ENV` and `EIGEN_DATA_ROOT` (the `.eml` preview's mail imports resolve the server's data folder when they load), the parent's time zone as `TZ` (`bun test` runs in UTC without setting `TZ`, and a date import must read as it does on the main thread), and the JIT knob of [§ A child runs under the machine's memory](#a-child-runs-under-the-machines-memory).

## A child runs under the machine's memory

On Linux the child starts through `sh -c` with three limits before it `exec`s Bun (`runner.ts`):

- `oom_score_adj` 1000: when the host runs out first, the kernel's OOM killer picks the child, never the API.
- `ulimit -d`, the data segment, at the machine's memory: `process.constrainedMemory()`, which Bun answers with the container's cgroup limit where there is one and the host's memory otherwise. A child may never claim more than the machine has, so a job too big for it is refused early and the same way every time, before it squeezes the host. A refused `ulimit -d` runs the child unbounded with a warning on stderr, never an outage.
- `ulimit -St`, a soft CPU limit at the job's deadline times the cores plus a minute, so an orphan that spins in a loop dies too. GC and JIT threads spend CPU on every core beside the job's own, 1.4 to 5.5 times the wall time measured, so a limit of the deadline alone would end a busy job before its deadline. It is soft so the orphan ends by SIGXCPU, a crash: dash's `ulimit -t` sets the hard limit too, whose SIGKILL would read as out of memory.

A core dump is off: an abort is an expected way for a child to die. macOS refuses `setrlimit` for the data segment, so on a dev Mac the child runs with no wrapper and no limit; it still isolates an abort from the API.

**The data limit is not the heap.** Bun sizes its reservations to the limit, so a child can use well under the limit. `BUN_JSC_jitMemoryReservationSize=67108864` shrinks the JIT's 512 MB reservation and hands about 0.33 GB back to the heap, with no slowdown measured. What a child can use, measured with `oven/bun:1.4.2-slim` in Docker with `--memory` (amd64 runs under Rosetta), and the heaviest legitimate jobs through the real runner:

| Arch | Machine | Usable, objects | Usable, `ArrayBuffer`s | docx bug65649 import | 1M-cell xlsx import | 1M-cell xlsx export |
|---|---|---|---|---|---|---|
| arm64 | 4 GiB | 1.72 GB | 1.58 GB | 0.54 GB | 1.71 GB | refused at 1.64 GB |
| arm64 | 7.65 GiB | 3.32 GB | 3.02 GB | 0.53 GB | 1.71 GB | 1.79 GB |
| amd64 | 4 GiB | 2.52 GB | 1.44 GB | 0.54 GB | 1.74 GB | 1.92 GB |
| amd64 | 7.65 GiB | 5.39 GB | 2.87 GB | 0.61 GB | 1.63 GB | 1.81 GB |

The 1M-cell import is a workbook of 10,000 rows of 100 mixed cells (shared strings, dates, numbers, booleans, formulas and styles), read under the child's limits. So on a 4 GB arm64 host a 1M-cell xlsx export is refused while the 1M-cell import still fits. At 512 MiB Bun cannot start on x86-64 at all, so a test that dials the limit down stays at 1 GiB. **The usable share depends on the Bun version and the arch: re-measure it on every Bun bump**, with the Linux-only suite of `document-transform-runner.test.ts` and the jobs of the table, and correct the table and the help center's memory advice.

## A package's parts have a parse budget before the memory limit

The memory limit refuses a file only once the parse has spent it, seconds in, and an OOXML part compresses a hundredfold: a 1 MB upload can hold a `[Content_Types].xml` that inflates to 180 MB. So `openPackage` (`apps/api/src/lib/core/opc.ts`) charges every part it parses whole against one budget per package, `[Content_Types].xml` and the relationships parts included: the part's declared size against `MAX_PACKAGE_XML_BYTES` (32 MiB) before it inflates, and its tags against `MAX_PACKAGE_XML_TAGS` (1,500,000) before it parses. A part past the budget refuses the whole file, a 413 in the format's words. One pair of limits serves every format: the docx, xlsx and pptx corpora's most is 15.5 MB and 611,000 tags, under half. The xlsx sheet grid and shared strings are parsed in batches outside this budget, under the xlsx import's own caps, and a sheet's part past its grid under a budget of the same values ([EXPORT.md](EXPORT.md#zip-guards-run-before-the-parser-inflates-anything)). The memory limit stays the backstop past both.

## Out of memory is the job's, not the server's

The child acknowledges a job the moment it arrives. How it ends decides the outcome (`childOutcome` in `runner.ts`):

| End | Outcome |
|---|---|
| A reply | the child's response; a caught `RangeError: Out of memory` is `out-of-memory` (`toTransformError`) |
| SIGABRT, SIGSEGV, SIGBUS, SIGTRAP or a SIGKILL the runner did not send, after the ack | `out-of-memory`: JSC aborts, faults or traps (x86-64) on a full heap, and the kernel's OOM killer sends SIGKILL |
| The runner's own kill | `timeout`, `canceled` or `shutdown` |
| A death before the ack, any other signal (SIGINT, SIGTERM, SIGXCPU), an exit without a reply, a failed spawn | `crashed` |

A crash stays a 500 because a broken install, a missing entry or a dev's Ctrl-C is not a file too large. `run-transform.ts` answers an import's `out-of-memory` with a 413 in its format's words (`import/messages.ts`: "Document too large", "Spreadsheet too large", "This presentation is too large to import"). A search extract's is a 413 too, which `extract-text.ts` indexes as an empty body, so the document is not extracted again, and out of memory again, on every drain. An export's or a preview's is a 500: it has no upload to blame.

A SIGSEGV or SIGTRAP after the ack is also what a native crash looks like (Bun's XML parser, sharp), so one reads as out of memory too: an import answers it as too large, an extract indexes nothing, and an export or a preview answers 500. The job line logs the signal that ended the child, and a child killed by a signal sends no peak, so its line reads `peakRssBytes=-1`. On such a death Bun prints its crash banner and a `bun.report` link into the API's log: expected, not a bug to report.

A caught out-of-memory must reach the child's top level, so `isOutOfMemory` (`core/errors.ts`) is rethrown by the catches that would turn it into something else: the XML and zip readers (a 400), the imports' error mapping (`importError`, `import/messages.ts`), the docx import's block check (a flattened block), the optional parts of a package (a dropped part), and a Yjs blob (skipped, which would export a truncated document). The other catches a transform reaches may swallow one: an object allocation aborts before any catch sees it, and the vCard, `.eml` and `.ics` previews' 422s, the calendar parser's skipped event and the sheet engine's formula catches hold allocations too small to fail first. Three keep it on purpose: a recalc that runs out of memory, on import or on export, falls back to the parsed or replayed values with a `recalc-failed` warning, as for any recalc failure ([§ A failure never falls back to the main thread](#a-failure-never-falls-back-to-the-main-thread)), and a docx or pptx export's SVG that can't be drawn is left out, a docx keeping its caption.

## Only buffers and plain data cross the boundary

The child receives buffers (Yjs blobs, upload bytes, file bytes, media buffers) and plain metadata. It never gets a `Mount`, a database, a `Y.Doc`, a storage handle, a callback or a class instance.

IPC copies both ways, so the caller keeps its buffers. A view serializes its whole backing buffer, which is why results go through `toTransferableBuffer` and a mail part is copied out of its message before it is sent. The copy serializes and deserializes on the API's event loop: a 200 MB request stalled it 220 ms in one piece in a fresh process and 544 ms in a warm one, a 200 MB reply 164 to 204 ms, 50 MB under 85 ms (Linux arm64, `transform-benchmark.ts`). So the copy's size is bounded where it can be. A source past `MAX_DECOMPRESSED_BYTES` (`core/zip.ts`, 200 MB) is a 413 in its format's words, and never reaches the child: `openZip` would refuse it anyway, and the upload cap allows up to a gigabyte. A convert refuses it before it reads the stored file; `/import` and `/import-from-drive` read the body first, up to the upload cap, and refuse it before the copy. An export's media is held to the same 200 MB ([§ An export's media is prepared inside its job](#an-exports-media-is-prepared-inside-its-job)). A result is bounded by the zip and output caps, which now hold for the API's heap too. At 200 MB the request's stall meets the 250 ms gate in a fresh process and fails it in a warm one (544 ms); a temp file or stdin in place of IPC measured no better.

Errors come back as a small typed code plus an optional HTTP status, never an `Error` instance. So an import's 400 and 413 survive the boundary, and a converter that fails to load is a 500, because a broken install is not a bad upload. The runner shape-checks every response (`isValidResponse`), so a half-valid one becomes a structured failure instead of a promise that never settles.

## The child's graph stays light

A module the child imports must never statically reach `preview/preview-cache.ts`. That would drag sharp and the sheet engine into every child, and it is why `document/media.ts` (light, both sides) and `export/media.ts` (screen previews, main thread) are separate files. sharp itself loads lazily, only for a docx or pptx with an SVG to draw its PNG fallback from, or a docx with a pasted `data:` image to re-encode. MathJax loads lazily too, only for a PDF with an equation in it, in the async pass before the doc's render that draws each equation as SVG, within the budgets [EXPORT.md](EXPORT.md#the-pdf-draws-an-equation-as-the-svg-mathjax-makes-of-it) gives. The docx import loads no sanitizer: its reader parses the XML itself and imports nothing that reaches `export/sanitize.ts`, so an import's child evaluates neither jsdom nor DOMPurify.

Inside the child's graph `ApiError` comes from `core/errors`, never the `core` barrel. The barrel pulls auth, the home relay and ExifTool into the bundle: 10.3 MB against 4.7 MB. `buildfordocker` (`apps/api/package.json`) bundles `child.ts` as an entry, and that bundle is how purity is checked. Production runs `src/index.ts` directly, and ExcelJS stays external in `node_modules` with the JSZip it depends on; no app code imports JSZip, which the tests alone use, as a dev dependency. The bundle keeps `@mathjax/src` external as well: MathJax imports a font range by its package name when a character first needs it, and under Bun's isolated install only `@mathjax/src`'s own `node_modules` resolves the font package, so a bundled copy fails on the first such character. The pptx importer reads Ecma's `presetShapeDefinitions.xml` from beside its own source (`import/slides/`, through `import.meta.url`), which holds because the child runs from source: a bundled child would need the file copied beside the bundle.

## A capture is always the whole document

The snapshot flush deletes every update with `id <= lastUpdateId` in the same transaction that inserts the snapshot (`collab/collabDocument.ts`). So the newest snapshot plus the newer updates is the complete state, and the capture reads nothing else. A blob that fails to decode is skipped with a `corrupt-blobs-skipped` warning, as on a live load.

## One child runs at a time

Memory is the limit, not cores: one reader's, writer's or Yjs heap exists at a time, and each child may use what the machine has. A reader builds a part's XML tree before its output caps can count what the tree holds, and a tree costs many times its text ([EXPORT.md](EXPORT.md#zip-guards-run-before-the-parser-inflates-anything)). So concurrency 1, the one-shot lifetime, the memory limit, the zip guards and the output byte guards are all load-bearing.

## Admission is bounded by predicted wait

The queue holds 16 jobs at two priorities. Foreground is a user waiting. Background is the search extract and a stale preview's regeneration. A queued request holds its HTTP connection open, so foreground admission is capped by predicted wait, the summed admission costs of the queued and active jobs (at most 120 s), not by queue length alone. Background work may hold at most 8 of the 16 slots, so a mass reindex can't starve users. A dropped background job is safe: the next preview request enqueues it again, and so does the `contentDirty` bit, the flag on a `paths` row that marks its body for the search reindex ([SEARCH.md](SEARCH.md)).

`TRANSFORM_LIMITS` (`runner.ts`) gives each kind a kill deadline and an admission cost. The deadline bounds a runaway. The main-thread prep a caller reports as `prepMs` spends from it, so a preview's media lookup shortens its deadline, and a job whose prep spent it all times out without spawning a child. An export's media prep runs inside the deadline itself. The cost is what a job is expected to take from the queue. It is keyed by kind, not document type, so the bytes previews run under the same `preview` row as the collab ones.

Admission is checked before the expensive preparation: the Yjs capture, upload copies, the convert source read. A refused job pays for nothing. It gets a readable 503 ("The server is busy…"), which `useExportDocument` shows verbatim.

Costs under-predict a slow job. If every admitted job runs to its deadline, a foreground connection can wait 8 to 10 minutes, but it still ends in a result or an error, never a hang. A queued job holds its full payload, the captured blobs or the upload, rather than a closure that prepares it at start. That is bounded in practice, and the refactor waits for a trigger in [ROADMAP-POST-1.md](ROADMAP-POST-1.md).

## An export's media is prepared inside its job

Only the child knows which files in a document's `media/` folder the document names, because only the child reads the document. The folder also keeps files nothing names: a deleted or replaced image, the pictures of a pptx import that failed. So an export's request carries no media. Once the export's renderer has read the document, the child sends the runner the names it holds (`mediaNamesIn`, `document/media.ts`; `sceneMediaNames` for a deck or drawing, whose frame backgrounds are stored JSON), and the runner hands them to the caller's `prepareMedia` and sends the prepared files back. A document that names none, an xlsx export among them, makes no round trip.

The bytes sit in the API's heap and then cross as a copy, so `collectExportMedia` (`export/media.ts`) holds them to `MAX_DECOMPRESSED_BYTES`, as an import source is held: the named files' declared sizes before any read, then the prepared bytes as it goes, since an SVG with its siblings inlined can outgrow its file. Past it the export is a 413, "This document's images are too large to export". The files are prepared one at a time while the job holds the one slot, so only one export's media is ever held, under the job's deadline. A cancel, the deadline or a shutdown aborts the prep's signal, and it reads no more files. The runner logs the prep as the job's `prepMs`.

## A child serves one job, then dies

The runner kills the child with SIGKILL after every outcome: success, structured failure, deadline, crash, cancellation, shutdown. The child never exits on its own, because a `process.send` followed by an exit drops the reply; it leaves only when its channel to the API closes, so an API that dies first leaves no orphan. `gracefulShutdown` closes the runner before the mount teardown, and the close waits up to a second for the killed children's ends, so no result races it and a child stuck in the kernel can't hold the shutdown.

A child costs 20 to 130 ms to start on Linux (the job line's `startupMs`: spawn, Bun's startup, the IPC), and the format modules it loads take the rest. A warm process running mixed jobs is what one-shot avoids: a warm Worker turned a sheets preview followed by a slides preview into a 127 s render and 10.6 GB of extra RSS, suspected to be shared isomorphic-dompurify jsdom state. A one-shot child can't reach that state, and a warm pool has to rule it out first.

## A failure never falls back to the main thread

Not after a timeout, a crash, an out-of-memory, an overload or a module that fails to load. A fallback would bring back the server-wide freeze this layer exists to remove, and an out-of-memory on the main thread would take the API down.

- A recalc failure returns the replayed values with a `recalc-failed` warning and never fails the job. Only an export recalcs ([SHEETS.md](SHEETS.md#the-editor-computes-on-write-the-server-only-what-nobody-computed)).
- Sanitizing runs inside the child. Every HTML preview and export body goes through `sanitizeExportHtml` ([EXPORT.md](EXPORT.md#the-sanitizer-keeps-only-data-references-because-a-browser-fetches), [PREVIEWS.md](PREVIEWS.md#no-preview-body-may-fetch-a-url-the-file-chose)). The `.eml` preview uses the mail reader's DOMPurify config plus hooks of its own that strip every reference but an inlined raster image and every CSS fetch, and it forbids more tags, such as `svg` and `video` (`apps/api/src/lib/preview/eml-preview.ts`).
- The import commit stays on the main thread ([EXPORT.md](EXPORT.md#an-import-writes-nothing-until-the-transform-succeeds)).

## The runner logs one line per job, overload included

Each job logs its kind, type, format, priority, queue depth and wait, the main-thread capture and media-prep time, startup, transform and total time, input and output bytes, the child's peak RSS, the outcome, the signal that ended the child and its warning codes. The main-thread times are there because a fast transform behind slow preparation is not a successful offload. The peak is the child's own `VmHWM`: on Linux a child's `maxRSS` starts at the API's high-water mark. A refused admission logs its reason and the queue state. No line carries document content, upload bytes or HTML.

`apps/api/src/test/transform-benchmark.ts` measures latency, event-loop delay, health-route latency, the API's RSS and the child's peak on heavy fixtures, and the stall of a 50 MB and a 200 MB copy each way. It is not a test: run it from `apps/api` with `bun src/test/transform-benchmark.ts [--memory]`. Its gates are a health p95 under 150 ms, a loop p99 under 100 ms and no single delay over 250 ms, and it prints a verdict for each measurement. Output bytes are pinned by the goldens in `src/test/document/document-transform.test.ts`, runner behavior in `document-transform-runner.test.ts`, whose Linux-only suite proves the memory limit.

## See also

- [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md): the readers the child runs
- [PREVIEWS.md](PREVIEWS.md), [EXPORT.md](EXPORT.md), [SEARCH.md](SEARCH.md): what each operation renders
- [SELF-HOSTING.md](SELF-HOSTING.md): the host the memory limit follows
