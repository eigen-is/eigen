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
- Tmp-dir caching means **subsequent opens are instant** (same `tmpDir` infrastructure used by collab temp files)
- The overlay component stays in `packages/ui` with no heavy dependencies

### Route Structure

Four routes handle all file delivery. Their semantics must be kept distinct:

| Route                     | Content                                                                                                                | Use case                                                                                                             |
|---------------------------|------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------|
| `GET .../download`        | Original file, `Content-Disposition: attachment`                                                                       | User hits "Download"                                                                                                 |
| `GET .../embed/:fileName` | Original file, `Content-Disposition: inline`                                                                           | Video/audio playback, PDF iframe, server-side export (Puppeteer needs original image quality for PDF/DOCX rendering) |
| `GET .../preview`         | **Screen-res WebP** for images; **styled HTML** for text/code/markdown/eigendoc; redirect to embed for video/audio/PDF | All UI display contexts: preview overlay, docs editor images, slides viewer images                                   |
| `GET .../thumb/:fileName` | 512px WebP (existing, unchanged)                                                                                       | Drive file list row icons                                                                                            |

`getDriveEmbedUrl` is **not replaced** — it stays as the URL for video/audio players and as the image URL for
server-side export. `getDrivePreviewUrl` is used for all client-side image display.

### New API Endpoint

```
GET /drive/:ownerId/:mountId/file/:pathId/preview
```

Response behaviour by file type:

| Type                             | Response                           | Cache                                              |
|----------------------------------|------------------------------------|----------------------------------------------------|
| `image/*`                        | Screen-res WebP (max 2560px)       | `tmpDir/previews/{pathId}-{updatedAt}.screen.webp` |
| `video/*`                        | 302 redirect to `/embed/:fileName` | —                                                  |
| `audio/*`                        | 302 redirect to `/embed/:fileName` | —                                                  |
| `application/pdf`                | 302 redirect to `/embed/:fileName` | —                                                  |
| `text/markdown`, `.md`           | Full HTML document                 | `tmpDir/previews/{pathId}-{updatedAt}.html`        |
| `text/*`, code extensions        | Full HTML document                 | `tmpDir/previews/{pathId}-{updatedAt}.html`        |
| `application/eigendoc` (Phase 4) | Full HTML document                 | `tmpDir/previews/{pathId}-{updatedAt}.html`        |
| everything else                  | 404                                | —                                                  |

### Cache Strategy

**Everything goes in `mount.tmpDir/previews/`** — both images and HTML. Uniform location, uniform cleanup.

Cache key: `{pathId}-{updatedAt}.{ext}` where ext is `screen.webp` or `html`.

- `updatedAt` in the filename = auto-invalidation. If the source file is updated, `updatedAt` changes, new cache key,
  old file stays until cleanup.
- Cache hit: file with exact `{pathId}-{updatedAt}.*` pattern exists → serve directly, no regeneration.
- Cache miss: generate, write, serve.
- **No mtime comparison needed** — the cache key carries its own validity.

`mount.thumbsDir` is unchanged: 512px thumbnails only.

**Cleanup** (run once at `mount.init()`):

- Scan `tmpDir/previews/`, delete any file older than 7 days
- No separate timer needed — Homes re-init frequently enough (timeout after 5 min idle)

### New URL Helpers

Add to `packages/lib/src/core/api.ts`:

```typescript
export const getDrivePreviewUrl = (ownerId: string, mountId: string, pathId: string) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/preview`;
```

### Frontend Overlay (simplified)

```
PreviewOverlay (fixed, z-[100])
  PreviewHeader  — filename, ← → nav, close button
  PreviewContent — dispatch by previewMode
    image:   <img src={previewUrl}>               ← screen-res WebP
    video:   <video src={embedUrl} controls>
    audio:   <audio src={embedUrl} controls>
    pdf:     <iframe src={embedUrl}>
    html:    <iframe src={previewUrl} sandbox="allow-same-origin allow-scripts">
    fallback: file icon + "No preview available" + Download button
  PreviewFooter  — Open, Download buttons
```

`previewMode` is determined client-side from `DrivePath.mimeType` and `DrivePath.name` — no extra API call needed.

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

## Impact on Other Apps

The `/preview` endpoint and `getDrivePreviewUrl` touch several places outside the preview overlay.

### `MediaResolver` (docs + slides editor, in-editor images)

`packages/lib/src/core/drive/media-resolver.tsx` currently calls `getDriveEmbedUrl` for `resolveMediaUrl`. This means
every image embedded in a doc or slide loads at **original resolution** — wasteful for screen display.

**Fix (Phase 2):** Switch `resolveMediaUrl` to `getDrivePreviewUrl`. Server returns screen-res WebP. The Tiptap `<img>`
node and slide image renderer both use `resolveMediaUrl`, so this change propagates everywhere automatically.

**Server-side export is unaffected:** The export pipeline (Puppeteer for PDF, mammoth for DOCX) runs on the server and
reads images directly from storage — it does not call `resolveMediaUrl`. Export-quality code paths must explicitly use
original content via storage read or `/embed` URL when constructing HTML for Puppeteer.

### Chat attachment display

Chat message image attachments already use `getDriveEmbedUrl` (via `AttachmentChip` and inline message images). Switch
to `getDrivePreviewUrl` in Phase 2. The chat app will automatically get WebP + screen-res images with no other changes.

### Apps that are NOT affected

- **File download** — always uses `/download`, no change
- **Video/audio playback** — uses `/embed`, no change (browser media player needs original; WebP conversion would break)
- **PDF display** — uses `/embed` iframe, no change
- **Thumbnails in drive file list** — uses `/thumb/:fileName`, no change (512px thumbnails are separate)

### Summary of URL usage by context

| Context                           | URL                                          | Reason                      |
|-----------------------------------|----------------------------------------------|-----------------------------|
| Preview overlay — image           | `/preview`                                   | Screen-res WebP             |
| Preview overlay — text/code/md    | `/preview`                                   | HTML response               |
| Preview overlay — video/audio/PDF | `/embed`                                     | Native player/renderer      |
| Docs editor — embedded images     | `/preview` → switch from `/embed` in Phase 2 | Screen-res display          |
| Slides viewer — images            | `/preview` → switch from `/embed` in Phase 2 | Screen-res display          |
| Chat — inline images              | `/preview` → switch from `/embed` in Phase 2 | Screen-res display          |
| Server-side export (Puppeteer)    | Storage read or `/embed`                     | Original quality for print  |
| Drive file list row               | `/thumb/:fileName`                           | 512px thumbnail             |
| User downloads                    | `/download`                                  | Original, attachment header |

---

## Alignment with Import/Export (PROPOSAL_DOC_IMPORT_EXPORT.md)

The server-side HTML generation is shared infrastructure:

| Piece                                            | Preview uses it                       | Import/Export uses it                       |
|--------------------------------------------------|---------------------------------------|---------------------------------------------|
| `markdown-it` → HTML                             | Phase 2 markdown preview              | Phase 3 markdown import (HTML→PM JSON step) |
| `lowlight` syntax highlight → HTML               | Phase 2 code preview                  | Already planned as API dep for export       |
| Tiptap `generateHTML()` + `server-extensions.ts` | Phase 4 eigendoc preview              | Phase 2 eigendoc → HTML export              |
| `apps/api/src/lib/preview/html-template.ts`      | Styled HTML wrapper for preview       | Styled HTML wrapper for HTML export         |
| `mount.tmpDir/previews/` + `generateThumbnail()` | Screen-res image + HTML preview cache | —                                           |

The single most important shared file: `apps/api/src/lib/preview/html-template.ts` — a function that wraps any HTML body in a full document with embedded CSS (prose typography, code highlighting, dark mode via `prefers-color-scheme`). Both preview and HTML export call this.

---

## Phases

### Phase 1 — Overlay Redesign + Navigation

**Goal:** Better overlay chrome — header with filename, footer with Open/Download, left/right nav. No new content types yet.

| File                                                                      | Change                                                                                                      |
|---------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| `packages/lib/src/core/api.ts`                                            | Add `getDrivePreviewUrl()`                                                                                  |
| `packages/ui/src/components/layout/preview-provider/preview-provider.tsx` | Store `DrivePath` + `siblings[]`, expose nav; pass `previewUrl` and `embedUrl` to overlay                   |
| `packages/ui/src/components/layout/drive/file-preview.tsx`                | Add `PreviewHeader` (name, ← →, ✕), `PreviewFooter` (Open, Download); keep existing image/video/PDF viewers |
| `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`            | Pass `folderContents` as `siblings` to `openPreview()`                                                      |

**Keyboard:** Escape = close, ArrowLeft/ArrowRight = prev/next sibling.

### Phase 2 — Screen-Res Image Preview + HTML Previews for Text/Code/Markdown

**Goal:** Images load at display resolution (not 35MB raw), text/code/markdown render as styled HTML.

#### API changes

| File                                        | Change                                                                                                                                               |
|---------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| `apps/api/src/lib/preview/preview-cache.ts` | **New.** `getScreenPreview(mount, path)` → Buffer (image) or string (HTML). Fetches `DrivePath` for `updatedAt` (cache key), dispatches by mimeType. |
| `apps/api/src/lib/preview/image-preview.ts` | **New.** Wraps `generateThumbnail()` with `maxSize: 2560`. Cache key: `{pathId}-{updatedAt}.screen.webp` in `previewsDir`.                           |
| `apps/api/src/lib/preview/html-template.ts` | **New.** `wrapHtml(body: string, title: string): string` — full HTML doc with inline CSS (prose + code highlight + dark mode).                       |
| `apps/api/src/lib/preview/text-preview.ts`  | **New.** `generateTextPreview(content, mimeType, fileName)` → HTML body. markdown-it for `.md`, lowlight for code, `<pre>` for plain text.           |
| `apps/api/src/routes/drive.ts`              | Add `GET .../file/:pathId/preview` route. Auth-guarded. Calls `drive.getPreview()`.                                                                  |
| `apps/api/src/lib/drive/drive.ts`           | Add `getPreview(mountId, pathId)` method (delegates to preview-cache)                                                                                |
| `apps/api/src/lib/mount/mount.ts`           | Add `previewsDir` getter (`tmpDir/previews`), init dir + cleanup in `init()`                                                                         |

#### Frontend changes

| File                                                                      | Change                                                                                                                                   |
|---------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `packages/ui/src/components/layout/drive/file-preview.tsx`                | Add `html` viewer: `<iframe src={previewUrl} sandbox="allow-same-origin allow-scripts" className="w-full h-full border-0">`              |
| `packages/ui/src/components/layout/preview-provider/preview-provider.tsx` | Extend `canPreview()` to include text/code/markdown types (reuse extension list from `getEditMode()` in `apps/api/src/routes/editor.ts`) |
| `packages/lib/src/core/drive/media-resolver.tsx`                          | Switch `resolveMediaUrl` from `getDriveEmbedUrl` to `getDrivePreviewUrl` — propagates to docs editor + slides viewer                     |

---

### Phase 3 — Audio + CSV

**Goal:** Audio with native player. CSV as a scrollable table (generated server-side to keep the frontend clean).

| File                                                       | Change                                                                                                                     |
|------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| `apps/api/src/lib/preview/text-preview.ts`                 | Extend to handle `text/csv` — parse with a lightweight server-side CSV parser, render HTML table (max 500 rows × 50 cols). |
| `apps/api/src/routes/drive.ts`                             | Add audio/CSV to preview endpoint dispatch                                                                                 |
| `packages/ui/src/components/layout/drive/file-preview.tsx` | Add `audio` viewer: `<audio controls src={embedUrl} className="w-full">`                                                   |

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

| File                                                                      | Change                                                                                            |
|---------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| `packages/lib/src/core/api.ts`                                            | Add `getDrivePreviewUrl()`                                                                        |
| `packages/ui/src/components/layout/preview-provider/preview-provider.tsx` | Store `DrivePath` + siblings, change `openPreview` signature, dispatch `previewUrl` vs `embedUrl` |
| `packages/ui/src/components/layout/drive/file-preview.tsx`                | Add header/footer/nav, add `html`+`audio` viewer cases                                            |
| `packages/lib/src/core/drive/media-resolver.tsx`                          | Switch `resolveMediaUrl` from `getDriveEmbedUrl` to `getDrivePreviewUrl`                          |
| `apps/api/src/routes/drive.ts`                                            | Add `GET .../file/:pathId/preview` route                                                          |
| `apps/api/src/lib/drive/drive.ts`                                         | Add `getPreview(mountId, pathId)` method (delegates to preview-cache)                             |
| `apps/api/src/lib/mount/mount.ts`                                         | Add `previewsDir` getter (`tmpDir/previews`), init dir + cleanup in `init()`                      |
| `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`            | Pass `folderContents` as `siblings` to `openPreview()`                                            |

### New (Phase 2)

| File                                        | Purpose                                     |
|---------------------------------------------|---------------------------------------------|
| `apps/api/src/lib/preview/preview-cache.ts` | Orchestration: check cache, generate, serve |
| `apps/api/src/lib/preview/image-preview.ts` | Screen-res WebP generation + cache check    |
| `apps/api/src/lib/preview/html-template.ts` | Styled HTML wrapper for preview             |
| `apps/api/src/lib/preview/text-preview.ts`  | markdown-it + lowlight → HTML body          |

### New (Phase 4)

| File | Purpose |
|------|---------|
| `apps/api/src/lib/preview/eigendoc-preview.ts` | Y.Doc → HTML (delegates to eigendoc HTML export function) |
| `packages/lib/src/core/docs/server-extensions.ts` | Shared Tiptap extension registry (also used by export) |
