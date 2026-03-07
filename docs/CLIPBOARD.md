# Clipboard & Inter-App Copy-Paste

Eigen implements a custom clipboard system that allows rich data to be copied and pasted seamlessly between different Eigen applications (e.g., from Docs to Slides, or Stickies to Docs).

## 1. Overview

The clipboard system lives in `packages/lib/src/core/clipboard/`. It provides utilities for reading and writing a standardized JSON payload (`EigenClipboardData`) to the system clipboard, preserving rich structure while also providing plain text fallbacks.

## 2. The HTML Marker Workaround

Browsers are notoriously strict about the Clipboard API. Many browsers strip out custom MIME types (like `application/eigen-clipboard`) when using the async `navigator.clipboard.write()` API.

To bypass this and ensure rich data survives the trip through the system clipboard, Eigen uses a clever HTML encoding strategy:

1. The data is serialized to JSON and URI-encoded.
2. It is wrapped in a hidden HTML span: `<span data-eigen-clipboard="%7B%22version%22... "></span>`
3. This string is written to the clipboard under the standard `text/html` MIME type.
4. On paste, `readEigenClipboard` intercepts the `text/html` payload, looks for the `data-eigen-clipboard` attribute, and decodes the rich JSON data.

## 3. Data Model

Types are defined in `packages/lib/src/types/clipboard.ts`.

```typescript
export type EigenClipboardItem = 
    | { type: 'text'; text: string; meta?: Record<string, unknown> }
    | { type: 'image'; src: string; sourcePath?: DrivePath; meta?: Record<string, unknown> };

export type EigenClipboardData = {
    version: 1;
    items: EigenClipboardItem[];
}
```

The payload is an array of items, allowing a user to copy multiple objects (like several selected slides or stickies) at once.

## 4. Cross-Document Media Handling

A critical challenge with inter-app copy-paste is **media ownership**. If a user copies an image from Document A and pastes it into Document B, Document B might not have ACL access to Document A's media folder, or if Document A is deleted, Document B's image would break.

The clipboard system provides utilities to handle this:

- **`needsReUpload(sourcePath, targetMediaFolderId)`**: Checks if the pasted image belongs to a different media folder than the current document.
- **`reUploadImage(...)`**: Fetches the image blob from its source URL and re-uploads it into the target document's `media/` folder, returning the new local `DrivePath` and embed URL.

## 5. API Usage

### Writing to Clipboard

**Synchronous (during a `copy` event):**
```typescript
import {writeEigenClipboard} from '@workspace/lib/clipboard';

const onCopy = (e: ClipboardEvent) => {
    e.preventDefault();
    writeEigenClipboard(e, { version: 1, items: [...] }, "Plain text fallback");
};
```

**Asynchronous (from a button click or menu):**
```typescript
import {writeEigenClipboardAsync} from '@workspace/lib/clipboard';

const handleCopyButton = async () => {
    await writeEigenClipboardAsync({ version: 1, items: [...] }, "Plain text fallback");
};
```

### Reading from Clipboard

**During a `paste` event:**
```typescript
import {readEigenClipboard} from '@workspace/lib/clipboard';

const onPaste = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    
    const eigenData = readEigenClipboard(e.clipboardData);
    if (eigenData) {
        e.preventDefault();
        // Handle eigenData.items
        return;
    }
    
    // Fallback to standard paste
};
```
