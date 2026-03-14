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
    | { type: 'image'; src: string; sourcePath?: DrivePath; meta?: Record<string, unknown> };

type EigenClipboardData = { version: 1; items: EigenClipboardItem[] }
```

## Cross-Document Media

When pasting images between documents, `needsReUpload()` checks if source differs from target. `reUploadImage()` fetches
and re-uploads to target's `media/` folder.

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
