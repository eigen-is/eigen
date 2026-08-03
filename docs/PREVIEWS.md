# File Preview System

> **TLDR**: Server-side preview generation with tmp-dir cache. Images served as screen-res WebP (max 2560px), text/code/markdown
> and eigen-native files (eigendoc/slides/sheets, a compact HTML slice) as JSON body snippets rendered client-side with shared
> `eigen-prose` styles. Eigen-native previews are generated off-thread in a one-shot document-transform Worker
> (bounded first-sheet / 20-block / 8-slide budgets); text previews serve stale-while-revalidate. Video/audio/PDF redirect to embed URL for native playback.
> Preview overlay in `packages/ui` with keyboard nav and sibling browsing.

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
- Text previews: `{pathId}-{updatedAt}.{format}.json` — `format` is the renderer format tag (`TEXT_FORMAT` in
  `preview-cache.ts`, currently `f3`); bumping it invalidates cached bodies whose `updatedAt` didn't change
- Cache hit = serve directly, no regeneration
- Prior versions are pruned fire-and-forget after each write (`pruneOldVersions`); cleanup of files older than
  7 days runs at `mount.init()`

**Stale-while-revalidate (text previews):** when the current version is a miss but a prior version exists, the
prior body is served immediately (marked `Cache-Control: no-store`) while one deduplicated background
regeneration produces the current version; a failed regeneration leaves the stale file in place. Concurrent
first-ever misses share a single generation (`inFlightFirstText`), mirroring image previews.

## Text Previews

`text-preview.ts` returns `{ body: string, mode: TextPreviewMode }`. Modes (defined in
`packages/lib/src/constants/preview.ts`):

| Mode           | Rendering                                       |
|----------------|-------------------------------------------------|
| `markdown`     | `markdown-it` → HTML, sanitized with DOMPurify |
| `code`         | `lowlight` syntax highlighting → HTML spans     |
| `plaintext`    | `<pre>` wrapped, HTML-escaped                   |
| `eigendoc`     | Yjs blobs → transform Worker → PM JSON (first 20 blocks) → tiptap static renderer → HTML |
| `eigenslides`  | Yjs blobs → transform Worker → first 8 slides → positioned divs with container-query sizing |
| `eigensheets`  | Yjs blobs → transform Worker → bounded first-sheet HTML table (`renderSheetsPreviewHtml`) |

The `eigendoc`/`eigenslides`/`eigensheets` modes load the file's Yjs document (via `getCollabPreview` in
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
| eigensheets | first sheet, ≤ 200 rows × 50 cols / 10,000 cells | `renderSheetsPreviewHtml(sheets)` clips from the top-left of the used range — the CF resolver still spans every sheet so cross-sheet formula refs resolve; a final 8MB byte guard replaces an oversized body with the truncated notice |
| eigenslides | first 8 slides            | `renderEigenslidesPreviewBody` slices `deck.slideOrder` (slides/objects maps stay whole) |
| eigendoc    | first 20 top-level blocks | `renderEigendocPreviewBody` slices `json.content` before rendering        |

Every preview generator slices its own input (`renderSheetsPreviewHtml` for sheets, the generators for
slides/eigendoc), leaving the full-document export renderers untouched. When content is actually dropped,
each generator appends a shared `renderPreviewTruncatedMarker()`
(`apps/api/src/lib/preview/preview-marker.ts`) — inline-styled because preview HTML is embedded without the
document `<head>`.

## Off-thread Collab Previews (document-transform Worker)

Eigensheets, eigendoc and eigenslides preview generation runs in a one-shot Bun Worker so Yjs reconstruction,
op replay, recalc, HTML rendering, and sanitization never block the API event loop
(`docs/PROPOSAL_DOCUMENT_TRANSFORM_WORKERS.md`, Phases 1–3 as-built). Every export rides the same runner
through the same seam — see [EXPORT.md](EXPORT.md):

1. The main thread keeps ACL, cache lookup/dedupe, and captures the document's compressed Yjs blobs in a
   short SELECT-only transaction (`readYjsStatePayload` via `captureCollabSource`). Every transform goes
   through `runTransformToText` / `runTransformToBytes` (`lib/document/transform/run-transform.ts`), the one
   main-thread seam that owns capture timing, admission, warning surfacing, and failure mapping.
2. `DocumentTransformRunner` (`lib/document/transform/runner.ts`) admits the job: one active Worker, queue of
   16 with foreground (first cache miss) and background (stale regeneration) priorities, foreground admission
   additionally bounded by predicted wait. Overload rejects with `503` (surfaced to the client); background
   overflow is dropped — a later request re-enqueues it. There is **never** a main-thread fallback.
3. The Worker (`lib/document/transform/worker.ts`) materializes the payload and dispatches on document type
   through dynamic imports, so a doc preview never evaluates the sheet engine: sheets replay ops and recalc
   when the gate fires (a recalc failure serves replayed values with a `recalc-failed` warning) and render the
   bounded first-sheet view; doc/slides convert the Yjs roots and render their capped slice with media resolved
   from a name → URL map the main thread prepared (`buildPreviewUrlMap` — the Worker never sees a Mount). All
   three sanitize with DOMPurify (`FORCE_BODY` only — the preview config, distinct from `sanitizeExportHtml`)
   and return the body plus warnings over a typed, closed protocol (`protocol.ts`). Corrupt blobs are skipped
   with warnings, matching the live-read behavior.
4. The main thread writes the usual `{ body, mode }` cache envelope. One-shot Workers are terminated after
   every outcome (success, timeout at 30s, crash, cancellation, shutdown); `gracefulShutdown` closes the
   runner before mount teardown.

The runner logs one observability line per job (queue depth/wait, main-thread capture/media-prep ms,
input/output bytes, transform/total ms, outcome, warning codes). `src/test/transform-benchmark.ts` measures end-to-end latency, event-loop delay,
health-route latency, and RSS on heavy fixtures; run it from `apps/api` with
`bun src/test/transform-benchmark.ts [--memory]`. Measured note for the warm-pool decision (proposal Phase
4): each terminated heavy Worker currently retains ~7MB RSS in Bun 1.3 (trivial Workers plateau; the same
pipeline on-thread is flat), so high cold-preview churn argues for Worker recycling in a later phase.

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
| `apps/api/src/lib/preview/eigendoc-preview.ts`                            | Eigendoc preview: Worker-side body renderer (first 20 blocks) + runner orchestration |
| `apps/api/src/lib/preview/eigenslides-preview.ts`                         | Slides preview: Worker-side body renderer (first 8 slides) + runner orchestration |
| `apps/api/src/lib/preview/eigensheets-preview.ts`                         | Sheets preview: Worker-side body renderer + runner orchestration |
| `apps/api/src/lib/document/media.ts`                                      | Document media helpers: listing, preview URLs, Worker-side data URIs |
| `apps/api/src/lib/preview/preview-marker.ts`                              | `renderPreviewTruncatedMarker()` appended on truncation |
| `apps/api/src/lib/document/transform/protocol.ts`                         | Clone-safe transform job/request/response unions    |
| `apps/api/src/lib/document/transform/run-transform.ts`                    | Shared main-thread seam: capture → run → map        |
| `apps/api/src/lib/document/transform/runner.ts`                           | Bounded queue + one-shot Worker lifecycle           |
| `apps/api/src/lib/document/transform/worker.ts`                           | Worker entry: operation dispatch with lazy imports  |
| `apps/api/src/lib/document/transform/collab-source.ts`                    | Main-thread compressed Yjs payload capture          |

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
preview reuses the export render functions (`doc/render.ts`, `slides/render.ts`, `sheets/render.ts`) over the
shared content readers in `apps/api/src/lib/document/`, inside the transform Worker.

| Type | Status | Approach |
|------|--------|----------|
| eigendoc | **Done** | `renderEigendocPreviewBody` in the transform Worker (`readEigendocFromDoc` → tiptap static renderer with `doc/render.ts` node mappings), first 20 blocks |
| eigenslides | **Done** | `renderEigenslidesPreviewBody` in the transform Worker (`readDeckFromDoc` → `renderDeckHtml`), first 8 slides |
| eigensheets | **Done** | `renderEigensheetsPreviewBody` in the transform Worker (`readSheetsFromDoc` → `renderSheetsPreviewHtml`), budgeted first sheet |
| eigenstickies | Future | Load stickies JSON, render simplified kanban columns as HTML |

---
