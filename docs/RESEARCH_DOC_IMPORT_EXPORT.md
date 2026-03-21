# Proposal: Document Import/Export for Eigen Docs

> **TLDR**: Add import (DOCX/Markdown/HTML/TXT → eigendoc) and export (eigendoc → PDF/DOCX/Markdown/HTML/TXT).
> Phase 1 exports client-side (Markdown, HTML, TXT, PDF via browser print) from the open editor. Phase 2 adds
> server-side export (DOCX, Puppeteer PDF) and import (DOCX, Markdown, HTML, TXT → eigendoc). No custom PDF
> layout engine — PDF uses browser print or opt-in Puppeteer. Self-hosted fonts from `RESEARCH_TYPOGRAPHY.md`
> (Inter, Source Serif 4, JetBrains Mono, Excalifont) are embedded in export templates for consistent output.
> Estimated total: ~8 weeks across 4 phases.

## Table of Contents

1. [Current State](#1-current-state)
2. [Architecture Overview](#2-architecture-overview)
3. [Content Model & Format Coverage](#3-content-model--format-coverage)
4. [Server-Side Tiptap Setup](#4-server-side-tiptap-setup)
5. [Export: Markdown, HTML, TXT](#5-export-markdown-html-txt)
6. [Export: PDF](#6-export-pdf)
7. [Export: DOCX](#7-export-docx)
8. [Import: DOCX, Markdown, HTML, TXT](#8-import-docx-markdown-html-txt)
9. [Font System for Export](#9-font-system-for-export)
10. [Image & Media Handling](#10-image--media-handling)
11. [Security](#11-security)
12. [UI/UX](#12-uiux)
13. [Concrete File Changes](#13-concrete-file-changes)
14. [Testing Strategy](#14-testing-strategy)
15. [Implementation Phases](#15-implementation-phases)
16. [Known Limitations](#16-known-limitations)

---

## 1. Current State

Eigen Docs has no import or export functionality. Documents are stored as `.eigendoc` directories containing a
`data.db` SQLite file with Yjs updates and snapshots (see `apps/api/src/lib/collab/collabDocument.ts`). The editor
uses Tiptap (ProseMirror-based) with collaborative editing via Yjs + WebSocket.

The only "export" available today is the browser Print function (`packages/ui/src/lib/printElement.ts`), which
clones the `[data-document]` DOM element and calls `window.print()`.

Related documents:
- `RESEARCH_TYPOGRAPHY.md` — font system (Inter, Source Serif 4, JetBrains Mono, Excalifont)
- `RESEARCH_COPY_PASTE.md` — clipboard protocol (shares image resolution logic)
- `RESEARCH_PREVIEWS.md` — preview pipeline (shares HTML generation)
- `RESEARCH_INLINE_EDITING.md` — inline editing of .md/.docx (shares conversion pipeline)

---

## 2. Architecture Overview

### Hybrid Approach: Client-Side First, Server-Side Second

**Phase 1 (client-side)**: For open documents, the editor already has the ProseMirror document in memory. Export
Markdown, HTML, and TXT directly from the client by serializing the editor state. PDF uses the existing browser
print path. No server round-trip required.

**Phase 2 (server-side)**: For Drive integration (export without opening a document) and heavy formats (DOCX,
Puppeteer PDF), the server loads the Y.Doc from `data.db`, converts to ProseMirror JSON, then to the target format.
Import is always server-side (receives uploaded file, converts, writes new eigendoc).

```
Client-side export (Phase 1):
  Editor state → ProseMirror JSON → Markdown / HTML / TXT → browser download
  Editor state → DOM clone → window.print() → PDF

Server-side export (Phase 2):
  data.db → Y.Doc → PM JSON → HTML → Puppeteer → PDF
  data.db → Y.Doc → PM JSON → docx builder → DOCX

Server-side import (Phase 2):
  DOCX → mammoth → HTML → DOMPurify → generateJSON() → Y.Doc → data.db
  Markdown → markdown-it → HTML → DOMPurify → generateJSON() → Y.Doc → data.db
  HTML → DOMPurify → generateJSON() → Y.Doc → data.db
  TXT → wrap in <p> tags → generateJSON() → Y.Doc → data.db
```

### Why Not a Job Queue

Fast formats (Markdown, HTML, TXT) complete in <200ms. DOCX and Puppeteer PDF typically complete in <5s. A SQLite
job queue with Bun Workers adds significant complexity (schema, worker lifecycle, SSE progress events, retry logic)
for marginal benefit. Instead:

- **Synchronous response** for all formats initially.
- **Simple timeout**: If export exceeds 30s, abort and return an error.
- **Future**: If real-world usage shows exports regularly exceeding acceptable times, add a lightweight async wrapper
  with a polling endpoint. Do not build this until needed.

### Export Permissions

Export requires `canRead` permission on the document. The existing ACL system (`DriveAccess` / `SharedDrive`) is
checked on the export route. Import creates a new file, requiring `canWrite` on the target folder.

---

## 3. Content Model & Format Coverage

### Tiptap Extensions in Use

From `apps/docs/src/components/docs/editor.tsx`:

| Extension | PM Node/Mark | Type |
|---|---|---|
| StarterKit | paragraph, heading, bold, italic, strike, code, codeBlock, blockquote, bulletList, orderedList, listItem, hardBreak, horizontalRule | Nodes + Marks |
| Underline | underline | Mark |
| TextAlign | textAlign attribute | Attribute |
| TaskList / TaskItem | taskList, taskItem | Nodes |
| Link | link | Mark |
| Highlight | highlight | Mark |
| Subscript / Superscript | subscript, superscript | Marks |
| Typography | smartQuotes, ellipsis, etc. | Input rules |
| Table / TableRow / TableCell / TableHeader | table, tableRow, tableCell, tableHeader | Nodes |
| TextStyle + Color | textStyle (color attribute) | Mark |
| CodeBlockLowlight | codeBlock (language attribute) | Node |
| ResizableImage | resizableImage (mediaName, width, alignment) | Node |
| CommentMark | comment | Mark |
| CharacterCount | — | Extension |
| Collaboration / CollaborationCursor | — | Extensions |

### Export Format Coverage

| Content | Markdown | HTML | TXT | PDF (print) | PDF (Puppeteer) | DOCX |
|---|---|---|---|---|---|---|
| Paragraphs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Headings (H1-H3) | ✅ | ✅ | prefix | ✅ | ✅ | ✅ |
| Bold / Italic / Strike | ✅ | ✅ | strip | ✅ | ✅ | ✅ |
| Underline | ✅ `<u>` | ✅ | strip | ✅ | ✅ | ✅ |
| Links | ✅ `[text](url)` | ✅ | URL in parens | ✅ | ✅ | ✅ hyperlink |
| Images | `![alt](url)` | ✅ base64 | `[Image: alt]` | ✅ | ✅ | ✅ embedded |
| Tables | ✅ GFM | ✅ | tab-separated | ✅ | ✅ | ✅ |
| Task lists | `- [x]` / `- [ ]` | ✅ | `[x]` / `[ ]` | ✅ | ✅ | ✅ checkbox |
| Code blocks | ✅ fenced | ✅ `<pre><code>` | as-is | ✅ | ✅ highlighted | ✅ monospace |
| Blockquotes | ✅ `>` | ✅ | `> ` prefix | ✅ | ✅ | ✅ indent |
| Text color | strip | ✅ inline style | strip | ✅ | ✅ | ✅ run color |
| Highlight | strip | ✅ `<mark>` | strip | ✅ | ✅ | ✅ shading |
| Subscript/Superscript | strip | ✅ `<sub>`/`<sup>` | strip | ✅ | ✅ | ✅ |
| Text align | strip | ✅ style | strip | ✅ | ✅ | ✅ |
| Horizontal rule | `---` | ✅ `<hr>` | `---` | ✅ | ✅ | ✅ |
| Table merged cells | flatten | ✅ colspan/rowspan | flatten | ✅ | ✅ | ✅ merge |
| Comments | strip | strip | strip | strip | strip | strip |

### Import Format Coverage

| Source | Supported? | Library | Fidelity |
|---|---|---|---|
| DOCX | ✅ | mammoth.js | Semantic — loses custom styles, keeps structure |
| Markdown | ✅ | markdown-it → HTML → PM JSON | High for GFM content |
| HTML | ✅ | DOMPurify → generateJSON() | High — maps to known nodes/marks |
| TXT | ✅ | Wrap in `<p>` tags | Paragraphs only |

---

## 4. Server-Side Tiptap Setup

The server needs to convert between Y.Doc state and ProseMirror JSON, and between PM JSON and HTML. This requires
a headless Tiptap extension registry matching the editor's extensions (minus React-specific parts).

### Shared Extension Registry

Create `packages/lib/src/core/docs/extensions.ts`:

```typescript
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import {common, createLowlight} from 'lowlight';
import {Node, mergeAttributes} from '@tiptap/core';

const ServerResizableImage = Node.create({
    name: 'resizableImage',
    group: 'block',
    atom: true,
    addAttributes() {
        return {
            mediaName: {default: null},
            src: {default: null},
            alt: {default: null},
            title: {default: null},
            width: {default: null},
            alignment: {default: 'center'},
        };
    },
    parseHTML() {
        return [{tag: 'img[data-media-name]'}, {tag: 'img[src]'}];
    },
    renderHTML({HTMLAttributes}) {
        const {mediaName, alignment, ...rest} = HTMLAttributes;
        return ['div', {style: `text-align: ${alignment || 'center'}`},
            ['img', mergeAttributes(rest, {'data-media-name': mediaName})]
        ];
    },
});

const lowlight = createLowlight(common);

export function getServerExtensions() {
    return [
        StarterKit.configure({codeBlock: false}),
        Underline,
        TextAlign.configure({types: ['heading', 'paragraph']}),
        TaskList,
        TaskItem.configure({nested: true}),
        Link.configure({openOnClick: false}),
        Highlight.configure({multicolor: true}),
        Subscript,
        Superscript,
        Table.configure({resizable: false}),
        TableRow,
        TableCell,
        TableHeader,
        TextStyle,
        Color,
        CodeBlockLowlight.configure({lowlight}),
        ServerResizableImage,
    ];
}
```

`ServerResizableImage` is the server-side equivalent of the client's `ResizableImage` extension
(`apps/docs/src/components/docs/extensions/resizable-image.tsx`). It preserves the `mediaName` attribute (used for
Drive image references) and the `alignment` attribute, and renders as a `<div>` with alignment + `<img>` with a
`data-media-name` attribute. The image resolution step (mediaName → base64 data URI) happens separately during
export (see section 10).

### Y.Doc to ProseMirror JSON

```typescript
import * as Y from 'yjs';
import {yDocToProsemirrorJSON} from 'y-prosemirror';

export function loadProsemirrorJSON(docPath: string): Record<string, unknown> {
    const db = new Database(path.join(docPath, 'data.db'));
    const ydoc = new Y.Doc();

    // Load latest snapshot + subsequent updates (same pattern as DbProvider.loadState)
    const snapshot = db.query('SELECT stateData FROM doc_snapshots ORDER BY id DESC LIMIT 1').get();
    if (snapshot) {
        Y.applyUpdate(ydoc, snapshot.stateData);
    }
    const updates = snapshot
        ? db.query('SELECT updateData FROM doc_updates WHERE id > ? ORDER BY id',
            [db.query('SELECT lastUpdateId FROM doc_snapshots ORDER BY id DESC LIMIT 1').get()?.lastUpdateId ?? 0]).all()
        : db.query('SELECT updateData FROM doc_updates ORDER BY id').all();

    for (const update of updates) {
        Y.applyUpdate(ydoc, update.updateData);
    }

    const json = yDocToProsemirrorJSON(ydoc, 'default');
    ydoc.destroy();
    db.close();
    return json;
}
```

This mirrors the `DbProvider.loadState()` logic in `apps/api/src/lib/collab/collabDocument.ts` but runs
standalone (no WebSocket, no update handler). The `'default'` fragment name matches the Collaboration extension's
default.

---

## 5. Export: Markdown, HTML, TXT

### Phase 1: Client-Side (from open editor)

When a document is open in the editor, the Tiptap `editor` instance is available. Serialize directly:

```typescript
// Markdown — use tiptap-markdown
import {Markdown} from 'tiptap-markdown';
// Register Markdown extension in editor, then:
const md = editor.storage.markdown.getMarkdown();

// HTML — use generateHTML with the editor's JSON
import {generateHTML} from '@tiptap/html';
const html = generateHTML(editor.getJSON(), getServerExtensions());

// TXT — extract text content
const txt = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n\n', '\n');
```

Trigger download via a Blob + `<a download>`:

```typescript
function downloadFile(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], {type: mimeType});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
```

### Phase 2: Server-Side (from Drive, without opening)

Route: `GET /export/:ownerId/:mountId/:pathId/:format`

```typescript
import {generateHTML} from '@tiptap/html';
import {getServerExtensions} from '@workspace/lib/core/docs/extensions';

// In the route handler:
const json = loadProsemirrorJSON(docPath);
const extensions = getServerExtensions();

switch (format) {
    case 'html': return generateHTML(json, extensions);
    case 'markdown': return prosemirrorToMarkdown(json);
    case 'txt': return extractText(json);
}
```

The `prosemirrorToMarkdown()` function walks the PM JSON tree and serializes to GFM-compatible Markdown. The
`extractText()` function recursively extracts text nodes with paragraph breaks.

---

## 6. Export: PDF

### Default: Browser Print (Phase 1)

The existing `printDocument()` in `packages/ui/src/lib/printElement.ts` already works. It clones the
`[data-document]` element and triggers `window.print()`. The browser's native print-to-PDF produces high-fidelity
output that exactly matches the editor rendering, including all fonts loaded via `RESEARCH_TYPOGRAPHY.md`.

Improvement for Phase 1: wrap the existing print flow in the export UI so "Export as PDF" triggers `window.print()`
with a pre-selected "Save as PDF" hint (not possible to force programmatically, but the UX is clear).

### Opt-In: Puppeteer (Phase 2)

For server-side PDF generation (headless, no browser UI) or Drive context menu export:

```typescript
import puppeteer from 'puppeteer-core';

async function htmlToPdf(html: string, chromiumPath: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
        executablePath: chromiumPath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, {waitUntil: 'networkidle0'});
    const pdf = await page.pdf({
        format: 'A4',
        margin: {top: '2cm', right: '2cm', bottom: '2cm', left: '2cm'},
        printBackground: true,
    });
    await browser.close();
    return Buffer.from(pdf);
}
```

Puppeteer is opt-in via the `CHROMIUM_PATH` environment variable. If not set, server-side PDF export returns a
`501 Not Implemented` error with a message directing the user to use browser print or configure Chromium.

The HTML template passed to Puppeteer includes `@font-face` declarations for the self-hosted fonts (see section 9)
so the PDF renders with consistent typography regardless of the server OS.

### Why Not pdfkit

Building a custom ProseMirror-to-PDF layout engine with `pdfkit` requires implementing paragraph wrapping, heading
styles, list indentation, table layout (with colspan/rowspan), image positioning, code block formatting, and text
color — essentially a mini word processor. This is months of work for a result that will never match the browser's
rendering quality. Puppeteer gives pixel-perfect output for a fraction of the effort.

---

## 7. Export: DOCX

Server-side only (Phase 2). Uses the `docx` npm package to build Open XML from ProseMirror JSON.

```typescript
import {Document, Packer, Paragraph, TextRun, HeadingLevel, Table as DocxTable, ...} from 'docx';

function prosemirrorToDocx(json: Record<string, unknown>): Promise<Buffer> {
    const children = convertNodes(json.content);
    const doc = new Document({
        sections: [{properties: {}, children}],
    });
    return Packer.toBuffer(doc);
}
```

The `convertNodes()` function walks the PM JSON tree and maps each node type to `docx` objects:

| PM Node | DOCX Object |
|---|---|
| paragraph | `Paragraph` with `TextRun` children |
| heading (level N) | `Paragraph` with `HeadingLevel.HEADING_N` |
| bulletList / orderedList | `Paragraph` with `numbering` config |
| taskItem | `Paragraph` with checkbox symbol prefix |
| table | `DocxTable` with `TableRow` / `TableCell` |
| codeBlock | `Paragraph` with monospace font (`JetBrains Mono`) |
| blockquote | `Paragraph` with left indent |
| horizontalRule | `Paragraph` with bottom border |
| resizableImage | `ImageRun` (binary data resolved from Drive) |

Marks map to `TextRun` properties: `bold`, `italics`, `strike`, `underline`, `color`, `highlight`, `superScript`,
`subScript`, `font` (for inline font changes).

Images are resolved from Drive storage, converted to PNG/JPEG via `sharp` if needed (DOCX does not support WebP
or SVG), and embedded as binary data in the DOCX ZIP.

---

## 8. Import: DOCX, Markdown, HTML, TXT

Server-side only (Phase 2). Route: `POST /import/:ownerId/:mountId/:parentId`

Accepts a multipart file upload. Returns the path to the created eigendoc.

### DOCX Import

```typescript
import mammoth from 'mammoth';

async function docxToEigendoc(buffer: Buffer): Promise<Record<string, unknown>> {
    const result = await mammoth.convertToHtml(
        {buffer},
        {
            styleMap: [
                "p[style-name='Heading 1'] => h1",
                "p[style-name='Heading 2'] => h2",
                "p[style-name='Heading 3'] => h3",
            ],
        }
    );
    const cleanHtml = sanitizeHtml(result.value);
    return generateJSON(cleanHtml, getServerExtensions());
}
```

**mammoth.js limitations** (accepted trade-offs):
- Loses custom styles, page layout, headers/footers, columns
- Table formatting is simplified (borders, shading lost)
- Text boxes and shapes are ignored
- Embedded charts become static images (if mammoth extracts them) or are lost

These are acceptable because eigendoc's content model (ProseMirror) does not support these features anyway. The
import is deliberately semantic: structure over styling.

### Markdown Import

```typescript
import MarkdownIt from 'markdown-it';

function markdownToEigendoc(md: string): Record<string, unknown> {
    const parser = new MarkdownIt({html: false, linkify: true});
    const html = parser.render(md);
    const cleanHtml = sanitizeHtml(html);
    return generateJSON(cleanHtml, getServerExtensions());
}
```

### HTML Import

```typescript
function htmlToEigendoc(rawHtml: string): Record<string, unknown> {
    const cleanHtml = sanitizeHtml(rawHtml);
    return generateJSON(cleanHtml, getServerExtensions());
}
```

### TXT Import

```typescript
function txtToEigendoc(text: string): Record<string, unknown> {
    const paragraphs = text.split(/\n\n+/).map(p => `<p>${escapeHtml(p)}</p>`).join('');
    return generateJSON(paragraphs, getServerExtensions());
}
```

### Writing the Eigendoc

After conversion to PM JSON, create the eigendoc:

```typescript
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc} from 'y-prosemirror';

function createEigendoc(json: Record<string, unknown>, targetPath: string) {
    const ydoc = prosemirrorJSONToYDoc(getServerSchema(), json, 'default');
    const state = Y.encodeStateAsUpdate(ydoc);

    // Create data.db with the collab schema and insert initial snapshot
    const db = new Database(path.join(targetPath, 'data.db'));
    db.exec(`CREATE TABLE doc_updates (...)`);
    db.exec(`CREATE TABLE doc_snapshots (...)`);
    db.run('INSERT INTO doc_snapshots (stateData, lastUpdateId) VALUES (?, 0)', [Buffer.from(state)]);
    db.close();
    ydoc.destroy();
}
```

This reuses the same schema as `apps/api/src/lib/collab/db-config.ts`.

### Image Extraction (DOCX)

mammoth.js provides an `images` option to handle embedded images:

```typescript
const result = await mammoth.convertToHtml(
    {buffer},
    {
        convertImage: mammoth.images.imgElement(async (image) => {
            const imageBuffer = await image.read();
            const ext = image.contentType.split('/')[1] || 'png';
            const fileName = `imported-${crypto.randomUUID()}.${ext}`;
            // Write to the eigendoc's media folder
            await storage.write(mediaFolderPath, fileName, imageBuffer);
            return {src: fileName}; // Will be resolved via mediaName at render time
        }),
    }
);
```

---

## 9. Font System for Export

Export output must use the self-hosted fonts defined in `RESEARCH_TYPOGRAPHY.md` for consistent rendering across
platforms. This is critical for server-side PDF export, where the server OS may have minimal fonts installed.

### Font Set

| Font | Category | Usage in Export | License |
|---|---|---|---|
| **Inter** | Sans-serif | Default body text, UI elements | OFL |
| **Source Serif 4** | Serif | Documents using serif font family | OFL |
| **JetBrains Mono** | Monospace | Code blocks, inline code | OFL |
| **Excalifont** | Hand-drawn | Hand-drawn/sketch text (stickies, whiteboard contexts) | OFL-1.1 |

**Why these fonts (and not others)**:

- **Inter** is the de facto standard for UI/body text. Variable font, ~100KB woff2. Replaces inconsistent system
  font stacks across macOS/Windows/Linux. No realistic alternative offers better screen rendering + language coverage
  at this file size.

- **Source Serif 4** (Adobe) is designed for on-screen reading with optical sizes. Compared to alternatives:
  **Literata** (Google) is excellent for e-readers but has a warmer, more old-style aesthetic that clashes with
  Inter's geometric clarity. **Charter** (Bitstream) lacks a variable font version and has limited weight range.
  Source Serif 4 pairs naturally with Inter and has the widest weight range (200-900).

- **JetBrains Mono** has the best balance of readability and ligature support among open-source monospace fonts.
  **Fira Code** is a close alternative but JetBrains Mono has a taller x-height (better at small sizes) and is
  more actively maintained. **Cascadia Code** (Microsoft) has similar quality but a different aesthetic.

- **Excalifont** (Excalidraw, 2024) is the successor to Virgil. It provides a distinct hand-drawn aesthetic for
  informal contexts — sticky notes, whiteboard elements, sketch annotations. Available as a single woff2 file with
  Latin, Greek, and Cyrillic support. No other open-source hand-drawn font matches its legibility at this quality
  level. Download: `https://excalidraw.nyc3.cdn.digitaloceanspaces.com/fonts/Excalifont-Regular.woff2`

**Dropped from consideration**: **Plus Jakarta Sans** was originally proposed as a "display/heading" font. However,
Inter at weights 600-800 covers the display use case adequately. Adding a second sans-serif font increases bundle
size and font-loading complexity without meaningful visual differentiation in a productivity context. If a geometric
display font is needed in the future, it can be added to the font registry without architectural changes.

### HTML Template for Puppeteer PDF

The HTML passed to Puppeteer for PDF rendering includes embedded `@font-face` declarations pointing to the
self-hosted font files (served by the API server). The template references the same font files defined in
`packages/ui/src/styles/fonts.css`:

```html
<!DOCTYPE html>
<html>
<head>
<style>
@font-face {
    font-family: 'Inter';
    src: url('file:///path/to/Inter-Variable.woff2') format('woff2-variations');
    font-weight: 100 900;
    font-display: block;
}
@font-face {
    font-family: 'Source Serif 4';
    src: url('file:///path/to/SourceSerif4-Variable.woff2') format('woff2-variations');
    font-weight: 200 900;
    font-display: block;
}
@font-face {
    font-family: 'JetBrains Mono';
    src: url('file:///path/to/JetBrainsMono-Variable.woff2') format('woff2-variations');
    font-weight: 100 800;
    font-display: block;
}
@font-face {
    font-family: 'Excalifont';
    src: url('file:///path/to/Excalifont-Regular.woff2') format('woff2');
    font-weight: 400;
    font-display: block;
}

body {
    font-family: 'Inter', sans-serif;
    font-size: 15px;
    line-height: 1.7;
    color: #000;
    max-width: 210mm;
    margin: 0 auto;
}
h1, h2, h3 { font-weight: 600; }
h1 { font-size: 1.75rem; line-height: 1.2; }
h2 { font-size: 1.375rem; line-height: 1.25; }
h3 { font-size: 1.125rem; line-height: 1.3; }
code, pre { font-family: 'JetBrains Mono', monospace; font-size: 0.875rem; }
pre { background: #f5f5f5; padding: 1rem; border-radius: 6px; overflow-x: auto; }
blockquote { border-left: 3px solid #ddd; padding-left: 1rem; color: #555; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #ddd; padding: 8px; }
th { background: #f5f5f5; font-weight: 600; }
img { max-width: 100%; height: auto; }
</style>
</head>
<body>
{{CONTENT}}
</body>
</html>
```

Font files are referenced via `file://` URLs pointing to the font assets directory on the server. The path is
resolved at runtime from the server's static assets directory. `font-display: block` is used (instead of `swap`)
because Puppeteer must wait for fonts to load before generating the PDF.

### DOCX Font Embedding

DOCX files reference fonts by name. The `docx` package allows specifying font names per `TextRun`. The recipient's
Word/LibreOffice installation must have the fonts installed, or the system will substitute. Since Inter, Source
Serif 4, JetBrains Mono, and Excalifont are freely available OFL fonts, include a note in the export metadata
pointing to download URLs. True font embedding in DOCX requires the `embedTrueTypeFonts` document property, which
the `docx` package supports — enable this for maximum portability.

---

## 10. Image & Media Handling

### Image References in Eigendoc

The `ResizableImage` extension stores images via `mediaName` (not `src`). The `mediaName` is a filename within the
document's media folder in Drive storage. The client resolves `mediaName` to a display URL via the
`useMediaResolver()` hook (`packages/lib/src/core/drive/hooks/use-media-resolver.ts`), which builds a Drive embed
URL: `/drive/:ownerId/:mountId/file/:mediaFolderId/embed/:mediaName`.

### Server-Side Image Resolution

For export, the server must resolve `mediaName` to raw image bytes:

```typescript
async function resolveImage(
    mediaName: string, ownerId: string, mountId: string, mediaFolderId: string, drive: Drive
): Promise<{data: Buffer; mimeType: string} | null> {
    const file = await drive.getFile(ownerId, mountId, mediaFolderId, mediaName);
    if (!file) return null;
    return {data: file.data, mimeType: file.mimeType};
}
```

This reuses the same Drive file access that the embed endpoint uses. Shared image resolution logic should be
extracted into `packages/lib/src/core/docs/image-resolver.ts` (also used by copy-paste and previews).

### Image Processing for Export

| Format | Image Handling |
|---|---|
| HTML | Convert to base64 data URIs: `<img src="data:image/png;base64,...">` |
| Markdown | Reference by name only: `![alt](mediaName)` (not self-contained) |
| PDF (Puppeteer) | Images embedded as base64 in the HTML template |
| DOCX | Binary embedding. Convert WebP/SVG to PNG via `sharp` (DOCX only supports PNG, JPEG, GIF, BMP, TIFF). Limit width to 2000px. |

### Cross-Owner Images

Documents may contain images from different owners/mounts (pasted from shared documents). For each image:
1. Check read permission on the source
2. If accessible, resolve and embed
3. If inaccessible, insert placeholder text: `[Image not available]`

This is the same permission logic used by the Drive embed endpoint.

---

## 11. Security

### DOCX Import Validation

DOCX files are ZIP archives containing XML. Attack vectors:

- **ZIP bomb**: A small file that expands to enormous size. Mitigation: reject files >50MB. Use `yauzl` or similar
  with entry count and total size limits (max 1000 entries, max 200MB uncompressed).
- **XML bomb (Billion Laughs)**: Deeply nested entity expansion. Mitigation: mammoth.js uses `saxes` for parsing,
  which does not expand external entities. Verify this behavior in tests.
- **Macro/ActiveX**: DOCX can contain VBA macros. Mitigation: mammoth.js ignores macro parts entirely. Verify
  by testing with a macro-enabled `.docm` file.

### HTML Import Sanitization

All HTML (from DOCX, Markdown rendering, or direct HTML import) passes through DOMPurify before
`generateJSON()`:

```typescript
import DOMPurify from 'isomorphic-dompurify';

function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
                       'u', 'sub', 'sup', 'a', 'img', 'table', 'tr', 'td', 'th', 'thead', 'tbody',
                       'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'br', 'mark', 'span'],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'style', 'class',
                       'data-type', 'data-checked', 'width', 'data-media-name'],
    });
}
```

`isomorphic-dompurify` is already a project dependency.

### Puppeteer Security

- HTML passed to `page.setContent()` contains no user-controlled JavaScript (only static HTML + CSS)
- All images are pre-resolved to base64 data URIs (no network access)
- Use `--no-sandbox` only in Docker with appropriate container isolation
- Set navigation timeout: `page.setDefaultTimeout(30000)`

### Export Authentication

All export/import routes require authentication via the existing better-auth middleware (`auth: true` in Elysia
route config). Export checks `canRead`, import checks `canWrite`.

---

## 12. UI/UX

### Export from Docs Editor (File Menu)

Add export options to the existing File dropdown in `editor-toolbar.tsx`:

```
File
  New document
  Open
  Rename
  ---
  Edit access
  Print
  ---
  Export as PDF          (Cmd+Shift+P — triggers window.print)
  Export as DOCX         (Phase 2, server-side)
  Export as Markdown
  Export as HTML
  Export as plain text
  ---
  Delete
```

Phase 1: Markdown, HTML, TXT are client-side instant downloads. PDF triggers browser print.
Phase 2: DOCX added (server request + download). PDF gets a "High-quality PDF" option (Puppeteer, if configured).

### Export from Drive Context Menu

When right-clicking an `.eigendoc` file in Drive (Phase 2, server-side only):

```
Open
Open in new tab
---
Export ▸
  PDF
  DOCX
  Markdown
  HTML
---
Rename
Move to...
Delete
```

### Import

**Drive context menu** — when right-clicking a `.docx`, `.md`, `.html`, or `.txt` file:

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

**Docs File menu** (Phase 2):

```
File
  New document
  Open
  Import...           (file picker: accepts .docx, .md, .txt, .html)
```

### Import Report

After import, show a dialog with the result:

```
Import Complete
Created: "Annual Report.eigendoc"

Warnings:
- 2 images could not be extracted
- Custom styles were normalized

[Open Document]  [Close]
```

The warnings list is populated from mammoth's `messages` array and any image resolution failures.

---

## 13. Concrete File Changes

### Phase 1: Client-Side Export

| File | Action |
|---|---|
| `packages/lib/src/core/docs/extensions.ts` | Create shared extension registry (`getServerExtensions()`, `ServerResizableImage`) |
| `packages/lib/src/core/export/client-export.ts` | Create client-side export functions (MD, HTML, TXT, download helper) |
| `packages/lib/src/core/export/hooks/use-export.ts` | Create `useExport()` hook wrapping client export + download |
| `apps/docs/package.json` | Add `tiptap-markdown` dependency |
| `apps/docs/src/components/docs/editor.tsx` | Register `Markdown` extension from `tiptap-markdown` |
| `apps/docs/src/components/docs/editor-toolbar.tsx` | Add export menu items to File dropdown |
| `packages/lib/src/core/export/index.ts` | Create barrel export |

### Phase 2: Server-Side Export + Import

| File | Action |
|---|---|
| `apps/api/package.json` | Add `@tiptap/html`, `@tiptap/core`, all `@tiptap/extension-*`, `y-prosemirror`, `lowlight`, `docx`, `puppeteer-core`, `mammoth`, `markdown-it` |
| `apps/api/src/lib/docs/doc-loader.ts` | Create `loadProsemirrorJSON()` — Y.Doc loading from data.db |
| `apps/api/src/lib/docs/image-resolver.ts` | Create server-side image resolution (mediaName → bytes) |
| `apps/api/src/lib/docs/html-export.ts` | Create `eigendocToHTML()` with image resolution + font template |
| `apps/api/src/lib/docs/docx-export.ts` | Create PM JSON → DOCX converter |
| `apps/api/src/lib/docs/pdf-export.ts` | Create Puppeteer PDF wrapper (opt-in) |
| `apps/api/src/lib/docs/import.ts` | Create import pipeline (DOCX, MD, HTML, TXT → eigendoc) |
| `apps/api/src/routes/export.ts` | Create export route (`GET /export/:ownerId/:mountId/:pathId/:format`) |
| `apps/api/src/routes/import.ts` | Create import route (`POST /import/:ownerId/:mountId/:parentId`) |
| `packages/ui/src/components/layout/drive/drive-table.tsx` | Add "Export" submenu and "Import as Eigen Doc" to context menu |
| `packages/lib/src/core/export/hooks/use-server-export.ts` | Create `useServerExport()` hook for Drive export |
| `packages/lib/src/core/import/hooks/use-import.ts` | Create `useImport()` hook |
| `packages/ui/src/components/layout/docs/import-report-dialog.tsx` | Create import report dialog |

### Font Assets (if not already added by typography work)

| File | Action |
|---|---|
| `packages/ui/src/assets/fonts/excalifont/Excalifont-Regular.woff2` | Add Excalifont woff2 file |

---

## 14. Testing Strategy

### Extension Parity Test

The most critical test: verify that the server extension registry produces identical output to the client editor for
all node/mark types. Create a comprehensive test document covering every extension, export it from both client and
server, and assert the HTML output matches.

```typescript
// packages/lib/src/core/docs/__tests__/extension-parity.test.ts
import {generateHTML, generateJSON} from '@tiptap/html';
import {getServerExtensions} from '../extensions';

const testDoc = {
    type: 'doc',
    content: [
        {type: 'heading', attrs: {level: 1}, content: [{type: 'text', text: 'Test'}]},
        {type: 'paragraph', content: [
            {type: 'text', marks: [{type: 'bold'}], text: 'bold'},
            {type: 'text', marks: [{type: 'italic'}], text: 'italic'},
            {type: 'text', marks: [{type: 'link', attrs: {href: 'https://example.com'}}], text: 'link'},
        ]},
        {type: 'resizableImage', attrs: {mediaName: 'test.png', width: 400, alignment: 'center'}},
        {type: 'table', content: [/* ... */]},
        {type: 'taskList', content: [{type: 'taskItem', attrs: {checked: true}, content: [/* ... */]}]},
        {type: 'codeBlock', attrs: {language: 'typescript'}, content: [{type: 'text', text: 'const x = 1;'}]},
    ],
};

test('server extensions produce valid HTML for all node types', () => {
    const html = generateHTML(testDoc, getServerExtensions());
    expect(html).toContain('<h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('data-media-name="test.png"');
    expect(html).toContain('<table>');
    // ...
});

test('round-trip: HTML → JSON → HTML preserves structure', () => {
    const extensions = getServerExtensions();
    const html = generateHTML(testDoc, extensions);
    const json = generateJSON(html, extensions);
    const html2 = generateHTML(json, extensions);
    expect(html2).toEqual(html);
});
```

### Export Tests

```typescript
// apps/api/src/lib/docs/__tests__/export.test.ts
test('eigendocToHTML resolves images to base64', async () => { /* ... */ });
test('eigendocToMarkdown handles tables, task lists, code blocks', () => { /* ... */ });
test('eigendocToTXT strips all formatting', () => { /* ... */ });
test('docx export produces valid ZIP with document.xml', async () => { /* ... */ });
test('puppeteer PDF export produces valid PDF header', async () => { /* ... */ });
```

### Import Tests

```typescript
// apps/api/src/lib/docs/__tests__/import.test.ts
test('DOCX import preserves headings, lists, tables', async () => { /* ... */ });
test('DOCX import extracts images to media folder', async () => { /* ... */ });
test('Markdown import handles GFM tables and task lists', () => { /* ... */ });
test('HTML import sanitizes script tags', () => { /* ... */ });
test('TXT import creates paragraphs from double newlines', () => { /* ... */ });
test('import rejects ZIP bombs (>50MB)', async () => { /* ... */ });
test('import rejects files exceeding size limits', async () => { /* ... */ });
```

### Manual Testing Checklist

- [ ] Export a document with images, tables, code blocks, task lists as each format
- [ ] Import a complex DOCX from Microsoft Word → verify structure preserved
- [ ] Import a GFM Markdown file → verify tables, task lists, code blocks
- [ ] Import HTML with script tags → verify they are stripped
- [ ] Export from Drive context menu (without opening document)
- [ ] Import from Drive context menu
- [ ] Test with empty document
- [ ] Test with document containing 50+ images
- [ ] Test DOCX round-trip: export → import → compare structure

---

## 15. Implementation Phases

### Phase 1: Client-Side Export (2 weeks)

**Goal**: Export Markdown, HTML, TXT, and PDF (browser print) from the open editor.

**Tasks**:
1. Create shared extension registry in `packages/lib`
2. Create client-side export functions (MD, HTML, TXT)
3. Create `useExport()` hook
4. Add `tiptap-markdown` to docs app, register extension
5. Add export items to the File menu in `editor-toolbar.tsx`
6. Wire "Export as PDF" to existing `printDocument()`

**Exit criteria**: All four formats downloadable from the File menu while editing a document.

### Phase 2: Server-Side Export (2-3 weeks)

**Goal**: Export from Drive context menu. Add DOCX export. Add opt-in Puppeteer PDF.

**Tasks**:
1. Add server dependencies (`@tiptap/html`, `docx`, `puppeteer-core`, etc.)
2. Create `loadProsemirrorJSON()` (Y.Doc → PM JSON from data.db)
3. Create server-side image resolver
4. Create `eigendocToHTML()` with font template and image resolution
5. Create DOCX export (`prosemirrorToDocx()`)
6. Create Puppeteer PDF export (opt-in via `CHROMIUM_PATH`)
7. Create export route with authentication
8. Add "Export" submenu to Drive context menu
9. Create `useServerExport()` hook

**Exit criteria**: Can export any eigendoc as DOCX from Drive context menu. Puppeteer PDF works when Chromium is
configured.

### Phase 3: Import (2-3 weeks)

**Goal**: Import DOCX, Markdown, HTML, TXT files as eigendoc.

**Tasks**:
1. Add `mammoth`, `markdown-it` to API dependencies
2. Create import pipeline (DOCX, MD, HTML, TXT → PM JSON → Y.Doc → data.db)
3. Implement DOCX safety validation (ZIP bomb, size limits)
4. Implement image extraction from DOCX
5. Create import route with authentication
6. Add "Import as Eigen Doc" to Drive context menu
7. Add "Import..." to Docs File menu
8. Create import report dialog

**Exit criteria**: Can import DOCX and Markdown files from Drive and from the Docs File menu. Images extracted
correctly. Import report shows warnings.

### Phase 4: Polish (1 week)

**Goal**: Edge cases, error handling, testing.

**Tasks**:
1. Extension parity tests
2. Export/import integration tests
3. Handle edge cases: empty documents, documents with 100+ images, wide tables, CJK content
4. Error handling UI (export failures, timeout handling)
5. Keyboard shortcuts (`Cmd+Shift+P` for PDF, `Cmd+Shift+M` for Markdown)

**Exit criteria**: All tests pass. Error cases handled gracefully.

### Future (not in scope)

- Batch export (multiple files → ZIP)
- Export templates (letterhead, report format)
- DOCX comment export (eigendoc comments → Word comments)
- "Publish as webpage" feature
- Pandoc integration for ODT/RTF/EPUB
- Email attachment export integration

---

## 16. Known Limitations

1. **Comments are stripped from all exports.** Eigendoc comments are stored as `.eigenchat` directories linked via
   `CommentMark`. No standard representation exists in PDF/Markdown.

2. **DOCX round-trip is lossy.** DOCX → eigendoc → DOCX loses formatting. mammoth strips styling on import, `docx`
   builds different XML on export. This is fundamental to the intermediate ProseMirror representation.

3. **Markdown export of merged table cells** produces simplified GFM. Merged cells are flattened (content repeated).

4. **PDF fidelity depends on method.** Browser print is pixel-perfect. Puppeteer is near-perfect. There is no
   third option — `pdfkit` is explicitly not used due to the prohibitive cost of building a layout engine.

5. **Image quality**: Images are embedded at stored resolution. Large images are downscaled to max 2000px width
   for DOCX to keep file size reasonable.

6. **No Puppeteer by default.** Server-side PDF requires configuring `CHROMIUM_PATH`. The Docker image does not
   include Chromium by default (~300MB). A separate `Dockerfile.with-chromium` can be provided.

7. **Import cannot preserve what eigendoc doesn't support.** DOCX features like columns, text boxes, shapes,
   headers/footers, and page breaks have no equivalent in the ProseMirror schema and are silently dropped.

---

## Appendix: Server-Side Dependencies

| Package | Purpose | Phase |
|---|---|---|
| `tiptap-markdown` | Markdown serialization (client-side) | 1 |
| `@tiptap/html` | `generateHTML()` / `generateJSON()` server-side | 2 |
| `@tiptap/core` + extensions (12 packages) | Server extension runtime | 2 |
| `y-prosemirror` | `yDocToProsemirrorJSON()` / `prosemirrorJSONToYDoc()` | 2 |
| `lowlight` | Syntax highlighting for code blocks | 2 |
| `docx` | DOCX generation | 2 |
| `puppeteer-core` | Headless Chromium (opt-in via `CHROMIUM_PATH`) | 2 |
| `mammoth` | DOCX import | 3 |
| `markdown-it` | Markdown parsing | 3 |
