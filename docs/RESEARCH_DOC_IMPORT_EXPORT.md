# Research: Document Import/Export for Eigen Docs

> **TLDR**: Add import (DOCX/Markdown/TXT/HTML -> eigendoc) and export (eigendoc -> PDF/DOCX/Markdown/HTML/TXT)
> capabilities. Export happens server-side via `@tiptap/html` for HTML generation, then format-specific converters.
> PDF generation uses a **tiered approach**: `pdfkit` for simple documents (fast, no external dependency), with
> Puppeteer (headless Chromium) as a configurable option for highest fidelity. DOCX export uses the `docx` npm
> package to build Open XML from ProseMirror JSON. Import uses mammoth.js (DOCX) with known limitations, plus
> `tiptap-markdown` (Markdown) and direct HTML parsing. A lightweight SQLite-based job queue backed by Bun Workers
> handles slow exports with progress tracking via SSE. UI surfaces export in the docs toolbar File menu and Drive
> context menu; import via an explicit "Import as Eigen Doc" action.

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Content Model Inventory](#2-content-model-inventory)
3. [Export Format Coverage Matrix](#3-export-format-coverage-matrix)
4. [Import Format Coverage Matrix](#4-import-format-coverage-matrix)
5. [Export Architecture](#5-export-architecture)
6. [Import Architecture](#6-import-architecture)
7. [Server-Side Tiptap Rendering](#7-server-side-tiptap-rendering)
8. [PDF Generation Deep Dive](#8-pdf-generation-deep-dive)
9. [DOCX Export Deep Dive](#9-docx-export-deep-dive)
10. [Markdown Export/Import](#10-markdown-exportimport)
11. [Queue System Design](#11-queue-system-design)
12. [Image and Media Handling](#12-image-and-media-handling)
13. [Security Considerations](#13-security-considerations)
14. [UI/UX Design](#14-uiux-design)
15. [Library Comparison](#15-library-comparison)
16. [Performance Considerations](#16-performance-considerations)
17. [Cross-Cutting Concerns](#17-cross-cutting-concerns)
18. [Edge Cases and Limitations](#18-edge-cases-and-limitations)
19. [Implementation Phases](#19-implementation-phases)

---

## 1. Current State Analysis

### What Exists Today

**No import or export functionality exists.** The current eigendoc flow is entirely self-contained:

1. User creates a new `.eigendoc` (Drive -> "New document")
2. Content is authored in the Tiptap editor with collaborative editing via Yjs
3. Content is stored as Yjs binary state in `data.db` (SQLite) inside the `.eigendoc` folder
4. The only output path is Print (via `printDocument()` which clones the `[data-document]` DOM element and
   calls `window.print()`)

**Relevant existing infrastructure:**

| Component | Location | Relevance |
|---|---|---|
| `printDocument()` | `packages/ui/src/lib/printElement.ts` | Only export path today -- browser print dialog (PDF via OS print-to-PDF) |
| `CollabDocument` | `apps/api/src/lib/collab/collabDocument.ts` | Loads Y.Doc from data.db, manages snapshots/updates via `DbProvider` |
| `DbProvider` | Inner class in `collabDocument.ts` | `loadState()` reads latest snapshot + incremental updates from SQLite |
| `yDocToProsemirrorJSON` | Used in `editor-toolbar.tsx` (line 105) for revision restore | Converts Y.Doc binary state to ProseMirror JSON |
| `CollabDocument.create()` | `apps/api/src/lib/collab/collabDocument.ts` | Creates eigendoc structure: `data.db` (via `touchFile`) + `media/` + `chat/` folders |
| Drive upload/download | `apps/api/src/routes/drive.ts` + `apps/api/src/lib/drive/drive.ts` | File read/write via mount system. Embed route: `GET /drive/:ownerId/:mountId/file/:pathId/embed/:fileName` |
| Mount system | `apps/api/src/lib/mount/mount.ts` | `readFile()`, `writeFile()`, `getChildByName()`, `touchFile()` |
| `ManagedDatabase` | `apps/api/src/lib/core/managed-database.ts` | SQLite with WAL, versioning, auto-sync |
| `JsonStore` | `apps/api/src/lib/core/json-store.ts` | JSON settings persistence pattern |
| SSE notifications | `apps/api/src/routes/sse.ts` | Real-time events to frontend |
| `sharp` | API dependency (^0.34.0) | Image processing (thumbnails) -- available for image format conversion |

**No job queue or background task system exists.** The API processes all requests synchronously. There is no
bull/bullmq, no worker thread pool, no task table. The closest pattern is `setInterval` in `ManagedDatabase` for
periodic sync.

**Key dependency versions** (from `apps/docs/package.json` and `apps/api/package.json`):
- Tiptap: `^2.11.5` (all extensions)
- Yjs: `^13.6.27`
- y-prosemirror: `^1.3.4` (in docs app only -- not yet in API)
- lowlight: `^3.1.0`
- sharp: `^0.34.0`
- isomorphic-dompurify: `^3.0.0`

### How Y.Doc Content Is Accessed

The path to extract document content server-side:

```
data.db (SQLite)
  -> doc_snapshots table (latest snapshot = Yjs binary state, ordered by id DESC)
  -> doc_updates table (incremental updates after last snapshot, joined via lastUpdateId)
  -> Y.applyUpdate() to reconstruct Y.Doc
  -> yDocToProsemirrorJSON(yDoc, 'default') -> ProseMirror JSON
  -> @tiptap/html generateHTML(json, extensions) -> HTML string
```

This is the fundamental pipeline for all exports. The `DbProvider.loadState()` method in `collabDocument.ts`
already implements the first three steps. The last two steps require adding `@tiptap/html` and `y-prosemirror`
to the API's dependencies and building a server-side extension registry.

### Overlap with Other Research

- **RESEARCH_INLINE_EDITING.md**: Covers Markdown round-trip fidelity, `tiptap-markdown` configuration, and
  DOCX-to-HTML conversion via mammoth.js. Those findings are directly relevant to import.
- **RESEARCH_PREVIEWS.md**: Preview generation for eigendoc files requires the same Yjs-to-HTML pipeline that
  export needs. These two features should share the server-side Tiptap rendering infrastructure.
- **RESEARCH_COPY_PASTE.md**: The Eigen Clipboard Protocol handles cross-app content transfer. Export/import
  must handle the same image URL resolution that copy-paste already deals with (see section 17).

---

## 2. Content Model Inventory

The full set of nodes and marks in the Eigen Docs editor, verified from `apps/docs/src/components/docs/editor.tsx`:

### Nodes

| Node | Source Extension | Attributes | Export Complexity |
|---|---|---|---|
| `doc` | StarterKit | -- | Container |
| `paragraph` | StarterKit | `textAlign` | Low |
| `heading` | StarterKit | `level` (1-6), `textAlign` | Low |
| `text` | StarterKit | -- | Trivial |
| `blockquote` | StarterKit | -- | Low |
| `bulletList` | StarterKit | -- | Low |
| `orderedList` | StarterKit | `start` | Low |
| `listItem` | StarterKit | -- | Low |
| `codeBlock` | CodeBlockLowlight | `language` | Medium (syntax highlighting) |
| `horizontalRule` | StarterKit | -- | Low |
| `hardBreak` | StarterKit | -- | Low |
| `taskList` | TaskList | -- | Medium (checkbox rendering) |
| `taskItem` | TaskItem | `checked` | Medium |
| `table` | Table | -- | High (complex layout) |
| `tableRow` | TableRow | -- | High |
| `tableCell` | TableCell | `colspan`, `rowspan`, `colwidth` | High |
| `tableHeader` | TableHeader | `colspan`, `rowspan`, `colwidth` | High |
| `resizableImage` | Custom (ResizableImage) | `src`, `alt`, `title`, `width`, `alignment` | High (image embedding) |

### Marks

| Mark | Source Extension | Attributes | Export Complexity |
|---|---|---|---|
| `bold` | StarterKit | -- | Low |
| `italic` | StarterKit | -- | Low |
| `strike` | StarterKit | -- | Low |
| `code` | StarterKit | -- | Low |
| `underline` | Underline | -- | Low |
| `subscript` | Subscript | -- | Low |
| `superscript` | Superscript | -- | Low |
| `link` | Link | `href`, `target`, `rel`, `class` | Low |
| `textStyle` | TextStyle | -- | Container for Color |
| `color` | Color | `color` (hex) | Medium (format-dependent) |
| `highlight` | Highlight | `color` (hex) | Medium (format-dependent) |
| `comment` | CommentMark (custom) | `chatId` | Export-irrelevant (strip on export) |

### Extensions Present in Editor But Not in Research Doc's Server Extension List

The document's `getServerExtensions()` must also account for:

1. **Typography** -- present in the editor (smart quotes, em dashes). Not a node/mark, but affects how content
   is stored. Safe to omit from server extensions since it only transforms input, not output rendering.
2. **CharacterCount** -- present in the editor. Not needed server-side (it only provides statistics).
3. **Collaboration / CollaborationCursor** -- obviously excluded from server rendering.

### Export-Critical Observations

1. **ResizableImage** is a custom node with non-standard attributes (`width`, `alignment`). The `src` attribute
   contains a Drive embed URL (`/drive/:ownerId/:mountId/file/:pathId/embed/:fileName`), which must be resolved
   to actual image bytes for export. The node's `renderHTML` method outputs a plain `<img>` tag (no wrapper div),
   so the server extension must add alignment/width styling that the frontend handles via React NodeView.

2. **CommentMark** stores a `chatId` linking to a `.eigenchat` directory. Comments should be stripped from all
   exports (they have no equivalent in PDF/Markdown). DOCX comments could be supported in Phase 6+.

3. **Color and Highlight** use arbitrary hex colors. DOCX supports arbitrary text colors; PDF supports them
   natively; Markdown cannot represent them (lost on export).

4. **TextAlign** is applied to `heading` and `paragraph` types. DOCX and PDF support alignment; Markdown does not.

5. **Tables** with `colspan`, `rowspan`, and `colwidth` are the most complex structure. DOCX tables support all
   of these. PDF tables require careful rendering. Markdown tables do not support colspan/rowspan (GFM tables are
   flat grids).

---

## 3. Export Format Coverage Matrix

What is preserved when exporting from eigendoc to each target format:

| Feature | PDF | DOCX | HTML | Markdown | TXT |
|---|---|---|---|---|---|
| Headings (h1-h6) | Full | Full | Full | Full | Structure lost (plain text) |
| Paragraphs | Full | Full | Full | Full | Full (line breaks) |
| Bold / Italic / Strike | Full | Full | Full | Full | Lost |
| Underline | Full | Full | Full | `<u>` with `html:true` | Lost |
| Subscript / Superscript | Full | Full | Full | `<sub>`/`<sup>` with `html:true` | Lost |
| Inline code | Full | Monospace font | Full | Full | Backticks preserved |
| Code blocks (with language) | Full (syntax highlighted) | Monospace, no highlighting | Full (with class) | Full (fenced + language) | Indented, no highlighting |
| Links | Clickable | Clickable | Full | Full (`[text](url)`) | URL in parentheses |
| Images | Embedded (rasterized) | Embedded | Embedded (base64 or linked) | `![alt](url)` | `[Image: alt]` |
| Image width/alignment | Preserved | Width preserved, alignment partial | Full | Lost | Lost |
| Tables | Full layout | Full (colspan/rowspan) | Full | Flat grid (no span) | ASCII table or lost |
| Table column widths | Preserved | Preserved | Preserved | Lost | Lost |
| Task lists | Checkbox rendered | Checkbox (content control) | Full | `- [x]` / `- [ ]` | `[x]` / `[ ]` prefix |
| Blockquotes | Styled | Indented paragraph | Full | `>` prefix | Lost |
| Horizontal rules | Rendered | Page/section break | `<hr>` | `---` | Dashes |
| Text color | Full | Full | Full | Lost | Lost |
| Highlight color | Full | Full (shading) | Full | Lost | Lost |
| Text alignment | Full | Full | Full | Lost | Lost |
| Comments | Stripped | Stripped (Phase 6: as DOCX comments) | Stripped | Stripped | Stripped |
| Ordered list start number | Preserved | Preserved | Preserved | Preserved | Lost |
| Nested lists | Full | Full | Full | Full | Indented |

### Quality Tier Summary

| Format | Quality | Use Case |
|---|---|---|
| **PDF** | Highest fidelity | Sharing, printing, archival |
| **DOCX** | High fidelity (some edge cases with custom nodes) | Interop with MS Office users |
| **HTML** | Perfect fidelity | Web publishing, email body, "publish as webpage" |
| **Markdown** | Good for text; lossy for rich formatting | Developer docs, README files, plain-text workflows |
| **TXT** | Text content only | Clipboard, search indexing, accessibility |

---

## 4. Import Format Coverage Matrix

What is preserved when importing into eigendoc from each source format:

| Feature | DOCX (mammoth) | Markdown (tiptap-markdown) | HTML | TXT |
|---|---|---|---|---|
| Headings | Full (h1-h6) | Full (ATX `#` style) | Full | N/A |
| Paragraphs | Full | Full | Full | As-is (line = paragraph) |
| Bold / Italic / Strike | Full | Full | Full | N/A |
| Underline | Full | Via `<u>` if `html:true` | Full | N/A |
| Links | Full | Full | Full | N/A |
| Images | Extracted from DOCX ZIP | Relative/absolute URLs | src URLs | N/A |
| Tables | Basic (no colspan) | GFM tables (flat grid) | Full | N/A |
| Code blocks | Monospace paragraphs only | Fenced blocks with language | `<pre><code>` | N/A |
| Task lists | N/A | `- [x]` / `- [ ]` | Custom HTML | N/A |
| Text color | Lost (mammoth strips styling) | Lost | Inline styles | N/A |
| Headers/Footers | Lost | N/A | N/A | N/A |
| Page numbers | Lost | N/A | N/A | N/A |
| Tracked changes | Lost | N/A | N/A | N/A |
| Footnotes | Limited (mammoth partial) | Not supported | `<sup>` only | N/A |
| Shapes / SmartArt | Lost | N/A | N/A | N/A |
| Charts | Lost | N/A | N/A | N/A |
| Custom fonts | Lost (normalized) | N/A | Ignored | N/A |

### Honest Assessment of mammoth.js for DOCX Import

mammoth.js is deliberately lossy -- it converts DOCX to *semantic* HTML, stripping visual-only formatting.
This is the right philosophy for import (we want clean ProseMirror content, not a pixel-perfect reproduction
of a Word doc). However, real-world limitations are significant:

1. **Tables**: mammoth produces flat `<table>` with no colspan/rowspan support. Complex Word tables with merged
   cells will import incorrectly -- cells appear duplicated or misaligned.
2. **Lists**: Numbered list continuation (start numbers) and multi-level custom list numbering are often lost.
3. **Images**: Works well for embedded images, but linked/external images may break. WMF/EMF vector images
   (common in older Word docs) are not supported.
4. **Text boxes and floating elements**: Completely lost. Content inside text boxes is silently dropped.
5. **Columns**: Multi-column layouts are flattened to single-column.
6. **Custom styles**: mammoth maps built-in Word styles (Heading 1, Normal, etc.) well but ignores custom styles
   unless you provide explicit style mappings.
7. **Headers/footers**: Lost entirely -- no equivalent in Tiptap's content model.
8. **Equations**: MathML/OMML equations are lost.

**Verdict**: mammoth.js is the best option for Phase 1 despite these limitations. The alternative (parsing
OOXML directly) is an enormous effort. The key is to **warn users** about expected losses during import and
show mammoth's `messages` array (which contains warnings about unsupported features).

### Import Priority by Format

| Priority | Format | Rationale |
|---|---|---|
| **P0 (Phase 1)** | DOCX | Most common document exchange format. Users switching from Google Docs/Word need this. |
| **P0 (Phase 1)** | Markdown | Developer audience. Also needed for inline editing feature (shared infrastructure). |
| **P1 (Phase 2)** | HTML | Copy-paste from web pages, email bodies. Low effort since Tiptap natively parses HTML. |
| **P1 (Phase 2)** | TXT | Trivial -- just set as paragraph content. |
| **P2 (Future)** | Google Docs | Export as DOCX from Google, then import. No direct `.gdoc` parsing needed. |
| **P2 (Future)** | ODT | Open Document format. Convert via `pandoc` or LibreOffice headless. |
| **P3 (Future)** | Apple Pages | No JS library exists. Convert via `pandoc` (limited) or require user to export as DOCX/PDF first. |

**Note on Google Docs and Apple Pages**: These are proprietary formats with no practical JS parsing libraries.
The pragmatic approach is to rely on their respective export-to-DOCX functionality rather than building direct
parsers. Document this in the import UI: "To import from Google Docs, first download as .docx".

---

## 5. Export Architecture

### Pipeline Overview

```
User clicks "Export as PDF"
  |
  v
Frontend: POST /export/:ownerId/:mountId/:pathId
  Body: { format: 'pdf' | 'docx' | 'markdown' | 'html' | 'txt', options?: ExportOptions }
  |
  v
Backend: ExportService.enqueue(path, format, options)
  |
  v
[Fast path: markdown, html, txt]         [Slow path: pdf, docx]
  |                                         |
  v                                         v
Synchronous:                             Job Queue (SQLite):
  1. Load Y.Doc from data.db               1. Insert job record
  2. Convert to ProseMirror JSON            2. Return jobId immediately
  3. Convert to target format               3. Bun Worker picks up job
  4. Return file as download                4. Worker: load Y.Doc -> PM JSON -> target
  |                                         5. Worker: store result in tmp/
  v                                         6. Worker: update job status -> 'complete'
Response: file blob                         7. SSE: notify client job is done
                                            |
                                            v
                                         GET /export/jobs/:jobId/download
                                           -> Return file blob, clean up
```

### Export Endpoint Design

```
POST /export/:ownerId/:mountId/:pathId
  Body: { format, options }
  Returns:
    - For fast formats: file blob directly (Content-Disposition: attachment)
    - For slow formats: { jobId: string, status: 'queued' }

GET /export/jobs/:jobId
  Returns: { status: 'queued' | 'processing' | 'complete' | 'failed', progress?: number, error?: string }

GET /export/jobs/:jobId/download
  Returns: file blob (Content-Disposition: attachment)
  Side effect: deletes job record and temp file after download
```

### What Determines Fast vs Slow?

| Format | Path | Reason |
|---|---|---|
| Markdown | Fast (sync) | Pure JSON-to-text transform, <50ms even for large docs |
| TXT | Fast (sync) | Trivial text extraction |
| HTML | Fast (sync) | `generateHTML()` is fast, <100ms |
| PDF (pdfkit) | Slow (queued) | Layout computation + image embedding. 1-3 seconds typical. |
| PDF (Puppeteer) | Slow (queued) | Chromium render + PDF generation. 2-10 seconds. |
| DOCX | Slow (queued) | Building Open XML with images is CPU-intensive. 1-5 seconds. |

The threshold for "slow" is roughly 500ms. Anything that might exceed this should be queued to avoid blocking
the API event loop.

---

## 6. Import Architecture

### Pipeline Overview

```
User right-clicks .docx in Drive -> "Import as Eigen Doc"
  |
  v
Frontend: POST /import/:ownerId/:mountId/:pathId
  Body: { targetFormat: 'eigendoc' }
  |
  v
Backend: ImportService.convert(path):
  1. Read source file bytes from mount
  2. Detect format (MIME type + extension)
  3. Validate file (see Security section)
  4. Convert to HTML or ProseMirror JSON:
     - DOCX: mammoth.js -> HTML -> Tiptap parse -> PM JSON
     - Markdown: tiptap-markdown parse -> PM JSON
     - HTML: DOMPurify sanitize -> Tiptap parse -> PM JSON
     - TXT: wrap in <p> tags -> PM JSON
  5. Extract images (DOCX: from ZIP; Markdown: resolve relative paths)
  6. Create .eigendoc folder structure (data.db, media/, chat/)
  7. Upload extracted images to media/ folder
  8. Rewrite image URLs in PM JSON to Drive embed URLs
  9. Initialize Y.Doc with PM JSON content
  10. Write Y.Doc state to data.db
  11. Return new eigendoc path + import warnings
```

### Recommended Import UX: Explicit Only

Auto-conversion on upload is surprising -- users who upload a `.docx` to Drive might want to keep it as a `.docx`.
The explicit import approach is clearer:

1. Upload `.docx` to Drive (stored as-is)
2. Preview the `.docx` in the preview system (using mammoth.js, as designed in RESEARCH_PREVIEWS.md)
3. User right-clicks -> "Import as Eigen Doc" or sees a banner in the preview: "Convert to Eigen Doc for editing"
4. Conversion runs server-side, creates a new `.eigendoc` alongside the original
5. Original `.docx` is preserved
6. **Import report**: Show a summary of what was imported and what was lost (based on mammoth's warnings)

For markdown files, the inline editing feature (RESEARCH_INLINE_EDITING.md) already enables direct editing without
conversion. The "Import as Eigen Doc" action is available for users who want full Eigen features (comments,
collaboration, rich formatting) on markdown content.

---

## 7. Server-Side Tiptap Rendering

### The Core Challenge

Tiptap is a frontend library. To generate HTML server-side for export, we need `@tiptap/html` which provides
`generateHTML(json, extensions)`. This function takes ProseMirror JSON and a list of Tiptap extensions, and
produces an HTML string.

The challenge: the extension list must match the frontend editor's extensions (same node/mark names and
attributes). If the server uses a different set, the generated HTML will be wrong or incomplete.

### @tiptap/html

The `@tiptap/html` package exports two functions:

```typescript
import { generateHTML } from '@tiptap/html';
import { generateJSON } from '@tiptap/html';

// ProseMirror JSON -> HTML string
const html = generateHTML(pmJson, extensions);

// HTML string -> ProseMirror JSON
const json = generateJSON(htmlString, extensions);
```

Both functions are **pure JavaScript** -- no DOM, no browser, no jsdom required. They use ProseMirror's
`DOMSerializer` and `DOMParser` with a minimal DOM shim. They work in Node.js, Bun, and Deno.

### Server-Side Extension Registry

Create a shared extension configuration. Place it in a location importable by both `apps/api` and `apps/docs`:

```typescript
// packages/lib/src/core/docs/server-extensions.ts

import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { Node } from '@tiptap/core';
import { common, createLowlight } from 'lowlight';

// Server-safe ResizableImage (no React, no DOM event handlers)
const ServerResizableImage = Node.create({
    name: 'resizableImage',
    group: 'block',
    atom: true,
    addAttributes() {
        return {
            src: { default: null },
            alt: { default: null },
            title: { default: null },
            width: { default: null },
            alignment: { default: 'center' },
        };
    },
    renderHTML({ HTMLAttributes }) {
        const { alignment, width, ...rest } = HTMLAttributes;
        const style = [
            width ? `width: ${width}px` : '',
            'max-width: 100%',
        ].filter(Boolean).join('; ');

        const wrapperStyle = `display: flex; justify-content: ${
            alignment === 'left' ? 'flex-start' : alignment === 'right' ? 'flex-end' : 'center'
        }`;

        return ['div', { style: wrapperStyle }, ['img', { ...rest, style }]];
    },
    parseHTML() {
        return [{ tag: 'img[src]' }];
    },
});

// Server-safe CommentMark (renders as invisible span, stripped on export)
const ServerCommentMark = /* ... same as frontend but without onCommentClick plugin ... */;

export function getServerExtensions() {
    return [
        StarterKit.configure({ history: false, codeBlock: false }),
        Underline,
        Subscript,
        Superscript,
        TextStyle,
        Color,
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Link,
        Highlight.configure({ multicolor: true }),
        CodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
        Table.configure({ resizable: true }),
        TableRow,
        TableCell,
        TableHeader,
        ServerResizableImage,
    ];
}
```

**Why ServerResizableImage is necessary**: The custom `ResizableImage` extension in `resizable-image.tsx` uses
`ReactNodeViewRenderer` which requires React and the DOM. Its `renderHTML()` method outputs a plain `<img>` tag
without width/alignment styling (those are handled by the React component). The server extension must add the
styling that the React NodeView provides visually.

### Full Server-Side Pipeline

```typescript
import { generateHTML } from '@tiptap/html';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';

async function eigendocToHTML(drive: Drive, mountId: string, pathId: string): Promise<string> {
    // 1. Load Y.Doc from data.db (same logic as DbProvider.loadState)
    const dataDbPath = await drive.getChildByName(mountId, pathId, 'data.db');
    const managedDb = await drive.openDatabase(mountId, COLLAB_DB_CONFIG, dataDbPath.id);

    const yDoc = new Y.Doc();
    const snapshot = managedDb.db.select().from(docSnapshots)
        .orderBy(desc(docSnapshots.id)).limit(1).get();
    if (snapshot) {
        Y.applyUpdate(yDoc, snapshot.stateData);
        const updates = managedDb.db.select().from(docUpdates)
            .where(gt(docUpdates.id, snapshot.lastUpdateId)).all();
        for (const u of updates) Y.applyUpdate(yDoc, u.updateData);
    } else {
        const updates = managedDb.db.select().from(docUpdates).all();
        for (const u of updates) Y.applyUpdate(yDoc, u.updateData);
    }

    // 2. Convert to ProseMirror JSON
    const pmJson = yDocToProsemirrorJSON(yDoc, 'default');
    yDoc.destroy();

    // 3. Generate HTML
    return generateHTML(pmJson, getServerExtensions());
}
```

**Important**: Consider extracting the Y.Doc loading logic from `DbProvider.loadState()` into a shared utility
so that both the WebSocket server and the export pipeline use the same code path. Currently `DbProvider` is a
private inner class of `CollabDocument` and not directly reusable.

---

## 8. PDF Generation Deep Dive

### The PDF Problem for Self-Hosted Software

The original document recommended Puppeteer unconditionally. This needs more nuance. For a **self-hosted**
product, the Chromium dependency is a serious concern:

| Concern | Impact |
|---|---|
| **Binary size** | ~300MB for Chromium. The current Docker image (`oven/bun:1-slim` + libvips) is far smaller. Adding Chromium more than doubles image size. |
| **ARM compatibility** | ARM64 (Apple Silicon, Raspberry Pi, many cloud VMs) needs ARM Chromium builds. Puppeteer's bundled Chromium does not always provide ARM builds; users must install system Chromium. |
| **Memory** | Each Chromium page uses 50-100MB. On a 1GB VPS (common self-hosted setup), this limits concurrent exports to 2-3 before OOM. |
| **Startup time** | First Chromium launch adds ~1-2 seconds. Subsequent pages are faster with a warm browser instance, but the browser pool must be managed (crashes, zombies). |
| **Security** | Running a headless browser on a server increases attack surface. Chromium sandbox requires either `--no-sandbox` (insecure) or proper namespace setup (complex in Docker). |
| **Alpine Linux** | Eigen's Docker image could use Alpine for smaller size, but Chromium on Alpine requires significant setup (`chromium` package is ~150MB compressed). |

### Recommended: Tiered Approach

Instead of Puppeteer-only, use a tiered strategy:

**Tier 1: pdfkit (default, no external dependency)**

Use `pdfkit` for all PDF exports by default. It produces clean, professional PDFs without any external binary.
The trade-off is that it requires building a layout engine that maps ProseMirror nodes to pdfkit drawing calls.

Fidelity trade-offs vs Puppeteer:
- Tables: Requires manual cell positioning (doable, not trivial)
- Code blocks: Monospace text with background fill (no syntax highlighting colors)
- Images: Supported natively by pdfkit
- Text alignment: Supported
- Colors/highlights: Supported
- Complex CSS layouts: Not supported (but eigendoc content is simple flow layout)

The key insight: eigendoc content is **structured document content**, not arbitrary web pages. It is paragraphs,
headings, lists, tables, images, and code blocks. This is well within pdfkit's capabilities. The document will
not look *identical* to the browser rendering, but it will look *professional and correct*.

```typescript
import PDFDocument from 'pdfkit';

function generatePDFSimple(pmJson: PMJson, images: Map<string, Buffer>, options: PDFOptions): Buffer {
    const doc = new PDFDocument({
        size: options.pageSize || 'A4',
        margins: { top: 72, bottom: 72, left: 72, right: 72 },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));

    for (const node of pmJson.content) {
        renderNode(doc, node, images, options);
    }

    doc.end();
    return Buffer.concat(chunks);
}
```

**Tier 2: Puppeteer (opt-in, highest fidelity)**

For users who need pixel-perfect PDF output (exact match to editor rendering), offer Puppeteer as an opt-in
option. This requires the user to either:
- Install Chromium on their server (`CHROMIUM_PATH` env var)
- Use a Docker image variant that includes Chromium

The export UI shows: "Export as PDF" (uses pdfkit) and "Export as PDF (high fidelity)" (uses Puppeteer, if
available). If Puppeteer/Chromium is not configured, the high-fidelity option is hidden.

### Why This Tiered Approach Is Better

1. **Zero-config default**: pdfkit works everywhere Bun runs. No extra install, no Docker image bloat, no ARM
   issues. Users get PDF export out of the box.
2. **Self-hosted friendly**: A 1GB VPS with 512MB RAM can still export PDFs via pdfkit.
3. **Opt-in quality**: Users who need exact visual fidelity can install Chromium. The system degrades gracefully
   when it is not available.
4. **Faster for simple docs**: pdfkit generates a 10-page document in <1 second. Puppeteer takes 3-5 seconds.

### Other Alternatives Considered

| Alternative | Verdict | Reasoning |
|---|---|---|
| **Playwright** | Same problems as Puppeteer | Same Chromium dependency, slightly better API but no practical advantage for PDF generation. Slightly heavier overall. |
| **weasyprint** | Not recommended | Python dependency. Requires Python runtime + GTK/Pango C libraries. Adds significant complexity to the Docker image and is not callable from Bun natively (would need subprocess + IPC). Good CSS support but not worth the operational burden for a JS/TS project. |
| **wkhtmltopdf** | Do not use | Deprecated, uses old WebKit, known security vulnerabilities. |
| **LibreOffice headless** | Phase 3+ only | ~500MB binary. Useful for DOCX->PDF conversion but overkill for HTML->PDF. Could be an alternative to Puppeteer for the highest-fidelity tier. |
| **@react-pdf/renderer** | Not recommended | Uses its own layout engine (Yoga). Requires building a parallel React rendering pipeline for ProseMirror content. No HTML/CSS input. |
| **jsPDF** | Not recommended | Designed for client-side. Poor layout engine, no CSS support. |
| **Existing `printDocument()` approach server-side** | Not viable | `printDocument()` clones the DOM and calls `window.print()`. This requires a real browser, which is exactly what Puppeteer provides. There is no way to use this approach without a browser engine. |
| **Prince** | Out of scope | Commercial license ($3800). Best CSS-to-PDF engine available, but price is prohibitive for a self-hosted open-source product. |

### Puppeteer PDF Pipeline (Tier 2)

When Puppeteer is available:

```typescript
async function generatePDFPuppeteer(html: string, options: PDFOptions): Promise<Buffer> {
    const browser = await getBrowserInstance();
    const page = await browser.newPage();

    try {
        const fullHTML = buildPDFDocument(html, options);
        await page.setContent(fullHTML, { waitUntil: 'networkidle0' });

        // Wait for images to load
        await page.evaluate(() => {
            return Promise.all(
                Array.from(document.images)
                    .filter(img => !img.complete)
                    .map(img => new Promise(resolve => {
                        img.onload = img.onerror = resolve;
                    }))
            );
        });

        const pdf = await page.pdf({
            format: 'A4',
            margin: { top: '2cm', right: '2cm', bottom: '2cm', left: '2cm' },
            printBackground: true,
            displayHeaderFooter: options.headerFooter ?? false,
            headerTemplate: options.headerTemplate ?? '',
            footerTemplate: options.footerTemplate ?? DEFAULT_FOOTER_TEMPLATE,
        });

        return Buffer.from(pdf);
    } finally {
        await page.close();
    }
}
```

### Browser Pool Management (Tier 2)

Maintain a persistent browser instance and create new pages (tabs) per export:

```typescript
import puppeteer, { Browser } from 'puppeteer-core';

let browser: Browser | null = null;

async function getBrowserInstance(): Promise<Browser> {
    if (!browser || !browser.connected) {
        browser = await puppeteer.launch({
            executablePath: getChromiumPath(),
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        });
        // Restart browser if it crashes
        browser.on('disconnected', () => { browser = null; });
    }
    return browser;
}

function getChromiumPath(): string {
    const candidates = [
        process.env.CHROMIUM_PATH,
        '/usr/bin/chromium-browser',              // Alpine
        '/usr/bin/chromium',                       // Debian
        '/usr/bin/google-chrome-stable',           // Ubuntu
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS
    ].filter(Boolean) as string[];

    for (const p of candidates) {
        if (require('fs').existsSync(p)) return p;
    }

    throw new Error('Chromium not found. Set CHROMIUM_PATH environment variable or install Chromium.');
}
```

### PDF HTML Template (Tier 2)

```typescript
function buildPDFDocument(contentHTML: string, options: PDFOptions): string {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: ${options.fontFamily || 'system-ui, -apple-system, sans-serif'};
            font-size: ${options.fontSize || '11pt'};
            line-height: 1.6;
            color: #000;
        }
        h1 { font-size: 2em; font-weight: bold; margin: 0.67em 0; }
        h2 { font-size: 1.5em; font-weight: bold; margin: 0.75em 0; }
        h3 { font-size: 1.17em; font-weight: bold; margin: 0.83em 0; }
        pre { background: #f5f5f5; padding: 1em; border-radius: 4px; overflow-x: auto; }
        code { font-family: 'Fira Code', 'Consolas', monospace; font-size: 0.9em; }
        table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        th, td { border: 1px solid #ddd; padding: 0.5em; }
        th { background: #f5f5f5; font-weight: bold; }
        ul[data-type="taskList"] { list-style: none; padding-left: 0; }
        ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 0.5em; }
        img { max-width: 100%; height: auto; }
        a { color: #2563eb; text-decoration: underline; }
        blockquote { border-left: 3px solid #ddd; padding-left: 1em; margin: 1em 0; color: #555; }
        mark { padding: 0.1em 0.2em; border-radius: 2px; }
        hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
        @media print {
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
    </style>
</head>
<body>${contentHTML}</body>
</html>`;
}
```

### Image Resolution in PDF

Images in eigendoc use Drive embed URLs (`/drive/:ownerId/:mountId/file/:pathId/embed/:fileName`). In the PDF
pipeline, these URLs must be resolved server-side (Puppeteer has no auth cookies, pdfkit needs raw bytes).

**Pre-resolve to base64 (both tiers)**:

Before passing HTML to Puppeteer (or extracting images for pdfkit), scan for `<img>` tags, read each image from
Drive storage directly (server-side, no HTTP), convert to base64 data URIs:

```typescript
async function resolveImages(html: string, drive: Drive, mountId: string): Promise<string> {
    const imgRegex = /src="[^"]*\/drive\/([^/]+)\/([^/]+)\/file\/([^/]+)\/embed\/[^"]*"/g;
    let resolved = html;

    for (const match of html.matchAll(imgRegex)) {
        const [fullMatch, ownerId, imgMountId, pathId] = match;
        try {
            const imageData = await drive.downloadFile(imgMountId, pathId);
            if (imageData) {
                const base64 = Buffer.from(imageData).toString('base64');
                const path = await drive.getPath(imgMountId, pathId);
                const mimeType = path?.mimeType || 'image/png';
                resolved = resolved.replace(fullMatch, `src="data:${mimeType};base64,${base64}"`);
            }
        } catch {
            // Image not accessible -- leave original URL (will show broken image)
        }
    }

    return resolved;
}
```

---

## 9. DOCX Export Deep Dive

### Recommended: `docx` npm Package

The `docx` package provides a declarative TypeScript API for building DOCX files. It gives full control over
the Open XML output without requiring an external binary.

**Why `docx` over `html-to-docx`**:
- `html-to-docx` is a thin wrapper that parses HTML and maps to `docx` API calls. The mapping is incomplete
  (no colspan/rowspan, limited image handling, no custom styles).
- Direct `docx` gives control over every aspect: table cell merging, image sizing, paragraph styles, text
  colors, highlights.
- The `docx` package is well-maintained (TypeScript-first, good documentation).

### ProseMirror JSON to DOCX Conversion

The conversion walks the ProseMirror JSON tree and builds `docx` objects:

```typescript
import { Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
         ImageRun, ExternalHyperlink, AlignmentType, Packer } from 'docx';

function pmNodeToDocx(node: PMNode, context: ConversionContext): DocxElement[] {
    switch (node.type) {
        case 'paragraph':
            return [new Paragraph({
                alignment: mapAlignment(node.attrs?.textAlign),
                children: pmInlineToDocx(node.content, context),
            })];

        case 'heading':
            return [new Paragraph({
                heading: mapHeadingLevel(node.attrs.level),
                alignment: mapAlignment(node.attrs?.textAlign),
                children: pmInlineToDocx(node.content, context),
            })];

        case 'bulletList':
            return pmListToDocx(node, 'bullet', context);

        case 'orderedList':
            return pmListToDocx(node, 'numbered', context);

        case 'taskList':
            return pmTaskListToDocx(node, context);

        case 'codeBlock':
            return [new Paragraph({
                style: 'Code',
                children: [new TextRun({
                    text: pmNodeText(node),
                    font: 'Consolas',
                    size: 20, // 10pt in half-points
                })],
            })];

        case 'table':
            return [pmTableToDocx(node, context)];

        case 'blockquote':
            return pmBlockquoteToDocx(node, context);

        case 'resizableImage':
            return [pmImageToDocx(node, context)];

        case 'horizontalRule':
            return [new Paragraph({
                border: { bottom: { style: 'single', size: 6, color: 'AAAAAA' } },
            })];

        default:
            return (node.content || []).flatMap(child => pmNodeToDocx(child, context));
    }
}
```

### Image Handling in DOCX

DOCX embeds images as binary data in the ZIP archive. The conversion must:

1. Resolve Drive embed URLs to actual image bytes (same as PDF pipeline)
2. Determine image dimensions (width from node attrs, natural dimensions from image metadata via `sharp`)
3. Convert WebP/SVG to PNG if needed (older Word versions may not support WebP; SVG is not supported in DOCX)
4. Create `ImageRun` with the binary data

```typescript
async function pmImageToDocx(node: PMNode, ctx: ConversionContext): Promise<Paragraph> {
    const imageData = await ctx.resolveImage(node.attrs.src);
    if (!imageData) {
        return new Paragraph({ children: [new TextRun('[Image not available]')] });
    }

    // Convert unsupported formats via sharp
    let buffer = imageData.buffer;
    let mimeType = imageData.mimeType;
    if (mimeType === 'image/webp' || mimeType === 'image/svg+xml') {
        buffer = await sharp(buffer).png().toBuffer();
        mimeType = 'image/png';
    }

    const width = node.attrs.width || 600;
    const metadata = await sharp(buffer).metadata();
    const aspectRatio = (metadata.width || 1) / (metadata.height || 1);
    const height = Math.round(width / aspectRatio);

    // Convert px to EMU (1 px = 9525 EMU at 96dpi)
    return new Paragraph({
        alignment: mapAlignment(node.attrs.alignment),
        children: [
            new ImageRun({
                data: buffer,
                transformation: { width: width * 9525, height: height * 9525 },
            }),
        ],
    });
}
```

### Table Conversion

Tables with `colspan` and `rowSpan` via the `docx` package:

```typescript
function pmTableToDocx(node: PMNode, ctx: ConversionContext): Table {
    const rows = (node.content || []).map(rowNode => {
        const cells = (rowNode.content || []).map(cellNode => {
            const isHeader = cellNode.type === 'tableHeader';
            return new TableCell({
                columnSpan: cellNode.attrs?.colspan || 1,
                rowSpan: cellNode.attrs?.rowspan || 1,
                width: cellNode.attrs?.colwidth?.[0]
                    ? { size: cellNode.attrs.colwidth[0] * 15, type: 'dxa' }
                    : undefined,
                shading: isHeader ? { fill: 'F5F5F5' } : undefined,
                children: (cellNode.content || []).flatMap(child => pmNodeToDocx(child, ctx)),
            });
        });
        return new TableRow({ children: cells });
    });

    return new Table({ rows });
}
```

---

## 10. Markdown Export/Import

### Export: eigendoc -> Markdown

Two approaches:

**Approach A: Via tiptap-markdown (recommended if feasible)**

Use `tiptap-markdown`'s serializer on the server. The challenge: `tiptap-markdown`'s `getMarkdown()` method
is only available through the editor storage API, requiring an editor instance. On the server (without DOM),
this may require `@tiptap/core`'s `Editor` class with a minimal DOM shim, or extracting the underlying
`prosemirror-markdown` serializer rules.

**Approach B: Direct ProseMirror JSON to Markdown**

Write a custom serializer that walks the ProseMirror JSON tree and outputs markdown. More control, but requires
maintaining parity with `tiptap-markdown`'s output format.

```typescript
function pmToMarkdown(node: PMNode, depth = 0): string {
    switch (node.type) {
        case 'heading':
            return '#'.repeat(node.attrs.level) + ' ' + inlineToMarkdown(node.content) + '\n\n';
        case 'paragraph':
            return inlineToMarkdown(node.content) + '\n\n';
        case 'bulletList':
            return node.content.map(li => '- ' + pmToMarkdown(li).trim()).join('\n') + '\n\n';
        case 'codeBlock':
            const lang = node.attrs.language || '';
            return '```' + lang + '\n' + pmNodeText(node) + '\n```\n\n';
        // ... etc
    }
}
```

Recommendation: Approach A if the server-side editor instance works cleanly. Approach B as fallback. Either way,
the fidelity constraints from RESEARCH_INLINE_EDITING.md apply: text color, highlight, alignment, underline,
subscript, superscript, and image width/alignment are lost in Markdown.

### Import: Markdown -> eigendoc

Use `markdown-it` (or `tiptap-markdown`) to parse markdown to HTML, then `generateJSON()` from `@tiptap/html`
to get ProseMirror JSON, then initialize a Y.Doc:

```typescript
import MarkdownIt from 'markdown-it';

async function markdownToEigendoc(markdown: string, drive: Drive, mountId: string, parentId: string) {
    const md = new MarkdownIt({ html: true });
    const html = md.render(markdown);
    const pmJson = generateJSON(html, getServerExtensions());

    const pathId = await drive.createDoc(mountId, parentId, 'Imported Document');
    // Initialize Y.Doc with pmJson content using y-prosemirror utilities
    // ...
    return pathId;
}
```

### Import: DOCX -> eigendoc

Use mammoth.js to extract HTML, then follow the same pipeline:

```typescript
import mammoth from 'mammoth';

async function docxToEigendoc(docxBuffer: ArrayBuffer, drive: Drive, mountId: string, parentId: string) {
    const result = await mammoth.convertToHtml(
        { arrayBuffer: docxBuffer },
        {
            convertImage: mammoth.images.imgElement(async (image) => {
                const buffer = await image.read();
                // Upload to eigendoc media folder, return Drive embed URL
                return { src: uploadedUrl };
            }),
        }
    );

    const html = result.value;
    const warnings = result.messages; // Surface these to the user

    const pmJson = generateJSON(html, getServerExtensions());
    // Create eigendoc and initialize Y.Doc...

    return { pathId, warnings };
}
```

---

## 11. Queue System Design

### Why a Queue?

PDF generation takes 1-10 seconds (depending on tier). DOCX generation with many images takes 1-5 seconds.
During this time:

1. The HTTP request would time out or block the event loop
2. Multiple concurrent exports could exhaust memory
3. The user has no feedback on progress
4. If the server restarts, in-flight exports are lost

### SQLite-Based Queue (Fits Eigen's Patterns)

Eigen already uses SQLite for everything. Adding a dedicated job queue database is consistent.

**Schema:**

```sql
CREATE TABLE export_jobs (
    id TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    mountId TEXT NOT NULL,
    pathId TEXT NOT NULL,
    format TEXT NOT NULL,
    options TEXT,                -- JSON blob
    status TEXT NOT NULL DEFAULT 'queued',  -- 'queued', 'processing', 'complete', 'failed'
    progress INTEGER DEFAULT 0,
    error TEXT,
    resultPath TEXT,
    resultName TEXT,
    retryCount INTEGER DEFAULT 0,
    maxRetries INTEGER DEFAULT 3,
    createdAt INTEGER DEFAULT (unixepoch()),
    updatedAt INTEGER DEFAULT (unixepoch()),
    expiresAt INTEGER
);

CREATE INDEX idx_export_jobs_status ON export_jobs(status, createdAt);
```

### Bun Worker for Queue Processing

Use Bun's built-in `Worker` (Web Workers API) to process exports in a separate thread. This keeps the main API
thread responsive and provides true parallelism:

```typescript
// apps/api/src/lib/export/export-worker.ts
const worker = new Worker(new URL('./worker-thread.ts', import.meta.url));

// Main thread sends jobs
worker.postMessage({ type: 'process', job: { id, ownerId, mountId, pathId, format, options } });

// Main thread receives results
worker.onmessage = (event) => {
    const { type, jobId, result, error } = event.data;
    if (type === 'complete') {
        updateJobStatus(jobId, 'complete', result);
        home.notify(buildExportCompleteEvent(jobId));
    } else if (type === 'failed') {
        handleJobFailure(jobId, error);
    } else if (type === 'progress') {
        updateJobProgress(jobId, result.progress, result.message);
        home.notify(buildExportProgressEvent(jobId, result));
    }
};
```

```typescript
// apps/api/src/lib/export/worker-thread.ts
self.onmessage = async (event) => {
    const { job } = event.data;
    try {
        self.postMessage({ type: 'progress', jobId: job.id, result: { progress: 10, message: 'Loading document...' } });

        // Load Y.Doc, convert to PM JSON, generate output
        // ... (same pipeline as synchronous path)

        self.postMessage({ type: 'progress', jobId: job.id, result: { progress: 50, message: 'Rendering...' } });

        const resultPath = await writeResultToTmp(job.id, outputBuffer);
        self.postMessage({ type: 'complete', jobId: job.id, result: { path: resultPath, filename: `${name}.${format}` } });
    } catch (error) {
        self.postMessage({ type: 'failed', jobId: job.id, error: error.message });
    }
};
```

**Why Worker over setInterval polling**:
- True parallelism: export CPU work does not block API request handling
- Cleaner error isolation: a crash in the worker does not bring down the API server
- Bun Workers share the same runtime, so all npm dependencies are available
- Message-passing is simpler than shared-state SQLite polling

**Caveat**: The Worker needs access to the Drive/Mount system to read document data. Options:
1. Pass file paths via messages and let the Worker open its own SQLite connections (preferred -- SQLite is safe
   for concurrent readers with WAL mode)
2. Read the Y.Doc state in the main thread, pass the binary data to the Worker

### Job Retry and Dead Letter Queue

Failed jobs should be retried with exponential backoff:

```typescript
function handleJobFailure(jobId: string, error: string) {
    const job = getJob(jobId);
    if (job.retryCount < job.maxRetries) {
        // Exponential backoff: 5s, 25s, 125s
        const delay = 5000 * Math.pow(5, job.retryCount);
        updateJob(jobId, {
            status: 'queued',
            retryCount: job.retryCount + 1,
            error,
            updatedAt: Date.now(),
        });
        // Job will be picked up after delay (checked via createdAt + delay)
    } else {
        // Move to dead letter state
        updateJob(jobId, {
            status: 'failed',
            error: `Failed after ${job.maxRetries} retries: ${error}`,
        });
        home.notify(buildExportFailedEvent(jobId, error));
    }
}
```

### Job Cleanup

Completed jobs auto-clean after a configurable TTL (default: 1 hour):

```typescript
setInterval(() => {
    const expired = db.all(`
        SELECT id, resultPath FROM export_jobs
        WHERE expiresAt < unixepoch()
    `);
    for (const job of expired) {
        if (job.resultPath) {
            try { fs.unlinkSync(job.resultPath); } catch {}
        }
        db.run('DELETE FROM export_jobs WHERE id = ?', [job.id]);
    }
}, 60_000);
```

### Concurrency Limiting

```typescript
const MAX_CONCURRENT_PDF = 3;
const MAX_CONCURRENT_DOCX = 5;
// Enforced by the Worker: it maintains a count of active jobs by type
// and delays processing if limits are reached
```

### Robustness Assessment

The SQLite-based queue is sufficient for Eigen's scale (single-server, self-hosted). Limitations:

1. **No distributed processing**: If Eigen ever goes multi-server, this queue cannot distribute work. That is
   acceptable per CLAUDE.md's architecture -- Eigen is single-server today.
2. **WAL mode concurrent access**: SQLite with WAL supports concurrent readers and a single writer. The main
   thread writes job records; the Worker reads them. This works well as long as both use the same database file.
3. **Crash recovery**: If the server crashes mid-export, jobs stuck in `processing` status should be reset to
   `queued` on startup (with `retryCount` incremented).
4. **No priority queues**: All jobs are FIFO. If needed, add a `priority` column later.

---

## 12. Image and Media Handling

### Export: Resolving Drive Image URLs

Images in eigendoc are stored in the `media/` subfolder and referenced via Drive embed URLs:
`/drive/:ownerId/:mountId/file/:pathId/embed/:fileName`

For export, these URLs must be resolved to actual image bytes:

1. **Parse the URL** to extract `ownerId`, `mountId`, and `pathId`
2. **Read from storage** via `mount.readFile(pathId)` (no HTTP request needed, direct storage access)
3. **Convert to the target format's image format**:
   - PDF (pdfkit): raw buffer passed to `doc.image()`
   - PDF (Puppeteer): base64 data URI in HTML
   - DOCX: raw binary buffer (docx package embeds it in the ZIP)
   - HTML export: base64 data URI (self-contained) or original URL (for web publishing)
   - Markdown: relative path or URL

### Import: Extracting Images from Source Files

**From DOCX**: mammoth.js provides an `images.imgElement` callback that yields image buffers. Each image is:
1. Uploaded to the eigendoc's `media/` folder via `mount.createFile()`
2. A Drive embed URL is generated
3. The URL is inserted into the ProseMirror JSON

**From Markdown**: Images are referenced as URLs or relative paths:
- **External URLs** (`https://...`): Keep as-is (linking, not embedding). Optionally download and embed.
- **Relative paths** (`./image.png`): Resolve relative to the markdown file's location in Drive, copy to the
  eigendoc's `media/` folder.

**From HTML**: Images can be `<img src="...">` with various sources:
- Data URIs: Extract binary data, upload to media folder
- External URLs: Keep as-is or download and embed
- Relative paths: Resolve and copy

### Image Format Conversion

The `sharp` library (already an API dependency at `^0.34.0`) handles format conversion:
- WebP -> PNG for DOCX compatibility (older Word versions do not support WebP)
- SVG -> PNG for DOCX (DOCX does not support SVG)
- Large images -> downscaled for DOCX to keep file size reasonable (max 2000px width)

---

## 13. Security Considerations

### Malicious DOCX Files

DOCX files are ZIP archives containing XML. They present several attack vectors:

1. **XML Bombs (Billion Laughs attack)**: A DOCX can contain XML with recursive entity definitions that expand
   to gigabytes of data when parsed. mammoth.js uses a standard XML parser that may be vulnerable.

   **Mitigation**: Before passing to mammoth, check the uncompressed size of the DOCX ZIP entries. Reject files
   where any single XML file exceeds 50MB or total uncompressed size exceeds 500MB.

   ```typescript
   import JSZip from 'jszip';

   async function validateDocxSafety(buffer: ArrayBuffer): Promise<void> {
       const zip = await JSZip.loadAsync(buffer);
       let totalSize = 0;
       for (const [name, entry] of Object.entries(zip.files)) {
           if (entry.dir) continue;
           const data = await entry.async('arraybuffer');
           if (data.byteLength > 50 * 1024 * 1024) {
               throw new Error(`DOCX entry ${name} exceeds 50MB limit`);
           }
           totalSize += data.byteLength;
       }
       if (totalSize > 500 * 1024 * 1024) {
           throw new Error('DOCX total uncompressed size exceeds 500MB limit');
       }
   }
   ```

2. **Macro injection (VBA)**: DOCX files can contain VBA macros (`.docm` extension, or embedded in `.docx`).
   mammoth.js ignores macros entirely, so they are not executed. However, we should still reject files with
   macro content to avoid storing potentially malicious files.

   **Mitigation**: Check for `vbaProject.bin` in the ZIP structure. Warn the user if found.

3. **External entity references (XXE)**: XML parsers can be configured to fetch external URLs via entity
   references. mammoth.js does not appear to resolve external entities, but verify this.

   **Mitigation**: Ensure the XML parser used by mammoth has external entity resolution disabled.

4. **ZIP bombs**: A small DOCX that expands to enormous size.

   **Mitigation**: The size check above catches this. Also set a maximum input file size (50MB).

### Malicious HTML Import

HTML import via `generateJSON()` processes arbitrary HTML. Tiptap's parser only extracts known node/mark types,
so script tags and event handlers are inherently stripped. However:

**Mitigation**: Run HTML through `DOMPurify` (already a dependency: `isomorphic-dompurify`) before parsing:

```typescript
import DOMPurify from 'isomorphic-dompurify';

const cleanHtml = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
                   'u', 'sub', 'sup', 'a', 'img', 'table', 'tr', 'td', 'th', 'thead', 'tbody',
                   'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'br', 'mark', 'span'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'style', 'class',
                   'data-type', 'data-checked', 'width'],
});
```

### Puppeteer Security (Tier 2 PDF)

Running headless Chromium on a server:
- The HTML content passed to `page.setContent()` should never include user-controlled JavaScript
- Image URLs are pre-resolved to base64 data URIs (no network access needed)
- Use `--no-sandbox` only if running in Docker with appropriate isolation
- Set a page navigation timeout to prevent hanging on malformed content

---

## 14. UI/UX Design

### Export UI Locations

**Location 1: Docs Editor Toolbar (File menu)**

The existing File dropdown in `editor-toolbar.tsx` currently has: New document, Open, Rename, Edit access, Print,
Delete. Add export options:

```
File
  New document
  Open
  Rename
  ---
  Edit access
  Print
  ---
  Export as PDF
  Export as DOCX
  Export as Markdown
  Export as HTML
  Export as plain text
  ---
  Delete
```

**Location 2: Drive Right-Click Context Menu**

When right-clicking an `.eigendoc` file in Drive, add an "Export" submenu:

```
Open
Open in new tab
---
Export >
  PDF
  DOCX
  Markdown
  HTML
---
Rename
Move to...
Delete
```

This allows export without opening the document.

### Import UI Locations

**Location 1: Drive Right-Click Context Menu**

When right-clicking a `.docx` or `.md` file:

```
Open
Preview
---
Import as Eigen Doc
---
Rename
Download
Delete
```

**Location 2: Docs App "Import" Action**

In the File menu:
```
File
  New document
  Open
  Import...           (file picker: accepts .docx, .md, .txt, .html)
```

### Export Progress Dialog

For slow exports, show a modal dialog:

```
+------------------------------------------+
|  Exporting as PDF...                      |
|                                           |
|  [=========>              ]  45%          |
|  Rendering document...                    |
|                                           |
|  [Cancel]                                 |
+------------------------------------------+
```

On completion:

```
+------------------------------------------+
|  Export Complete                           |
|                                           |
|  Your PDF is ready.                       |
|                                           |
|  [Download]  [Save to Drive]  [Close]     |
+------------------------------------------+
```

### Import Report Dialog

After import completes, show what was preserved and what was lost:

```
+------------------------------------------+
|  Import Complete                          |
|                                           |
|  Created: "Annual Report.eigendoc"        |
|                                           |
|  Warnings:                                |
|  - 2 images could not be converted        |
|  - Text box content was flattened         |
|  - Custom styles were normalized          |
|                                           |
|  [Open Document]  [Close]                 |
+------------------------------------------+
```

### Progress Tracking via SSE

```typescript
// Backend emits progress events
home.notify({
    type: 'export:progress',
    data: { jobId, progress: 45, message: 'Rendering document...' }
});

home.notify({
    type: 'export:complete',
    data: { jobId, downloadUrl: `/export/jobs/${jobId}/download`, fileName: 'document.pdf' }
});
```

Frontend SSE handler in `packages/lib/src/core/export/sse-handlers.ts` updates query cache, which drives the
progress dialog.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+P` | Export as PDF |
| `Cmd+Shift+D` | Export as DOCX |
| `Cmd+Shift+M` | Export as Markdown |
| `Cmd+P` | Print (existing, browser native) |

---

## 15. Library Comparison

### For PDF Generation

| Library | Approach | Pros | Cons | Verdict |
|---|---|---|---|---|
| **pdfkit** | Programmatic PDF | Pure JS, fast, small (~2MB), no external binary, works on ARM | Must build layout engine for PM nodes | **Recommended (Tier 1 default)** |
| **puppeteer-core** | Headless Chromium | Highest fidelity, CSS support | Heavy (~300MB Chromium), ARM issues, memory-intensive | **Recommended (Tier 2 opt-in)** |
| **playwright** | Headless browsers | Multi-browser, good API | Same weight as Puppeteer, no practical advantage for PDF | Alternative to Puppeteer if needed |
| **@react-pdf/renderer** | React-based layout | Pure JS, good for simple docs | No HTML input, needs parallel render pipeline | Not recommended |
| **jsPDF** | Client-side PDF | Pure JS, browser-native | Low quality, no complex layouts | Not recommended |
| **weasyprint** | Python + CSS-to-PDF | Good CSS support | Python runtime + GTK deps, complex Docker setup | Not recommended |
| **prince** | Commercial CSS-to-PDF | Best CSS support | Commercial license ($3800) | Out of scope |

### For DOCX

| Library | Approach | Pros | Cons | Verdict |
|---|---|---|---|---|
| **docx** (write) | Declarative OOXML builder | Full control, TS types, well-maintained | Must build from scratch | **Recommended** |
| **mammoth** (read) | DOCX -> semantic HTML | Clean output, deliberate lossy conversion | Loses styling, see limitations in section 4 | **Recommended** |
| **html-to-docx** | HTML -> DOCX | Simple API, less code | Incomplete feature mapping | Fallback option |
| **pandoc** (CLI) | Universal converter | Excellent output quality | External ~100MB binary | Future option |

### For Markdown

| Library | Approach | Pros | Cons | Verdict |
|---|---|---|---|---|
| **tiptap-markdown** | Tiptap extension | Bidirectional, auto-discovers extensions | Requires editor instance for serialization | **Recommended for import** |
| **markdown-it** | Markdown -> HTML | Fast, extensible, GFM support | One-way (parse only) | Import fallback |
| **prosemirror-markdown** | PM <-> Markdown | Direct PM integration | Lower-level API | Direct PM use if needed |

### For HTML

| Library | Approach | Pros | Cons | Verdict |
|---|---|---|---|---|
| **@tiptap/html** | `generateHTML()` + `generateJSON()` | Official Tiptap, no DOM needed | Must match frontend extension set | **Required** |

---

## 16. Performance Considerations

### Export Performance Targets

| Format | Target Time | Bottleneck | Mitigation |
|---|---|---|---|
| Markdown | <100ms | JSON serialization | Sync response |
| TXT | <50ms | Text extraction | Sync response |
| HTML | <200ms | `generateHTML()` + image resolution | Sync response (images optional) |
| PDF (pdfkit) | <3s typical | Layout computation + image embedding | Queue + Worker |
| PDF (Puppeteer) | <5s typical, <15s large | Chromium render | Queue + Worker |
| DOCX | <3s typical, <10s large | Image embedding + ZIP packaging | Queue + Worker |

### Memory Usage

| Operation | Memory | Notes |
|---|---|---|
| Y.Doc loading (100KB doc) | ~5MB | Y.Doc expands significantly in memory |
| Y.Doc loading (1MB doc) | ~50MB | Large documents with many revisions |
| ProseMirror JSON (typical doc) | ~200KB | Much smaller than Y.Doc |
| pdfkit generation | ~10-30MB | Depends on embedded images |
| Puppeteer page | ~50-100MB | Per page, shared browser instance |
| DOCX generation | ~20-50MB | Depends on embedded images |

### Document Size Limits

| Format | Max Input Size | Rationale |
|---|---|---|
| eigendoc -> PDF | 10MB Y.Doc state | Large docs may take too long or exhaust memory |
| eigendoc -> DOCX | 10MB Y.Doc state | Image embedding can be slow |
| DOCX -> eigendoc | 50MB DOCX file | mammoth.js handles large files reasonably |
| Markdown -> eigendoc | 2MB markdown | ProseMirror performance degrades |

### Caching

For frequently exported documents, cache the intermediate ProseMirror JSON (keyed by Y.Doc state vector hash).
If the document has not changed since the last export, skip the Y.Doc loading step. Invalidate on any Yjs update.

This optimization is Phase 2+ -- the initial implementation regenerates from scratch each time.

---

## 17. Cross-Cutting Concerns

### Export and the Copy-Paste System

The Eigen Clipboard Protocol (RESEARCH_COPY_PASTE.md) and export share a common problem: resolving Drive image
URLs to actual image data. The clipboard system already handles image re-upload across documents
(`needsReUpload()` and `reUploadImage()` in `packages/lib/src/core/clipboard/`). Export should reuse the same
image resolution logic (server-side equivalent of what the clipboard does client-side).

Key overlap:
- Both need to parse Drive embed URLs to extract `ownerId`, `mountId`, `pathId`
- Both need to read image bytes from storage
- Both need to handle images from different owners/mounts (permission checking)

Recommendation: Extract a shared `resolveImageUrl(url: string): { ownerId, mountId, pathId }` utility into
`packages/lib/src/core/docs/` that both systems use.

### Import and Inline Editing

RESEARCH_INLINE_EDITING.md proposes editing `.md` and `.docx` files directly in the Docs app without converting
to `.eigendoc`. Import is the **conversion** path -- when the user explicitly wants to convert to eigendoc. The
infrastructure overlaps:

- Both use mammoth.js for DOCX -> HTML
- Both use `tiptap-markdown` for Markdown parsing
- Both need server-side Tiptap extension registries

Share the conversion pipeline. Inline editing calls it transiently (in-memory round-trip), import calls it
persistently (writes to a new eigendoc).

### PDF Export and the Preview System

RESEARCH_PREVIEWS.md describes generating previews for eigendoc files. The preview pipeline is:
Y.Doc -> PM JSON -> HTML -> rendered thumbnail/preview.

This is the same pipeline as PDF export (sections 7 and 8). Share the infrastructure:
- `eigendocToHTML()` serves both preview generation and export
- The server-side extension registry is shared
- Image resolution is shared

If Puppeteer (Tier 2) is available, it can also generate preview thumbnails (higher quality than sharp-based
HTML rendering). The preview system should check for Chromium availability and use it when present.

### Export and Media References

When a document contains images from different owners or mounts (e.g., an image pasted from a shared document),
the export must:

1. Check read permissions for each image's source
2. Skip inaccessible images with a `[Image not available]` placeholder
3. Handle images that no longer exist (deleted from source)

This is the same access control logic that the Drive embed endpoint (`/drive/:ownerId/:mountId/file/:pathId/embed/:fileName`)
already performs. The export image resolver should use the same permission checks.

### Batch Export

Export a whole Drive folder as a ZIP:

1. User selects multiple `.eigendoc` files in Drive (or a folder containing them)
2. Right-click -> "Export all as PDF" (or DOCX, etc.)
3. Creates one job per document, tracked as a batch
4. When all complete, pack results into a ZIP
5. Download the ZIP

Implementation: Add a `batchId` column to the job queue. A batch-completion check runs after each job finishes.
When all jobs in a batch are complete, generate the ZIP.

### Email Attachment Export

When composing an email in the Mail app, allow attaching an eigendoc as PDF or DOCX:

1. "Attach from Drive" -> select `.eigendoc`
2. Prompt: "Attach as: PDF / DOCX / Link"
3. If PDF or DOCX, trigger export and attach the result

This depends on the Mail app having an attachment system that can wait for async export completion.

### Sharing Exported PDFs

After export, the "Save to Drive" option saves the PDF/DOCX back to Drive alongside the original eigendoc.
The saved file then benefits from all existing Drive features: sharing, ACL, preview, download links.

For external sharing without a Drive account, consider a "Create public link" option that generates a
time-limited download URL for the exported file (similar to Google Docs' "Anyone with the link" for PDFs).

### Publish as Webpage

HTML export can double as a "publish" feature:

1. Export as HTML (self-contained, with base64 images)
2. Save to a `published/` folder in Drive
3. Serve published files via a public route (`/published/:id`)
4. Generate a shareable URL

This is a lightweight alternative to a full CMS. The published HTML is static (not live-updated when the
eigendoc changes). A "Republish" action regenerates the HTML.

Implementation cost is low since HTML export already exists. The main work is the public serving route and
a simple published-documents registry.

### Export Templates

For professional output, support export templates:

1. **PDF templates**: Letterhead (logo + company info in header), report format (cover page + ToC + content),
   minimal (clean typography, no decoration)
2. **DOCX templates**: Corporate branding (header/footer with logo, standard fonts/colors), academic
   (double-spaced, Times New Roman), minimal

Templates are stored as JSON configuration + optional header/footer images in a system directory. The export
options dialog lets users select a template.

Phase 6+ feature. Initial implementation uses a single default template per format.

---

## 18. Edge Cases and Limitations

### Edge Cases

| Case | Behavior | Mitigation |
|---|---|---|
| Empty document | Export produces empty file (PDF: blank page, DOCX: empty doc, Markdown: empty string) | Check for empty content, warn user |
| Document being edited (active Yjs session) | Export reads the latest persisted state, which may lag behind real-time edits | Flush pending updates before export (`createSnapshot()`) |
| Images from different owners/mounts | Embed URL parsing extracts ownerId/mountId/pathId; must have read permission | Check permissions; skip inaccessible images with placeholder |
| External image URLs (non-Drive) | URL may not be resolvable from the server | pdfkit: skip with placeholder; Puppeteer: let it try to fetch (may fail) |
| Very wide tables (10+ columns) | PDF may not fit on page | Scale table to fit page width, or switch to landscape for that page |
| Code blocks with long lines | PDF line wrapping | CSS `white-space: pre-wrap` in PDF template |
| Document with 100+ images | Slow export, high memory | Limit concurrent image fetches (semaphore); stream images |
| Unicode content (emoji, RTL, CJK) | PDF font embedding | pdfkit: embed a Unicode-capable font (Noto Sans); Puppeteer: system fonts |
| Nested lists (5+ levels) | Markdown: deep indentation; DOCX: numbering levels | Cap at 9 levels (DOCX limit) |
| Merged table cells -> Markdown | GFM tables do not support colspan/rowspan | Flatten: merged cells become repeated content |
| Concurrent export of same document | Multiple jobs for same doc | Allow it -- each job reads its own Y.Doc snapshot |

### Known Limitations

1. **Comments are stripped from all exports.** Eigendoc comments are stored as separate `.eigenchat` directories
   linked via `CommentMark`. No standard representation exists in PDF/Markdown. DOCX comments (Word's comment
   feature) could be supported in Phase 6+.

2. **Syntax highlighting in code blocks**: PDF (pdfkit tier) renders code as monospace text without color
   highlighting. PDF (Puppeteer tier) renders highlighted code via CSS classes. DOCX renders as monospace only.

3. **PDF is not editable.** Unlike DOCX, the PDF is a rendered snapshot. Use DOCX for interoperability.

4. **DOCX round-trip is lossy.** A DOCX -> eigendoc -> DOCX cycle loses formatting (mammoth strips styling on
   import, `docx` builds different XML on export). This is fundamental to the intermediate ProseMirror
   representation.

5. **Markdown export of tables with merged cells** produces simplified/ugly markdown. GFM tables are flat grids.

6. **Image quality**: Images are embedded at stored resolution. No upscaling. Large images may be downscaled for
   DOCX to keep file size under control (max 2000px width via sharp).

7. **pdfkit fidelity gap**: The Tier 1 (pdfkit) PDF output will not match the browser rendering pixel-for-pixel.
   Tables, code blocks, and images will look correct but not identical to the Tiptap editor. Users who need
   exact visual fidelity should use Tier 2 (Puppeteer) or the existing browser Print function.

---

## 19. Implementation Phases

### Phase 1: Core Export Infrastructure + HTML/Markdown/TXT Export (2-3 weeks)

**Goal**: Server-side document content extraction and fast format exports.

**Tasks**:
1. Add `@tiptap/html`, `y-prosemirror`, and all `@tiptap/extension-*` packages to API dependencies
2. Create server-side extension registry with `ServerResizableImage` node
3. Extract Y.Doc loading logic from `DbProvider` into a shared utility
4. Implement `eigendocToHTML()` pipeline (Y.Doc -> PM JSON -> HTML)
5. Implement `eigendocToMarkdown()` (PM JSON -> markdown)
6. Implement `eigendocToTXT()` (PM JSON -> plain text extraction)
7. Create export route (`apps/api/src/routes/export.ts`) with `POST /export/:ownerId/:mountId/:pathId`
8. Add "Export as Markdown / HTML / TXT" to the docs File menu
9. Add `useExport()` hook in `packages/lib/src/core/export/hooks/`
10. Image URL resolution for HTML export (Drive embed URLs -> base64 data URIs)

**Exit criteria**: Can export any eigendoc as HTML, Markdown, or TXT from the toolbar. HTML includes resolved
images. Markdown correctly represents all markdown-compatible content.

### Phase 2: PDF Export + Job Queue + Bun Worker (2-3 weeks)

**Goal**: Export eigendoc as PDF with progress tracking.

**Tasks**:
1. Add `pdfkit` to API dependencies
2. Implement ProseMirror JSON -> pdfkit rendering (paragraphs, headings, lists, tables, images, code blocks)
3. Create SQLite job queue schema and `ExportWorker` (Bun Worker)
4. Add SSE events for export progress (`export:progress`, `export:complete`, `export:failed`)
5. Create `ExportProgressDialog` component in docs app
6. Add export SSE handlers in `packages/lib/src/core/export/sse-handlers.ts`
7. Add "Export as PDF" to File menu with progress dialog
8. Add PDF export options: page size, margins, header/footer toggle
9. Add job retry logic and cleanup
10. Add concurrency limiting
11. Optionally: add `puppeteer-core` support with Chromium auto-detection (Tier 2)

**Exit criteria**: Can export any eigendoc as PDF. PDF includes all images, tables, and formatted text. Progress
dialog shows real-time progress. Works without Chromium installed.

### Phase 3: DOCX Export (2 weeks)

**Goal**: Export eigendoc as DOCX with full formatting.

**Tasks**:
1. Add `docx` npm package to API dependencies
2. Implement PM JSON -> DOCX converter (paragraphs, headings, lists, tables, images)
3. Handle table colspan/rowspan, task lists, text colors/highlights
4. Handle image embedding (resolve, convert WebP/SVG via sharp, embed in DOCX ZIP)
5. Add "Export as DOCX" to File menu (uses job queue)
6. Add to Drive context menu

**Exit criteria**: DOCX opens correctly in Microsoft Word and LibreOffice Writer.

### Phase 4: Import (DOCX + Markdown -> eigendoc) (2-3 weeks)

**Goal**: Convert uploaded DOCX and Markdown files to eigendoc.

**Tasks**:
1. Add `mammoth` to API dependencies
2. Implement DOCX safety validation (ZIP bomb, XML bomb, macro detection)
3. Implement DOCX -> eigendoc pipeline (mammoth -> HTML -> PM JSON -> Y.Doc)
4. Implement Markdown -> eigendoc pipeline (markdown-it -> HTML -> PM JSON -> Y.Doc)
5. Handle image extraction and storage
6. Create import route (`apps/api/src/routes/import.ts`)
7. Add "Import as Eigen Doc" to Drive context menu
8. Add "Import..." to Docs File menu
9. Show import report with warnings
10. Handle HTML and TXT import

**Exit criteria**: Can import DOCX and Markdown files. Images extracted correctly. Import warnings shown.

### Phase 5: Drive Integration + Polish (1-2 weeks)

**Goal**: Batch export, Drive context menu integration, refinements.

**Tasks**:
1. Export from Drive context menu without opening the document
2. Batch export: select multiple eigendocs -> "Export all as PDF" -> ZIP download
3. Export options dialog (page size, margins, template selection)
4. Error handling and retry UI
5. "Save to Drive" for exported files

### Phase 6: Advanced Features (Future)

1. DOCX comment export (eigendoc comments -> Word comments)
2. Export templates (letterhead, report format)
3. "Publish as webpage" feature
4. ODT export/import via Pandoc
5. Batch import (upload folder of DOCX files -> convert all)
6. Email attachment export integration
7. Export with revision history visualization

---

## Appendix A: How Google Docs and Notion Handle Export

### Google Docs

- Export is synchronous for most formats (DOCX, PDF, ODT, RTF, TXT, HTML)
- PDF is generated server-side using Google's internal renderer (not Chromium)
- Download starts immediately for documents under ~100 pages
- Export via direct URL: `docs.google.com/document/d/{id}/export?format=pdf`
- No job queue visible to the user

### Notion

- Export is queued for all formats (Markdown, HTML, PDF)
- "Preparing export..." dialog with spinner (no percentage progress)
- PDF uses a server-side renderer (believed to be Chromium-based)
- Bulk export produces a ZIP and sends email when complete
- Markdown is their primary interop format
- DOCX is not supported

### Implications for Eigen

- For fast formats (Markdown, HTML, TXT): Follow Google Docs -- synchronous download, no queue.
- For slow formats (PDF, DOCX): Queue with progress dialog, but with real percentage progress (not just a
  spinner), since we control the pipeline and can report stages.

---

## Appendix B: Server-Side Dependencies Summary

New dependencies required for the API server:

| Package | Purpose | Size (gzipped) | Phase |
|---|---|---|---|
| `@tiptap/html` | `generateHTML()` / `generateJSON()` server-side | ~15KB | 1 |
| `@tiptap/core` | Extension runtime for server | ~50KB | 1 |
| `@tiptap/starter-kit` | StarterKit extension (server-side) | ~30KB | 1 |
| `@tiptap/extension-*` (12 packages) | All editor extensions for server parity | ~100KB total | 1 |
| `y-prosemirror` | `yDocToProsemirrorJSON()` | ~20KB | 1 |
| `lowlight` | Syntax highlighting for code blocks | ~30KB | 1 |
| `pdfkit` | PDF generation (Tier 1) | ~200KB | 2 |
| `puppeteer-core` | Headless Chromium control (Tier 2, optional) | ~150KB | 2 |
| `docx` | DOCX generation | ~150KB | 3 |
| `mammoth` | DOCX import | ~80KB | 4 |
| `markdown-it` | Markdown parsing (for import) | ~30KB | 4 |

**Note**: The Tiptap extension packages are already dependencies of `apps/docs`. Adding them to `apps/api`
means they load in the API server process. This is ~200KB of additional JS, acceptable. The extensions are pure
JavaScript (the React parts like `ReactNodeViewRenderer` are in separate entry points not imported on the server).

**Chromium binary** (Tier 2 only): Not an npm dependency. Managed via system package manager (Docker:
`apt-get install chromium`), environment variable (`CHROMIUM_PATH`), or auto-detection of installed Chrome.
The current Dockerfile uses `oven/bun:1-slim` with `apt-get` -- adding Chromium would require:
```dockerfile
RUN apt-get install -y chromium
ENV CHROMIUM_PATH=/usr/bin/chromium
```
This adds ~300MB to the image. Consider offering a separate `Dockerfile.with-chromium` for users who want Tier 2.
