# Document Export: DOCX, PDF, HTML

## Overview

Export eigendoc documents as DOCX, PDF, and HTML. A single HTML pipeline generates standalone HTML with embedded
fonts, base64 images, and flattened eigen-prose CSS. DOCX and PDF are derived from that HTML:

- **HTML**: the standalone HTML document itself
- **DOCX**: HTML fed to `@turbodocx/html-to-docx`
- **PDF**: HTML fed to WeasyPrint subprocess

## File Structure

```
apps/api/src/lib/export/
  export-document.ts             # Entry point: dispatches by mime type + format
  weasyprint.ts                  # Generic: htmlToPdf(html) -> Buffer via subprocess
  modules.d.ts                   # Type declarations for untyped npm packages
  doc/
    render.ts                    # Pure functions: escapeHtml, renderFigureNode, renderCodeBlockNode, renderTaskItemNode, ExportResult type
    content.ts                   # Load eigendoc Yjs -> PM JSON + media map (shared with preview)
    html.ts                      # PM JSON -> standalone HTML (fonts, CSS, base64 images)
    docx.ts                      # DOCX export via html-to-docx
    pdf.ts                       # PDF export via WeasyPrint
```

### Architecture

- **`render.ts`**: pure utility functions with zero side effects — no imports from tiptap, lowlight, or
  any heavy library. Callers pass their own lowlight instance. Shared by both `html.ts` (export) and
  `eigendoc-preview.ts` (quick preview)
- **`content.ts`**: shared Yjs -> PM JSON + media map loader, used by both export and preview
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
loadEigendocContent() -> PM JSON + media map
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
New document > Open > Rename > Export > [separator] > Edit access > ... > Print > Delete
```

### Drive Context Menu (`packages/ui/src/components/layout/drive/drive-table.tsx`)

Export submenu for eigendoc files, driven by `onExport` callback.

## Dependencies

| Package                    | Where           | Purpose                                |
|----------------------------|-----------------|----------------------------------------|
| `@turbodocx/html-to-docx` | `apps/api/`     | HTML -> DOCX conversion (externalized in build) |
| `weasyprint` (system)      | Server          | HTML -> PDF via subprocess             |

## Edge Cases

- **Empty documents**: return minimal empty HTML wrapped in the target format
- **Missing media**: skip image (readFileAsDataUri returns null, no img tag emitted)
- **WeasyPrint not installed**: return 501 with install instructions
- **Corrupt Yjs state**: `loadYjsState()` handles this with try/catch
- **Large docs with many images**: images loaded in parallel via `Promise.all`
- **Code blocks without language**: `lowlight.highlightAuto()` auto-detects the language
- **Task lists**: custom `taskItem` nodeMapping preserves checked/unchecked state
- **Export during active collab**: loads last persisted state (may lag a few seconds)
- **DOMPurify + data URIs**: `ADD_DATA_URI_TAGS: ['img']` preserves base64 image sources
