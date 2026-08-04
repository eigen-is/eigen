# Document Export: DOCX, PDF, HTML

> **TLDR**: One route exports eigendocs, slides and sheets. Each type renders standalone HTML with
> embedded fonts and base64 images; PDF is that HTML through a WeasyPrint subprocess, DOCX through
> `@turbodocx/html-to-docx`, XLSX straight from `Sheet[]` via ExcelJS. Every HTML body goes through
> `sanitizeExportHtml` — DOMPurify plus a data-URI-only rule that closes SSRF against WeasyPrint.

## Overview

Export eigendoc documents as DOCX, PDF, and HTML. A single HTML pipeline generates standalone HTML with embedded
fonts, base64 images, and flattened eigen-prose CSS. DOCX and PDF are derived from that HTML:

- **HTML**: the standalone HTML document itself
- **DOCX**: HTML fed to `@turbodocx/html-to-docx`
- **PDF**: HTML fed to WeasyPrint subprocess

Eigenslides and eigensheets reuse the same HTML→PDF pipeline (sheets also export native XLSX) — see their
sections below.

## File Structure

Everything lives under `apps/api/src/lib/export/`, one directory per document type (`doc/`, `slides/`,
`sheets/`) over a shared root: `export-document.ts` (dispatch by mime + format), `weasyprint.ts`
(`htmlToPdf`), `sanitize.ts` (`sanitizeExportHtml`), `render-types.ts` (`RenderMode`, `SizeUnit`,
`*ImgSrcResolver`), `fonts.ts` (embedded WOFF2 `@font-face` CSS) and `media.ts` (`buildDataUriMap`
for base64 images, `buildPreviewUrl` for embed URLs). Each type directory holds a `render.ts` of pure
node/object renderers plus one file per output format.

Content loaders (Yjs → PM JSON / `DeckData` / `Sheet[]` + media map) are **not** here — they live in
`apps/api/src/lib/document/` and are shared with preview and the search indexer. See
[DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md).

### Architecture

- **`render.ts`**: pure utility functions with zero side effects — no imports from tiptap, lowlight, or
  any heavy library. Callers pass their own lowlight instance. Shared by both `html.ts` (export) and
  `eigendoc-preview.ts` (quick preview)
- **`export-document.ts`**: thin dispatcher that routes `(mount, path, format)` to the right export
  function. Imported by the drive route, NOT by Drive class — export is not Drive's responsibility
- **`sanitize.ts`**: the one sanitizer every HTML body passes through — see Sanitization and SSRF below
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

Errors: 400 (unsupported format), 501 (WeasyPrint not installed — PDF only), 504 (WeasyPrint killed
by the 60 s render timeout), 500 (WeasyPrint exited non-zero; its stderr is in the message).

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
sanitizeExportHtml()  -- DOMPurify + data:-only url() and <img src>
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

### Sanitization and SSRF

All four HTML pipelines — `doc/html.ts`, `slides/html.ts`, `sheets/html.ts` and `sheets/pdf.ts` —
route their assembled body through `sanitizeExportHtml()` (`apps/api/src/lib/export/sanitize.ts`)
before it is wrapped or handed to a converter. DOCX and the doc/slides PDFs inherit it, because they
are built from that same sanitized HTML.

On top of DOMPurify it adds one rule: **every `url()` in a `style` attribute and every `<img src>`
must be a `data:` URI**; anything else is stripped. That is the SSRF guard. Export embeds all its
resources as data URIs, so a remote reference can only have come from an attacker-controlled CRDT
string (a slide text run, a sheet cell). WeasyPrint fetches such references server-side while
rendering, from the API host, and its CLI has no way to restrict fetch protocols — so the
restriction has to happen here. `<a href>` is deliberately left alone: link targets are not fetched
during render, and docs and sheets carry legitimate http(s) hyperlinks.

The hook is added and removed around each synchronous `DOMPurify.sanitize()` call, so it never leaks
to other DOMPurify users in the process. Regression tests: `apps/api/src/test/export-pdf-ssrf.test.ts`.

### CSS Handling

The export HTML includes three CSS layers:
1. **Embedded fonts** — WOFF2 files base64-encoded into `@font-face` rules
2. **Flattened eigen-prose.css** — modern CSS nesting flattened, `.dark` rules dropped, CSS variables resolved
3. **Print extras** — Tailwind preflight reset, A4 page setup, checkbox sizing, code wrap

### Build Configuration

Production does not run a bundle. `docker/api/Dockerfile` starts the API from TypeScript source
(`bun run src/index.ts`) with a full `bun install`, so the export dependencies —
`@turbodocx/html-to-docx`, `sharp`, `jsdom`, `isomorphic-dompurify` — are ordinary `@apps/api`
dependencies; nothing needs installing separately.

The `buildfordocker` script (`apps/api/package.json`) is a verification build, not a deploy
artifact: it bundles the API and Worker entries to inspect what lands in a Worker's module graph.
It externalizes `sharp`, `jsdom` and `@turbodocx/*` (bundling `@turbodocx` — 1.7MB — changes module
evaluation order and breaks `PATHS.MAIL` initialization in the mail module); `isomorphic-dompurify`
bundles fine and stays in.

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
- **DOMPurify + data URIs**: the doc pipeline passes `ADD_DATA_URI_TAGS: ['img']` to
  `sanitizeExportHtml` so base64 image sources survive

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

Code: `apps/api/src/lib/export/slides/` — `render.ts` (slide/object → HTML strings, `SizeUnit`
abstraction), `html.ts`, `pdf.ts`. Content loader: `apps/api/src/lib/document/slides.ts`.

## Sheets Export

Eigensheets (`.eigensheets`) support XLSX, PDF, and HTML export via the same route:

| Format | Pipeline |
|--------|----------|
| `xlsx`  | Yjs snapshot → `Sheet[]` → ExcelJS workbook |
| `pdf`   | `Sheet[]` → `renderSheetsHtml` → WeasyPrint (page sized to the widest/tallest sheet) |
| `html`  | `Sheet[]` → `renderSheetsHtml` standalone HTML |

All three formats start from `readSheetsContent`, which may **recalc the workbook server-side** before
handing over `Sheet[]` — that is why an xlsx import nobody ever opened still exports with computed
values rather than blanks. See [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md).

The XLSX conversion reverses the XLSX import pipeline (`apps/api/src/lib/import/sheets/from-xlsx.ts`),
using the same ExcelJS library. Round-tripped are cell values, formulas, rich-text runs (`ct.s`),
styles (font, fill, alignment, rotation), merged cells, column widths and row heights, hidden rows and
columns, the autofilter range, and hyperlinks.

Four of those need care:

- **Borders** — cell-level plus toolbar range borders via `range-borders.ts`. Merged-region perimeters
  are unioned edge-aware into the ONE style ExcelJS shares across a merge.
- **Frozen panes** — merged into the same view object as `showGridLines`, since ExcelJS keeps one.
- **Conditional formatting** — engine rule order becomes explicit xlsx priorities. `duplicateValue`
  exports as a COUNTIF expression, because ExcelJS has no native writer for it.
- **Data validation** — per-cell rules, which ExcelJS re-merges into sqref rectangles.

Hyperlinks are scheme-gated. Webpage links go through `resolveWebLink`
(`@workspace/lib/sheets/web-link`) — the same gate the editor's link navigation uses. Internal links
are written in Excel-native `location` form.

`renderSheetsHtml` (`sheets/html.ts`) is shared with the quick preview and takes a `RenderMode`, so
the preview renders only the first sheet (see [PREVIEWS.md](PREVIEWS.md)). It emits webpage hyperlinks
as `target="_blank" rel="noopener noreferrer"` anchors through the same scheme gate; internal links
stay plain text, since there is no meaningful target in standalone HTML.

Code: `apps/api/src/lib/export/sheets/` — `html.ts` (`renderSheetsHtml`), `xlsx.ts`, `pdf.ts`, and
`fonts.ts` (`FONT_ARRAY` + `resolveFontFamily`, numeric/string `ff` → family name). Content loader:
`apps/api/src/lib/document/sheets.ts`.

## Import: XLSX and DOCX

Import is the mirror of export and runs through one dispatcher, `apps/api/src/lib/import/import-document.ts`.
It owns both directions of the conversion UX: `convertToDocument` (a new eigen file from an uploaded
xlsx/docx) and `importIntoDocument` (replace the contents of an existing one).

| Source | Converter | Produces |
|---|---|---|
| `.xlsx` | `apps/api/src/lib/import/sheets/from-xlsx.ts` — `xlsxToSheets(buffer)` | `Sheet[]` |
| `.docx` | `apps/api/src/lib/import/doc/from-docx.ts` — `docxToPmJson(buffer)` | PM JSON + images + schema |

The converters are pure buffer → native-content; the dispatcher writes the result into Yjs through
`writeSheetsToYjs` / `writeEigendocToYjs` and, for docx, saves the extracted images into the document's
`media/` folder so the `figure` nodes resolve by name. Both parsers need the whole file in memory —
they are zip formats — so callers size-check first.

The sheets importer only needs to emit `celldata` (with `f` for formula cells) and `config`. The
dispatcher then runs `recalcSheets()` once, so the persisted snapshot carries engine-verified values
and a `calcChain`; a recalc failure falls back to the parsed values rather than blocking the import.
See [SHEETS.md § Mount-time Bootstrap](SHEETS.md#mount-time-bootstrap).

Invariants the xlsx importer must uphold:
- **`ct.fa` paired with `ct.t`** — when setting cell type (`t`), always set format assignment (`fa`), defaulting
  to `'General'` if Excel reports no explicit numFmt. Without an `fa`, numfmt falls through to the raw value —
  date serials show as numbers, percents lose their `%` sign, etc.
- **Formula cells use leading `=`** — `f: '=SUM(A1:A3)'`, not `f: 'SUM(A1:A3)'`.

Location-form internal hyperlinks (`<hyperlink location=…>` — what Excel itself and our own exporter write)
never survive ExcelJS's read reconcile, so `from-xlsx.ts` re-reads them from the raw worksheet XML (via
`jszip`, ExcelJS's own zip dependency) and routes them through the same mapping as `#`-prefixed rel targets.
