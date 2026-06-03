# File Preview System

> **TLDR**: Server-side preview generation with tmp-dir cache. Images served as screen-res WebP (max 2560px), text/code/markdown
> and eigen-native files (eigendoc/slides/sheets, a compact HTML slice) as JSON body snippets rendered client-side with shared
> `eigen-prose` styles. Video/audio/PDF redirect to embed URL for native playback. Preview overlay in `packages/ui` with keyboard
> nav and sibling browsing.

## Route Structure

| Route                     | Content                                                        | Use case                        |
|---------------------------|----------------------------------------------------------------|---------------------------------|
| `GET .../download`        | Original file, `Content-Disposition: attachment`               | User hits "Download"            |
| `GET .../embed/:fileName` | Original file, `Content-Disposition: inline`                   | Video/audio playback, PDF iframe, server-side export |
| `GET .../preview`         | Screen-res WebP for images; redirect to embed for video/audio/PDF | Preview overlay image display |
| `GET .../text-preview`    | JSON `{ body, mode }` — sanitized HTML body for text/code/md  | Quick look + inline editor read-only mode |
| `GET .../thumb/:fileName` | 512px WebP                                                     | Drive file list row icons       |

## Cache Strategy

Everything in `mount.previewsDir` (`tmpDir/previews/`). Cache key: `{pathId}-{updatedAt}.{ext}`.

- Image previews: `{pathId}-{updatedAt}.screen.webp`
- SVG previews: `{pathId}-{updatedAt}.screen.svg` (raw SVG, no conversion)
- Text previews: `{pathId}-{updatedAt}.json`
- Cache hit = serve directly, no regeneration
- Cleanup: files older than 7 days, run at `mount.init()`

## Text Previews

`text-preview.ts` returns `{ body: string, mode: TextPreviewMode }`. Modes (defined in
`packages/lib/src/constants/preview.ts`):

| Mode           | Rendering                                       |
|----------------|-------------------------------------------------|
| `markdown`     | `markdown-it` → HTML, sanitized with DOMPurify |
| `code`         | `lowlight` syntax highlighting → HTML spans     |
| `plaintext`    | `<pre>` wrapped, HTML-escaped                   |
| `eigendoc`     | Yjs → PM JSON (first 20 blocks) → tiptap static renderer → HTML |
| `eigenslides`  | Yjs → first 8 slides → positioned divs with container-query sizing |
| `eigensheets`  | Yjs snapshot → first sheet → HTML table (`renderSheetsHtml`, preview mode) |

The `eigendoc`/`eigenslides`/`eigensheets` modes load the file's Yjs document (via `getCollabPreviewData` in
`preview-cache.ts`) rather than raw file text, and render only a compact slice — see Compact Previews below.

Body is consumed via `useTextPreview()` hook (TanStack Query, 5min staleTime) and rendered with
`dangerouslySetInnerHTML` inside a `.eigen-prose` container. No iframe, no shadow DOM.

Shared `eigen-prose.css` in `packages/ui/src/styles/` provides prose typography + Catppuccin code highlighting,
used by both previews and the docs editor.

## Compact Previews vs Full Export

In-app quick-look previews render a **compact** slice of eigen-native files; downloads/exports render the whole
document. The cap keeps the cached preview body small. Each type compacts by its natural unit:

| Type        | Preview cap               | Mechanism                                                                 |
|-------------|---------------------------|---------------------------------------------------------------------------|
| eigensheets | first sheet               | `renderSheetsHtml(sheets, 'preview')` — the CF resolver still spans every sheet so cross-sheet formula refs resolve |
| eigenslides | first 8 slides            | `eigenslides-preview.ts` slices `deck.slideOrder` (slides/objects maps stay whole) |
| eigendoc    | first 20 top-level blocks | `eigendoc-preview.ts` slices `json.content` before rendering              |

`RenderMode = 'export' | 'preview'` (`apps/api/src/lib/export/render-types.ts`) is threaded as a parameter (not
module state) so concurrent requests stay isolated. Only the sheets renderer reads it — slides and eigendoc
instead slice their input in the preview generator, leaving `renderDeckHtml` / the tiptap renderer signatures
untouched. When content is actually dropped, each generator appends a shared `renderPreviewTruncatedMarker()`
(`apps/api/src/lib/preview/preview-marker.ts`) — inline-styled because preview HTML is embedded without the
document `<head>`.

## Image Previews

Unified flow in `generateImagePreview()` (`thumbnails.ts`): accepts `ImageSource` (`StorageFile | Buffer | string`),
tries sharp first, then HEIC-specific conversion, then exiftool extraction. Used by both upload thumbnails (512px) and
screen previews (max 2560px). `preview-cache.ts` passes `StorageFile` references from `mount.readFile()` directly
to avoid buffering the entire file upfront.

- **SVG**: Served as-is (no rasterisation). `preview-cache.ts` caches the raw SVG locally for S3 mounts
- **Standard images** (JPEG, PNG, WebP, GIF, TIFF): sharp resize + WebP conversion
- **HEIC/HEIF**: sharp first (works if libvips has HEIC support), else `heic-convert` to JPEG → sharp → WebP
- **RAW/PSD/AI**: sharp if libvips supports it, else exiftool extracts embedded JPEG → sharp → WebP
- **Gate**: `isExiftoolCandidate()` — true for any `image/*` mime or known exiftool extensions
  (defined in `packages/lib/src/constants/preview.ts`)

## Video Thumbnails

Server-side still-frame extraction for `video/*` uploads. Same async pipeline as image
thumbnails (`regenerateThumbnailAsync` → Bun Worker → `saveThumbnail` → re-emit SSE),
only the source-to-bytes step differs.

- **Frame selection**: fast-seek at 1.0s (`-ss 1` before `-i`), falls back to 0s if the
  video is shorter. Single frame, encoded as JPEG via `image2pipe`, then resized through
  sharp to the same 512px WebP as images.
- **Probing**: `ffprobe` extracts `width`, `height`, and `duration`. Width/height are
  written to `paths.details` like images; `duration` (seconds, number) is also written.
- **Gate**: `isVideoCandidate(mimeType)` — true for any `video/*` MIME
  (`apps/api/src/lib/preview/video-preview.ts`).
- **Dependency**: system `ffmpeg` binary, shipped in the docker image. If absent,
  `isFfmpegAvailable()` returns false on first use and `extractVideoFrame` returns null —
  uploads still succeed, the thumbnail is just not generated.
- **Out of scope** (v1): animated WebP, backfill of existing videos, S3-stored video
  regeneration (upload-time only).

## Frontend Overlay

```
FilePreview (fixed, z-[100])
  Header   — filename, ← → nav, close ✕
  Content  — dispatch by previewMode:
    image:    ProgressiveImage (thumbnail → full preview)
    video:    <video src={embedUrl} controls>
    audio:    <audio src={embedUrl} controls>
    pdf:      <iframe src={embedUrl}>
    text:     TextPreviewContent (useTextPreview → eigen-prose div)
    fallback: file icon + "No preview available" + Download button
  Footer   — Open, Download/Save to Drive, Download all/Save all to Drive
```

**Keyboard:** Escape = close, ArrowLeft/ArrowRight = prev/next sibling.

**Download modes:** `openPreview(path, siblings?, options?)` accepts a `downloadMode` option (`'direct'` | `'save-to-drive'`).
Direct mode (default) shows a browser download link. Save-to-drive mode (used by chat attachments) shows a
`DriveLocationPicker` dialog to copy the file into the user's drive. Both modes offer a bulk action when there are 2+
siblings (Download all / Save all to Drive). The save-to-drive dialog renders above the preview overlay via the
`abovePreview` prop on `DialogContent`.

**Progressive image loading:** For images with thumbnails, `ProgressiveImage` stacks two `<img>` elements — the 512px
thumbnail renders instantly while the screen-resolution preview (max 2560px) loads on top. Both use `object-contain`
within a fixed-size container so there's no size change when the preview loads. Images without thumbnails load the
preview directly.

**PreviewProvider** stores `DrivePath` + `siblings[]` + `downloadMode`, exposes `openPreview(path, siblings?, options?)`.

`previewMode` determined client-side from `DrivePath.mimeType` + `DrivePath.name` via `getPreviewMode()`.

## Inline Editor Integration

`native-file-editor.tsx` in Drive shows text preview (nicely formatted via `useTextPreview`) in read-only mode.
Heavy editors (Tiptap for markdown, CodeMirror for code) are lazy-loaded only when user clicks Edit.

## Files

| File                                                                      | Purpose                                          |
|---------------------------------------------------------------------------|--------------------------------------------------|
| `apps/api/src/lib/preview/preview-cache.ts`                               | Orchestration: check cache, generate, serve      |
| `apps/api/src/lib/preview/text-preview.ts`                                | markdown-it + lowlight → HTML body + DOMPurify   |
| `apps/api/src/lib/preview/exiftool-preview.ts`                            | Embedded JPEG extraction for RAW/PSD/AI/HEIC     |
| `apps/api/src/lib/shared/thumbnails.ts`                                   | Unified image processing (sharp + heic-convert + exiftool) |
| `apps/api/src/lib/shared/video-thumbnail.ts`                              | ffmpeg-based video frame extractor + `isFfmpegAvailable`   |
| `apps/api/src/lib/preview/video-preview.ts`                               | `isVideoCandidate` MIME gate                               |
| `packages/lib/src/constants/preview.ts`                                   | `TextPreviewMode`, `getTextPreviewMode()`, `isExiftoolExtension()` |
| `apps/api/src/lib/drive/drive.ts`                                         | `resolveFile()` → ACL-checked `{ mount, path }` for preview/export/thumb routes |
| `apps/api/src/routes/drive.ts`                                            | `/preview` + `/text-preview` routes              |
| `packages/ui/src/styles/eigen-prose.css`                                  | Shared prose + code highlight styles             |
| `packages/ui/src/components/layout/drive/file-preview.tsx`                | Preview overlay component                        |
| `packages/ui/src/components/layout/preview-provider/preview-provider.tsx` | Context: open/close/navigate previews            |
| `packages/lib/src/core/drive/hooks/use-drive.ts`                          | `useTextPreview()` hook                          |
| `packages/lib/src/core/drive/media-resolver.tsx`                          | Uses `getDrivePreviewUrl` for editor images      |
| `apps/drive/src/components/editor/native-file-editor.tsx`                 | Inline editor with text preview in read-only     |
| `apps/api/src/lib/preview/eigendoc-preview.ts`                            | Eigendoc Yjs → tiptap static HTML (first 20 blocks) |
| `apps/api/src/lib/preview/eigenslides-preview.ts`                         | Slides Yjs → positioned HTML divs (first 8 slides)  |
| `apps/api/src/lib/preview/eigensheets-preview.ts`                         | Sheets Yjs → HTML table (first sheet)               |
| `apps/api/src/lib/preview/preview-marker.ts`                              | `renderPreviewTruncatedMarker()` appended on truncation |
| `apps/api/src/lib/export/render-types.ts`                                 | `RenderMode` toggle (export vs preview)             |

## Future

- CSV table rendering (currently treated as code/plaintext)
- Eigenstickies preview (eigendoc, eigenslides, eigensheets are done)
- DOCX/XLSX/PPTX preview

---

### Phase — CSV Table Rendering

**Goal:** CSV as a scrollable table (generated server-side to keep the frontend clean).

| File                                       | Change                                                                                                                      |
|--------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| `apps/api/src/lib/preview/text-preview.ts` | Extend to handle `text/csv` — parse with a lightweight server-side CSV parser, render HTML table (max 500 rows x 50 cols).  |

---

### Phase — Eigen Native Types (eigenstickies remaining)

**Goal:** Preview Eigen native files without opening them. eigendoc/eigenslides/eigensheets are done — each
preview reuses the export render functions (`doc/render.ts`, `slides/render.ts`, `sheets/html.ts`) over the
shared content loaders in `apps/api/src/lib/document/`.

| Type | Status | Approach |
|------|--------|----------|
| eigendoc | **Done** | `readEigendocContent` (Yjs → PM JSON) → tiptap static renderer with `doc/render.ts` node mappings, first 20 blocks |
| eigenslides | **Done** | `readSlidesContent` → `renderDeckHtml`, first 8 slides |
| eigensheets | **Done** | `readSheetsContent` → `renderSheetsHtml(…, 'preview')`, first sheet |
| eigenstickies | Future | Load stickies JSON, render simplified kanban columns as HTML |

---
