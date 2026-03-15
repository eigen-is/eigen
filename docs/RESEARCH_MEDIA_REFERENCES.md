# Research: Media References Across Eigen Document Types

> Deep research into how media files (images, attachments, embedded chats) are referenced inside Eigen's document types,
> and how to make document copying work correctly so all internal references point to the copied media -- not the
> originals.

## Table of Contents

1. [Current State Audit](#current-state-audit)
2. [Reference Type Taxonomy](#reference-type-taxonomy)
3. [The Copy Problem](#the-copy-problem)
4. [Current Copy Behavior and What Breaks](#current-copy-behavior-and-what-breaks)
5. [How Other Products Solve This](#how-other-products-solve-this)
6. [Embedded Chat Deep Dive](#embedded-chat-deep-dive)
7. [Content-Addressable Storage Possibility](#content-addressable-storage-possibility)
8. [Proposed Solutions](#proposed-solutions)
9. [Reference Rewriting Algorithm](#reference-rewriting-algorithm)
10. [Impact on Existing Features](#impact-on-existing-features)
11. [Edge Cases](#edge-cases)
12. [Moving Documents](#moving-documents)
13. [Garbage Collection for Orphaned Media](#garbage-collection-for-orphaned-media)
14. [Yjs Rewriting Safety Analysis](#yjs-rewriting-safety-analysis)
15. [Cross-Cutting Concerns](#cross-cutting-concerns)
16. [Implementation Phases](#implementation-phases)

---

## Current State Audit

### Document Internal Structure

Every Eigen document type (`.eigendoc`, `.eigenslides`, `.eigenstickies`, `.eigensheets`, `.eigenchat`) is represented
in the drive as a container (type != `file`). When created, `CollabDocument.create()` or `ChatRoom.create()` sets up
the internal structure:

```
my-document.eigendoc/          # type: 'doc', parentId in metadata.db
  data.db                       # SQLite: Yjs updates + snapshots (collab schema)
  media/                        # folder containing uploaded images
    <uuid>.png                  # each file has its own pathId in metadata.db
    <uuid>.jpg
  chat/                         # folder containing embedded comment chats
    task-1710000000.eigenchat/
      data.db                   # chat message database
      media/                    # chat's own media folder (for chat attachments)
```

Key code: `CollabDocument.create()` in `apps/api/src/lib/collab/collabDocument.ts:156-159`:

```typescript
static async create(drive: Drive, mountId: string, docId: string): Promise<void> {
    await drive.touchFile(mountId, docId, 'data.db', 'application/x-sqlite3');
    await drive.createFolder(mountId, docId, 'media');
    await drive.createFolder(mountId, docId, 'chat');
}
```

Note: `ChatRoom.create()` (`apps/api/src/lib/chat/chat.ts:32-35`) creates the same structure but without a `chat/`
subfolder:

```typescript
static async create(drive: Drive, mountId: string, roomId: string): Promise<void> {
    await drive.touchFile(mountId, roomId, 'data.db', 'application/x-sqlite3');
    await drive.createFolder(mountId, roomId, 'media');
}
```

All these entries (data.db, media folder, individual media files, chat folder, individual chats) are rows in the mount's
`metadata.db`. Each has a UUID `id` (the `pathId`), a `parentId` pointing to the container, and a `file` field used by
the storage backend to locate the actual bytes on disk.

### Per-Document-Type Breakdown

#### 1. `.eigendoc` (Tiptap + Yjs)

**Storage structure**: `data.db` + `media/` + `chat/`

**Media references in Yjs content**:

Images are inserted via the `ResizableImage` Tiptap extension
(`apps/docs/src/components/docs/extensions/resizable-image.tsx`). When an image is uploaded:

1. The file is uploaded to the document's `media/` folder via the standard drive upload API
2. An embed URL is constructed via `getDriveEmbedUrl()`: `{API_HOST}/drive/{ownerId}/{mountId}/file/{pathId}/embed/image`
3. This full absolute URL is stored as the `src` attribute of a `resizableImage` node in the Yjs document

The Tiptap node attributes stored in Yjs (verified against `ResizableImage.addAttributes()`):

| Attribute   | Type     | Description                                        | Contains reference? |
|-------------|----------|----------------------------------------------------|---------------------|
| `src`       | `string` | Full absolute URL: `{API_HOST}/drive/{ownerId}/{mountId}/file/{pathId}/embed/image` | **Yes** -- pathId embedded in URL |
| `alt`       | `string` | Alt text (optional)                                | No |
| `title`     | `string` | Title (optional)                                   | No |
| `width`     | `number` | Display width in pixels (optional)                 | No |
| `alignment` | `string` | `'left'` / `'center'` / `'right'` (default: `'center'`) | No |

The critical field is `src`. It contains the **pathId** of the media file, embedded in a URL. This pathId is a UUID that
is specific to a particular row in `metadata.db`.

**Comment references in Yjs content**:

Comments use the `CommentMark` extension (`apps/docs/src/components/docs/extensions/comment-mark.ts`). A comment is a
Tiptap mark (not a node) with one attribute:

| Attribute | Type     | Description                                        | Contains reference? |
|-----------|----------|----------------------------------------------------|---------------------|
| `chatId`  | `string` | pathId of a `.eigenchat` inside the doc's `chat/` folder | **Yes** -- raw pathId |

The `chatId` is the **pathId** of an eigenchat directory stored as a child of the document's `chat/` folder.

**Other Tiptap extensions -- verified not to contain references**:

The editor (`apps/docs/src/components/docs/editor.tsx`) loads these extensions: StarterKit (headings, paragraphs, lists,
blockquotes, code, horizontal rule), Underline, Subscript, Superscript, Typography, TextStyle, Color, CharacterCount,
TextAlign, TaskList, TaskItem, Link, CodeBlockLowlight, Table + TableRow + TableCell + TableHeader, Highlight,
Collaboration, CollaborationCursor.

Of these, only `ResizableImage` and `CommentMark` store media references. The `Link` extension stores `href` URLs, but
these are external links (not references to drive-managed files). Tables do not embed images -- table cells contain
standard Tiptap content nodes, so images inside table cells are the same `resizableImage` nodes already covered above.

There is no file embed node (no PDF/document embed), no audio node, and no video node. The only media type stored in
eigendoc is images.

**What is embedded in the URL pattern**:

```
{API_HOST}/drive/{ownerId}/{mountId}/file/{pathId}/embed/{fileName}
```

The URL is generated by `getDriveEmbedUrl()` in `packages/lib/src/core/api.ts:86`:
```typescript
export const getDriveEmbedUrl = (ownerId: string, mountId: string, pathId: string, fileName: string) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/embed/${fileName}`;
```

The URL contains the host prefix plus three identity components: `ownerId`, `mountId`, and `pathId`. All three must be
correct for the image to load. On copy, `ownerId` and `mountId` remain the same (copy within same drive), but every
`pathId` changes because each file in the copy gets a new UUID.

#### 2. `.eigenslides` (Yjs)

**Storage structure**: `data.db` + `media/` + `chat/`

**Media references in Yjs content**:

Slides store image data in a Yjs `Map` called `objects`, where each object has a type. Image objects
(`apps/slides/src/components/slides/types.ts`) store:

| Field          | Type        | Description                                        | Contains reference? |
|----------------|-------------|----------------------------------------------------|---------------------|
| `src`          | `string`    | Full absolute URL, same pattern as eigendoc         | **Yes** -- pathId in URL |
| `objectFit`    | `string`    | `'contain'` / `'cover'` / `'fill'`                 | No |
| `sourcePath`   | `DrivePath` | Full DrivePath object of the uploaded file (optional) | **Yes** -- entire DrivePath |

Slides also support background images on slide items:

| Field                        | Type        | Description                                        | Contains reference? |
|------------------------------|-------------|----------------------------------------------------|---------------------|
| `backgroundImage`            | `string`    | Full absolute URL                                  | **Yes** -- pathId in URL |
| `backgroundImageSourcePath`  | `DrivePath` | Full DrivePath object (optional)                   | **Yes** -- entire DrivePath |

The `sourcePath` / `backgroundImageSourcePath` fields store an **entire serialized DrivePath object** in the Yjs
document. This includes the `id`, `mountId`, `ownerId`, `parentId`, `name`, etc. This is used by the clipboard system's
`needsReUpload()` function to determine if an image needs to be re-uploaded when pasted into a different document.

**Yjs structure** (from `use-deck.ts`):

```
Y.Doc
  slides: Y.Map<slideId -> Y.Map{id, backgroundColor, backgroundImage, backgroundImageSourcePath, objectIds: Y.Array}>
  objects: Y.Map<objId -> Y.Map{id, slideId, type, x, y, w, h, rotation, src, objectFit, sourcePath, ...}>
  slideOrder: Y.Array<slideId>
```

Note: The `OBJECT_FIELDS` constant in `use-deck.ts:12` lists all serialized fields. These include shadow properties
(`shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY`) that are not in the `types.ts` type definitions but are
present in the Yjs serialization code. None of these shadow fields contain references.

**Note on `duplicateSlide()`**: The existing slide duplication (`use-deck.ts:179-221`) copies all object attributes
including `src` directly. It does **not** duplicate the media files or rewrite URLs. This means the duplicated slide's
images still point to the same media files as the original. Within the same document this is fine because the media files
are shared, but on a full document copy it would break.

**Note on chat folder**: Eigenslides creates a `chat/` folder via `CollabDocument.create()`, but there is currently no
UI for creating comment threads on slides. The `chat/` folder exists but is unused. If comment support is added to
slides in the future, it would follow the same `chatId` pattern as eigendoc comments.

#### 3. `.eigenstickies` (Yjs)

**Storage structure**: `data.db` + `media/` + `chat/`

**References in Yjs content**:

Stickies cards have one reference type -- the `chatId` field (`apps/stickies/src/components/stickies/types.ts`):

| Field     | Type     | Description                                        | Contains reference? |
|-----------|----------|----------------------------------------------------|---------------------|
| `chatId`  | `string` | pathId of an `.eigenchat` in the stickies' `chat/` folder (optional) | **Yes** -- raw pathId |

Each card can have an associated chat room. The chat is created in the stickies document's `chat/` folder via
`createCardChat()` in `use-board.ts`. Notably, a chat is created for **every** card by default (in
`handleAddCard()` at line 160), not just when the user explicitly opens a chat.

**Yjs structure** (from `use-board.ts`):

```
Y.Doc
  tasks: Y.Map<taskId -> Y.Map{id, title, description, color, creator, createdAt, chatId}>
  columns: Y.Map<columnId -> Y.Map{id, title, taskIds: Y.Array, creator, createdAt}>
  columnOrder: Y.Array<columnId>
```

Stickies currently have **no direct image/media references** in the Yjs content. The `media/` folder is created by
`CollabDocument.create()` but is unused by the stickies app itself. The only reference is `chatId`, which points to a
chat that may itself contain attachments.

#### 4. `.eigensheets` (Yjs + fortune-sheet)

**Storage structure**: `data.db` + `media/` + `chat/`

**References in Yjs content**:

Sheets store their state as a JSON snapshot string in a Yjs `Map`:

```
Y.Doc
  state: Y.Map{snapshot: string (JSON of SheetData[])}
  ops: Y.Array (incremental operations)
```

Sheets currently have **no image or media references**. The `media/` and `chat/` folders are created by the generic
`CollabDocument.create()` but are unused. The sheet data is purely cell values, formatting, and formulas stored as
serialized JSON. Verified by examining `use-sheet.ts` -- the `SheetData` type is `Record<string, any> & { name: string }`,
and the fortune-sheet fork does not add image insertion capabilities.

#### 5. `.eigenchat` (SQLite)

**Storage structure**: `data.db` + `media/` (no `chat/` subfolder)

**References in database rows**:

Chat is the only document type that uses SQLite directly (not Yjs) for its content. The `messages` table
(`apps/api/src/lib/chat/schema.ts`) has:

| Column        | Type             | Description                                        | Contains reference? |
|---------------|------------------|----------------------------------------------------|---------------------|
| `attachments` | `text (json)` -> `string[] \| null` | Array of pathIds of files in the chat's `media/` folder | **Yes** -- array of raw pathIds |
| `replyTo`     | `text`           | ID of another message in the same chat             | No (intra-chat, not a pathId) |

The chat also has a `read_state` table (`apps/api/src/lib/chat/schema.ts:18-22`):

| Column              | Type   | Description                                 | Contains reference? |
|---------------------|--------|---------------------------------------------|---------------------|
| `userId`            | `text` | User who read messages                      | No |
| `lastReadMessageId` | `text` | Last message ID read                        | No (intra-chat) |
| `lastReadAt`        | `integer` | Timestamp of last read                   | No |

When a user sends a message with attachments:

1. Files are uploaded to the chat's `media/` folder via `uploadFile.mutateAsync({parentId: mediaFolder.id, file})`
2. The resulting `DrivePath.id` values (pathIds) are stored as the `attachments` array on the message row

The `AttachmentChip` component (`packages/ui/src/components/layout/chat/chat-message-list.tsx:33`) resolves these pathIds
back to file info via `useFileInfo(ownerId, mountId, pathId)` and constructs download URLs via `getDriveDownloadUrl()`:
`{API_HOST}/drive/{ownerId}/{mountId}/file/{pathId}/download`.

The `AttachmentChip` also renders thumbnails for image attachments using `getDriveThumbnailUrl()`. Thumbnails are stored
in the mount's `thumbs/` directory and are keyed by pathId, so they would also need copying or regeneration.

When a message is deleted, `ChatRoom.deleteMessage()` iterates over `attachments` and calls
`drive.deleteFile(mountId, attachmentId)` for each.

**Note on attachment types**: Chat attachments are generic files -- any file type can be attached, not just images. There
is no dedicated audio message type or voice recording feature. Audio files can be uploaded as regular attachments.

---

## Reference Type Taxonomy

All media references in Eigen can be classified into these types:

### Type 1: Absolute URL References (eigendoc, eigenslides)

```
{API_HOST}/drive/{ownerId}/{mountId}/file/{pathId}/embed/image
```

Stored as a string in Yjs node attributes (`src`). Contains the API host prefix plus three identity components:
`ownerId`, `mountId`, `pathId`. The `pathId` is the critical part -- it is a UUID that maps to a specific row in
`metadata.db`. The `API_HOST` prefix is set from `packages/lib/src/core/api.ts` at runtime and is typically
`http://localhost:8000` in development.

**Used by**: eigendoc `resizableImage.src`, eigenslides `ImageObject.src`, eigenslides `SlideItem.backgroundImage`

**Important**: The URL also bakes in the current `API_HOST`. This means documents are not portable across servers or
even across port changes. This is an orthogonal problem to copy, but worth noting as a design debt. If the server moves
to a different host/port, all existing embedded URLs break.

### Type 2: pathId References (eigenstickies, eigenchat, eigendoc comments)

A raw UUID string that is the `id` of a DrivePath entry in `metadata.db`.

**Used by**:
- eigendoc `CommentMark.chatId` -- points to an eigenchat in the doc's `chat/` folder
- eigenstickies `CardItem.chatId` -- points to an eigenchat in the stickies' `chat/` folder
- eigenchat `messages.attachments[]` -- array of pathIds pointing to files in the chat's `media/` folder

### Type 3: Serialized DrivePath Objects (eigenslides)

An entire `DrivePath` object serialized into the Yjs document. Contains `id`, `mountId`, `ownerId`, `parentId`, `name`,
`mimeType`, `size`, `thumbnail`, etc.

**Used by**: eigenslides `ImageObject.sourcePath`, eigenslides `SlideItem.backgroundImageSourcePath`

These are used by the clipboard system's `needsReUpload()` to decide if an image being pasted comes from the same
`media/` folder (same `parentId`) or needs re-uploading.

### Type 4: External URLs

Standard `http://` or `https://` URLs that point to external resources (not managed by Eigen). These appear in Tiptap
`Link` nodes and possibly in image `src` attributes if an image was pasted from an external source.

**These must NOT be rewritten during copy.**

Detection: An internal URL always matches the pattern `{API_HOST}/drive/{ownerId}/{mountId}/file/{pathId}/embed/...`.
Any URL that does not match this pattern is external. The `rewriteEmbedUrl()` function should check for this pattern
specifically rather than checking for `http://localhost` or any hardcoded host, since the `API_HOST` can vary.

### What is NOT a reference (verified absent)

The following were investigated and confirmed not to exist in the current codebase:

- **File embeds in eigendoc**: No PDF/document embed node exists. Only `resizableImage` handles media.
- **Link previews / OpenGraph images**: No local storage of link preview images. External links are stored as plain URLs.
- **User avatars in comments**: Avatars are resolved at render time via `usePublicUser()`. They are not stored in the
  document or chat. No reference to rewrite.
- **Audio/video messages in chat**: Chat has no dedicated audio/video message type. Audio/video files are uploaded as
  regular attachments (covered by the `attachments[]` pathId array).
- **Slide comments**: The `chat/` folder exists in eigenslides containers but no UI creates comment chats there.
- **Sheet media**: No image insertion UI exists in sheets. The `media/` and `chat/` folders are created but unused.

---

## The Copy Problem

### The Core Issue

When you copy (duplicate) an `.eigen*` document, the Drive system would need to:

1. Create a new container with a new UUID
2. Deep-copy all children (data.db, media files, chat subfolders) with new UUIDs
3. Copy the raw file data (the bytes on disk)

After step 3, the new document has a perfect byte-for-byte copy of `data.db`. But the Yjs state (or chat messages)
inside that database still contains references to the **original** pathIds.

**Concrete example**:

```
Original: my-doc.eigendoc (pathId: aaa)
  media/ (pathId: bbb)
    photo.png (pathId: ccc)
  data.db contains Yjs node: { type: 'resizableImage', src: '.../file/ccc/embed/image' }

Copy: my-doc (copy).eigendoc (pathId: xxx)
  media/ (pathId: yyy)
    photo.png (pathId: zzz)      <-- new UUID, same bytes
  data.db contains Yjs node: { type: 'resizableImage', src: '.../file/ccc/embed/image' }
                                                                        ^^^
                                                                    STILL POINTS TO ORIGINAL!
```

The image in the copy still loads (because `ccc` still exists and the user probably still has access). But this creates
several problems:

1. **Deletion cascade**: If the original is deleted, the copy's images break
2. **Permission divergence**: If the copy is shared with someone who does not have access to the original, images fail
3. **Storage accounting**: The copy appears to use less storage than it actually does
4. **Independence violation**: The copy is not truly independent of the original
5. **Ownership confusion**: The copy's media folder has files that are never referenced

### Scope of the Problem

| Document type | Reference types affected | Complexity |
|---------------|------------------------|------------|
| `.eigendoc`   | URL (images), pathId (comments->chats) | High -- must parse Yjs + rewrite URLs + recursively copy embedded chats |
| `.eigenslides`| URL (images, backgrounds), DrivePath objects | High -- must parse Yjs + rewrite URLs + update serialized DrivePath objects |
| `.eigenstickies` | pathId (card chats) | Medium -- must rewrite chatIds + recursively copy embedded chats |
| `.eigensheets` | None currently | Low -- no media references to rewrite |
| `.eigenchat` | pathId (message attachments) | Medium -- must rewrite attachment pathIds in SQLite rows |

---

## Current Copy Behavior and What Breaks

### No Copy Exists

**There is currently no document copy/duplicate feature in Eigen's Drive system.** Verified by examining:

- `apps/api/src/lib/drive/drive.ts` -- no `copyPath()`, `duplicatePath()`, or similar method
- `apps/api/src/lib/mount/mount.ts` -- no copy method on Mount
- `apps/api/src/routes/drive.ts` -- no copy endpoint (the only `copy` endpoint is mail message copy)
- `packages/ui/src/components/layout/drive/` -- no "Duplicate" or "Copy" context menu item

The only "duplication" that exists is:

1. **Slide duplication** (`use-deck.ts:duplicateSlide`, lines 179-221) -- duplicates a slide within the same document.
   This copies Yjs object data including `src` URLs and `sourcePath` objects, which is correct because the media files
   are in the same document's `media/` folder.

2. **Clipboard copy-paste between documents** -- The clipboard system (`packages/lib/src/core/clipboard/clipboard.ts`)
   handles this with `needsReUpload()` and `reUploadImage()`. When pasting an image into a different document, it
   detects that `sourcePath.parentId !== targetMediaFolderId` and re-downloads + re-uploads the image, generating a new
   URL. This is the only place where cross-document media portability is handled.

### What Would Break if a Naive Copy Were Implemented

If someone implemented a simple recursive directory copy (copy all paths with new UUIDs, copy all file bytes):

| What breaks | Why | Severity |
|---|---|---|
| All images in eigendoc | URL contains old pathId | All images show broken/load from original |
| All images in eigenslides | URL contains old pathId | Same as above |
| All background images in eigenslides | URL contains old pathId | Slides show wrong/broken backgrounds |
| All `sourcePath` objects in eigenslides | Contains old pathId, parentId, etc. | Clipboard re-upload logic breaks |
| All comment threads in eigendoc | `chatId` points to original's chat folder | Comments open original's chats |
| All card chats in eigenstickies | `chatId` points to original's chat folder | Cards open original's chats |
| All chat message attachments | `attachments[]` contains old pathIds | Attachments load from original / break on deletion |
| Thumbnails | Thumbnail filenames in `thumbs/` are keyed by pathId | Copy's thumbnails are missing |

---

## How Other Products Solve This

### Google Docs

Google Docs uses content-addressable storage for images. When you insert an image, it is stored in a global blob store
keyed by content hash. The document references the image by its content hash (or an opaque ID that is internally mapped
to a content hash). When you "Make a Copy", the new document references the same blobs -- no bytes are duplicated, and
no references need rewriting. This works because Google's blob store is immutable and shared across documents.

### Notion

Notion stores media in S3 with per-block IDs. When you duplicate a page, Notion creates new blocks with new IDs but the
media URLs are updated server-side during the copy operation. The copy is async -- large pages with many images take time
to duplicate. Notion uses signed S3 URLs that are regenerated on access, so the actual storage key can be remapped.

### Confluence / Atlassian

Confluence stores attachments as "page attachments" with IDs relative to the page. When copying a page, all attachments
are duplicated and the page body's references are rewritten. This is done server-side in a single transaction.

### CRDTs and Reference Rewriting

Yjs documents do not have built-in support for "reference rewriting" because the CRDT model is about merging concurrent
edits, not about rewriting content. The standard approach is:

1. Deserialize the Yjs binary state into a Y.Doc
2. Mutate the Y.Doc in memory (rewrite references using normal Y.Map/Y.XmlFragment APIs)
3. Re-encode the modified state as a Yjs update
4. Store the update in a fresh database

This is safe as long as the copy is performed while no one is editing the document (or the document is not yet opened
for collaboration). See [Yjs Rewriting Safety Analysis](#yjs-rewriting-safety-analysis) for a detailed discussion.

---

## Embedded Chat Deep Dive

Embedded chats are the most complex reference type because they are **recursive containers with their own media**.

### How Embedded Chats Work

**In eigendoc (comments)**:

1. User selects text and clicks "Add Comment"
2. `CreateCommentDialog` creates a new `.eigenchat` in the document's `chat/` folder
3. The chat's pathId is stored as a `CommentMark` attribute (`chatId`) on the selected text in Yjs
4. The comment chat can have its own media attachments (via the chat input's paperclip button)

**In eigenstickies (card chats)**:

1. When a card is created, `createCardChat()` (`use-board.ts:35-45`) creates a new `.eigenchat` in the stickies'
   `chat/` folder with the name `task-{timestamp}`
2. The chat's pathId is stored as `chatId` in the card's Yjs Map
3. The card chat can have its own media attachments

### The Recursive Copy Problem

Copying a document with embedded chats requires:

```
Copy eigendoc
  Copy media/ files, build pathId mapping {old -> new}
  Copy chat/ folder
    For each embedded .eigenchat:
      Copy chat's data.db
      Copy chat's media/ files, extend pathId mapping
      Rewrite attachment pathIds in copied chat's messages table
  Rewrite Yjs state in copied data.db:
    - Image src URLs: replace pathIds using mapping
    - Comment chatIds: replace with new chat pathIds from mapping
```

This is a three-level deep copy: document -> embedded chat -> chat media.

### Chat Data Structure

The chat database is simple SQLite (`apps/api/src/lib/chat/schema.ts`):

```sql
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    authorId TEXT NOT NULL,
    authorEmail TEXT NOT NULL,
    type TEXT NOT NULL,      -- 'message' | 'emote' | 'whisper' | 'system'
    content TEXT NOT NULL,
    attachments JSON,        -- string[] of pathIds, or null
    whisperTo TEXT,
    replyTo TEXT,
    editedAt INTEGER,
    deletedAt INTEGER,
    createdAt INTEGER NOT NULL
);

CREATE TABLE read_state (
    userId TEXT PRIMARY KEY,
    lastReadMessageId TEXT,
    lastReadAt INTEGER
);
```

The `attachments` column is the only field that contains media references. The `replyTo` field references other message
IDs within the same chat (not pathIds), so it does not need rewriting on copy.

---

## Content-Addressable Storage Possibility

### The Idea

Instead of identifying media files by their pathId (which changes on copy), identify them by a hash of their content
(SHA-256). The URL would become:

```
/drive/{ownerId}/{mountId}/blob/{contentHash}/image.png
```

Since the content hash does not change when a file is copied, no references in the Yjs document or chat messages would
need rewriting.

### Relationship to File Hashing Proposal

The file hashing research (`docs/RESEARCH_FILE_HASHING.md`) proposes adding content hashes to the Drive paths schema
for integrity verification and duplicate detection. Phase 1 of that proposal (hash on upload) would add a `hash` column
to the paths table. This is a natural stepping stone toward content-addressable media URLs:

1. **Phase 1 (file hashing)**: Add hash field to paths table, compute on upload
2. **Phase 2 (CAS for media)**: Add a blob resolution endpoint that looks up files by hash
3. **Phase 3 (CAS URLs in documents)**: New uploads use hash-based URLs; old pathId URLs still work

If file hashing is implemented first, the CAS approach becomes significantly cheaper to adopt later.

### Trade-offs

| Advantage | Disadvantage |
|---|---|
| Copy never needs reference rewriting for media | Requires a new storage layer (blob store) |
| Natural deduplication (same image uploaded twice = one blob) | Cannot rename or move individual media files |
| Immutable references are simpler to reason about | Garbage collection needed (when is a blob no longer referenced?) |
| Works across documents, users, and teams | Breaks the "everything is a DrivePath in metadata.db" model |
| External URLs stay unchanged (they are not hashes) | Requires migrating all existing media references |

### Why Not Adopt It Now

Content-addressable storage is the right long-term architecture, but it requires:

1. A new blob storage backend (`BlobStore` alongside existing `StorageBackend`)
2. A new routing layer for blob URLs
3. Migration of all existing documents to use blob references
4. Garbage collection to clean up orphaned blobs
5. Changes to every app's image upload flow

This is a large architectural change. For now, the reference-rewriting approach is simpler, more localized, and can be
implemented without changing the storage model.

### Future Path

If content-addressable storage is later adopted:

1. New uploads would store blobs by hash and return hash-based URLs
2. Old URLs with pathIds would still work (backward compatible)
3. Copy would be trivial: just copy the `data.db`, no reference rewriting needed
4. A migration script could gradually rewrite old references

---

## Proposed Solutions

### Solution A: Server-Side Reference Rewriting at Copy Time

**Approach**: When copying an `.eigen*` document, the server performs a deep copy with a reference rewriting pass.

**Steps**:

1. Recursively copy the directory structure, assigning new UUIDs. Build a mapping `{oldPathId -> newPathId}`.
2. For collab documents (eigendoc, eigenslides, eigenstickies, eigensheets):
   a. Open the copied `data.db`
   b. Read the latest Yjs snapshot + any pending updates
   c. Apply them to a temporary `Y.Doc`
   d. Mutate the Y.Doc in memory using standard Yjs APIs (setAttribute, map.set, etc.)
   e. Encode the modified state as a Yjs update
   f. Store as a single fresh snapshot in the copied `data.db`
3. For chat documents (eigenchat):
   a. Open the copied `data.db`
   b. Update all `attachments` columns using the pathId mapping
   c. Clear the `read_state` table
4. Handle nested structures (chats inside docs/stickies) by processing inner chats first, then outer documents.

**Pros**:
- No change to storage architecture
- No change to how references are stored
- Copy is atomic and complete
- Works with all existing URL patterns

**Cons**:
- Requires Yjs dependency on the server (already exists -- `collabDocument.ts` imports `yjs`)
- Type-specific rewriting logic for each document type
- Must be updated when new reference types are added
- Copy is synchronous and may be slow for large documents

### Solution B: Relative References

**Approach**: Change all media references to use relative paths instead of absolute URLs with pathIds.

Instead of: `{API_HOST}/drive/{ownerId}/{mountId}/file/{pathId}/embed/image`
Use: `eigen://media/{fileName}` (resolved at render time using document context)

**Pros**:
- Copy is trivial -- just copy the directory, references work automatically
- Simpler mental model
- Portable across servers (no baked-in host)
- Solves the API_HOST change problem as a side effect

**Cons**:
- Breaking change to all existing documents (requires migration)
- Requires a URL resolver on the frontend to map relative paths to API URLs
- File names may not be unique (would need UUID-based names anyway, defeating the purpose)
- Does not solve the embedded chat problem (chatIds would still need to be pathIds or some identifier)
- Sharing becomes harder (need to resolve the document's context to serve media)
- `needsReUpload()` clipboard logic would need redesigning

### Solution C: Manifest-Based Approach

**Approach**: Store a manifest file alongside `data.db` that maps logical media IDs to physical pathIds.

```json
{
  "media": {
    "img-001": "actual-pathId-uuid-here",
    "img-002": "actual-pathId-uuid-here"
  },
  "chats": {
    "comment-001": "actual-pathId-uuid-here"
  }
}
```

The Yjs document uses logical IDs (`img-001`) instead of pathIds. On copy, only the manifest needs updating, not the
Yjs state.

**Pros**:
- Yjs state never contains physical pathIds
- Copy only needs to rewrite the manifest
- Easy to inspect and debug
- Adds a natural "table of contents" for document media

**Cons**:
- Adds an indirection layer that complicates every read path
- Requires manifest lookup on every image load
- Must keep manifest in sync with Yjs state (two sources of truth)
- Migration required for existing documents

### Recommendation: Solution A (Server-Side Rewriting)

Solution A is the pragmatic choice because:

1. It requires no changes to the reference format or storage model
2. It is a self-contained addition (a new `copyDocument()` method on `Drive`)
3. It works with all existing URLs and clients
4. The Yjs state can be safely modified using the standard Yjs API (see safety analysis below)
5. It can be implemented incrementally (one document type at a time)

Solution C (manifest) is the best long-term architecture, but the migration cost is not justified until the copy feature
proves the need. Solution B (relative references) has too many downsides around sharing and resolution, though its
portability benefit is worth noting as a future consideration.

---

## Reference Rewriting Algorithm

### Overview

```
copyDocument(mountId, pathId, targetParentId) -> DrivePath
  1. Get source path and validate
  2. Ensure collab document is flushed (if active)
  3. Create destination container (new UUID)
  4. Deep-copy children, building pathId map
  5. Rewrite references in destination data stores
  6. Copy/regenerate thumbnails
  7. Return new DrivePath
```

### Step-by-Step

#### Phase 1: Deep Copy with Mapping

```typescript
type PathMapping = Map<string, string>; // oldId -> newId

async function deepCopyPath(
    mount: Mount,
    sourceId: string,
    targetParentId: string,
    mapping: PathMapping
): Promise<string> {
    const source = await mount.getPath(sourceId);
    const newId = randomUUID();
    mapping.set(sourceId, newId);

    if (source.type === 'file') {
        // Copy file bytes
        const data = await mount.readFile(sourceId);
        await mount.createFileWithId(newId, targetParentId, source.name, source.mimeType, data);
    } else {
        // Create container
        await mount.createFolderWithId(newId, targetParentId, source.name, source.type);
        // Recursively copy children
        const children = await mount.listFolder(sourceId);
        for (const child of children) {
            await deepCopyPath(mount, child.id, newId, mapping);
        }
    }

    return newId;
}
```

Note: `Mount` does not currently have `createFileWithId()` or `createFolderWithId()` methods. These would need to be
added to allow specifying the UUID rather than generating one internally. Alternatively, the existing `createFile()` and
`createFolder()` methods could be modified to accept an optional `id` parameter.

#### Phase 2: Rewrite Yjs State (eigendoc, eigenslides, eigenstickies)

```typescript
async function rewriteCollabReferences(
    dataDbPath: string,
    mapping: PathMapping,
    ownerId: string,
    mountId: string,
    documentType: 'doc' | 'slides' | 'stickies' | 'sheets'
): Promise<void> {
    // Open the copied data.db directly (not via ManagedDatabase -- it is not an active document)
    const db = new Database(dataDbPath);

    // Get latest snapshot
    const snapshot = db.query('SELECT stateData, lastUpdateId FROM doc_snapshots ORDER BY id DESC LIMIT 1').get();

    // Decode Yjs state
    const doc = new Y.Doc();

    if (snapshot) {
        Y.applyUpdate(doc, snapshot.stateData);

        // Apply any pending updates after the snapshot
        const updates = db.query('SELECT updateData FROM doc_updates WHERE id > ?')
            .all(snapshot.lastUpdateId);
        for (const update of updates) {
            Y.applyUpdate(doc, update.updateData);
        }
    } else {
        // No snapshot -- apply all updates
        const updates = db.query('SELECT updateData FROM doc_updates ORDER BY id ASC').all();
        for (const update of updates) {
            Y.applyUpdate(doc, update.updateData);
        }
    }

    // Rewrite references based on document type
    switch (documentType) {
        case 'doc':
            rewriteDocReferences(doc, mapping, ownerId, mountId);
            break;
        case 'slides':
            rewriteSlidesReferences(doc, mapping, ownerId, mountId);
            break;
        case 'stickies':
            rewriteStickiesReferences(doc, mapping);
            break;
        case 'sheets':
            // No references to rewrite
            break;
    }

    // Save rewritten state as a single fresh snapshot
    const newState = Y.encodeStateAsUpdate(doc);
    db.run('DELETE FROM doc_updates');
    db.run('DELETE FROM doc_snapshots');
    db.run('INSERT INTO doc_snapshots (stateData, lastUpdateId) VALUES (?, 0)', [Buffer.from(newState)]);

    doc.destroy();
    db.close();
}
```

#### Phase 3: Rewrite Specific Document Types

**eigendoc**: Walk the Yjs XmlFragment, find `resizableImage` nodes and `comment` marks.

```typescript
function rewriteDocReferences(doc: Y.Doc, mapping: PathMapping, ownerId: string, mountId: string) {
    const fragment = doc.getXmlFragment('default'); // Tiptap stores in 'default' fragment

    doc.transact(() => {
        // Walk all nodes in the Yjs XML fragment
        walkYjsFragment(fragment, (node) => {
            // Rewrite image src URLs
            if (node instanceof Y.XmlElement && node.nodeName === 'resizableImage') {
                const src = node.getAttribute('src');
                if (src) {
                    const newSrc = rewriteEmbedUrl(src, mapping);
                    if (newSrc !== src) {
                        node.setAttribute('src', newSrc);
                    }
                }
            }

            // Rewrite comment marks in text nodes
            if (node instanceof Y.XmlText) {
                // Y.XmlText stores marks as formatting attributes on text runs.
                // The mark attributes need to be walked via the delta format.
                const delta = node.toDelta();
                // CommentMark attributes are in delta[i].attributes.comment.chatId
                // Rewriting marks requires deleting and re-inserting formatted text,
                // which is complex. An alternative is to use the JSON export approach.
            }
        });
    });
}

function rewriteEmbedUrl(url: string, mapping: PathMapping): string {
    // Match pattern: /drive/{ownerId}/{mountId}/file/{pathId}/embed/{fileName}
    const match = url.match(/\/drive\/([^/]+)\/([^/]+)\/file\/([^/]+)\/embed\/(.+)/);
    if (!match) return url; // External URL, do not rewrite

    const [, , , pathId] = match;
    const newPathId = mapping.get(pathId);
    if (!newPathId) return url; // PathId not in mapping, leave unchanged

    return url.replace(`/file/${pathId}/`, `/file/${newPathId}/`);
}
```

**Important note on comment mark rewriting**: Tiptap marks are stored as formatting attributes on `Y.XmlText` runs.
Rewriting mark attributes (like `comment.chatId`) on `Y.XmlText` is nontrivial because Yjs does not expose a direct
"update mark attribute" API. The practical approach is:

1. Export the Y.Doc's `default` fragment as JSON (via `yXmlFragmentToJson` or similar)
2. Walk the JSON tree and rewrite all `comment` mark `chatId` values
3. Delete and re-create the fragment content from the modified JSON

This is the approach used by Tiptap's own import/export and is safe for a copy (where the document has no active
collaborators).

**eigenslides**: Walk the objects Map, rewrite `src` and `sourcePath` on image objects, and `backgroundImage` /
`backgroundImageSourcePath` on slides.

```typescript
function rewriteSlidesReferences(doc: Y.Doc, mapping: PathMapping, ownerId: string, mountId: string) {
    const objects = doc.getMap('objects');
    const slides = doc.getMap('slides');

    doc.transact(() => {
        // Rewrite image objects
        for (const [, objMap] of objects) {
            const yObj = objMap as Y.Map<any>;
            if (yObj.get('type') === 'image') {
                const src = yObj.get('src');
                if (src) {
                    yObj.set('src', rewriteEmbedUrl(src, mapping));
                }
                const sourcePath = yObj.get('sourcePath') as DrivePath | undefined;
                if (sourcePath && mapping.has(sourcePath.id)) {
                    yObj.set('sourcePath', {
                        ...sourcePath,
                        id: mapping.get(sourcePath.id)!,
                        parentId: mapping.get(sourcePath.parentId!) ?? sourcePath.parentId,
                    });
                }
            }
        }

        // Rewrite slide background images
        for (const [, slideMap] of slides) {
            const ySlide = slideMap as Y.Map<any>;
            const bgImage = ySlide.get('backgroundImage');
            if (bgImage) {
                ySlide.set('backgroundImage', rewriteEmbedUrl(bgImage, mapping));
            }
            const bgSourcePath = ySlide.get('backgroundImageSourcePath') as DrivePath | undefined;
            if (bgSourcePath && mapping.has(bgSourcePath.id)) {
                ySlide.set('backgroundImageSourcePath', {
                    ...bgSourcePath,
                    id: mapping.get(bgSourcePath.id)!,
                    parentId: mapping.get(bgSourcePath.parentId!) ?? bgSourcePath.parentId,
                });
            }
        }
    });
}
```

**eigenstickies**: Walk the tasks Map, rewrite `chatId`.

```typescript
function rewriteStickiesReferences(doc: Y.Doc, mapping: PathMapping) {
    const tasks = doc.getMap('tasks');

    doc.transact(() => {
        for (const [, taskMap] of tasks) {
            const yTask = taskMap as Y.Map<any>;
            const chatId = yTask.get('chatId');
            if (chatId && mapping.has(chatId)) {
                yTask.set('chatId', mapping.get(chatId)!);
            }
        }
    });
}
```

#### Phase 4: Rewrite Chat Messages

```typescript
async function rewriteChatReferences(dataDbPath: string, mapping: PathMapping): Promise<void> {
    const db = new Database(dataDbPath);

    const messages = db.query('SELECT id, attachments FROM messages WHERE attachments IS NOT NULL').all();

    for (const msg of messages) {
        const attachments = JSON.parse(msg.attachments) as string[];
        const rewritten = attachments.map(id => mapping.get(id) ?? id);

        if (rewritten.some((id, i) => id !== attachments[i])) {
            db.run('UPDATE messages SET attachments = ? WHERE id = ?', [
                JSON.stringify(rewritten),
                msg.id,
            ]);
        }
    }

    // Clear read state -- no one has "read" the copied chat
    db.run('DELETE FROM read_state');

    db.close();
}
```

### Processing Order

The rewriting must happen in the correct order:

1. Deep-copy the entire directory tree (all children recursively), building the complete pathId mapping
2. Rewrite embedded chats first (their `data.db` `attachments` columns)
3. Rewrite the parent document's `data.db` (Yjs state referencing chat pathIds and media pathIds)

This ensures the mapping is complete before any rewriting begins.

---

## Impact on Existing Features

### Sharing and ACLs

**Impact**: Low. Copy should create the new document with no ACLs (private by default). The original's sharing settings
are not carried over. Users explicitly re-share the copy if needed.

The copy operation itself only needs read access to the source and write access to the target parent folder.

### Preview System

**Impact**: Low. Previews are generated from the file content, not from references. Thumbnails are stored per-file in
the mount's `thumbs/` directory keyed by pathId. Thumbnails for copied media files would need to be either:

- **Copied**: Copy the thumbnail file from `thumbs/{oldPathId}.webp` to `thumbs/{newPathId}.webp`
- **Regenerated**: Let thumbnails be generated lazily on first access

Copying is cheaper and instant. The pathId mapping makes this straightforward.

### Clipboard System

**Impact**: Low. The clipboard system already handles cross-document media with `needsReUpload()`. After copy,
clipboard operations between the original and the copy work correctly because the clipboard always checks `parentId`
proximity.

However, the serialized `sourcePath` objects in eigenslides Yjs state should be updated during copy (the `parentId`
should point to the new media folder). If not updated, clipboard pastes from the copy may unnecessarily re-upload
images.

### SSE / Real-time

**Impact**: None. The copy creates a new document that is not being collaboratively edited. SSE events for the copy
are independent of the original. The `DRIVE_FILE_CREATED` event is emitted as usual.

### Revision History

**Impact**: The copy starts with a fresh revision history. The copied `data.db` contains the rewritten Yjs state as a
single snapshot. Historical snapshots from the original are discarded during the rewriting step (the database is
rebuilt with just the current state). This is intentional -- the copy's history begins at copy time.

---

## Edge Cases

### 1. Copying a Document That Is Being Edited

If someone is actively editing the original while it is being copied, the Yjs state in `data.db` may be stale (recent
updates are in the in-memory Y.Doc, not yet snapshotted). Solutions:

- **Option A**: Force a snapshot before copying. The `DbProvider.createSnapshot()` method (called from
  `DbProvider.destroy()`) flushes the current state. Calling `closeCollabDocument()` triggers `provider.destroy()` which
  creates a snapshot. But this closes the WebSocket connections and disrupts collaborators.
- **Option B**: Copy the current on-disk state, accepting that recent (last few seconds) edits may be missing from the
  copy. The `DbProvider` creates snapshots every 100 updates (`SNAPSHOT_INTERVAL`), so the staleness is bounded. This
  is acceptable for most use cases.
- **Option C**: Access the in-memory Y.Doc directly from the CollabDocument instance if it is active. Call
  `Y.encodeStateAsUpdate()` on the live doc, then use that state for the copy instead of reading from disk. This gives
  the most up-to-date copy but requires coordination with the collab system.
- **Recommendation**: Option B for simplicity. Option C if freshness matters.

### 2. External Image URLs in Tiptap

Users can paste images with external `http://` URLs into eigendoc. The rewriting algorithm must distinguish between:

- Internal URLs: `/drive/{ownerId}/{mountId}/file/{pathId}/...` -- rewrite
- External URLs: `https://example.com/image.png` -- leave unchanged

The `rewriteEmbedUrl()` function handles this by checking the URL pattern.

### 3. Cross-Owner Copying

If a document shared by user A is copied by user B into user B's drive, the `ownerId` in all URLs must also be
rewritten. The mapping must include `ownerId` transformation. The `rewriteEmbedUrl()` function should accept the
target `ownerId` and `mountId` and rewrite the full URL path, not just the pathId segment.

### 4. Cross-Mount Copying

Currently each user has one mount (`default`). If multi-mount support grows, copying across mounts requires `mountId`
transformation in URLs.

### 5. Orphaned Media Files

If a user uploads an image, then deletes it from the document (but the file remains in the `media/` folder), the copy
will include this orphaned file. This is acceptable -- it matches the behavior of the original. See
[Garbage Collection for Orphaned Media](#garbage-collection-for-orphaned-media) for a future cleanup mechanism.

### 6. Broken References

If a media file referenced in the Yjs state was already deleted (broken reference in the original), the copy will have
the same broken reference. The rewriting algorithm should gracefully handle missing mappings (leave the reference
unchanged).

### 7. Very Large Documents

Documents with hundreds of images or large chat histories may take significant time to copy. Consider:

- Showing a progress indicator during copy
- Performing the copy asynchronously with an SSE notification on completion
- Streaming the copy to avoid memory pressure

### 8. Data.db In Use (SQLite Locking)

If the collab document is currently open (active WebSocket connections), the `data.db` may have a WAL file with pending
writes. The copy should include the WAL state. SQLite's `VACUUM INTO` can create a consistent copy of a database
including WAL contents. Note: Eigen does not currently use `VACUUM INTO` anywhere -- this would be new.

### 9. Undo After Copy

The copy is an independent document. Undo in the original does not affect the copy, and vice versa. This is the correct
behavior.

### 10. Nested Eigendocs (Future)

Currently, eigendocs cannot contain other eigendocs. But if this feature were added (e.g., embedded documents), the copy
algorithm would need to recurse into nested documents. The current algorithm design supports this naturally because it
already handles the doc -> chat recursion pattern.

### 11. Chat Message IDs and replyTo

Chat messages have `replyTo` fields that reference other message IDs within the same chat. Since message IDs are UUIDs
generated at creation time, the copy has the same message IDs as the original. This is fine because message IDs only
need to be unique within a single chat database, and the copied chat has its own `data.db`. The `replyTo` chain is
preserved correctly.

### 12. Read State in Copied Chats

The `read_state` table in chat databases tracks which messages each user has read. On copy, this data should be
**cleared** (no one has "read" the copied chat). This avoids leaking information about who accessed the original and
ensures a clean starting state. The rewriting algorithm includes `DELETE FROM read_state` for all copied chat databases.

### 13. Deleted Messages with Attachments

When a message is deleted, `ChatRoom.deleteMessage()` sets `deletedAt` and clears `content`, then deletes the
attachment files from the media folder. However, the `attachments` column is not cleared -- it still contains the old
pathIds. On copy, these pathIds would be in the mapping (since the media files were copied before deletion), but the
referenced files may no longer exist if they were deleted. The rewriting algorithm handles this gracefully: it rewrites
what it can and leaves unmapped references unchanged.

---

## Moving Documents

### Do References Break When Moving?

**No -- within the same mount, moves are reference-safe.** The `movePath()` method in `Drive` (`drive.ts:334-357`)
only changes the `parentId` of the moved path. The `pathId` itself does not change. Since all internal references
(URLs, chatIds, attachment pathIds) use the `pathId` (not the parentId or any path-based location), moving a document
to a different folder within the same mount preserves all references.

Specifically, `mount.updatePath(pathId, {parentId: targetParentId})` updates only the tree position. The `id`,
`ownerId`, `mountId`, and `file` fields are unchanged.

### When Moves Would Break References

References would break in these (currently unsupported) scenarios:

1. **Cross-mount move**: If a document were moved from one mount to another, it would get new pathIds for all its
   children (since each mount has its own `metadata.db`). This is equivalent to copy + delete and would require the
   same reference rewriting as copy. Cross-mount moves are not currently implemented.

2. **Cross-owner move**: If a document were moved from one user's drive to another, the `ownerId` in all URLs would
   become wrong. Cross-owner moves are not currently implemented. The `movePath()` method restricts moves to within
   the same mount and validates that the target parent is a folder.

### Recommendation

No action needed for the current move implementation. If cross-mount or cross-owner moves are ever implemented, they
should use the same reference rewriting pipeline as copy.

---

## Garbage Collection for Orphaned Media

### The Problem

Media files can become orphaned in several ways:

1. User uploads an image to the document's `media/` folder, then deletes the image from the document content (undo,
   manual deletion, etc.). The file remains in `media/`.
2. A document copy includes all `media/` files, including ones no longer referenced in the content.
3. Chat attachments on deleted messages may or may not be cleaned up (currently they are deleted in
   `ChatRoom.deleteMessage()`, so this is handled).

### Scope

Orphaned media files consume storage but are otherwise harmless. The risk is proportional to how frequently users add
and remove images from documents.

### Proposed Cleanup Mechanism

A `cleanupOrphanedMedia()` method on `Drive` or `CollabDocument` that:

1. Loads the current Yjs state from `data.db`
2. Extracts all referenced pathIds (from image URLs and chatIds)
3. Lists all files in `media/` and `chat/`
4. Deletes any files not referenced in the content

This should be:
- **Manual / admin-triggered** (not automatic) to avoid accidental deletion
- **Run only when no active collaborators** are editing the document
- **Logged** for audit purposes

### Interaction with Copy

The copy algorithm should NOT attempt to skip orphaned files. It should copy everything in `media/` and `chat/`
faithfully. Orphan cleanup, if desired, should be a separate operation run on the copy after it is created. This keeps
the copy algorithm simpler and avoids the risk of accidentally skipping a referenced file due to a parsing error.

---

## Yjs Rewriting Safety Analysis

### Is Direct Binary State Rewriting Safe?

**No. Never modify Yjs binary state directly.** The Yjs binary format encodes operations with client IDs, logical
clocks, and structural dependencies. Byte-level manipulation would corrupt the CRDT state and make the document
unsyncable.

### The Safe Approach: Deserialize, Modify, Reserialize

The correct approach (used in the algorithm above) is:

1. Create a new `Y.Doc()`
2. Apply the existing state via `Y.applyUpdate(doc, stateData)`
3. Modify the doc using standard Yjs APIs (`map.set()`, `xmlElement.setAttribute()`, etc.)
4. Encode the result via `Y.encodeStateAsUpdate(doc)`
5. Store the encoded state in the copied `data.db`

This is safe because:
- The Yjs API handles all CRDT bookkeeping (client IDs, clocks, tombstones)
- The modifications are treated as new operations from a new client
- The resulting state is a valid Yjs document

### What About Active Collab Sessions During Copy?

The copy reads from `data.db` (on-disk state), not from the in-memory `Y.Doc` in the `CollabDocument` instance.
Active collaborators may have pending updates that are not yet snapshotted. This means the copy may be slightly stale
(missing the last few seconds of edits). This is acceptable -- see Edge Case #1 above.

The copy does NOT interfere with the active session because it opens the database read-only (or a separate connection)
and creates a completely independent Y.Doc. There is no mutation of the original.

### What About Yjs Undo History?

Yjs undo history (`Y.UndoManager`) is local to the client session -- it is not persisted in `data.db`. The undo
history tracks operations by their CRDT metadata (client ID + clock). After a copy:

- The original document's undo history is unaffected (it is in-memory on the client)
- The copy starts with no undo history (no one has edited it yet)
- If someone opens the copy and undoes changes, they undo within the copy's own state

There is no risk of undo history containing old references that would point back to the original document's media.

### What About the Revision History?

The copy's `data.db` has a single snapshot (the rewritten state) and no updates. All historical snapshots from the
original are discarded. This is intentional -- the copy should have a clean slate. Historical revisions of the original
may contain references to files that exist in the original but not the copy, so keeping them would create confusion.

---

## Cross-Cutting Concerns

### Interaction with Copy-Paste (RESEARCH_COPY_PASTE.md)

The clipboard system (`packages/lib/src/core/clipboard/clipboard.ts`) and document-level copy are separate mechanisms
that serve different purposes:

- **Clipboard copy-paste**: Copies content _between_ documents at the node/object level. Uses `needsReUpload()` to
  detect when an image needs re-uploading to the target document's `media/` folder.
- **Document copy**: Duplicates an entire document including all of its media. Uses pathId mapping to rewrite
  references in bulk.

These two systems are independent and do not conflict. After a document is copied, clipboard operations between the
original and copy work correctly because `needsReUpload()` compares `sourcePath.parentId` against the target document's
`mediaFolderId` -- since the copy has a new `mediaFolderId`, it correctly detects that re-upload is needed when pasting
from the original into the copy (or vice versa).

The serialized `sourcePath` objects in eigenslides are updated during copy (parentId is remapped), ensuring clipboard
operations from the copy work correctly.

### Interaction with Document Export (RESEARCH_DOC_IMPORT_EXPORT.md)

Document export (to PDF, DOCX, etc.) resolves image URLs at export time by fetching the image data from the drive API.
This is unaffected by the copy mechanism because:

- Exported documents use the live URLs, which work for both originals and copies
- The export reads the Yjs state and resolves references at that moment
- No cross-reference between the export system and the copy system

Import is similarly unaffected: importing a DOCX into a new eigendoc uploads images to the new document's `media/`
folder and generates fresh URLs.

### Interaction with Sharing / ACLs

Copy creates a new document with **no ACLs** (private by default). This is the correct behavior:

- The user who creates the copy owns it
- The original's sharing settings do not propagate to the copy
- The copy's media files are independent, so no permission delegation is needed
- `propagateACLChange()` is not called for the copy's internal children (they inherit from the copy's root)

If the user wants to share the copy, they share it explicitly. ACL propagation (`apps/api/src/lib/drive/acl-propagation.ts`)
handles the new document independently of the original.

### Interaction with File Hashing Proposal (RESEARCH_FILE_HASHING.md)

If content hashing is implemented first:

1. Copied media files would have the same content hash as the originals (same bytes)
2. This enables future deduplication: instead of storing the same bytes twice, the copy could reference the same
   blob by hash
3. The hash provides a cheap way to verify that a copy's media files are identical to the originals

File hashing does not change the copy algorithm -- it is an orthogonal enhancement. But it makes the future transition
to content-addressable storage (Solution C above) significantly cheaper.

### Interaction with the Labels System

Files in the drive can have labels (via the `paths_to_labels` junction table in `metadata.db`). When copying a document,
the labels on the document container should either be:

- **Not copied** (the copy starts unlabeled) -- simpler and avoids confusion
- **Copied** (the copy inherits the original's labels) -- useful if labels represent categories

Labels on internal children (media files, data.db, chat folders) are irrelevant as they are not user-visible.

Recommendation: Do not copy labels. The user can add labels to the copy manually.

---

## Implementation Phases

### Phase 0: Add `copyPath()` to Mount (Foundation)

Add a recursive deep-copy method to `Mount` that copies a path tree and returns the pathId mapping.

**Files to modify**:
- `apps/api/src/lib/mount/mount.ts` -- add `copyPath(sourceId, targetParentId): Promise<{newId: string, mapping: PathMapping}>`
  This requires either adding `createFileWithId()` / `createFolderWithId()` methods or modifying existing create methods
  to accept an optional `id` parameter.

**Acceptance criteria**: Can copy a plain folder with files. New UUIDs, same bytes. Returns complete mapping.

### Phase 1: Copy Plain Files and Folders

Add `copyPath()` / `duplicatePath()` to `Drive` class, exposed via a new route.

**Files to modify**:
- `apps/api/src/lib/drive/drive.ts` -- add `copyPath()` method
- `apps/api/src/routes/drive.ts` -- add `POST /drive/:ownerId/:mountId/path/:pathId/copy`
- `packages/lib/src/core/drive/hooks/` -- add `useCopyPath()` hook

**Acceptance criteria**: Can copy folders and regular files. Document types are copied naively (broken references).

### Phase 2: Eigendoc Reference Rewriting

Implement Yjs state rewriting for eigendocs.

**Files to create/modify**:
- `apps/api/src/lib/collab/copy-references.ts` -- new file with rewriting logic
- `apps/api/src/lib/drive/drive.ts` -- call rewriter after copy for doc type

**Acceptance criteria**: Copied eigendoc images load correctly. Copy is independent of original (deleting original does
not break copy).

### Phase 3: Eigenslides Reference Rewriting

Implement Yjs state rewriting for eigenslides.

**Acceptance criteria**: Copied slide images and backgrounds work. `sourcePath` objects are updated.

### Phase 4: Chat Reference Rewriting

Implement SQLite row rewriting for eigenchat attachments.

**Files to create/modify**:
- `apps/api/src/lib/chat/copy-references.ts` -- new file with attachment rewriting

**Acceptance criteria**: Copied chat attachments load correctly. `read_state` is cleared.

### Phase 5: Eigenstickies and Embedded Chat Rewriting

Combine stickies chatId rewriting with the chat rewriting from Phase 4.

**Acceptance criteria**: Copied stickies boards have independent card chats. Chat attachments in card chats work.

### Phase 6: Eigendoc Comment Chat Rewriting

Combine eigendoc comment chatId rewriting with embedded chat copying.

**Acceptance criteria**: Copied eigendoc comments open independent chat threads. Comment chat attachments work.

### Phase 7: UI Integration

Add duplicate/copy option to the Drive file browser.

**Files to modify**:
- `packages/ui/src/components/layout/drive/drive-table.tsx` -- add context menu option
- `packages/lib/src/core/drive/hooks/` -- expose the copy mutation

**Acceptance criteria**: Users can right-click a document and select "Duplicate". Progress shown for large documents.

### Phase 8: Cross-Owner Copy

Handle copying shared documents into the current user's drive with ownerId rewriting.

**Acceptance criteria**: User B can copy a document shared by User A. All references point to User B's drive.
