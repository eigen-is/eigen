# Document Export: DOCX, PDF, HTML

## Overview

Export eigendoc documents as DOCX, PDF, and HTML. A single HTML pipeline generates standalone HTML with embedded
fonts, base64 images, and flattened eigen-prose CSS. DOCX and PDF are derived from that HTML:

- **HTML**: the standalone HTML document itself
- **DOCX**: HTML fed to `@turbodocx/html-to-docx`
- **PDF**: HTML fed to WeasyPrint subprocess

Eigenslides and eigensheets reuse the same HTML→PDF pipeline (sheets also export native XLSX) — see their
sections below.

Every eigendoc/eigenslides/eigensheets export runs its Yjs reconstruction, rendering and sanitization in the
one-shot document-transform Worker (`docs/PROPOSAL_DOCUMENT_TRANSFORM_WORKERS.md`, Phases 2–3 as-built): the
main thread prepares media, the Worker returns the finished document bytes. The DOCX conversion runs there too
— the Worker loads the externalized `@turbodocx/html-to-docx` from runtime `node_modules`. WeasyPrint stays a
main-thread subprocess on top of the Worker's HTML.

## File Structure

```
apps/api/src/lib/export/
  export-document.ts             # Entry point: dispatches by mime type + format
  weasyprint.ts                  # Generic: htmlToPdf(html) -> Buffer via subprocess
  modules.d.ts                   # Type declarations for untyped npm packages
  render-types.ts                # Shared contracts: SizeUnit, *ImgSrcResolver
  fonts.ts                       # Embedded WOFF2 @font-face CSS (Inter, Source Serif 4, JetBrains Mono, Excalifont)
  media.ts                       # collectExportMedia: screen previews -> transferable buffers (main thread)
  doc/
    render.ts                    # Pure node renderers: renderFigureNode, renderCodeBlockNode, renderTaskItemNode
    transform.ts                 # Worker-side: materialized doc + media -> HTML bytes, or docx via html-to-docx
    html.ts                      # Main thread: media prep + transform seam (runEigendocExport) + HTML download
    docx.ts                      # DOCX download wrapper (the conversion itself runs in the Worker)
    pdf.ts                       # PDF export via WeasyPrint (over the Worker's HTML)

# Content loaders (Yjs -> PM JSON / DeckData / Sheet[] + media map) live in
# apps/api/src/lib/document/{doc,slides,sheets}.ts — shared by export AND preview; their
# media-free halves (readEigendocFromDoc, readDeckFromDoc, readSheetsFromDoc) are what the
# Worker calls. Media helpers live in apps/api/src/lib/document/media.ts.
```

### Architecture

- **`render.ts`**: pure utility functions with zero side effects — no imports from tiptap, lowlight, or
  any heavy library. Callers pass their own lowlight instance. Shared by both `doc/transform.ts` (export) and
  `eigendoc-preview.ts` (quick preview)
- **Worker side vs main-thread side**: `doc/transform.ts` and `slides/transform.ts` assemble the document and
  are imported *inside* the Worker; `doc/html.ts`, `slides/html.ts`, `pdf.ts` and `docx.ts` are the main-thread
  wrappers that prepare media and call the seam. The split is load-bearing: a module the Worker imports must
  never reach `preview/preview-cache.ts` (it would drag the screen-preview pipeline, sharp and the sheet engine
  into every document Worker), which is why `document/media.ts` (light) and `export/media.ts` (screen previews)
  are separate
- **content loaders** (`apps/api/src/lib/document/{doc,slides,sheets}.ts`): shared Yjs -> PM JSON / DeckData /
  `Sheet[]` + media map loaders (`readEigendocContent`, `readSlidesContent`, `readSheetsContent`), used by both
  export and preview
- **`export-document.ts`**: thin dispatcher that routes `(mount, path, format)` to the right export
  function. Imported by the drive route, NOT by Drive class — export is not Drive's responsibility
- **`doc/transform.ts`**: standalone HTML with base64 data URIs, embedded WOFF2 fonts (via Bun `import ... with
  { type: 'file' }`), CSS imported as text (via `import ... with { type: 'text' }`), and Tailwind
  preflight reset. Font/CSS paths are resolved at build time by Bun's bundler
- **`weasyprint.ts`**: not eigendoc-specific — any file type can use it for PDF

### Separation of Concerns

Export logic lives in `apps/api/src/lib/export/`, not in the Drive class. The route calls
`drive.resolveFile()` to get a `Mount` + `DrivePath` (with ACL enforcement via SharedDrive), then passes
them to `exportDocument()`. Same pattern for previews and thumbnails.

## Route

```
GET /drive/:ownerId/:mountId/file/:pathId/export/:format
```

The route handler is thin:
```typescript
const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
const result = await exportDocument(mount, path, params.format, request.signal);
```

Returns 400 for unsupported format, 501 if WeasyPrint not installed (PDF only), 503 when the transform runner
is saturated. `request.signal` is threaded through so a disconnected export drops its queued job or terminates
its Worker.

## HTML Pipeline

```
main thread: listDocumentMedia() + collectExportMedia() -> { name, contentType, bytes }[]
        |
        |  transferred to the Worker with the compressed Yjs blobs
        v
readEigendocFromDoc() -> PM JSON      toDataUriMap() -> base64 data URIs
        |
        v
renderToHTMLString() with custom nodeMappings:
  - codeBlock: lowlight syntax highlighting (highlightAuto fallback)
  - taskItem: checkbox with data-checked attribute
  - figure: base64 data URIs (export) or embed URLs (preview)
        |
        v
DOMPurify.sanitize() (with ADD_DATA_URI_TAGS for img)
        |
        v
wrapInDocument() -> full HTML with:
  - Embedded WOFF2 fonts (Inter, Source Serif 4, JetBrains Mono, Excalifont)
  - Flattened eigen-prose.css (nested CSS flattened for WeasyPrint)
  - Tailwind preflight reset (box-sizing, list-style, input resets)
  - Print extras (@page, page breaks, text alignment)
        |
        |
        v
still in the Worker: docx feeds this HTML to @turbodocx/html-to-docx (dynamic import,
externalized); html and pdf-html hand back the UTF-8 bytes
        |
        v
bytes transferred back to the main thread
        +-> HTML export (return as-is)
        +-> DOCX export (return as-is)
        +-> PDF export (feed to WeasyPrint subprocess)
```

`runEigendocExport(mount, path, format, signal?)` (`doc/html.ts`) is the single main-thread entry all three
formats share: it prepares the media, then calls `runTransformToBytes` — the same seam sheets previews and
exports use. `html` and `pdf-html` produce the identical document today (WeasyPrint renders exactly what the
download serves), and `docx` is that same document converted in the Worker. The `<title>` keeps the UNstripped
container name (`Report.eigendoc`) — frozen output, pinned by `document-export-route.test.ts`; the docx
document property keeps the stripped name (`Report`).

### CSS Handling

The export HTML includes three CSS layers:
1. **Embedded fonts** — WOFF2 files base64-encoded into `@font-face` rules
2. **Flattened eigen-prose.css** — modern CSS nesting flattened, `.dark` rules dropped, CSS variables resolved
3. **Print extras** — Tailwind preflight reset, A4 page setup, checkbox sizing, code wrap

### Build Configuration

The `buildfordocker` script externalizes `@turbodocx/*` to prevent it from being bundled (it's 1.7MB
and changes the module evaluation order, breaking `PATHS.MAIL` initialization in the mail module).

`@turbodocx/html-to-docx` must be installed in the deployment directory alongside `sharp` and
`isomorphic-dompurify`.

## Frontend

### Export Hook (`packages/lib/src/core/drive/hooks/use-export-document.ts`)

`useExportDocument()` returns `{ exportDocument, isExporting }`. Handles fetch, blob download, filename
extraction from Content-Disposition, and error handling via `onMutationError`.

### FileMenu (`packages/ui/src/components/layout/toolbar/file-menu.tsx`)

Export submenu rendered via `onExport` prop, positioned after Rename:
```
New document > Open > Rename > Export > [separator] > Share > ... > Print > Delete
```

### Drive Context Menu (`packages/ui/src/components/layout/drive/drive-table.tsx`)

Export submenu for eigendoc, eigenslides, and eigensheets files, driven by `onExport` callback.

## Dependencies

| Package                    | Where           | Purpose                                |
|----------------------------|-----------------|----------------------------------------|
| `@turbodocx/html-to-docx` | `apps/api/`     | HTML -> DOCX conversion (externalized in build) |
| `weasyprint` (system)      | Server          | HTML -> PDF via subprocess             |

## Edge Cases

- **Empty documents**: return minimal empty HTML wrapped in the target format
- **Missing media**: skip image (`collectExportMedia` omits non-image results, so `renderFigureNode` emits no
  img tag)
- **WeasyPrint not installed**: return 501 with install instructions
- **Corrupt Yjs state**: `loadYjsState()` handles this with try/catch
- **Large docs with many images**: images loaded in parallel via `Promise.all`
- **Code blocks without language**: `lowlight.highlightAuto()` auto-detects the language. Don't remove this
  thinking it's unnecessary — users rarely set a language on code blocks, so auto-detection provides all
  syntax highlighting in practice
- **Task lists**: custom `taskItem` nodeMapping preserves checked/unchecked state
- **Export during active collab**: loads last persisted state (may lag a few seconds)
- **DOMPurify + data URIs**: `ADD_DATA_URI_TAGS: ['img']` preserves base64 image sources

## Slides Export

Eigenslides (`.eigenslides`) support HTML and PDF export via the same route:

```
GET /drive/:ownerId/:mountId/file/:pathId/export/:format
```

| Format | Pipeline |
|--------|----------|
| `html` | Standalone HTML with container queries (`cqh`/`cqw`) for responsive font sizing |
| `pdf`  | HTML with fixed `px` values → WeasyPrint (254mm × 142.875mm landscape pages) |

Both formats embed WOFF2 fonts (via shared `export/fonts.ts`) and base64 images. The `SizeUnit` abstraction
in `render.ts` lets the same render functions produce either responsive or fixed-size output. Both run in the
document-transform Worker through `runSlidesExport(mount, path, format, signal?)` (`slides/html.ts`), which
prepares the media on the main thread and hands the deck to `renderEigenslidesExport` (`slides/transform.ts`).

Text objects store HTML (TipTap output). `render.ts` runs `obj.text` through `DOMPurify` and `escapeHtml`s
the highlight color before embedding, so the same value that's safely shown by the FE canvas is also safe
inside the export. The `.slide-text` typography rules live in `packages/ui/src/styles/slide-text.css` and
are imported via `with { type: 'text' }` from `html.ts` so canvas and export render identically.

### File Structure

```
apps/api/src/lib/export/slides/
  render.ts      # Slide/object → HTML strings (SizeUnit abstraction), shared with the preview
  transform.ts   # Worker-side: materialized deck + media → standalone HTML bytes (screen or PDF mode)
  html.ts        # Main thread: media prep + transform seam (runSlidesExport) + HTML download
  pdf.ts         # PDF via WeasyPrint (over the Worker's fixed-size HTML)
# content loader: apps/api/src/lib/document/slides.ts (readDeckFromDoc + readSlidesContent)
```

## Sheets Export

Eigensheets (`.eigensheets`) support XLSX, PDF, and HTML export via the same route. Every format runs in the
one-shot document-transform Worker (`docs/PROPOSAL_DOCUMENT_TRANSFORM_WORKERS.md`, Phase 2 as-built), so Yjs
reconstruction, op replay, recalc, rendering, sanitization, and ExcelJS/ZIP work never block the API event
loop:

| Format | Worker | Main thread |
|--------|--------|-------------|
| `xlsx`  | Yjs blobs → `Sheet[]` → ExcelJS workbook → transferred bytes | headers + response |
| `pdf`   | `Sheet[]` → `renderSheetsPdfDocument` (page sized to the widest/tallest sheet) | `htmlToPdf` WeasyPrint subprocess |
| `html`  | `Sheet[]` → `renderSheetsExportDocument` standalone HTML | headers + response |

`exportSheetsToHtml/Pdf/Xlsx` are thin wrappers: they derive the title and call `runTransformToBytes`
(`lib/document/transform/run-transform.ts`) — the one main-thread seam that captures the compressed Yjs blobs,
admits the job, surfaces warnings, and maps failures, shared with the sheets preview. Inside the Worker,
`renderEigensheetsExport` (`export/sheets/transform.ts`) materializes once and lazily imports only the
requested format's renderer, so an HTML export never evaluates ExcelJS. A recalc failure or an unreadable Yjs
blob comes back as a warning, never as a failed export. There is no main-thread fallback: an overloaded runner
returns `503` and any other transform failure throws.

The XLSX conversion reverses the XLSX import pipeline (`apps/api/src/lib/import/sheets/from-xlsx.ts`), using the
same ExcelJS library. Round-tripped: cell values, formulas, rich-text runs (`ct.s`), styles (font, fill,
alignment, rotation), borders (cell-level and toolbar range borders via `range-borders.ts`; merged-region
perimeters are unioned edge-aware into the ONE style ExcelJS shares across a merge), merged cells, column
widths/row heights, hidden rows/cols, frozen panes (merged into the same view object as `showGridLines`),
the autofilter range, conditional formatting (engine rule order becomes explicit xlsx priorities;
`duplicateValue` exports as a COUNTIF expression — ExcelJS has no native writer for it), data validation
(per-cell rules that ExcelJS re-merges into sqref rectangles), and hyperlinks. Webpage links are scheme-gated
through `resolveWebLink` (`@workspace/lib/sheets/web-link`, the same gate the editor's link navigation uses);
internal links are written in Excel-native `location` form. `renderSheetsHtml` (`sheets/html.ts`) renders the
full workbook for exports; the quick preview shares its internals via `renderSheetsPreviewHtml`, which clips
the first sheet to the preview budget and runs inside the document-transform Worker (see PREVIEWS.md). Both
render webpage hyperlinks as `target="_blank" rel="noopener noreferrer"` anchors through the same scheme
gate (internal links stay plain text — no meaningful target in standalone HTML).

### File Structure

```
apps/api/src/lib/export/sheets/
  transform.ts   # Worker-side: materialized doc → export bytes + warnings, lazy per-format import
  html.ts        # Sheet[] → HTML table (renderSheetsHtml full export + renderSheetsPreviewHtml budgeted preview)
  xlsx.ts        # Sheet[] → XLSX buffer via ExcelJS
  pdf.ts         # Sheet[] → HTML document sized for WeasyPrint
  fonts.ts       # FONT_ARRAY + resolveFontFamily (numeric/string ff → family name)
# content loader: apps/api/src/lib/document/sheets.ts (Yjs snapshot → Sheet[])
```

## Sheets Import

Eigensheets import XLSX via the same shape, reversed — and, like the exports, off the main thread:

```
apps/api/src/lib/import/sheets/
  transform.ts   # Worker-side: uploaded bytes → lean snapshot JSON + warnings
  from-xlsx.ts   # xlsxToSheets(buffer) → Sheet[] (ExcelJS Workbook → sheet cells)
```

| Stage | Where |
|-------|-------|
| ACL and the upload / stored-source size bound (`/import`, `/import-from-drive`, `/convert`) | main thread |
| ZIP guards, ExcelJS parse, mapping, engine recalc, snapshot serialization | Worker |
| Destination creation (convert) and the Yjs commit | main thread, only after the Worker succeeds |

`importIntoDocument` / `convertToDocument` (`import/import-document.ts`) call `runImportToSnapshotJson`
(`lib/document/transform/run-transform.ts`) — the same main-thread seam preview and export use, minus the
Yjs capture — and commit the returned UTF-8 snapshot through `writeSheetsSnapshotToYjs`
(`lib/document/sheets.ts`) without parsing it. The Worker does pure conversion: it never sees an owner,
mount, ACL or destination path, so a failed transform creates no document and mutates no Yjs state. The
`400` (not a valid xlsx) and `413` (too large / too many cells) bodies survive the boundary unchanged, and
a recalc failure comes back as a warning with the parsed values persisted.

`from-xlsx.ts` only produces `Sheet[]`. The importer only needs to emit `celldata` (with
`f` for formula cells) and `config`. `calcChain` and initial computed values are filled in by the Workbook's
mount-time bootstrap — see [SHEETS.md § Mount-time Bootstrap](SHEETS.md#mount-time-bootstrap).

Invariants the importer must uphold:
- **`ct.fa` paired with `ct.t`** — when setting cell type (`t`), always set format assignment (`fa`), defaulting
  to `'General'` if Excel reports no explicit numFmt. Without an `fa`, numfmt falls through to the raw value —
  date serials show as numbers, percents lose their `%` sign, etc.
- **Formula cells use leading `=`** — `f: '=SUM(A1:A3)'`, not `f: 'SUM(A1:A3)'`.

Location-form internal hyperlinks (`<hyperlink location=…>` — what Excel itself and our own exporter write)
never survive ExcelJS's read reconcile, so `from-xlsx.ts` re-reads them from the raw worksheet XML (via
`jszip`, ExcelJS's own zip dependency) and routes them through the same mapping as `#`-prefixed rel targets.

## Docx Import

Eigendoc imports DOCX through the same seam, in the same shape as the sheets import:

```
apps/api/src/lib/import/doc/
  transform.ts   # Worker-side: uploaded bytes → Yjs update + extracted images
  from-docx.ts   # docxToPmJson(buffer) → { json, images } (mammoth → DOMPurify → ProseMirror)
```

| Stage | Where |
|-------|-------|
| ACL and the upload / stored-source size bound (`/import`, `/import-from-drive`, `/convert`) | main thread |
| mammoth parse, sanitization, ProseMirror conversion, ProseMirror → Yjs encoding | Worker |
| Destination creation (convert), the Yjs commit, and the media writes | main thread, only after the Worker succeeds |

The Worker returns a ready Yjs update plus the extracted images, so the ProseMirror-to-Yjs conversion cost
also stays off the event loop. `importIntoDocument` / `convertToDocument` call `runImportToDocumentUpdate`,
commit the update through `writeEigendocUpdateToYjs` (`lib/document/doc.ts`) — which clears the fragment
first, so an import replaces rather than appends — and then write the images into the container's `media/`
folder through Mount. mammoth, JSDOM and DOMPurify are evaluated only inside the Worker; the `400`
(not a valid docx) body survives the boundary unchanged.
