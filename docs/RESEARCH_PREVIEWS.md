# Research: Fast File Preview System (Quick Look for Eigen Drive)

> **Goal**: Build a file preview system for Eigen Drive that feels as fast and seamless as pressing Space in macOS Finder.
> Preview must appear instantly, support a wide range of file types (including Eigen's native formats), and integrate with
> the existing Drive UI without architectural disruption.

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [File Format Coverage Matrix](#file-format-coverage-matrix)
3. [Architecture Proposal: Preview Pipeline](#architecture-proposal-preview-pipeline)
4. [Speed Optimization Strategies](#speed-optimization-strategies)
5. [Eigen File Type Preview Approach](#eigen-file-type-preview-approach)
6. [External File Type Preview Approach](#external-file-type-preview-approach)
7. [Security Considerations](#security-considerations)
8. [Caching and Pre-generation Strategy](#caching-and-pre-generation-strategy)
9. [Bandwidth and Payload Sizing](#bandwidth-and-payload-sizing)
10. [Accessibility](#accessibility)
11. [UI/UX Design](#uiux-design)
12. [Cross-Cutting Concerns](#cross-cutting-concerns)
13. [Implementation Phases](#implementation-phases)

---

## Current State Analysis

### What Exists Today

**Preview provider** (`packages/ui/src/components/layout/preview-provider/preview-provider.tsx`):

- `PreviewProvider` context wraps apps via `EigenApp`
- `usePreview()` hook exposes `openPreview`, `updatePreview`, `closePreview`, `canPreview`
- `isPreviewable()` checks: `image/*`, `video/*`, `application/pdf` -- nothing else
- `buildPreviewState()` constructs a URL via `getDriveEmbedUrl()` and extracts aspect ratio from `path.details`
- `updatePreview()` swaps the previewed file when arrow-key navigation occurs in DriveTable

**FilePreview component** -- exists in two identical copies:
- `apps/drive/src/components/drive/file-preview.tsx`
- `packages/ui/src/components/layout/drive/file-preview.tsx`

Both render identically:
- Fullscreen overlay (fixed z-50 with black/80 backdrop, `animate-in fade-in` + `zoom-in-95`)
- Three render branches by MIME type:
  - `<img>` for `image/*` (direct embed URL via `getDriveEmbedUrl`)
  - `<video controls>` for `video/*`
  - `<iframe>` for `application/pdf` (browser native renderer)
- Escape key closes via `useHotkey` (from `@tanstack/react-hotkeys`)
- Click-on-backdrop closes (cursor: zoom-out); click-inside stops propagation
- No loading states, no progressive rendering, no error handling
- No keyboard navigation between files (left/right arrows)
- Note: the `aspectRatio` prop type differs between copies (`number` in drive app, `string` in packages/ui) -- needs consolidation

**DriveDetail sidebar** (`packages/ui/src/components/layout/drive/drive-detail.tsx`):

- Shows thumbnail (if exists via `getDriveThumbnailUrl`), video player (`video/mp4`, `video/mpeg` only), audio player (`audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/vorbis`, `audio/mp4`)
- Displays metadata: name, MIME, size, created date, dimensions, duration, page count
- Also renders arbitrary key-value pairs from `path.details` (filtering out known keys)
- Includes `DriveAccessList` for ACL display

**Thumbnail system** (`apps/api/src/lib/shared/thumbnails.ts`):

- Uses Sharp (`sharp@^0.34.0`)
- Generates 512px max WebP thumbnails on upload (quality 80, `inside` fit)
- `THUMBNAIL_SUPPORTED_MIMES` array lists JPEG, PNG, GIF, WebP, SVG, BMP, TIFF -- but `isThumbnailSupported()` actually checks `mimeType.startsWith('image/')`, so it accepts any image MIME type
- `generateThumbnail()` rejects images larger than 12000x12000 pixels (returns null)
- Extracts image dimensions (width/height) via Sharp metadata
- Stored in `mounts/{mountId}/thumbs/{pathId}.webp`
- `deleteThumbnail()` cleans up both .webp and .jpeg variants
- No thumbnails for: video, PDF, Office, code, eigen document types

**Upload pipeline** (`apps/api/src/lib/drive/drive.ts` line 229):

- On `uploadFile()`, runs `saveThumbnail()` and `extractImageDetails()` in parallel
- Stores results as `thumbnail` (filename string) and `details` (JSON with width/height/originalName)
- File size limit: 35MB single file, 10MB per file in batch upload

**Keyboard navigation** (`packages/ui/src/hooks/use-keyboard-list-navigation.ts`):

- ArrowUp/ArrowDown navigate the file list, trigger `onSelect` (which shows detail sidebar)
- Space/Enter both trigger `onSelect` (same action -- currently opens detail, not preview)
- Also handles: Cmd+A (select all), Escape (clear selection), Delete, Home/End, PageUp/PageDown
- Supports shift-click range selection via `UseListSelectionReturn`

### Gaps

| Gap | Impact |
|-----|--------|
| Only 3 MIME types previewable (image, video, PDF) | Most files require download to view |
| No preview for text/code/markdown/CSV/JSON | Common developer files are opaque |
| No preview for Office documents (docx/xlsx/pptx) | Major format gap |
| No preview for eigen native types (docs/slides/stickies/sheets) | Eigen's own formats lack quick look |
| No thumbnails for video/PDF/Office/eigen types | Detail sidebar shows icon only |
| No progressive loading (thumbnail -> full) | Large images/videos show blank then jump |
| No arrow-key navigation between files in preview | Must close, navigate, reopen |
| No loading/error states in preview | Broken images show nothing |
| Audio has no preview overlay (only inline in detail) | Inconsistent behavior |
| PDF uses iframe (no control over rendering) | No zoom, no page navigation, inconsistent cross-browser |
| Two divergent copies of FilePreview component | Maintenance burden, type mismatch on `aspectRatio` |
| Space and Enter do the same thing (both `onSelect`) | Space unavailable for preview toggle |

---

## File Format Coverage Matrix

### Tier 1: Native Browser (zero dependencies)

| Format | Current | Proposed Preview | Proposed Thumbnail | Notes |
|--------|---------|------------------|--------------------|-------|
| JPEG/PNG/WebP/GIF | Preview + thumb | Image viewer | Already done | Add progressive loading |
| SVG | Thumb only | Sandboxed render | Already done | Must sanitize (scripts, external refs) |
| BMP/TIFF | Thumb only | Image viewer | Already done | Browsers render BMP natively; TIFF needs conversion |
| MP4/WebM | Preview (video tag) | Video player + scrub | **FFmpeg first frame** | Need video thumbnail |
| MP3/WAV/OGG/FLAC | Inline audio only | Audio player + waveform | Waveform image | Web Audio API for visualization |
| Plain text (.txt) | None | Text viewer | First N lines as image | Trivial |

### Tier 2: Lightweight Libraries

| Format | Current | Proposed Preview | Proposed Thumbnail | Library |
|--------|---------|------------------|--------------------|---------|
| PDF | iframe | PDF.js viewer | **First page render** | `pdfjs-dist` |
| Markdown | None | Rendered HTML | First paragraph | `marked` or `markdown-it` |
| Code files | None | Syntax highlighted | First N lines | `lowlight` (already in docs app) |
| CSV | None | Table view | First rows as table | `papaparse` (proper quoting) |
| JSON | None | Syntax highlighted tree | Collapsed tree | Built-in + `lowlight` |
| XML/HTML | None | Syntax highlighted | First lines | `lowlight` |

### Tier 3: Eigen Native Types

| Format | Current | Proposed Preview | Proposed Thumbnail | Approach |
|--------|---------|------------------|--------------------|----------|
| `.eigendoc` | None | Read-only Tiptap | **Server-side HTML snapshot** | Yjs -> HTML on save |
| `.eigenslides` | None | First slide render | **First slide as image** | Reuse `ReadOnlySlideObject` + `SlideThumbnail` |
| `.eigenstickies` | None | Board mini-view | **Board snapshot** | Simplified column layout |
| `.eigensheets` | None | Grid preview | **Top-left cells** | Table render from Yjs `state` snapshot |
| `.eigenchat` | None | Recent messages | **Last message preview** | Query last N messages from SQLite |
| `.eigenvector` | N/A (future) | SVG render | **Rasterized SVG** | See [Cross-Cutting Concerns](#eigenvector-previews) |

### Tier 4: Heavy / External (future)

| Format | Current | Proposed Preview | Proposed Thumbnail | Approach |
|--------|---------|------------------|--------------------|----------|
| DOCX | None | Rendered HTML | First page | `mammoth` (DOCX->HTML) |
| XLSX | None | Table view | First sheet corner | `xlsx` / `SheetJS` |
| PPTX | None | Slide carousel | First slide | Custom XML parser or LibreOffice |
| Fonts (TTF/OTF/WOFF) | None | Character sample | Sample text render | CSS `@font-face` + canvas |
| 3D models (GLB/GLTF) | None | 3D viewer | Rendered frame | `@google/model-viewer` |
| Archives (ZIP/TAR) | None | File listing | File tree | `fflate` (browser) or server-side |

---

## Architecture Proposal: Preview Pipeline

### Design Principles

1. **Registry-based dispatch**: Each file type has a dedicated viewer. The framework dispatches by MIME type, with
   priority ordering for overlapping patterns (e.g., `text/markdown` before generic `text/*`).

2. **Two-phase rendering**: Show a cached thumbnail (instant), then load the full preview asynchronously. The user
   sees something immediately.

3. **Isolation for heavy rendering**: PDF pages, Office conversion, and Yjs extraction happen server-side or in a Web
   Worker -- never on the main thread.

4. **Pre-generation**: Generate thumbnails/preview data in the background on upload and on Yjs document save. The
   preview is ready before the user ever clicks.

5. **Aggressive caching**: Thumbnails and preview data cached on disk (existing `thumbs/` directory), in HTTP cache,
   and in TanStack Query in-memory cache.

### Proposed Architecture

```
                        +-----------------------+
                        |   PreviewProvider     |
                        |   (React Context)     |
                        +-----------+-----------+
                                    |
                    +---------------+---------------+
                    |                               |
          +---------v---------+          +----------v----------+
          | PreviewOverlay    |          | ThumbnailResolver   |
          | (fullscreen)      |          | (detail sidebar)    |
          +---+-------+---+--+          +-----------+----------+
              |       |   |                         |
     +--------v+  +---v---v-----+         +---------v----------+
     |Thumbnail|  |PreviewPanel |         | /api/preview/thumb |
     |Fallback |  |(lazy loaded)|         | (server endpoint)  |
     +---------+  +------+------+         +--------------------+
                         |
            +------------+------------+
            |            |            |
     +------v----+ +----v------+ +---v--------+
     |ImageViewer| |TextViewer | |EigenViewer |
     |VideoViewer| |CodeViewer | |DocPreview  |
     |AudioViewer| |PDFViewer  | |SlidePreview|
     +-----------+ |CSVViewer  | |BoardPreview|
                   |MDViewer   | |SheetPreview|
                   +-----------+ +------------+
```

### Preview Registry (Plugin System)

```typescript
type PreviewRenderer = {
    canHandle: (mimeType: string, fileName: string) => boolean;
    thumbnailSupported: boolean;
    component: React.LazyComponent;     // Lazy-loaded preview component
    priority: number;                    // Higher = checked first
}

// Registry ordered by priority. The `canHandle` second parameter is fileName
// for extension-based fallback when MIME is generic (e.g., application/octet-stream).
const previewRegistry: PreviewRenderer[] = [
    { canHandle: (m) => m.startsWith('image/'), thumbnailSupported: true, component: lazy(() => import('./viewers/image-viewer')), priority: 100 },
    { canHandle: (m) => m.startsWith('video/'), thumbnailSupported: true, component: lazy(() => import('./viewers/video-viewer')), priority: 100 },
    { canHandle: (m) => m.startsWith('audio/'), thumbnailSupported: true, component: lazy(() => import('./viewers/audio-viewer')), priority: 100 },
    { canHandle: (m) => m === 'application/pdf', thumbnailSupported: true, component: lazy(() => import('./viewers/pdf-viewer')), priority: 100 },
    { canHandle: (m) => m === 'application/eigendoc', thumbnailSupported: true, component: lazy(() => import('./viewers/eigendoc-viewer')), priority: 90 },
    { canHandle: (m) => m === 'application/eigenslides', thumbnailSupported: true, component: lazy(() => import('./viewers/eigenslides-viewer')), priority: 90 },
    { canHandle: (m) => m === 'application/eigenstickies', thumbnailSupported: true, component: lazy(() => import('./viewers/eigenstickies-viewer')), priority: 90 },
    { canHandle: (m) => m === 'application/eigensheets', thumbnailSupported: true, component: lazy(() => import('./viewers/eigensheets-viewer')), priority: 90 },
    { canHandle: (m) => m === 'application/eigenchat', thumbnailSupported: false, component: lazy(() => import('./viewers/eigenchat-viewer')), priority: 90 },
    { canHandle: (m) => m === 'text/markdown', thumbnailSupported: false, component: lazy(() => import('./viewers/markdown-viewer')), priority: 80 },
    { canHandle: (m, f) => isCodeMime(m) || isCodeExtension(f), thumbnailSupported: false, component: lazy(() => import('./viewers/code-viewer')), priority: 80 },
    { canHandle: (m) => m === 'text/csv', thumbnailSupported: false, component: lazy(() => import('./viewers/csv-viewer')), priority: 80 },
    { canHandle: (m) => m === 'application/json', thumbnailSupported: false, component: lazy(() => import('./viewers/json-viewer')), priority: 80 },
    { canHandle: (m) => m.startsWith('text/'), thumbnailSupported: false, component: lazy(() => import('./viewers/text-viewer')), priority: 50 },
];
```

Note: the `canHandle` function takes both MIME type and filename. This matters because servers often tag `.ts`, `.tsx`,
`.rs`, `.go` files as `application/octet-stream` or `text/plain`. Extension-based fallback via `isCodeExtension()`
handles these cases.

### New API Endpoints

```
GET /drive/:ownerId/:mountId/preview/:pathId/thumb    -> WebP thumbnail (any type)
GET /drive/:ownerId/:mountId/preview/:pathId/data     -> Preview-specific data (JSON)
```

These extend the existing drive router (`apps/api/src/routes/drive.ts`). Auth and ACL checks follow the same
`getSharedDrive(params.ownerId, user)` pattern already used for downloads and thumbnails.

The `/preview/:pathId/data` endpoint returns type-specific preview payloads:

- **eigendoc**: `{ html: string, wordCount: number }`
- **eigenslides**: `{ slideCount: number, firstSlide: { objects: SlideObject[], backgroundColor: string, backgroundImage?: string } }`
- **eigenstickies**: `{ columns: { title: string, taskCount: number }[], totalTasks: number }`
- **eigensheets**: `{ sheetName: string, preview: string[][] }` (top-left 10x20 cells)
- **eigenchat**: `{ messageCount: number, lastMessages: { sender: string, text: string, timestamp: number }[] }`
- **code/text**: `{ content: string, lineCount: number, language: string }` (first 200 lines)
- **csv**: `{ headers: string[], rows: string[][], totalRows: number }` (first 50 rows)
- **markdown**: `{ html: string }` (rendered server-side, sanitized)

---

## Speed Optimization Strategies

### The Speed Budget

To match macOS Quick Look's perceived instant feel:

| Phase | Target | What Happens |
|-------|--------|--------------|
| 0-50ms | Overlay appears | Dark backdrop + container animate in |
| 50-100ms | Thumbnail visible | Cached WebP thumbnail fills the frame |
| 100-300ms | Preview loading | Spinner on top of thumbnail |
| 300-1000ms | Full preview ready | Swap thumbnail for full renderer |

### Strategy 1: Show Thumbnail First (Two-Phase Rendering)

```
User presses Space
  -> Instantly show overlay with cached thumbnail (already loaded in DriveDetail)
  -> Start loading full preview component (React.lazy)
  -> Start fetching preview data from API
  -> Once both ready, crossfade from thumbnail to full preview
```

The thumbnail is likely already in the browser's HTTP cache from the DriveDetail sidebar (served with
`Cache-Control: public, max-age=86400` from the existing `/drive/:ownerId/:mountId/thumb/:fileName` endpoint).
This makes phase 1 essentially free.

For files without thumbnails (text, code, CSV), skip to showing a loading skeleton immediately.

### Strategy 2: Prefetch on Hover/Select

When a file is selected in the list (single click), start prefetching its preview data:

```typescript
// In DriveTable, on row select:
const prefetchPreview = (path: DrivePath) => {
    const renderer = findRenderer(path.mimeType, path.name);
    if (renderer) {
        queryClient.prefetchQuery({
            queryKey: previewKeys.data(path.ownerId, path.mountId, path.id),
            queryFn: () => fetchPreviewData(path),
            staleTime: 60_000,
        });
    }
};
```

By the time the user presses Space, the data is already cached. For text/code files, the full content (first 200
lines) is typically under 10KB and fetches in <50ms.

### Strategy 3: Lazy-Load Viewer Components

Each viewer is a separate chunk. The image viewer (most common) stays in the main bundle. Everything else is
`React.lazy`:

```
main bundle:     ImageViewer, VideoViewer (~5KB)
lazy chunk 1:    PDFViewer (~200KB, pdfjs-dist worker + core)
lazy chunk 2:    CodeViewer (~30KB, lowlight + theme)
lazy chunk 3:    MarkdownViewer (~15KB, marked)
lazy chunk 4:    EigenDocViewer (~50KB, tiptap read-only renderer)
lazy chunk 5:    EigenSlidesViewer (~10KB, reuses ReadOnlySlideObject)
lazy chunk 6:    CSVViewer, JSONViewer, TextViewer (~5KB)
```

Preload common chunks on app startup via `<link rel="modulepreload">` for PDFViewer and CodeViewer since these are
the most likely secondary file types.

### Strategy 4: Server-Side Pre-Rendering for Eigen Types

On every Yjs document save (the existing `DbProvider.createSnapshot()` in `collabDocument.ts` triggers every 100
updates), generate a static preview artifact:

- **eigendoc**: Render Yjs content to HTML using `@tiptap/html` (server-side, no DOM needed). Store as
  `thumbs/{pathId}.preview.html`.
- **eigenslides**: Read slide data from Yjs (slideOrder, slides, objects Y.Maps), serialize first slide's objects
  as JSON. Store as `thumbs/{pathId}.preview.json`.
- **eigensheets**: Read the `state` Y.Map snapshot, extract top-left cells. Store as JSON.
- **eigenstickies**: Read `columns`, `tasks`, `columnOrder` from Yjs, extract column names + task counts. Store as
  JSON.

This means preview data is ready before the user ever clicks.

**Caveat**: `DbProvider.createSnapshot()` currently runs synchronously in the `storeUpdate` path. Preview generation
must be fully async and non-blocking -- use `queueMicrotask()` or `setTimeout(fn, 0)` to defer it.

### Strategy 5: Content-Addressable Preview Cache

Use `{pathId}` as the stable key with `updatedAt` for invalidation. The API endpoint returns
`Cache-Control: public, max-age=86400` with an ETag based on `updatedAt` (matching the pattern already used for
thumbnails and file downloads in `drive.ts`).

```
thumbs/
  {pathId}.webp              <- existing thumbnail (images)
  {pathId}.preview.html      <- eigendoc rendered HTML
  {pathId}.preview.json      <- eigenslides/sheets/stickies/audio preview data
  {pathId}.preview.webp      <- generated preview image (PDF first page, video frame, etc.)
```

### Strategy 6: Stream Large Content

For text/code files, return only the first 200 lines server-side. For CSV, only the first 50 rows. For PDF, render
only page 1 initially, then lazy-load remaining pages on scroll. This keeps the initial payload small and the preview
fast.

---

## Eigen File Type Preview Approach

### Option A: Server-Side HTML Snapshot (Recommended for eigendoc)

The Tiptap editor stores content as a Yjs document. `@tiptap/html` can convert a Tiptap JSON document to HTML
without a browser DOM:

```typescript
import { generateHTML } from '@tiptap/html';
import StarterKit from '@tiptap/starter-kit';
// Must use the same extension set as the editor (StarterKit, Underline, Subscript,
// Superscript, TextStyle, Color, TextAlign, TaskList, TaskItem, Link, Highlight,
// CodeBlockLowlight, Table/Row/Cell/Header, CommentMark, ResizableImage)

const html = generateHTML(jsonContent, [StarterKit, ...extensions]);
```

**Pipeline**:
1. On Yjs snapshot in `DbProvider.createSnapshot()`, trigger async preview generation
2. Load the Yjs doc state, convert the `Y.XmlFragment` to Tiptap JSON via `yXmlFragmentToProseMirrorJSON()`
3. Generate HTML via `generateHTML()`
4. Store the HTML string in `thumbs/{pathId}.preview.html`
5. Frontend fetches this HTML and renders in a sandboxed container with Eigen's prose CSS

**Advantages**: Fast (HTML is pre-generated), accurate (same extension pipeline), small payload.

**Thumbnail generation**: Sharp's SVG input does not support `<foreignObject>` with HTML content (librsvg limitation).
Instead, generate a simplified text-only preview image: extract the first ~500 characters of plain text from the doc,
render as a styled SVG with text elements, convert to WebP via Sharp. Alternatively, skip image thumbnails for
eigendocs and rely on the HTML preview with a document icon fallback.

### Option B: Read-Only Mini App (Recommended for eigenslides)

The Slides app has `ReadOnlySlideObject` (`apps/slides/src/components/slides/slide-object.tsx`) and `SlideThumbnail`
(`apps/slides/src/components/slides/slide-thumbnail.tsx`) that render without Yjs or WebSocket connections.
`SlideThumbnail` already handles text (with font scaling at 4px), images (with objectFit), background colors, and
background images. We can reuse these directly:

```typescript
const EigenSlidesViewer = ({ previewData }: { previewData: SlidesPreviewData }) => {
    return (
        <div style={{ aspectRatio: '16/9' }} className="bg-white relative">
            {previewData.firstSlide.objects.map(obj => (
                <ReadOnlySlideObject key={obj.id} obj={obj} />
            ))}
        </div>
    );
};
```

The `ReadOnlySlideObject` component uses `getObjectPositionStyle()` for percentage-based CSS positioning, which works
at any render size. Text uses `obj.fontSize / 1080 * 100` viewport-relative sizing, which may need adjustment for
the preview container (use a fixed container height and scale the font accordingly).

**For eigenslides thumbnail**: The server extracts slide data from Yjs, sends it as JSON. The client renders it.
For a server-side image thumbnail, build an SVG from the slide objects' position/size/text data and convert via Sharp.

### Option C: Data Extract + Custom Renderer (Recommended for eigensheets, eigenstickies)

**Eigensheets**: Extract the Yjs `Y.Map("state")` snapshot. Pull the first sheet's cell data (top-left 10 columns x
20 rows). Use `cell.v` (computed value) not `cell.m` (display string) for numeric accuracy. Render as a simple HTML
`<table>` with Eigen's table styling.

**Eigenstickies**: Extract board state from Yjs (`Y.Map("columns")`, `Y.Map("tasks")`, `Y.Array("columnOrder")`).
Render as a simplified kanban:

```
[To Do (3)]  [In Progress (2)]  [Done (5)]
  - Task 1     - Task 4           - Task 6
  - Task 2     - Task 5           - Task 7
  - Task 3                        - Task 8
                                  - ...
```

### Option D: Eigenchat Preview

Chat is SQLite-based, not Yjs. Chat rooms have their own `data.db` inside the `.eigenchat` folder. The preview
endpoint opens this database, queries the last 5-10 messages, and returns them as JSON. The frontend renders a
simplified message list (no WebSocket needed, no real-time updates in preview).

### Server-Side Preview Data Extraction

Create a `PreviewGenerator` class separate from `CollabDocument` to avoid coupling:

```typescript
// apps/api/src/lib/preview/preview-generator.ts
class PreviewGenerator {
    async generateDocPreview(drive: Drive, mountId: string, pathId: string): Promise<DocPreviewData> {
        const dataDbPath = await drive.getChildByName(mountId, pathId, 'data.db');
        if (!dataDbPath) return null;
        const managedDb = await drive.openDatabase(mountId, COLLAB_DB_CONFIG, dataDbPath.id);
        const doc = new Y.Doc();
        const snapshot = managedDb.db.select().from(docSnapshots)
            .orderBy(desc(docSnapshots.id)).limit(1).get();
        if (snapshot) Y.applyUpdate(doc, snapshot.stateData as Uint8Array);
        // Convert Y.XmlFragment -> Tiptap JSON -> HTML
        const fragment = doc.getXmlFragment('default');
        const json = yXmlFragmentToProseMirrorJSON(fragment);
        const html = generateHTML(json, extensions);
        doc.destroy();
        return { html, wordCount: countWords(html) };
    }

    async generateSlidesPreview(drive: Drive, mountId: string, pathId: string): Promise<SlidesPreviewData> {
        // Load Yjs, read slideOrder Y.Array, slides Y.Map, objects Y.Map
        // Extract first slide's objects, backgroundColor, backgroundImage
    }
}
```

### Integration with Existing Save Flow

The existing `DbProvider.createSnapshot()` in `collabDocument.ts` runs every `SNAPSHOT_INTERVAL` (100) updates. It
consolidates all incremental updates into a single snapshot and prunes old ones (max 50 revisions). Hook into this
with a deferred async call:

```typescript
private createSnapshot(): void {
    // ... existing snapshot code (stateData, lastUpdateId, prune) ...
    // Trigger async preview generation (non-blocking, fire-and-forget)
    queueMicrotask(() => this.generatePreviewAsync());
}

private async generatePreviewAsync(): Promise<void> {
    try {
        const previewData = await this.previewGenerator.generate(this.drive, this.path);
        await this.savePreviewData(previewData);
    } catch {
        // Preview generation failure is non-critical -- log and continue
    }
}
```

---

## External File Type Preview Approach

### PDF Preview

**Library**: `pdfjs-dist` (Mozilla's PDF.js)

**Why PDF.js over iframe**: Full control over rendering, progressive page loading, consistent cross-browser behavior,
text selection, zoom controls. The current iframe approach gives no control over scrolling, zoom, or error handling.

**Implementation**:

```typescript
const PDFViewer = ({ url }: { url: string }) => {
    const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const loadTask = pdfjsLib.getDocument(url);
        loadTask.promise.then(setPdf);
        return () => loadTask.destroy();
    }, [url]);

    // Render only visible pages (virtualized)
    return <canvas ref={canvasRef} />;
};
```

**Server-side thumbnail**: Use `pdfjs-dist` in Node/Bun to render page 1 to a canvas (via `node-canvas` or
`OffscreenCanvas`), then convert to WebP via Sharp. Run in a worker thread to avoid blocking the main event loop.
Alternatively, use `pdf-img-convert` which wraps this pipeline.

**Bundle size**: pdfjs-dist is ~200KB gzipped (core + worker). The PDF worker should be loaded as a separate worker
file, not inlined. Configure via `pdfjsLib.GlobalWorkerOptions.workerSrc`.

### Code Files (Syntax Highlighting)

**Library**: `lowlight` (already installed in docs app via `apps/docs/package.json`, used by `CodeBlockLowlight`
extension in `apps/docs/src/components/docs/editor.tsx`)

Lowlight is a virtual highlighter that works without DOM. It outputs `hast` (HTML AST) nodes that can be rendered to
React elements. Supports 40+ languages via `common` preset.

```typescript
const CodeViewer = ({ content, language }: { content: string; language: string }) => {
    const highlighted = lowlight.highlight(language, content.slice(0, MAX_CHARS));
    return (
        <pre className="font-mono text-sm p-4 overflow-auto">
            {toJsxRuntime(highlighted, { Fragment, jsx, jsxs })}
        </pre>
    );
};
```

**Language detection**: MIME types are unreliable for code files. Use a two-pass approach:
1. Check MIME type (`text/javascript`, `application/json`, `text/css`, `text/html`, `text/xml`, `text/x-python`,
   `application/x-sh`, `text/x-c`, `text/x-c++`)
2. Fall back to extension-based detection: `.ts`/`.tsx` -> typescript, `.rs` -> rust, `.go` -> go, `.py` -> python,
   `.rb` -> ruby, `.java` -> java, `.kt` -> kotlin, `.swift` -> swift, `.sh` -> bash, `.yml`/`.yaml` -> yaml,
   `.toml` -> toml, `.sql` -> sql, `.jsx` -> javascript

**Alternative**: `shiki` (TextMate grammar based, more accurate highlighting, WASM mode). Worth evaluating if
lowlight's highlighting quality is insufficient. However, lowlight is already a dependency via docs -- prefer
reuse over adding a new highlighter.

### Markdown

**Library**: `marked` (~10KB gzipped, fast, CommonMark + GFM tables/strikethrough).

Since the RESEARCH_INLINE_EDITING doc proposes `tiptap-markdown` for editing `.md` files, the preview renderer
should use a lighter-weight library that does not pull in Tiptap. `marked` is sufficient for read-only rendering.

```typescript
const MarkdownViewer = ({ content }: { content: string }) => {
    const html = useMemo(() => DOMPurify.sanitize(marked.parse(content)), [content]);
    return <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: html }} />;
};
```

Note: markdown output must be sanitized before rendering via `dangerouslySetInnerHTML`. Markdown files from untrusted
sources can contain arbitrary HTML, script injection via `javascript:` URLs in links, or `<img onerror>` payloads.

### CSV

Use `papaparse` (~7KB) for proper CSV parsing. Naive `split(',')` breaks on quoted fields containing commas,
newlines, or escaped quotes:

```typescript
const CSVViewer = ({ content }: { content: string }) => {
    const { data, meta } = useMemo(() =>
        Papa.parse(content, { header: true, preview: 100 }), [content]);
    return (
        <table>
            <thead><tr>{meta.fields?.map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{data.map((row, i) => (
                <tr key={i}>{meta.fields?.map((f, j) => <td key={j}>{row[f]}</td>)}</tr>
            ))}</tbody>
        </table>
    );
};
```

### Office Documents (DOCX, XLSX, PPTX)

This is the hardest category. Options ranked by feasibility:

**Option 1: `mammoth` for DOCX (recommended)**

Converts DOCX to clean semantic HTML. ~50KB. Does not support complex layouts, headers/footers, or advanced
formatting, but handles 80% of documents well enough for preview.

```typescript
const result = await mammoth.convertToHtml({ arrayBuffer });
// result.value is HTML string -- must sanitize before rendering
const safeHtml = DOMPurify.sanitize(result.value);
```

This aligns with RESEARCH_INLINE_EDITING which also proposes mammoth for DOCX viewing/editing.

**Option 2: `SheetJS` / `xlsx` for XLSX**

Parses Excel files client-side. Can extract cell data and render as HTML table. ~200KB. The community edition is
sufficient for preview (first sheet, top-left cells only).

**Option 3: Custom PPTX parser**

PPTX files are ZIP archives containing XML. A minimal parser can extract slide text and images. No good open-source
library exists for browser-side PPTX rendering. Consider server-side LibreOffice conversion as a future enhancement.

**Option 4: Server-side LibreOffice (future, heavy)**

Run headless LibreOffice to convert Office files to PDF, then use PDF.js. Accurate but requires LibreOffice
installation. Only worth it if Office file support becomes a priority. Could run in Docker sidecar (see DOCKER.md).

### Audio Files

**Waveform visualization**: Use Web Audio API to decode audio and draw a waveform on canvas:

```typescript
const audioContext = new AudioContext();
const buffer = await audioContext.decodeAudioData(arrayBuffer);
const channelData = buffer.getChannelData(0);
// Downsample to ~500 peaks, draw as bars on canvas
```

**Server-side waveform thumbnail**: Compute peaks server-side by reading audio file headers (or full decode for
short files), store as a JSON array of peak values. Sharp can render the peaks as a simple SVG bar chart converted
to WebP. Alternatively, use `audiowaveform` (C++ tool) if available.

### Video Thumbnails

**Server-side with FFmpeg**: Extract a frame at ~1 second (avoids black frames common at t=0):

```bash
ffmpeg -i input.mp4 -ss 00:00:01 -vframes 1 -f image2pipe -vcodec png pipe:1
```

Bun can shell out via `Bun.spawn()`. Check if FFmpeg is available at startup; if not, skip video thumbnails
gracefully. Store the extracted frame through Sharp (resize + WebP conversion) into the existing thumbs directory.

Also extract duration and dimensions from FFmpeg's probe output to populate `details.duration`, `details.width`,
`details.height` on the DrivePath.

**Client-side fallback**: For environments without FFmpeg, use the browser's `<video>` element to seek to 1s and
capture a frame via canvas. This only works when the user actively previews the video, not for background thumbnail
generation.

### SVG (Safe Rendering)

SVGs are an active attack vector. They can contain:
- `<script>` elements (JavaScript execution)
- Event handlers (`onload`, `onerror`, `onclick`)
- External resource references (`<image xlink:href="http://evil.com/track.gif">`)
- CSS `@import` and `url()` for data exfiltration
- Embedded `<foreignObject>` with arbitrary HTML

Sanitize before rendering in preview:

```typescript
import DOMPurify from 'dompurify';
const safeSvg = DOMPurify.sanitize(svgString, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover'],
});
// Render as <img> to further sandbox (img context blocks script execution)
// <img src={`data:image/svg+xml,${encodeURIComponent(safeSvg)}`} />
```

Rendering as `<img src="data:image/svg+xml,...">` provides a second layer of defense: browsers do not execute
scripts in SVGs loaded via `<img>`. Do NOT use `<iframe>` or `dangerouslySetInnerHTML` for SVG preview.

The existing thumbnail system already rasterizes SVGs via Sharp (which uses librsvg), which is safe because librsvg
does not execute JavaScript.

### Fonts (TTF/OTF/WOFF)

Load via the `FontFace` API and render a character sample:

```typescript
const FontViewer = ({ url }: { url: string }) => {
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        const fontFace = new FontFace('preview-font', `url(${url})`);
        fontFace.load().then(() => {
            document.fonts.add(fontFace);
            setLoaded(true);
        });
        return () => { document.fonts.delete(fontFace); };
    }, [url]);

    if (!loaded) return <Spinner />;

    return (
        <div style={{ fontFamily: 'preview-font' }}>
            <p className="text-4xl">The quick brown fox jumps over the lazy dog</p>
            <p className="text-2xl">ABCDEFGHIJKLMNOPQRSTUVWXYZ</p>
            <p className="text-2xl">abcdefghijklmnopqrstuvwxyz</p>
            <p className="text-2xl">0123456789 !@#$%^&*()</p>
        </div>
    );
};
```

**Security note**: Malicious font files can exploit parser vulnerabilities in the browser's font rendering engine.
The risk is low (browsers sandbox font parsing) but worth noting. Do not allow font preview for files from untrusted
external sources without explicit user action.

### 3D Models (GLB/GLTF)

**Library**: `@google/model-viewer` (web component, ~150KB) or `three.js` with `GLTFLoader`.

This is a low-priority nice-to-have. Load lazily and only when the user explicitly previews a 3D file.

---

## Security Considerations

Rendering untrusted files in preview is fundamentally a security-sensitive operation. Key mitigations:

| File Type | Threat | Mitigation |
|-----------|--------|------------|
| SVG | Script execution, external resource loading | DOMPurify sanitization + render as `<img>` (not `<iframe>`) |
| HTML/XML | XSS via `dangerouslySetInnerHTML` | Never render raw HTML from files; syntax-highlight only |
| Markdown | Script injection via HTML blocks, `javascript:` links | Sanitize rendered HTML via DOMPurify |
| PDF | JavaScript in PDF, external resource loading | PDF.js runs in a worker (sandboxed); disable JS execution |
| DOCX/XLSX | Macro execution, external references | mammoth/xlsx do not execute macros; sanitize output HTML |
| Eigendoc HTML | Stored XSS if doc content contains script tags | Sanitize `generateHTML()` output before rendering |
| Fonts | Parser exploits | Browser sandboxes font rendering; accept the residual risk |
| Code files | No rendering risk | Syntax highlighting produces safe AST nodes, no raw HTML |

**General principle**: Never render file content via `dangerouslySetInnerHTML` without sanitization. Always prefer
rendering approaches that produce safe output (lowlight AST, `<img>` for SVG, canvas for PDF).

For eigendoc HTML previews specifically: Tiptap's `generateHTML()` converts the ProseMirror doc tree, which
constrains output to known node/mark types. However, if a user pastes raw HTML into a document, it could persist
as HTML content. Sanitize the output before displaying in preview.

---

## Caching and Pre-generation Strategy

### Cache Layers

```
Layer 1: Browser Cache (HTTP)
  - Thumbnails: Cache-Control: public, max-age=86400 (already implemented in drive routes)
  - Preview data: Cache-Control: public, max-age=3600, ETag: {updatedAt}
  - Full files: Cache-Control: public, max-age=86400 (already implemented)

Layer 2: TanStack Query Cache (in-memory)
  - Preview data: staleTime=60s, gcTime=5min
  - Prefetched on file select, ready for instant display

Layer 3: Server Disk Cache (thumbs/ directory)
  - Thumbnails: {pathId}.webp (already exists)
  - Preview images: {pathId}.preview.webp
  - Preview data: {pathId}.preview.json
  - Rendered HTML: {pathId}.preview.html

Layer 4: Service Worker Cache (optional, future)
  - Cache preview chunks (PDF.js pages, large images)
  - Offline preview support for recently viewed files
```

### Pre-generation Pipeline

```
File Upload (apps/api/src/lib/drive/drive.ts uploadFile)
  -> Generate image thumbnail (existing, Sharp via saveThumbnail)
  -> Extract image dimensions (existing, Sharp via extractImageDetails)
  -> Generate video thumbnail (new, FFmpeg first frame, if available)
  -> Generate PDF thumbnail (new, pdfjs-dist first page -> Sharp)
  -> Extract video/audio metadata: duration, dimensions (new, FFmpeg probe)

Yjs Document Save (collabDocument.ts DbProvider.createSnapshot, every 100 updates)
  -> Generate eigendoc HTML preview (async, non-blocking)
  -> Generate eigenslides first-slide JSON (async)
  -> Generate eigensheets cell preview JSON (async)
  -> Generate eigenstickies board summary JSON (async)

Background Job (periodic, optional)
  -> Scan for files missing preview data
  -> Generate any missing thumbnails/previews
  -> Clean up orphaned preview files (where pathId no longer exists in metadata.db)
```

### Cache Invalidation

- **Files**: Invalidate on re-upload (same pathId, new content). The `updatedAt` field changes. The existing
  `deleteThumbnail()` function cleans up old thumbnails -- extend it to also clean `.preview.*` files.
- **Eigen docs**: Invalidate on Yjs snapshot (every 100 updates, roughly every few minutes of editing). The preview
  generation overwrites the previous `.preview.html`/`.preview.json` file.
- **Thumbnails**: Stored with pathId as key. Delete on file delete (already implemented via `deleteThumbnail`).
- **Preview data**: Same lifecycle as thumbnails. Extend `deleteThumbnail()` to also delete `.preview.*` variants.

---

## Bandwidth and Payload Sizing

### Preview Data Size Estimates

| Preview Type | Typical Size | Max Size | Notes |
|-------------|-------------|----------|-------|
| Image thumbnail (WebP, 512px) | 5-50KB | ~100KB | Already exists, quality 80 |
| Video thumbnail (WebP, 512px) | 10-50KB | ~100KB | Single frame |
| PDF first-page (WebP, 512px) | 20-100KB | ~200KB | Rendered page |
| Eigendoc HTML | 1-50KB | ~200KB | Depends on doc length |
| Eigenslides JSON | 1-10KB | ~50KB | First slide objects |
| Eigensheets JSON | 1-5KB | ~20KB | 10x20 cells |
| Eigenstickies JSON | 0.5-3KB | ~10KB | Column names + task titles |
| Eigenchat messages | 1-5KB | ~20KB | Last 10 messages |
| Code/text (200 lines) | 2-15KB | ~50KB | Server truncates |
| CSV (50 rows) | 2-20KB | ~100KB | Server truncates |
| Audio waveform peaks | 1-5KB | ~10KB | 500 peak values |
| Markdown rendered HTML | 2-30KB | ~200KB | Must sanitize |

**Total storage overhead per file**: ~10-100KB average. For a drive with 10,000 files: ~100MB-1GB additional disk
usage. Acceptable for a self-hosted system.

**Network impact**: Preview data payloads are small (1-50KB typical). Combined with aggressive HTTP caching and
TanStack Query in-memory cache, repeat views are essentially free. The largest payload is the PDF.js library itself
(~200KB) which is loaded once and cached by the browser.

### Size Limits

Enforce limits on what gets previewed server-side to prevent DoS:

- Text/code files: serve first 200 lines or 50KB, whichever is smaller
- CSV files: serve first 50 rows or 100KB
- Markdown: render first 100KB of source
- Eigendoc HTML: cap at 500KB
- Image thumbnails: already limited (Sharp rejects images >12000x12000)

---

## Accessibility

### Keyboard Navigation

The preview overlay must be fully keyboard-navigable:

| Key | Action |
|-----|--------|
| Space | Toggle preview (when file selected in list) |
| Escape | Close preview, return focus to file list |
| ArrowLeft / ArrowRight | Previous/next file |
| Enter | Open file in its app |
| Tab | Cycle through footer action buttons (Open, Download, Share) |

Focus management: when the overlay opens, trap focus within it (standard modal pattern). When it closes, return
focus to the previously focused file list item.

### Screen Reader Support

- Overlay announced as a dialog with `role="dialog"` and `aria-label="File preview"`
- File name and position announced: `aria-label="Preview of report.pdf, 3 of 12 files"`
- Image previews: use the file name as `alt` text
- Video/audio: native `<video controls>` and `<audio controls>` provide built-in accessibility
- Text/code previews: readable by screen readers natively (rendered as `<pre>` with text content)
- PDF.js: supports text extraction layer for screen readers
- Navigation buttons: proper `aria-label` on prev/next/close buttons

### Reduced Motion

Respect `prefers-reduced-motion`:
- Skip the zoom-in animation on overlay open
- Skip the crossfade from thumbnail to full preview
- Use instant show/hide instead of transitions

### Color Contrast

- Header/footer controls must meet WCAG AA contrast against the dark backdrop
- Code syntax highlighting themes must have sufficient contrast (lowlight's default themes generally do)
- Error states must not rely solely on color (use text + icon)

---

## UI/UX Design

### Preview Overlay

```
+------------------------------------------------------------------+
|                                                                    |
|  [<]  filename.pdf  (3 of 12)                           [X]       |
|                                                                    |
|  +--------------------------------------------------------------+  |
|  |                                                              |  |
|  |                                                              |  |
|  |                     PREVIEW CONTENT                          |  |
|  |                                                              |  |
|  |                                                              |  |
|  |                                                              |  |
|  +--------------------------------------------------------------+  |
|                                                                    |
|  [ Open ]  [ Download ]  [ Share ]                                 |
|                                                                    |
+------------------------------------------------------------------+
```

### Key Interactions

| Input | Action |
|-------|--------|
| `Space` | Toggle preview open/close (when file selected in list) |
| `Escape` | Close preview |
| `ArrowLeft` / `ArrowRight` | Previous/next file in current folder |
| `Enter` | Open file in its app (eigendoc -> Docs, PDF -> download, etc.) |
| Click backdrop | Close preview |
| Scroll (in preview) | Scroll content (PDF pages, long text, etc.) |
| Pinch/zoom (touch) | Zoom images |

Note: ArrowUp/ArrowDown are NOT used for file navigation in preview mode -- that would conflict with scrolling
within the preview content (code files, PDF pages, etc.). Only ArrowLeft/ArrowRight navigate between files.

### Progressive Loading States

```
State 1: Opening
  -> Show cached thumbnail (from DriveDetail/DriveTable browser cache)
  -> Backdrop fades in
  -> Container zooms in (animate-in zoom-in-95, already exists in FilePreview)

State 2: Loading
  -> Thumbnail visible at preview size
  -> Small spinner in bottom-right corner
  -> File name and navigation visible in header

State 3: Ready
  -> Crossfade from thumbnail to full preview
  -> All interactive controls available

State 4: Error
  -> Show file icon + "Preview not available" text
  -> "Download" and "Open" buttons still work
  -> For unsupported types: "No preview available for .xyz files"
```

### Header Bar

Minimal header with:
- File name (truncated with `text-ellipsis`)
- Position indicator: "3 of 12" (current index in folder)
- Left/Right arrow buttons for navigation (also available via keyboard)
- Close button (X)

### Footer Bar

- "Open" button (opens in appropriate app via `openDocument()` from `packages/lib/src/core/api.ts`)
- "Download" button (triggers download via `getDriveDownloadUrl()`)
- "Share" button (opens access dialog, reusing `onShareClick` from DriveDetail)
- File size and type badge

### Mobile Considerations

- Full-screen preview (no padding)
- Swipe left/right for navigation (use `touch-action: pan-y` to allow vertical scroll while capturing horizontal swipe)
- Swipe down to close
- Pinch to zoom on images
- Same progressive loading states

---

## Cross-Cutting Concerns

### Relationship to Copy-Paste System (RESEARCH_COPY_PASTE.md)

The copy-paste system's **Layout Preservation Strategy** generates self-contained HTML fragments with inline styles
for visual reproduction across apps. Preview rendering needs the same capability:

- **Eigendoc preview HTML** and the copy-paste HTML fragment for a doc selection use the same Tiptap-to-HTML pipeline.
  Extract this into a shared utility (`generateHtmlFromTiptapDoc()`) usable by both systems.
- **Eigenslides preview** and the clipboard's slide-to-image export both need to render slide objects to a static
  representation. The `ReadOnlySlideObject` component serves both use cases.
- **Eigensheets preview** (table of cells) mirrors the HTML table generated when copying cells from Sheets. The
  `extractChartData()` pattern from RESEARCH_GRAPHS.md could be reused for cell range extraction.

Shared code opportunity: a `renderToStaticHtml()` utility that takes an Eigen document type and produces a
self-contained HTML snapshot. Used by preview, clipboard, and (future) export/print.

### Eigenvector Previews (RESEARCH_VECTOR.md)

The RESEARCH_VECTOR doc proposes `.eigenvector` files stored as Drive folders (MIME `application/eigenvector`),
using SVG rendering with Yjs collaboration. Preview approach:

- **Thumbnail**: Extract the element data from Yjs, build an SVG string from element positions/shapes/text, render
  to WebP via Sharp. This is analogous to eigenslides thumbnails but for an infinite canvas (need to compute a
  bounding box of all elements and viewport-fit).
- **Preview**: Render the SVG in a sandboxed `<img>` element (safe since SVG-as-img blocks scripts). The vector app's
  read-only renderer can be reused, similar to `ReadOnlySlideObject` for slides.
- **Registry entry**: Add `{ canHandle: (m) => m === 'application/eigenvector', ... }` at priority 90, alongside
  other eigen types.

### Chart Previews (RESEARCH_GRAPHS.md)

The RESEARCH_GRAPHS doc proposes `<EigenChart>` components rendering Recharts (SVG-based charts) across sheets, docs,
and slides. For preview:

- Charts embedded in eigendocs render as part of the doc's HTML preview (the `ChartNode` Tiptap extension would need
  a server-side rendering path, or charts could be pre-rendered as SVG/PNG and embedded as images in the preview HTML).
- Charts embedded in eigenslides render as part of the slide preview (the `ReadOnlySlideObject` for chart objects
  would render `<EigenChart interactive={false} />`).
- Charts in eigensheets are canvas overlays -- they would not appear in the cell-data preview, but a future "sheet
  screenshot" thumbnail could capture them.

Server-side chart rendering: Recharts outputs SVG. On the server, the SVG string could be extracted and passed to
Sharp for rasterization. This requires running React's `renderToStaticMarkup()` server-side with Recharts components.

### Inline Editing Integration (RESEARCH_INLINE_EDITING.md)

The inline editing research proposes opening `.md`, `.txt`, and `.docx` files directly in the Tiptap editor. The
preview system is the natural "first contact" for these files:

- Preview shows the rendered content (markdown -> HTML, code -> highlighted, DOCX -> mammoth HTML)
- The "Open" button in the preview footer navigates to the inline editor (for `.md`/`.txt`) or the Docs app
  (for `.docx`), using the routing proposed in RESEARCH_INLINE_EDITING (`/_auth/edit/$ownerId/$mountId/$pathId`)
- The preview system validates that the inline editing rendering is correct before the user commits to opening
  the full editor

### Offline / Cached Previews

For recently viewed files, preview data persists in:
1. **TanStack Query in-memory cache** (survives navigation within the app, lost on page reload)
2. **Browser HTTP cache** (survives page reload, governed by Cache-Control headers)
3. **Server disk cache** (`thumbs/` directory, survives server restart)

A Service Worker (Layer 4, future) could cache preview data for offline use. This is most valuable for:
- Thumbnails of recently browsed folders
- Preview data for recently opened eigen documents
- PDF.js chunks (the ~200KB library)

This aligns with future offline-first goals if Eigen moves toward PWA support.

### File Hashing Integration (RESEARCH_FILE_HASHING.md)

The file hashing research proposes adding content hashes to Drive metadata. If implemented, the preview cache could
use content hashes instead of `updatedAt` for cache invalidation. Benefits:
- Content-addressable caching: if a file is re-uploaded with the same content, the existing preview is reused
- Stronger invalidation guarantees than timestamp-based approaches
- Deduplication of preview data for identical files

---

## Implementation Phases

### Phase 1: Enhanced Preview Overlay + Consolidation (2-3 days)

**Goal**: Upgrade the existing `FilePreview` to a proper Quick Look overlay with navigation. Consolidate the two
divergent copies of FilePreview.

**Changes**:
- Delete `apps/drive/src/components/drive/file-preview.tsx` -- use only the packages/ui version
- Fix the `aspectRatio` type inconsistency (standardize on `string`)
- Redesign `PreviewProvider` to accept a file list (current folder contents) and track current index
- Change Space to toggle preview, Enter to open file (requires modifying `use-keyboard-list-navigation.ts` to
  separate Space and Enter behavior)
- Add `ArrowLeft`/`ArrowRight` navigation between files while preview is open
- Add header bar with filename, position indicator, close button
- Add footer bar with Open/Download/Share actions
- Add progressive loading: show thumbnail first, crossfade to full content
- Add loading and error states
- Add `role="dialog"`, `aria-label`, focus trapping for accessibility
- Keep existing image/video/PDF support, improve PDF from iframe to full-bleed embed

**Files to modify**:
- `packages/ui/src/components/layout/preview-provider/preview-provider.tsx` -- add file list, navigation, Space hotkey
- `packages/ui/src/components/layout/drive/file-preview.tsx` -- redesign with header/footer/progressive loading
- `packages/ui/src/hooks/use-keyboard-list-navigation.ts` -- separate Space (preview) from Enter (open)
- `packages/ui/src/components/layout/drive/drive-layout.tsx` -- pass folder contents to preview provider
- `apps/drive/src/components/drive/file-preview.tsx` -- delete (use packages/ui version)

### Phase 2: Text-Based Previews (1-2 days)

**Goal**: Add preview for text, code, markdown, CSV, JSON.

**Changes**:
- Implement preview registry (plugin system)
- Create `TextViewer` (plain text with line numbers)
- Create `CodeViewer` (lowlight syntax highlighting, reuse from docs app, with extension-based language detection)
- Create `MarkdownViewer` (rendered HTML with prose styling, sanitized via DOMPurify)
- Create `CSVViewer` (table rendering via papaparse)
- Create `JSONViewer` (syntax highlighted via lowlight, collapsible sections optional)
- Add `/drive/:ownerId/:mountId/preview/:pathId/data` API endpoint for server-side text extraction (first 200 lines)
- Extend `isPreviewable()` / replace with registry-based `findRenderer()`

**New files**:
- `packages/ui/src/components/layout/preview-provider/viewers/text-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/code-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/markdown-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/csv-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/json-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/preview-registry.ts`
- `apps/api/src/routes/preview.ts` (or extend `drive.ts`)
- `apps/api/src/lib/preview/text-preview.ts`

### Phase 3: PDF.js Integration (1-2 days)

**Goal**: Replace iframe PDF preview with PDF.js for better performance and control.

**Changes**:
- Add `pdfjs-dist` dependency
- Configure PDF worker as a separate file (not inlined)
- Create `PDFViewer` component (canvas-based rendering, page navigation, zoom)
- Generate PDF first-page thumbnails server-side (run in worker thread)
- Add page count extraction on upload (store in `details.pageCount`)

**New files**:
- `packages/ui/src/components/layout/preview-provider/viewers/pdf-viewer.tsx`
- `apps/api/src/lib/preview/pdf-preview.ts` (server-side first-page extraction)

### Phase 4: Eigen Native Type Previews (3-4 days)

**Goal**: Preview eigendoc, eigenslides, eigenstickies, eigensheets, eigenchat without opening the full app.

This is the largest phase. The server-side Yjs extraction for each document type requires understanding each app's
Yjs data model.

**Changes**:
- Add `@tiptap/html` to API for server-side eigendoc HTML generation
- Create `PreviewGenerator` class with methods per document type
- Hook preview generation into `DbProvider.createSnapshot()` (async, non-blocking)
- Create `EigenDocViewer` (rendered + sanitized HTML in prose container)
- Create `EigenSlidesViewer` (reuse `ReadOnlySlideObject`, render first slide with proper font scaling)
- Create `EigenStickiesViewer` (simplified kanban columns with task titles)
- Create `EigenSheetsViewer` (table of top-left cells)
- Create `EigenChatViewer` (last N messages, simplified message bubbles)
- Extend `deleteThumbnail()` to also clean up `.preview.*` files

**New files**:
- `apps/api/src/lib/preview/preview-generator.ts`
- `apps/api/src/lib/preview/eigendoc-preview.ts`
- `apps/api/src/lib/preview/eigenslides-preview.ts`
- `apps/api/src/lib/preview/eigensheets-preview.ts`
- `apps/api/src/lib/preview/eigenstickies-preview.ts`
- `apps/api/src/lib/preview/eigenchat-preview.ts`
- `packages/ui/src/components/layout/preview-provider/viewers/eigendoc-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/eigenslides-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/eigenstickies-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/eigensheets-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/eigenchat-viewer.tsx`

### Phase 5: Video/Audio Thumbnails (1 day)

**Goal**: Generate thumbnails for video and audio files on upload.

**Changes**:
- Detect FFmpeg availability at server startup (try `Bun.spawn(['ffmpeg', '-version'])`)
- Extract video first frame via FFmpeg, pipe to Sharp for WebP thumbnail
- Extract video duration and dimensions via `ffprobe`, store in `details`
- Generate audio waveform peaks (downsample to ~500 values), store as JSON
- Render waveform as SVG -> WebP thumbnail via Sharp
- Create `AudioViewer` with waveform visualization + native `<audio controls>`

**New files**:
- `apps/api/src/lib/preview/video-preview.ts`
- `apps/api/src/lib/preview/audio-preview.ts`
- `packages/ui/src/components/layout/preview-provider/viewers/audio-viewer.tsx`

### Phase 6: Office Document Previews (2-3 days, optional)

**Goal**: Preview DOCX, XLSX, PPTX files.

**Changes**:
- Add `mammoth` for DOCX-to-HTML conversion (client-side, sanitize output)
- Add `xlsx`/SheetJS for XLSX parsing (client-side, first sheet only)
- Custom minimal PPTX text extraction (low priority)
- Create corresponding viewer components

**Note on client-side vs server-side**: These libraries parse the file in the browser. The file is already being
downloaded for preview -- parsing locally avoids doubling the network traffic. However, the file must be fully
downloaded before parsing can begin, which makes this slower for large Office files. Consider a server-side fallback
for files >5MB.

**New files**:
- `packages/ui/src/components/layout/preview-provider/viewers/docx-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/xlsx-viewer.tsx`

### Phase 7: Prefetch and Performance Polish (1 day)

**Goal**: Optimize perceived speed.

**Changes**:
- Prefetch preview data on file select (TanStack Query prefetch)
- Preload viewer component chunks on app startup (for common types: PDF, code)
- Add crossfade animation from thumbnail to full preview (respect `prefers-reduced-motion`)
- Add touch gestures (swipe navigation, pinch zoom)
- Audit bundle sizes, ensure lazy chunks are optimally split
- Add `<link rel="modulepreload">` for frequently used viewer chunks

### Phase 8: Nice-to-Haves (future)

- Font previewer (TTF/OTF/WOFF)
- 3D model viewer (GLB/GLTF via model-viewer)
- Archive contents viewer (ZIP file listing via fflate)
- EXIF data display for photos (camera, GPS, etc.)
- Image comparison mode (before/after for edited images)
- Presentation mode for eigenslides preview (full slideshow)
- `.eigenvector` preview (SVG render from Yjs element data)
- Chart preview for eigensheets/eigendocs containing EigenChart components
- Background preview generation job (catch files uploaded before the preview system existed)
- Service Worker for offline preview caching

---

## Dependencies Summary

### Already Available

| Package | Version | Used In | Preview Use |
|---------|---------|---------|-------------|
| `sharp` | ^0.34.0 | API (`apps/api/src/lib/shared/thumbnails.ts`) | Image/video/PDF thumbnails |
| `lowlight` | ^3.1.0 | Docs app (`apps/docs/package.json`) | Code syntax highlighting |
| `yjs` | ^13.6.27 | API + apps | Eigen doc preview extraction |
| `@tiptap/*` | ^2.11.5 | Docs app | Eigendoc HTML generation |
| `@tanstack/react-hotkeys` | - | FilePreview | Keyboard shortcuts |

### New Dependencies (by phase)

| Package | Size (gzip) | Phase | Purpose |
|---------|-------------|-------|---------|
| `dompurify` | ~15KB | 1 | HTML/SVG/MD sanitization (security-critical) |
| `marked` | ~10KB | 2 | Markdown rendering |
| `papaparse` | ~7KB | 2 | CSV parsing (handles quoting correctly) |
| `pdfjs-dist` | ~200KB | 3 | PDF rendering (core + worker) |
| `@tiptap/html` | ~5KB | 4 | Server-side doc-to-HTML |
| `mammoth` | ~50KB | 6 | DOCX to HTML |
| `xlsx` | ~200KB | 6 | XLSX parsing |
| `@google/model-viewer` | ~150KB | 8 | 3D model preview |

All heavy dependencies (pdfjs-dist, mammoth, xlsx, model-viewer) are lazy-loaded and only downloaded when the user
previews that specific file type.

### External Tools (optional, server-side)

| Tool | Phase | Purpose | Detection |
|------|-------|---------|-----------|
| FFmpeg | 5 | Video thumbnail extraction, metadata | `Bun.spawn(['ffmpeg', '-version'])` at startup |
| LibreOffice | 8 | Office document conversion (future) | Only in Docker deployments |

---

## Key Design Decisions to Make

1. **Space bar behavior**: Should Space toggle preview (like macOS), or should it remain as "select" (current
   behavior where Space/Enter both trigger `onSelect`)? Recommendation: Space toggles preview, Enter opens file.
   This requires separating the Space and Enter cases in `use-keyboard-list-navigation.ts` (currently lines 120-127
   handle both identically).

2. **Preview data endpoint**: Should preview data be served from the existing drive routes or a new `/preview/`
   namespace? Recommendation: Extend the existing drive router in `apps/api/src/routes/drive.ts` with
   `/drive/:ownerId/:mountId/preview/:pathId/data`. This keeps auth/ACL handling consistent and avoids a separate
   router.

3. **Thumbnail storage**: Should generated preview thumbnails share the existing `thumbs/` directory or get a
   separate `previews/` directory? Recommendation: Same `thumbs/` directory with naming convention
   (`{id}.webp` for thumbnail, `{id}.preview.webp` for full preview, `{id}.preview.json` for data,
   `{id}.preview.html` for rendered HTML). Extend `deleteThumbnail()` to clean up all variants.

4. **Eigen doc preview generation timing**: On every Yjs snapshot (automatic, slight CPU cost) or on-demand when
   first requested (lazy, but slower first preview)? Recommendation: On snapshot with async deferral
   (`queueMicrotask`). The CPU cost is small (Yjs state encode + HTML generation takes <50ms for typical docs).
   On-demand as fallback for docs that predate the preview system.

5. **Office document rendering**: Client-side (mammoth/xlsx in browser) or server-side (API returns rendered HTML)?
   Recommendation: Client-side for Phase 6. The files are already being downloaded; parsing them locally avoids
   doubling the network traffic. Server-side fallback for large files (>5MB).

6. **FilePreview component consolidation**: Which copy survives? Recommendation: Keep only
   `packages/ui/src/components/layout/drive/file-preview.tsx` (the packages/ui version). Delete the drive app copy.
   The `PreviewProvider` in packages/ui already imports from the packages/ui path.
