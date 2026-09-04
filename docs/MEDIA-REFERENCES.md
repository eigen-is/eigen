# Media References Inside Eigendocs

> **TLDR**: All embedded file references (images, chats, attachments) in Yjs/SQLite state are stored as **file names**,
> not pathIds or URLs. Names are unique per folder (enforced by `Mount.assertUniqueName()`). At render time, names are
> resolved to pathIds via folder contents. This makes document copy trivial (no Yjs rewriting) and eliminates
> `API_HOST` portability issues.

## Why Names

When a document is copied, every embedded file gets a new UUID but keeps its **name**. If Yjs stores names instead of
UUIDs, references in the copy resolve correctly against the copy's own files. No rewriting needed.

Two guarantees make this safe:

1. **Names are unique per folder** — `Mount.assertUniqueName()` enforces case-insensitive uniqueness. Upload conflicts
   are handled by `getUniqueFileName()` (`apps/api/src/lib/drive/naming.ts`), which appends ` (2)`, ` (3)`, … before
   the extension (`photo.png` → `photo (2).png`). It is extension-aware, case-insensitive, and re-uses an existing
   ` (n)` suffix as its starting counter instead of stacking a second one.
2. **Folder structure is fixed** — media files are always in `{doc}/media/`, chats in `{doc}/chat/`, chat attachments
   in `{chat}/media/`.

## What's Stored Where

| App | Yjs/SQLite Field | Stores | Example |
|-----|-----------------|--------|---------|
| **eigendoc** | `figure.mediaName` | Image file name | `photo.png` |
| **eigendoc** | `comments` card `.chatName` | Chat folder name | `comment-1710523456.eigenchat` |
| **eigenslides / eigenvector** | `image` element `.mediaName` | Image file name | `photo.png` |
| **eigenslides / eigenvector** | frame `.background` (image variant) | Background image name | `{ type: 'image', mediaName: 'bg.jpg', fit: 'cover' }` |
| **eigenstickies** | `tasks` card `.chatName` | Chat folder name | `task-1710523456.eigenchat` |
| **eigenchat** | `messages.attachments` | JSON array of file names | `["photo.png","doc.pdf"]` |

The eigendoc image node is `figure` (`packages/lib/src/docs/eigendoc/nodes/figure.ts`) — an inline
atom whose `mediaName` attribute is the only durable reference; `src` is filled in at render time.
A canvas frame background (one slide) is a `BackgroundFill` union (`packages/lib/src/types/background.ts`)
of `solid` / `gradient` / `image`, and only the `image` variant carries a `mediaName`; the infinite
canvas' own `meta.background` is a plain colour token and never names media. Comment
anchors are the exception to the name rule: the eigendoc `comment` mark stores a `cardId`, and the
card itself (in the doc's Yjs `comments` map) carries the `chatName`.

## Resolution at Render Time

Names are resolved to pathIds (for API calls) or URLs (for `<img src>`) using `useFolderLookup`, which wraps
`useFolderContent` with refetch-on-miss logic (triggers a single refetch per unknown name to handle the case where
a collaborator uploads a file and Yjs propagates the name before the query cache updates).

**`MediaResolverProvider`** (`packages/lib/src/core/drive/media-resolver.tsx`) wraps editors and provides:
- `resolveMediaUrl(name)` — returns preview URL or null (uses `getDrivePreviewUrl`)
- `resolveMediaPath(name)` — returns DrivePath or undefined
- `resolveChatId(name)` — returns pathId or null
- `mediaFolderId` — the media folder's pathId (used by clipboard for `needsReUpload()` comparison)
- `startUpload(file)` — returns `{ pendingName, promise }` and starts the upload

Used by: eigendoc editor (wraps `TiptapEditor`), eigenslides editor, eigensheets editor
(`apps/sheets/src/components/sheets/editor.tsx`), eigenstickies board.

### The `pending:` optimistic-name protocol

`startUpload(file)` hands back a synthetic name — `pending:<uuid>`, recognised by
`isPendingMediaName()` — and registers a local `URL.createObjectURL(file)` blob for it. The caller
writes that name into Yjs immediately, so `resolveMediaUrl()` returns the blob URL and the image
renders on the very next frame. This is how insert and paste feel instant.

When the upload settles, the caller swaps every node still holding the pending name over to the real
file name (`swapFigureMediaName` in the docs editor, the canvas engine's untracked element swap, its equivalent in sheets); a failed
upload resolves to `null` and the caller removes the node instead. The provider preloads the server
preview URL (`probe.decode()`) before revoking the blob and defers the revoke by a macrotask, so the
`<img src>` swap has no flash. Pending entries live in a ref, not state — the context value stays
stable, so an upload does not re-render every image in the document.

A `pending:` name that outlives its tab (closed or reloaded mid-upload) is a zombie: nothing can
resolve it any more. Sheets sweeps those on mount; the other surfaces do not yet.

For **chat attachments**, resolution happens differently: `ChatMessageList` receives `mediaFolderId` from `useChatRoom`,
and `AttachmentChip` calls `useFolderContent` on that folder to resolve attachment names.

## Clipboard

The clipboard is **transient** (not persisted in Yjs), so it keeps pathId-based source identifiers for re-upload
detection and downloading:

```typescript
type EigenClipboardImageItem = {
    type: 'image';
    mediaName: string;              // file name (stored in Yjs on paste)
    sourcePathId: string;           // for downloading if re-upload needed
    sourceParentId: string | null;  // for needsReUpload() comparison
    sourceOwnerId: string;          // for constructing download URL
    sourceMountId: string;          // for constructing download URL
}
```

`needsReUpload()` compares `sourceParentId !== targetMediaFolderId`. On re-upload, the new file's **name** is stored
in Yjs (may differ from original if there's a name conflict).

## Document Copy

With name-based references, document copy is straightforward:

1. Deep copy the directory tree (recursive `createFile`/`createFolder`, copy file bytes)
2. Done — no Yjs rewriting, no SQLite rewriting, no pathId mapping

All internal references resolve correctly because they use names, not UUIDs.
