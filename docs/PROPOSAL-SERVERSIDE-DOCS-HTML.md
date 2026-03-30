# Proposal: Server-Side Document Rendering & DOCX Import

## Problem

Eigen's document system (eigendoc, eigenstickies, eigenslides, eigensheets) stores content as binary Yjs updates in
SQLite. There's no server-side way to:

1. Generate HTML previews (for quick-preview in Drive, search indexing, notifications)
2. Export documents to PDF or other formats
3. Import DOCX files by converting them to eigendoc format

## Key Enabler: Tiptap 3

The docs app has been upgraded to tiptap 3, which includes `@tiptap/static-renderer` — a server-side HTML renderer that
uses the **same extension definitions** as the editor. No DOM required, no duplicate rendering logic.

```
Yjs binary → Y.Doc → PM JSON → renderToHTMLString(json, extensions) → HTML
                                 ↑ same extensions as the editor
```

## Architecture

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
              yXmlFragmentToProsemirrorJSON()    ← @tiptap/y-tiptap (pure JS)
                             │
                  ┌──────────▼───────────────────┐
                  │     ProseMirror JSON          │
                  └──────┬──────────────┬────────┘
                         │              │
        renderToHTMLString()            │
        with shared extensions          │
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
              prosemirrorJSONToYDoc()     ← @tiptap/y-tiptap
                         │
                  ┌──────▼───────────────────────┐
                  │     Y.Doc → binary updates     │
                  └────────────────────────────────┘
```

## Shared Extensions

The critical insight: tiptap 3's `renderToHTMLString` accepts the same extension array as the editor. To avoid
duplication, extract the extension list into a shared module:

```
packages/lib/src/core/docs/
├── extensions.ts          # Shared tiptap extension list (no React, no DOM)
└── yjs-loader.ts          # Load Y.Doc from SQLite (shared by all eigen file types)
```

**extensions.ts** exports the extension list used by both the editor and the server renderer:

```typescript
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Highlight from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { Color, FontFamily, TextStyle } from '@tiptap/extension-text-style';
import Typography from '@tiptap/extension-typography';
import StarterKit from '@tiptap/starter-kit';

export function getDocExtensions(options?: { lowlight?: unknown }) {
    return [
        StarterKit.configure({
            undoRedo: false,
            codeBlock: false,
            link: {
                HTMLAttributes: {
                    target: '_blank',
                    rel: 'noopener noreferrer',
                },
            },
        }),
        Subscript,
        Superscript,
        Typography,
        TextStyle,
        Color,
        FontFamily,
        TaskList,
        TaskItem.configure({ nested: true }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Highlight.configure({ multicolor: true }),
        ...(options?.lowlight
            ? [CodeBlockLowlight.configure({ lowlight: options.lowlight })]
            : []),
        Table,
        TableRow,
        TableCell,
        TableHeader,
    ];
}
```

The editor adds editor-specific extensions on top (Collaboration, CollaborationCaret, Figure, CommentMark, SmallMark,
TableWidthClamp). The server renderer uses the base list + custom `nodeMapping` overrides for Figure.

## Use Case 1: Quick Preview

### Server-Side Rendering

```typescript
import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { getDocExtensions } from '@workspace/lib/docs/extensions';

async function renderDocPreview(
    drive: Drive, mountId: string, pathId: string
): Promise<string> {
    // Load Yjs state from eigendoc's SQLite
    const ydoc = await loadYjsDoc(drive, mountId, pathId);
    const fragment = ydoc.getXmlFragment('default');
    const pmJson = yXmlFragmentToProsemirrorJSON(fragment);

    // Resolve media folder for figure images
    const mediaFolder = await drive.findMediaFolder(mountId, pathId);

    const html = renderToHTMLString({
        content: pmJson,
        extensions: getDocExtensions({ lowlight }),
        options: {
            nodeMapping: {
                // Custom rendering for figure nodes (media URL resolution)
                figure: ({ node }) => {
                    const url = resolveMediaUrl(mediaFolder, node.attrs.mediaName);
                    const img = url ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(node.attrs.alt || '')}" />` : '';
                    const caption = node.attrs.caption
                        ? `<figcaption>${escapeHtml(node.attrs.caption)}</figcaption>` : '';
                    return `<figure>${img}${caption}</figure>`;
                },
            },
        },
    });

    return DOMPurify.sanitize(html);
}
```

### API Endpoint

```
GET /collab/:ownerId/:mountId/:pathId/preview
```

Returns sanitized HTML wrapped in `eigen-prose` class for consistent styling.

### Loading Without Active Collab Session

For previews, we don't need a full `CollabDocument` with WebSocket subscriptions. A lightweight loader reads the Yjs
state directly from the eigendoc's SQLite database:

```typescript
function loadYjsDoc(db: Database): Y.Doc {
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

## Use Case 2: DOCX Import

### Pipeline

```
DOCX file → mammoth (DOCX → HTML) → ProseMirror DOMParser → PM JSON → Y.Doc → eigendoc
```

### Why Mammoth?

- Produces clean, semantic HTML (headings, lists, tables, images)
- Ignores decorative styling that doesn't map to our schema
- Lightweight, no system dependencies (unlike LibreOffice)
- Works in Bun/Node

### Image Extraction

DOCX files embed images as binary blobs. During import, mammoth extracts images via its `convertImage` handler. Each
image is saved to the eigendoc's media folder, and the HTML `<img>` gets a `data-media-name` attribute that the Figure
extension's `parseHTML` picks up.

### HTML → ProseMirror JSON

ProseMirror's `DOMParser.fromSchema(schema).parse(domNode)` needs a DOM. For server-side, use `happy-dom` (Bun-
compatible). This is the **only** step that requires a DOM polyfill, and only for DOCX import.

The schema is built from the shared extensions:

```typescript
import { getSchema } from '@tiptap/core';
import { getDocExtensions } from '@workspace/lib/docs/extensions';

const schema = getSchema(getDocExtensions());
```

### PM JSON → Y.Doc

```typescript
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';

const ydoc = prosemirrorJSONToYDoc(schema, pmJson);
const update = Y.encodeStateAsUpdate(ydoc);
// Store in eigendoc's database
```

## Use Case 3: DOCX Export

### Option A: Via HTML (simpler)

Use `renderToHTMLString` from Use Case 1, then convert to DOCX via `html-to-docx`.

### Option B: Direct (better fidelity)

`prosemirror-docx` serializes ProseMirror documents directly to DOCX, preserving more structure.

## Other Collab Document Types

Each type stores content differently in Yjs:

| Type | Yjs structure | Rendering approach |
|------|---------------|-------------------|
| eigendoc | `Y.XmlFragment` (ProseMirror) | `renderToHTMLString` with shared extensions |
| eigenslides | `Y.Map` with slides/objects/order | Custom: iterate slides, render positioned elements |
| eigenstickies | `Y.Map` with cards/columns | Custom: iterate columns/cards, render kanban HTML |
| eigensheets | `Y.Map` with cell data | Custom: iterate cells, render HTML table |

The Yjs loader (`loadYjsDoc`) is shared across all types. Only the extraction and rendering steps are type-specific.

## Dependencies

### Already Available

| Package | Purpose |
|---------|---------|
| `yjs` | Yjs document handling (API server) |
| `@tiptap/y-tiptap` | Yjs ↔ ProseMirror JSON (docs frontend, add to API) |
| `@tiptap/core` + extensions | Schema + rendering (docs frontend, add to API) |
| `lowlight` | Code syntax highlighting (API + frontend) |
| `isomorphic-dompurify` | HTML sanitization (API server) |

### New Dependencies

| Package | Purpose | When |
|---------|---------|------|
| `@tiptap/static-renderer` | Server-side HTML rendering (no DOM) | Phase 1 |
| `mammoth` | DOCX → HTML import | Phase 2 |
| `happy-dom` | Minimal DOM for DOCX import DOMParser | Phase 2 |
| `prosemirror-docx` | PM → DOCX export (optional) | Phase 3 |

## Implementation Order

### Phase 1: Quick Preview

1. Extract shared extension list to `packages/lib/src/core/docs/extensions.ts`
2. Add `@tiptap/static-renderer` + `@tiptap/y-tiptap` to API server
3. Create Yjs doc loader utility
4. Add `GET /collab/:ownerId/:mountId/:pathId/preview` endpoint
5. Wire into Drive's preview system
6. Update docs editor to import from shared extensions

### Phase 2: DOCX Import

1. Add `mammoth` + `happy-dom` to API server
2. Create DOCX → eigendoc conversion pipeline (uses shared schema via `getSchema(getDocExtensions())`)
3. Handle image extraction → media folder
4. Add `POST /drive/:ownerId/:mountId/import-docx` endpoint

### Phase 3: DOCX Export

1. Evaluate `prosemirror-docx` vs `html-to-docx`
2. Add export endpoint

### Phase 4: Other Document Types

1. Eigenslides, eigenstickies, eigensheets HTML serializers (custom per type)

## Edge Cases

- **Empty documents**: Return minimal HTML or empty string
- **Missing media**: `resolveMediaUrl` returns null → render placeholder or skip image
- **Corrupt Yjs state**: Wrap `Y.applyUpdate()` in try/catch, return error state
- **Concurrent edits during preview**: Load a snapshot — previews are eventually consistent
- **Code blocks without language**: Fall back to plain text (no highlighting)
- **Custom marks (comments)**: Skip in preview (they reference chat threads)
- **DOCX round-trip fidelity**: Import is lossy by design — complex formatting simplified to match our schema
- **New custom nodes**: Added once in the shared extension list, automatically available in both editor and server
