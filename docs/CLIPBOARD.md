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
    highlightColor?: string;
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

type EigenClipboardItem = EigenClipboardTextItem | EigenClipboardImageItem;

type EigenClipboardData = { version: 1; items: EigenClipboardItem[] };
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

This is a hard contract, not a nicety. Consumers place items straight from the typed box with **no fallbacks**. The
alternative — the consumer probing the image to recover its ratio — was an aspect-ratio bug: the probe resolved the
image *by name* against a media-folder listing captured before the paste's own re-upload, missed, and fell back to a
4:3 default box, so every docs image pasted into slides/sheets/vector landed at the wrong shape. The rule that
follows: **after a copy/upload mutation returns a `DrivePath`, build the URL from that path**
(`resolveMediaUrlByPath` on the media resolver) — by-name resolution is for render, where the listing has caught up
and self-heals.

The wire is forgeable by any web page, so the read seam (`readEigenClipboard`) drops any item whose `width`/`height`
aren't finite numbers before a consumer ever sees it (the same threat model that makes rich HTML get re-sanitized on
paste).

### Empty text carriers

Vector shapes ride the wire as text items with `text: ''` — the item exists to carry geometry, not words. Consumers
MUST filter with `clipboardTextItemHasContent` so a foreign shape never lands as a blank paragraph or a blank cell.

### Copy flavors

A pure-image copy writes no `text/plain`; a copy that writes `text/plain` writes no PNG. This avoids the
double-paste where a consumer accepts both flavors. It is a clipboard-protocol rule — the worked example lives in
[CANVAS.md](CANVAS.md) § D6.

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

// Async write (button click, no ClipboardEvent to hang off)
await writeEigenClipboardAsync(data, "plain text fallback");

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

## Used by

Rich payload (`EigenClipboardData`):

| Surface | Entry point |
|---|---|
| eigendoc editor | `apps/docs/src/components/docs/editor.tsx` |
| eigenslides editor | `apps/slides/src/components/slides/editor.tsx` |
| eigensheets | `packages/sheet/src/components/Workbook/index.tsx` (media re-upload in `apps/sheets/src/components/sheets/editor.tsx`) |
| eigenvector canvas | `packages/ui/src/components/vector/vector-canvas.tsx` (lives in `packages/ui`, not an app) |

### Sheets caveat

**In-app sheets → sheets copy-paste does not use this system.** Sheets writes the eigen payload on every copy, but
`packages/sheet/src/components/Workbook/index.tsx:632` skips `readEigenClipboard` whenever the clipboard HTML
contains `copy-action-table`, which the sheet's own copy always emits
(`packages/sheet/src/state/modules/selection.ts`, `COPY_ACTION_TABLE_MARKER`) — matched as a suffix, so a
clipboard written before the 2026-08-28 `fortune-` → `sheet-` rename is still recognised. Paste is instead served from `ctx.copyState`
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
