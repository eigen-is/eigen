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
  Returns: binary file (Content-Disposition: attachment)
```

Synchronous — the response IS the exported file. The server checks the file's MIME and dispatches to the correct
pipeline. Returns 400 if the format is not supported for the file type.

| MIME | Supported `:format` values |
|------|---------------------------|
| `application/eigendoc` | `docx`, `pdf` |
| `application/eigenslides` | `pptx`, `pdf` |
| `application/eigensheets` | `xlsx`, `csv` |
| `application/eigenstickies` | `pdf` |

### Import

Creates a new eigen file in the target folder from an uploaded file.

```
POST /drive/:ownerId/:mountId/folder/:parentId/import/:format
  Body: multipart/form-data (uploaded file)
  Returns: DrivePath (the created eigen file)
```

| `:format` | Creates (MIME) |
|-----------|---------------|
| `docx` | `application/eigendoc` |
| `pptx` | `application/eigenslides` |
| `xlsx` | `application/eigensheets` |

### Why Synchronous?

The original proposal had an async job system with polling. After review, this adds significant complexity (job
tracking, status routes, download routes, server restart recovery) for marginal benefit. The actual heavy work is:

- **DOCX export**: PM serialization + image embedding. Fast for most documents (< 1s). For large docs with many
  images, the bottleneck is I/O (reading images from disk), not CPU.
- **PPTX/XLSX export**: Similar — serialization is fast, I/O dominates.
- **Import**: mammoth + DOM parsing. CPU-bound but typically < 5s even for large files.
- **PDF**: The only truly heavy operation (headless browser). Deferred to a later phase.

For the initial implementation, synchronous responses are simpler and sufficient. The route handler runs the export
in a Worker to avoid blocking the event loop, but the HTTP connection stays open until the result is ready. If PDF
export later proves too slow for synchronous responses, we can add an async job system specifically for that format.

### Frontend Integration

Export is triggered from the Drive context menu (already has Open, Download, etc.) and from a menu in each editor app.
The frontend sends the POST request and initiates a file download from the response.

Import is triggered from the Drive toolbar — an "Import" button that opens a file picker filtered by supported
formats. After upload, the new file appears in the current folder.

## Worker Architecture

Export and import run in Bun Workers to avoid blocking the main thread. The pattern matches the existing thumbnail
worker: spawn a worker per request, send input via `postMessage`, receive the result, terminate the worker.

### Data Flow

The export runs on the main thread (not in a separate export worker) because it needs Mount access for reading files.
Image conversion is offloaded to the existing thumbnail worker — one worker call per image.

```
Main thread:
  1. Load Yjs state → Y.Doc → PM JSON
  2. Walk PM tree via prosemirror-docx serializers
  3. For each figure node with a mediaName:
     a. Read original file from media folder (mount.readFile)
     b. Send to thumbnail worker with outputFormat: 'png'
     c. Receive PNG buffer + dimensions
     d. Embed as ImageRun in DOCX
  4. Generate final .docx buffer via Packer.toBuffer()
  5. Return as HTTP response
```

Images are converted one at a time via the thumbnail worker, not pre-loaded into memory. This keeps memory usage
proportional to a single image, not the total media size.

### File Structure

```
apps/api/src/lib/export/
├── docx-export.ts              # Eigendoc → DOCX (serializers + export function)
├── pptx-export.ts              # Eigenslides → PPTX
├── xlsx-export.ts              # Eigensheets → XLSX
└── csv-export.ts               # Eigensheets → CSV

apps/api/src/lib/import/
├── docx-import.ts              # DOCX → eigendoc
├── pptx-import.ts              # PPTX → eigenslides
└── xlsx-import.ts              # XLSX → eigensheets
```

Export/import functions run on the main thread (they need Mount access). CPU-heavy image conversion is offloaded to
the existing thumbnail worker. No new worker entry points needed.

Same build constraint as preview: export files import tiptap/prosemirror packages, so `--splitting` keeps them in
separate chunks loaded on demand via dynamic `await import()`.

### Thumbnail Worker Reuse

Export and import don't use separate workers. Instead, they reuse the existing **thumbnail worker** for image
conversion. The thumbnail worker gains an `outputFormat` parameter (`'webp' | 'png'`) — the only change needed.

| Operation | Runs on | Image conversion via |
|-----------|---------|---------------------|
| Eigendoc → HTML preview | Main thread | N/A (images are URLs) |
| Eigendoc → DOCX | Main thread | Thumbnail worker (→ PNG) |
| Eigenslides → PPTX | Main thread | Thumbnail worker (→ PNG) |
| Eigensheets → XLSX | Main thread | N/A (no images) |
| Eigensheets → CSV | Main thread | N/A |
| Any import | Main thread | N/A (images stored as-is) |
| Any → PDF | Worker (Puppeteer) | N/A (HTML rendered by browser) |

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
a preview is actually requested. The same `--splitting` mechanism handles export/import worker chunks.

### Extension Split Pattern

| Shared (`packages/lib/src/docs/`) | Frontend (`apps/docs/`) | Backend (`apps/api/`) |
|---|---|---|
| Node/mark schema (attrs, parseHTML, renderHTML) | React NodeViews | Yjs loading from SQLite |
| Extension list (`getDocExtensions()`) | Collaboration, CollaborationCaret | Preview endpoints |
| | TableWidthClamp, editor UI | Export/import workers |

## Phase 2: Export

### Eigendoc → DOCX

**Library**: `prosemirror-docx` (curvenote) — serializes ProseMirror documents directly to DOCX via the `docx`
package (9.6.1, 5.6k stars). Note: `prosemirror-docx` is a thin wrapper — if it falls behind on ProseMirror
compatibility, we can use `docx` directly with a custom PM tree walker.

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

#### Image Conversion

DOCX only supports PNG and JPEG natively. WebP, SVG, HEIC, AVIF, RAW formats (CR2, NEF, ARW, etc.) are NOT supported.
The eigendoc media folder stores **original files** in any format, so every image must be converted before embedding.

The existing thumbnail worker (`apps/api/src/lib/shared/thumbnail-worker.ts`) already solves this problem with a
3-stage fallback chain: sharp → heic-convert → exiftool embedded preview extraction. It currently outputs WebP only.

**Approach: extend the thumbnail worker with an `outputFormat` parameter.**

The worker gains a new option: `outputFormat: 'webp' | 'png'`. The final sharp call switches between `.webp()` and
`.png()` based on this parameter. Everything else stays the same — the 3-stage fallback, timeout, cleanup, dimension
extraction. This means DOCX export gets the same broad format support as thumbnails (HEIC, RAW, SVG, etc.) for free.

```
Export pipeline for each figure node:
  1. Main thread reads original file from media folder (mount.readFile)
  2. Sends to thumbnail worker with outputFormat: 'png', maxSize: 1200
  3. Worker converts any format → PNG via the existing 3-stage chain
  4. Returns PNG buffer + dimensions
  5. DOCX serializer embeds the PNG buffer as an ImageRun
```

SVG is a special case: the preview system serves SVG as-is (vector), but DOCX can't render SVG. The worker's sharp
stage handles SVG rasterization natively (`sharp(svgBuffer).png()`), so SVG files go through the same pipeline.

The `maxSize` parameter controls the output resolution. Thumbnails use small sizes (256px); DOCX export uses larger
sizes (e.g. 1200px) for print-quality output while keeping file sizes reasonable.

For the figure node's `width` attribute (pixels as set in the editor): the DOCX ImageRun uses the same pixel value
(at 96 DPI). If the figure has no width, use the image's natural dimensions capped to page width (600px).

**Dependencies**: `prosemirror-docx`, `docx` (no new image dependencies — reuses existing worker)

### Eigenslides → PPTX

**Library**: `pptxgenjs` (3.2k stars) — pure JS PPTX generation.

Pipeline: Yjs → extract slide data (Y.Map structures) → map objects to pptxgenjs shapes. Note: eigenslides uses
percentage-based coordinates on a 1920x1080 canvas. `pptxgenjs` supports percentage positioning via `{ x: '10%' }`
syntax — verify exact coordinate mapping during implementation.

**Dependencies**: `pptxgenjs`

### Eigensheets → XLSX

**Library**: `exceljs` (15k stars) — pure JS, streaming support for large sheets.

Pipeline: Yjs → extract sheet data → write to XLSX workbook. Note: fortune-sheet uses Luckysheet's internal cell data
model which differs significantly from Excel's. Key mapping challenges:
- Cell formatting (fortune-sheet's `ct` object → exceljs style properties)
- Merged cells (`mc` config → exceljs `worksheet.mergeCells()`)
- Formulas (fortune-sheet syntax may differ from Excel — needs testing)
- Conditional formatting (likely lossy — simplify or skip)

**Dependencies**: `exceljs`

### Eigensheets → CSV

Simple: extract sheet data, serialize to CSV string. No external library needed.

### PDF Export

Deferred to a later phase. PDF requires a headless browser (Puppeteer/Playwright) to render HTML previews to PDF.
This is the only operation that's genuinely too slow for synchronous responses and would benefit from an async job
system. When implemented:

- Reuse `generateEigendocPreview()` HTML → Puppeteer `page.pdf()`
- For slides: render each slide to an HTML page → multi-page PDF
- For sheets: render HTML table → Puppeteer PDF
- Always runs in a worker with a generous timeout (60s)

**Dependencies** (future): `puppeteer` or `playwright`

## Phase 3: Import

### DOCX → Eigendoc

**Library**: `mammoth.js` (6.2k stars) — DOCX to clean semantic HTML.

Pipeline:

```
DOCX upload
  → mammoth.convertToHtml(buffer, { convertImage })
    → extract images → save to media/ folder
    → HTML with <img data-media-name="...">
  → DOMPurify.sanitize(html)  (isomorphic-dompurify, already installed)
  → jsdom DOMParser → DOM tree  (jsdom already externalized in build)
  → ProseMirror DOMParser.fromSchema(schema).parse(dom)
    → schema built from getDocExtensions()
    → FigureNode.parseHTML picks up data-media-name attributes
  → PM JSON
  → prosemirrorJSONToYDoc()  (from y-prosemirror, NOT @tiptap/y-tiptap)
  → Y.encodeStateAsUpdate(ydoc)
  → create eigendoc via Drive.createDoc() + write Yjs state to data.db
```

DOM requirement: ProseMirror's `DOMParser.fromSchema(schema).parse(dom)` needs a DOM. Use `jsdom` — it's already a
dependency via `isomorphic-dompurify` and externalized in the build command. No need to add `happy-dom`.

Yjs write: use `Drive.createDoc()` to create the eigendoc folder structure, then write the Yjs state to `data.db`
using the same schema as `CollabDocument`. This ensures the new file is compatible with the collab system.

**Dependencies**: `mammoth`, `y-prosemirror` (for `prosemirrorJSONToYDoc`)

### PPTX → Eigenslides

**Library**: manual OOXML parsing via `jszip` + XML parser.

PPTX is a zip of XML files. Extract slides, parse shapes/text/images, map to eigenslides' Yjs data model (Y.Map
structures for slides, objects, slideOrder). Images extracted and saved to the doc's media folder.

**Dependencies**: `jszip` (likely already available transitively)

### XLSX → Eigensheets

**Library**: `exceljs` (same as export — read and write).

Parse workbook, extract cells/formulas/formatting, map to fortune-sheet's Yjs data model. Same mapping challenges as
export but in reverse.

## Dependencies Summary

### Already Available

| Package | Purpose |
|---------|---------|
| `yjs` | Yjs document handling |
| `@tiptap/y-tiptap` | Yjs → ProseMirror JSON (`yXmlFragmentToProsemirrorJSON`) |
| `@tiptap/core` + extensions | Schema + rendering |
| `@tiptap/static-renderer` | Server-side HTML rendering |
| `lowlight` | Code syntax highlighting |
| `isomorphic-dompurify` | HTML sanitization (includes jsdom) |

### New Dependencies

| Package | Purpose | Phase |
|---------|---------|-------|
| `prosemirror-docx` | PM → DOCX serialization | 2 (export) |
| `docx` | DOCX generation (peer dep) | 2 (export) |
| `pptxgenjs` | PPTX generation | 2 (export) |
| `exceljs` | XLSX read/write | 2 + 3 |
| `mammoth` | DOCX → HTML | 3 (import) |
| `y-prosemirror` | `prosemirrorJSONToYDoc()` for import | 3 (import) |

## Edge Cases

- **Empty documents**: Return minimal/empty file in target format
- **Missing media**: Skip image in export, render placeholder in preview
- **Corrupt Yjs state**: `loadYjsState()` handles corrupt snapshots/updates with try/catch
- **Concurrent edits during export**: Loads a snapshot — exports are eventually consistent
- **Code blocks**: No syntax highlighting in DOCX/PPTX (monospace + gray background only)
- **Comment marks**: Stripped from export (internal-only, references chat threads)
- **Round-trip fidelity**: Import is lossy by design — complex formatting simplified to match our schema
- **Image format conversion**: All images converted to PNG via thumbnail worker before DOCX/PPTX embedding. Handles WebP, SVG, HEIC, RAW, AVIF, etc. through existing 3-stage fallback (sharp → heic-convert → exiftool)
- **Large images in export**: Images converted one at a time via thumbnail worker — not pre-loaded into memory
- **Upload size limits**: Import route must call `getUploadMaxSize()` for quota enforcement
- **Worker timeout**: 30s default for export/import workers. Worker is terminated on timeout, error returned
- **Server restart during export**: Export is synchronous — the HTTP connection drops and the client retries
