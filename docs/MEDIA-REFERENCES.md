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
   are handled by `getUniqueFileName()` which appends `#1`, `#2`, etc.
2. **Folder structure is fixed** — media files are always in `{doc}/media/`, chats in `{doc}/chat/`, chat attachments
   in `{chat}/media/`.

## What's Stored Where

| App | Yjs/SQLite Field | Stores | Example |
|-----|-----------------|--------|---------|
| **eigendoc** | `resizableImage.mediaName` | Image file name | `photo.png` |
| **eigendoc** | `commentMark.chatName` | Chat folder name | `comment-1710523456.eigenchat` |
| **eigenslides** | `ImageObject.mediaName` | Image file name | `photo.png` |
| **eigenslides** | `SlideItem.backgroundMediaName` | Background image name | `bg.jpg` |
| **eigenstickies** | `CardItem.chatName` | Chat folder name | `task-1710523456.eigenchat` |
| **eigenchat** | `messages.attachments` | JSON array of file names | `["photo.png","doc.pdf"]` |

## Resolution at Render Time

Names are resolved to pathIds (for API calls) or URLs (for `<img src>`) using `useFolderLookup`, which wraps
`useFolderContent` with refetch-on-miss logic (triggers a single refetch per unknown name to handle the case where
a collaborator uploads a file and Yjs propagates the name before the query cache updates).

**`MediaResolverProvider`** (`packages/lib/src/core/drive/media-resolver.tsx`) wraps editors and provides:
- `resolveMediaUrl(name)` — returns preview URL or null (uses `getDrivePreviewUrl`)
- `resolveMediaPath(name)` — returns DrivePath or undefined
- `resolveChatId(name)` — returns pathId or null
- `mediaFolderId` — the media folder's pathId (used by clipboard for `needsReUpload()` comparison)

Used by: eigendoc editor (wraps `TiptapEditor`), eigenslides editor, eigenstickies board.

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
