# Clipboard

> **TLDR:** Rich copy and paste between Eigen apps. One typed JSON payload (`EigenClipboardData`, `packages/lib/src/types/clipboard.ts`) rides the `application/eigen-clipboard` MIME type and, as a fallback, a marker span in `text/html`; the readers and writers live in `packages/lib/src/core/clipboard/`. Any web page can forge the payload, so the reader validates every item. Width and height are mandatory, because consumers place with no fallback. An image travels as a reference the pasting user must be allowed to read. A canvas cut deletes only what the copy carried.

## One payload rides two channels

`writeEigenClipboard` runs inside a native `copy` event. It sets the JSON on `application/eigen-clipboard`, and writes it again URI-encoded into `<span data-eigen-clipboard="…">` on `text/html`, with the caller's HTML after the span and its plain text on `text/plain`. `readEigenClipboard` reads the custom type first and falls back to the marker, because a custom type does not survive every clipboard and `text/html` does.

A menu row has no `ClipboardEvent`, so it uses `writeEigenClipboardAsync` and `readEigenClipboardAsync`. `navigator.clipboard.write` cannot set an arbitrary custom type, so the async pair uses the marker only. Whether that loses anything is the open Copy-Paste Phase 0 row in [ROADMAP.md](ROADMAP.md).

The async writer takes its HTML as a promise. The write must start inside the user gesture, or Safari and Firefox reject it once a media fetch outlives the activation window. A rejected HTML promise still writes the marker and the plain text.

## Every field on the wire is typed and has a reader

An item is `text`, `image` or `elements`. Geometry (`width`, `height`, `angle`) and text `typography` are typed fields, with no untyped bag beside them. Every field has a producer and a consumer, and anything an app wants to carry earns a typed field with a reader. Producers build items with `buildImageClipboardItem` and `buildTextClipboardItem`, and consumers read the box with `readClipboardBox`.

Text and image items carry no position: each app pastes at its own caret, cell or viewport center. The `elements` item is the exception, because a canvas paste lands relative to where it was copied from.

`EigenClipboardTypography` is exactly the ten fields a canvas rich-text box stores, the widest set any consumer can place. The canvas writes and applies all ten. Docs maps the six it has nodes and marks for (font family, color, alignment, bold, italic, underline or strike), and sheets reads none. `fontFamily` is the `EIGEN_FONTS` name, not a CSS stack. The `text` is plain, so per-run marks do not survive.

## Both dimensions are mandatory

Every item carries `width` and `height` in the source app's document units, measured at copy time. A producer that stores one dimension measures the other before it writes: a docs figure stores only its width, so the copy handler measures the rendered `<img>`.

Images place straight from this box. A consumer that probes the image for its ratio looks it up by name in a media listing taken before the paste's own re-upload. It misses and lands the image at a default 4:3. The general rule: when a copy or upload returns a `DrivePath`, build the URL from that path (`resolveMediaUrlByPath`). By-name resolution is for render, where the listing has caught up.

Text re-measures. Every consumer measures a text item with its own fonts, because a box sized by another app's metrics would clip or leave a gap. On a text item, `height` is fidelity information, not a placement instruction.

## The reader validates every item against its own variant

`readEigenClipboard` checks each item before a consumer sees it: finite geometry, a string `text` on a text item, the five source identifiers on an image item, an array on an elements item. A bad item is dropped and the good ones survive (`packages/lib/src/test/core/clipboard/clipboard.test.ts`). Consumers read the typed fields with no fallbacks, inside a paste handler that has already called `preventDefault`. An item that passed and then threw would eat the paste, and the user would see nothing.

A text item with no content is valid but useless. No Eigen app writes one, but a forged payload may, so every consumer filters with `clipboardTextItemHasContent`.

## A copy never writes two flavors one consumer would both accept

Two flavors a single consumer reads would paste twice. So a pure image copy writes the payload and no `text/plain`. The pair at risk is `text/plain` beside `image/png`. No producer writes a PNG today, but a new one must not ride beside `text/plain`.

## A pasted image re-uploads as the pasting user

An image item carries the media file's name and source identifiers, not its bytes. On paste, `needsReUpload` compares `sourceParentId` with the target's media folder. When they differ, `reUploadImage` downloads the source and uploads it into the target's `media/`, and the document stores the new name, which may differ after a collision rename ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md)).

The download runs as the pasting user, with credentials. A user who cannot read the source gets a "Could not load the pasted image" toast and no image. A reference confers no access, so an image payload does not carry across logins.

## Each app keeps its own paste ladder

`classifyPaste` (`classify.ts`) resolves every flavor of a `DataTransfer` once: the parsed payload, the SVG with the image items behind it, files, HTML and text. It imposes no order. Each app reads the fields in its own order:

| App | Ladder |
|---|---|
| Docs (`apps/docs/src/components/docs/editor.tsx`) | SVG as a figure, then image items and marker-only text, then an image file, then ProseMirror's own paste |
| Sheets (`packages/sheet/src/components/Workbook/index.tsx`) | SVG as a floating image, then image items as images and text items into cells, then the HTML table |
| Canvas (`packages/ui/src/components/vector/hooks/use-canvas-clipboard.ts`) | Native elements, then the SVG, then OS files, then plain text as a text box |

Docs claims text items only when `hasRichHtmlBeyondMarker` says the HTML is just the marker. A sheets range rides as marker plus a real `<table>`, which ProseMirror turns into a docs table.

## Sheets serves its own copies from memory

A sheets copy writes the payload, but a sheets paste of it skips the payload. The copy tags its HTML with `COPY_ACTION_TABLE_MARKER`, and `classifyPaste`'s `internalMarkerText` drops the payload and the SVG on that tag. The paste is served from `ctx.copyState`, which holds coordinates and re-reads the live cells. That is why formulas, formats and links survive a same-tab paste though none of them exist on the wire. In another tab there is no `copyState`, the tag still suppresses the payload, and the paste falls through to the HTML table parser, lossy. Putting sheets on the wire is scoped in [SHEETS-TODO.md](SHEETS-TODO.md).

A sheets menu copy has no native event either, and the async writer cannot set the custom type. So it stages its HTML with `setPendingCopy` and fires `execCommand('copy')`, and the Workbook's `copy` listener writes every flavor (`packages/sheet/src/state/modules/clipboard.ts`).

## A canvas selection rides as its stored records

`buildElementsClipboardItem` (`packages/lib/src/vector/clipboard.ts`) copies the whole stored record of every selected element, so a canvas-to-canvas paste restores exactly what was copied, including any field a future kind adds. `readElementsClipboardItem` runs each record back through `readElementFromFields`. A forged record meets the same validator as a hostile peer write, and there is no second field list to drift.

The paste planner (`packages/ui/src/components/vector/tools/paste-elements.ts`) drops each record's id, index and seed, clears `commentCardIds`, and runs rich text's `html` through `sanitizeToLightEditorHtml`. Pasted arrows rebind to the pasted copies of their shapes, and a binding to a shape left behind is cleared. Every add and the arrow remap are one undo step. A cross-mount image lands under a pending name and swaps in its real name untracked, or is deleted when the re-upload fails.

Beside the `elements` item the copy writes an `image` item per image, which is both what other apps place and the canvas' re-upload manifest, and a `text` item per rich-text box.

## A canvas paste lands relative to where it was copied

The `elements` item keeps stored coordinates: scene coordinates on an infinite canvas, frame-relative inside a frame. `pasteAnchorOffset` moves the whole set by one offset:

| From, to | Where it lands |
|---|---|
| A frame, the same frame | One duplicate step down and right, as ⌘D does |
| A frame, a different frame | In place, the same spot on the other slide |
| Anything involving an infinite canvas | Its bounding box centered on the viewport |

A selection already at the viewport center would move by almost nothing and land exactly on the original, and ⌘V would look like a dead key. So a re-anchor under one step in both directions takes the duplicate step instead. The `addElements` wrapper then stamps the active frame, so a paste lands in the frame it is pasted into.

## A canvas cut deletes only what it copied

A copy leaves out any image whose media path does not resolve yet, such as a pending upload, because nobody could fetch its bytes. `buildSelectionData` returns the ids it actually serialized, and both cut paths delete those, not the selection. Cutting an element the copy dropped would leave its only copy on the undo stack. Instead the image stays, and a toast says it is still uploading. The menu cut deletes only after the async write succeeds.

## A canvas paste that places nothing leaves the event alone

A payload can be valid and place nothing: every item dropped as forged, or only images with no `media/` folder. `pasteEigenItems` reports whether it placed anything, and the handler calls `preventDefault` only when it did, so the lower rungs still get their turn. The SVG rung likewise falls through without a `media/` folder. If nothing places and a payload was there, the canvas toasts, because a silent ⌘V looks like a broken key.

## The SVG flavor is skipped for text-only and big selections

A canvas copy sets `EigenClipboardData.svg`: a `sceneToSvg` render with the items embedded in a `<metadata>` block. Docs and sheets cannot place elements, so they paste the SVG as one image. `selectionSvg` (`tools/clipboard.ts`) has two gates:

- A text-only selection writes none. Every foreign host tries the SVG before the typed items, so a text box would land as a picture of itself instead of styled, editable text.
- A big selection writes none. The records are serialized as items, again in the metadata, and the whole SVG is URI-encoded into an attribute. Past `CLIPBOARD_SVG_MAX_ELEMENTS` or `CLIPBOARD_SVG_MAX_BYTES`, a canvas still pastes from the `elements` item, and docs and sheets get only the image and text items.

A canvas given an SVG, pasted or dropped as a file, restores native elements from the metadata and inserts an image otherwise. `readSvgClipboardWithItems` also takes a whole SVG from `text/plain` when its root tag carries the SVG namespace, so an `<svg>` code snippet stays text.

## The SVG names its images, never their bytes

A copy event cannot fetch bytes, and a live URL (an owner-scoped preview, a tab-local `blob:`) renders blank for anyone else. So each `<image>` carries `href="eigen-media:<name>"` (`packages/lib/src/vector/media-refs.ts`). On paste, `materializeClipboardSvg` uses the typed image items as the fetch manifest: a cross-container ref re-uploads, a same-folder ref keeps its name, and a failed one is stripped. The stored SVG only names files in the target's `media/`, and the preview inliner swaps each ref for a `data:` URI when it serves the file.

The menu Copy and Cut also append `<img src="data:image/svg+xml;base64,…">` with every image inlined (`inlineClipboardSvgMedia`), so a foreign rich editor shows the drawing. Past a soft cap on the inlined bytes the flavor is skipped. The `<img>` carries `EIGEN_CLIPBOARD_RENDER_ATTR`, which `hasRichHtmlBeyondMarker` ignores, or docs would store a shape copy as a base64 figure. ⌘C cannot write it: the sync event cannot fetch, and the async writer cannot set the custom type. Mail compose shows neither, because its editor has no image node. The fix is an `image/png` flavor, listed in [ROADMAP.md](ROADMAP.md).

## See also

- [MEDIA-REFERENCES.md](MEDIA-REFERENCES.md): name-based media references
- [CANVAS.md](CANVAS.md), [CANVAS-ARROWS.md](CANVAS-ARROWS.md), [SHEETS.md](SHEETS.md)
- [PROPOSAL_COPY_PASTE.md](proposals/PROPOSAL_COPY_PASTE.md): what a v2 wire would add
