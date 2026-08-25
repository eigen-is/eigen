# Clipboard System

> **TLDR**: Custom clipboard for rich copy-paste between Eigen apps. JSON payload encoded in `text/html` via hidden
> span (`data-eigen-clipboard` attribute) to survive browser clipboard stripping. Handles cross-document media
> re-upload.

## How It Works

1. Serialize `EigenClipboardData` to JSON, URI-encode
2. Wrap in `<span data-eigen-clipboard="..."></span>`
3. Write as `text/html` to clipboard (optionally prepend additional HTML)
4. On paste: look for `data-eigen-clipboard`, decode rich data
5. Falls back to reading the custom `application/eigen-clipboard` MIME type if the HTML marker is missing

## Data Model

**File**: `packages/lib/src/types/clipboard.ts`

```typescript
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

The wire is forgeable by any web page, so `parseEigenJson` drops any item whose `width`/`height` aren't finite
numbers before a consumer ever sees it (the same threat model that makes rich HTML get re-sanitized on paste).

## Cross-Document Media

When pasting images between documents, `needsReUpload()` compares `sourceParentId` to the target's `mediaFolderId`.
If different, `reUploadImage()` downloads via the source pathId and uploads to the target's `media/` folder. The new
file's **name** is stored in Yjs (may differ from original due to `getUniqueFileName()` conflict resolution).

## API

```typescript
import {writeEigenClipboard, readEigenClipboard, writeEigenClipboardAsync} from '@workspace/lib/clipboard';

// Sync (during copy event) — optional html param appended after the marker
writeEigenClipboard(e, data, "plain text fallback", "<p>optional html</p>");

// Async (button click)
await writeEigenClipboardAsync(data, "plain text fallback");

// Read (during paste event)
const eigenData = readEigenClipboard(e.clipboardData);
```

Used by: eigendoc editor, eigenslides editor, eigensheets (sheet), eigenvector canvas.

**Files**: `packages/lib/src/core/clipboard/`
