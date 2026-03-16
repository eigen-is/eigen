# Plan: File Preview System

Based on PROPOSAL_PREVIEWS.md and PROPOSAL_DOC_IMPORT_EXPORT.md, cross-referenced against the actual codebase.

---

## Completed

| Change | Status |
|--------|--------|
| `packages/ui/.../file-preview.tsx` `z-50` → `z-[100]` | ✅ Done |
| `apps/drive/src/components/drive/file-preview.tsx` | ✅ Deleted (was orphaned) |
| `_auth.shared.$to.tsx` + `_auth.mime.$mimeType.tsx` | ✅ Migrated to `usePreview()` |

---

## Architecture: Server-Side Preview with Tmp Cache

### Core Idea

The preview overlay should be **as dumb as possible on the frontend**. Instead of shipping CodeMirror, Tiptap, CSV parsers etc. into the UI bundle, the API generates the preview content server-side and serves it via a single new endpoint. The frontend renders the result with `<img>`, `<iframe>`, `<video>`, or `<audio>`.

This is the right approach because:
- Preview works from **any app** (chat, calendar) without bundling editor deps
- The **same HTML generation pipeline** serves both preview and export-to-HTML/DOCX/PDF (see PROPOSAL_DOC_IMPORT_EXPORT.md)
- Tmp-dir caching means **subsequent opens are instant** (same infrastructure as existing `thumbsDir`)
- The overlay component stays in `packages/ui` with no heavy dependencies

### New API Endpoint

```
GET /drive/:ownerId/:mountId/file/:pathId/preview
```

Response behaviour by file type:

| Type | Response | Cache location |
|------|----------|---------------|
| `image/*` | Screen-res WebP (max 2560px, Sharp resize) | `mount.thumbsDir/{pathId}.screen.webp` |
| `video/*` | Redirect to embed URL (passthrough) | — |
| `audio/*` | Redirect to embed URL (passthrough) | — |
| `application/pdf` | Redirect to embed URL (passthrough) | — |
| `text/markdown`, `.md` | Full HTML document (markdown-it → styled template) | `mount.tmpDir/previews/{pathId}-{updatedAt}.html` |
| `text/*`, code extensions | Full HTML document (lowlight syntax-highlight → styled template) | `mount.tmpDir/previews/{pathId}-{updatedAt}.html` |
| `application/eigendoc` (Phase 4) | Full HTML document (Y.Doc → Tiptap `generateHTML()` → styled template) | `mount.tmpDir/previews/{pathId}-{updatedAt}.html` |
| everything else | 404 (fallback viewer shows download button) | — |

### Cache Strategy

**Images** (`thumbsDir/{pathId}.screen.webp`):
- Same directory as existing 512px thumbnails
- Cache miss: generate with Sharp at `maxSize: 2560`, save, serve
- Invalidation: check `{pathId}.screen.webp` file mtime vs source file `updatedAt`. If source is newer, regenerate.
- Reuses existing `generateThumbnail()` from `apps/api/src/lib/shared/thumbnails.ts` with larger `maxSize`

**HTML previews** (`tmpDir/previews/{pathId}-{updatedAt}.html`):
- `updatedAt` encoded as epoch ms in filename — old revisions stay until cleanup
- Cache miss: generate HTML, write file, serve
- Cache hit: file with matching `{pathId}-{updatedAt}` exists → serve directly
- Old revisions auto-expire via cleanup

**Cleanup** (run at mount init + every 24h):
- Scan `tmpDir/previews/`
- Delete any `.html` file older than 7 days
- When regenerating an image preview, delete the old `{pathId}.screen.webp` before writing (handled by the preview route)

### New URL Helper

Add to `packages/lib/src/core/api.ts` alongside existing helpers:

```typescript
export const getDrivePreviewUrl = (ownerId: string, mountId: string, pathId: string) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/preview`;
```

The existing `getDriveEmbedUrl` stays for video/audio playback and image `src` in documents (where the original resolution is appropriate). `getDrivePreviewUrl` is used exclusively by the preview overlay.

### Frontend Overlay (simplified)

```
PreviewOverlay (fixed, z-[100])
  PreviewHeader  — filename, ← → nav, close button
  PreviewContent — dispatch by previewMode
    image:   <img src={previewUrl}>            (screen-res WebP from preview endpoint)
    video:   <video src={embedUrl} controls>
    audio:   <audio src={embedUrl} controls>
    pdf:     <iframe src={embedUrl}>
    html:    <iframe src={previewUrl} sandbox="allow-same-origin allow-scripts">
    fallback: file icon + "No preview available" + Download button
  PreviewFooter  — Open, Download buttons
```

The `previewMode` is determined client-side from `DrivePath.mimeType` and `DrivePath.name` — no new API call needed to decide which viewer to show.

### PreviewProvider Changes

Store `DrivePath` (not just `{url, mimeType}`) and add folder-sibling list for navigation:

```typescript
type PreviewState = {
    path: DrivePath;
    siblings: DrivePath[];  // for ← → navigation; pass [] if unknown
}

// openPreview API change:
openPreview: (path: DrivePath, siblings?: DrivePath[]) => void
```

`canPreview()` is extended to include text/code types (any file the new preview endpoint handles). Logic mirrors `getEditMode()` from `editor.ts`.

---

## Alignment with Import/Export (PROPOSAL_DOC_IMPORT_EXPORT.md)

The server-side HTML generation is shared infrastructure:

| Piece | Preview uses it | Import/Export uses it |
|---|---|---|
| `markdown-it` → HTML | Phase 2 markdown preview | Phase 3 markdown import (HTML→PM JSON step) |
| `lowlight` syntax highlight → HTML | Phase 2 code preview | Already planned as API dep for export |
| Tiptap `generateHTML()` + `server-extensions.ts` | Phase 4 eigendoc preview | Phase 2 eigendoc → HTML export |
| `apps/api/src/lib/preview/html-template.ts` | Styled HTML wrapper for preview | Styled HTML wrapper for HTML export |
| `mount.thumbsDir` + `generateThumbnail()` | Screen-res image preview | — |
| `mount.tmpDir/previews/` | HTML preview cache | — |

The single most important shared file: `apps/api/src/lib/preview/html-template.ts` — a function that wraps any HTML body in a full document with embedded CSS (prose typography, code highlighting, dark mode via `prefers-color-scheme`). Both preview and HTML export call this.

---

## Phases

### Phase 1 — Overlay Redesign + Navigation

**Goal:** Better overlay chrome — header with filename, footer with Open/Download, left/right nav. No new content types yet.

| File | Change |
|------|--------|
| `packages/lib/src/core/api.ts` | Add `getDrivePreviewUrl()` |
| `packages/ui/.../preview-provider.tsx` | Store `DrivePath` + `siblings[]`, expose nav; pass `previewUrl` and `embedUrl` to overlay |
| `packages/ui/.../file-preview.tsx` | Add `PreviewHeader` (name, ← →, ✕), `PreviewFooter` (Open, Download); keep existing image/video/PDF viewers |
| `apps/drive/src/routes/_auth.fs.$ownerId.*` | Pass `folderContents` as `siblings` to `openPreview()` |

**Keyboard:** Escape = close, ArrowLeft/ArrowRight = prev/next sibling.

### Phase 2 — Screen-Res Image Preview + HTML Previews for Text/Code/Markdown

**Goal:** Images load at display resolution (not 35MB raw), text/code/markdown render as styled HTML.

#### API changes

| File | Change |
|------|--------|
| `apps/api/src/lib/preview/preview-cache.ts` | **New.** `getScreenPreview(mount, path)` → Buffer (image) or string (HTML). Handles both cache types. |
| `apps/api/src/lib/preview/image-preview.ts` | **New.** Wraps `generateThumbnail()` with `maxSize: 2560`. Checks/updates `{pathId}.screen.webp` in thumbsDir. |
| `apps/api/src/lib/preview/html-template.ts` | **New.** `wrapHtml(body: string, title: string): string` — full HTML doc with inline CSS (prose + code highlight + dark mode). |
| `apps/api/src/lib/preview/text-preview.ts` | **New.** `generateTextPreview(content, mimeType, fileName)` → HTML body. markdown-it for `.md`, lowlight for code, `<pre>` for plain text. |
| `apps/api/src/routes/drive.ts` | Add `GET .../file/:pathId/preview` route. Auth-guarded. Calls `preview-cache.ts`. |
| `apps/api/src/lib/drive/drive.ts` | Add `getPreview(mountId, pathId)` method (delegates to preview-cache) |
| `apps/api/src/lib/mount/mount.ts` | Add `previewsDir` getter (`tmpDir/previews`), init dir in `init()`, add cleanup method |
| `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx` | Pass `folderContents` as siblings to `openPreview()` |

#### Frontend changes

| File | Change |
|------|--------|
| `packages/ui/.../file-preview.tsx` | Add `html` viewer: `<iframe src={previewUrl} sandbox="allow-same-origin allow-scripts" className="w-full h-full border-0">` |
| `packages/ui/.../preview-provider.tsx` | Extend `canPreview()` to include text/code/markdown types |

---

### Phase 3 — Audio + CSV

**Goal:** Audio with native player. CSV as a scrollable table (generated server-side to keep the frontend clean).

| File | Change |
|------|--------|
| `apps/api/src/lib/preview/text-preview.ts` | Extend to handle `text/csv` — parse with a lightweight server-side CSV parser, render HTML table (max 500 rows × 50 cols). |
| `apps/api/src/routes/drive.ts` | Add audio/CSV to preview endpoint dispatch |
| `packages/ui/.../file-preview.tsx` | Add `audio` viewer: `<audio controls src={embedUrl} className="w-full">` |

---

### Phase 4 — Eigen Native Types (eigendoc, eigenslides, eigensheets, eigenstickies)

**Goal:** Preview Eigen native files without opening them. Shares heavy infrastructure with import/export Phase 2.

| Type | Server approach | Prerequisite |
|------|----------------|--------------|
| eigendoc | Load Y.Doc (same as `DbProvider.loadState()`), `yDocToProsemirrorJSON()`, `generateHTML(json, serverExtensions)`, cache as HTML | `packages/lib/src/core/docs/server-extensions.ts` from import/export Phase 2; `y-prosemirror` in API |
| eigenslides | Load slides JSON, render each slide as styled HTML div | None |
| eigensheets | Load sheet JSON, render as HTML table | None |
| eigenstickies | Load stickies JSON, render simplified kanban columns as HTML | None |

eigendoc preview HTML generation is **identical** to eigendoc HTML export (PROPOSAL_DOC_IMPORT_EXPORT.md Phase 2). Build export first, then the preview endpoint calls the same function and caches the result.

---

### Phase 5 — Deferred

- Video thumbnail frames (FFmpeg dependency)
- DOCX/XLSX/PPTX preview (requires mammoth + server-side XLSX parser)
- ZIP file listing
- Audio waveform

---

## Complete File Inventory

### Existing (modified)

| File | Change |
|------|--------|
| `packages/lib/src/core/api.ts` | Add `getDrivePreviewUrl()` |
| `packages/ui/src/components/layout/preview-provider/preview-provider.tsx` | Store `DrivePath` + siblings, change `openPreview` signature, use `getDrivePreviewUrl` |
| `packages/ui/src/components/layout/drive/file-preview.tsx` | Add header/footer/nav, add `html`+`audio` viewer cases |
| `apps/api/src/routes/drive.ts` | Add `GET .../file/:pathId/preview` route |
| `apps/api/src/lib/drive/drive.ts` | Add `getPreview(mountId, pathId)` method (delegates to preview-cache) |
| `apps/api/src/lib/mount/mount.ts` | Add `previewsDir` getter (`tmpDir/previews`), init dir in `init()`, add cleanup method |
| `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx` | Pass `folderContents` as siblings to `openPreview()` |

### New (Phase 2)

| File | Purpose |
|------|---------|
| `apps/api/src/lib/preview/preview-cache.ts` | Orchestration: check cache, generate, serve |
| `apps/api/src/lib/preview/image-preview.ts` | Screen-res WebP generation + cache check |
| `apps/api/src/lib/preview/html-template.ts` | Styled HTML wrapper for preview |
| `apps/api/src/lib/preview/text-preview.ts` | markdown-it + lowlight → HTML body |

### New (Phase 4)

| File | Purpose |
|------|---------|
| `apps/api/src/lib/preview/eigendoc-preview.ts` | Y.Doc → HTML (delegates to eigendoc HTML export function) |
| `packages/lib/src/core/docs/server-extensions.ts` | Shared Tiptap extension registry (also used by export) |
