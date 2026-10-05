# File Previews and File Actions

> **TLDR:** Two things live together: the previews the API renders of Drive files and mail parts, and the one set of actions every surface offers on a file, the quick-look overlay included. The previews are `apps/api/src/lib/preview/`, and the actions are `packages/lib/src/core/file-actions.ts` and `packages/ui/src/components/file-actions/`.

A preview is what a user sees of a file without opening it in its app: a tile in a Drive grid, the hero at the top of Drive's detail column, and the quick-look overlay that Space or Quick preview opens over a list. The server renders every image, text and document preview and the browser only shows it, so every surface draws the same result. Video, audio and PDF play from the original bytes. A Drive preview is cached in a folder of its mount and is never the truth: it can be thrown away and rendered again from the file.

The same file shows up in many places: a Drive listing, the mail reader, a chat message, a stickies card. Each place offers the same actions on it, such as Quick preview, Download, Save to Drive, the converts and the imports. So a file is passed around as a file subject (`FileSubject`), which holds what identifies it: a Drive path, or a mail message and the index of one of its parts, with that part's name, type and size. The surface that holds the file adds two flags: `attachment` for a file a message or document carries, and `readOnly` where the viewer cannot write beside it. Everything else is derived from that. One registry, `FILE_ACTIONS`, lists the actions, and each one decides from the subject alone whether it applies. The file-action runner performs one, and the host, the surface that draws the menu, mounts the dialogs a row opens.

Two more terms come back. A format tag names the shape of a renderer's output and is part of the cache key. A slice is the part of an Eigen document a preview renders: its first blocks, slides or rows.

The sections run from the server to the screen: what each kind of file previews as, the cache and how a browser revalidates it, text and Eigen-document bodies, images, mail parts, the `.vcf`, `.eml` and `.ics` quick looks and how the client draws a body. Then file subjects, the action registry and its runner, Save to Drive, and the overlay and its keys. Five things in them surprise people:

- A cached preview is keyed by the file's version and a format tag, and the tag is bumped on every change to the output's shape ([§ The cache key](#the-cache-key-is-the-file-version-and-the-format-tag)).
- A new version serves the old body while it regenerates ([§ A new version serves the old body](#a-new-version-serves-the-old-body-while-it-regenerates)).
- An Eigen document previews only a slice, rendered in the document-transform Worker, a one-shot Worker that keeps the render off the API's event loop ([§ An Eigen document previews a slice](#an-eigen-document-previews-a-slice-off-the-event-loop), [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)).
- No preview may fetch a URL the file chose ([§ No preview body may fetch a URL](#no-preview-body-may-fetch-a-url-the-file-chose)).
- The host mounts the action dialogs, because a menu unmounts when it closes ([§ The host mounts the runner's dialogs](#the-host-mounts-the-runners-dialogs)).

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

The format tag (`TEXT_FORMAT` and its siblings in `preview-cache.ts`) names the shape of the renderer's output. **Bump it whenever the output changes shape.** A bump makes every cached body a miss even though `updatedAt` did not move. A cached typed payload is JSON this process wrote, and reading it back is a typed assignment nothing checks, so a payload type change without a bump makes a restored `previewsDir` serve the old shape. Bump `EML_FORMAT` on every DOMPurify upgrade too: a cached message is HTML the previous sanitizer filtered.

Every write goes through a dot-prefixed temp file and a rename (`writeCacheFile`). A read deletes a cache file it cannot parse, so a reader that caught a half-written file would delete the regeneration that just landed.

## JSON previews revalidate, images ride a versioned URL

An image preview and a thumbnail carry `?v=<updatedAt>` in their URL, so they are served with a one-day `max-age`. A new version is a new URL.

The JSON routes revalidate instead, through `answerPreview` (`apps/api/src/lib/core/http.ts`). The ETag is the file's own etag plus the format tag, so a format bump reaches a browser that already holds a body. A matching `If-None-Match` gets a 304 before anything generates. **Only a generated body carries the ETag and `private, no-cache`.** A 404 or a renderer error goes out without a validator: a browser would store the error with it, and every later 304 would bring that error back.

The `/text-preview` URL carries `updatedAt` as a query parameter. Both the browser cache and the TanStack query key derive from the URL, so a URL without the stamp would serve stale content after an inline edit.

## A new version serves the old body while it regenerates

When the current version is a miss but an older one is cached, `getOrCacheText` serves the older body at once, marked `Cache-Control: no-store`, and regenerates the current one in the background. A failed regeneration leaves the old file in place, and a later request retries. Only an older body in the current format qualifies: a body from another format has another shape, and the client would lay it out wrong.

Generations are shared per cache name, the first one and the background one alike. A folder of twenty tiles for one just-edited document triggers one render, not twenty. A first miss runs at foreground priority in the document-transform runner ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)). A background regeneration may be dropped under load, which is safe because the next request enqueues it again.

`useTextPreview` and the three typed quick-look hooks (`useVCardPreview`, `useEmlPreview`, `useIcsPreview`) have a 30 s `staleTime`. After it, the next window focus or remount fetches again and picks up the fresh body the server has written by then.

## Loose bytes preview as what their name says

`getTextPreview` decides on the **container type**, never the mime. A collab container renders from its Yjs document. Everything else is loose bytes, a plain file whatever its mime, and renders from its bytes through `getBytesTextPreviewMode`, because a mime is the uploader's or the sender's word. A plain file wearing an Eigen mime must not be drawn inside an A4 page or a slide frame it does not hold.

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

A sheets preview never recalculates and renders stored values ([SHEETS.md § The editor computes on write](SHEETS.md#the-editor-computes-on-write-the-server-only-what-nobody-computed)). The sheet window also bounds declared spans: one merge or conditional-format range can name millions of cells, so both clip to the window. So an aggregate rule (data bars, color scales, top-N, duplicates) takes its extremes over the window, not over the range it declares.

The caps count units, and one enormous block passes all of them. So `applyPreviewByteGuard` replaces any body over 8 MB with the truncation marker, never with a sliced string. The marker is inline-styled because a preview body is embedded without a `<head>`.

## No preview body may fetch a URL the file chose

A body renders as live DOM in the viewer's browser. A collaborator's `<img src=https://…>` or `url(https://…)` would tell a third party who opened the folder. So every Eigen-document body and every markdown body passes `sanitizeExportHtml`, which keeps only `data:` URIs and the media URLs the main thread prepared (`allowedRefs`). A code or plain-text body is HTML-escaped instead (`text-preview.ts`), so it holds no tag of the file's own. A canvas body is filtered twice: each rich-text box through `sanitizeSceneHtml` before the compositor (the server renderer that turns a scene into HTML, [EXPORT.md](EXPORT.md)) runs, then the assembled page, so the compositor's own media hrefs and gradient refs survive.

An SVG is served as its own bytes under the sandbox CSP, not rasterised. An `eigen-media:` image inside it is inlined as a `data:` URI first (`svg-media-inline.ts`), because an SVG shown in an `<img>` never fetches a reference.

## Images convert through sharp first

`generateImagePreview` (`apps/api/src/lib/shared/thumbnails.ts`) runs in a Worker and makes both the 512 px thumbnail and the 2560 px screen preview. It tries sharp, then `heic-convert` for HEIC, then the JPEG exiftool finds embedded in a RAW, PSD or AI file. `isExiftoolCandidate` gates it.

An uploaded SVG's thumbnail and an SVG avatar are rasterized through sharp. Its bundled librsvg ignores external references, so an SVG can't make the server fetch a URL or read a local file.

A video thumbnail is a frame ffmpeg takes at one second, retried at zero when that fails, resized like an image. ffprobe adds width, height and duration to the file's details. Without ffmpeg the upload still succeeds, just without a thumbnail.

## A mail part previews through the same renderers

The mail preview routes (`routes/mail.ts`) end in the bytes-in entry points beside the cached ones: `getBytesTextPreview` and its three typed siblings. A part has no version stamp to key a cache on, so nothing is cached server-side. `answerMailPart` builds the ETag from the message and the format tag, stamped only on a produced body. A part decodes with the charset its sender declared. Only an inline forwarded `message/rfc822` is flattened into its parent; a non-inline one is a part of its own, which the `.eml` route previews. Why the routes sit two segments past the part index is in [MAIL.md](MAIL.md).

## A `.vcf`, an `.eml` and an `.ics` preview as what they hold

A `.vcf` is mostly base64 photo, an `.ics` is folded property lines, and an `.eml` is headers, boundaries and base64. None of them reads well as text. So `getBytesTextPreviewMode` answers `null` for all three, and `getPreviewMode` gives each its own mode before it reaches the text rule. That also keeps each path at one cached artifact, which matters because `pruneOldVersions` is not format-scoped. The builders live in `preview/{vcard,eml,ics}-preview.ts` and run in the transform Worker.

| Format | Mode and predicate | Ceiling | Payload | Cache tag |
|---|---|---|---|---|
| `.vcf` | `vcard`, `isVCardFile` | `VCARD_MAX_BYTES` | `VCardPreview` | `VCARD_FORMAT` |
| `.eml` | `eml`, `isEmlFile` | `EML_MAX_BYTES` | `EmlPreview` | `EML_FORMAT` |
| `.ics` | `ics`, `isIcsFile` | `ICS_MAX_BYTES` | `IcsPreview` | `ICS_FORMAT` |

Each format has a Drive route (`/drive/…/file/:pathId/<format>-preview`) and a mail-part route (`/mail/…/attachment/:index/preview/<format>`). One guard runs first: a 400 for a file that isn't the format, a 413 past the ceiling. Drive checks the row before it reads the bytes. A file the parser throws on is a 422, "Could not read this file", never a crash or an empty success. The ceiling is the import's, because the preview parses the whole file the way an import does. An `.ics` also meets the import's event ceiling, `ICS_IMPORT_MAX_EVENTS`, counted on the text before the parser runs, and past it answers 413: ical.js caches a TZID it found but never one it missed, so a file of events naming an undefined zone rescans itself once per event. Drive caches the payload through the same `getOrCacheText` the text preview uses.

Search follows the same split. A `.vcf` indexes the names in its cards and an `.ics` its raw body, but an `.eml` is not content-indexed under any mime ([SEARCH.md](SEARCH.md)).

## The typed payloads share one client path

The client reads all six routes through `plainApi` (`packages/lib/src/core/api.ts`). Eden's default reviver would turn a bare `YYYY-MM-DD` birthday, an ISO `date` or an all-day `start` into a `Date` the type does not admit. `PreviewPane` (`packages/ui/src/components/drive/preview-pane.tsx`) is the box all three draw into, with the too-large, loading and unreadable states they share. A query that is still disabled, because the owner is unknown until auth settles, shows the loader and not an error.

`dropped` means the same in all three payloads: what the parser could not read. What a payload merely does not list is `total - dropped - listed`, which the surface derives. The counted lines under the cards, "and N more" and "N could not be read", come from `remainingLine` and `unreadableLine` in `packages/lib/src/core/transfer.ts`.

## The `.eml` payload is where a message is made safe

The mail parser bounds neither the size of a body nor its references, so the builder does both.

**Size.** `EML_PREVIEW_MAX_HTML_BYTES` (2 MiB) is measured on the sanitizer's input, not its output. A 12 MiB `text/html` part costs 4.4 GB of RSS inside `DOMPurify.sanitize`, which the Worker would pay before an output bound applied. A body over the ceiling is measured again without its inlined `data:` images, since one `cid:` named 200 times is 200 copies. Only a body still over it becomes `null`, so a heavier message never shows less than a lighter one.

**References.** The preview makes no network request when it renders. The rule is an allowlist inside DOMPurify's own DOM, because a regex over serialized HTML would void the sanitizer's output guarantee. On top of the reader's config it forbids `svg`, `math`, media, `picture` and form controls. It removes every URL attribute that is not an inline raster image, since an SVG or HTML `data:` URI is a document of its own. Links keep only `http:`, `https:` and `mailto:`, and open in a new tab.

**CSS** is refused on a token, never on a well-formed `url()` pair. A CSS escape spells `url(` invisibly to a regex (`u\72l(`), and an unterminated `url(` still fetches. The check also reads the text a viewer's color-scheme deletion would leave: removing `@media (prefers-color-scheme: dark){}` from `ur@media …{}l(https://…)` rejoins a `url(`. A `<style>` sheet loses only its top-level statements that fetch, so the layout beside them stays. The kept text is checked again whole, and a sheet that still fetches is emptied. The hooks are added and removed around one synchronous call, because DOMPurify's hooks are global. `apps/api/src/test/preview/eml-preview.test.ts` is the hostile corpus that pins all of it.

## An `.ics` preview lists masters only

The builder runs the one parser, `parseIcs` ([CALENDAR.md](CALENDAR.md)), on a strict UTF-8 decode. It lists **masters only**: an override and the cancelled row an EXDATE becomes are parts of a series the master's `rrule` already describes. An override whose master the file lacks attaches to nothing a card can show, so it counts as dropped. So does an event dated outside the years 1 to 9999, which `toISOString` would spell as an invalid date.

Nothing in the payload is relative to now, because it is cached per file version. `start` and `end` are strings: an instant, or a bare date with the exclusive end the calendar stores for an all-day event. The quick-look overlay and the drive hero (the preview at the top of Drive's detail column, `drive-preview.tsx`) turn them into `Date`s where they draw them.

The payload copies named event fields (`previewEvent`), so an ATTACH, a URL or a directory reference in the file never reaches a card. An organizer or attendee is listed only as a plain address. A CAL-ADDRESS is a URI, and the card writes a `mailto:` link from it, so `javascript:…` or an address with a `?` is left out. `EventDetailCard` is the same card the calendar's detail dialog renders, so a file's event reads like a stored one.

## A `.vcf` preview never fetches a photo

The build decodes strict UTF-8 and parses no more cards than an import accepts. A card the parser refuses is counted, not fatal. The first 200 cards are listed. An inline `PHOTO` becomes a `data:` URI; a `PHOTO;VALUE=uri` is dropped rather than fetched, so the file can't make a viewer's browser call a URL it chose.

## The client draws the body as live DOM

The overlay and the drive hero render a body with `dangerouslySetInnerHTML`, with no iframe and no shadow root, so it takes the app's styles. Text and documents sit in `.eigen-prose` (`packages/ui/src/styles/eigen-prose.css`), which the docs editor shares.

Two bodies bring their own box. A deck and a drawing are compositor pages composed at `CANVAS_PREVIEW_WIDTH`, so the hero scales them from a known width with no wrapper class. A sheet is a bare grid whose floating images sit at declared pixels, so `.eigensheets-preview` in `globals.css` undoes the two app rules that would move the grid under them.

Drive's inline editor shows the same body read-only and loads Tiptap or CodeMirror only on Edit (`apps/drive/src/components/editor/native-file-editor.tsx`).

## A message body is never rewritten as text

`MessageView` (`packages/ui/src/components/mail/message-view.tsx`) draws the header and body for the mail reader and the `.eml` quick look alike, so a saved message reads as the message it was. Unlike the other bodies, it goes into `ShadowContent`'s closed shadow root. It drops the color-scheme rules that disagree with its canvas through the CSSOM, once the sheet is parsed, and never over the text: a text deletion could splice the halves around it into the `url(` the server refused. Search highlights are wrapped on the parsed tree too.

## A file subject stores identity, everything else is derived

Every surface that shows a file (a Drive listing, the mail reader, a chat or card attachment) acts on it through a `FileSubject` (`packages/lib/src/types/file-subject.ts`). It is a `DrivePath` or a mail part reference (`{ ownerId, messageId, index }` plus the part's name, type and size), and holds nothing that follows from that identity. `subjectInfo(subject)` derives the rest in one place: the key siblings are matched on, the name, the mime, the size, and the embed, download and thumbnail URLs. So no surface composes a route by hand, and no fact is stored twice where it could disagree.

`subjectFromPath` and `subjectFromMailAttachment` in `packages/lib/src/core/file-subject.ts` are the only builders. A mail subject carries the **raw** part index the mail routes address, calendar parts included, so a reader that hides those parts still names the right one. `importSourceOf` answers where an import reads the bytes: a Drive file is copied server-side, anything else is fetched from its download URL.

Two flags come from the surface that holds the file:

- `readOnly`: the viewer can't write where the file sits, such as a watched feed. The convert rows write the new document beside the source, so they drop out. The surface sets it from its own `DriveCapabilities.canWrite` ([LAYOUT.md](LAYOUT.md)).
- `attachment`: the file belongs to a message or a container, not to a Drive location. Its siblings are a set, which is what draws the overlay's "Save all (n)". And a chat or card attachment's Drive copy sits in a hidden media folder, so a convert saves to a folder the user picks first.

## A file-action row never asks which surface draws it

`FILE_ACTIONS` (`packages/lib/src/core/file-actions.ts`) lists what can be done with a file: Quick preview, Download, Save to Drive, the two converts and the three imports. Each row's `applies` reads the derived facts, and for a few rows the identity behind them. `fileActionsFor(subject, exclude?)` derives the facts once for the whole list. A new row shows up in every menu and in the overlay footer without editing one.

Save to Drive declines a Drive file that isn't an attachment, because Drive's own "Copy to…" does that. An import row declines a file over its import ceiling, because the route would answer 413.

`useFileActions` (`packages/ui/src/components/file-actions/use-file-actions.ts`) is the one place that knows who is asking. An import route refuses a guest while `applies` is handed only the file, so rows flagged `guestDenied` drop out for a guest there. Rows flagged `mailOnly` drop out on a server without hosted mail.

## The host mounts the runner's dialogs

`useFileActionRunner(subject, siblings?, exclude?)`, the file-action runner, performs a row. `FileActionMenuItems` draws the rows as menu items and takes the runner rather than building one. A menu's content unmounts when it closes, so the picker a row opens must live above it: the host renders `runner.dialogs` once. The rows come from `runner.subject`, so a host can't pair one menu with another's subject.

The subject may be `null` for a host whose subject is state, like the right-clicked chip. What a picker acts on is snapshotted when the row runs, because the menu that drew the row is closed by the time the picker is confirmed.

A convert on an attachment opens the Save to Drive picker first, titled with the row's label and confirmed with **Save and convert**. `useConvertDocument` then runs on each file the save created. Import to Calendar opens a target picker before it imports ([CALENDAR.md](CALENDAR.md)). The overlay disables its footer while `runner.isPending`, and its focus trap stands down while `runner.isDialogOpen`.

## Save to Drive copies on the server

`SaveToDrivePicker` (`packages/ui/src/components/drive/save-to-drive-picker.tsx`) is the one "where does this go" dialog. A Drive subject is copied server-side, so its bytes never travel through the browser. A mail subject is written from the message the server still holds, in one call for every part. "Download instead" falls back to browser downloads, staggered because a browser drops the later downloads of a burst fired in one tick.

Siblings come from one surface, so a batch is all Drive items or all mail parts, and the first subject picks the branch. The picker renders above the overlay through `DialogContent`'s `abovePreview` prop.

## The overlay picks its mode from the subject

`PreviewProvider` stores the subject and its siblings and portals `FilePreview` (`packages/ui/src/components/drive/file-preview.tsx`) to `<body>`. `openPreview(subject, siblings?)` takes the siblings the arrow keys page through. A Drive listing passes its folder without the `attachment` flag, so the overlay never offers to copy a folder onto itself.

`getPreviewMode(subject)` runs the text gate of [§ Loose bytes preview as what their name says](#loose-bytes-preview-as-what-their-name-says) on the client. An image needs a mount to be resized, so only a Drive image uses `/preview`. A mail image shows its original bytes, which makes it an image only for a mime in `BROWSER_IMAGE_MIMES`. A HEIC part gets the file card rather than a broken box.

`ProgressiveImage` stacks the 512 px thumbnail under the screen preview so the image shows at once. The box takes its ratio from the Drive row. A mail part has no stored size, so the box measures the image once it loads and then hugs it, and a click beside it reaches the backdrop that closes the overlay. The component is keyed on the preview URL, so a sibling never inherits the previous image's size.

## The overlay's keys stand down for a layer above it

Escape closes, all four arrow keys page, and Space closes the way it opened, like Finder's Quick Look. The keys listen on the document, so they must yield to a layer open above the overlay.

Every layer portals to `<body>` in the order it opened, so later in the document is higher in the stack. `useDialogOpen(overlayRef)` (`packages/ui/src/hooks/use-dialog-open.ts`) asks whether a `role="dialog"` after the overlay is open. A stickies card dialog the overlay was opened from sits before it, so it doesn't count.

Presence is not enough for the keydown in hand. A layer dismisses itself on the capture phase of the same keydown the overlay hears on the bubble, so by then the layer is gone. So a keydown whose target sits inside a dialog, menu or listbox after the overlay belongs to that layer. A `DialogContent` under an open preview ignores Escape, which is the overlay's to close.

Space yields when focus is on a control inside the overlay, where it presses that control. The overlay registers it with `preventDefault: false`, because the hotkey library prevents the default before the callback runs.

## One hook wires every attachment chip to the menu

`useAttachmentChipMenu` (`packages/ui/src/components/attachment/use-attachment-chip-menu.ts`) connects the chips in the mail reader, chat and the card dialog to the singleton context menu. It handles right-click and touch long-press, and reads the chip under the pointer at pointer-down, because a long-press reports only where it started. A right-click on a plain link or a text selection is left to the browser's own menu. The host draws the menu's content: `FileActionMenuItems`, plus its own rows in chat ([CHAT.md](CHAT.md)).

## See also

- [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md): the Worker, its admission and its benchmark
- [EXPORT.md](EXPORT.md): the full-document renderers the previews share
- [LAYOUT.md](LAYOUT.md): Drive's item menu, capabilities and the overlay's z-index
- [MAIL.md](MAIL.md), [CALENDAR.md](CALENDAR.md), [CONTACTS.md](CONTACTS.md): the parsers and the imports
