# Proposal: Server-Side Document Rendering & DOCX Import

## Problem

Eigen's document system (eigendoc, eigenstickies, eigenslides, eigensheets) stores content as binary Yjs updates in
SQLite. There's no server-side way to:

1. Generate HTML previews (for quick-preview in Drive, search indexing, notifications)
2. Export documents to PDF or other formats
3. Import DOCX files by converting them to eigendoc format

All rendering currently happens client-side via tiptap/React.

## Architecture Overview

```
                  ┌──────────────────────────────┐
                  │        Yjs Binary State       │
                  │   (SQLite: docUpdates table)   │
                  └──────────┬───────────────────┘
                             │
                    Y.applyUpdate()
                             │
                  ┌──────────▼───────────────────┐
                  │         Y.Doc instance         │
                  └──────────┬───────────────────┘
                             │
              yXmlFragmentToProsemirrorJSON()    ← y-prosemirror (pure JS, no DOM)
                             │
                  ┌──────────▼───────────────────┐
                  │     ProseMirror JSON          │
                  │  { type: "doc", content: [...] } │
                  └──────┬──────────────┬────────┘
                         │              │
           generateHTML() with          │
           shared extension defs        │
                         │              │
                  ┌──────▼──────┐  ┌───▼────────────┐
                  │    HTML     │  │  DOCX export    │
                  │  (preview)  │  │ (prosemirror-docx)│
                  └─────────────┘  └────────────────┘

                  ┌─────────────┐
                  │  DOCX file  │
                  └──────┬──────┘
                         │
               mammoth (DOCX → HTML)
                         │
                  ┌──────▼──────┐
                  │    HTML     │
                  └──────┬──────┘
                         │
           ProseMirror DOMParser + schema
                         │
                  ┌──────▼───────────────────────┐
                  │     ProseMirror JSON          │
                  └──────┬───────────────────────┘
                         │
              prosemirrorJSONToYDoc()     ← y-prosemirror
                         │
                  ┌──────▼───────────────────────┐
                  │     Y.Doc → binary updates     │
                  └────────────────────────────────┘
```

## Current State

| What | Where | DOM required? |
|------|-------|---------------|
| Yjs doc loading | `CollabDocument.init()` in `apps/api/src/lib/collab/collabDocument.ts` | No |
| Yjs → PM JSON | `yXmlFragmentToProsemirrorJSON()` from `y-prosemirror` | No |
| PM JSON → HTML | `generateHTML()` from `@tiptap/core` | **Yes** (uses `DOMSerializer`) |
| Tiptap extensions | `apps/docs/src/components/docs/extensions/` + StarterKit | Mixed (Figure uses React) |
| Text previews | `apps/api/src/lib/preview/text-preview.ts` | No (markdown-it + DOMPurify) |
| Media resolution | `mediaName` → folder lookup → `getDrivePreviewUrl()` | No |

### Key Constraint

`@tiptap/core`'s `generateHTML()` calls `DOMSerializer.fromSchema(schema).serializeFragment()` which requires
`document.implementation.createHTMLDocument()` — a browser API. This does **not** work in Bun.

## Proposed Approach: Custom JSON-to-HTML Serializer

### Why Not Use Existing Solutions?

| Option | Issue |
|--------|-------|
| `@tiptap/core` `generateHTML()` | Requires browser DOM |
| `@tiptap/static-renderer` | Tiptap 3 only; docs app uses tiptap 2 |
| JSDOM/happy-dom polyfill | Heavy dependency, fragile, slow |
| Upgrade docs to tiptap 3 | Large migration, out of scope for this |

### The Approach

Write a lightweight **ProseMirror JSON → HTML string** serializer that runs in pure JavaScript (no DOM). Each node/mark
type maps to an HTML render function. The render functions are **shared** between frontend parseHTML/renderHTML
definitions and the server-side serializer.

### Shared Extension Definitions

Move the schema-relevant parts of each tiptap extension into a shared package that both frontend and backend can import.
This avoids duplicating node/mark → HTML mappings.

```
packages/lib/src/core/docs/
├── schema.ts              # Shared node/mark HTML mappings
└── html-serializer.ts     # ProseMirror JSON → HTML string (pure JS)
```

**schema.ts** defines the HTML output for each node/mark type as pure data (no DOM, no React):

```typescript
export type NodeMapping = {
    tag: string;
    attrs?: (node: { attrs: Record<string, unknown> }) => Record<string, string>;
    selfClosing?: boolean;
};

export type MarkMapping = {
    tag: string;
    attrs?: (mark: { attrs: Record<string, unknown> }) => Record<string, string>;
};

export const nodeMapping: Record<string, NodeMapping> = {
    paragraph:   { tag: 'p' },
    heading:     { tag: 'h', attrs: (n) => ({ _tag: `h${n.attrs.level}` }) },
    blockquote:  { tag: 'blockquote' },
    bulletList:  { tag: 'ul' },
    orderedList: { tag: 'ol' },
    listItem:    { tag: 'li' },
    taskList:    { tag: 'ul', attrs: () => ({ 'data-type': 'taskList' }) },
    taskItem:    { tag: 'li', attrs: (n) => ({
        'data-type': 'taskItem',
        'data-checked': String(n.attrs.checked),
    }) },
    codeBlock:   { tag: 'pre' },
    table:       { tag: 'table' },
    tableRow:    { tag: 'tr' },
    tableCell:   { tag: 'td' },
    tableHeader: { tag: 'th' },
    horizontalRule: { tag: 'hr', selfClosing: true },
    hardBreak:   { tag: 'br', selfClosing: true },
    figure:      { tag: 'figure' },
};

export const markMapping: Record<string, MarkMapping> = {
    bold:          { tag: 'strong' },
    italic:        { tag: 'em' },
    underline:     { tag: 'u' },
    strike:        { tag: 's' },
    code:          { tag: 'code' },
    subscript:     { tag: 'sub' },
    superscript:   { tag: 'sup' },
    small:         { tag: 'small' },
    highlight:     { tag: 'mark', attrs: (m) => (
        m.attrs.color ? { style: `background-color: ${m.attrs.color}` } : {}
    ) },
    link:          { tag: 'a', attrs: (m) => ({
        href: String(m.attrs.href),
        target: '_blank',
        rel: 'noopener noreferrer',
    }) },
    textStyle:     { tag: 'span', attrs: (m) => {
        const styles: string[] = [];
        if (m.attrs.color) styles.push(`color: ${m.attrs.color}`);
        if (m.attrs.fontFamily) styles.push(`font-family: ${m.attrs.fontFamily}`);
        return styles.length ? { style: styles.join('; ') } : {};
    }},
};
```

**html-serializer.ts** walks ProseMirror JSON and produces HTML strings. Uses `escapeHtml()` for all text content and
attribute values to prevent XSS. Output is additionally sanitized via DOMPurify before serving.

### Media Resolution

The `figure` node stores a `mediaName` attribute (e.g., `photo.jpg`), not a URL. Server-side, the serializer needs a
`resolveMediaUrl` callback:

```typescript
const html = serializeDoc(pmJson, {
    resolveMediaUrl: (mediaName) => {
        const file = drive.findFileByName(mediaFolderId, mediaName);
        return file ? `/drive/${ownerId}/${mountId}/file/${file.id}/embed/${file.name}` : null;
    },
});
```

This matches the client-side `MediaResolverProvider` pattern but without React context.

### Code Highlight in Previews

Code blocks need syntax highlighting. The backend already has `lowlight` (used for text previews). The serializer can
optionally highlight code blocks using `lowlight.highlight()` + `hast-util-to-html`.

## Use Case 1: Quick Preview

### API Endpoint

```
GET /collab/:ownerId/:mountId/:pathId/preview
```

Returns sanitized HTML suitable for the preview pane. Wraps output in the `eigen-prose` class for consistent styling.

### Loading Without Active Collab Session

For previews, we don't need a full `CollabDocument` with WebSocket subscriptions. We just need to load the Yjs state
from the eigendoc's SQLite database:

```typescript
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';

function loadYjsDocFromDb(db: Database): Y.Doc {
    const doc = new Y.Doc();
    const snapshot = db.query('SELECT stateData FROM docSnapshots ORDER BY id DESC LIMIT 1').get();
    if (snapshot) Y.applyUpdate(doc, snapshot.stateData);
    const updates = db.query(
        'SELECT updateData FROM docUpdates WHERE id > ? ORDER BY id',
        [snapshot?.id || 0],
    ).all();
    for (const update of updates) Y.applyUpdate(doc, update.updateData);
    return doc;
}
```

Then extract ProseMirror JSON and serialize:

```typescript
const fragment = ydoc.getXmlFragment('default');
const pmJson = yXmlFragmentToProsemirrorJSON(fragment);
const html = serializeDoc(pmJson, { resolveMediaUrl });
return DOMPurify.sanitize(html);
```

## Use Case 2: DOCX Import

### Pipeline

```
DOCX file
  → mammoth (DOCX → clean HTML)
  → ProseMirror DOMParser (HTML → PM JSON)   // needs DOM — use happy-dom
  → prosemirrorJSONToYDoc (PM JSON → Y.Doc)  // y-prosemirror, pure JS
  → store as eigendoc
```

### Why Mammoth?

- Produces clean, semantic HTML (headings, lists, tables, images)
- Ignores decorative styling that doesn't map to our schema
- Supports custom style maps for enterprise DOCX templates
- Lightweight, no system dependencies (unlike LibreOffice)
- Works in Bun/Node

### Image Extraction

DOCX files embed images as binary blobs. During import, mammoth extracts images via its `convertImage` handler. Each
image is saved to the eigendoc's media folder, and the HTML `<img>` gets a `data-media-name` attribute that the Figure
extension's `parseHTML` picks up.

### HTML → ProseMirror JSON (requires minimal DOM)

ProseMirror's `DOMParser.fromSchema(schema).parse(domNode)` needs a DOM. For server-side, use `happy-dom` (lighter
than JSDOM, Bun-compatible). This is the **only** step that requires a DOM polyfill, and only for DOCX import — not for
preview rendering.

### PM JSON → Y.Doc

```typescript
import { prosemirrorJSONToYDoc } from 'y-prosemirror';

const ydoc = prosemirrorJSONToYDoc(schema, pmJson);
const update = Y.encodeStateAsUpdate(ydoc);
// Store in eigendoc's database
```

## Use Case 3: DOCX Export

### Option A: Via HTML (simpler)

Use the HTML serializer from Use Case 1, then convert to DOCX via `html-to-docx`.

### Option B: Direct (better fidelity)

`prosemirror-docx` serializes ProseMirror documents directly to DOCX, preserving more structure. Requires defining
serializers for each node/mark type.

## Other Collab Document Types

Each document type stores content differently in Yjs:

| Type | Yjs structure | Rendering approach |
|------|---------------|-------------------|
| eigendoc | `Y.XmlFragment` (ProseMirror) | PM JSON → HTML serializer (this proposal) |
| eigenslides | `Y.Map` with slides/objects/order | Custom: iterate slides, render positioned elements |
| eigenstickies | `Y.Map` with cards/columns | Custom: iterate columns/cards, render kanban HTML |
| eigensheets | `Y.Map` with cell data | Custom: iterate cells, render HTML table |

### Shared Pattern

```
packages/lib/src/core/docs/
├── yjs-loader.ts          # Shared: load Y.Doc from SQLite database
├── eigendoc.ts            # PM JSON extraction + HTML serializer
├── eigenslides.ts         # DeckData extraction + HTML serializer
├── eigenstickies.ts       # Board extraction + HTML serializer
└── eigensheets.ts         # Cell data extraction + HTML table serializer
```

## Dependencies

### Already Available

| Package | Used in | Purpose |
|---------|---------|---------|
| `yjs` | API server | Yjs document handling |
| `y-prosemirror` | docs frontend | Yjs ↔ ProseMirror JSON conversion |
| `lowlight` | API + docs frontend | Code syntax highlighting |
| `markdown-it` | API server | Markdown rendering |
| `isomorphic-dompurify` | API server | HTML sanitization |

### New Dependencies Needed

| Package | Purpose | Size | When |
|---------|---------|------|------|
| `mammoth` | DOCX → HTML import | ~200KB | Phase 2 |
| `happy-dom` | Minimal DOM for DOCX import only | ~1MB | Phase 2 |
| `prosemirror-model` | Schema + Node types for DOCX import | ~100KB | Phase 2 |
| `prosemirror-docx` | PM → DOCX export (optional) | ~50KB | Phase 3 |

**Note:** `y-prosemirror` needs to be added to the API server's dependencies (currently only in docs frontend). The
HTML serializer itself (Phase 1) needs **zero** new dependencies.

## Implementation Order

### Phase 1: Quick Preview (eigendoc only)

1. Create `packages/lib/src/core/docs/html-serializer.ts` — pure JS, no DOM
2. Add `y-prosemirror` to API server dependencies
3. Create lightweight Yjs doc loader (reuse existing `CollabDocument` DB schema)
4. Add `GET /collab/:ownerId/:mountId/:pathId/preview` endpoint
5. Wire into Drive's preview system

### Phase 2: DOCX Import

1. Add `mammoth` + `happy-dom` + `prosemirror-model` to API server
2. Create shared ProseMirror schema definition (for DOMParser)
3. Create DOCX → eigendoc conversion pipeline
4. Handle image extraction → media folder
5. Add `POST /drive/:ownerId/:mountId/import-docx` endpoint

### Phase 3: DOCX Export

1. Evaluate `prosemirror-docx` vs `html-to-docx`
2. Create PM JSON → DOCX pipeline
3. Add `GET /collab/:ownerId/:mountId/:pathId/export/docx` endpoint

### Phase 4: Other Document Types

1. Eigenslides HTML serializer
2. Eigenstickies HTML serializer
3. Eigensheets HTML table serializer

## Edge Cases

- **Empty documents**: Return minimal HTML or empty string
- **Missing media**: `resolveMediaUrl` returns null → render placeholder or skip image
- **Corrupt Yjs state**: Wrap `Y.applyUpdate()` in try/catch, return error state
- **Large documents**: Stream HTML generation for documents with many nodes
- **Concurrent edits during preview**: Load a snapshot, not the live doc — previews are eventually consistent
- **Code blocks without language**: Fall back to plain text (no highlighting)
- **Nested tables**: The serializer handles recursive node traversal naturally
- **Custom marks (comments)**: Skip comment marks in preview (they reference chat threads)
- **Text alignment**: Map `textAlign` attribute to `style="text-align: ..."` on the tag
- **Font/color styles**: Preserve inline styles from `textStyle` mark via the style attribute
- **Task lists**: Render checkboxes as Unicode characters or disabled input elements
- **DOCX round-trip fidelity**: Import is lossy by design — complex DOCX formatting is simplified to match our schema
