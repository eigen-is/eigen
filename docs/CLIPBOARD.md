# Clipboard System

> **TLDR**: Custom clipboard for rich copy-paste between Eigen apps. JSON payload encoded in `text/html` via hidden
> span (`data-eigen-clipboard` attribute) to survive browser clipboard stripping. Handles cross-document media
> re-upload.

## How It Works

1. Serialize `EigenClipboardData` to JSON, URI-encode
2. Wrap in `<span data-eigen-clipboard="..."></span>`
3. Write as `text/html` to clipboard
4. On paste: look for `data-eigen-clipboard`, decode rich data

## Data Model

**File**: `packages/lib/src/types/clipboard.ts`

```typescript
type EigenClipboardItem =
    | { type: 'text'; text: string; meta?: Record<string, unknown> }
    | { type: 'image'; mediaName: string; sourcePathId: string; sourceParentId: string | null;
        sourceOwnerId: string; sourceMountId: string; meta?: Record<string, unknown> };

type EigenClipboardData = { version: 1; items: EigenClipboardItem[] }
```

Image items carry the file **name** (for Yjs storage on paste) plus source identifiers (for re-upload detection and
downloading). See [MEDIA-REFERENCES.md](MEDIA-REFERENCES.md) for the full name-based reference design.

## Cross-Document Media

When pasting images between documents, `needsReUpload()` compares `sourceParentId` to the target's `mediaFolderId`.
If different, `reUploadImage()` downloads via the source pathId and uploads to the target's `media/` folder. The new
file's **name** is stored in Yjs (may differ from original due to `getUniqueFileName()` conflict resolution).

## API

```typescript
import {writeEigenClipboard, readEigenClipboard, writeEigenClipboardAsync} from '@workspace/lib/clipboard';

// Sync (during copy event)
writeEigenClipboard(e, data, "plain text fallback");

// Async (button click)
await writeEigenClipboardAsync(data, "plain text fallback");

// Read (during paste event)
const eigenData = readEigenClipboard(e.clipboardData);
```

**Files**: `packages/lib/src/core/clipboard/`
