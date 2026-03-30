# Proposal: Server-Side Document Rendering, DOCX Export & Import

## Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Quick Preview | Done | `eigendoc-preview.ts`, shared extensions, yjs-loader |
| Phase 2: DOCX Export | Planned | `prosemirror-docx` — direct PM JSON to DOCX |
| Phase 3: DOCX Import | Planned | `mammoth.js` — DOCX to HTML to PM JSON |
| Phase 4: Other doc types | Future | Slides, stickies, sheets previews |

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
              yXmlFragmentToProsemirrorJSON()    ← @tiptap/y-tiptap
                             │
                  ┌──────────▼───────────────────┐
                  │     ProseMirror JSON          │
                  └──────┬──────────────┬────────┘
                         │              │
        renderToHTMLString()    DocxSerializer()
        with shared extensions  with custom node serializers
                         │              │
                  ┌──────▼──────┐  ┌───▼────────────┐
                  │    HTML     │  │     .docx       │
                  │  (preview)  │  │   (download)    │
                  └─────────────┘  └────────────────┘

                  ┌─────────────┐
                  │  DOCX file  │
                  └──────┬──────┘
                         │
               mammoth (DOCX → HTML)
                         │
           ProseMirror DOMParser + schema
                         │
              prosemirrorJSONToYDoc()     ← @tiptap/y-tiptap
                         │
                  ┌──────▼───────────────────────┐
                  │     Y.Doc → binary updates     │
                  └────────────────────────────────┘
```

## Phase 1: Quick Preview (Done)

Eigendoc HTML preview is implemented and deployed. Key files:

| File | Purpose |
|------|---------|
| `packages/lib/src/docs/eigendoc/extensions.ts` | `getDocExtensions()` — shared tiptap extension list |
| `packages/lib/src/docs/eigendoc/nodes/figure.ts` | Figure node schema (attrs, parseHTML, renderHTML) |
| `packages/lib/src/docs/eigendoc/nodes/comment-mark.ts` | Comment mark schema |
| `packages/lib/src/docs/eigendoc/nodes/small-mark.ts` | Small mark schema |
| `apps/api/src/lib/collab/yjs-loader.ts` | Lightweight read-only Yjs state loading |
| `apps/api/src/lib/preview/eigendoc-preview.ts` | Yjs → PM JSON → HTML via `@tiptap/static-renderer` |
| `apps/api/src/lib/preview/preview-cache.ts` | Dynamic import of eigendoc-preview (see Build section) |

### Build Constraint

`eigendoc-preview.ts` imports tiptap/ProseMirror packages that reference DOM globals at the module level. With
`bun build`, these crash the server at startup. The solution: `--splitting` in the build command, combined with a
dynamic `await import('./eigendoc-preview')` in `preview-cache.ts`. This produces a separate chunk that only loads when
a preview is actually requested. See the `buildfordocker` script in `apps/api/package.json`.

### Extension Split Pattern

Schema (shared) vs React NodeView (editor-only):

```typescript
// packages/lib — pure schema, no React, works on server
export const FigureNode = Node.create({
    name: 'figure',
    addAttributes() { /* mediaName, src, alt, caption, width, alignment */ },
    parseHTML() { /* figure, img[data-media-name], img[src] */ },
    renderHTML() { /* figure > img + figcaption */ },
});

// apps/docs — extends shared schema with interactive React UI
export const Figure = FigureNode.extend({
    addNodeView() { return ReactNodeViewRenderer(FigureView); },
});
```

| Shared (`packages/lib/src/docs/`) | Frontend (`apps/docs/`) | Backend (`apps/api/`) |
|---|---|---|
| Node/mark schema (attrs, parseHTML, renderHTML) | React NodeViews | Yjs loading from SQLite |
| Extension list (`getDocExtensions()`) | Collaboration, CollaborationCaret | Preview endpoints |
| | TableWidthClamp, editor UI | DOCX import/export |

## Phase 2: DOCX Export

### Approach: `prosemirror-docx` (PM JSON → DOCX directly)

We use `prosemirror-docx` (curvenote) rather than HTML-to-DOCX because:

1. **We already have the PM JSON** — the Yjs loader extracts it. Going PM JSON → DOCX is more direct than PM JSON →
   HTML → DOCX, which loses structural information (custom attributes, alignment semantics)
2. **Custom nodes need explicit handling either way** — with prosemirror-docx we write serializers that read node
   attributes directly (`mediaName`, `width`, `alignment`, `caption`). With HTML-to-DOCX we'd depend on how a
   third-party library interprets our custom HTML
3. **Fewer dependencies** — prosemirror-docx depends on `docx` + `prosemirror-model` + `image-dimensions`. The
   HTML-to-DOCX alternatives drag in axios, lodash, htmlparser2, jszip, etc.
4. **Same serializer pattern extends** to other eigen types if needed

### Library: `prosemirror-docx`

| Attribute | Details |
|-----------|---------|
| Package | `prosemirror-docx` (curvenote) |
| Version | 0.6.1 |
| Stars | 159 |
| Depends on | `docx` (9.6.1, 5.6k stars), `prosemirror-model`, `image-dimensions` |
| Input | ProseMirror Node (from `Node.fromJSON(schema, json)`) |
| Server-safe | Yes — pure JS, no DOM |

The serializer pattern is clean — provide a `Record<nodeName, serializerFn>` with defaults for standard nodes:

```typescript
import { DocxSerializer, defaultNodes, defaultMarks } from 'prosemirror-docx';

const serializer = new DocxSerializer(
    { ...defaultNodes, figure: figureToDOCX, taskList: taskListToDOCX },
    { ...defaultMarks, highlight: highlightToDOCX },
);
```

### Custom Serializers Needed

These eigen-specific nodes/marks need custom DOCX serializers:

| Node/Mark | DOCX Mapping | Complexity |
|-----------|-------------|------------|
| `figure` | Image (embedded buffer) + optional caption paragraph, with alignment and width | Medium — needs `getImageBuffer` callback to resolve `mediaName` from mount |
| `taskList` / `taskItem` | Bullet list with checkbox Unicode characters (☐/☑) | Low |
| `codeBlock` | Monospace paragraph with gray background shading | Low (no syntax highlighting in DOCX) |
| `highlight` mark | Run-level background color | Low |
| `small` mark | Smaller font size run | Low |
| `comment` mark | Skip (internal-only, references chat threads) | Trivial |
| `textAlign` attribute | Paragraph alignment property | Low |
| `color` / `fontFamily` (TextStyle) | Run-level formatting | Low |

### Image Handling

DOCX embeds images as binary blobs. The export pipeline resolves `mediaName` to file buffers via `mount.readFile()`:

```typescript
async function getImageBuffer(mediaName: string): Promise<Buffer | null> {
    const mediaFolder = await mount.getChildByName(docPathId, 'media');
    if (!mediaFolder) return null;
    const file = await mount.getChildByName(mediaFolder.id, mediaName);
    if (!file) return null;
    const blob = await mount.readFile(file.id);
    return blob ? Buffer.from(await blob.arrayBuffer()) : null;
}
```

### API Endpoint

```
GET /drive/:ownerId/:mountId/file/:pathId/export/docx
```

Returns a `.docx` file as a download. Pipeline:

1. Load Yjs state → PM JSON (existing: `yjs-loader.ts`)
2. Build ProseMirror Node from JSON (using shared schema from `getDocExtensions()`)
3. Resolve media files → Buffer map
4. Serialize PM Node → DOCX via `DocxSerializer` with custom serializers
5. Return `.docx` with `Content-Disposition: attachment`

### File Location

```
apps/api/src/lib/export/
├── docx-export.ts          # Main export function
└── docx-serializers.ts     # Custom node/mark serializers for eigen types
```

Same build constraint as preview: these files import tiptap/prosemirror packages. Either use `--splitting` (already
enabled) with dynamic import, or add as another build entry point.

### Dependencies to Add

| Package | Purpose |
|---------|---------|
| `prosemirror-docx` | PM document → DOCX serialization |
| `docx` | DOCX file generation (peer dep of prosemirror-docx) |

## Phase 3: DOCX Import

### Approach: `mammoth.js` (DOCX → HTML → PM JSON → Y.Doc)

mammoth.js (6.2k stars, actively maintained) converts DOCX to clean semantic HTML. ProseMirror's `DOMParser` converts
that HTML to PM JSON using our shared schema. Then `prosemirrorJSONToYDoc()` creates the Yjs document.

### Pipeline

```
DOCX upload
  → mammoth.convertToHtml(buffer, { convertImage })
    → extracts images via convertImage callback → save to media/ folder
    → produces HTML with <img data-media-name="..."> references
  → DOMPurify.sanitize(html)
  → happy-dom DOMParser → DOM tree
  → ProseMirror DOMParser.fromSchema(schema).parse(dom)
    → schema built from getDocExtensions()
    → FigureNode.parseHTML picks up data-media-name attributes
  → PM JSON
  → prosemirrorJSONToYDoc(schema, json)
  → Y.encodeStateAsUpdate(ydoc)
  → write to eigendoc data.db
```

### Image Extraction

mammoth's `convertImage` callback receives image data as a buffer. During import, each image is saved to the
eigendoc's `media/` folder, and the HTML `<img>` gets a `data-media-name` attribute that `FigureNode.parseHTML`
already understands.

### DOM Requirement

`ProseMirror DOMParser.fromSchema(schema).parse(dom)` needs a DOM. Use `happy-dom` (lightweight, Bun-compatible).
This is the **only** step that needs a DOM, and only for import.

### API Endpoint

```
POST /drive/:ownerId/:mountId/folder/:pathId/import-docx
Content-Type: multipart/form-data

Body: .docx file
Returns: created DrivePath (the new eigendoc)
```

1. Create eigendoc folder structure (data.db + media/)
2. Run mammoth → extract images to media/ → get HTML
3. Sanitize HTML, parse to DOM, convert to PM JSON
4. Convert PM JSON → Y.Doc → write to data.db
5. Return the new DrivePath

### Dependencies to Add

| Package | Purpose |
|---------|---------|
| `mammoth` | DOCX → HTML conversion |
| `happy-dom` | Minimal DOM for ProseMirror DOMParser (server-side) |

## Phase 4: Other Document Types (Future)

Slides, stickies, and sheets don't use tiptap — they store custom JSON in Yjs `Y.Map` structures. Each would follow a
type → extract → render pattern:

```
packages/lib/src/docs/
├── eigenslides/    # extractDeckData(ydoc) → renderSlidesToHTML(data)
├── eigenstickies/  # extractBoard(ydoc) → renderBoardToHTML(data)
└── eigensheets/    # extractSheet(ydoc) → renderSheetToHTML(data)
```

DOCX export for these types is likely not needed (slides → PPTX and sheets → XLSX would be separate efforts).

## Edge Cases

- **Empty documents**: Return minimal HTML / empty DOCX
- **Missing media**: Skip image in export, render placeholder in preview
- **Corrupt Yjs state**: `loadYjsState()` handles corrupt snapshots/updates with try/catch
- **Concurrent edits during export**: Loads a snapshot — exports are eventually consistent
- **Code blocks**: No syntax highlighting in DOCX (monospace + gray background only)
- **Comment marks**: Stripped from both preview and export (internal-only)
- **DOCX round-trip fidelity**: Import is lossy by design — complex formatting simplified to match our schema
- **Large images**: `prosemirror-docx` scales images to fit page width; `mammoth` extracts at original resolution
