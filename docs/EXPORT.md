# Document Export: DOCX, PDF, HTML

## Overview

Export eigendoc documents as DOCX, PDF, and HTML. A single HTML pipeline generates standalone HTML with embedded
fonts, base64 images, and flattened eigen-prose CSS. DOCX and PDF are derived from that HTML:

- **HTML**: the standalone HTML document itself
- **DOCX**: HTML fed to `@turbodocx/html-to-docx`
- **PDF**: HTML fed to WeasyPrint subprocess

The content loader (`content.ts`) extracts the Yjs -> PM JSON + media resolution logic shared by both
the preview system and the export pipeline. The file structure accommodates future eigenslides/eigensheets export.

## File Structure

```
apps/api/src/lib/export/
  weasyprint.ts                  # Generic: htmlToPdf(html) -> Buffer via subprocess
  doc/
    render.ts                    # Shared: escapeHtml, renderFigureNode, docExtensions, ExportResult, stripEigendocExtension
    content.ts                   # Load eigendoc Yjs -> PM JSON + media map
    html.ts                      # PM JSON -> standalone HTML (fonts, CSS, base64 images)
    docx.ts                      # DOCX export via html-to-docx
    pdf.ts                       # PDF export via WeasyPrint
  slides/                        # Future: pptx.ts, pdf.ts
  sheets/                        # Future: xlsx.ts, csv.ts
```

### Rationale

- **`doc/`**: eigendoc-specific. Each eigen type gets its own directory -- the content models are
  completely different (PM JSON vs Y.Map structures vs fortune-sheet cells)
- **`render.ts`**: shared rendering primitives used by both `html.ts` (export) and `eigendoc-preview.ts`
  (quick preview): `escapeHtml`, `renderFigureNode` (parameterized by image-src resolver), the shared
  tiptap `docExtensions` singleton, `ExportResult` type, and `stripEigendocExtension`
- **`content.ts`**: extracts the "load Yjs + resolve media" logic from `eigendoc-preview.ts`. Both
  preview and export need the same data. `eigendoc-preview.ts` imports from here
- **`html.ts`**: full standalone HTML document with base64 data URIs for images, embedded WOFF2 fonts,
  and flattened eigen-prose CSS (nested CSS flattened for WeasyPrint compatibility). Used directly as
  HTML export and as input for both DOCX and PDF pipelines
- **`weasyprint.ts`** at the export root: not eigendoc-specific, all file types can use it for PDF

## HTML Pipeline

All three export formats start from the same HTML:

```
loadEigendocContent() -> PM JSON + media map
        |
        v
renderToHTMLString() with custom figure nodeMapping (base64 data URIs)
        |
        v
DOMPurify.sanitize() (with ADD_DATA_URI_TAGS for img)
        |
        v
wrapInDocument() -> full HTML with embedded fonts + flattened CSS + print extras
        |
        +-> HTML export (return as-is)
        +-> DOCX export (feed to @turbodocx/html-to-docx)
        +-> PDF export (feed to WeasyPrint subprocess)
```

### CSS Flattening

The shared `eigen-prose.css` uses modern CSS nesting (`.eigen-prose { h1 { ... } }`). Standalone HTML
and WeasyPrint need flat CSS. `flattenEigenProseCSS()` rewrites the shared stylesheet:

1. Rewrites `.eigen-prose, .tiptap { }` to `.eigen-prose { }`
2. Drops `.dark` overrides (export is always light)
3. Flattens nested selectors to `.eigen-prose h1 { }` etc.
4. Resolves CSS variables to concrete values

### Font Embedding

Reads WOFF2 files from `packages/ui/src/assets/fonts/`, base64-encodes them into `@font-face` rules.
Path resolution uses `resolveUiSrcDir()` which tries multiple relative paths to handle dev (source)
and Docker (build) layouts.

Embedded fonts: Inter, Source Serif 4, JetBrains Mono, Excalifont.

## Route

```
GET /drive/:ownerId/:mountId/file/:pathId/export/:format
```

Added to `apps/api/src/routes/drive.ts`. Follows the existing pattern: `getSharedDrive()` for ACL,
`drive.exportDocument()` for the work. Uses dynamic `await import()` for tiptap chunk splitting.

| MIME                      | `:format` values       |
|---------------------------|------------------------|
| `application/eigendoc`    | `docx`, `pdf`, `html`  |
| (future) eigenslides      | `pptx`, `pdf`          |
| (future) eigensheets      | `xlsx`, `csv`          |

Returns 400 for unsupported format, 501 if WeasyPrint not installed (PDF only).

### Drive Class Integration

`getMount()` is private, so export functions receive a `Mount` via `Drive.exportDocument()` -- same
pattern as `getTextPreview()`:

```typescript
async exportDocument(mountId: string, pathId: string, format: string):
    Promise<{ data: Buffer; contentType: string; fileName: string }>
```

### ExportResult Type (in `render.ts`)

```typescript
type ExportResult = {
    data: Buffer;
    contentType: string;
    fileName: string;
};
```

## Content Loader (`content.ts`)

Extracts the shared Yjs loading + media resolution from `eigendoc-preview.ts`:

```typescript
type EigendocContent = {
    pmJson: JSONContent;
    mediaByName: Map<string, MediaFile>;
};

async function loadEigendocContent(mount: Mount, drivePath: DrivePath): Promise<EigendocContent | null>
```

Implementation: opens `data.db`, calls `loadYjsState()`, converts via `yXmlFragmentToProsemirrorJSON()`,
resolves media folder children into the map.

## DOCX Export (`docx.ts`)

Generates standalone HTML via `generateExportHtml()`, feeds it to `@turbodocx/html-to-docx`:

```typescript
async function exportEigendocToDocx(mount: Mount, drivePath: DrivePath): Promise<ExportResult>
```

The library handles HTML-to-OOXML conversion including images, tables, and text formatting.

## PDF Export (`pdf.ts`)

Generates standalone HTML via `generateExportHtml()`, feeds it to WeasyPrint:

```typescript
async function exportEigendocToPdf(mount: Mount, drivePath: DrivePath): Promise<ExportResult>
```

### WeasyPrint Wrapper (`weasyprint.ts`)

```typescript
async function htmlToPdf(html: string): Promise<Buffer>
```

Spawns WeasyPrint as subprocess: `Bun.spawn(['weasyprint', '-', '-', '--encoding', 'utf-8'])`.
Writes HTML to stdin, reads PDF from stdout. Returns 501 error if WeasyPrint is not installed.
Caches the availability check at module level. 60-second timeout with process kill.

## Frontend

### Editor FileMenu (`apps/docs/src/components/docs/editor-toolbar.tsx`)

Export submenu as FileMenu children, before the existing Print item:

```
File > ... > Export > Export as DOCX / Export as PDF / Export as HTML > Print > ...
```

Download via programmatic `<a>` click with `getDriveExportUrl()`.

### Drive Context Menu (`packages/ui/src/components/layout/drive/drive-table.tsx`)

Export submenu for eigendoc files (`type === 'doc'`), after Download:

```
Download > Export > Export as DOCX / Export as PDF / Export as HTML
```

`onExport?: (item: DrivePath, format: string) => void` prop, wired via `drive-list.tsx` and `drive-layout.tsx`.

### URL Helper (`packages/lib/src/core/api.ts`)

```typescript
export const getDriveExportUrl = (ownerId: string, mountId: string, pathId: string, format: string) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/export/${format}`;
```

## Dependencies

| Package                    | Where           | Purpose                                |
|----------------------------|-----------------|----------------------------------------|
| `@turbodocx/html-to-docx` | `apps/api/`     | HTML -> DOCX conversion                |
| `weasyprint` (system)      | Server          | HTML -> PDF (~50-80MB, lighter than Chromium) |

## Edge Cases

- **Empty documents**: return minimal empty HTML wrapped in the target format
- **Missing media**: skip image (readFileAsDataUri returns null, no img tag emitted)
- **WeasyPrint not installed**: return 501 with install instructions
- **Corrupt Yjs state**: `loadYjsState()` handles this with try/catch
- **Large docs with many images**: images loaded sequentially (bounded memory)
- **Comment marks**: stripped by tiptap renderer (not in export extensions)
- **Code blocks**: dark theme (Catppuccin) with syntax highlighting via lowlight
- **Export during active collab**: loads last persisted state (may lag a few seconds)
- **DOMPurify + data URIs**: `ADD_DATA_URI_TAGS: ['img']` preserves base64 image sources
