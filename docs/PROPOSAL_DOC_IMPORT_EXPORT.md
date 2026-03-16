# Proposal: Document Import/Export for Eigen Docs

## TLDR

Add export (eigendoc to PDF, DOCX, Markdown, HTML, TXT) and import (DOCX, Markdown, HTML, TXT to eigendoc). Start with
synchronous Markdown/HTML/TXT export (no queue needed), then add DOCX export via the `docx` npm package, and PDF via
Puppeteer only (drop pdfkit -- building a custom layout engine is not worth it). Import uses mammoth.js for DOCX and
`@tiptap/html` for HTML/Markdown. Skip the job queue until real-world profiling proves it necessary. Share the
server-side Tiptap extension registry with the planned preview system.

---

## Summary of Key Findings

### What the Research Gets Right

1. **Content model inventory is accurate and complete.** Verified against `apps/docs/src/components/docs/editor.tsx` --
   all nodes (paragraph, heading, codeBlock, table, taskList, resizableImage, etc.) and marks (bold, italic, color,
   highlight, comment, etc.) match. The extension configuration in the editor matches what the research documents.

2. **Y.Doc extraction pipeline is correct.** The `DbProvider.loadState()` in `collabDocument.ts` confirms: snapshot
   (latest by id DESC) + incremental updates (where id > snapshot.lastUpdateId) + `Y.applyUpdate()`. The research
   accurately describes this flow.

3. **ResizableImage needs a server-side equivalent.** The frontend `ResizableImage` extension uses
   `ReactNodeViewRenderer` (requires React + DOM), but its `renderHTML()` simply outputs `['img', mergeAttributes()]` --
   a plain `<img>` tag without width/alignment styling. The server extension must add those styles since no React
   NodeView will handle rendering.

4. **`@tiptap/html` works server-side without DOM.** The `generateHTML()` and `generateJSON()` functions use
   ProseMirror's DOM serializer with a minimal shim. No jsdom or browser needed. This is the right foundation.

5. **CommentMark should be stripped on export.** The mark stores a `chatId` referencing a `.eigenchat` directory. No
   standard representation exists in any export format. The server extension should either omit CommentMark entirely or
   render it as a transparent `<span>`.

6. **Image URL resolution is necessary.** Images use Drive embed URLs
   (`/drive/:ownerId/:mountId/file/:pathId/embed/:fileName`). These must be resolved to bytes server-side since exported
   files have no auth context. The research correctly identifies reading directly from storage via
   `mount.readFile(pathId)` rather than making HTTP requests.

7. **mammoth.js limitations are honestly documented.** No colspan/rowspan in tables, lost text colors, dropped
   headers/footers, no text boxes -- all accurate. The "deliberately lossy" philosophy is the right trade-off for import
   (clean ProseMirror content over pixel-perfect reproduction).

### Where the Research Shows Tunnel Vision

**1. The tiered PDF approach (pdfkit + Puppeteer) is over-engineered.**

The research proposes pdfkit as "Tier 1 default" and Puppeteer as "Tier 2 opt-in." This sounds reasonable in the
abstract but falls apart in practice:

- Building a pdfkit layout engine that correctly handles paragraphs, headings, nested lists, task lists, tables
  (with colspan/rowspan), code blocks, images (with alignment/width), blockquotes, text colors, highlights, and
  horizontal rules is a *massive* engineering effort. The research handwaves this with a 6-line `renderNode(doc, node)`
  skeleton, but the real implementation is hundreds of lines of manual coordinate math, text measurement, page-break
  logic, and font management.
- Tables alone in pdfkit require manual cell positioning, border drawing, text wrapping within cells, and handling
  of merged cells -- easily 200+ lines of code that will have edge-case bugs for months.
- Unicode and emoji support in pdfkit requires embedding fonts (the research mentions Noto Sans but does not account
  for CJK, Arabic, or emoji). This is a font-management rabbit hole.
- The "professional and correct" output claim is optimistic. pdfkit output will look noticeably different from the
  editor -- users will report it as buggy even when it is working correctly.

**Recommendation:** Drop pdfkit entirely. Use Puppeteer (or the existing `printDocument()` browser print flow) as the
only PDF path. For users without Chromium, the browser's native Cmd+P / Ctrl+P already works via `printDocument()` and
produces high-fidelity output via the OS print-to-PDF. There is no need to build a second, lower-fidelity PDF engine.

If server-side PDF is needed (for Drive context menu export without opening the doc, or batch export), Puppeteer is the
only practical approach for matching the editor's visual output. The Docker image size concern (300MB) is real but
manageable via a separate Docker image variant. Most self-hosted users who need PDF export will accept the trade-off.

**2. The SQLite job queue is premature optimization.**

The research proposes a full job queue with SQLite schema, Bun Workers, retry logic, dead letter queue, concurrency
limiting, and job cleanup. This is a significant amount of infrastructure for an unproven need.

Measured against reality:
- **Markdown/HTML/TXT export**: <100ms. Synchronous. No queue needed.
- **DOCX export**: The `docx` npm package generates DOCX files from JS objects. For a typical 10-page document with
  5 images, this takes 200-500ms. Synchronous is fine.
- **PDF via Puppeteer**: This is the only genuinely slow operation (2-10s). But is it slow enough to warrant a queue?
  For a single-user self-hosted product, blocking the API for 5 seconds is ugly but not catastrophic -- the event loop
  in Bun is not single-threaded in the same way as Node.js for I/O-bound work.

**Recommendation:** Start without a queue. Make all exports synchronous. If PDF generation blocks the API noticeably
under real load, add a simple async wrapper (not a full queue system) later. The research's queue has retry logic,
exponential backoff, dead letter states, batch IDs, and concurrency limits -- none of which are needed for a
single-server product where exports are user-initiated and infrequent.

If a queue becomes necessary, it should be the simplest possible version: a single `Promise` that the route awaits,
with a timeout. Not a database table with 12 columns.

**3. Client-side vs server-side is a false dichotomy.**

The research assumes all export must be server-side. But for Phase 1, client-side export is simpler, faster to ship,
and needs no new API infrastructure:

- **Markdown export**: The editor already has the ProseMirror JSON in memory. A `pmToMarkdown()` serializer running
  in the browser produces a string that can be downloaded via `URL.createObjectURL()` + `<a download>`. Zero API calls.
- **HTML export**: `editor.getHTML()` is already available in the Tiptap API. Wrap in a template, download.
- **TXT export**: `editor.getText()` exists. Download.
- **PDF export**: `printDocument()` already works. Users can "Save as PDF" from the print dialog. This is the
  zero-infrastructure path that covers 80% of use cases.

Server-side export is only needed for: (a) exporting without opening the document (Drive context menu), (b) batch
export, and (c) DOCX export (which requires the `docx` npm package, better suited to the server). These are Phase 2+
features.

**4. The research does not address collaborative editing snapshot consistency.**

What happens when a document is being actively edited by multiple users and someone exports? The research mentions
"flush pending updates before export (`createSnapshot()`)" but does not explain how to trigger this from the export
endpoint. The `DbProvider.createSnapshot()` is a private method called from within the WebSocket message handler.

The practical answer is simpler than it seems: the export reads from `data.db` directly (same as `loadState()`), which
returns the last persisted state. This may lag behind the live Y.Doc by up to `SNAPSHOT_INTERVAL` (100) updates. For
export purposes, this is acceptable -- the user gets a recent-enough version. Documenting this as "exports reflect the
last saved state, which may be a few seconds behind real-time edits" is sufficient.

**5. Pandoc deserves more consideration.**

The research dismisses Pandoc with one line ("Future option, ~100MB binary"). But Pandoc is a single binary that
handles DOCX, Markdown, HTML, LaTeX, ODT, EPUB, and more -- in both directions. For a self-hosted product that already
ships a Docker image, adding a ~70MB static binary is less painful than maintaining custom converters for each format
pair. The `docx` npm package + mammoth.js together solve DOCX import/export, but Pandoc does it with one tool and also
unlocks ODT, LaTeX, and EPUB for free.

The trade-off: Pandoc is a subprocess call (not a JS library), so error handling is less ergonomic. But its output
quality for DOCX round-trips is substantially better than mammoth.js (which is deliberately lossy).

**Recommendation:** Evaluate Pandoc seriously for Phase 2+. For Phase 1, the JS-only approach (mammoth + docx) is
appropriate since it avoids the subprocess dependency.

**6. Export permissions are unaddressed.**

The research never discusses who can export. Currently, the Drive ACL system has `canRead` and `canWrite` permissions.
Export should require `canRead` -- any user who can view the document should be able to export it. This matches Google
Docs behavior (viewers can download). The existing `getSharedDrive()` call in routes already enforces team/org
membership. The export route should follow the same pattern.

---

## Architecture Decision: Hybrid (Client-Side First, Server-Side Later)

### Phase 1: Client-side export (no API changes)

For documents that are already open in the editor, export directly from the browser:

| Format | Method | Latency |
|--------|--------|---------|
| Markdown | Custom `pmToMarkdown()` serializer on ProseMirror JSON from editor state | <50ms |
| HTML | `editor.getHTML()` wrapped in a styled template | <50ms |
| TXT | `editor.getText()` | <10ms |
| PDF | Existing `printDocument()` (browser print dialog with "Save as PDF") | 0ms (browser-native) |

Download via `Blob` + `URL.createObjectURL()` + synthetic `<a>` click. No API involvement.

### Phase 2: Server-side export (for Drive integration)

Add server-side pipeline for exporting without opening the document:

| Format | Method | Where |
|--------|--------|-------|
| DOCX | ProseMirror JSON -> `docx` npm package | API route |
| PDF | Server-side HTML generation -> Puppeteer (if available) | API route |
| Markdown/HTML/TXT | Server-side Y.Doc -> ProseMirror JSON -> serializer | API route |

### Phase 3: Import

Server-side conversion of uploaded files to eigendoc format.

---

## Export Pipeline (eigendoc to format)

### Client-Side Export (Phase 1)

The editor already has the document content in memory as ProseMirror state. No Y.Doc round-trip needed.

```
editor.getJSON() -> ProseMirror JSON
  |
  +--> pmToMarkdown(json)    -> download .md
  +--> editor.getHTML()      -> wrap in template -> download .html
  +--> editor.getText()      -> download .txt
  +--> printDocument()       -> browser print dialog (PDF via OS)
```

**New files for Phase 1:**

| File | Purpose |
|------|---------|
| `packages/lib/src/core/docs/export/to-markdown.ts` | ProseMirror JSON to Markdown serializer |
| `packages/lib/src/core/docs/export/to-html.ts` | HTML template wrapper (add CSS for standalone HTML file) |
| `packages/lib/src/core/docs/export/download.ts` | `downloadAsFile(content, filename, mimeType)` utility |
| `apps/docs/src/components/docs/export-menu.tsx` | Export submenu added to the File dropdown in editor-toolbar |

The Markdown serializer walks the ProseMirror JSON tree and produces a GFM-compatible string. It handles:
- Headings (ATX `#` style)
- Paragraphs, hard breaks
- Bold, italic, strikethrough, code (inline marks)
- Links (`[text](url)`)
- Images (`![alt](src)`)
- Bullet lists, ordered lists (with start number), task lists (`- [x]`)
- Code blocks (fenced, with language)
- Blockquotes (`>`)
- Horizontal rules (`---`)
- Tables (GFM pipe tables -- colspan/rowspan are flattened)

Features that are lost in Markdown (documented to the user): text color, highlight color, text alignment, underline,
subscript, superscript, image width/alignment, table cell merging.

### Server-Side Export (Phase 2)

For Drive context menu export (without opening the document):

```
POST /docs/:ownerId/:mountId/:pathId/export
  Body: { format: 'pdf' | 'docx' | 'markdown' | 'html' | 'txt' }
  Response: file blob (Content-Disposition: attachment)
```

Server-side pipeline:

```
1. Load data.db from eigendoc folder via Drive/Mount
2. Read Y.Doc state (snapshot + updates) -- reuse DbProvider logic
3. yDocToProsemirrorJSON(yDoc, 'default') -> ProseMirror JSON
4. Format-specific conversion:
   - HTML:     generateHTML(json, serverExtensions) -> resolve images to base64 -> wrap in template
   - Markdown: pmToMarkdown(json)  (same code as client-side, shared in packages/lib)
   - TXT:      extract text content from JSON tree
   - DOCX:     pmToDocx(json, resolvedImages) -> Packer.toBuffer()
   - PDF:      generateHTML() -> resolve images -> Puppeteer page.pdf()
5. Return file with Content-Disposition header
```

**New files for Phase 2:**

| File | Purpose |
|------|---------|
| `packages/lib/src/core/docs/server-extensions.ts` | Server-safe Tiptap extension registry (shared with preview system) |
| `apps/api/src/lib/docs/doc-content.ts` | `loadDocContent(drive, mountId, pathId)` -- extracts ProseMirror JSON from eigendoc |
| `apps/api/src/lib/docs/export-service.ts` | Format-specific export functions |
| `apps/api/src/lib/docs/image-resolver.ts` | Resolves Drive embed URLs to image bytes/base64 |
| `apps/api/src/routes/docs.ts` | Export route |

### Server-Side Tiptap Extension Registry

This is shared infrastructure that both export and the preview system (see PREVIEWS.md) will use.
Place it in `packages/lib` so both `apps/api` and `apps/docs` can import it.

The server extension list must mirror the editor's extensions (minus Collaboration, CollaborationCursor,
CharacterCount, Typography -- none of which affect content rendering):

- StarterKit (with `history: false`, `codeBlock: false`)
- Underline, Subscript, Superscript
- TextStyle, Color
- TextAlign (types: `['heading', 'paragraph']`)
- TaskList, TaskItem (nested: true)
- Link
- Highlight (multicolor: true)
- CodeBlockLowlight (lowlight with `common`)
- Table (resizable: true), TableRow, TableCell, TableHeader
- ServerResizableImage (custom node matching frontend's `resizableImage` name/attrs, adding width/alignment as inline styles)

**CommentMark handling:** The server extension should include a stripped-down CommentMark that renders as a plain
`<span>` (no class, no data attribute). Alternatively, strip comment marks from the JSON before passing to
`generateHTML()`. The latter is simpler and avoids polluting the HTML output.

### ResizableImage: Server vs Client

The frontend `ResizableImage.renderHTML()` outputs `['img', mergeAttributes(HTMLAttributes)]` -- a bare `<img>` tag.
The `width` and `alignment` attributes are present in the HTML attributes but are not rendered as CSS styles.

The server extension must produce styled output:

```typescript
renderHTML({ HTMLAttributes }) {
    const { alignment, width, ...rest } = HTMLAttributes;
    const imgStyle = width ? `width: ${width}px; max-width: 100%;` : 'max-width: 100%;';
    const wrapperStyle = `display: flex; justify-content: ${
        alignment === 'left' ? 'flex-start' : alignment === 'right' ? 'flex-end' : 'center'
    };`;
    return ['div', { style: wrapperStyle }, ['img', { ...rest, style: imgStyle }]];
}
```

This ensures exported HTML correctly positions and sizes images.

---

## Import Pipeline (format to eigendoc)

### Overview

Import creates a new `.eigendoc` file from an uploaded document. The original file is preserved.

```
1. Read source file bytes from Drive (it is already uploaded)
2. Detect format by MIME type + extension
3. Validate (size limits, safety checks)
4. Convert to ProseMirror JSON:
   - DOCX: mammoth.js -> HTML -> generateJSON(html, serverExtensions) -> PM JSON
   - Markdown: markdown-it -> HTML -> generateJSON(html, serverExtensions) -> PM JSON
   - HTML: DOMPurify sanitize -> generateJSON(html, serverExtensions) -> PM JSON
   - TXT: wrap lines in <p> tags -> generateJSON(html, serverExtensions) -> PM JSON
5. Extract and upload images (DOCX: from ZIP; Markdown: resolve relative paths)
6. Rewrite image URLs in PM JSON to Drive embed URLs
7. Create .eigendoc folder (data.db + media/ + chat/)
8. Initialize Y.Doc with PM JSON content, write state to data.db
9. Return new eigendoc path + import warnings
```

### DOCX Import

Library: `mammoth` (npm package, pure JS, ~80KB).

mammoth converts DOCX to semantic HTML. This is deliberately lossy -- it strips visual-only formatting and produces
clean content that maps well to ProseMirror's content model. The conversion:

```
DOCX (ArrayBuffer)
  -> mammoth.convertToHtml({ arrayBuffer }, { convertImage: ... })
  -> { value: html, messages: warnings[] }
  -> generateJSON(html, serverExtensions)
  -> ProseMirror JSON
```

Image handling: mammoth's `convertImage` callback yields image buffers extracted from the DOCX ZIP. Each image is
uploaded to the new eigendoc's `media/` folder, and the URL in the HTML is replaced with a Drive embed URL.

**Known losses** (show to user as import warnings):
- Tables lose colspan/rowspan (mammoth produces flat tables)
- Text colors and highlights are stripped
- Headers, footers, page numbers are dropped
- Text boxes, shapes, SmartArt are dropped
- Custom fonts are normalized
- Tracked changes are dropped
- Equations (MathML/OMML) are dropped

### Markdown Import

Library: `markdown-it` (for parsing) + `@tiptap/html`'s `generateJSON()` (for PM JSON generation).

```
Markdown string
  -> markdown-it.render(markdown)  (with GFM tables, task lists, and strikethrough plugins)
  -> HTML string
  -> generateJSON(html, serverExtensions)
  -> ProseMirror JSON
```

Image handling: Markdown images (`![alt](src)`) can be:
- External URLs (`https://...`): Keep as-is (referenced, not embedded)
- Relative paths (`./image.png`): Resolve relative to the markdown file's location in Drive, copy to `media/` folder

### HTML Import

HTML is sanitized via DOMPurify (already a dependency: `isomorphic-dompurify`), then parsed via `generateJSON()`.
This is the simplest import path since Tiptap natively understands HTML.

### TXT Import

Each line becomes a `<p>` tag. Empty lines create empty paragraphs. The simplest possible import.

### Initializing Y.Doc with ProseMirror JSON

After obtaining ProseMirror JSON from import, we need to create a Y.Doc containing this content and persist it to
`data.db`. This requires:

1. Create a Y.Doc
2. Use `prosemirrorJSONToYDoc()` from `y-prosemirror` (the inverse of `yDocToProsemirrorJSON()`) to populate the
   Y.Doc's XML fragment with the ProseMirror content
3. Encode the Y.Doc state as a binary snapshot via `Y.encodeStateAsUpdate(doc)`
4. Insert the snapshot into the `doc_snapshots` table of the new eigendoc's `data.db`

This requires `y-prosemirror` as an API dependency (currently only in `apps/docs`).

**New files for import:**

| File | Purpose |
|------|---------|
| `apps/api/src/lib/docs/import-service.ts` | Format detection, orchestration, warning collection |
| `apps/api/src/lib/docs/converters/docx-to-pm.ts` | DOCX -> ProseMirror JSON via mammoth |
| `apps/api/src/lib/docs/converters/markdown-to-pm.ts` | Markdown -> ProseMirror JSON |
| `apps/api/src/lib/docs/converters/html-to-pm.ts` | HTML -> ProseMirror JSON (with sanitization) |
| `apps/api/src/lib/docs/converters/txt-to-pm.ts` | TXT -> ProseMirror JSON |
| `apps/api/src/lib/docs/ydoc-initializer.ts` | Creates and persists Y.Doc from ProseMirror JSON |

---

## Queue System: Do We Need One?

**No, not for Phase 1-3.**

| Operation | Expected Duration | Queue Needed? |
|-----------|-------------------|---------------|
| Markdown/HTML/TXT export (client-side) | <50ms | No |
| Markdown/HTML/TXT export (server-side) | <200ms | No |
| DOCX export | 200-500ms typical, <2s with many images | No |
| PDF export (Puppeteer) | 2-10s | Maybe |
| DOCX import | 500ms-2s | No |
| Markdown import | <200ms | No |

For PDF export via Puppeteer, 2-10 seconds of blocking is not ideal but is tolerable for a single-user self-hosted
product where exports are infrequent. The API uses Bun's event loop, which handles concurrent I/O; the CPU-bound
Puppeteer work runs in Chromium's process, not in Bun's main thread.

If queue becomes necessary later (evidence: users report API unresponsiveness during PDF export), the simplest viable
approach is:

1. Return `202 Accepted` with a job ID
2. Run export in `setTimeout(() => ..., 0)` (deferred execution, not a Worker)
3. Send SSE notification on completion with download URL
4. Client polls or listens for SSE event, then downloads

This is 50 lines of code, not the 200+ line SQLite-backed queue with retry logic, dead letter states, and batch IDs
that the research proposes.

---

## PDF Generation: Final Recommendation

**Drop pdfkit. Use Puppeteer as the sole server-side PDF engine. Keep browser print as the zero-config fallback.**

### Rationale

| Option | Effort | Quality | Dependencies |
|--------|--------|---------|--------------|
| Browser print (`printDocument()`) | 0 (exists) | Excellent (matches editor exactly) | None |
| Puppeteer | Low-medium (HTML template + page.pdf()) | Excellent (CSS-rendered) | Chromium (~300MB) |
| pdfkit | Very high (custom layout engine) | Good but different from editor | None (pure JS) |

The browser print path already exists and produces the highest-fidelity output. Adding "Export as PDF" via
server-side Puppeteer only makes sense for use cases where the document is not open (Drive context menu, batch
export, API integration).

When Puppeteer is not available (no Chromium installed), the export endpoint should return an error instructing the
user to use the browser's print function or install Chromium. This is clearer than offering a degraded pdfkit output
that looks different from the editor.

### Puppeteer Integration

Use `puppeteer-core` (no bundled Chromium -- user provides it):

```typescript
const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || findChromium(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
```

Maintain a persistent browser instance (reuse across exports). Create a new page per export, close after.

### Docker Support

Provide two Dockerfile variants:
- `Dockerfile` (default): No Chromium. PDF export via browser print only.
- `Dockerfile.chromium`: Includes Chromium for server-side PDF export.

---

## DOCX Import/Export: Concrete Library Choices

### Export: `docx` npm package

The `docx` package provides a TypeScript-first declarative API for building DOCX files. It handles the Open XML
structure, ZIP packaging, and binary embedding.

The conversion walks the ProseMirror JSON tree and maps each node/mark to `docx` objects:
- `paragraph` -> `Paragraph` with alignment
- `heading` -> `Paragraph` with `HeadingLevel`
- `bulletList`/`orderedList` -> `Paragraph` with `NumberingLevel`
- `taskList` -> `Paragraph` with checkbox `SymbolRun`
- `codeBlock` -> `Paragraph` with monospace font
- `table` -> `Table` with `TableRow`/`TableCell` (supports colspan/rowspan)
- `resizableImage` -> `ImageRun` with binary data and dimensions
- `blockquote` -> `Paragraph` with left indent
- `horizontalRule` -> `Paragraph` with bottom border
- Inline marks: `TextRun` with `bold`, `italic`, `strike`, `underline`, `font`, `color`, `highlight`

Image handling:
1. Parse Drive embed URLs from `resizableImage` nodes
2. Read image bytes from storage via `mount.readFile()`
3. Convert WebP/SVG to PNG via `sharp` (already an API dependency)
4. Determine dimensions from node attributes + image metadata
5. Create `ImageRun` with buffer data

**Limitations:**
- Syntax highlighting in code blocks is not preserved (monospace only)
- Custom fonts are not used (system defaults)
- No header/footer support (eigendoc has no concept of these)

### Import: `mammoth` npm package

See Import Pipeline section above. Key limitation: mammoth is deliberately lossy. Users must be warned about expected
losses. The import report dialog should surface mammoth's `messages` array (which contains warnings about unsupported
features).

---

## Markdown Import/Export: Concrete Approach

### Export (eigendoc -> Markdown)

Use a custom ProseMirror JSON to Markdown serializer (Approach B from the research). This is preferred over
`tiptap-markdown`'s serializer because:

1. `tiptap-markdown`'s `getMarkdown()` requires an editor instance, which requires a DOM on the server.
2. A custom serializer is ~150 lines of code and gives full control over output formatting.
3. The same code runs client-side (Phase 1) and server-side (Phase 2) since it operates on plain JSON.

The serializer lives in `packages/lib/src/core/docs/export/to-markdown.ts` and is shared between frontend and API.

### Import (Markdown -> eigendoc)

Use `markdown-it` to parse Markdown to HTML, then `generateJSON()` to convert to ProseMirror JSON. This is the
standard approach and works well for GFM-compatible Markdown.

Add `markdown-it` plugins for:
- GFM tables (`markdown-it-table`)
- Task lists (`markdown-it-task-lists`)
- Strikethrough (`markdown-it-strikethrough-alt` or the built-in GFM strikethrough)

---

## Server-Side Tiptap: What Is Needed

### New API Dependencies

| Package | Purpose | Already in workspace? |
|---------|---------|----------------------|
| `@tiptap/html` | `generateHTML()` / `generateJSON()` | No |
| `@tiptap/core` | Extension runtime | No (in `apps/docs` only) |
| `@tiptap/starter-kit` | StarterKit for server | No (in `apps/docs` only) |
| `@tiptap/extension-*` (12 packages) | Match frontend extensions | No (in `apps/docs` only) |
| `y-prosemirror` | `yDocToProsemirrorJSON()` + `prosemirrorJSONToYDoc()` | No (in `apps/docs` only) |
| `lowlight` | Syntax highlighting for code blocks | No (in `apps/docs` only) |
| `docx` | DOCX generation | No |
| `mammoth` | DOCX import | No |
| `markdown-it` | Markdown parsing | No |
| `puppeteer-core` | PDF generation (optional) | No |

These are all pure JS packages (except `puppeteer-core` which is a client library for an external Chromium binary).
Total additional JS bundle size for the API: ~500KB gzipped. Acceptable.

### Sharing Extensions Between Frontend and API

The server extension list is defined once in `packages/lib/src/core/docs/server-extensions.ts`. The frontend editor
in `apps/docs` imports from this shared location and adds its frontend-only extensions (Collaboration,
CollaborationCursor, CharacterCount, Typography, the React-based ResizableImage, CommentMark with click handler).

This ensures the server and client extension sets stay in sync. When a new extension is added to the editor, the
developer must also add it to the shared registry -- enforced by convention and verified by export tests.

Note: the `packages/lib` package currently depends on `@apps/api` (see its package.json). Adding Tiptap extensions
to `packages/lib` means they become transitive dependencies of the API, which is the correct direction. However,
the Tiptap extension packages must also be added to `packages/lib/package.json`.

---

## UI Design

### Export Actions (Phase 1 -- from editor toolbar)

Add an "Export" submenu to the existing File dropdown in `editor-toolbar.tsx`:

```
File
  New document
  Open
  Rename
  ---
  Edit access
  Print                    (existing -- browser print dialog)
  ---
  Export as Markdown        (.md)
  Export as HTML             (.html)
  Export as plain text       (.txt)
  Export as PDF              (browser print dialog, same as Print)
  ---
  Delete
```

In Phase 2, when server-side DOCX export is available:

```
  Export as Markdown
  Export as DOCX
  Export as HTML
  Export as plain text
  Export as PDF
```

### Export Actions (Phase 2 -- from Drive context menu)

When right-clicking an `.eigendoc` file in Drive:

```
Open
Open in new tab
---
Export as >
  PDF
  DOCX
  Markdown
  HTML
---
Share
Rename
Move to...
Delete
```

### Import Actions

**From Drive context menu** (right-clicking `.docx`, `.md`, `.html`, `.txt` files):

```
Open
Preview
---
Convert to Eigen Doc
---
Download
Rename
Delete
```

**From Docs File menu:**

```
File
  New document
  Open
  Import from file...     (opens file picker: .docx, .md, .html, .txt)
```

### Import Report Dialog

After import, show a dialog with:
- Name of the created eigendoc
- List of warnings from the conversion (mammoth messages, etc.)
- "Open Document" button
- "Close" button

### No Progress Dialog for Phase 1-2

Since all operations are synchronous or fast enough (<2s), no progress dialog is needed. Show a loading spinner on the
button and a toast notification on completion. If PDF export via Puppeteer proves slow enough to warrant a progress
indicator, add it as a targeted enhancement -- not a general-purpose progress system.

---

## Concrete File Changes

### Phase 1: Client-Side Export (Markdown/HTML/TXT/PDF)

| File | Change |
|------|--------|
| `packages/lib/src/core/docs/export/to-markdown.ts` | **New.** ProseMirror JSON -> Markdown serializer |
| `packages/lib/src/core/docs/export/to-html.ts` | **New.** HTML template wrapper with inline CSS |
| `packages/lib/src/core/docs/export/download.ts` | **New.** `downloadAsFile()` browser utility |
| `packages/lib/src/core/docs/export/index.ts` | **New.** Re-exports |
| `packages/lib/package.json` | No change (no new deps for client-side export) |
| `apps/docs/src/components/docs/editor-toolbar.tsx` | **Modify.** Add Export submenu to File dropdown |

### Phase 2: Server-Side Export (DOCX + all formats from Drive)

| File | Change |
|------|--------|
| `packages/lib/src/core/docs/server-extensions.ts` | **New.** Shared Tiptap extension registry |
| `packages/lib/package.json` | **Modify.** Add `@tiptap/*` deps, `lowlight` |
| `apps/api/package.json` | **Modify.** Add `docx`, `puppeteer-core` (optional), `y-prosemirror` |
| `apps/api/src/lib/docs/doc-content.ts` | **New.** Load Y.Doc -> PM JSON from eigendoc |
| `apps/api/src/lib/docs/export-service.ts` | **New.** Export orchestration (format routing, image resolution) |
| `apps/api/src/lib/docs/image-resolver.ts` | **New.** Drive embed URL -> image bytes |
| `apps/api/src/lib/docs/to-docx.ts` | **New.** ProseMirror JSON -> DOCX via `docx` package |
| `apps/api/src/lib/docs/pdf-service.ts` | **New.** HTML -> PDF via Puppeteer (if available) |
| `apps/api/src/routes/docs.ts` | **New.** Export route |
| `packages/ui/src/components/layout/drive/drive-table.tsx` | **Modify.** Add "Export as" submenu to context menu |

### Phase 3: Import

| File | Change |
|------|--------|
| `apps/api/package.json` | **Modify.** Add `mammoth`, `markdown-it` |
| `apps/api/src/lib/docs/import-service.ts` | **New.** Import orchestration |
| `apps/api/src/lib/docs/converters/docx-to-pm.ts` | **New.** |
| `apps/api/src/lib/docs/converters/markdown-to-pm.ts` | **New.** |
| `apps/api/src/lib/docs/converters/html-to-pm.ts` | **New.** |
| `apps/api/src/lib/docs/converters/txt-to-pm.ts` | **New.** |
| `apps/api/src/lib/docs/ydoc-initializer.ts` | **New.** Create Y.Doc from PM JSON, persist to data.db |
| `apps/api/src/routes/docs.ts` | **Modify.** Add import route |
| `packages/ui/src/components/layout/drive/drive-table.tsx` | **Modify.** Add "Convert to Eigen Doc" to context menu |
| `apps/docs/src/components/docs/editor-toolbar.tsx` | **Modify.** Add "Import from file..." to File menu |

---

## Security Considerations

### DOCX Import

1. **ZIP bomb detection**: Before passing to mammoth, validate the DOCX file:
   - Maximum compressed file size: 50MB (already enforced by Drive upload limit of 35MB)
   - Maximum uncompressed size: 500MB (check via ZIP entry headers)
   - Reject files containing `vbaProject.bin` (VBA macros) with a warning

2. **XML entity expansion (Billion Laughs)**: mammoth.js uses a standard XML parser. Set entity expansion limits if
   the parser supports it. As a practical defense, the uncompressed size check catches most XML bombs.

3. **Image extraction**: Images from DOCX should be validated via `sharp` before storage (this catches corrupted or
   adversarial image files). Sharp already handles this gracefully by throwing on invalid input.

### HTML Import

1. **XSS prevention**: Run all HTML through DOMPurify (already an API dependency) before passing to `generateJSON()`.
   Whitelist only the HTML elements and attributes that Tiptap's content model supports.

2. **External resource loading**: `generateJSON()` does not load external resources -- it only parses the HTML string.
   Image URLs are stored as strings in the ProseMirror JSON, not fetched during import.

### Export

1. **Auth on export endpoints**: Export routes must use `{auth: true}` and `getSharedDrive()` to verify read
   permissions. Same pattern as existing Drive routes.

2. **Puppeteer sandboxing**: The HTML content passed to `page.setContent()` is generated server-side from ProseMirror
   JSON via `generateHTML()`. It does not contain user-controlled JavaScript. Image URLs are pre-resolved to base64
   data URIs. The Puppeteer page has no network access (content is self-contained).

3. **File size limits on export**: Set a maximum eigendoc size for export (10MB Y.Doc state). Documents exceeding this
   should return a clear error rather than attempting a slow, memory-intensive export.

---

## Testing Strategy

### Unit Tests

| Test | Location | What |
|------|----------|------|
| Markdown serializer | `packages/lib/src/core/docs/export/__tests__/to-markdown.test.ts` | PM JSON fixtures -> expected markdown strings |
| HTML template | `packages/lib/src/core/docs/export/__tests__/to-html.test.ts` | PM JSON -> HTML with correct structure/styles |
| DOCX export | `apps/api/src/test/docs/export-docx.test.ts` | PM JSON -> DOCX buffer -> unzip -> verify content |
| Import converters | `apps/api/src/test/docs/import-*.test.ts` | Source format -> PM JSON -> verify structure |
| Image resolver | `apps/api/src/test/docs/image-resolver.test.ts` | Drive URLs -> resolved image data |
| Y.Doc initializer | `apps/api/src/test/docs/ydoc-initializer.test.ts` | PM JSON -> Y.Doc -> readback -> same PM JSON |
| Server extensions | `packages/lib/src/core/docs/__tests__/server-extensions.test.ts` | Extension list matches editor |

### Integration Tests

| Test | What |
|------|------|
| Export round-trip (Markdown) | Create eigendoc -> export as Markdown -> verify content |
| Export round-trip (HTML) | Create eigendoc -> export as HTML -> verify HTML structure |
| Import round-trip (DOCX) | Upload DOCX -> import -> verify eigendoc content |
| Import round-trip (Markdown) | Upload .md -> import -> verify eigendoc content |
| Export permissions | Verify viewer can export, non-member cannot |
| Image resolution in export | Create eigendoc with images -> export -> verify images are embedded |

### Extension Parity Test

A critical test that verifies the server extension list matches the editor's:

```typescript
// Compare node/mark names between server extensions and editor extensions
// This catches the case where someone adds a new extension to the editor
// but forgets to add it to the server registry
```

### Edge Case Tests

- Empty document export (each format)
- Document with 50+ images
- Document with deeply nested lists (5+ levels)
- Document with complex table (colspan + rowspan)
- DOCX import with unsupported features (verify warnings)
- Markdown with HTML blocks
- Very large document (1MB of text content)

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `@tiptap/html` has Bun-specific issues | Low | High | Test early in Phase 1. Fallback: use `@tiptap/core` Editor with `headless: true` mode. |
| `y-prosemirror` server-side fails | Low | High | Already proven to work (used in editor-toolbar.tsx for revision restore). Moving to server is a dependency issue, not a runtime issue. |
| DOCX export tables look wrong | Medium | Medium | Build comprehensive table test fixtures. Accept some formatting differences vs Word. |
| Puppeteer Chromium not available | Certain (some users) | Low | Browser print is the fallback. Document this clearly. |
| mammoth.js drops important DOCX content | Certain | Medium | Show import warnings. Document limitations. Provide "Preview before converting" flow. |
| Server extension registry drifts from editor | Medium | High | Extension parity test (see Testing). Fail CI if they diverge. |
| Image resolution fails for deleted/moved images | Medium | Low | Show `[Image not available]` placeholder. Log warning. |
| Large documents (100+ pages) cause memory issues | Low | Medium | Set size limits. Y.Doc state > 10MB -> reject with error. |
| Export during active collaboration returns stale data | Certain | Low | Document: "Exports reflect the last saved state." Acceptable lag is <5 seconds. |

---

## Phases

### Phase 1: Client-Side Export (Markdown/HTML/TXT) -- 1 week

**Goal:** Users can export the open document without any server changes.

**Scope:**
- ProseMirror JSON -> Markdown serializer in `packages/lib`
- HTML template wrapper
- `downloadAsFile()` utility
- Export submenu in editor-toolbar File menu
- PDF via existing Print function

**Why start here:** Highest value (users can get their data out), lowest risk (no API changes, no new dependencies),
fastest to ship (1 week). Markdown export is also the foundation for the inline editing feature.

**Exit criteria:** Can export any open eigendoc as .md, .html, or .txt. Content is correct and well-formatted.

### Phase 2: Server-Side Export Infrastructure + DOCX -- 2-3 weeks

**Goal:** Export from Drive context menu. DOCX export.

**Scope:**
- Server-side Tiptap extension registry (shared with preview system)
- `doc-content.ts` for Y.Doc -> PM JSON extraction
- Image URL resolver
- Export route in API
- DOCX export via `docx` package
- Drive context menu "Export as" submenu
- Optional: Puppeteer PDF integration

**Exit criteria:** Can export eigendoc as DOCX from Drive without opening it. DOCX opens in Word/LibreOffice. Server
exports Markdown/HTML/TXT for files not currently open.

### Phase 3: Import (DOCX + Markdown) -- 2 weeks

**Goal:** Convert uploaded DOCX and Markdown files to eigendoc.

**Scope:**
- mammoth.js DOCX import with image extraction
- Markdown import via markdown-it
- HTML and TXT import
- Y.Doc initialization from ProseMirror JSON
- Import route in API
- "Convert to Eigen Doc" in Drive context menu
- "Import from file..." in Docs File menu
- Import report dialog with warnings

**Exit criteria:** Can import DOCX and Markdown files. Images are extracted and stored. Import warnings are shown.

### Phase 4: Polish + Edge Cases -- 1 week

**Goal:** Production quality.

**Scope:**
- Extension parity tests
- Edge case handling (empty docs, large docs, many images)
- Error handling and user-facing error messages
- Size limit enforcement
- Security hardening (DOCX validation, HTML sanitization)
- Update docs/CALENDAR.md pattern for new docs domain files

### Future Phases (not scoped)

- Batch export (multi-file ZIP)
- Export templates (letterhead, report format)
- Pandoc integration for ODT/LaTeX/EPUB
- DOCX comment export (eigendoc comments -> Word comments)
- "Publish as webpage" feature
- Email attachment integration
