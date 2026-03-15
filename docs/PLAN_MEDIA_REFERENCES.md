# Proposal: Name-Based Media References

## TLDR

Eigen documents store references to embedded files (images, chats) using pathIds and hardcoded URLs. This breaks on
copy because copied files get new UUIDs. Fix: store the file **name** instead of pathId/URL. Since names are unique
per folder (enforced by `Mount.assertUniqueName()`) and the folder structure is known (`media/` for images, `chat/`
for comments), we can always resolve a name back to the correct file. This also eliminates the `API_HOST` portability
problem as a free bonus.

---

## The Problem

Eigen documents are folders. A `.eigendoc` contains `data.db` (Yjs state), `media/` (uploaded images), and `chat/`
(comment threads as `.eigenchat` containers). The Yjs state references these embedded files, but each app stores
references differently — some as full hardcoded URLs, some as raw pathId UUIDs, some as entire serialized DrivePath
objects.

When you copy a document, every embedded file gets a new UUID. The Yjs state in the copy still points to the
original UUIDs. Images work only as long as the originals exist. Comments silently break. This affects templates,
"Save a Copy", and team-to-personal copies.

---

## Current State: The Mess

### Document Structure (all collab types)

```
My Document.eigendoc/
├── data.db              # Yjs state (snapshots + updates)
├── media/               # Uploaded images
│   ├── photo.png        # pathId: uuid-1, name: "photo.png"
│   └── screenshot#1.png # pathId: uuid-2, name: "screenshot#1.png"
└── chat/                # Comment threads
    ├── comment-1710523456.eigenchat/   # pathId: uuid-3
    │   ├── data.db                     # SQLite messages
    │   └── media/                      # Message attachments
    └── comment-1710523789.eigenchat/   # pathId: uuid-4
        ├── data.db
        └── media/
```

### What Each App Stores in Yjs/SQLite

| App | Field | What's Stored | Location | Example |
|-----|-------|---------------|----------|---------|
| **eigendoc** | `resizableImage.src` | Full absolute URL with `API_HOST` + pathId | Yjs XmlFragment `'default'` | `http://localhost:8000/drive/{ownerId}/{mountId}/file/{uuid}/embed/image` |
| **eigendoc** | `commentMark.chatId` | Raw pathId (UUID) | Yjs XmlFragment `'default'` | `a1b2c3d4-e5f6-7890-...` |
| **eigenslides** | `ImageObject.src` | Full absolute URL with `API_HOST` + pathId | Yjs Map `'objects'` | Same URL format as eigendoc |
| **eigenslides** | `ImageObject.sourcePath` | **Entire serialized DrivePath object** | Yjs Map `'objects'` | `{id:"uuid",name:"photo.png",ownerId:"...",mountId:"...",...}` |
| **eigenslides** | `SlideItem.backgroundImage` | Full absolute URL | Yjs Map `'slides'` | Same URL format |
| **eigenslides** | `SlideItem.backgroundImageSourcePath` | **Entire serialized DrivePath object** | Yjs Map `'slides'` | Same DrivePath object |
| **eigenstickies** | `CardItem.chatId` | Raw pathId (UUID) | Yjs Map `'tasks'` | `a1b2c3d4-e5f6-7890-...` |
| **eigenchat** | `messages.attachments` | JSON array of pathIds | SQLite `messages` table | `["uuid-5","uuid-6"]` |
| **eigensheets** | — | No media references | — | — |

### What's Wrong With This

1. **Full URLs break on copy** — pathId in URL points to original, not the copy
2. **Full URLs break on server change** — `API_HOST` is baked in (`http://localhost:8000`)
3. **Raw pathIds break on copy** — UUIDs change, references become stale
4. **Serialized DrivePath objects are wasteful** — storing entire objects in Yjs when only one field is needed
5. **Every app does it differently** — no consistent pattern, each is its own flavor of broken

### Where References Are Created (Code Locations)

| Reference | Created At | How |
|-----------|-----------|-----|
| eigendoc image src | `apps/docs/src/components/docs/editor.tsx:271` | `getDriveEmbedUrl(ownerId, mountId, result.id, 'image')` |
| eigendoc comment chatId | `apps/docs/src/components/docs/comment-dialog.tsx:46` | `onCommentCreated(chatPath.id)` |
| eigenslides image src | `apps/slides/src/components/slides/editor.tsx:151` | `getDriveEmbedUrl(ownerId, mountId, result.id, 'image')` |
| eigenslides sourcePath | `apps/slides/src/components/slides/editor.tsx:155` | `sourcePath: result` (full DrivePath) |
| eigenslides background | `apps/slides/src/components/slides/editor.tsx:322` | Same pattern as image src |
| eigenstickies chatId | `apps/stickies/src/components/stickies/hooks/use-board.ts:176` | `newTaskMap.set('chatId', chatId)` where chatId = `(result as DrivePath)?.id` |
| eigenchat attachments | `packages/lib/src/core/chat/hooks/use-chat-room.ts:79` | `uploaded.filter(Boolean).map(u => (u as DrivePath).id)` |

---

## The Fix: Store Name, Not PathId

### Why This Works

Two guarantees make name-based references safe:

1. **Names are unique per folder.** `Mount.assertUniqueName()` (`apps/api/src/lib/mount/mount.ts:170`) enforces
   case-insensitive uniqueness. Both `createFile()` and `createFolder()` call it. `Drive.uploadFile()` handles
   conflicts via `getUniqueFileName()` which appends `#1`, `#2`, etc.

2. **Folder structure is known and fixed.** Media files are always in `{doc}/media/`. Comment/card chats are always
   in `{doc}/chat/`. Chat attachments are always in `{chat}/media/`. This is set up by `CollabDocument.create()`
   and `ChatRoom.create()`.

After a copy, all files keep their **names** but get new **UUIDs**. If the Yjs state stores names instead of UUIDs,
references in the copy resolve correctly against the copy's own files. No rewriting needed.

### What To Store

| App | Field | Currently | Proposed |
|-----|-------|-----------|----------|
| **eigendoc** | `resizableImage.src` | Full URL with pathId | File **name** (e.g., `photo.png`) |
| **eigendoc** | `commentMark.chatId` | Raw pathId | Chat folder **name** (e.g., `comment-1710523456.eigenchat`) |
| **eigenslides** | `ImageObject.src` | Full URL with pathId | File **name** |
| **eigenslides** | `ImageObject.sourcePath` | Entire DrivePath | **Remove entirely** |
| **eigenslides** | `SlideItem.backgroundImage` | Full URL | File **name** |
| **eigenslides** | `SlideItem.backgroundImageSourcePath` | Entire DrivePath | **Remove entirely** |
| **eigenstickies** | `CardItem.chatId` | Raw pathId | Chat folder **name** |
| **eigenchat** | `messages.attachments` | JSON array of pathIds | JSON array of file **names** |

### How Names Get Resolved at Render Time

Names need to be resolved back to pathIds (for API calls) or to URLs (for `<img src>`). The existing folder
contents hook (`GET /drive/:ownerId/:mountId/folder/:pathId`) already provides everything we need.

**For images — resolve from media folder contents:**

The frontend already knows `mediaFolderId` from `useCollabDocumentInfo().folderContents`. Fetch the media
folder's children using the existing folder listing endpoint, build a `name → DrivePath` map, and construct
embed URLs using the resolved pathId.

```typescript
// Fetch media folder contents using existing endpoint
const { data: mediaContents } = useFolderContents(ownerId, mountId, mediaFolderId);
const mediaMap = new Map(mediaContents?.map(f => [f.name, f]) ?? []);

// Resolve name → embed URL
function resolveMediaUrl(fileName: string): string | null {
    const file = mediaMap.get(fileName);
    if (!file) return null;
    return getDriveEmbedUrl(ownerId, mountId, file.id, fileName);
}
```

**For chat references — resolve from chat folder contents:**

Same pattern. The frontend knows `chatFolderId` from `folderContents`. Fetch the chat folder's children,
build a `name → pathId` map.

```typescript
const { data: chatContents } = useFolderContents(ownerId, mountId, chatFolderId);
const chatMap = new Map(chatContents?.map(c => [c.name, c.id]) ?? []);
const resolvedChatId = chatMap.get(chatName); // "comment-1710523456.eigenchat" → uuid
```

**For chat attachments — same pattern:**

Each `.eigenchat` has its own `media/` subfolder. Fetch its contents and resolve attachment names to pathIds
using the same lookup pattern.

---

## Changes Per App

### 1. API (backend)

No new routes needed. Existing `GET /drive/:ownerId/:mountId/folder/:pathId` and
`GET /drive/:ownerId/:mountId/file/:pathId/embed/:fileName` are sufficient.

### 2. eigendoc

**`apps/docs/src/components/docs/extensions/resizable-image.tsx`**:
- Rename attribute from `src` to `mediaName` (or keep `src` but change its semantics)
- Component receives a `resolveMediaUrl(name)` function via context/props
- Constructs image URL at render time by resolving name → pathId → embed URL

**`apps/docs/src/components/docs/editor.tsx`**:
- On image upload: store `result.name` instead of `getDriveEmbedUrl(...)` 
- On comment creation: store `chatPath.name` instead of `chatPath.id`
- On comment click: resolve `chatName → chatId` from chat folder contents

**`apps/docs/src/components/docs/extensions/comment-mark.ts`**:
- Rename attribute from `chatId` to `chatName` (semantic change)

### 3. eigenslides

**`apps/slides/src/components/slides/types.ts`**:
- `ImageObject`: replace `src: string` + `sourcePath?: DrivePath` with `mediaName: string`
- `SlideItem`: replace `backgroundImage: string` + `backgroundImageSourcePath?: DrivePath` with
  `backgroundMediaName: string`

**`apps/slides/src/components/slides/hooks/use-deck.ts`**:
- Remove `sourcePath` from `OBJECT_FIELDS`
- On image upload: store `result.name` instead of URL
- Remove `backgroundImageSourcePath` handling

**`apps/slides/src/components/slides/editor.tsx`**:
- Construct image URLs at render time by resolving name → pathId from media folder contents
- Simplify clipboard handling (no `sourcePath` to carry around)

### 4. eigenstickies

**`apps/stickies/src/components/stickies/types.ts`**:
- `CardItem`: rename `chatId?: string` to `chatName?: string`

**`apps/stickies/src/components/stickies/hooks/use-board.ts`**:
- On card creation: store `chatPath.name` instead of `chatPath.id`

**`apps/stickies/src/components/stickies/card-dialog.tsx`**:
- Resolve `chatName → chatId` from chat folder contents before rendering chat

### 5. eigenchat

**`packages/lib/src/core/chat/hooks/use-chat-room.ts`**:
- On file upload: store `result.name` instead of `result.id` in attachments array

**`packages/ui/src/components/layout/chat/chat-message-list.tsx`**:
- `AttachmentChip`: resolve file name → pathId from chat's media folder contents
- Construct download/embed URL using existing `getDriveDownloadUrl()` with resolved pathId

### 6. Clipboard (`packages/lib/src/core/clipboard/`)

- `EigenClipboardData` items: carry `mediaName` instead of `src` URL
- On paste into a different document: download from source URL, upload to target media folder, store new file's
  `name` in Yjs (the name may differ if there's a conflict, handled by `getUniqueFileName()`)
- `needsReUpload()` and `reUploadImage()`: adapt to work with names instead of pathIds
- `sourcePath` field on clipboard items: no longer needed

---

## Bonus: API_HOST Portability

With name-based references, **no `API_HOST` is stored in Yjs state at all**. URLs are constructed at render time
from the current `API_HOST`. This means documents are immediately portable between servers — change the API host,
and all images still work. This was previously identified as separate technical debt; the name-based approach
eliminates it for free.

---

## Document Copy (Future)

With name-based references in place, document copy becomes straightforward:

1. **Deep copy the directory tree** — recursive walk, `createFile`/`createFolder` for each node, copy file bytes
2. **Done** — no Yjs rewriting, no SQLite rewriting, no pathId mapping

The only thing copy needs to handle is generating a unique name for the copy itself (via `getUniqueFileName()`).
All internal references resolve correctly because they use names, not UUIDs.

---

## Implementation Order

1. **Add `useFolderContents` hook** (or reuse existing) for fetching media/chat folder children
2. **Migrate eigendoc** — simplest, only two reference types (image src, comment chatId)
3. **Migrate eigenstickies** — one reference type (card chatId), same pattern as doc comments
4. **Migrate eigenslides** — most fields to change but same pattern, plus removal of `sourcePath`
5. **Migrate eigenchat attachments** — SQLite instead of Yjs, but same name-based principle
6. **Update clipboard** — adapt copy/paste to work with name-based references
7. **Implement document copy** — `Mount.copyPath()` with recursive deep copy, no rewriting needed
