# Clipboard System

> **TLDR**: Custom clipboard for rich copy-paste between Eigen apps. JSON payload written to a custom
> `application/eigen-clipboard` MIME type, with a copy encoded in `text/html` via a hidden span
> (`data-eigen-clipboard` attribute) so it survives clipboards that strip custom types. Handles
> cross-document media re-upload.

## How It Works

**Write** (`writeEigenClipboard`, during a `copy` event):

1. Serialize `EigenClipboardData` to JSON and set it on the `application/eigen-clipboard` MIME type
2. URI-encode the same JSON, wrap it in `<span data-eigen-clipboard="..."></span>`
3. Write that span as `text/html`, with the caller's own HTML appended after it
4. Write the caller's plain-text fallback as `text/plain`

**Read** (`readEigenClipboard`, during a `paste` event):

5. Read `application/eigen-clipboard` first — lossless, and what you get pasting inside the same tab
6. Fall back to matching `data-eigen-clipboard` out of `text/html` — this is what survives a
   cross-tab or cross-browser-session paste, where the custom MIME type does not

The order matters: the custom MIME is the primary channel and the HTML marker is the fallback, not
the other way round.

## Data Model

**File**: `packages/lib/src/types/clipboard.ts`

```typescript
type EigenClipboardTypography = {
    fontFamily?: string; // the EIGEN_FONTS name, NOT a CSS font stack
    fontSize?: number;
    textAlign?: string;
    fontWeight?: string;
    fontStyle?: string;
    textDecoration?: string;
    verticalAlign?: string;
    color?: string;
    letterSpacing?: number;
    lineHeight?: number;
};

type EigenClipboardTextItem = {
    type: 'text';
    text: string; // PLAIN text, never HTML
    width: number;
    height: number;
    angle?: number;
    typography?: EigenClipboardTypography;
    meta?: Record<string, unknown>;
};

type EigenClipboardImageItem = {
    type: 'image';
    mediaName: string;
    sourcePathId: string;
    sourceParentId: string | null;
    sourceOwnerId: string;
    sourceMountId: string;
    caption?: string;
    width: number;
    height: number;
    angle?: number;
    meta?: Record<string, unknown>;
};

type EigenClipboardElementsItem = {
    type: 'elements';
    elements: Record<string, string | number | boolean>[]; // whole stored records (the ELEMENT_FIELDS scalars)
    sourceFrameId: string; // '' when the source was an infinite canvas
    width: number; // the selection's bounding box
    height: number;
};

type EigenClipboardItem = EigenClipboardTextItem | EigenClipboardImageItem | EigenClipboardElementsItem;

type EigenClipboardData = { version: 1; items: EigenClipboardItem[]; svg?: string }; // svg: the vector copy flavour, see below
```

Image items carry the file **name** (for Yjs storage on paste) plus source identifiers (for re-upload detection and
downloading). See [MEDIA-REFERENCES.md](MEDIA-REFERENCES.md) for the full name-based reference design.

Geometry (`width`/`height`/`angle`) and text `typography` are **first-class typed fields** — never entries in the
untyped `meta` bag, which carries app-private extras only. Build items via `buildImageClipboardItem` /
`buildTextClipboardItem` and read the box via `readClipboardBox`; the builders take a `box` and put it on the typed
fields, so no producer hand-assembles an item.

### Both dimensions are mandatory

**Every item carries `width` AND `height`**, in the source app's document-space units, measured at copy time. A
producer that stores only one dimension measures the other before it writes: a docs figure stores width only (the
document reflows, so the height must follow the image), so the copy handler measures the rendered `<img>` and takes
the height from its intrinsic ratio.

The contract binds hardest on images: they place straight from the wire box. Text does not — every consumer
re-measures a text item with its own font metrics, because a box sized by another app's fonts would clip or gap. So
`height` on a text item is fidelity information, not a placement instruction.

This is a hard contract, not a nicety. Consumers place items straight from the typed box with **no fallbacks**. The
alternative — the consumer probing the image to recover its ratio — was an aspect-ratio bug: the probe resolved the
image *by name* against a media-folder listing captured before the paste's own re-upload, missed, and fell back to a
4:3 default box, so every docs image pasted into slides/sheets/vector landed at the wrong shape. The rule that
follows: **after a copy/upload mutation returns a `DrivePath`, build the URL from that path**
(`resolveMediaUrlByPath` on the media resolver) — by-name resolution is for render, where the listing has caught up
and self-heals.

The wire is forgeable by any web page, so the read seam (`readEigenClipboard`) validates **every item against its own
variant** before a consumer sees it — the geometry must be finite numbers, and a `text` item must carry a string
`text`, an `image` item its five source identifiers, an `elements` item an array. Anything else is dropped, and one
bad item never takes the good ones with it. That matters more than it looks: consumers read the typed fields with no
fallbacks, inside a paste handler that has already called `preventDefault`, so an item that survives validation and
then throws doesn't just fail — it eats the paste with no error the user can see. (Same threat model that makes rich
HTML get re-sanitized on paste.)

### Typography: what is on the wire is what somebody reads

`EigenClipboardTypography` is exactly the set a canvas rich-text box models, which is also the widest set any
consumer can place. The canvas producer writes all ten; the canvas' own foreign-paste applies all ten to the
rich-text box it creates; docs maps the six it has nodes and marks for (font family, colour, alignment, bold,
italic, underline/strike) and drops the rest gracefully — it has no font-size, letter-spacing or line-height control
by design. Sheets reads none of them for a text item. Nothing goes on this wire that no consumer reads:
`highlightColor` did, was produced by nobody and read by nobody, and is gone.

### The elements item (canvas copies)

A canvas selection rides as ONE `elements` item: the whole stored record of every copied element (`buildElementsClipboardItem`, `packages/lib/src/vector/clipboard.ts`), so a canvas→canvas paste restores exactly what was copied — including every field a future kind adds. Reading is `readElementsClipboardItem`, which runs each record through the document reader (`readElementFromFields`): the wire is forgeable by any web page, so a forged record is dropped and a hostile value is clamped by the same validator a hostile peer write meets. There is no second field list to drift.

It is the one item type that carries **position**: the coordinates are the stored ones (scene coordinates on an infinite canvas, frame-relative inside a frame), because pasting a drawing back into a drawing is a paste in place, not "at the app's default spot". `sourceFrameId` is what lets the paste tell those apart, in `pasteAnchorOffset` (`packages/lib/src/vector/clipboard.ts`): a paste into the frame it was copied from offsets the copy by the duplicate step, one into a different frame lands in place, and anything else — the infinite canvas, and every crossing between the two — re-anchors the bounding box on the viewport centre so the paste lands where the user is looking. That last rule has one degenerate case, which is why the rule is not simply "re-anchor": a selection sitting AT the viewport centre re-anchors by ~0, so the copy lands pixel-exactly on top of the original and ⌘V looks like a dead key. A re-anchor smaller than one duplicate step IS that case, so it takes the duplicate step instead — the same thing ⌘D does with the same selection. `width`/`height` are the selection's bounding box, so the mandatory-dimensions contract above holds with no special case.

**A canvas copy writes the other items too**: an `image` item per copied image (the cross-mount re-upload manifest, keyed by `mediaName`, and the payload a foreign host places) and a `text` item per rich-text box (flattened text, its typography, the HTML under `meta.html`). Hosts that cannot place native elements ignore the `elements` item and read those, or the `svg` flavour below.

### Empty text carriers

Nothing writes an empty text item today, but the wire is forgeable and any app may. Consumers filter with
`clipboardTextItemHasContent` so a contentless carrier never lands as a blank paragraph or a blank cell.

### Copy flavors

A pure-image copy writes no `text/plain`. The rule it belongs to is "never write two flavours a single consumer
would both accept", which is what avoids a double-paste; in practice the only pair at risk would be `text/plain`
beside an `image/png`, and no producer in the repo writes an `image/png` flavour at all, so that half of the rule
has nothing to bite on today. The rule still governs anything new: add a PNG flavour and it must not ride beside
`text/plain`. The canvas' own flavour bullet is under [CANVAS.md](CANVAS.md) § Shared primitives.

### The SVG flavour (canvas copies)

A canvas copy sets `EigenClipboardData.svg` unless one of two gates says otherwise, both in `selectionSvg`
(`packages/ui/src/components/vector/tools/clipboard.ts`):

- **A text-only selection omits it.** Every foreign host runs its svg rung BEFORE the typed items, so writing an SVG
  for a lone rich-text box makes it paste into a document as a flat picture of itself, with the typed text item and
  its typography never read. An SVG conveys nothing about a text box that the text item doesn't, so not writing it
  is exactly what makes a copied text box land as styled, editable text.
- **A big selection omits it.** The same records are serialized once as typed items, again into the SVG's
  `<metadata>`, and the whole SVG is then URI-encoded into an HTML attribute — a 500-shape select-all put ~1.1MB on
  `text/html`. Past `CLIPBOARD_SVG_MAX_ELEMENTS` (checked before the render, so a huge selection never pays for it)
  or `CLIPBOARD_SVG_MAX_BYTES` (the backstop for few-but-enormous elements), the flavour is skipped. The failure
  mode is deliberate and total: every eigen host still pastes losslessly from the typed items, and a foreign host
  gets the `text/plain` fallback instead of an image — the same thing it gets for a shape-only copy.

One more limit is inherent rather than chosen: the render sees the **selection alone**, so an elbow arrow bound to
an unselected shape draws straight in the copied SVG. That is what a copy of the selection is.

Otherwise it is: a self-contained `sceneToSvg` render of the selection with the element JSON URI-encoded into a `<metadata>` block (`embedClipboardSvgMetadata`/`extractClipboardSvgMetadata`), Excalidraw's svg-source pattern. It rides the eigen payload because Chromium's async clipboard cannot carry an `image/svg+xml` flavour. Hosts that can't place the canvas' typed carriers (docs, sheets — slides IS the canvas engine now, and consumes the typed items first) call `readSvgClipboardWithItems` BEFORE consuming the typed items — it returns the SVG together with the typed image items that back its refs — then run it through `materializeClipboardSvg` and insert the result as one image via their existing image-upload path. That single consumption point is what keeps the no-double-paste rule. `readSvgClipboardWithItems` also accepts a whole SVG document on `text/plain` (root tag carrying the SVG xmlns — a pasted `<svg>` code snippet without it stays text, and it carries no items), so foreign drawings paste as images too; a canvas restores native elements from the `<metadata>` block when present, whether the SVG arrived on the clipboard or as a dropped `.svg` file — drop and paste run the same rung, so the same file can't behave differently depending on how it got there.

**Image-bearing selections reference their images BY NAME**: the copy's SVG never inlines image bytes (the synchronous copy path can't), and never bakes a live href (owner-scoped preview URLs, tab-local `blob:` pendings) that would render blank for every other viewer. Instead each `<image>` carries `href="eigen-media:<encodeURIComponent(name)>"` (`eigenMediaHref`, `packages/lib/src/vector/media-refs.ts`), and `materializeClipboardSvg` resolves those names against the target container on paste: for each name its typed image item is the fetch manifest — a cross-container ref re-uploads through the credentialed `reUploadImage` seam, a same-folder ref keeps its name — then the stored SVG's refs are rewritten old→final (collision renames) or stripped when the upload failed, so the drawing only ever references names that exist in the target's `media/`. The display path swaps each surviving `eigen-media:` ref for a `data:` URI at serve time. A still-pending upload has no portable path, so it's omitted from the SVG exactly as it's omitted from the typed items. While a pasted media reference resolves, the consuming editors (docs figures, canvas images) show the shared `ImagePlaceholder` spinner; a terminally missing name shows the same spinner — the by-name resolver's miss-triggered refetch self-heals the common case, and distinguishing "still resolving" from "gone" would need refetch-settled tracking in the resolver, deferred until it earns its machinery. See [MEDIA-REFERENCES.md](MEDIA-REFERENCES.md) for the name-based reference design.

The name-ref SVG in the eigen JSON is **unchanged** by the rest of this section — every eigen host still materializes it by name via `materializeClipboardSvg`. What the polish round added is a SECOND, foreign-visible flavour that the async menu **Copy/Cut** now ALSO writes: a `<img src="data:image/svg+xml;base64,…">` appended after the marker span, so an html-reading foreign consumer (mail compose, another web page — chat's plain textarea reads only text/plain) that can't read the eigen payload still pastes the drawing as an image. Its images are inlined as base64 `data:` URIs at write time via `inlineClipboardSvgMedia` (bytes fetched through the credentialed media resolver), because no eigen server-side inliner will serve a clipboard `<img>`. Two guards keep it well-behaved: a per-image fetch that fails **strips that ref** (exactly as `materializeClipboardSvg` strips a failed re-upload, so the SVG never references bytes it can't show), and a ~4MB soft cap on the total inlined payload **skips the flavour entirely** (`inlineClipboardSvgMedia` returns null → the write degrades to today's marker + name-ref payload) rather than putting a multi-MB, clipboard-rejectable blob on the clipboard. The `<img>` is marked with `EIGEN_CLIPBOARD_RENDER_ATTR` (`data-eigen-clipboard-render`), which `hasRichHtmlBeyondMarker` strips before its test — so a shape-only vector copy never counts as foreign rich HTML (else docs' rich-HTML rung would land the drawing as a persisted base64 figure).

**Limitation — a shape or image copy is invisible in our own mail composer.** A sync ⌘C of shapes/images writes
marker-only `text/html` and no `text/plain`, so pasting into mail compose lands nothing. The async menu path's
base64 `<img>` does not rescue it either: mail's LightEditor has no Image extension
(`packages/ui/src/components/editor/light-editor.tsx`), so ProseMirror's schema drops the node. The menu path fixes
the foreign case for hosts that accept an `<img>` (another web page, a foreign rich editor) — not for mail. A real
fix is an `image/png` flavour on the async path, which would also give the no-PNG-beside-`text/plain` rule something
to bite on. Not built.

**Limitation — sync ⌘C keeps name refs only.** Only the async menu path writes the inlined `<img>`; a native `copy`/`cut` event (`writeEigenClipboard`) writes just the marker + name-ref SVG, because a sync clipboard event can't fetch the media bytes. Making ⌘C write the inlined flavour would mean handing `navigator.clipboard.write` a promise-`ClipboardItem`, which drops the custom `application/eigen-clipboard` MIME — the same Phase-0 asymmetry the async write already lives with (see the API § asymmetry note). So a menu-copied drawing pastes as an image into a foreign contenteditable; a ⌘C-copied one does not.

## Cut deletes only what it copied

A canvas copy leaves out any image whose media path doesn't resolve yet — a still-pending upload, or one whose
folder listing hasn't refreshed — because nobody could fetch its bytes from the wire. `buildSelectionData` therefore
returns the ids it **actually serialized** beside the payload, and cut deletes those, not the selection. Cutting an
element the copy silently dropped is data loss: the one copy of it would exist nowhere but the undo stack, with
nothing telling the user it had gone. What the user sees instead: the rest of the selection is cut, the unresolved
image stays in the drawing, and a toast says it is still uploading. Both cut paths (⌘X and the menu row) use the
same ids.

## A paste that places nothing must not claim the event

An eigen payload can be non-empty and still place nothing: every item dropped at the read seam as forged, or images
with no `media/` folder to land in. The canvas' `pasteEigenItems` reports whether it placed anything, and the
handler calls `preventDefault` only when it did — so the rungs below (the SVG flavour, OS files, plain text) still
get their turn instead of the paste vanishing. If the whole ladder places nothing and an eigen payload was present,
the canvas toasts, because a ⌘V that silently does nothing is indistinguishable from a broken key.

## Cross-Document Media

When pasting images between documents, `needsReUpload()` compares `sourceParentId` to the target's `mediaFolderId`.
If different, `reUploadImage()` downloads via the source pathId and uploads to the target's `media/` folder. The new
file's **name** is stored in Yjs (may differ from original due to `getUniqueFileName()` conflict resolution).

That download runs **as the pasting user**, with `credentials: 'include'`. When someone pastes a payload whose
source file they cannot read, the fetch fails, `reUploadImage` returns `null`, and the consumer drops the
placeholder — the image silently disappears. This is correct: the clipboard carries a reference, not the bytes, and
a reference confers no access. It also means an image payload is **not** self-contained across logins.

## API

```typescript
import {
    writeEigenClipboard, writeEigenClipboardAsync,
    readEigenClipboard, readEigenClipboardAsync,
    hasRichHtmlBeyondMarker, clipboardTextItemHasContent,
    buildTextClipboardItem, buildImageClipboardItem, readClipboardBox,
    copyToClipboard, needsReUpload, reUploadImage,
} from '@workspace/lib/clipboard';

// Sync write (during a copy event) — optional html is appended after the marker
writeEigenClipboard(e, data, "plain text fallback", "<p>optional html</p>");

// Async write (button click, no ClipboardEvent to hang off) — optional html, appended after the
// marker span like the sync path. It may be a string OR a Promise (the SVG data-URI inliner fetches
// media): a promise-valued ClipboardItem lets navigator.clipboard.write START inside the user gesture,
// so Safari/Firefox don't reject the write while the fetch is still in flight. A rejecting/undefined
// html promise degrades to a marker-only html blob rather than aborting the whole write.
await writeEigenClipboardAsync(data, "plain text fallback", htmlOrHtmlPromise);

// Read (during a paste event)
const eigenData = readEigenClipboard(e.clipboardData);

// Async read (a context-menu Paste row, no ClipboardEvent)
const eigenData = await readEigenClipboardAsync();

// Is there real HTML besides our marker span? Docs uses this to decide whether to let ProseMirror
// parse the foreign markup instead of consuming our flat text item.
if (hasRichHtmlBeyondMarker(e.clipboardData)) { /* ... */ }
```

`copyToClipboard(text, message?)` is the plain "copy this string and toast" helper from the same barrel — unrelated
to the rich payload, and used far more widely (calendar, index, drive menus, command palette).

**Asymmetry (open):** `writeEigenClipboardAsync` does not write the `application/eigen-clipboard` MIME —
`navigator.clipboard.write` cannot set arbitrary custom types — so an async-written payload always round-trips
through the HTML marker. Tracked as Copy-Paste Phase 0 in [ROADMAP.md](ROADMAP.md).

**Files**: `packages/lib/src/core/clipboard/`

## Classifying a paste (`classifyPaste`)

`classifyPaste(cd, opts?)` (`core/clipboard/classify.ts`) is the shared flavour classifier: one **sync** pass over an
already-obtained `DataTransfer` that resolves every present clipboard flavour once — the parsed `eigen` payload, the
`svg` payload (svg + the typed items that back its refs), `imageFiles`, all `files`, `html`, `text` — and returns
them as an object of flavours. It composes the existing readers (`readEigenClipboard`, `readSvgClipboardWithItems`)
rather than re-parsing: the eigen JSON is parsed exactly once and handed to `readSvgClipboardWithItems`, so the svg
flavour is derived without a second parse. It stays sync because every reader it composes is sync (the async menu
paths only ever want eigen items and keep `readEigenClipboardAsync`).

It deliberately does **not** impose a priority order — each app keeps its own short ladder that reads the returned
fields in its own rung order and calls its own per-kind insert handlers (the ladders in docs, sheets and the canvas engine, which
serves slides and vector alike). Rich-HTML arbitration also stays caller-side: a consumer that gates on foreign HTML (docs) calls
`hasRichHtmlBeyondMarker` itself; `classifyPaste` makes no pass over `text/html` for that decision. The one built-in
special case is the `internalMarkerText` option: sheets' same-tab copy writes a table marker in `text/html` and
serves paste from `ctx.copyState`, so passing that marker string suppresses the `eigen` + `svg` flavours entirely
(the caller then falls through to its native table paste). One place owns the marker-skip; every other app passes no
`internalMarkerText`.

## Used by

Rich payload (`EigenClipboardData`):

| Surface | Entry point |
|---|---|
| eigendoc editor | `apps/docs/src/components/docs/editor.tsx` |
| eigensheets | `packages/sheet/src/components/Workbook/index.tsx` (media re-upload in `apps/sheets/src/components/sheets/editor.tsx`) |
| eigenslides + eigenvector canvas | `packages/ui/src/components/vector/canvas-editor.tsx` + `hooks/use-canvas-clipboard.ts` (lives in `packages/ui`, not an app, so both apps get one paste path) |

### Sheets caveat

**In-app sheets → sheets copy-paste does not use this system.** Sheets writes the eigen payload on every copy, but
`packages/sheet/src/components/Workbook/index.tsx:633` skips `readEigenClipboard` whenever the clipboard HTML
contains `sheet-copy-action-table` — which the sheet's own copy always emits
(`COPY_ACTION_TABLE_MARKER`, `packages/sheet/src/state/modules/selection.ts`). Paste is instead served from `ctx.copyState`
(`packages/sheet/src/state/context.ts:136`), which holds **coordinates only**; the fidelity comes from re-reading
the live cells, which is why formulas, number formats, conditional-format rules, data validation and hyperlinks all
survive a same-tab paste and none of them exist on the eigen wire.

Consequences worth knowing:

- The cell-range payload sheets does write is a single flat text item — the `innerText` of its HTML table. No
  structure, no formulas.
- An incoming text item is downgraded to a synthetic `text/plain` paste, so even a structured payload could not be
  received today.
- **Cross-tab sheets → sheets is already lossy**: the receiving tab has no `ctx.copyState`, the marker still
  suppresses the eigen read, and the paste falls through to the foreign-HTML parser.

Converting sheets onto this system is scoped in [SHEETS-TODO.md](SHEETS-TODO.md) § Clipboard.

### How sheets writes a menu-triggered copy

A copy from a menu row has no native `copy` event, and `navigator.clipboard.write` cannot set the custom MIME type.
Sheets therefore stages its HTML in a module-level buffer and re-enters a synthetic event:
`setPendingCopy` → `flushPendingCopy` (which calls `document.execCommand('copy')`) → the Workbook's `copy` listener
drains it with `consumePendingCopy`. The plain text is mirrored into `sessionStorage.localClipboard` so a
menu-triggered *paste* has something to read. See `packages/sheet/src/state/modules/clipboard.ts`.

The package↔app seam is three hooks in `packages/sheet/src/state/settings.ts`: `resolveImagePath`,
`onPasteEigenImage`, `onPasteImageFile`.
