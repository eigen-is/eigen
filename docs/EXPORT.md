# Document Export: DOCX + PDF

## Overview

Export eigendoc documents as DOCX and PDF. Reuses the existing Yjs -> PM JSON pipeline from the preview
system. DOCX serialization runs in a Bun Worker (off main thread). PDF uses WeasyPrint subprocess
(HTML+CSS -> PDF). The file structure accommodates future eigenslides/eigensheets export.

## File Structure

```
apps/api/src/lib/export/
  run-in-worker.ts               # Generic: spawn worker, postMessage, timeout, cleanup
  weasyprint.ts                  # Generic: htmlToPdf(html) -> Buffer via subprocess
  doc/
    content.ts                   # Load eigendoc Yjs -> PM JSON + media map
    html.ts                      # PM JSON -> standalone HTML (images as base64 data URIs)
    docx.ts                      # Orchestrator: loads content, prepares images, spawns worker
    docx-worker.ts               # Worker: receives PM JSON + PNG buffers, serializes to DOCX
    pdf.ts                       # Orchestrator: generates HTML, calls WeasyPrint
  slides/                        # Future: pptx-worker.ts, pptx.ts, pdf.ts
  sheets/                        # Future: xlsx-worker.ts, xlsx.ts, csv.ts
```

### Rationale

- **`doc/`**: eigendoc-specific. Each eigen type gets its own directory — the content models are
  completely different (PM JSON vs Y.Map structures vs fortune-sheet cells)
- **`content.ts`**: extracts the "load Yjs + resolve media" logic from `eigendoc-preview.ts`. Both
  preview and export need the same data. After this exists, `eigendoc-preview.ts` imports from here
- **`html.ts`**: full standalone HTML document with base64 data URIs for images. Used by `pdf.ts`
  as WeasyPrint input. Also useful as standalone HTML export format later
- **`run-in-worker.ts`** at the export root: generic worker spawn utility. Used by DOCX now and by
  future PPTX/XLSX workers. Could also replace the inline worker logic in `thumbnails.ts` later
- **`weasyprint.ts`** at the export root: not eigendoc-specific, all file types can use it for PDF
- **`docx.ts` + `docx-worker.ts`**: orchestrator/worker split. Orchestrator runs on main thread
  (needs Mount for I/O), worker does the CPU-heavy serialization off main thread

## Threading Model

All exports keep the main thread free for other requests.

### DOCX

```
Main thread (docx.ts):                        Worker (docx-worker.ts):
  1. loadEigendocContent() -> PM JSON
  2. For each figure:
     - mount.readFile()
     - thumbnail worker -> PNG buffer
  3. postMessage({ pmJson, images })  -------->  4. Serialize PM -> docx objects
                                                 5. Packer.toBuffer()
  6. Receive DOCX buffer  <--------------------  6. postMessage(docxBuffer)
  7. Return HTTP response
```

Main thread only does I/O (non-blocking). The CPU-heavy work (XML generation, ZIP compression in
`Packer.toBuffer()`) runs in the worker. Images are pre-converted to PNG via the existing thumbnail
worker before being sent to the DOCX worker.

### PDF

```
Main thread (pdf.ts):                         Subprocess (WeasyPrint):
  1. loadEigendocContent() -> PM JSON
  2. renderToHTMLString() with base64 images
  3. Wrap in full HTML doc with print CSS
  4. Bun.spawn(['weasyprint', '-', '-'])  --->  5. Parse HTML + CSS
     write HTML to stdin                        6. Render to PDF
  7. Read PDF from stdout  <------------------  7. Write PDF to stdout
  8. Return HTTP response
```

WeasyPrint is a subprocess, so PDF generation is naturally off main thread. The HTML generation
(step 2-3) is fast string building — no worker needed.

### Generic Worker Utility

`run-in-worker.ts` provides a typed, reusable wrapper for the spawn/message/timeout/cleanup pattern:

```typescript
async function runInWorker<TInput, TOutput>(
    workerUrl: URL,
    input: TInput,
    options?: { transferables?: ArrayBuffer[]; timeout?: number },
): Promise<TOutput>
```

Used by `docx.ts` and future `pptx.ts`/`xlsx.ts`. Same pattern currently used inline in
`thumbnails.ts` — that file could be refactored to use this utility later.

## Route

```
GET /drive/:ownerId/:mountId/file/:pathId/export/:format
```

Added to `apps/api/src/routes/drive.ts`. Follows the existing pattern: `getSharedDrive()` for ACL,
`drive.exportDocument()` for the work. Uses dynamic `await import()` for tiptap chunk splitting.

| MIME                      | `:format` values  |
|---------------------------|-------------------|
| `application/eigendoc`    | `docx`, `pdf`     |
| (future) eigenslides      | `pptx`, `pdf`     |
| (future) eigensheets      | `xlsx`, `csv`     |

Returns 400 for unsupported format, 501 if WeasyPrint not installed (PDF only).

### Drive Class Integration

`getMount()` is private, so export functions receive a `Mount` via a new `Drive.exportDocument()`
method — same pattern as `getTextPreview()` which internally gets the mount and passes it to
`getCollabPreviewData(mount, path)`:

```typescript
// In Drive class
async exportDocument(mountId: string, pathId: string, format: string): Promise<ExportResult> {
    const mount = this.getMount(mountId);
    const path = await mount.getPath(pathId);
    if (!path) throw new ApiError(404, 'File not found');

    if (path.mimeType === 'application/eigendoc') {
        if (format === 'docx') {
            const { exportEigendocToDocx } = await import('../export/doc/docx');
            return exportEigendocToDocx(mount, path);
        }
        if (format === 'pdf') {
            const { exportEigendocToPdf } = await import('../export/doc/pdf');
            return exportEigendocToPdf(mount, path);
        }
    }
    throw new ApiError(400, `Format "${format}" not supported for ${path.mimeType}`);
}
```

Route handler is thin:

```typescript
.get(
    '/drive/:ownerId/:mountId/file/:pathId/export/:format',
    async ({ params, user, set }) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const result = await drive.exportDocument(params.mountId, params.pathId, params.format);
        set.headers['Content-Type'] = result.contentType;
        set.headers['Content-Disposition'] =
            `attachment; filename="${encodeURIComponent(result.fileName)}"`;
        return result.data;
    },
    { auth: true },
)
```

### ExportResult Type

```typescript
type ExportResult = {
    data: Buffer;
    contentType: string;
    fileName: string;   // e.g. "My Document.docx"
};
```

## Content Loader (`content.ts`)

Extracts the shared Yjs loading + media resolution from `eigendoc-preview.ts`:

```typescript
type MediaFile = {
    pathId: string;
    name: string;
    mimeType: string;
};

type EigendocContent = {
    pmJson: JSONContent;
    mediaByName: Map<string, MediaFile>;
};

async function loadEigendocContent(mount: Mount, drivePath: DrivePath): Promise<EigendocContent | null>
```

Implementation: opens `data.db`, calls `loadYjsState()`, converts via `yXmlFragmentToProsemirrorJSON()`,
resolves media folder children into the map. This is lines 15-27 of `eigendoc-preview.ts` extracted.

After this exists, `eigendoc-preview.ts` is refactored to import `loadEigendocContent()`.

## DOCX Export

### Orchestrator (`docx.ts`)

```typescript
async function exportEigendocToDocx(mount: Mount, drivePath: DrivePath): Promise<ExportResult>
```

1. Calls `loadEigendocContent(mount, drivePath)`
2. For each figure node in PM JSON: reads image via `mount.readFile()`, converts to PNG via
   thumbnail worker (with new `outputFormat: 'png'`)
3. Sends `{ pmJson, images, title }` to `docx-worker.ts` via `runInWorker()`
4. Returns `{ data: docxBuffer, contentType: 'application/vnd.openxmlformats...', fileName }`

### Worker (`docx-worker.ts`)

Receives PM JSON + pre-converted PNG image buffers. Pure CPU work, no I/O:

1. Walks PM JSON tree depth-first
2. Maps each node/mark to `docx` package objects
3. Calls `Packer.toBuffer(doc)`
4. Returns DOCX buffer via `postMessage`

Must be added to the build command as an entry point (alongside `thumbnail-worker.ts`).

### Node Serialization Map

| PM Node/Mark       | DOCX Mapping                                              |
|--------------------|------------------------------------------------------------|
| `paragraph`        | `Paragraph` with alignment from textAlign attr             |
| `heading` (1-4)    | `Paragraph` with `HeadingLevel.HEADING_1` etc.            |
| `text`             | `TextRun` with accumulated mark formatting                 |
| `bold`             | `TextRun({ bold: true })`                                  |
| `italic`           | `TextRun({ italics: true })`                               |
| `underline`        | `TextRun({ underline: { type: SINGLE } })`                |
| `strike`           | `TextRun({ strike: true })`                                |
| `code`             | `TextRun({ font: 'Courier New' })`                        |
| `superscript`      | `TextRun({ superScript: true })`                           |
| `subscript`        | `TextRun({ subScript: true })`                             |
| `small`            | `TextRun({ size: 18 })` (9pt)                             |
| `color`            | `TextRun({ color: attrs.color })`                          |
| `fontFamily`       | `TextRun({ font: attrs.fontFamily })`                      |
| `highlight`        | `TextRun({ shading: { fill: attrs.color } })`             |
| `comment`          | **Stripped** (internal-only)                               |
| `link`             | `ExternalHyperlink` wrapping `TextRun`                     |
| `bulletList`       | `Paragraph` with bullet numbering                          |
| `orderedList`      | `Paragraph` with decimal numbering                         |
| `taskList/Item`    | `Paragraph` with checkbox char prefix (U+2610/U+2611)     |
| `blockquote`       | `Paragraph` with left indent + left border                 |
| `codeBlock`        | `Paragraph` with monospace font, gray shading              |
| `horizontalRule`   | `Paragraph` with bottom border                             |
| `table`            | `Table` with `TableRow` / `TableCell`                      |
| `figure`           | `Paragraph` with `ImageRun` + optional caption paragraph   |
| `hardBreak`        | `TextRun({ break: 1 })`                                    |

Figure image sizing: if `width` attr exists, use it at 96 DPI. Otherwise, use natural dimensions
capped at 600px (page width minus margins). Alignment mapped to paragraph alignment.

## PDF Export

### HTML Generator (`html.ts`)

```typescript
async function generateExportHtml(mount: Mount, drivePath: DrivePath): Promise<string>
```

Uses `loadEigendocContent()` + `renderToHTMLString()` from `@tiptap/static-renderer` with the
shared `getDocExtensions()`. Images embedded as base64 data URIs (reads from mount, encodes to
`data:image/...;base64,...`). This avoids WeasyPrint needing auth to fetch embed URLs.

Wraps the HTML fragment in a full document with:
- `@page` rules (A4 margins)
- eigen-prose typography styles (headings, paragraphs, spacing)
- Table borders and padding
- Code block monospace + gray background
- Figure alignment via flexbox
- Task list checkbox styling
- `page-break-inside: avoid` for figures, tables, code blocks

### WeasyPrint Wrapper (`weasyprint.ts`)

```typescript
async function htmlToPdf(html: string): Promise<Buffer>
```

Spawns WeasyPrint as subprocess: `Bun.spawn(['weasyprint', '-', '-', '--encoding', 'utf-8'])`.
Writes HTML to stdin, reads PDF from stdout. Returns 501 error if WeasyPrint is not installed.

Caches the availability check at module level after first call.

### Orchestrator (`pdf.ts`)

```typescript
async function exportEigendocToPdf(mount: Mount, drivePath: DrivePath): Promise<ExportResult>
```

Calls `generateExportHtml()`, feeds result to `htmlToPdf()`, returns ExportResult.

## Thumbnail Worker Extension

`thumbnail-worker.ts` gains `outputFormat?: 'webp' | 'png'` in options. Defaults to `'webp'`.
In `sharpResize()`, switches between `.webp({ quality })` and `.png()`.

`thumbnails.ts` passes the new option through. Adds a convenience helper:

```typescript
async function convertImageToPng(
    source: ImageSource, mimeType: string, fileName: string,
    tmpDir: string, pathId: string, maxSize?: number,
): Promise<{ data: Buffer; width: number; height: number } | null>
```

Uses `maxSize: 1200` for print-quality output (vs 512 for thumbnails).

## Build

The build command gains `docx-worker.ts` as an additional entry point:

```
bun build ... --splitting src/index.ts src/lib/shared/thumbnail-worker.ts src/lib/export/doc/docx-worker.ts --outdir=./build
```

The `docx` package must be externalized (it's in `node_modules/*` which is already external).

## Frontend

### Editor FileMenu (`apps/docs/src/components/docs/editor-toolbar.tsx`)

Add Export submenu as FileMenu children, before the existing Print item:

```
File > ... > Export > Export as DOCX / Export as PDF > Print > ...
```

Download via `<a href={exportUrl}>` click, same pattern as existing download handler.

### Drive Context Menu (`packages/ui/src/components/layout/drive/drive-table.tsx`)

Add Export submenu for eigendoc files (`type === 'doc'`), after Download:

```
Download > Export > Export as DOCX / Export as PDF
```

Add `onExport?: (item: DrivePath, format: string) => void` prop, wired up in `drive-layout.tsx`.

### URL Helper (`packages/lib/src/core/api.ts`)

```typescript
export const getDriveExportUrl = (ownerId: string, mountId: string, pathId: string, format: string) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/export/${format}`;
```

## Dependencies

| Package              | Where           | Purpose                                    |
|----------------------|-----------------|--------------------------------------------|
| `docx` (npm)         | `apps/api/`    | DOCX generation (already installed: 9.6.1) |
| `weasyprint` (system)| Server         | HTML -> PDF (~50-80MB, lighter than Chromium)|

## Files to Create

| File                                               | Purpose                                     |
|----------------------------------------------------|---------------------------------------------|
| `apps/api/src/lib/export/run-in-worker.ts`         | Generic worker spawn utility                |
| `apps/api/src/lib/export/weasyprint.ts`            | WeasyPrint subprocess wrapper               |
| `apps/api/src/lib/export/doc/content.ts`           | Load eigendoc Yjs -> PM JSON + media map    |
| `apps/api/src/lib/export/doc/html.ts`              | PM JSON -> full HTML with base64 images     |
| `apps/api/src/lib/export/doc/docx.ts`              | DOCX orchestrator (main thread)             |
| `apps/api/src/lib/export/doc/docx-worker.ts`       | DOCX serializer (worker thread)             |
| `apps/api/src/lib/export/doc/pdf.ts`               | PDF orchestrator                            |

## Files to Modify

| File                                                              | Change                                   |
|-------------------------------------------------------------------|------------------------------------------|
| `apps/api/src/routes/drive.ts`                                    | Add export route                         |
| `apps/api/src/lib/drive/drive.ts`                                 | Add `exportDocument()` method            |
| `apps/api/src/lib/shared/thumbnail-worker.ts`                     | Add `outputFormat` option                |
| `apps/api/src/lib/shared/thumbnails.ts`                           | Pass `outputFormat`, add `convertImageToPng()` |
| `apps/api/src/lib/preview/eigendoc-preview.ts`                    | Refactor to use content loader           |
| `apps/api/package.json`                                           | Add `docx-worker.ts` to build entry      |
| `apps/docs/src/components/docs/editor-toolbar.tsx`                | Add Export submenu                       |
| `packages/ui/src/components/layout/drive/drive-table.tsx`         | Add Export to context menu               |
| `packages/ui/src/components/layout/drive/drive-layout.tsx`        | Add export handler                       |
| `packages/lib/src/core/api.ts`                                    | Add `getDriveExportUrl`                  |

## Implementation Order

1. **Foundation**: `run-in-worker.ts` + `content.ts` + thumbnail worker extension + refactor eigendoc-preview
2. **DOCX**: `docx.ts` + `docx-worker.ts` + route + Drive method
3. **PDF**: `html.ts` + `weasyprint.ts` + `pdf.ts` + wire into route
4. **Frontend**: editor toolbar + drive context menu + URL helper
5. **Verify**: typecheck + lint + test existing previews

## Edge Cases

- **Empty documents**: return minimal empty file in target format
- **Missing media**: skip image in DOCX, omit from HTML
- **WeasyPrint not installed**: return 501 with install instructions
- **Corrupt Yjs state**: `loadYjsState()` handles this with try/catch
- **Large docs with many images**: images converted one at a time (bounded memory)
- **Comment marks**: stripped from export (internal-only)
- **Code blocks**: monospace + gray background, no syntax highlighting in DOCX
- **Export during active collab**: loads last persisted state (may lag a few seconds)
