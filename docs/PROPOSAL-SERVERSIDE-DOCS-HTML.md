# Proposal: Server-Side Document Rendering, Export & Import

## Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Quick Preview | Done | `eigendoc-preview.ts`, shared extensions, yjs-loader |
| Phase 2: Export | Planned | DOCX, PPTX, XLSX, PDF |
| Phase 3: Import | Planned | DOCX, PPTX, XLSX |

## Route Design

Follows the existing drive route pattern: `/drive/:ownerId/:mountId/[file|folder]/:pathId/...`. The server resolves
the eigen type from the file's MIME type and validates that the requested format is supported for that type.

### Export

```
POST /drive/:ownerId/:mountId/file/:pathId/export/:format
  Body: { options? }
  Returns: { jobId } | binary (for fast exports)
```

The server checks the file's MIME and dispatches to the correct pipeline:

| MIME | Supported `:format` values |
|------|---------------------------|
| `application/eigendoc` | `docx`, `pdf` |
| `application/eigenslides` | `pptx`, `pdf` |
| `application/eigensheets` | `xlsx`, `csv` |
| `application/eigenstickies` | `pdf` |

Returns 400 if the format is not supported for the file's type.

### Import

Creates a new eigen file in the target folder from an uploaded file.

```
POST /drive/:ownerId/:mountId/folder/:parentId/import/:format
  Body: multipart/form-data (uploaded file)
  Returns: { jobId } | DrivePath (for fast imports)
```

| `:format` | Creates (MIME) |
|-----------|---------------|
| `docx` | `application/eigendoc` |
| `pptx` | `application/eigenslides` |
| `xlsx` | `application/eigensheets` |

### Job Status (shared)

```
GET  /drive/:ownerId/:mountId/jobs/:jobId/status
  Returns: { status: 'pending' | 'processing' | 'done' | 'error', progress?, downloadUrl?, result?: DrivePath }

GET  /drive/:ownerId/:mountId/jobs/:jobId/download
  Returns: binary file (export only)
```

### Why Async Jobs?

Some operations are fast (eigendoc → DOCX with no images: < 100ms). Others are slow (large PPTX with many images,
XLSX with thousands of rows). Rather than two different APIs, we use a single pattern:

- **Fast path**: If the export completes within ~2 seconds, return the result directly in the POST response
- **Slow path**: If it takes longer, return `{ jobId }` immediately and process in a worker

The client always checks: if the response has a `jobId`, poll for status. If it has binary data or a `DrivePath`,
use it directly.

## Job Worker System

### Architecture

```
Route handler (main thread)
  │
  ├─ Fast path: complete inline, return result
  │
  └─ Slow path: spawn Worker, return jobId
       │
       Worker thread
         ├─ postMessage({ type: 'progress', progress: 0.5 })
         ├─ postMessage({ type: 'done', buffer: ArrayBuffer }, [buffer])
         └─ or: postMessage({ type: 'error', message: '...' })
       │
       Main thread receives worker messages
         ├─ Updates job status (in-memory Map, not DB — jobs are ephemeral)
         ├─ Writes result file to temp dir
         └─ Client polls /status, then /download
```

### Implementation

```
apps/api/src/lib/jobs/
├── job-manager.ts          # JobManager: tracks active jobs, spawns workers
├── export-worker.ts        # Worker entry point for exports
└── import-worker.ts        # Worker entry point for imports
```

The `JobManager` is simple — an in-memory Map of job state. No database needed. Jobs expire after 10 minutes (the
download URL is temporary). This follows the same pattern as the existing thumbnail worker.

```typescript
// Simplified job manager concept
class JobManager {
    private jobs = new Map<string, Job>();

    startExport(jobId: string, input: ExportInput): void {
        const worker = new Worker(new URL('./export-worker', import.meta.url).href);
        this.jobs.set(jobId, { status: 'processing', worker });

        worker.onmessage = (event) => {
            if (event.data.type === 'progress') {
                this.jobs.get(jobId)!.progress = event.data.progress;
            }
            if (event.data.type === 'done') {
                // Write buffer to temp file, update status
            }
        };

        worker.postMessage(input);

        // Auto-cleanup after 10 minutes
        setTimeout(() => this.cleanup(jobId), 10 * 60 * 1000);
    }
}
```

### Worker Data Flow

Workers can't access Mount or Database instances (those aren't transferable). Instead, the main thread pre-reads the
data and sends it to the worker:

```
Main thread:
  1. Load Yjs state → binary (Uint8Array)
  2. Read media files → Map<name, ArrayBuffer>
  3. postMessage({ yjsState, mediaFiles, format, options }, [...transferables])

Worker:
  1. Apply Yjs state → Y.Doc → PM JSON (or extract Yjs maps for slides/sheets)
  2. Serialize to target format (DOCX/PPTX/XLSX)
  3. postMessage({ type: 'done', buffer }, [buffer])
```

This keeps I/O on the main thread (where Mount is available) and CPU-heavy serialization on the worker.

### When to Use Workers

Not every operation needs a worker. Guidelines:

| Operation | Worker? | Reason |
|-----------|---------|--------|
| Eigendoc → HTML preview | No | Fast (< 50ms), pure string concatenation |
| Eigendoc → DOCX (no images) | No | Fast (< 200ms) |
| Eigendoc → DOCX (with images) | Yes | Image embedding is slow for many/large images |
| Eigenslides → PPTX | Yes | Image-heavy, layout computation |
| Eigensheets → XLSX | Maybe | Fast for small sheets, slow for thousands of rows |
| DOCX → eigendoc import | Yes | mammoth + DOM parsing + image extraction |
| Any → PDF | Yes | Requires headless browser or heavy rendering |

## Phase 1: Quick Preview (Done)

Eigendoc HTML preview is implemented and deployed. Key files:

| File | Purpose |
|------|---------|
| `packages/lib/src/docs/eigendoc/extensions.ts` | `getDocExtensions()` — shared tiptap extension list |
| `packages/lib/src/docs/eigendoc/nodes/` | Figure, CommentMark, SmallMark schemas |
| `apps/api/src/lib/collab/yjs-loader.ts` | Lightweight read-only Yjs state loading |
| `apps/api/src/lib/preview/eigendoc-preview.ts` | Yjs → PM JSON → HTML via `@tiptap/static-renderer` |
| `apps/api/src/lib/preview/preview-cache.ts` | Dynamic import of eigendoc-preview |

### Build Constraint

`eigendoc-preview.ts` imports tiptap/ProseMirror packages that reference DOM globals at the module level. With
`bun build`, these crash the server at startup. The solution: `--splitting` in the build command, combined with a
dynamic `await import('./eigendoc-preview')` in `preview-cache.ts`. This produces a separate chunk that only loads when
a preview is actually requested. The same `--splitting` mechanism works for export/import workers.

### Extension Split Pattern

| Shared (`packages/lib/src/docs/`) | Frontend (`apps/docs/`) | Backend (`apps/api/`) |
|---|---|---|
| Node/mark schema (attrs, parseHTML, renderHTML) | React NodeViews | Yjs loading from SQLite |
| Extension list (`getDocExtensions()`) | Collaboration, CollaborationCaret | Preview endpoints |
| | TableWidthClamp, editor UI | Export/import workers |

## Phase 2: Export

### Eigendoc → DOCX

**Library**: `prosemirror-docx` (curvenote) — serializes ProseMirror documents directly to DOCX.

Why not HTML → DOCX: PM JSON → DOCX preserves structural information (custom attributes, alignment semantics) that
gets lost in HTML. Custom nodes need explicit handling either way — better to read node attributes directly.

Custom serializers needed:

| Node/Mark | DOCX Mapping |
|-----------|-------------|
| `figure` | Embedded image + optional caption paragraph, with alignment and width |
| `taskList` / `taskItem` | Bullet list with checkbox characters (☐/☑) |
| `codeBlock` | Monospace paragraph with gray background (no syntax highlighting) |
| `highlight` mark | Run-level background color |
| `small` mark | Smaller font size |
| `comment` mark | Skip (internal-only) |
| `textAlign` | Paragraph alignment |
| `color` / `fontFamily` | Run-level formatting |

**Dependencies**: `prosemirror-docx`, `docx` (peer dep)

### Eigenslides → PPTX

**Library**: `pptxgenjs` (3.2k stars) — pure JS, creates PPTX from JavaScript objects.

Pipeline: Yjs → extract slide data → map objects to pptxgenjs shapes. Each slide's text boxes, images, and shapes map
to pptxgenjs primitives. Percentage-based coordinates (eigenslides format) convert directly to pptxgenjs's
percentage-based positioning.

**Dependencies**: `pptxgenjs`

### Eigensheets → XLSX

**Library**: `exceljs` (15k stars) or `xlsx-populate` — pure JS, streaming support for large sheets.

Pipeline: Yjs → extract sheet data (cells, formulas, formatting) → write to XLSX workbook. Fortune-sheet's cell format
maps to Excel cell styles.

**Dependencies**: `exceljs`

### Eigensheets → CSV

Simple: extract sheet data, serialize to CSV string. No library needed.

### PDF Export (All Types)

Two approaches:

1. **HTML → PDF via headless browser**: Use Puppeteer/Playwright to render the HTML preview to PDF. Heavy but accurate.
2. **Library-based**: `pdf-lib` for simple documents, but limited for complex layouts.

For eigendocs: reuse `generateEigendocPreview()` HTML → Puppeteer PDF. For slides: render each slide to HTML → PDF
pages. For sheets: XLSX → PDF via headless LibreOffice, or render HTML table → Puppeteer.

PDF is the heaviest operation — always runs in a worker.

### File Structure

```
apps/api/src/lib/export/
├── export-manager.ts       # Job management, worker spawning
├── export-worker.ts        # Worker entry point (dispatches by format)
├── docx/
│   ├── docx-export.ts      # Eigendoc → DOCX
│   └── docx-serializers.ts # Custom node/mark serializers
├── pptx/
│   └── pptx-export.ts      # Eigenslides → PPTX
├── xlsx/
│   └── xlsx-export.ts      # Eigensheets → XLSX
└── csv/
    └── csv-export.ts       # Eigensheets → CSV
```

## Phase 3: Import

### DOCX → Eigendoc

**Library**: `mammoth.js` (6.2k stars) — DOCX to clean semantic HTML.

Pipeline:

```
DOCX upload
  → mammoth.convertToHtml(buffer, { convertImage })
    → extract images → save to media/ folder
    → HTML with <img data-media-name="...">
  → DOMPurify.sanitize(html)
  → happy-dom DOMParser → DOM tree
  → ProseMirror DOMParser.fromSchema(schema).parse(dom)
  → PM JSON → prosemirrorJSONToYDoc() → Y.Doc → write to data.db
```

`happy-dom` provides the minimal DOM needed for ProseMirror's DOMParser. Only used for import.

**Dependencies**: `mammoth`, `happy-dom`

### PPTX → Eigenslides

**Library**: `pptx2json` or manual OOXML parsing via `jszip` + XML parser.

PPTX is a zip of XML files. Extract slides, parse shapes/text/images, map to eigenslides' Yjs data model. Images are
extracted and saved to the doc's media folder.

### XLSX → Eigensheets

**Library**: `exceljs` (same as export — read and write).

Parse workbook, extract cells/formulas/formatting, map to fortune-sheet's Yjs data model.

### File Structure

```
apps/api/src/lib/import/
├── import-manager.ts       # Job management, worker spawning
├── import-worker.ts        # Worker entry point
├── docx/
│   └── docx-import.ts      # DOCX → eigendoc
├── pptx/
│   └── pptx-import.ts      # PPTX → eigenslides
└── xlsx/
    └── xlsx-import.ts       # XLSX → eigensheets
```

### Route

```
POST /drive/:ownerId/:mountId/folder/:parentId/import/docx
```

## Dependencies Summary

### Already Available

| Package | Purpose |
|---------|---------|
| `yjs` | Yjs document handling |
| `@tiptap/y-tiptap` | Yjs ↔ ProseMirror JSON |
| `@tiptap/core` + extensions | Schema + rendering |
| `@tiptap/static-renderer` | Server-side HTML rendering |
| `lowlight` | Code syntax highlighting |
| `isomorphic-dompurify` | HTML sanitization |

### New Dependencies

| Package | Purpose | Phase |
|---------|---------|-------|
| `prosemirror-docx` | PM → DOCX serialization | 2 (export) |
| `docx` | DOCX generation (peer dep) | 2 (export) |
| `pptxgenjs` | PPTX generation | 2 (export) |
| `exceljs` | XLSX read/write | 2 (export) + 3 (import) |
| `mammoth` | DOCX → HTML | 3 (import) |
| `happy-dom` | Minimal DOM for ProseMirror DOMParser | 3 (import) |

## Edge Cases

- **Empty documents**: Return minimal/empty file in target format
- **Missing media**: Skip image in export, render placeholder in preview
- **Corrupt Yjs state**: `loadYjsState()` handles corrupt snapshots/updates with try/catch
- **Concurrent edits during export**: Loads a snapshot — exports are eventually consistent
- **Code blocks**: No syntax highlighting in DOCX/PPTX (monospace + gray background only)
- **Comment marks**: Stripped from export (internal-only, references chat threads)
- **Round-trip fidelity**: Import is lossy by design — complex formatting simplified to match our schema
- **Large files**: Worker + timeout (30s default, configurable). Client sees progress via polling
- **Cancelled exports**: Worker terminated, temp files cleaned up
- **Multiple concurrent exports**: JobManager limits concurrent workers (default: 2 per user)
