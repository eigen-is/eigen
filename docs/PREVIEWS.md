# File Preview System

> **TLDR**: Server-side preview generation, cached per file version in a tmp dir. Images become
> screen-res WebP (max 2560px). Text, code, markdown and eigen-native files become a small HTML body
> served as JSON and rendered client-side with shared `eigen-prose` styles; a `.vcf` answers on its own
> route with the contact cards themselves, rendered by `ContactDetailCard`. Eigen-native previews render
> off-thread in a one-shot document-transform Worker (bounded first-sheet / 20-block / 8-slide / 500-element budgets);
> text previews serve stale-while-revalidate. Video, audio and PDF redirect to the embed URL. The overlay
> lives in `packages/ui`, with keyboard and sibling nav.

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
- Text previews: `{pathId}-{updatedAt}.{format}.json` — `format` is the renderer format tag (`TEXT_FORMAT` in
  `preview-cache.ts`, currently `f5`); bumping it invalidates cached bodies whose `updatedAt` didn't change
- vCard previews: the same shape under `VCARD_FORMAT`, so neither artifact resolves the other as its stale predecessor
- Cache hit = serve directly, no regeneration
- Prior versions are pruned fire-and-forget after each write (`pruneOldVersions`); cleanup of files older than
  7 days runs at `mount.init()`

**Stale-while-revalidate (text previews):** when the current version is a miss but a prior version exists, the
prior body is served immediately (marked `Cache-Control: no-store`) while one deduplicated background
regeneration produces the current version; a failed regeneration leaves the stale file in place. Concurrent
first-ever misses share a single generation (`inFlightFirstText`), mirroring image previews.

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
| `markdown`     | `markdown-it` → HTML, sanitized with `sanitizeExportHtml` (no refs — a `![](http://…)` image can't beacon a viewer of the drive hero) |
| `code`         | `lowlight` syntax highlighting → HTML spans     |
| `plaintext`    | prose paragraphs — HTML-escaped `<p>` blocks, single newlines as `<br>` |
| `eigendoc`     | Yjs blobs → transform Worker → PM JSON (first 20 blocks) → tiptap static renderer → HTML |
| `eigenslides`  | Yjs blobs → transform Worker → `framePages` + `renderCanvasPage` (`export/canvas/render.ts`) → the first 8 slides as compositor pages, each scaled to `CANVAS_PREVIEW_WIDTH`, media as `/preview` URLs. Filtered on two levels like `eigenvector`: each rich-text `html` first, then the assembled pages |
| `eigensheets`  | Yjs blobs → transform Worker → bounded first-sheet HTML table (`renderSheetsPreviewHtml`) |
| `eigenvector`  | Yjs blobs → transform Worker → `drawingPage` + `renderCanvasPage` (`export/canvas/render.ts`) → one HTML page fitted to `CANVAS_PREVIEW_WIDTH` × `CANVAS_PREVIEW_HEIGHT` (960×540) and centred in a full-width box, media as `/preview` URLs. A drawing with nothing in it composes an `emptyPage` rather than no body, so an emptied drawing stops serving the preview it had. Filtered twice: each rich-text `html` through `sanitizeExportHtml` (the shared ref restriction — a collaborator's `<img src=https://…>` or `background:url(https://…)` would otherwise beacon every viewer of the folder), then the assembled page through DOMPurify |

Plaintext is deliberately **not** `<pre>`: `eigen-prose` paints every `<pre>` as a dark, non-wrapping
code block, and a `.txt` file should read like rendered markdown instead.

The `eigendoc`/`eigenslides`/`eigensheets`/`eigenvector` modes load the file's Yjs document rather than raw file text. The first three render only a compact slice — see Compact Previews below.

`getTextPreview` (`preview-cache.ts`) is the single entry point. It splits on `COLLAB_DOCUMENT_TYPES`, the one list of which mimes are collab containers: those go to the Worker-side `preview/eigen{doc,slides,sheets,vector}-render.ts` bodies, everything else reads the file as text and calls `generateTextPreview`. Both sides go through the same `getOrCacheText` read-through cache — as does the vCard preview beside them, under its own format tag — so caching, in-flight sharing and stale-while-revalidate behave identically.

Body is consumed via the `useTextPreview()` hook (TanStack Query) and rendered with `dangerouslySetInnerHTML` inside a `.eigen-prose` container. No iframe, no shadow DOM. Its `staleTime` is deliberately short — **30 s** — so that when the server hands back a stale-while-revalidate body, the next refetch trigger (window focus or remount) picks up the fresh one. The `eigenvector` body is the exception on both counts: it is a self-contained page div carrying its own box, background and absolutely-positioned layers, so the lightbox only centres it and the drive hero scales it from its known intrinsic width (`CANVAS_PREVIEW_WIDTH` — `eigenslides` composes at the same width, `eigendoc` at `A4_WIDTH_PX`) with no wrapper class at all rather than a prose one. `eigenslides` is the same shape — a column of self-contained `.canvas-page` divs — scaled from the same known width, so the drive hero shows the first slide.

Shared `eigen-prose.css` in `packages/ui/src/styles/` provides prose typography + Catppuccin code highlighting,
used by both previews and the docs editor.

## Compact Previews vs Full Export

In-app quick-look previews render a **compact** slice of eigen-native files; downloads/exports render the whole
document. The cap keeps the cached preview body small. Each type compacts by its natural unit:

| Type        | Preview cap               | Mechanism                                                                 |
|-------------|---------------------------|---------------------------------------------------------------------------|
| eigensheets | first sheet, ≤ 200 rows × 50 cols / 10,000 cells | `renderSheetsPreviewHtml(sheets)` clips from the top-left of the used range — the CF resolver still spans every sheet so cross-sheet formula refs resolve |
| eigenslides | first 8 slides, ≤ 500 elements | `renderEigenslidesPreviewBody` slices the frame list, then the shown frames' elements through `capPreviewElements` |
| eigendoc    | first 20 top-level blocks | `renderEigendocPreviewBody` slices `json.content` before rendering        |
| eigenvector | ≤ 500 elements            | one page sized to the content bounds, its elements sliced by the same `capPreviewElements` |

Each capped preview render module slices its own input (`renderSheetsPreviewHtml` for sheets, the render modules themselves for slides/eigendoc), leaving the full-document export renderers untouched. The two canvas types cap on elements through one shared budget (`capPreviewElements` in `preview/preview-scene.ts`, kept in reading order — frame by frame, then z-order inside a frame), and a deck caps on frames first. When content is actually dropped, each render module appends a shared `renderPreviewTruncatedMarker()` (`apps/api/src/lib/preview/preview-marker.ts`) — inline-styled because preview HTML is embedded without the document `<head>`.

The sheet window bounds *declared* spans too, not just emitted cells — one legal merge or conditional-format
range can name millions of cells. Merge `colspan`/`rowspan` clip to the window edge (sets the truncated
marker); CF rules evaluate only over the window, so aggregate rules (data bars, color scales, top-10,
above-average, duplicates) compute their extremes over the visible slice rather than the full declared range —
the editor canvas remains the fidelity reference. Formula rules keep their range start (it anchors the rule's
relative references) with ends clipped, and a rule whose kept area still exceeds 50,000 cells is dropped from
the preview outright. Exports render declarations in full.

All four then run their body through `applyPreviewByteGuard()` from that same module: the caps count blocks, slides, elements and cells, so one enormous block sails through all of them. A body over 8MB is replaced by the truncated marker — never a partially sliced string — and surfaces a `byte-guard-truncated` warning.

## Off-thread Collab Previews (document-transform Worker)

Eigensheets, eigendoc, eigenslides and eigenvector preview generation runs in a one-shot Bun Worker so Yjs reconstruction, op replay, recalc, HTML rendering, and sanitization never block the API event loop (a `.vcf` rides the same runner, carrying its own bytes instead of a captured document) ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)). Every export rides the same runner through the same seam — see [EXPORT.md](EXPORT.md):

1. The main thread keeps ACL, cache lookup/dedupe, builds the media URL map for doc, slides and vector, and captures the document's compressed Yjs blobs in a short SELECT-only transaction (`readYjsStatePayload` via `captureCollabSource`). That main-thread half is one shared entry, `generateDocumentPreview` in `preview/preview-document.ts` (the `export-document.ts` counterpart); every transform then goes through `runTransformToText` / `runTransformToBytes` (`lib/document/transform/run-transform.ts`), the one main-thread seam that owns capture timing, the operation's deadline, admission, warning surfacing, and failure mapping.
2. `DocumentTransformRunner` (`lib/document/transform/runner.ts`) admits the job: one active Worker, queue of
   16 with foreground (first cache miss) and background (stale regeneration) priorities, foreground admission
   additionally bounded by predicted wait. Overload rejects with `503` (surfaced to the client); background
   overflow is dropped — a later request re-enqueues it. There is **never** a main-thread fallback.
3. The Worker (`lib/document/transform/worker.ts`) materializes the payload and dispatches on document type through dynamic imports into the Worker-pure render modules (`preview/eigen{doc,slides,sheets,vector}-render.ts`, which reach neither the Mount nor the transform seam), so a doc preview never evaluates the sheet engine: sheets replay ops — never recalc: stored values render as-is and a valueless formula cell stays blank, because a legacy never-computed workbook can cost an unbounded recalc (~39s measured) that the 30s deadline would kill on every attempt; only the export read recalcs (SHEETS.md § Server-side recalc) — and render the bounded first-sheet view; doc, slides and vector convert the Yjs roots and render with media resolved from a name → URL map the main thread prepared (`buildPreviewUrlMap` — the Worker never sees a Mount). Doc and sheets sanitize their assembled body with `sanitizeExportHtml` — the shared ref restriction that keeps only `data:` URIs and the prepared media URLs, so a collaborator's `url(http://…)` cell background or dangling figure `src` can't beacon a viewer (doc passes its media URLs as `allowedRefs`, sheets embed no media and pass none); both canvas types sanitize *per element* first — `sanitizeSceneHtml` (`export/sanitize.ts`, shared with the exports) filters each rich-text `html` down to the LightEditor tag set the canvas itself mounts (EXPORT.md § Sanitization and SSRF) before the compositor runs, so the page's own generated markup survives the pass that follows (the reader is the trust boundary for a scene's scalar fields, but not for a rich-text body, which it caps and cleans without filtering tags). All four return the body plus warnings over a typed, closed protocol (`protocol.ts`). Corrupt blobs are skipped with warnings, matching the live-read behavior.
4. The main thread writes the usual `{ body, mode }` cache envelope. One-shot Workers are terminated after
   every outcome (success, timeout at the 30s preview deadline in `TRANSFORM_LIMITS`, crash, cancellation, shutdown);
   `gracefulShutdown` (`src/index.ts`) closes the runner before mount teardown.

The runner logs one observability line per job (queue depth/wait, main-thread capture/media-prep ms,
input/output bytes, transform/total ms, outcome, warning codes). `src/test/transform-benchmark.ts` measures end-to-end latency, event-loop delay,
health-route latency, and RSS on heavy fixtures; run it from `apps/api` with
`bun src/test/transform-benchmark.ts [--memory]`. Each terminated heavy Worker retains ~7MB RSS in Bun 1.3
(trivial Workers plateau; the same pipeline on-thread is flat) — but the no-warm-pool decision stands on a
measured pathology, recorded in [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md) § Worker lifecycle.

## Image Previews

Unified flow in `generateImagePreview()` (`thumbnails.ts`): accepts `ImageSource` (`StorageFile | Buffer | string`),
tries sharp first, then HEIC-specific conversion, then exiftool extraction. Used by both upload thumbnails (512px) and
screen previews (max 2560px). `preview-cache.ts` passes `StorageFile` references from `mount.readFile()` directly
to avoid buffering the entire file upfront.

- **SVG**: Served as-is (no rasterisation). `preview-cache.ts` caches the raw SVG locally for S3 mounts, and runs the stored bytes through `svg-media-inline.ts` first: an `<image href="eigen-media:<name>">` ref is resolved against the file's own folder and inlined as a `data:` URI, because an `<img>`-hosted SVG never fetches external refs. The content type stays `image/svg+xml`, so the route serves it under the sandbox CSP
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
    text:     TextPreviewContent (useTextPreview → eigen-prose div; the eigenvector
              body is a self-contained page, centred rather than prose-styled)
    vcard:    VCardPreviewContent (useVCardPreview → one ContactDetailCard per card)
    fallback: file icon + "No preview available"
  Footer   — Open (a Drive subject), then one button per FILE_ACTIONS row the subject
             qualifies for (Download, Save to Drive…, Convert to Sheet, Convert to
             Document, Import to Contacts), then "Save all (n)" for a batch
```

**Keyboard:** Escape = close, ArrowLeft/ArrowRight = prev/next sibling.

**vCard quick look.** A `.vcf` reads as contact cards, never as its raw text, so it previews as the cards themselves rather than as a body. `getPreviewMode` (`packages/lib/src/core/file-subject.ts`) returns the `vcard` mode on `isVCardFile` before it reaches the text rule, and `getTextPreviewMode` returns `null` for the same files — which keeps a `.vcf` out of raw-text rendering and out of the inline editor (`isInlineEditable` is a separate list and `.vcf` is not on it). `GET /drive/:ownerId/:mountId/file/:pathId/vcard-preview` (`routes/drive.ts`) answers with `{ cards: { contact, categories }[], dropped, total }`: a file over `IMPORT_MAX_BYTES` is a 413 before its bytes are read, a name and mime `isVCardFile` doesn't recognise a 400. `getVCardPreview` (`preview-cache.ts`) rides the same `getOrCacheText` cache under its own format tag, so the cards are produced once per file version and neither artifact for a path ever reads the other's file as its stale predecessor (`pruneOldVersions` is not format-scoped, but a `.vcf` only ever has the one: `getTextPreviewMode` declines it and `getScreenPreview` does not answer for its mimes). A cached body that no longer parses — a file truncated or half-written on disk — is treated as a corrupt cache file: it is deleted and regenerated, the way every other unreadable cache file in that module is; `runFileTransformToText` reads the bytes from the Mount and transfers them to the Worker, which builds the payload in `preview/vcard-preview.ts` under the shared `preview` limits. The build decodes UTF-8 with `{ fatal: true }` — another encoding is a controlled 422 ("Could not read this file"), never a crash and never an empty success — splits with `splitVCards`, transcodes and parses no more cards than an import would accept (`IMPORT_MAX_CARDS`), counts the cards the parser refuses rather than failing the whole file, and carries the first `VCARD_PREVIEW_MAX_CARDS` (200). The payload's shape is a TypeScript type beside that build, `VCardPreview`, and the route answers with the value the handler returns: Elysia infers the response from it and Eden carries the type through `useVCardPreview` to `ContactDetailCard`, so nothing between the Worker and the component casts. The cache read back (`parseVCardPreview`) is a typed assignment on JSON this process wrote itself, the same trust the text preview places in its own cached body — `VCARD_FORMAT` in the cache name is what isolates a shape change after a deploy. Inline `PHOTO` bytes become `data:` URIs through `parsedCardToContact`; a `PHOTO;VALUE=uri` and a non-image media type are dropped rather than fetched, so an untrusted file can't make a viewer's browser call a URL it chose. `VCardPreviewContent` (`packages/ui/src/components/drive/vcard-preview-content.tsx`) renders one `ContactDetailCard` per card with each card's `CATEGORIES` as label badges, and ends on up to two counted lines, "and N more contacts" and "N contacts could not be read", spelled once in `packages/lib/src/core/contacts/preview-lines.ts`. Over the ceiling it shows a "File too large to preview" empty state, on a query error "Could not read this file", and on a file with no readable card "No contacts in this file". The overlay's footer carries an **Import to Contacts** button for a `.vcf` under the import ceiling — the registry row of that name, run by `useFileActionRunner`, which posts the previewed path to `/contacts/:ownerId/import-from-drive` ([CONTACTS.md](CONTACTS.md)) and imports a subject without a Drive path by fetching its bytes in the browser. The drive detail hero reads the same query: `VCardHero` (`packages/ui/src/components/drive/drive-preview.tsx`) shows the first three cards as compact `UserAvatar` + name + first-email rows — the card's own name, never the address book's — and falls back to the file icon over the ceiling, on a read error, and on a file with no readable card.

**The subject and its actions.** The overlay acts on a `FileSubject` (`packages/lib/src/types/file-subject.ts`): one file with a name, a mime, a size and the URLs to embed, download and thumbnail it, carrying the `DrivePath` behind it when a Drive item is what it holds, or a `mail` identity (`{ ownerId, messageId, index }`) when a mail part is — the source identity a write route needs, never parsed back out of the `key`. `subjectFromPath` (`packages/lib/src/core/file-subject.ts`) is the only place a Drive item becomes one, so no surface composes a preview route by hand. `openPreview(subject, siblings?, options?)` takes the siblings ← → pages through, and `{ batch: true }` marks them as a set to act on as a whole — which is what draws the "Save all (n)" row. A Drive listing hands over its whole folder for navigation and passes no option, so the overlay never offers to copy a folder onto itself; the attachment chips, whose siblings are one message's attachments, do pass it. What may be done with a subject is the registry `FILE_ACTIONS` (`packages/lib/src/core/file-actions.ts`), read through `fileActionsFor(subject, exclude?)` — each row's `applies` predicate reads the subject's own type and size, never which surface is asking. The overlay draws one footer button per row, excluding `quick-look`, being Quick Look itself. Every menu draws those rows through `FileActionMenuItems` (`packages/ui/src/components/file-actions/file-action-menu-items.tsx`), the one place a file action is a menu row: Drive's item menu excludes `save-to-drive`, since its own "Copy to…" row says the same thing, and the chat and card attachment chips exclude nothing. The component takes the runner rather than building one — a menu's content unmounts when it closes, so the picker a row opens has to be mounted by the host above it, and the rows come from `runner.subject` so a host can never pair one menu with another's subject. `useFileActionRunner(subject, siblings?, options?)` (`packages/ui/src/components/file-actions/use-file-action-runner.tsx`) performs a row and owns both the `SaveToDrivePicker` and the conversion progress dialog its host mounts through `runner.dialogs`: the footer's own Save to Drive row opens the picker on the previewed subject, and the batch row opens it on the downloadable siblings through `runner.openPicker(subjects)`. The subject is nullable, for a host whose subject is state — the right-clicked chip, the right-clicked row — and `options` carries the `batch` flag on to the quick-look row, so a chip's menu opens the overlay with the same "Save all" row its click does. Footer buttons disable while `runner.isPending`, and the overlay's focus trap hands focus over while `runner.isDialogOpen`. `SaveToDrivePicker` (`packages/ui/src/components/drive/save-to-drive-picker.tsx`) is the "where does this go" dialog: a Drive subject is copied server-side so its bytes never travel, "Download instead" falls back to a staggered browser download, and it renders above the preview overlay via the `abovePreview` prop on `DialogContent`.

**Progressive image loading:** For images with thumbnails, `ProgressiveImage` stacks two `<img>` elements — the 512px
thumbnail renders instantly while the screen-resolution preview (max 2560px) loads on top. Both use `object-contain`
within a fixed-size container so there's no size change when the preview loads. Images without thumbnails load the
preview directly.

**PreviewProvider** stores the subject + `siblings[]` + the `batch` flag and exposes `openPreview(subject, siblings?, options?)`, `updatePreview(subject)` and `closePreview()`. One memo derives the preview URL (the transcode route for a Drive subject, the subject's own `embedUrl` otherwise), the aspect ratio and the preview mode.

`previewMode` is decided client-side by `getPreviewMode(subject)` (`packages/lib/src/core/file-subject.ts`, beside the subject builder) from the mime prefix, `application/pdf`, `isExiftoolExtension(name)`, `isVCardFile` and `getTextPreviewMode`. Every server-rendered mode needs a mount to query, so those branches gate on `subject.drive`; without one the `<img>` points at the original bytes, which makes it an image preview only for a mime in `BROWSER_IMAGE_MIMES` (`packages/lib/src/constants/preview.ts`) — a HEIC gets the fallback card instead of a broken box.

## Inline Editor Integration

`native-file-editor.tsx` in Drive shows text preview (nicely formatted via `useTextPreview`) in read-only mode.
Heavy editors (Tiptap for markdown, CodeMirror for code) are lazy-loaded only when user clicks Edit.

## Where the Code Lives

| File                                                                      | Purpose                                          |
|---------------------------------------------------------------------------|--------------------------------------------------|
| `apps/api/src/lib/preview/preview-cache.ts`                               | Orchestration: check cache, generate, serve      |
| `apps/api/src/lib/preview/text-preview.ts`                                | markdown-it + lowlight → HTML body + `sanitizeExportHtml` |
| `apps/api/src/lib/preview/exiftool-preview.ts`                            | Embedded JPEG extraction for RAW/PSD/AI/HEIC     |
| `apps/api/src/lib/shared/thumbnails.ts`                                   | Unified image processing (sharp + heic-convert + exiftool) |
| `apps/api/src/lib/shared/video-thumbnail.ts`                              | ffmpeg-based video frame extractor + `isFfmpegAvailable`   |
| `apps/api/src/lib/preview/video-preview.ts`                               | `isVideoCandidate` MIME gate                               |
| `packages/lib/src/constants/preview.ts`                                   | `TextPreviewMode`, `getTextPreviewMode()`, `isExiftoolExtension()`, `CANVAS_PREVIEW_WIDTH`, `CANVAS_PREVIEW_HEIGHT` |
| `apps/api/src/lib/drive/drive.ts`                                         | `resolveFile()` → ACL-checked `{ mount, path }` for preview/export/thumb routes |
| `apps/api/src/routes/drive.ts`                                            | `/preview` + `/text-preview` + `/vcard-preview` routes |
| `packages/ui/src/styles/eigen-prose.css`                                  | Shared prose + code highlight styles             |
| `packages/ui/src/components/drive/file-preview.tsx`                | Preview overlay component                        |
| `packages/lib/src/types/file-subject.ts`                                  | `FileSubject`: the one file shape every surface acts on |
| `packages/lib/src/core/file-subject.ts`                                   | `subjectFromPath()` + `getPreviewMode()`         |
| `packages/lib/src/core/file-actions.ts`                                   | `FILE_ACTIONS` + `fileActionsFor()`: what may be done with a subject |
| `packages/ui/src/components/file-actions/use-file-action-runner.tsx`      | Runs a registry row; owns the host's one `SaveToDrivePicker` |
| `packages/ui/src/components/drive/save-to-drive-picker.tsx`               | "Save to Drive" dialog, with the browser download as the escape hatch |
| `apps/api/src/lib/preview/vcard-preview.ts`                                | The `VCardPreview` payload: its type, the Worker-side card builder (first 200 cards) and the cache-read parse |
| `packages/ui/src/components/drive/vcard-preview-content.tsx`       | `.vcf` quick look: the served cards as `ContactDetailCard`s |
| `packages/ui/src/components/preview-provider/preview-provider.tsx` | Context: open/close/navigate previews            |
| `packages/lib/src/core/drive/hooks/reads.ts`                              | `useTextPreview()` + `useVCardPreview()` hooks    |
| `packages/lib/src/core/drive/media-resolver.tsx`                          | Uses `getDrivePreviewUrl` for editor images      |
| `apps/drive/src/components/editor/native-file-editor.tsx`                 | Inline editor with text preview in read-only     |
| `apps/api/src/lib/preview/eigen{doc,slides,sheets,vector}-render.ts`      | Worker-side body renderers (first 20 blocks / 8 slides / budgeted first sheet / 500 elements) |
| `apps/api/src/lib/preview/preview-document.ts`                            | Main-thread orchestration for every collab type: media prep + the transform seam |
| `apps/api/src/lib/document/media.ts`                                      | Document media helpers: listing, preview URLs, Worker-side data URIs |
| `apps/api/src/lib/export/canvas/render.ts`                                | Worker-pure compositor shared with the PDF export (see [EXPORT.md](EXPORT.md)) |
| `apps/api/src/lib/preview/preview-scene.ts`                               | `capPreviewElements`: the element budget both canvas previews run |
| `apps/api/src/lib/preview/preview-marker.ts`                              | `renderPreviewTruncatedMarker()` appended on truncation |
| `apps/api/src/lib/document/transform/protocol.ts`                         | Clone-safe transform job/request/response unions    |
| `apps/api/src/lib/document/transform/run-transform.ts`                    | Shared main-thread seam: capture → run → map        |
| `apps/api/src/lib/document/transform/runner.ts`                           | Bounded queue + one-shot Worker lifecycle           |
| `apps/api/src/lib/document/transform/worker.ts`                           | Worker entry: operation dispatch with lazy imports  |
| `apps/api/src/lib/document/transform/collab-source.ts`                    | Main-thread compressed Yjs payload capture          |

## Future

- CSV table rendering (currently treated as code/plaintext) — parse server-side and emit a bounded
  HTML table, so the frontend stays a plain `eigen-prose` container
- Eigenstickies preview (eigendoc, eigenslides, eigensheets, eigenvector are done)
- DOCX/XLSX/PPTX preview

---

### Phase — CSV Table Rendering

**Goal:** CSV as a scrollable table (generated server-side to keep the frontend clean).

| File                                       | Change                                                                                                                      |
|--------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| `apps/api/src/lib/preview/text-preview.ts` | Extend to handle `text/csv` — parse with a lightweight server-side CSV parser, render HTML table (max 500 rows x 50 cols).  |

---

### Phase — Eigen Native Types (eigenstickies remaining)

**Goal:** Preview Eigen native files without opening them. eigendoc/eigenslides/eigensheets/eigenvector are done — each preview reuses the export render path (`doc/render.ts`, `sheets/render.ts`, `canvas/render.ts` for both canvas types) over the shared content readers, inside the transform Worker.

| Type | Status | Approach |
|------|--------|----------|
| eigendoc | **Done** | `renderEigendocPreviewBody` in the transform Worker (`readEigendocFromDoc` → tiptap static renderer with `doc/render.ts` node mappings), first 20 blocks |
| eigenslides | **Done** | `renderEigenslidesPreviewBody` in the transform Worker (`readVectorFromDoc` → `framePages` → `renderCanvasPage`), first 8 slides and 500 elements |
| eigensheets | **Done** | `renderEigensheetsPreviewBody` in the transform Worker (`readSheetsFromDoc` → `renderSheetsPreviewHtml`), budgeted first sheet |
| eigenvector | **Done** | `renderEigenvectorPreviewBody` in the transform Worker (`readVectorFromDoc` → `drawingPage` → `renderCanvasPage`), first 500 elements as one page |
| eigenstickies | Future | Load stickies JSON, render simplified kanban columns as HTML |

---
