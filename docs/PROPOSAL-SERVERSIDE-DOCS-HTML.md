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

## Directory Structure

Shared schema, types, and rendering code lives in `packages/lib/src/docs/`. This code has **no React dependency**, no
I/O, and works in both browser and server (Bun) contexts. Backend-only code (Yjs loading from SQLite, API endpoints)
stays in `apps/api/`.

```
packages/lib/src/docs/                    # Schema, types, rendering (NO React, NO I/O)
├── eigendoc/
│   ├── extensions.ts               # getDocExtensions() — shared tiptap extension list
│   ├── nodes/
│   │   ├── figure.ts               # Figure node (schema: attrs, parseHTML, renderHTML, commands)
│   │   ├── comment-mark.ts         # Comment mark (schema only, no click handler)
│   │   └── small-mark.ts           # Small mark
│   └── index.ts                    # Re-exports
│
├── eigenslides/
│   ├── types.ts                    # DeckData, SlideItem, SlideObject types
│   ├── extract.ts                  # extractDeckData(ydoc) → DeckData
│   ├── render.ts                   # renderSlidesToHTML(data, options) → string
│   └── index.ts
│
├── eigenstickies/
│   ├── types.ts                    # Board, Column, Card types
│   ├── extract.ts                  # extractBoard(ydoc) → Board
│   ├── render.ts                   # renderBoardToHTML(data, options) → string
│   └── index.ts
│
└── eigensheets/
    ├── types.ts                    # Sheet, Cell types
    ├── extract.ts                  # extractSheet(ydoc) → Sheet
    ├── render.ts                   # renderSheetToHTML(data, options) → string
    └── index.ts
```

### What Stays in the Apps

Editor-only code (React components, UI interactions, WebSocket handling) stays in the app:

```
apps/docs/src/components/docs/
├── extensions/
│   ├── figure-view.tsx             # React NodeView (resize handles, image loading, drag)
│   ├── figure.ts                   # Extends shared FigureNode + adds ReactNodeViewRenderer
│   ├── comment-mark.ts             # Extends shared CommentMark + adds click handler plugin
│   └── table-width-clamp.ts        # Editor-only: clamps table column widths to page
├── editor.tsx                      # Imports getDocExtensions() + adds editor-only extensions
├── editor-toolbar.tsx
├── figure-properties-panel.tsx
└── table-properties-panel.tsx
```

### The Split Principle

| Shared (`packages/lib/src/docs/`) | Frontend (`apps/docs/`) | Backend (`apps/api/`) |
|---|---|---|
| Node/mark **schema** (attrs, parseHTML, renderHTML) | React NodeViews (FigureView) | Yjs doc loading from SQLite |
| Extension list (`getDocExtensions()`) | Collaboration, CollaborationCaret | Preview/export endpoints |
| Types and data extraction functions | TableWidthClamp (editor UX) | DOCX import pipeline |
| | Editor UI (toolbar, panels) | Media URL resolution |

### How Extension Splitting Works

The Figure extension demonstrates the pattern. The **schema** is shared (attributes, parseHTML, renderHTML, commands).
The **React NodeView** is editor-only:

```typescript
// packages/lib/src/docs/eigendoc/nodes/figure.ts
// Pure schema — no React, no DOM, works on server
export const FigureNode = Node.create({
    name: 'figure',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes() { /* mediaName, src, alt, caption, width, alignment */ },
    parseHTML() { /* figure, img[data-media-name], img[src] */ },
    renderHTML() { /* figure > img + figcaption */ },
    addCommands() { /* setFigure */ },
});
```

```typescript
// apps/docs/src/components/docs/extensions/figure.ts
// Editor extension — extends shared schema with React NodeView
import { FigureNode } from '@workspace/lib/docs/eigendoc';

export const Figure = FigureNode.extend({
    addNodeView() {
        return ReactNodeViewRenderer(FigureView);
    },
});
```

The server renderer uses `FigureNode` directly (gets correct HTML from `renderHTML`). The editor uses `Figure` which
adds the interactive resize/drag UI on top. New attributes or parseHTML rules are added once in the shared definition.

### Pattern for Non-ProseMirror Types

Slides, stickies, and sheets don't use tiptap — they store custom JSON in Yjs `Y.Map` structures. Each module follows
the same pattern: **types** → **extract** → **render**.

```typescript
// packages/lib/src/docs/eigenslides/extract.ts
export function extractDeckData(ydoc: Y.Doc): DeckData {
    const slides = ydoc.getMap('slides');
    const objects = ydoc.getMap('objects');
    const slideOrder = ydoc.getArray('slideOrder');
    return { slides: slides.toJSON(), objects: objects.toJSON(), slideOrder: slideOrder.toArray() };
}

// packages/lib/src/docs/eigenslides/render.ts
export function renderSlidesToHTML(data: DeckData, options?: RenderOptions): string {
    return data.slideOrder.map(id => renderSlide(data.slides[id], data.objects, options)).join('');
}
```

## Yjs Loader (Backend)

All eigen file types store Yjs state in the same SQLite schema (`docUpdates` + `docSnapshots` tables). The loader lives
in the API server next to the existing `CollabDocument`:

```
apps/api/src/lib/collab/
├── collabDocument.ts               # Existing: full collab session (WebSocket, subscriptions)
├── yjs-loader.ts                   # New: lightweight read-only Yjs state loading
└── schema.ts                       # Existing: DB schema
```

```typescript
// apps/api/src/lib/collab/yjs-loader.ts
import * as Y from 'yjs';

export function loadYjsState(db: Database): Y.Doc {
    const doc = new Y.Doc();
    const snapshot = db.query('SELECT stateData FROM docSnapshots ORDER BY id DESC LIMIT 1').get();
    if (snapshot) Y.applyUpdate(doc, snapshot.stateData as Uint8Array);
    const updates = db.query(
        'SELECT updateData FROM docUpdates WHERE id > ? ORDER BY id',
        [snapshot?.id || 0],
    ).all();
    for (const update of updates) Y.applyUpdate(doc, update.updateData as Uint8Array);
    return doc;
}
```

This is a lightweight alternative to `CollabDocument` — no WebSocket subscriptions, no undo manager, no update tracking.
Just load the state and return.

## Use Case 1: Quick Preview (all eigen doc types)

### Integration with Existing Preview System

No new routes needed. The existing `text-preview` system already handles cached HTML previews for text/markdown/code
files via `GET /drive/:ownerId/:mountId/file/:pathId/text-preview`. Eigen document types plug into the same pipeline:

```
drive.getTextPreview(mountId, pathId)
  → getTextPreviewData(mount, drivePath)
      ├── text/markdown/code  → existing generateTextPreview()
      ├── application/eigendoc      → generateEigendocPreview()
      ├── application/eigenslides   → generateEigenslidesPreview()
      ├── application/eigenstickies → generateEigenstickiesPreview()
      └── application/eigensheets   → generateEigensheetsPreview()
```

The result is cached as JSON (`{ body: string, mode: string }`) in the mount's preview directory, keyed by
`pathId + updatedAt`. Stale previews auto-invalidate when the document is edited.

### Preview Location

```
apps/api/src/lib/preview/
├── text-preview.ts                 # Existing: markdown, code, plaintext
├── eigendoc-preview.ts             # New: eigendoc → HTML via static-renderer
├── eigenslides-preview.ts          # New: slides → HTML
├── eigenstickies-preview.ts        # New: stickies → HTML
├── eigensheets-preview.ts          # New: sheets → HTML table
└── preview-cache.ts                # Existing: cache layer (add eigen type support)
```

### Eigendoc Preview

```typescript
// apps/api/src/lib/preview/eigendoc-preview.ts
import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import DOMPurify from 'isomorphic-dompurify';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { loadYjsState } from '../collab/yjs-loader';

export async function generateEigendocPreview(
    mount: Mount, pathId: string, resolveMediaUrl: (name: string) => string | null,
): Promise<string> {
    const db = await mount.openDatabase(pathId);
    const ydoc = loadYjsState(db);
    const pmJson = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment('default'));

    const html = renderToHTMLString({
        content: pmJson,
        extensions: getDocExtensions({ lowlight }),
        options: {
            nodeMapping: {
                figure: ({ node }) => {
                    const url = resolveMediaUrl(node.attrs.mediaName);
                    const img = url ? `<img src="${escapeAttr(url)}" />` : '';
                    const cap = node.attrs.caption
                        ? `<figcaption>${escapeHtml(node.attrs.caption)}</figcaption>` : '';
                    return `<figure>${img}${cap}</figure>`;
                },
            },
        },
    });

    return DOMPurify.sanitize(html);
}
```

The frontend already calls `useTextPreview(ownerId, mountId, pathId)` which hits
`GET /drive/:ownerId/:mountId/file/:pathId/text-preview`. The only change needed on the frontend: add
`application/eigendoc` (and other eigen MIME types) to `getTextPreviewMode()` in
`packages/lib/src/constants/` so the preview pane knows to request and render HTML for these types.

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
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';

const schema = getSchema(getDocExtensions());
```

### PM JSON → Y.Doc

```typescript
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';

const ydoc = prosemirrorJSONToYDoc(schema, pmJson);
const update = Y.encodeStateAsUpdate(ydoc);
```

## Use Case 3: DOCX Export

### Option A: Via HTML (simpler)

Use `renderToHTMLString` from Use Case 1, then convert to DOCX via `html-to-docx`.

### Option B: Direct (better fidelity)

`prosemirror-docx` serializes ProseMirror documents directly to DOCX, preserving more structure.

## Dependencies

### Already Available

| Package | Purpose |
|---------|---------|
| `yjs` | Yjs document handling (API server) |
| `@tiptap/y-tiptap` | Yjs <-> ProseMirror JSON (docs frontend, add to API) |
| `@tiptap/core` + extensions | Schema + rendering (docs frontend, add to API) |
| `lowlight` | Code syntax highlighting (API + frontend) |
| `isomorphic-dompurify` | HTML sanitization (API server) |

### New Dependencies

| Package | Purpose | When |
|---------|---------|------|
| `@tiptap/static-renderer` | Server-side HTML rendering (no DOM) | Phase 1 |
| `mammoth` | DOCX -> HTML import | Phase 2 |
| `happy-dom` | Minimal DOM for DOCX import DOMParser | Phase 2 |
| `prosemirror-docx` | PM -> DOCX export (optional) | Phase 3 |

## Implementation Order

### Phase 1: Quick Preview

1. Create `packages/lib/src/docs/eigendoc/` — shared extension list + node/mark schemas
2. Move Figure/CommentMark/SmallMark schemas to shared, keep React views in app
3. Create `getDocExtensions()` in shared, update docs editor to import from it
4. Create `apps/api/src/lib/collab/yjs-loader.ts` — lightweight read-only Yjs state loading
5. Add `@tiptap/static-renderer` + shared tiptap deps to API server
6. Create `apps/api/src/lib/preview/eigendoc-preview.ts`
7. Extend `getTextPreviewData()` in `preview-cache.ts` to handle eigen MIME types
8. Add eigen MIME types to `getTextPreviewMode()` in `packages/lib/src/constants/`

### Phase 2: DOCX Import

1. Add `mammoth` + `happy-dom` to API server
2. Create DOCX -> eigendoc conversion pipeline (uses shared schema via `getSchema(getDocExtensions())`)
3. Handle image extraction -> media folder
4. Add `POST /drive/:ownerId/:mountId/import-docx` endpoint

### Phase 3: DOCX Export

1. Evaluate `prosemirror-docx` vs `html-to-docx`
2. Add export endpoint

### Phase 4: Other Document Types

1. Create `eigenslides/` types + extract + render
2. Create `eigenstickies/` types + extract + render
3. Create `eigensheets/` types + extract + render

## Edge Cases

- **Empty documents**: Return minimal HTML or empty string
- **Missing media**: `resolveMediaUrl` returns null -> render placeholder or skip image
- **Corrupt Yjs state**: Wrap `Y.applyUpdate()` in try/catch, return error state
- **Concurrent edits during preview**: Load a snapshot — previews are eventually consistent
- **Code blocks without language**: Fall back to plain text (no highlighting)
- **Custom marks (comments)**: Skip in preview (they reference chat threads)
- **DOCX round-trip fidelity**: Import is lossy by design — complex formatting simplified to match our schema
- **New custom nodes**: Added once in the shared extension list, automatically available in both editor and server
