# File Previews

> **TLDR:** The API renders previews of Drive files and mail parts for the quick-look overlay and the drive hero, in `apps/api/src/lib/preview/`. Four things are not obvious: every cached preview is keyed by the file's version and a renderer format tag; the JSON previews serve the previous version while the current one regenerates; an Eigen document previews a small slice inside the one-shot transform Worker, never on the event loop; and no preview body may fetch a URL the file chose. The `.vcf`, `.eml` and `.ics` quick looks have [PREVIEW-PAYLOADS.md](PREVIEW-PAYLOADS.md), the overlay and its actions [FILE-ACTIONS.md](FILE-ACTIONS.md).

## Each kind of file gets one kind of preview

| The file | Its preview | Route |
|---|---|---|
| An image | A WebP of at most 2560 px, or an SVG as it is | `/preview` |
| Video, audio, PDF | A redirect to the original bytes, served inline | `/preview` → `/embed` |
| Text, code, markdown, an Eigen document | JSON `{ body, mode }`, an HTML body the client renders | `/text-preview` |
| A `.vcf`, `.eml`, `.ics` | JSON of the cards, the message or the events | `/{vcard,eml,ics}-preview` |
| An image or a video, in a list | A 512 px WebP thumbnail, made on upload | `/thumb/:fileName` |

The server renders every body, so the frontend stays a plain container and every surface draws the same result. The types the routes serve live in `packages/lib/src/types/preview.ts`. The modes and the text gate live in `packages/lib/src/constants/preview.ts`.

## The cache key is the file version and the format tag

Every preview is a file in `mount.previewsDir`, named `{pathId}-{updatedAt}.{format}.json` (images: `.screen.webp` or `.screen.svg`). A new version writes a new file rather than overwriting the old one, which is what lets a versioned URL be cached for long. After each write, `pruneOldVersions` deletes the path's other versions fire-and-forget. A sweep at `mount.init()` removes anything older than seven days, for paths written once and never again.

The format tag (`TEXT_FORMAT` and its siblings in `preview-cache.ts`) names the shape of the renderer's output. **Bump it whenever the generated HTML changes shape.** A bump makes every cached body a miss even though `updatedAt` did not move.

Every write goes through a dot-prefixed temp file and a rename (`writeCacheFile`). A read deletes a cache file it cannot parse, so a reader that caught a half-written file would delete the regeneration that just landed.

## JSON previews revalidate, images ride a versioned URL

An image preview and a thumbnail carry `?v=<updatedAt>` in their URL, so they are served with a one-day `max-age`. A new version is a new URL.

The JSON routes revalidate instead, through `answerPreview` (`apps/api/src/lib/core/http.ts`). The ETag is the file's own etag plus the format tag, so a format bump reaches a browser that already holds a body. A matching `If-None-Match` gets a 304 before anything generates. **Only a generated body carries the ETag and `private, no-cache`.** A 404 or a renderer error goes out without a validator: a browser would store the error with it, and every later 304 would bring that error back.

The `/text-preview` URL carries `updatedAt` as a query parameter. Both the browser cache and the TanStack query key derive from the URL, so a URL without the stamp would serve stale content after an inline edit.

## A new version serves the old body while it regenerates

When the current version is a miss but an older one is cached, `getOrCacheText` serves the older body at once, marked `Cache-Control: no-store`, and regenerates the current one in the background. A failed regeneration leaves the old file in place, and a later request retries. Only an older body in the current format qualifies: a body from another format has another shape, and the client would lay it out wrong.

Generations are shared per cache name, the first one and the background one alike. A folder of twenty tiles for one just-edited document triggers one render, not twenty. A first miss runs at foreground priority in the transform runner. A background regeneration may be dropped under load, which is safe because the next request enqueues it again.

`useTextPreview` has a 30 s `staleTime`. After it, the next window focus or remount fetches again and picks up the fresh body the server has written by then.

## Loose bytes preview as what their name says

`getTextPreview` decides on the **container type**, never the mime. A collab container renders from its Yjs document. Everything else renders from its bytes through `getBytesTextPreviewMode`, because a mime is the uploader's or the sender's word. A plain file wearing an Eigen mime must not be drawn inside an A4 page or a slide frame it does not hold.

Loose bytes render in one of three modes. Markdown goes through markdown-it with raw HTML off. Code goes through lowlight. Plain text becomes `<p>` paragraphs, not `<pre>`, because `eigen-prose` paints every `<pre>` as a dark code block and a `.txt` should read like prose.

One ceiling bounds every loose-bytes preview, Drive and mail alike: `TEXT_PREVIEW_MAX_BYTES` (1 MiB). The decode and the highlighter run on the API event loop, per request. Drive refuses on the row's `size` before it reads a byte. A container is not measured against it, because its size is its databases, not the body the Worker renders. `getPreviewMode` on the client applies the same gate, so the overlay shows the file card rather than a panel the route would 404.

## An Eigen document previews a slice, off the event loop

The four collab types render in the one-shot document-transform Worker. The main thread checks access, captures the compressed Yjs state and builds the media URL map (`generateDocumentPreview`, `preview-document.ts`). The Worker renders the body in `preview/eigen{doc,slides,sheets,vector}-render.ts`. Admission, the 30 s deadline, the 503 on overload and the rule that there is never a main-thread fallback are in [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md).

A preview is a glance, so each type stops at its natural unit and leaves the export renderers whole:

| Type | Cap |
|---|---|
| eigendoc | first 20 top-level blocks |
| eigenslides | first 8 slides, 500 elements |
| eigenvector | 500 elements in reading order, one page |
| eigensheets | first sheet, 200 rows × 50 columns, 10,000 cells |

A sheets preview never recalculates. It renders stored values, because a never-computed legacy workbook can cost more than the deadline. The sheet window also bounds declared spans: one merge or conditional-format range can name millions of cells, so both clip to the window.

The caps count units, and one enormous block passes all of them. So `applyPreviewByteGuard` replaces any body over 8 MB with the truncation marker, never with a sliced string. The marker is inline-styled because a preview body is embedded without a `<head>`.

## No preview body may fetch a URL the file chose

A body renders as live DOM in the viewer's browser. A collaborator's `<img src=https://…>` or `url(https://…)` would tell a third party who opened the folder. So every HTML body passes `sanitizeExportHtml`, which keeps only `data:` URIs and the media URLs the main thread prepared (`allowedRefs`). Markdown takes the same pass. A canvas body is filtered twice: each rich-text box through `sanitizeSceneHtml` before the compositor runs, then the assembled page, so the compositor's own media hrefs and gradient refs survive.

An SVG is served as its own bytes under the sandbox CSP, not rasterised. An `eigen-media:` image inside it is inlined as a `data:` URI first (`svg-media-inline.ts`), because an SVG shown in an `<img>` never fetches a reference.

## Images convert through sharp first

`generateImagePreview` (`apps/api/src/lib/shared/thumbnails.ts`) runs in a Worker and makes both the 512 px thumbnail and the 2560 px screen preview. It tries sharp, then `heic-convert` for HEIC, then the JPEG exiftool finds embedded in a RAW, PSD or AI file. `isExiftoolCandidate` gates it.

A video thumbnail is a frame ffmpeg takes at one second, or at zero for a shorter clip, resized like an image. ffprobe adds width, height and duration to the file's details. Without ffmpeg the upload still succeeds, just without a thumbnail.

## A mail part previews through the same renderers

The mail preview routes (`routes/mail.ts`) end in the bytes-in entry points beside the cached ones: `getBytesTextPreview` and its three typed siblings. A part has no version stamp to key a cache on, so nothing is cached server-side. `answerMailPart` builds the ETag from the message and the format tag, stamped only on a produced body. A part decodes with the charset its sender declared. Why the routes sit two segments past the part index is in [MAIL.md](MAIL.md).

## The client draws the body as live DOM

The overlay and the drive hero render a body with `dangerouslySetInnerHTML`, with no iframe and no shadow root, so it takes the app's styles. Text and documents sit in `.eigen-prose` (`packages/ui/src/styles/eigen-prose.css`), which the docs editor shares.

Two bodies bring their own box. A deck and a drawing are compositor pages composed at `CANVAS_PREVIEW_WIDTH`, so the hero scales them from a known width with no wrapper class. A sheet is a bare grid whose floating images sit at declared pixels, so `.eigensheets-preview` in `globals.css` undoes the two app rules that would move the grid under them.

Drive's inline editor shows the same body read-only and loads Tiptap or CodeMirror only on Edit (`apps/drive/src/components/editor/native-file-editor.tsx`).

## See also

- [PREVIEW-PAYLOADS.md](PREVIEW-PAYLOADS.md): the `.vcf`, `.eml` and `.ics` quick looks
- [FILE-ACTIONS.md](FILE-ACTIONS.md): the overlay, `FileSubject` and the file-action registry
- [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md): the Worker, its admission and its benchmark
- [EXPORT.md](EXPORT.md): the full-document renderers the previews share
