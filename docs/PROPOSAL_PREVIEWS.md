# Proposal: File Preview System for Eigen Drive

## TLDR

Extend Eigen Drive's existing preview overlay to support text, code, markdown, CSV, PDF (via PDF.js), and Eigen native
types. Consolidate the two divergent FilePreview copies, add keyboard navigation (left/right arrows, Space to toggle),
and add progressive loading states. Skip the proposed plugin registry -- a simple `switch`/map is sufficient for the
foreseeable file type count. Defer Office document previews and server-side thumbnail generation for video/PDF/audio
to later phases since they introduce heavy dependencies (FFmpeg, pdfjs-dist server-side, mammoth) for marginal early
value.

---

## Critical Evaluation of Research

The research document is thorough and well-structured, but has several areas of tunnel vision and over-engineering that
this proposal corrects.

### What the Research Gets Right

- **Accurate gap analysis**: The two-copy divergence, missing loading/error states, Space/Enter conflation, and limited
  MIME coverage are all real problems confirmed by reading the code.
- **Two-phase rendering concept**: The idea of showing a cached thumbnail first is sound, since the thumbnail is likely
  already in the browser's HTTP cache from the detail sidebar.
- **Prefetch on select**: Prefetching preview data when a file is selected (before the user presses Space) is a
  practical latency optimization.
- **Server-side text truncation**: Returning only the first 200 lines avoids sending entire files over the wire.
- **Security analysis**: SVG sanitization, DOMPurify for markdown/HTML, and the `<img>` trick for SVG sandboxing are
  all correct.

### Where the Research Shows Tunnel Vision

**1. Registry-based plugin system is over-engineered.**
The research proposes a full `PreviewRenderer` registry with priority ordering, `canHandle` predicates, and extension
points. In practice, Eigen has ~15 file type categories to preview. A simple `Map<string, LazyComponent>` with a
`getRenderer(mimeType, fileName)` function that does pattern matching is clearer, debuggable, and adds no abstraction
cost. The "priority" system solves a problem that does not exist -- there are no overlapping MIME type claims between
viewers that require priority resolution.

**2. Server-side HTML snapshots for eigendoc are premature complexity.**
The research proposes generating HTML snapshots on every Yjs `createSnapshot()` call using `@tiptap/html` +
`yXmlFragmentToProseMirrorJSON()`. Neither of these functions exists in the current codebase (confirmed by grep).
This means adding `@tiptap/html` plus every Tiptap extension used in the docs editor to the API server's dependency
tree. The simpler approach: fetch the raw Yjs state from the existing `/preview/data` endpoint, decode it client-side
in the preview component using the Tiptap extensions already loaded in the frontend bundle, and render read-only.
This avoids duplicating the entire Tiptap extension configuration on the server. The trade-off (slightly slower
first render, ~50-100ms for Yjs decode) is acceptable for a preview.

**3. "Instant" preview is misleading.**
The 0-50ms overlay + 50-100ms thumbnail target is realistic only for images where the thumbnail is already HTTP-cached.
For text/code/CSV files that require a server round-trip, actual latency will be 100-300ms in local deployment and
500-1000ms over a network. The proposal should not promise "instant" -- it should promise "fast enough that the overlay
animation masks the data fetch." This is achievable but different from "instant."

**4. Audio waveform thumbnails are low ROI.**
The research proposes server-side peak computation, SVG rendering, and Sharp conversion for audio waveforms. The
native `<audio controls>` element is sufficient for preview. Waveform visualization is a cosmetic enhancement that can
be added later if users request it.

**5. The two-phase thumbnail-to-full crossfade can feel janky.**
For files where the thumbnail is a low-res 512px WebP and the full preview is a text/code/CSV rendering, the visual
transition is jarring -- going from a blurry image to sharp text. For non-image files, skip the thumbnail phase
entirely and show a loading skeleton instead. Reserve the two-phase approach for images and videos where the thumbnail
is a meaningful preview of the final content.

### Edge Cases the Research Misses

| Case | Risk | Mitigation |
|------|------|------------|
| Very large files (>35MB) | Cannot be uploaded (existing limit), but could exist from earlier imports | Check file size before preview; show "File too large to preview" above 10MB for text-based previews |
| Corrupted files | Sharp/PDF.js/parsers crash on malformed input | Wrap all preview generation in try/catch; show generic error state with download fallback |
| Files with no extension | MIME type from upload is the only signal; `application/octet-stream` is common | Fall back to text preview for any `text/*` or `application/octet-stream` under 1MB |
| Empty files | 0-byte files produce empty previews | Show "Empty file" placeholder instead of blank preview |
| Symlinks | Not relevant -- Eigen uses DB-backed virtual filesystem, no symlinks |  |
| Files in team drives with different permissions | ACL check happens in `getSharedDrive()` before preview data is returned | No additional work needed; the existing auth middleware handles this |
| Concurrent Yjs editing during preview | Preview data could be stale by seconds | Acceptable for preview; show a "Last updated" timestamp |
| Zip bombs / decompression bombs | Not relevant for Phase 1-4 (no archive preview); Sharp already rejects images >12000x12000 | Add file size limits on all server-side preview extraction |
| Malicious fonts | Browser sandboxes font parsing; residual risk is low | Defer font preview to a future phase; not worth the security surface for v1 |
| Memory pressure from many lazy components | React.lazy chunks are small (5-50KB each); only one is loaded at a time | Not a real concern with lazy loading |

### The Real Risk

The biggest risk is not technical -- it is scope. The research lists 6 phases spanning 10-15 days. Phase 1
(consolidation + navigation) and Phase 2 (text-based previews) deliver 80% of the value. Phases 3-6 have diminishing
returns. The proposal below front-loads the high-value work.

---

## Integration Proposal

### Architecture

Keep the existing `PreviewProvider` context pattern. Extend it with:

1. **File list awareness**: The provider needs to know the current folder's file list to support left/right navigation.
2. **Preview state expansion**: Store the full `DrivePath` (not just URL + MIME), which is needed for the preview
   data endpoint and for rendering the header/footer.
3. **Renderer resolution**: A simple `getRenderer()` function that returns the lazy component for a given MIME type.

```
PreviewProvider (context)
  |
  +-- PreviewOverlay (fullscreen modal)
        |
        +-- PreviewHeader (filename, position, nav arrows, close)
        +-- PreviewContent (dispatches to viewer by MIME type)
        |     |
        |     +-- ImageViewer (existing, enhanced with loading state)
        |     +-- VideoViewer (existing, enhanced)
        |     +-- PDFViewer (PDF.js, Phase 3)
        |     +-- TextViewer (plain text with line numbers)
        |     +-- CodeViewer (lowlight syntax highlighting)
        |     +-- MarkdownViewer (rendered HTML, sanitized)
        |     +-- CSVViewer (table via papaparse)
        |     +-- JSONViewer (highlighted + collapsible)
        |     +-- EigenDocViewer (client-side Yjs decode + Tiptap read-only)
        |     +-- EigenSlidesViewer (reuse SlideThumbnail components)
        |     +-- EigenSheetsViewer (simple table)
        |     +-- EigenStickiesViewer (simplified kanban)
        |     +-- EigenChatViewer (last N messages)
        |     +-- FallbackViewer (icon + "No preview available")
        |
        +-- PreviewFooter (Open, Download, Share buttons)
```

### Renderer Resolution

Instead of the research's priority-based registry, use a straightforward lookup:

```typescript
const MIME_VIEWERS: Record<string, () => Promise<{ default: ComponentType<ViewerProps> }>> = {
    'application/pdf': () => import('./viewers/pdf-viewer'),
    'application/eigendoc': () => import('./viewers/eigendoc-viewer'),
    'application/eigenslides': () => import('./viewers/eigenslides-viewer'),
    'application/eigenstickies': () => import('./viewers/eigenstickies-viewer'),
    'application/eigensheets': () => import('./viewers/eigensheets-viewer'),
    'application/eigenchat': () => import('./viewers/eigenchat-viewer'),
    'text/markdown': () => import('./viewers/markdown-viewer'),
    'text/csv': () => import('./viewers/csv-viewer'),
    'application/json': () => import('./viewers/json-viewer'),
};

function getRenderer(mimeType: string, fileName: string) {
    if (MIME_VIEWERS[mimeType]) return lazy(MIME_VIEWERS[mimeType]);
    if (mimeType.startsWith('image/')) return lazy(() => import('./viewers/image-viewer'));
    if (mimeType.startsWith('video/')) return lazy(() => import('./viewers/video-viewer'));
    if (mimeType.startsWith('audio/')) return lazy(() => import('./viewers/audio-viewer'));
    if (mimeType.startsWith('text/') || isCodeExtension(fileName)) return lazy(() => import('./viewers/code-viewer'));
    return null; // No preview available
}
```

This is ~20 lines, fully readable, and trivially extensible.

### API Endpoints

Add two new endpoints to the existing drive router:

```
GET /drive/:ownerId/:mountId/preview/:pathId/data    -> JSON preview payload
GET /drive/:ownerId/:mountId/preview/:pathId/thumb   -> WebP preview thumbnail (future)
```

The `/data` endpoint returns type-specific payloads:

| MIME Type | Response | Server Work |
|-----------|----------|-------------|
| `text/*`, code files | `{ content: string, lineCount: number, language: string }` | Read first 200 lines from file on disk |
| `text/csv` | `{ headers: string[], rows: string[][], totalRows: number }` | Parse first 50 rows server-side |
| `text/markdown` | `{ content: string }` | Read first 100KB (render client-side, not server-side) |
| `application/json` | `{ content: string }` | Read first 100KB |
| `application/eigendoc` | `{ stateData: base64 }` | Read latest Yjs snapshot from data.db |
| `application/eigenslides` | `{ stateData: base64 }` | Read latest Yjs snapshot from data.db |
| `application/eigensheets` | `{ stateData: base64 }` | Read latest Yjs snapshot from data.db |
| `application/eigenstickies` | `{ stateData: base64 }` | Read latest Yjs snapshot from data.db |
| `application/eigenchat` | `{ messages: ChatMessage[], messageCount: number }` | Query last 10 messages from chat's data.db |

Note the key difference from the research: for Eigen native types, return the raw Yjs state rather than pre-rendered
HTML. This avoids needing `@tiptap/html` and all the doc editor extensions on the server. The client already has these
dependencies loaded. Decode and render client-side.

For markdown, return raw markdown content and render client-side with `marked` + `DOMPurify`. Rendering server-side
saves no meaningful time (marked parsing is <5ms) and avoids adding `marked` to the API.

### File Format Support Matrix

| Format | Preview | Thumbnail | Phase | Notes |
|--------|---------|-----------|-------|-------|
| JPEG/PNG/WebP/GIF/BMP | Full image viewer | Existing (Sharp) | 1 | Add loading/error states |
| SVG | Sandboxed `<img>` render | Existing (Sharp rasterize) | 1 | DOMPurify + data URI |
| MP4/WebM | Video player with controls | Not supported (no FFmpeg) | 1 | Enhanced from current |
| MP3/WAV/OGG/FLAC | Audio player | Not supported | 1 | Native `<audio controls>` |
| PDF | PDF.js canvas renderer | Not supported initially | 3 | Replaces iframe |
| Plain text (.txt) | Text with line numbers | Not supported | 2 | First 200 lines |
| Code files (.ts, .py, .rs, etc.) | Syntax highlighted | Not supported | 2 | lowlight, extension-based language detection |
| Markdown (.md) | Rendered HTML (prose styling) | Not supported | 2 | marked + DOMPurify |
| CSV | Table view | Not supported | 2 | papaparse, first 50 rows |
| JSON | Syntax highlighted | Not supported | 2 | lowlight or custom |
| XML/HTML | Syntax highlighted (code viewer) | Not supported | 2 | Treated as code |
| .eigendoc | Read-only Tiptap render | Not supported | 4 | Client-side Yjs decode |
| .eigenslides | First slide render | Not supported | 4 | Reuse SlideThumbnail |
| .eigensheets | Table of cells | Not supported | 4 | Client-side Yjs decode, table render |
| .eigenstickies | Simplified kanban | Not supported | 4 | Client-side Yjs decode |
| .eigenchat | Last 10 messages | Not supported | 4 | Query from SQLite |
| DOCX | **Not supported** | **Not supported** | Future | Requires mammoth (~50KB) |
| XLSX | **Not supported** | **Not supported** | Future | Requires SheetJS (~200KB) |
| PPTX | **Not supported** | **Not supported** | Future | No good browser lib |
| Fonts (TTF/OTF/WOFF) | **Not supported** | **Not supported** | Future | Low priority |
| 3D models | **Not supported** | **Not supported** | Future | Low priority |
| Archives (ZIP/TAR) | **Not supported** | **Not supported** | Future | Security concerns |
| TIFF | **Not supported** (no browser render) | Existing thumbnail via Sharp | - | Thumbnail only |

### Concrete File Changes

#### Phase 1: Overlay Consolidation + Navigation

**Delete:**
- `apps/drive/src/components/drive/file-preview.tsx` (duplicate, use packages/ui version)

**Modify:**
- `packages/ui/src/components/layout/preview-provider/preview-provider.tsx`
  - Store full `DrivePath` in state instead of `{ url, mimeType, aspectRatio }`
  - Add `fileList: DrivePath[]` to context (set by DriveLayout)
  - Add `setFileList()` to context API
  - Add `navigatePreview(direction: 'prev' | 'next')` method
  - Add ArrowLeft/ArrowRight hotkeys when preview is open
  - Replace `isPreviewable()` with `getRenderer()` check (supports all new types)
- `packages/ui/src/components/layout/drive/file-preview.tsx`
  - Redesign as `PreviewOverlay` with header (filename, position, close), content area, footer (Open, Download)
  - Add loading state (skeleton), error state (icon + message)
  - Add `role="dialog"`, `aria-label`, focus trap
  - Dispatch to viewer components by MIME type
- `packages/ui/src/hooks/use-keyboard-list-navigation.ts`
  - Separate Space (toggle preview) from Enter (open/activate file)
  - Space: call new `onPreview?(id)` callback
  - Enter: call existing `onSelect(id)`
- `packages/ui/src/components/layout/drive/drive-layout.tsx`
  - Pass `folderContents` to preview provider via `setFileList()`
- `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`
  - Wire up `onPreview` handler for Space key
  - Remove import of deleted file-preview.tsx from drive app

**New:**
- `packages/ui/src/components/layout/preview-provider/get-renderer.ts` (MIME-to-viewer mapping)
- `packages/ui/src/components/layout/preview-provider/viewers/fallback-viewer.tsx`

#### Phase 2: Text-Based Previews

**New frontend files:**
- `packages/ui/src/components/layout/preview-provider/viewers/text-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/code-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/markdown-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/csv-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/json-viewer.tsx`

**New backend files:**
- `apps/api/src/lib/preview/text-preview.ts` (read first N lines, detect language)

**Modify:**
- `apps/api/src/routes/drive.ts` -- add `GET /drive/:ownerId/:mountId/preview/:pathId/data`
- `packages/lib/src/core/drive/hooks/` -- add `usePreviewData(ownerId, mountId, pathId, mimeType)` hook

**New dependencies (frontend):**
- `marked` (~10KB gzipped) for markdown rendering
- `papaparse` (~7KB gzipped) for CSV parsing
- Note: `lowlight` is already available via docs app; may need to be moved to packages/lib or packages/ui

**New dependencies (backend):**
- None. Text reading, CSV truncation, and language detection are trivial with built-in APIs.

#### Phase 3: PDF.js Integration

**New:**
- `packages/ui/src/components/layout/preview-provider/viewers/pdf-viewer.tsx`

**New dependencies:**
- `pdfjs-dist` (~200KB gzipped, frontend only)

**Modify:**
- Build config to handle PDF.js worker file as a separate asset

#### Phase 4: Eigen Native Type Previews

**New frontend files:**
- `packages/ui/src/components/layout/preview-provider/viewers/eigendoc-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/eigenslides-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/eigensheets-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/eigenstickies-viewer.tsx`
- `packages/ui/src/components/layout/preview-provider/viewers/eigenchat-viewer.tsx`

**New backend files:**
- `apps/api/src/lib/preview/eigen-preview.ts` (Yjs snapshot extraction for all collab types, chat message query)

**Modify:**
- `apps/api/src/routes/drive.ts` -- extend preview endpoint for Eigen types
- `apps/api/src/lib/shared/thumbnails.ts` -- extend `deleteThumbnail()` to clean `.preview.*` files

**Key decision**: Decode Yjs state client-side. The eigendoc viewer imports Tiptap extensions from `apps/docs`
(or from a shared location if they have been extracted). The eigenslides viewer imports `SlideThumbnail` /
`ReadOnlySlideObject` from `apps/slides`. These cross-app imports may require moving shared rendering components
to `packages/ui` or `packages/lib`.

### Caching Strategy

**Layer 1 -- HTTP Cache (browser):**
- Thumbnails: `Cache-Control: public, max-age=86400` (already implemented)
- Preview data: `Cache-Control: public, max-age=3600` with `ETag` based on `path.updatedAt`
- Static files (embed): `Cache-Control: public, max-age=86400` (already implemented)

**Layer 2 -- TanStack Query Cache (in-memory):**
- Preview data: `staleTime: 60_000` (60s), `gcTime: 300_000` (5min)
- Prefetch on file select (existing `onRowSelect` handler), so data is ready when Space is pressed
- Query key pattern: `['drive', 'preview', ownerId, mountId, pathId]`

**Layer 3 -- Server Disk Cache (thumbs/ directory):**
- For Phase 4 Eigen types: optionally cache the Yjs-extracted preview data as `.preview.json` in the thumbs directory,
  invalidated on `updatedAt` change. This is an optimization, not a requirement -- the Yjs snapshot read is fast
  enough (<50ms) to serve live on each request.

**No Service Worker cache.** Adding a service worker is a separate architectural decision with implications for auth
token refresh, cache invalidation, and offline behavior. Not in scope for preview.

### Performance Budget

| Metric | Target | Measurement |
|--------|--------|-------------|
| Overlay appears (backdrop + container) | <50ms | CSS animation, no data dependency |
| Thumbnail visible (for image files) | <100ms | Already HTTP-cached from detail sidebar |
| Text/code preview visible | <300ms | Server reads first 200 lines + network |
| Markdown/CSV preview visible | <400ms | Server reads + client parses/renders |
| Eigen doc preview visible | <500ms | Server reads Yjs snapshot + client decodes + Tiptap render |
| PDF first page visible | <1000ms | PDF.js loads + parses + renders first page |
| Arrow key navigation (next file) | <200ms | If prefetched; <500ms cold |
| Total JS bundle increase (Phase 1-2) | <30KB gzipped | marked + papaparse + viewer components |
| Total JS bundle increase (Phase 3) | <200KB gzipped | pdfjs-dist (loaded lazily) |

These are targets for local-network deployment. Over WAN, add 100-500ms for each server round-trip.

### Testing Strategy

**Unit tests (Bun test runner, existing pattern in `apps/api/src/tests/`):**
- Preview data endpoint: verify correct response shape for each MIME type
- Text truncation: verify 200-line limit, handles files with <200 lines, handles empty files
- CSV truncation: verify 50-row limit, handles malformed CSV gracefully
- Eigen type preview extraction: verify Yjs snapshot decode produces valid preview data
- Language detection: verify extension-to-language mapping for code files
- Size limits: verify large files are rejected with appropriate error

**Integration tests:**
- Preview endpoint respects ACL (user without read access gets 401/403)
- Preview endpoint works for team drives (owner ID with `team_` prefix)
- Preview data is invalidated when file is re-uploaded (updatedAt changes)

**Manual testing checklist:**
- Space toggles preview open/close
- ArrowLeft/ArrowRight navigate between files in preview
- Escape closes preview and returns focus to file list
- Preview works for each supported MIME type
- Loading skeleton shows for slow-loading previews
- Error state shows for corrupted/unparseable files
- Empty files show "Empty file" message
- Files >10MB show "File too large to preview" for text-based types
- Preview works in chat attachment context (AttachmentChip in chat-message-list.tsx)
- Mobile: full-screen preview with swipe navigation (future)

### Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Cross-app imports for Eigen type viewers break build | High | Medium | Move shared rendering components (SlideThumbnail, ReadOnlySlideObject) to packages/ui before Phase 4 |
| lowlight is only in apps/docs, not shared | Medium | Low | Move lowlight to packages/ui as a shared dependency, or lazy-load from docs chunk |
| PDF.js worker file configuration with Bun bundler | Medium | Medium | Test early; may need custom build config for worker file |
| Yjs client-side decode is slow for large documents | Low | Medium | Set a 1MB limit on Yjs state size for preview; show fallback for very large docs |
| DOMPurify is only in API (isomorphic-dompurify), not in frontend | Medium | Low | Add `dompurify` (browser version) to packages/ui dependencies |
| Space key conflicts with other UI contexts (e.g., text input, modal open) | Medium | Medium | Only bind Space for preview when the file list container has focus and no modal is open |
| Preview data endpoint adds load to API server | Low | Low | Server-side work is minimal (file read, no heavy processing); add rate limiting if needed |

### Phases

#### Phase 1: Overlay Consolidation + Navigation (2-3 days)
- Consolidate FilePreview copies
- Add header/footer to overlay
- Add ArrowLeft/ArrowRight navigation
- Separate Space (preview) from Enter (open) in keyboard navigation
- Add loading skeleton, error state, empty state
- Add focus trapping, ARIA attributes
- Enhance existing image/video/PDF viewers with loading states

**Deliverable**: A proper Quick Look overlay that works for all currently supported types (image, video, PDF) with
keyboard navigation between files.

#### Phase 2: Text-Based Previews (2-3 days)
- Add preview data API endpoint
- Implement TextViewer, CodeViewer, MarkdownViewer, CSVViewer, JSONViewer
- Add `usePreviewData` hook with prefetch-on-select
- Add `marked`, `papaparse` dependencies
- Add language detection for code files

**Deliverable**: Preview support for text, code, markdown, CSV, JSON files. This covers the majority of developer
files and common document formats.

#### Phase 3: PDF.js Integration (1-2 days)
- Replace iframe with PDF.js canvas renderer
- Add page navigation, zoom
- Configure PDF worker build

**Deliverable**: Proper PDF preview with page navigation and consistent cross-browser behavior.

#### Phase 4: Eigen Native Type Previews (3-5 days)
- Add Yjs snapshot extraction endpoint for collab types
- Add chat message query endpoint
- Implement viewers for eigendoc, eigenslides, eigensheets, eigenstickies, eigenchat
- Move shared rendering components to packages/ui as needed
- Extend `deleteThumbnail()` to clean preview artifacts

**Deliverable**: Preview support for all Eigen native document types without opening the full editor.

#### Phase 5 (Future): Enhanced Thumbnails + Office Docs
- FFmpeg-based video thumbnails (optional, if FFmpeg is available)
- Server-side PDF first-page thumbnails
- DOCX preview via mammoth
- XLSX preview via SheetJS

This phase is intentionally deferred. It adds significant dependency weight and operational complexity (FFmpeg
availability, LibreOffice for PPTX) for formats that are less common in a self-hosted workspace.
