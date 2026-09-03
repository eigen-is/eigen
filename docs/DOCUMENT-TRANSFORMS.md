# Document Transform Workers

> **TLDR**: Every CPU-heavy document transform — eigensheets/eigendoc/eigenslides/eigenvector previews, HTML/PDF/XLSX/DOCX
> exports, the xlsx/docx import and convert, and background search extraction — runs in a one-shot Bun Worker
> behind one bounded runner (`apps/api/src/lib/document/transform/`). The main thread keeps auth/ACL, cache
> coordination, storage I/O, media prep and the import commit; only transferred `ArrayBuffer`s and plain
> metadata cross the boundary. Overload answers `503` — there is never a main-thread fallback.

## Why

`async` does not move work off Bun's event loop: awaiting a preview only suspends the caller, while Yjs
reconstruction, formula recalc, HTML rendering, sanitization and ExcelJS/ZIP work still run on the request
thread and pause every other API, WebSocket, SSE, mail and sync task. Before the move, a cold heavy-sheet
preview stalled the event loop for 14.1s; through the Worker the worst delay is 9ms and the health route p95
stays at 0.3ms. Image/video thumbnails were already off-thread (`lib/shared/thumbnail-worker.ts`) and stay
separate.

## Architecture

```
Main thread                                       One-shot Bun Worker
  route auth / ACL                                  materializeYjsState(payload)
  preview-cache lookup + in-flight dedupe           dispatch on request kind (dynamic imports)
  capture compressed Yjs blobs (SELECT-only txn)    parse snapshot / replay ops / (export-only) recalc
  media prep (URL map or export buffers)            render / sanitize / convert / serialize
  runner admission                                  return bytes or text + warnings
  cache write / response / import commit
```

| File (`apps/api/src/lib/document/transform/`) | Role |
|---|---|
| `run-transform.ts`  | The one main-thread seam every transform goes through (`runTransformToText` / `runTransformToBytes` / import variants): owns capture timing, per-operation deadline, admission, warning surfacing, failure mapping |
| `runner.ts`         | Admission + Worker lifecycle only, no document logic; `TRANSFORM_LIMITS` lives here |
| `worker.ts`         | Operation dispatch with lazy imports — a doc preview never evaluates the sheet engine or ExcelJS |
| `protocol.ts`       | Closed discriminated request/response unions, transfer lists, result↔request pairing, result sizing |
| `collab-source.ts`  | Main-thread capture of the compressed Yjs payload (`readYjsStatePayload`) |

Every operation follows the same layout: a Worker-pure module per type behind a thin main-thread entry.

| Operation | Main-thread entry | Worker-pure modules | Detail doc |
|---|---|---|---|
| Preview  | `preview/preview-document.ts` | `preview/eigen{doc,slides,sheets,vector}-render.ts` | [PREVIEWS.md](PREVIEWS.md) |
| Export   | `export/export-document.ts` (`runDocumentExport` + the format→envelope table) | `export/{doc,slides,sheets,vector}/{render,transform}.ts`, `export/canvas/render.ts` | [EXPORT.md](EXPORT.md) |
| Import / convert | `import/import-document.ts` | `import/{doc,sheets}/transform.ts` | [EXPORT.md](EXPORT.md), [SHEETS.md](SHEETS.md) |
| Search extraction | `search/extract-text.ts` | `search/extract-render.ts` | [SEARCH.md](SEARCH.md) |

**Boundary rules.** Workers receive transferred `ArrayBuffer`s (compressed Yjs blobs, upload bytes, media
buffers) and clone-safe metadata — never a `Mount`, `ManagedDatabase`, `Y.Doc`, storage handle, callback or
class instance. A module the Worker imports must never statically reach `preview/preview-cache.ts` (it would
drag sharp and the sheet engine into every document Worker) — the reason `document/media.ts` (light, both
sides) and `export/media.ts` (screen previews, main thread) are separate files. Inside the Worker graph,
import `ApiError` from `core/errors`, never the core barrel: the barrel pulls auth/home-relay/ExifTool into
the Worker bundle (measured: 10.3MB → 4.7MB when fixed). Purity is verified by bundling each Worker entry.

The Yjs capture relies on one invariant: the snapshot flush deletes every update with `id <= lastUpdateId` in
the same transaction that inserts the snapshot (`collab/collabDocument.ts`), so "snapshot + newer updates" is
always the complete state. Corrupt blobs are skipped with a warning, matching live-read behavior.

## Admission and limits

One process-wide runner: **one active Worker** (one ExcelJS/Yjs heap at a time — memory, not cores, is the
limiting resource), a queue of 16 with foreground (user waits) and background (stale preview regeneration,
search extraction) priorities. Per-kind limits live in `TRANSFORM_LIMITS` (`runner.ts`):

| Kind | Kill deadline | Admission cost |
|---|---|---|
| preview       | 30s  | 15s |
| export        | 120s | 30s |
| import        | 120s | 30s |
| extract-text  | 30s  | 15s |

The deadline bounds runaways; the admission cost is what a job is expected to cost the queue. Because these
routes are synchronous, a queued request holds its HTTP connection open — foreground admission is therefore
bounded by predicted wait (summed admission costs, max 120s), not queue length alone. Overflow rejects with a
human-readable `503` ("The server is busy…" — `useExportDocument` shows the raw text). Background work may
hold at most 8 of the 16 slots so mass reindexing cannot starve foreground admission, and dropped background
jobs are safe: the `contentDirty` bit or a later preview request re-enqueues them. Admission is checked
*before* expensive preparation (Yjs capture, export media prep, upload copies, the convert source read).

Known consequence, accepted: under adversarially slow jobs the worst-case foreground connection hold is
~8–10 min (costs under-predict; the per-job deadline still kills runaways — 503-not-hang holds).

## Worker lifecycle: one-shot, no warm pool

Workers are terminated after every outcome — success, structured failure, deadline, crash, cancellation,
shutdown (`gracefulShutdown` closes the runner before mount teardown). This is a **decision, not a default**
(2026-08-04, measured):

- Worker spawn is 2–4ms; the real one-shot cost is module evaluation, 0.3–0.8s per job.
- A terminated heavy Worker retains ~5–7MB RSS; a reused Worker stays flat — so churn has a real cost.
- But a mixed-operation warm Worker showed a pathological sheets-preview → slides-preview interaction: a 127s
  render and +10.6GB RSS (suspect: shared isomorphic-dompurify jsdom state). Unreachable with one-shot
  Workers.

Any future pooling discussion starts from that pathology. The test suite was tuned instead (route round-trips
only where they pin contracts).

## Failure and security rules

- **Never a main-thread fallback** — after timeout, crash, overflow or module-load failure. A fallback would
  reintroduce the server-wide freeze this layer removes.
- Errors cross the boundary as small typed codes plus an optional HTTP status — never cloned `Error`
  instances. Import `400`/`413` semantics survive the boundary; a converter *module-load* failure is `500`
  (a broken install is not a bad upload). Worker responses are shape-validated at the trust boundary
  (`isValidResponse` in `runner.ts`); a half-valid response becomes a structured failure, not a hung promise.
- A recalc failure inside the Worker returns replayed values plus a `recalc-failed` warning — it never fails
  a preview or export. Preview and extract reads never recalc at all; export is the only recalc'ing read
  (SHEETS.md § Server-side recalc).
- Sanitization happens inside the Worker: previews use DOMPurify with `FORCE_BODY` only; exports go through
  `sanitizeExportHtml` (the call-scoped data-URI-only SSRF hook — see [EXPORT.md](EXPORT.md)).
- Decompressed-size guards (`import/zip-size-guard.ts`) run before ExcelJS or mammoth materialize anything;
  the sheet cell-count guard still only fires after load, which is a core reason concurrency stays at 1.
- The import commit stays on the main thread: the write-permission recheck is the last await before the Yjs
  transaction, and a Worker crash leaves source and target untouched. `/convert` deliberately takes no abort
  signal — its result is a durable document and a page reload must not kill a minute-long conversion (it
  surfaces via the drive SSE refresh); `/import` into an existing document keeps its signal.
- Bun Workers isolate the event loop, not the address space — a native OOM can still take the API down.
  One-shot lifetime, concurrency 1, the zip guards and the output byte guards are therefore all mandatory.
- Job logs carry kind, type, format, sizes and timings — never document content, upload bytes or HTML.

## Build and deployment

The Worker is an explicit build entry next to `src/index.ts` and the thumbnail worker (`buildfordocker` in
`apps/api/package.json`). Large format modules (ExcelJS, Turbodocx, mammoth) load via dynamic import inside
the Worker's operation switch and stay externalized in runtime `node_modules`. Production executes
`src/index.ts` directly; `buildfordocker` remains the Worker-graph purity verification tool.

## Observability

The runner logs one line per job: kind/type/format, priority, queue depth and wait, main-thread capture and
media-prep ms, startup/transform/total ms, input/output bytes, outcome (success, document error, timeout,
crash, cancellation, overload) and warning codes. `apps/api/src/test/transform-benchmark.ts` measures
end-to-end latency, event-loop delay, health-route latency and RSS on heavy fixtures (run from `apps/api`:
`bun src/test/transform-benchmark.ts [--memory]`); gates: health p95 < 150ms, loop p99 < 100ms, no single
delay > 250ms.

## History

Built as the `transform-workers` program, shipped 2026-08-04 (phases: sheets preview → sheet export/import →
doc/slides/docx → extraction + tuning, plus an external review round). Representative wins: cold heavy sheet
preview 14.1s stall → 9ms worst delay; xlsx export worst loop delay 519ms → 3.4ms; 619ms module evaluation
and 72MB RSS moved off the API process. Documents and snapshots stayed byte-identical through the move
(goldens in `src/test/document/document-transform.test.ts`; runner behavior in `document-transform-runner.test.ts`;
route contracts in the export/import route tests).

Post-ship amendments: preview/extract reads no longer recalc (2026-08-05, after a legacy never-computed
workbook looped a ~39s recalc against the 30s deadline); the sheets snapshot moved to the v2 dictionary
format (SHEETS.md § Snapshot format v2).

Accepted drifts still standing:

- Queued jobs retain their payloads rather than preparation closures — bounded in practice; the closure
  refactor is parked on the [ROADMAP](ROADMAP.md) with its trigger.
- Preview conditional-format aggregate rules compute over the render window, not the full declared range
  (PREVIEWS.md § Compact Previews); the editor canvas is the fidelity reference.
