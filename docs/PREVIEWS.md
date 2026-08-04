# File Preview System

> **TLDR**: Server-side preview generation, cached per file version in a tmp dir. Images become
> screen-res WebP (max 2560px). Text, code, markdown and eigen-native files become a small HTML body
> served as JSON and rendered client-side with shared `eigen-prose` styles. Video, audio and PDF
> redirect to the embed URL. The overlay lives in `packages/ui`, with keyboard and sibling nav.

## Route Structure

| Route                     | Content                                                        | Use case                        |
|---------------------------|----------------------------------------------------------------|---------------------------------|
| `GET .../download`        | Original file, `Content-Disposition: attachment`               | User hits "Download"            |
| `GET .../embed/:fileName` | Original file, `Content-Disposition: inline`                   | Video/audio playback, PDF iframe, server-side export |
| `GET .../preview`         | Screen-res WebP for images; redirect to embed for video/audio/PDF | Preview overlay image display |
| `GET .../text-preview`    | JSON `{ body, mode }` — sanitized HTML body for text/code/md  | Quick look + inline editor read-only mode |
| `GET .../thumb/:fileName` | 512px WebP                                                     | Drive file list row icons       |

## Cache Strategy

Everything in `mount.previewsDir` (`tmpDir/previews/`). The cache key carries the file version, so a
new version writes a **new file** instead of overwriting one — which is what lets responses use a long
`max-age`, since the URL carries the same `updatedAt` stamp.

- Image previews: `{pathId}-{updatedAt}.screen.webp`
- SVG previews: `{pathId}-{updatedAt}.screen.svg` (raw SVG, no conversion)
- Text previews: `{pathId}-{updatedAt}.{formatVersion}.json` — bump the renderer format version to
  force regeneration when the generated HTML changes shape at an unchanged `updatedAt`
- Cache hit = serve directly, no regeneration
- Cleanup: files older than 7 days, run at `mount.init()`

Two behaviors follow from the versioned key and define how previews feel:

**`pruneOldVersions`** runs fire-and-forget after every cache write and deletes the path's other
versions, so `previewsDir` doesn't grow one file per edit. It never touches the file just written, so
an in-flight prune can't race a concurrent read. The 7-day sweep still covers paths written once and
never again.

**Stale-while-revalidate.** When the current version isn't cached but an older one is, the route
serves the older body immediately (marked `stale`, with `Cache-Control: no-store`) and regenerates the
current one in the background. In-flight generations are shared per cache name, so N tiles of one
just-added file trigger one generate, not N.

The `/text-preview` route takes `updatedAt` as a query param. It is the cache buster: both the browser
HTTP cache and the TanStack query key are derived from the URL, so a stale URL would otherwise serve
stale content after an inline edit.

## Text Previews

`text-preview.ts` returns `{ body: string, mode: TextPreviewMode }`. Modes (defined in
`packages/lib/src/constants/preview.ts`):

| Mode           | Rendering                                       |
|----------------|-------------------------------------------------|
| `markdown`     | `markdown-it` → HTML, sanitized with DOMPurify |
| `code`         | `lowlight` syntax highlighting → HTML spans     |
| `plaintext`    | prose paragraphs — HTML-escaped `<p>` blocks, single newlines as `<br>` |
| `eigendoc`     | Yjs → PM JSON (first 20 blocks) → tiptap static renderer → HTML |
| `eigenslides`  | Yjs → first 8 slides → positioned divs with container-query sizing |
| `eigensheets`  | Yjs snapshot → first sheet → HTML table (`renderSheetsHtml`, preview mode) |

Plaintext is deliberately **not** `<pre>`: `eigen-prose` paints every `<pre>` as a dark, non-wrapping
code block, and a `.txt` file should read like rendered markdown instead.

`getTextPreview` (`preview-cache.ts`) is the single entry point. It splits on path type: eigen-native
containers go to the three `*-preview.ts` generators (`eigendoc-preview.ts`, `eigenslides-preview.ts`,
`eigensheets-preview.ts`), everything else reads the file as text and calls `generateTextPreview`.
Both sides go through the same `getOrCacheText` read-through cache, so caching, in-flight sharing and
stale-while-revalidate behave identically. The eigen-native generators render only a compact slice —
see Compact Previews below.

Body is consumed via the `useTextPreview()` hook (TanStack Query) and rendered with
`dangerouslySetInnerHTML` inside a `.eigen-prose` container. No iframe, no shadow DOM. Its
`staleTime` is deliberately short — **30 s** — so that when the server hands back a
stale-while-revalidate body, the next refetch trigger (window focus or remount) picks up the fresh one.

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

## Where the Code Lives

**Server.** `apps/api/src/lib/preview/` holds the whole generation side: `preview-cache.ts`
(orchestration, cache, stale-while-revalidate), `text-preview.ts` (markdown-it + lowlight + prose
paragraphs), the three `{eigendoc,eigenslides,eigensheets}-preview.ts` generators, `preview-marker.ts`
(`renderPreviewTruncatedMarker()`), `exiftool-preview.ts` and `video-preview.ts` (the MIME gates and
extractors). Shared image work sits in `apps/api/src/lib/shared/` — `thumbnails.ts` (sharp +
heic-convert + exiftool) and `video-thumbnail.ts` (ffmpeg). Routes are in `apps/api/src/routes/drive.ts`,
ACL through `Drive.resolveFile()`. `RenderMode` comes from `apps/api/src/lib/export/render-types.ts`.

The eigen-native generators own no loading of their own: they read through `readEigendocContent` /
`readSlidesContent` / `readSheetsContent` (see [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md))
and render with the same functions export uses — `doc/render.ts`, `slides/render.ts`, `sheets/html.ts`.
That sharing is why a preview can never disagree with an export about what the document says. See
[EXPORT.md](EXPORT.md).

**Shared.** `packages/lib/src/constants/preview.ts` owns `TextPreviewMode`, `getTextPreviewMode()` and
the exiftool extension gate — used by preview, export and the inline editor alike.
`useTextPreview()` lives in `packages/lib/src/core/drive/hooks/use-drive.ts`.

**Client.** `packages/ui/src/components/layout/drive/file-preview.tsx` is the overlay,
`.../preview-provider/preview-provider.tsx` the context, `packages/ui/src/styles/eigen-prose.css` the
shared typography. Drive's `native-file-editor.tsx` reuses the same text preview for read-only mode.

## Future

- CSV table rendering (currently treated as code/plaintext) — parse server-side and emit a bounded
  HTML table, so the frontend stays a plain `eigen-prose` container
- Eigenstickies preview (eigendoc, eigenslides, eigensheets are done)
- DOCX/XLSX/PPTX preview
