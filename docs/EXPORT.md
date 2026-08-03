# Document Export: DOCX, PDF, HTML

## Overview

Export eigendoc documents as DOCX, PDF, and HTML. A single HTML pipeline generates standalone HTML with embedded
fonts, base64 images, and flattened eigen-prose CSS. DOCX and PDF are derived from that HTML:

- **HTML**: the standalone HTML document itself
- **DOCX**: HTML fed to `@turbodocx/html-to-docx`
- **PDF**: HTML fed to WeasyPrint subprocess

Eigenslides and eigensheets reuse the same HTML→PDF pipeline (sheets also export native XLSX) — see their
sections below.

## File Structure

```
apps/api/src/lib/export/
  export-document.ts             # Entry point: dispatches by mime type + format
  weasyprint.ts                  # Generic: htmlToPdf(html) -> Buffer via subprocess
  modules.d.ts                   # Type declarations for untyped npm packages
  render-types.ts                # Shared contracts: RenderMode, SizeUnit, *ImgSrcResolver
  fonts.ts                       # Embedded WOFF2 @font-face CSS (Inter, Source Serif 4, JetBrains Mono, Excalifont)
  media.ts                       # buildDataUriMap (base64 images) + buildPreviewUrl (embed URLs)
  doc/
    render.ts                    # Pure node renderers: renderFigureNode, renderCodeBlockNode, renderTaskItemNode
    html.ts                      # PM JSON -> standalone HTML (fonts, CSS, base64 images)
    docx.ts                      # DOCX export via html-to-docx
    pdf.ts                       # PDF export via WeasyPrint

# Content loaders (Yjs -> PM JSON / DeckData / Sheet[] + media map) live in
# apps/api/src/lib/document/{doc,slides,sheets}.ts — shared by export AND preview.
```

### Architecture

- **`render.ts`**: pure utility functions with zero side effects — no imports from tiptap, lowlight, or
  any heavy library. Callers pass their own lowlight instance. Shared by both `html.ts` (export) and
  `eigendoc-preview.ts` (quick preview)
- **content loaders** (`apps/api/src/lib/document/{doc,slides,sheets}.ts`): shared Yjs -> PM JSON / DeckData /
  `Sheet[]` + media map loaders (`readEigendocContent`, `readSlidesContent`, `readSheetsContent`), used by both
  export and preview
- **`export-document.ts`**: thin dispatcher that routes `(mount, path, format)` to the right export
  function. Imported by the drive route, NOT by Drive class — export is not Drive's responsibility
- **`html.ts`**: standalone HTML with base64 data URIs, embedded WOFF2 fonts (via Bun `import ... with
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
const result = await exportDocument(mount, path, params.format);
```

Returns 400 for unsupported format, 501 if WeasyPrint not installed (PDF only).

## HTML Pipeline

```
readEigendocContent() -> PM JSON + media map
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
        +-> HTML export (return as-is)
        +-> DOCX export (feed to @turbodocx/html-to-docx)
        +-> PDF export (feed to WeasyPrint subprocess)
```

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
- **Missing media**: skip image (`buildDataUriMap` omits the entry, so `renderFigureNode` emits no img tag)
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
in `render.ts` lets the same render functions produce either responsive or fixed-size output.

Text objects store HTML (TipTap output). `render.ts` runs `obj.text` through `DOMPurify` and `escapeHtml`s
the highlight color before embedding, so the same value that's safely shown by the FE canvas is also safe
inside the export. The `.slide-text` typography rules live in `packages/ui/src/styles/slide-text.css` and
are imported via `with { type: 'text' }` from `html.ts` so canvas and export render identically.

### File Structure

```
apps/api/src/lib/export/slides/
  render.ts      # Slide/object → HTML strings (SizeUnit abstraction)
  html.ts        # Standalone HTML export
  pdf.ts         # PDF via WeasyPrint
# content loader: apps/api/src/lib/document/slides.ts (Yjs → DeckData + media map)
```

## Sheets Export

Eigensheets (`.eigensheets`) support XLSX, PDF, and HTML export via the same route:

| Format | Pipeline |
|--------|----------|
| `xlsx`  | Yjs snapshot → `Sheet[]` → ExcelJS workbook |
| `pdf`   | `Sheet[]` → `renderSheetsHtml` → WeasyPrint (page sized to the widest/tallest sheet) |
| `html`  | `Sheet[]` → `renderSheetsHtml` standalone HTML |

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
  html.ts        # Sheet[] → HTML table (renderSheetsHtml full export + renderSheetsPreviewHtml budgeted preview)
  xlsx.ts        # Sheet[] → XLSX buffer via ExcelJS
  pdf.ts         # Sheet[] → HTML → WeasyPrint
  fonts.ts       # FONT_ARRAY + resolveFontFamily (numeric/string ff → family name)
# content loader: apps/api/src/lib/document/sheets.ts (Yjs snapshot → Sheet[])
```

## Sheets Import

Eigensheets import XLSX via the same shape, reversed:

```
apps/api/src/lib/import/sheets/
  from-xlsx.ts   # xlsxToSheets(buffer) → Sheet[] (ExcelJS Workbook → sheet cells)
```

`from-xlsx.ts` only produces `Sheet[]`; `import/import-document.ts` writes it into the Yjs state map via
`writeSheetsToYjs` (`apps/api/src/lib/document/sheets.ts`). The importer only needs to emit `celldata` (with
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
