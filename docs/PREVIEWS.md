# File Preview System

> **TLDR**: Server-side preview generation, cached per file version in a tmp dir. Images become
> screen-res WebP (max 2560px). Text, code, markdown and eigen-native files become a small HTML body
> served as JSON and rendered client-side with shared `eigen-prose` styles; a `.vcf`, an `.eml` and an `.ics`
> each answer on their own route with the cards, the message and the events they hold, as one typed payload
> rather than a body. A mail part reaches the same
> renderers through its own routes, on the part's bytes. Eigen-native previews render
> off-thread in a one-shot document-transform Worker (bounded first-sheet / 20-block / 8-slide / 500-element budgets);
> text previews serve stale-while-revalidate. Video, audio and PDF redirect to the embed URL. The overlay
> lives in `packages/ui`, with keyboard and sibling nav.

## Route Structure

| Route                     | Content                                                        | Use case                        |
|---------------------------|----------------------------------------------------------------|---------------------------------|
| `GET .../download`        | Original file, `Content-Disposition: attachment`               | User hits "Download"            |
| `GET .../embed/:fileName` | Original file, `Content-Disposition: inline`                   | Video/audio playback, PDF iframe, server-side export |
| `GET .../preview`         | Screen-res WebP for images; redirect to embed for video/audio/PDF | Preview overlay image display |
| `GET .../text-preview`    | JSON `TextPreviewResult` — sanitized HTML body for text/code/md | Quick look + inline editor read-only mode |
| `GET .../{vcard,eml,ics}-preview` | JSON `VCardPreview` / `EmlPreview` / `IcsPreview` — the cards, the message, the events | Quick look of a `.vcf`, an `.eml`, an `.ics` |
| `GET .../thumb/:fileName` | 512px WebP                                                     | Drive file list row icons       |

## Cache Strategy

Everything in `mount.previewsDir` (`tmpDir/previews/`). The cache key carries the file version, so a
new version writes a **new file** instead of overwriting one — which is what lets responses use a long
`max-age`, since the URL carries the same `updatedAt` stamp.

- Image previews: `{pathId}-{updatedAt}.screen.webp`
- SVG previews: `{pathId}-{updatedAt}.screen.svg` (raw SVG, no conversion)
- Text previews: `{pathId}-{updatedAt}.{format}.json` — `format` is the renderer format tag (`TEXT_FORMAT` in
  `preview-cache.ts`, currently `f5`); bumping it invalidates cached bodies whose `updatedAt` didn't change
- Typed-payload previews: the same shape under the format's own tag (`VCARD_FORMAT`, `EML_FORMAT`, `ICS_FORMAT`), so no artifact resolves another as its stale predecessor. `dropped` means one thing in all three — what the parser could not read — and what a payload merely does not list is the consumer's own `total - dropped - listed`. Each is bumped on every change to its payload type — `EML_FORMAT` **on every DOMPurify upgrade** too, because a cached body is html a previous sanitizer filtered; the `.eml` Drive route answers `private, no-cache` instead of a long `max-age`, so a bump reaches a browser that already holds a body
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

`text-preview.ts` returns a `TextPreviewResult` — `{ body: string, mode: TextPreviewMode }`, the FE/BE type in
`packages/lib/src/types/preview.ts`. Modes (defined in
`packages/lib/src/constants/preview.ts`, where `BytesTextPreviewMode` is the first three — the ones a
file's own bytes render as):

| Mode           | Rendering                                       |
|----------------|-------------------------------------------------|
| `markdown`     | `markdown-it` → HTML, sanitized with `sanitizeExportHtml` (no refs — a `![](http://…)` image can't beacon a viewer of the drive hero) |
| `code`         | `lowlight` syntax highlighting → HTML spans     |
| `plaintext`    | prose paragraphs — HTML-escaped `<p>` blocks, single newlines as `<br>` |
| `eigendoc`     | Yjs blobs → transform Worker → PM JSON (first 20 blocks) → tiptap static renderer → HTML |
| `eigenslides`  | Yjs blobs → transform Worker → `framePages` + `renderCanvasPage` (`export/canvas/render.ts`) → the first 8 slides as compositor pages, each scaled to `CANVAS_PREVIEW_WIDTH`, media as `/preview` URLs. Filtered on two levels like `eigenvector`: each rich-text `html` first, then the assembled pages |
| `eigensheets`  | Yjs blobs → transform Worker → bounded first-sheet HTML table (`renderSheetsPreviewHtml`) |
| `eigenvector`  | Yjs blobs → transform Worker → `drawingPage` + `renderCanvasPage` (`export/canvas/render.ts`) → one HTML page fitted to `CANVAS_PREVIEW_WIDTH` × `CANVAS_PREVIEW_HEIGHT` (960×540) and centered in a full-width box, media as `/preview` URLs. A drawing with nothing in it composes an `emptyPage` rather than no body, so an emptied drawing stops serving the preview it had. Filtered twice: each rich-text `html` through `sanitizeExportHtml` (the shared ref restriction — a collaborator's `<img src=https://…>` or `background:url(https://…)` would otherwise beacon every viewer of the folder), then the assembled page through DOMPurify |

Plaintext is deliberately **not** `<pre>`: `eigen-prose` paints every `<pre>` as a dark, non-wrapping
code block, and a `.txt` file should read like rendered markdown instead.

The `eigendoc`/`eigenslides`/`eigensheets`/`eigenvector` modes load the file's Yjs document rather than raw file text. The first three render only a compact slice — see Compact Previews below.

One ceiling bounds every text preview, Drive and mail alike: `TEXT_PREVIEW_MAX_BYTES` (1 MiB, `packages/lib/src/constants/preview.ts`), because the decode and the highlighter run on the API event loop, per request. `getBytesTextPreview` is the gate — it answers null for bytes over it — and `getTextPreview` refuses a Drive file on its row's `size` first, so an oversize file is never read. A collab container is not measured against it: its size is its databases, not the body the Worker renders from them. Client-side, `getPreviewMode` returns `fallback` for a loose-bytes text subject over the same ceiling, so the overlay shows the file card with its action rows rather than a panel the route would 404.

`getTextPreview` (`preview-cache.ts`) is the single entry point. It splits on `COLLAB_DOCUMENT_TYPES`, the one list of which mimes are collab containers: those go to the Worker-side `preview/eigen{doc,slides,sheets,vector}-render.ts` bodies, everything else reads the file as text and calls `generateTextPreview`. Both sides go through the same `getOrCacheText` read-through cache — as do the three typed-payload previews beside them, each under its own format tag — so caching, in-flight sharing and stale-while-revalidate behave identically.

Body is consumed via the `useTextPreview()` hook (TanStack Query) and rendered with `dangerouslySetInnerHTML` inside a `.eigen-prose` container. No iframe, no shadow DOM. Its `staleTime` is deliberately short — **30 s** — so that when the server hands back a stale-while-revalidate body, the next refetch trigger (window focus or remount) picks up the fresh one. The `eigenvector` body is the exception on both counts: it is a self-contained page div carrying its own box, background and absolutely-positioned layers, so the lightbox only centers it and the drive hero scales it from its known intrinsic width (`CANVAS_PREVIEW_WIDTH` — `eigenslides` composes at the same width, `eigendoc` at `A4_WIDTH_PX`) with no wrapper class at all rather than a prose one. `eigenslides` is the same shape — a column of self-contained `.canvas-page` divs — scaled from the same known width, so the drive hero shows the first slide.

The `eigensheets` body is the other shape with a wrapper rule of its own: a bare grid fragment whose floating-image overlay positions each image in declared grid pixels, embedded in app CSS that moves the grid under it. `.eigensheets-preview` (`packages/ui/src/styles/globals.css`) restores what the export document's `SHEET_CSS_BASE` gives the same markup — `line-height: normal`, so a row keeps the height its `<tr>` declares instead of stretching half a pixel per row under the app line-height, and `img { max-width: none }`, so preflight's image cap cannot shrink a floating image to the table's width.

Shared `eigen-prose.css` in `packages/ui/src/styles/` provides prose typography + Catppuccin code highlighting,
used by both previews and the docs editor.

## Mail Parts

A mail part previews through the same renderers on its own bytes: `GET /mail/:ownerId/message/:id/attachment/:index/preview/text`, `.../preview/vcard`, `.../preview/eml` and `.../preview/ics` (`routes/mail.ts`) answer with the `TextPreviewResult`, the `VCardPreview` cards, the `EmlPreview` message and the `IcsPreview` events the Drive routes answer with (all in `packages/lib/src/types/preview.ts`), two segments past the index so that a part named after a preview route cannot shadow it, so the same components render both. A forwarded message rides along as a `message/rfc822` part with its own bytes (`mail-parser/split.ts` flattens only an *inline* one into its parent), so the `.eml` route previews it like any other part; a calendar part carries no filename at all and names its purpose in the type's own parameters (`text/calendar; method=REQUEST`), which is why `isIcsFile` matches the media type with its parameters (`text/calendar` itself, or `text/calendar;`, never a type that merely starts with those letters). All four end in the one bytes-in entry point beside the cached ones — `getBytesTextPreview`, `getBytesVCardPreview`, `getBytesEmlPreview` and `getBytesIcsPreview` (`preview-cache.ts`) — which own the decode and the Worker job; Drive reaches the same renderers through `getOrCacheText`, a part reaches them directly, because a part has no version stamp to key a cache on. `getBytesTextPreview` decodes with the charset the part declared, defaulting to UTF-8, and owns the text mode gate (the other three have none — the routes run their `assert*Previewable` guard before them), and it gates on `getBytesTextPreviewMode`, never `getTextPreviewMode`: an eigen mime is the uploader's or the sender's word, so loose bytes render — and are labeled — as what their name says, rather than being drawn inside the A4, slide or canvas frame their mime claims. The responses are `private, no-cache` with the ETag `readMailPart` builds, so a rewritten draft revalidates rather than serving what it had ([MAIL.md](MAIL.md)); a preview route hands it the renderer's format tag, so a payload or sanitizer fix (an `EML_FORMAT` bump) is answered with the new body rather than a 304 on a message whose own bytes never moved. `useMailTextPreview` / `useMailVCardPreview` (`packages/lib/src/core/mail/hooks/use-attachment-preview.ts`) read them, keyed per owner, message and part index, through the no-revival routes `mailVCardPreviewRoute` / `mailEmlPreviewRoute` / `mailIcsPreviewRoute`.

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

Eigensheets, eigendoc, eigenslides and eigenvector preview generation runs in a one-shot Bun Worker so Yjs reconstruction, op replay, recalc, HTML rendering, and sanitization never block the API event loop (a `.vcf`, an `.eml` and an `.ics` ride the same runner, carrying their own bytes instead of a captured document) ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)). Every export rides the same runner through the same seam — see [EXPORT.md](EXPORT.md):

1. The main thread keeps ACL, cache lookup/dedupe, builds the media URL map, and captures the document's compressed Yjs blobs in a short SELECT-only transaction (`readYjsStatePayload` via `captureCollabSource`). That main-thread half is one shared entry, `generateDocumentPreview` in `preview/preview-document.ts` (the `export-document.ts` counterpart); every transform then goes through `runTransformToText` / `runTransformToBytes` (`lib/document/transform/run-transform.ts`), the one main-thread seam that owns capture timing, the operation's deadline, admission, warning surfacing, and failure mapping.
2. `DocumentTransformRunner` (`lib/document/transform/runner.ts`) admits the job: one active Worker, queue of
   16 with foreground (first cache miss) and background (stale regeneration) priorities, foreground admission
   additionally bounded by predicted wait. Overload rejects with `503` (surfaced to the client); background
   overflow is dropped — a later request re-enqueues it. There is **never** a main-thread fallback.
3. The Worker (`lib/document/transform/worker.ts`) materializes the payload and dispatches on document type through dynamic imports into the Worker-pure render modules (`preview/eigen{doc,slides,sheets,vector}-render.ts`, which reach neither the Mount nor the transform seam), so a doc preview never evaluates the sheet engine: sheets replay ops — never recalc: stored values render as-is and a valueless formula cell stays blank, because a legacy never-computed workbook can cost an unbounded recalc (~39s measured) that the 30s deadline would kill on every attempt; only the export read recalcs (SHEETS.md § Server-side recalc) — and render the bounded first-sheet view; doc, slides and vector convert the Yjs roots. Every type resolves its media from a name → URL map the main thread prepared (`buildPreviewUrlMap` — the Worker never sees a Mount): a figure, a slide's image element, a drawing's `<image>` href, a sheet's floating images. Doc and sheets sanitize their assembled body with `sanitizeExportHtml` — the shared ref restriction that keeps only `data:` URIs and the prepared media URLs, so a collaborator's `url(http://…)` cell background or dangling figure `src` can't beacon a viewer (both pass their media URLs as `allowedRefs`); both canvas types sanitize *per element* first — `sanitizeSceneHtml` (`export/sanitize.ts`, shared with the exports) filters each rich-text `html` down to the LightEditor tag set the canvas itself mounts (EXPORT.md § Sanitization and SSRF) before the compositor runs, so the page's own generated markup survives the pass that follows (the reader is the trust boundary for a scene's scalar fields, but not for a rich-text body, which it caps and cleans without filtering tags). All four return the body plus warnings over a typed, closed protocol (`protocol.ts`). Corrupt blobs are skipped with warnings, matching the live-read behavior.
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

- **SVG**: Served as-is (no rasterization). `preview-cache.ts` caches the raw SVG locally for S3 mounts, and runs the stored bytes through `svg-media-inline.ts` first: an `<image href="eigen-media:<name>">` ref is resolved against the file's own folder and inlined as a `data:` URI, because an `<img>`-hosted SVG never fetches external refs. The content type stays `image/svg+xml`, so the route serves it under the sandbox CSP
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
    text:     TextPreviewContent / MailTextPreviewContent (→ one eigen-prose div; the
              eigenvector body is a self-contained page, centred rather than prose-styled)
    vcard:    VCardPreviewContent / MailVCardPreviewContent (→ one ContactDetailCard per card)
    eml:      EmlPreviewContent / MailEmlPreviewContent (→ one MessageView)
    ics:      IcsPreviewContent / MailIcsPreviewContent (→ one EventDetailCard per event)
    fallback: file icon + "No preview available"
  Footer   — Open (a Drive subject), then one button per FILE_ACTIONS row the subject
             qualifies for (Download, Save to Drive…, Convert to Sheet, Convert to
             Document, Import to Contacts, Import to Mail, Import to Calendar), then
             "Save all (n)" for an attachment set
```

**Keyboard:** Escape = close, ArrowLeft/ArrowRight = prev/next sibling.

**Typed-payload quick looks (`.vcf`, `.eml`, `.ics`).** Three formats read as what they hold rather than as their own text: a `.vcf` as contact cards, an `.eml` as the message it carries, an `.ics` as its events. They share one pipeline, so a fourth would be the same handful of files again:

- `getPreviewMode` (`packages/lib/src/core/file-subject.ts`) returns the format's own mode on its predicate, before it reaches the text rule, and `getBytesTextPreviewMode` answers `null` for the same files — which keeps them out of raw-text rendering, out of the inline editor (`isInlineEditable` is a separate list and none of the three is on it), and keeps a path from carrying two cached preview artifacts (`pruneOldVersions` is not format-scoped). Drive-wide content search is a separate list again: a `.vcf` and an `.ics` are indexed (`isSearchableTextFile`), the cards through the Worker payload and the calendar from its raw body.
- A Drive route `GET /drive/:ownerId/:mountId/file/:pathId/<format>-preview` (`routes/drive.ts`) and a mail-part route `.../attachment/:index/preview/<format>` (`routes/mail.ts`) answer with the same shared type. One guard runs before anything else — 400 for a file the mime and the name don't call one of these, 413 past the format's ceiling — on the Drive row before its bytes are read, on the parsed part for mail, whose size is not known until then. A file the parser throws on is a 422 ("Could not read this file"), never a crash and never an empty success.
- `getOrCacheText` (`preview-cache.ts`) caches the Drive answer per file version under the format's own tag, so neither artifact for a path ever reads the other's file as its stale predecessor, and stale-while-revalidate and the long `max-age` work exactly as they do for a text preview (the `.eml` route alone answers `private, no-cache`, because its body is sanitized html). A cached body that no longer parses — a file truncated or half-written on disk — is treated as a corrupt cache file: it is deleted and regenerated, the way every other unreadable cache file in that module is. The read back is a typed assignment on JSON this process wrote itself, the same trust the text preview places in its own cached body, so **the format tag is bumped on every change to the payload type** or a restored `previewsDir` serves the old shape.
- `PreviewPane` (`packages/ui/src/components/drive/preview-pane.tsx`) is the box all three draw into and the three states they reach before their payload: "File too large to preview" with the format's own ceiling named, a `LoadingState`, and "Could not read this file". What is left is the format's own renderer, and whatever "this file holds nothing" means for it.
- The rows a viewer may run come from `useFileActions` (`packages/ui/src/components/file-actions/use-file-actions.ts`), which `useFileActionRunner` reads for every menu and for the overlay's footer. It is the one place that knows who is asking: an import route refuses a guest (`requireNonGuest`) while a registry `applies` is handed the file alone, so every row flagged `guestDenied` is excluded for a guest there. A host's own exclusions (the overlay drops `quick-look`, its own row) ride the same argument.
- `runFileTransformToText` reads the bytes from the Mount and transfers them to the Worker, which builds the payload under the shared `preview` limits; a mail part hands its own bytes to the `getBytes*Preview` beside it instead, because a part has no version stamp to key a cache on. The handler annotates its return with the shared type from `packages/lib/src/types/preview.ts`, so Elysia takes the response type from it and Eden carries it to the component with nothing casting in between — through `plainApi` (`core/api.ts`) for all three, because Eden's reviver would turn a bare `YYYY-MM-DD` birthday, an ISO `date` string or an all-day event's `start` into a `Date` the type does not admit.

| Format | Mode / predicate | Ceiling | Payload type | Worker builder | Cache tag |
|---|---|---|---|---|---|
| `.vcf` | `vcard` / `isVCardFile` | `VCARD_MAX_BYTES` | `VCardPreview` | `preview/vcard-preview.ts` | `VCARD_FORMAT` |
| `.eml` | `eml` / `isEmlFile` | `EML_MAX_BYTES` | `EmlPreview` | `preview/eml-preview.ts` | `EML_FORMAT` |
| `.ics` | `ics` / `isIcsFile` | `ICS_MAX_BYTES` | `IcsPreview` | `preview/ics-preview.ts` | `ICS_FORMAT` |

**vCard quick look.** `VCardPreview` is `{ cards: { contact, categories }[], dropped, total }`. The build decodes UTF-8 with `{ fatal: true }` — another encoding is the shared 422 — splits with `splitVCards`, transcodes and parses no more cards than an import would accept (`VCARD_IMPORT_MAX_CARDS`), counts the cards the parser refuses rather than failing the whole file, and carries the first `VCARD_PREVIEW_MAX_CARDS` (200). Inline `PHOTO` bytes become `data:` URIs through `parsedCardToContact`; a `PHOTO;VALUE=uri` and a non-image media type are dropped rather than fetched, so an untrusted file can't make a viewer's browser call a URL it chose. `VCardPreviewContent` (`packages/ui/src/components/drive/vcard-preview-content.tsx`) renders one `ContactDetailCard` per card with each card's `CATEGORIES` as label badges, and ends on up to two counted lines, "and N more contacts" and "N contacts could not be read", spelled once in `packages/lib/src/core/contacts/preview-lines.ts`. Over the ceiling it shows a "File too large to preview" empty state, on a query error "Could not read this file", and on a file with no readable card "No contacts in this file". The overlay's footer carries an **Import to Contacts** button for a `.vcf` under the import ceiling — the registry row of that name, run by `useFileActionRunner`, which posts the previewed path to `/contacts/:ownerId/import-from-drive` ([CONTACTS.md](CONTACTS.md)) and imports a subject without a Drive path through `useImportContactsFromUrl`, which fetches its bytes in the browser. The drive detail hero reads the same query: `VCardHero` (`packages/ui/src/components/drive/drive-preview.tsx`) shows the first three cards as compact `UserAvatar` + name + first-email rows — the card's own name, never the address book's — and falls back to the file icon over the ceiling, on a read error, and on a file with no readable card.

**`.eml` quick look.** `EmlPreview` is `subject`, `from`, `to`, `cc`, an ISO `date` string, the sanitized `html`, the `text` body, the parts as `{ filename, contentType, size }` and `remainingAttachments`: no part bytes, no `bcc`, no invite summary. The builder parses with `parseMail` — so the parser's own ceilings (`MAX_HEAD_SIZE`, `MAX_CHILD_NODES`) bound the parse, and `inlineCidImages` has already turned a `cid:` reference into a `data:` URI. A forwarded message rides along as a `message/rfc822` part with its own bytes (`mail-parser/split.ts` flattens only an *inline* one into its parent), so the mail-part route previews it like any other part.

The payload is where an untrusted message is made safe to render, because the parser bounds neither its size nor its references. **Size:** one ceiling binds the body, `EML_PREVIEW_MAX_HTML_BYTES` (2 MiB), and it is measured on the sanitizer's **input** — a 12 MiB `text/html` part costs 4.4 GB of RSS inside `DOMPurify.sanitize`, which the Worker thread would pay before any bound on its output applied. A body over it is measured again with its inlined `data:` images stripped — one `cid:` named 200 times is 200 copies of the same image — and only a body still over it becomes `null`, so a message with more inline bytes never shows less than one with fewer. `text` is cut at `EML_PREVIEW_MAX_TEXT_CHARS`, and the parts list stops at `EML_PREVIEW_MAX_ATTACHMENTS` (50) with the rest counted. **References:** the preview makes no network request when it renders, and the mechanism is an allowlist inside the sanitizer's own DOM — never a regex over serialized html, which would void DOMPurify's output guarantee. On top of the reader's config (`READER_SANITIZE_CONFIG` in `mail-parse.ts`, which the preview spreads so the `<form>` rule is stated once), `FORBID_TAGS` drops `svg`, `math`, `video`, `audio`, `source`, `track`, `input`, `button` and `picture` beside `form`; an `afterSanitizeAttributes` hook removes every URL-bearing attribute (`src`, `srcset`, `poster`, `background`, `href` off an `<a>`, `xlink:href`, `action`, `formaction`, `ping`, `cite`, `longdesc`, `usemap`, `data`) whose value is not an inline raster image — `data:image/` `png`, `jpeg`, `jpg`, `gif`, `webp`, `avif` or `bmp`, because an SVG or HTML `data:` URI is a document tree of its own — and forces `target="_blank"` + `rel="noopener noreferrer"` on every `<a>`, keeping only `http:`, `https:` and `mailto:` links; a `style` attribute or `<style>` element is dropped whole when its text holds a backslash, `@import`, `image-set`, `image(`, `cross-fade`, `element(`, or any `url(` token not followed by one of those raster `data:` images. Both CSS rules read a **token**, never a well-formed `url()` pair: a CSS escape spells `url(` invisibly to a regex (`u\72l(`), and an unterminated `url(https://…` at the end of a declaration, a sheet or a quoted string still fetches — so `url(` decides, and a quick look can afford the fidelity loss. The hooks are added and removed around the one synchronous call, because DOMPurify's hooks are global to the instance. The hostile corpus that pins all of it is `apps/api/src/test/preview/eml-preview.test.ts`; **bump `EML_FORMAT` on every DOMPurify upgrade**, or cached bodies keep whatever the previous sanitizer let through.

`MessageView` (`packages/ui/src/components/mail/message-view.tsx`) draws it — the mail reader's own header and body, extracted, so a saved message reads exactly as the message it was ([MAIL.md](MAIL.md)). `EmlPreviewContent` (`packages/ui/src/components/drive/eml-preview-content.tsx`) hands it the payload plus the parts as plain `SimpleAttachmentChip`s labelled "name · size" and no actions — the payload carries no bytes to download or preview — and ends on "and N more attachments" when `remainingAttachments` is set, spelled once in `packages/lib/src/core/mail/preview-lines.ts`. The overlay's footer carries an **Import to Mail** button for an `.eml` under the ceiling — the registry row of that name, run by `useFileActionRunner`, which posts the previewed path to `/mail/:ownerId/import-from-drive` and imports a subject without a Drive path through `useImportMailFromUrl`, which fetches its bytes in the browser. The drive detail hero reads the same query: `EmlHero` (`packages/ui/src/components/drive/drive-preview.tsx`) shows what a mail list row shows — sender, date, subject, the first lines of the text body — and falls back to the file icon on a read error.

**`.ics` quick look.** `IcsPreview` is `{ method?, events, dropped, total }`, and each event carries what a calendar card draws: `uid`, `title`, `description`, `location`, `start`, `end`, `allDay`, `timezone`, `rrule`, `status`, `organizer`, `attendees` and `remainingAttendees`. Nothing in it is relative to now — the payload is cached per file version, so it must not depend on the clock, and the card describes the recurrence from the `rrule` itself. `start` and `end` are declared as strings: an ISO instant, or a bare `YYYY-MM-DD` with the exclusive end the calendar domain stores when the event is all-day. The builder runs the one canonical parser, `parseIcs` (`caldav/ical-parse.ts`, [CALENDAR.md](CALENDAR.md)), on a `{ fatal: true }` UTF-8 decode, and lists **masters only** — an override VEVENT and the synthetic cancelled row an EXDATE becomes belong to their series, which the master's own `rrule` already says. `total` counts the masters, `events` keeps the first `ICS_PREVIEW_MAX_EVENTS` (200) sorted by start and `dropped` counts the masters the builder could not read — a surface derives what is merely past the cap as `total - dropped - events.length`, the way the `.vcf` payload is read; per event, `description` is cut at `ICS_PREVIEW_MAX_DESCRIPTION_CHARS` and `attendees` at `ICS_PREVIEW_MAX_ATTENDEES` with `remainingAttendees` counting the rest, so 200 events stay a small payload. An event whose start or end year falls outside 1–9999 is one of the masters `dropped` counts: `toISOString` spells such a year with a sign and six digits ("+010007-06-07T…"), which the card would print as an invalid date, and a `DTSTART;VALUE=DATE:99999999` normalizes its month and day into the year that way. Nothing the file points at reaches the card: `parseIcs` keeps what the event columns model, so an `ATTACH`, a `URL` and a directory reference are never in the payload to be fetched, and the builder lists an `ORGANIZER` or an `ATTENDEE` only when its value is a plain address (`validateEmailAddress`, the shared validator) — a CAL-ADDRESS is a URI, so `javascript:alert(1)` and `http://…` are addresses the card would write a `mailto:` link from otherwise; such an organizer is `null` and such an attendee is omitted, not one more in `remainingAttendees`.

`EventDetailCard` (`packages/ui/src/components/calendar/event-detail-card.tsx`) draws one event — when, recurrence, location, description, guests — and is the same card the calendar app's detail dialog renders for its read-only body, so a file's event reads exactly as a stored one ([CALENDAR.md](CALENDAR.md)). Its bounds are `Date`s, because `formatEventWhen` takes instants: `IcsPreviewContent` (`packages/ui/src/components/drive/ics-preview-content.tsx`) is the one seam where the payload's strings become them. It heads the list with a banner naming the file's `method` when it declares one ("Calendar invitation", "Calendar RSVP response", "Calendar cancellation", spelled once in `packages/lib/src/core/calendar/preview-lines.ts`) — a METHOD belongs to the file, not to one of its events — and ends on "and N more events" when `dropped` is set. Over the ceiling it shows a "File too large to preview" empty state, on a query error "Could not read this file", and on a file with no listable event "No events in this file". The overlay's footer carries an **Import to Calendar** button for an `.ics` under the ceiling — the registry row of that name, which opens the target picker before it imports ([CALENDAR.md](CALENDAR.md)). The drive detail hero reads the same query: `IcsHero` (`packages/ui/src/components/drive/drive-preview.tsx`) shows the first three events as title + when, and falls back to the file icon on a read error and on a file with no listable event.

**The subject and its actions.** The overlay acts on a `FileSubject` (`packages/lib/src/types/file-subject.ts`): the identity of one file and nothing that follows from it — the `DrivePath` when a Drive item is what holds it, or a `mail` reference (`{ ownerId, messageId, index }`) plus the part itself when a mail part is, the source identity a write route needs, never parsed back out of a key. `subjectFromPath` (`packages/lib/src/core/file-subject.ts`) is the only place a Drive item becomes one and `subjectFromMailAttachment(ownerId, messageId, index, att)` beside it the only place a mail part does. `subjectInfo(subject)` beside them is the one derivation: the key siblings are matched on (`drive:{ownerId}:{mountId}:{id}` or `mail:{ownerId}:{messageId}:{index}`), the name, the mime, the size and the URLs to embed, download and thumbnail it. So no surface composes a preview route by hand, and nothing the path already says is stored a second time where it could disagree with it; a surface that needs several of those fields calls `subjectInfo` once and destructures. A mail subject carries the RAW part index the two mail byte routes address, calendar parts counted, so a reader that hides those still names the part it means. A Drive subject also carries `readOnly` when the listing that built it cannot be written to (`subjectFromPath(path, capabilities)` from the view's `DriveCapabilities.canWrite`), which is what keeps the two convert rows out of a watched feed's menus, detail kebab and preview footer: the convert route writes the new document into the source folder. An attachment is exempt — its convert saves through the picker first. `openPreview(subject, siblings?)` takes the siblings ← → pages through; a subject built by `useAttachmentSubjects` or `subjectFromMailAttachment` carries `attachment: true`, saying it is a container's or message's attachment rather than a file at a Drive location. Two things follow: they are a set to act on as a whole, which is what draws the "Save all (n)" row, and their Drive copies (a chat or card attachment lives in a hidden media folder) are not where a user would want a converted file, which is why a convert on one saves through the picker first. A Drive listing hands over its whole folder for navigation with no `attachment` flag, so the overlay never offers to copy a folder onto itself; the mail reader and the chat and card chips build attachment subjects. What may be done with a subject is the registry `FILE_ACTIONS` (`packages/lib/src/core/file-actions.ts`), read through `fileActionsFor(subject, exclude?)` — each row's `applies` predicate reads the derived facts and, for Quick Look and Save to Drive, the identity behind them — `fileActionsFor` derives once for the whole list — never which surface is asking. The overlay draws one footer button per row, excluding `quick-look`, being Quick Look itself. Every menu draws those rows through `FileActionMenuItems` (`packages/ui/src/components/file-actions/file-action-menu-items.tsx`), the one place a file action is a menu row: every menu draws every applicable row; `save-to-drive` declines a file already at a Drive location, whose item menu has its own "Copy to…". The component takes the runner rather than building one — a menu's content unmounts when it closes, so the picker a row opens has to be mounted by the host above it, and the rows come from `runner.subject` so a host can never pair one menu with another's subject. `useFileActionRunner(subject, siblings?)` (`packages/ui/src/components/file-actions/use-file-action-runner.tsx`) performs a row and owns both the `SaveToDrivePicker` and the conversion progress dialog its host mounts through `runner.dialogs`: the footer's own Save to Drive row opens the picker on the previewed subject, and the "Save all" row opens it on the downloadable siblings through `runner.openPicker(subjects)`. The subject is nullable, for a host whose subject is state — the right-clicked chip, the right-clicked row — and the quick-look row hands the same subjects to the overlay, so a chip's menu opens it with the same "Save all" row its click does. A convert row on a subject that has no Drive path to convert, or one whose path is a container's media copy, opens the picker instead: the runner remembers the target type and the row's label, so the picker asks under that label with **Save and convert** as its confirm button, and the paths it reports through `onSaved` are what `useConvertDocument` then runs on, one call per created file, with the picked folder as the parent. The progress dialog is the same one an in-place convert shows. Footer buttons disable while `runner.isPending`, and the overlay's focus trap hands focus over while `runner.isDialogOpen`. `SaveToDrivePicker` (`packages/ui/src/components/drive/save-to-drive-picker.tsx`) is the "where does this go" dialog: a Drive subject is copied server-side so its bytes never travel, a mail subject is written from the message the server still holds (`useSaveMailAttachmentsToDrive`, one call carrying the message id and every index), "Download instead" falls back to a staggered browser download, and it renders above the preview overlay via the `abovePreview` prop on `DialogContent`. Siblings always come from one surface, so a batch is all Drive items or all mail parts: the first subject picks the branch and the rest ride it, and there is no mixed case to handle. Both branches toast what they saved with an "Open folder" action, and both report the created `DrivePath`s through `onSaved`.

**The chip menu.** An attachment chip reaches the singleton context menu through `useAttachmentChipMenu` (`packages/ui/src/components/attachment/use-attachment-chip-menu.ts`), shared by the mail reader, the chat message list and the card dialog. The host gives it one callback that turns the row the press belongs to and the key of the chip under the pointer into a menu item, returning `undefined` when there is no menu to open, and spreads the handlers it gets back on the element holding the chips. It owns the right-click (left alone on a link that is not a chip, and on a text selection the press landed in, so the browser's own menu still appears), the touch long-press through `useLongPress` (reporting back whether it opened anything, so a press that resolved no chip doesn't swallow the click that follows), and the pointer-down capture that records which chip the finger started on, because a long-press only reports where it started. The menu content stays with the host: a chip list draws `FileActionMenuItems` alone, chat draws the message's own rows under them.

**Progressive image loading:** For images with thumbnails, `ProgressiveImage` stacks two `<img>` elements — the 512px
thumbnail renders instantly while the screen-resolution preview (max 2560px) loads on top. Both use `object-contain`
within a fixed-size container so there's no size change when the preview loads. Images without thumbnails load the
preview directly. The container is sized from the aspect ratio the Drive row carries; a subject that has none — a mail
part stores no width or height — falls back to the loaded image's own `naturalWidth / naturalHeight`, measured in the
full image's `onLoad`. Until something loads the box spans the viewport, which is invisible because nothing is drawn in
it yet; once the box hugs the image, a click beside it reaches the backdrop that closes the overlay. The component is
keyed on the preview URL, so paging to a sibling starts from an unmeasured box rather than the previous image's.

**PreviewProvider** stores the subject + `siblings[]` and exposes `openPreview(subject, siblings?)`, `updatePreview(subject)` and `closePreview()`. `FilePreview` derives the rest on render: the preview URL (the transcode route for a Drive subject, the `embedUrl` `subjectInfo` returns otherwise), the aspect ratio, the preview mode and the prev/next state.

`previewMode` is decided client-side by `getPreviewMode(subject)` (`packages/lib/src/core/file-subject.ts`, beside the subject builder) from the mime prefix, `application/pdf`, `isExiftoolExtension(name)`, `isVCardFile`, `isEmlFile`, `isIcsFile` and the text gate. That last one mirrors the routes: a Drive container (`isCollabType` on the row's TYPE) renders from its Yjs body and answers to `getTextPreviewMode`, and everything else — a plain file, a mail part — answers to `getBytesTextPreviewMode`, so an eigen mime on loose bytes gets the fallback card rather than a text panel the route would 404. The image branch needs a mount to resize from, so it gates on `subject.drive`; without one the `<img>` points at the original bytes, which makes it an image preview only for a mime in `BROWSER_IMAGE_MIMES` (`packages/lib/src/constants/preview.ts`) — a HEIC gets the fallback card instead of a broken box. The `text` and `vcard` branches gate on carrying either identity, `drive` or `mail`, because both have a route that renders them; `eml` and `ics` answer for both identities too.

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
| `apps/api/src/routes/drive.ts`                                            | `/preview` + `/text-preview` + `/vcard-preview` + `/eml-preview` + `/ics-preview` routes |
| `apps/api/src/routes/mail.ts`                                             | `/attachment/:index/preview/text` + `/preview/vcard` + `/preview/eml` + `/preview/ics` for one mail part |
| `packages/lib/src/core/mail/hooks/use-attachment-preview.ts`              | `useMailTextPreview()` + `useMailVCardPreview()` hooks  |
| `packages/ui/src/styles/eigen-prose.css`                                  | Shared prose + code highlight styles             |
| `packages/ui/src/components/drive/file-preview.tsx`                | Preview overlay component                        |
| `packages/lib/src/types/file-subject.ts`                                  | `FileSubject`: the one file shape every surface acts on |
| `packages/lib/src/core/file-subject.ts`                                   | `subjectFromPath()` + `subjectFromMailAttachment()` + `getPreviewMode()` |
| `packages/lib/src/core/file-actions.ts`                                   | `FILE_ACTIONS` + `fileActionsFor()`: what may be done with a subject |
| `packages/ui/src/components/file-actions/use-file-action-runner.tsx`      | Runs a registry row; owns the host's one `SaveToDrivePicker` |
| `packages/ui/src/components/attachment/use-attachment-chip-menu.ts`       | Chip right-click + long-press → the singleton context menu |
| `packages/ui/src/components/drive/save-to-drive-picker.tsx`               | "Save to Drive" dialog, with the browser download as the escape hatch |
| `apps/api/src/lib/preview/vcard-preview.ts`                                | The `VCardPreview` payload: the Worker-side card builder (first 200 cards) and the cache-read parse |
| `apps/api/src/lib/preview/eml-preview.ts`                                  | The `EmlPreview` payload: the Worker-side message builder, its allowlist sanitizer and the cache-read parse |
| `apps/api/src/lib/preview/ics-preview.ts`                                  | The `IcsPreview` payload: the Worker-side event builder (masters only, first 200) and the cache-read parse |
| `packages/lib/src/types/preview.ts`                                        | `TextPreviewResult` + `VCardPreview` + `EmlPreview` + `IcsPreview`: the shapes the preview routes serve |
| `packages/ui/src/components/drive/vcard-preview-content.tsx`       | `.vcf` quick look: the served cards as `ContactDetailCard`s |
| `packages/ui/src/components/drive/eml-preview-content.tsx`         | `.eml` quick look: the served message as a `MessageView` |
| `packages/ui/src/components/drive/ics-preview-content.tsx`         | `.ics` quick look: the served events as `EventDetailCard`s, under the method banner |
| `packages/ui/src/components/drive/preview-pane.tsx`                | The pane a typed-payload quick look fills, and its too-large / loading / unreadable states |
| `packages/ui/src/components/mail/message-view.tsx`                 | One message drawn from data alone: the mail reader's and the `.eml` quick look's |
| `packages/ui/src/components/calendar/event-detail-card.tsx`        | One event drawn from data alone: the detail dialog's and the `.ics` quick look's |
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
