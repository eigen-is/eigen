# Document Export: DOCX, PDF, HTML

> **TLDR**: One route exports eigendocs, slides, sheets and vector drawings. Each type renders standalone
> HTML (vector: its own SVG, or its scene layers composed as an HTML page for PDF) with embedded fonts and
> base64 images; PDF is that document through a WeasyPrint subprocess, DOCX through
> `@turbodocx/html-to-docx`, XLSX straight from `Sheet[]` via ExcelJS.
> Every rendered body goes through `sanitizeExportHtml` — DOMPurify plus a data-URI-only rule that closes
> SSRF against WeasyPrint — and SVG media bytes get the same pass before they are embedded.

## Overview

Export eigendoc documents as DOCX, PDF, and HTML. A single HTML pipeline generates standalone HTML with embedded
fonts, base64 images, and flattened eigen-prose CSS. DOCX and PDF are derived from that HTML:

- **HTML**: the standalone HTML document itself
- **DOCX**: HTML fed to `@turbodocx/html-to-docx`
- **PDF**: HTML fed to WeasyPrint subprocess

Eigenslides and eigensheets reuse the same HTML→PDF pipeline (sheets also export native XLSX), and eigenvector exports its own SVG (PDF = the same drawing recomposed as HTML layers on a WeasyPrint page) — see their sections below.

Every eigendoc/eigenslides/eigensheets/eigenvector export runs its Yjs reconstruction, rendering and sanitization in the one-shot document-transform Worker ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)): the main thread prepares media, the Worker returns the finished document bytes. The DOCX conversion runs there too — the Worker loads the externalized `@turbodocx/html-to-docx` from runtime `node_modules`. WeasyPrint stays a main-thread subprocess on top of the Worker's HTML.

## File Structure

```
apps/api/src/lib/export/
  export-document.ts             # Entry point: (mime, format) dispatch, the format->envelope table,
                                 #   media prep and the transform seam (runDocumentExport)
  weasyprint.ts                  # Generic: htmlToPdf(html | UTF-8 bytes) -> Buffer via subprocess
  sanitize.ts                    # sanitizeExportHtml: DOMPurify + the call-scoped data-refs-only SSRF hook
  modules.d.ts                   # Type declarations for untyped npm packages
  fonts.ts                       # Embedded WOFF2 @font-face CSS (Inter, Source Serif 4, JetBrains Mono, Excalifont)
  media.ts                       # collectExportMedia: screen previews -> transferable buffers (main thread)
  doc/
    render.ts                    # Pure node renderers + the FigureImgSrcResolver contract they take
    transform.ts                 # Worker-side: materialized doc + media -> HTML bytes, or docx via html-to-docx

# Content loaders (Yjs -> PM JSON / Sheet[] / VectorScene) live in
# apps/api/src/lib/document/{doc,sheets}.ts and packages/lib/src/vector/read-vector.ts —
# shared by export AND preview; readEigendocFromDoc, readSheetsFromDoc and readVectorFromDoc
# are what the Worker calls. Media helpers live in apps/api/src/lib/document/media.ts.
```

### Architecture

- **`render.ts`**: pure utility functions with zero side effects — no imports from tiptap, lowlight, or
  any heavy library. Callers pass their own lowlight instance. Shared by both `doc/transform.ts` (export) and
  `preview/eigendoc-render.ts` (quick preview)
- **Worker side vs main-thread side**: `{doc,canvas,vector,sheets}/transform.ts` assemble the document — over the pure renderers in `*/render.ts` and `sheets/to-xlsx.ts` — and are imported *inside* the Worker; `export-document.ts` is the whole main-thread side, preparing media and calling the seam through one `runDocumentExport`. The split is load-bearing: a module the Worker imports must never reach `preview/preview-cache.ts` (it would drag the screen-preview pipeline, sharp and the sheet engine into every document Worker), which is why `document/media.ts` (light) and `export/media.ts` (screen previews) are separate
- **content loaders** (`apps/api/src/lib/document/{doc,sheets}.ts`, plus `read-vector.ts` in `packages/lib` for both canvas types): every type ships a media-free reader over an already-materialized `Y.Doc` (`readEigendocFromDoc`, `readSheetsFromDoc`, `readVectorFromDoc`) — that is what export, preview and search extraction (`lib/search/extract-render.ts`, the `extract-text` op) call inside the Worker. There is no Mount-side read path: callers capture compressed blobs (`captureCollabSource`) and the Worker materializes them; media maps come from `document/media.ts` on the main thread
- **`export-document.ts`**: routes `(mount, path, format)` through the format->envelope table to one
  `runDocumentExport`. Imported by the drive route, NOT by Drive class — export is not Drive's responsibility
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
its Worker. The response streams nothing while the job queues and its Worker runs, and that silence can
exceed any server-wide idle timeout (Bun caps `idleTimeout` at 255s; queue wait + deadline + WeasyPrint can
pass it), so the export/import/convert routes exempt themselves per-request with `server.timeout(request, 0)`
— without that Bun closes the silent connection (10s documented default; ~30s observed), aborting the signal
and killing the job mid-transform. The transform runs under the 120s export/import deadline
(`TRANSFORM_LIMITS` in `runner.ts`, looked up per job kind by the seam in `run-transform.ts`); WeasyPrint keeps its own
60s subprocess timeout (504 on expiry), and a non-zero WeasyPrint exit is a 500 with its stderr in the message.

## HTML Pipeline

```
main thread: collectExportMedia() (listDocumentMedia + screen previews) -> TransformMedia[]
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
sanitizeExportHtml() (export/sanitize.ts) — DOMPurify + data:-only url()/<img src>, ADD_DATA_URI_TAGS for img
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

`runDocumentExport(job, mount, path, signal?)` (`export-document.ts`) is the single main-thread entry every type and format shares: it derives the title, prepares the media for doc, slides and vector (sheets embed none), then calls `runTransformToBytes` — the same seam the previews use. `html` and `pdf-html` produce the identical document today (WeasyPrint renders exactly what the download serves), and `docx` is that same document converted in the Worker. The `<title>` keeps the UNstripped container name (`Report.eigendoc`) — frozen output, pinned by `document-export-route.test.ts`; the docx document property keeps the stripped name (`Report`).

### Sanitization and SSRF

Every HTML pipeline — doc (`doc/transform.ts`), the canvas documents (`canvas/transform.ts`, `vector/transform.ts`) and the sheets document builders (`sheets/render.ts`) — routes its assembled body through `sanitizeExportHtml()` (`apps/api/src/lib/export/sanitize.ts`) inside the Worker, before it is wrapped or handed to a converter. DOCX and the PDFs inherit it, because they are built from that same sanitized HTML.

On top of DOMPurify it adds one rule: **every `url()` in a `style` attribute or `<style>` element, every `<img src>`, and every SVG `href`/`xlink:href` must be a `data:` URI**; anything else is stripped, and `@import` (whose string form fetches without any `url()`, and which can only exist in element CSS) is removed from style-element text. Backslashes are dropped from CSS before that scan, because a CSS escape spells the same token invisibly to a regex — `\75 rl(…)` and `@\69 mport` are `url(…)` and `@import` to the parser that does the fetching. SVG `<image href>` is covered because DOMPurify keeps it by default and it is a fetch just like `<img src>`; `<a href>` is explicitly exempt. That is the SSRF guard. Export embeds all its resources as data URIs, so a remote reference can only have come from an attacker-controlled CRDT string (a rich-text box's HTML, a sheet cell). WeasyPrint fetches such references server-side while rendering, from the API host, and its CLI has no way to restrict fetch protocols — so the restriction has to happen here. The style-element coverage exists for the sheets exports, which emit their interned class rules in a body `<style>` (SHEETS.md § HTML/PDF export). The same rule is why the vector compositor keeps a gradient or clip reference in an SVG `fill`/`stroke`/`clip-path` attribute and never in CSS — attributes are not scanned, a `style` `url(#…)` would be stripped. `<a href>` is deliberately left alone: link targets are not fetched during render, and docs and sheets carry legitimate http(s) hyperlinks.

A canvas scene gets a second, narrower pass first. `sanitizeSceneHtml` (same file) filters every element's rich-text `html` before the compositor assembles anything, and it filters to the **LightEditor tag set** — `LIGHT_EDITOR_TAGS`/`LIGHT_EDITOR_ATTRS`/`LIGHT_EDITOR_HREF` in `packages/lib/src/core/html.ts`, the same fact the canvas mounts a stored body with (`sanitizeToLightEditorHtml`). One list, one answer to what a rich-text box can hold: a `<table>`, an `<img src="data:…">` or a `<style>` a hostile peer wrote into the Y.Doc is unwrapped on every live client, so it must be unwrapped in the `.svg`/`.html` download, the PDF and the drive hero too. `target` and `rel` opt out of the href-scheme rule (they are not URLs); the assembled-document pass that follows still drops `target` everywhere, as DOMPurify's own profile does.

The hook is added and removed around each synchronous `DOMPurify.sanitize()` call, so it never leaks
to other DOMPurify users in the process. Regression tests: `apps/api/src/test/export/export-pdf-ssrf.test.ts`.

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

### Which formats a type offers

`EIGEN_DOC_TYPE_INFO[type].exportFormats` (`packages/lib/src/types/drive.ts`) is the one list, in menu order: `docx/pdf/html` for a doc, `xlsx/pdf/html` for a sheet, `pdf/html` for a deck, `svg/pdf` for a drawing, nothing for stickies and chat. `exportFormatsFor(type)` reads it. The export route gates on the same list — and each entry narrows to a literal there, so a format added to a type without a Worker envelope for it fails to compile rather than reaching a user as a 400.

### FileMenu (`packages/ui/src/components/layout/toolbar/file-menu.tsx`)

Export submenu rendered when the host passes `onExport` and the type offers formats, positioned after Rename:
```
New document > Open > Rename > Export > [separator] > Share > ... > Print > Delete
```

### Drive Context Menu (`packages/ui/src/components/drive/drive-table.tsx`)

The same submenu on a drive row, driven by the `onExport` callback and the same per-type list.

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
- **Corrupt Yjs state**: `materializeYjsState()` skips the unreadable blob in the Worker and the export comes
  back with a `corrupt-blobs-skipped` warning (logged with the job), never a failure — same behavior as a live read
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

A deck is a canvas of frames, so both formats are the canvas compositor's pages — `framePages(scene, resolveMedia)`, one page per frame in deck order, each `renderCanvasPage`d at scale 0.5. A frame is 1920×1080 and the sheet has always been 16:9 landscape at 960 × 540 px (254mm × 142.875mm at 96 dpi); a `@page` of 1920px would be a 20-inch sheet.

| Format | Pipeline |
|--------|----------|
| `html` | A centred column of fixed 960 × 540 pages, each wrapped in a container-sized fit box that scales it to the width available (`container-type: inline-size` + `transform: scale(calc(100cqw / 960px))` about the top-left corner, the wrapper's height from `aspect-ratio`), plus a `<meta name="viewport">` — so a downloaded deck reads on a phone. A named `@media` ladder is declared first, for a browser that cannot parse the length division. Printing the page column breaks after each slide |
| `pdf`  | The same pages unscaled inside `@page { size: 960px 540px; margin: 0 }` → WeasyPrint. WeasyPrint gives each page its own sheet and has no viewport to be responsive to, so the fit box is a screen-only wrapper |

Both formats embed WOFF2 fonts (via shared `export/fonts.ts`) and base64 images, and both leave through `canvasHtmlDocument` in `export/canvas/transform.ts` — one `<html>` wrapper, one `@page` rule, one font block and one reset for both canvas document types, so the deck's HTML/PDF and the drawing's PDF cannot drift. `renderEigenslidesExport` is the deck's entry; it runs in the document-transform Worker through `runDocumentExport` (`export-document.ts`), which prepares the media on the main thread. An empty deck (no frames) is a 400.

A rich-text element stores TipTap HTML, which a collaborator controls, so the assembled body runs through `sanitizeExportHtml` inside the Worker. The `.eigen-canvas-text` typography rules — the list markers, blockquote rule and link underline an element's inline style cannot reach — live in `packages/ui/src/styles/canvas-text.css` and are embedded via `with { type: 'text' }` by the canvas export document, so canvas and export render identically.

### File Structure

```
apps/api/src/lib/export/canvas/
  render.ts      # Worker-pure compositor: framePages / drawingPage / renderCanvasPage
  transform.ts   # Worker-side: canvasHtmlDocument + renderEigenslidesExport (screen or PDF mode)
# content loader: packages/lib/src/vector/read-vector.ts (readVectorFromDoc)
```

## Vector Export

Eigenvector (`.eigenvector`) drawings export as SVG and PDF via the same route:

| Format | Pipeline |
|--------|----------|
| `svg`  | `sceneToSvg` (the shared `packages/lib/src/vector` serializer previews/embeds also use), media as `data:` URIs, the used `@font-face` blocks spliced into `<defs><style>`, then `sanitizeExportHtml` |
| `pdf`  | The drawing as compositor layers (`export/canvas/render.ts` — `drawingPage` + `renderCanvasPage`) inside the shared `canvasHtmlDocument` (`export/canvas/transform.ts`), which owns the `@page` rule — sized to the artwork — the fonts and the reset → WeasyPrint. Rich text prints because it is an HTML div here; WeasyPrint ignores the `<foreignObject>` the svg arm uses. An empty drawing is a 400 |

`renderEigenvectorExport` lives in `export/vector/transform.ts` and runs in the document-transform Worker like the other types; `collectExportMedia` prepares the media on the main thread. Both arms run their assembled output through `sanitizeExportHtml` inside the Worker — the svg arm with `ADD_TAGS: ['foreignObject']` plus an HTML integration point so the rich-text `<div>` nested in the SVG survives, the compositor arm with the default config, because it emits ordinary HTML and never a `foreignObject`. Media previews serve SVG bytes as-is, so `prepareMedia` (`export/media.ts`) passes `image/svg+xml` media through `sanitizeExportHtml` before it is embedded — a nested `<image href>` inside an SVG data: URI reaches WeasyPrint's fetcher, the same SSRF the assembled document already closes. A transparent drawing keeps its transparency in the SVG download and exports on white paper for PDF.

### The Canvas Compositor

`export/canvas/render.ts` is the one definition of "a page of `sceneLayers` as HTML", shared by all four canvas pipelines: the deck's HTML and PDF exports, the drawing's PDF export, and both previews ([PREVIEWS.md](PREVIEWS.md)). It is Worker-pure — no Mount, no preview cache, no DOM — and it restates no geometry, typography or fill CSS: it calls `layerInnerHtml`, the kind's own `render` (which supplies `richTextCssText`) and `backgroundCss` from `packages/lib`.

- `drawingPage(scene, { resolveMedia })` → one `CanvasPage` sized to the drawing's content bounds plus 10px of padding — the same margin a standalone `sceneToSvg` leaves, absorbing roughjs's overshoot past the geometric bounds — carrying the scene background and the scene's `sceneLayers`. A drawing with no elements has nothing to size a page from and returns `null`: the export answers 400, the preview serves an empty body.
- `framePages(scene, resolveMedia)` → one `CanvasPage` per frame in deck order. A frame IS the page — 0,0-based and a fixed size — so there is no content-bounds arithmetic and no origin offset, and an element that overhangs is clipped by the page box exactly as the live canvas clips it. The resolver is passed because a frame background may be an image; a drawing's background is a colour token.
- `renderCanvasPage(page, scale, resolveMedia?)` → a clipped page div holding the scene at 1:1, with the whole scene scaled **once** (`transform: scale(k)` + `transform-origin: 0 0`) rather than re-unitising each length, because a layer's body is authored in scene pixels by `packages/lib`. Each layer is an absolutely-positioned box at `translate(x,y) rotate(a)` — exactly the box the live canvas uses (`packages/ui` `element-layer.tsx`), so what a user sees is what prints. A rich-text layer *is* its styled div; every other kind is a fragment inside an `overflow="visible"` `<svg>` viewport, because roughjs overshoots its box and an elbow route spills past it.

**A kind's gradient and clip references must stay SVG attributes, pointing inside the layer's own `<svg>`.** A sketchy fill names its own `<defs>` with `fill="url(#…)"` / `stroke="url(#…)"` and a rounded image clips with `clip-path="url(#…)"` — never a CSS declaration. Both halves are load-bearing. `sanitize.ts` rewrites every non-`data:` `url()` it finds in a `style` attribute or a `<style>` block to `url()` (the SSRF rule above), so a gradient moved into CSS silently stops painting in the PDF; and WeasyPrint resolves `url(#id)` only within the same `<svg>` element — a cross-`<svg>` reference renders nothing, silently — so per-element `<defs>` are mandatory.

**Known limitation.** WeasyPrint ignores `clip-rule="evenodd"`, so in a PDF an arrow's shaft strikes through its bound label: the hole punched around the label is an even-odd `clipPath`. The SVG export and the live canvas are correct.

```
apps/api/src/lib/export/canvas/
  render.ts      # Worker-pure compositor: a CanvasPage of sceneLayers → absolutely-positioned HTML
  transform.ts   # Worker-side: canvasHtmlDocument (both canvas types) + renderEigenslidesExport
apps/api/src/lib/export/vector/
  transform.ts   # Worker-side: materialized scene + media → SVG bytes, or the PDF arm over canvasHtmlDocument
# serializer: packages/lib/src/vector/scene-to-svg.ts (sceneToSvg, shared FE/BE)
# content loader: packages/lib/src/vector/read-vector.ts (readVectorFromDoc)
```

## Sheets Export

Eigensheets (`.eigensheets`) support XLSX, PDF, and HTML export via the same route. Every format runs in the
one-shot document-transform Worker ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)), so Yjs
reconstruction, op replay, recalc, rendering, sanitization, and ExcelJS/ZIP work never block the API event
loop:

| Format | Worker | Main thread |
|--------|--------|-------------|
| `xlsx`  | Yjs blobs → `Sheet[]` → ExcelJS workbook → transferred bytes | headers + response |
| `pdf`   | `Sheet[]` → `renderSheetsPdfDocument` (page sized to the widest/tallest sheet) | `htmlToPdf` WeasyPrint subprocess |
| `html`  | `Sheet[]` → `renderSheetsExportDocument` standalone HTML | headers + response |

All three formats go through `runDocumentExport` (`export-document.ts`), the single main-thread entry — it
derives the title and calls `runTransformToBytes` (`lib/document/transform/run-transform.ts`), the one
main-thread seam that captures the compressed Yjs blobs, admits the job, surfaces warnings, and maps failures,
shared with the sheets preview. Inside the Worker,
`renderEigensheetsExport` (`export/sheets/transform.ts`) materializes once and lazily imports only the
requested format's renderer, so an HTML export never evaluates ExcelJS. A recalc failure or an unreadable Yjs
blob comes back as a warning, never as a failed export. There is no main-thread fallback: an overloaded runner
returns `503` and any other transform failure throws.

All three formats materialize through `readSheetsFromDoc`, which may recalc the workbook inside the Worker —
an xlsx import nobody ever opened still exports computed values rather than blanks. Export is the only read
that still recalcs (preview and search extract pass `{ recalc: false }` — SHEETS.md § Server-side recalc);
a legacy workbook whose recalc would exceed the 120s export deadline fails the export, an accepted residual.
See [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md).

The XLSX conversion reverses the XLSX import pipeline (`apps/api/src/lib/import/sheets/from-xlsx.ts`), using the
same ExcelJS library. Round-tripped: cell values, formulas, rich-text runs (`ct.s`), styles (font, fill,
alignment, rotation), borders (per-cell `config.borderInfo` sides; a merge's perimeter is folded onto its
master by `mergedBorderSides` in `packages/lib/src/sheets/borders.ts`, shared with the HTML renderer, because
ExcelJS keeps ONE style across a merge and the HTML table emits one `<td>` for it), merged cells, column
widths/row heights, hidden rows/cols, frozen panes (merged into the same view object as `showGridLines`),
the autofilter range, conditional formatting (engine rule order becomes explicit xlsx priorities;
`duplicateValue` exports as a COUNTIF expression — ExcelJS has no native writer for it), data validation
(per-cell rules that ExcelJS re-merges into sqref rectangles), and hyperlinks. Webpage links are scheme-gated
through `resolveWebLink` (`@workspace/lib/sheets/web-link`, the same gate the editor's link navigation uses);
internal links are written in Excel-native `location` form. `renderSheetsHtml` (`sheets/render.ts`) renders the
full workbook for exports with class-based styles — every style interns into a workbook-global class registry
whose rules ship in a body `<style>` element, so DOMPurify never CSS-parses per-cell inline attributes
(SHEETS.md § HTML/PDF export); the quick preview shares its internals via `renderSheetsPreviewHtml`, which
keeps inline styles (its fragment embeds without a `<head>`), clips
the first sheet to the preview budget and runs inside the document-transform Worker (see PREVIEWS.md). Both
render webpage hyperlinks as `target="_blank" rel="noopener noreferrer"` anchors through the same scheme
gate (internal links stay plain text — no meaningful target in standalone HTML).

### File Structure

```
apps/api/src/lib/export/sheets/
  transform.ts   # Worker-side: materialized doc → export bytes + warnings, lazy per-format import
  render.ts      # Sheet[] → HTML (renderSheetsHtml full export, renderSheetsPreviewHtml budgeted preview,
                 #   renderSheetsExportDocument + renderSheetsPdfDocument standalone documents)
  to-xlsx.ts     # Sheet[] → XLSX buffer via ExcelJS
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
| Destination creation (convert), the write recheck and the Yjs commit | main thread, only after the Worker succeeds |

`importIntoDocument` / `convertToDocument` (`import/import-document.ts`) call `runImportToSnapshotJson`
(`lib/document/transform/run-transform.ts`) — the same main-thread seam preview and export use, minus the
Yjs capture — and commit the returned UTF-8 snapshot through `writeSheetsSnapshotToYjs`
(`lib/document/sheets.ts`) without parsing it. The Worker does pure conversion: it never sees an owner,
mount, ACL or destination path, so a failed transform creates no document and mutates no Yjs state. The
`400` (not a valid xlsx) and `413` (too large / too many cells) bodies survive the boundary unchanged, and
a recalc failure comes back as a warning with the parsed values persisted.

`importIntoDocument` takes the acting user and re-checks write permission immediately before the commit:
the route's check happens before buffering, and the job can queue and transform for minutes, long enough
for the share to be revoked. A revoked writer gets `403 No write permission` and the target stays untouched
(`convertToDocument` needs no recheck — `SharedDrive.create` checks write when it creates the destination).

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
| Destination creation (convert), the write recheck, the Yjs commit and the media writes | main thread, only after the Worker succeeds |

The Worker returns a ready Yjs update plus the extracted images, so the ProseMirror-to-Yjs conversion cost
also stays off the event loop. `importIntoDocument` / `convertToDocument` call `runImportToDocumentUpdate`,
commit the update through `writeEigendocUpdateToYjs` (`lib/document/doc.ts`) — which clears the fragment
first, so an import replaces rather than appends — and then write the images into the container's `media/`
folder through Mount. mammoth, JSDOM and DOMPurify are evaluated only inside the Worker; the `400`
(not a valid docx) body survives the boundary unchanged.
