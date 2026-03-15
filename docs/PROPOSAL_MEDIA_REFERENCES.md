# Proposal: Document Copy with Media Reference Rewriting

## TLDR

Implement server-side document duplication with reference rewriting. All media URLs and pathIds baked into Yjs state
and chat databases must be remapped to the new copy's file UUIDs. The approach: deep-copy the directory tree on the
Mount, build an old-to-new pathId mapping, then rewrite Yjs documents and chat SQLite rows using that mapping.
Relative references would avoid the rewriting problem but are a larger migration; save them for a future pass that
also fixes the API_HOST portability issue. Start with same-owner copy; cross-owner copy is Phase 2.

---

## Summary of Key Findings

The research document's audit of media references is accurate. Verified against the codebase:

| Document Type | Reference Fields | Storage | Verified |
|---|---|---|---|
| `.eigendoc` | `resizableImage.src` (absolute URL with pathId), `CommentMark.chatId` (raw pathId) | Yjs XmlFragment `'default'` | Yes -- `resizable-image.tsx` attrs: src, alt, title, width, alignment. `comment-mark.ts` attr: chatId |
| `.eigenslides` | `ImageObject.src` (URL), `ImageObject.sourcePath` (full DrivePath), `SlideItem.backgroundImage` (URL), `SlideItem.backgroundImageSourcePath` (DrivePath) | Yjs Maps `'objects'` and `'slides'` | Yes -- `types.ts` and `use-deck.ts` OBJECT_FIELDS confirms these |
| `.eigenstickies` | `CardItem.chatId` (raw pathId) | Yjs Map `'tasks'` | Yes -- `types.ts` and `use-board.ts` confirm chatId field |
| `.eigensheets` | None | Yjs Map `'state'` (JSON snapshot string) + Array `'ops'` | Yes -- `use-sheet.ts` confirms no media references |
| `.eigenchat` | `messages.attachments` (JSON array of pathIds) | SQLite `messages` table | Yes -- `schema.ts` and `chat.ts` deleteMessage logic confirms |

Additional verified facts:
- No copy/duplicate method exists anywhere in `Mount`, `Drive`, or drive routes
- `duplicateSlide()` in `use-deck.ts` copies object attributes directly (including `src` and `sourcePath`) without
  re-uploading media -- correct within a single document, broken for full document copy
- `needsReUpload()` in clipboard.ts compares `sourcePath.parentId` against `targetMediaFolderId` -- this works
  correctly post-copy since the copy gets a new media folder UUID
- `API_HOST` is baked into all embed/download URLs at `packages/lib/src/core/api.ts:86`
- `ChatRoom.deleteMessage()` deletes attachment files but does not clear the `attachments` column
- Mount's `createFile()` and `createFolder()` always generate new UUIDs internally via `randomUUID()`

---

## The Core Problem

Eigen documents are containers (directories in the metadata tree). Each container holds a `data.db` (Yjs or SQLite),
a `media/` folder, and optionally a `chat/` folder with embedded `.eigenchat` containers. Every child gets a UUID
(`pathId`) in `metadata.db`. Media references stored inside `data.db` point to specific pathIds.

When you deep-copy a container, every child gets a new UUID. The bytes are identical, but all pathId references inside
the copied `data.db` still point to the originals. The copy's images work only as long as the originals exist and the
user has access -- a silent correctness bug.

This is not an exotic edge case. Document templates, "Save a Copy", and team-to-personal copies all require this.

---

## Critical Evaluation of the Research

### What It Gets Right

1. The reference audit is thorough and accurate. Every claim about which fields contain references checks out.
2. The taxonomy (URL refs, pathId refs, serialized DrivePath refs) is useful.
3. The identification of eigensheets as reference-free is correct.
4. The processing order (copy tree first, then rewrite inner chats, then rewrite outer doc) is correct.
5. The observation that moves within the same mount are reference-safe is correct.

### Where It Overcomplicates or Misses

1. **The "3-level recursion" is not as scary as described.** The doc -> chat -> chat-media chain is just two rewrite
   passes: one for Yjs state, one for SQLite rows. The recursive directory copy is a single tree walk. Calling it
   "three-level deep" makes it sound harder than it is. It is two distinct rewrite algorithms (Yjs and SQLite),
   applied to different files in the same copy tree.

2. **The research does not address the API_HOST problem with sufficient urgency.** Every embed URL contains the
   literal `API_HOST` value (e.g., `http://localhost:8000`). This means:
   - Documents are not portable between servers
   - Changing the API port breaks all embedded images
   - Copy across owners on different servers is impossible

   However, fixing API_HOST is a separate effort. For copy within the same server, the host portion is identical
   between original and copy, so we only need to rewrite the pathId segment. The host stays unchanged.

3. **The content-addressable storage discussion is a distraction.** CAS is architecturally appealing but requires
   a new storage layer, a new URL scheme, migration of all existing documents, and garbage collection. It is a
   6-month project masquerading as a "future optimization". For document copy, reference rewriting is strictly
   simpler and more pragmatic. CAS should be evaluated independently when deduplication or cross-server portability
   becomes a priority.

4. **The manifest approach (Solution C) adds indirection with no clear payoff.** Two sources of truth (manifest +
   Yjs state) is worse than one. The rewriting approach keeps the single source of truth.

5. **The research underestimates the SQLite locking concern.** If a collab document is open, its `data.db` may be
   written to by the `DbProvider`. Reading from a WAL-mode SQLite database while another process writes is safe
   (SQLite guarantees reader isolation in WAL mode), but the copy may miss in-flight updates. This is acceptable.

---

## Reference Format Recommendation

**Keep the current absolute URL format for now. Rewrite pathIds in URLs during copy.**

The alternatives considered:

| Approach | Effort | Benefit | Verdict |
|---|---|---|---|
| **Keep current + rewrite on copy** | Low | Enables copy with no migration | **Do this** |
| **Relative refs (`eigen://media/filename`)** | High | Copy-proof, portable | Does not solve chatId/attachment refs. Requires frontend URL resolver. Does not justify migration cost now |
| **Content-addressable (hash-based URLs)** | Very high | Copy-proof, dedup | Requires new storage layer. Evaluate independently later |
| **Manifest (logical ID -> pathId)** | Medium | Copy only rewrites manifest | Two sources of truth. Not worth the indirection |

### Future: Fix API_HOST Separately

The `API_HOST` baked into URLs is technical debt. The correct fix is to store URLs without the host prefix and resolve
at render time. This is orthogonal to copy and should be a separate effort. When it is done, the copy rewriter
becomes simpler (fewer URL segments to match). But it is not a prerequisite for copy.

---

## Copy Algorithm

### Step 1: Deep Copy the Directory Tree

Add `copyPath(sourceId, targetParentId, newName?)` to `Mount`. This performs a recursive copy of the entire
subtree, generating new UUIDs for every node. It returns the new root pathId and a complete mapping of
`{oldPathId -> newPathId}`.

Key detail: `Mount.createFile()` and `Mount.createFolder()` always generate UUIDs internally. To build the mapping
without modifying these methods, the copy function should:
1. Walk the source tree
2. For each node, call the appropriate create method (which generates a new UUID)
3. Record `mapping.set(sourceNode.id, newNode.id)`
4. For files, read the source bytes and write them to the new file

This avoids adding `createFileWithId()` / `createFolderWithId()` methods. The existing APIs are sufficient.

For the new document name, use the `getUniqueFileName()` utility already in `apps/api/src/lib/drive/naming.ts` to
generate names like `Document#1.eigendoc`.

### Step 2: Rewrite Yjs State (eigendoc, eigenslides, eigenstickies)

Open the copied `data.db` directly (not via `ManagedDatabase` -- it is not an active collab session). Load the Yjs
state the same way `DbProvider.loadState()` does: latest snapshot + pending updates. Apply to a temporary `Y.Doc`.

Rewrite references using standard Yjs APIs, then save as a single fresh snapshot:

```
DELETE FROM doc_updates;
DELETE FROM doc_snapshots;
INSERT INTO doc_snapshots (stateData, lastUpdateId) VALUES (encoded_state, 0);
```

This gives the copy a clean revision history starting from the rewritten state.

**Per document type:**

- **eigendoc**: Walk `Y.XmlFragment('default')`. For `resizableImage` elements, rewrite `src` attribute (match
  `/file/{pathId}/embed/` and replace pathId). For `comment` marks on `Y.XmlText` nodes, rewrite `chatId`. The mark
  rewriting requires export-to-JSON, rewrite, re-import approach because Yjs does not expose a "modify mark attribute"
  API on XmlText.

- **eigenslides**: Iterate `objects` Map entries. For entries where `type === 'image'`, rewrite `src` (same URL
  pattern match) and `sourcePath` (replace `id` and `parentId` using mapping). Iterate `slides` Map entries. For
  entries with `backgroundImage`, rewrite the URL. For entries with `backgroundImageSourcePath`, rewrite `id` and
  `parentId`.

- **eigenstickies**: Iterate `tasks` Map entries. For entries with `chatId`, replace using mapping.

- **eigensheets**: No rewriting needed.

### Step 3: Rewrite Chat Databases

For each `.eigenchat` in the copied tree, open its `data.db`. Run:

```sql
UPDATE messages SET attachments = rewritten_json WHERE attachments IS NOT NULL;
DELETE FROM read_state;
```

Where `rewritten_json` maps each pathId in the array through the mapping.

### Step 4: Copy Thumbnails

For each file entry in the mapping, check if a thumbnail exists at `thumbs/{oldPathId}.webp`. If so, copy it to
`thumbs/{newPathId}.webp`. This is cheaper than regeneration and preserves thumbnail quality.

### Processing Order

1. Deep-copy entire directory tree (Step 1) -- builds complete mapping
2. Rewrite embedded chat databases (Step 3) -- these have no dependencies
3. Rewrite parent document Yjs state (Step 2) -- uses chatId mappings from Step 1
4. Copy thumbnails (Step 4)

Steps 2 and 3 could run in parallel since they operate on different files.

---

## Handling Embedded Chats

The recursion is simpler than the research implies:

1. The directory tree copy (Step 1) copies everything -- media files, chat containers, chat data.db files, chat media
   files -- in a single recursive walk. The mapping is built during this walk.
2. After the walk completes, we have a flat mapping of all old-to-new pathIds, including chat container pathIds and
   chat media file pathIds.
3. We then iterate over all `.eigenchat` containers in the copy and rewrite their `attachments` columns (Step 3).
4. We then rewrite the parent document's Yjs state, which includes chatId references (Step 2).

There is no actual recursion in the rewriting phase. The directory copy is recursive; the rewriting is two flat
passes over different file types.

---

## API Design

### Mount Level

```typescript
// In Mount class
async copyPath(
    sourceId: string,
    targetParentId: string,
    newName?: string
): Promise<{newId: string; mapping: Map<string, string>}>
```

This is a low-level operation: recursive directory copy with byte copying. No reference awareness. Returns the
complete pathId mapping.

### Drive Level

```typescript
// In Drive class
async copyDocument(
    mountId: string,
    sourceId: string,
    targetParentId: string,
    newName?: string
): Promise<DrivePath>
```

This is the high-level operation:
1. Validates permissions (read on source, write on target parent)
2. Calls `mount.copyPath()` to get raw copy + mapping
3. Detects document type from the source path's `type` field
4. Dispatches to the appropriate rewriter (Yjs or SQLite)
5. Copies thumbnails
6. Emits `DRIVE_FILE_CREATED` SSE event
7. Returns the new DrivePath

### Route

```
POST /drive/:ownerId/:mountId/path/:pathId/copy
Body: { targetParentId: string, newName?: string }
Response: DrivePath
```

### Frontend Hook

```typescript
// In packages/lib/src/core/drive/hooks/
export function useCopyPath(ownerId: string, mountId: string) {
    return useMutation({
        mutationFn: async (args: {pathId: string; targetParentId: string; newName?: string}) => {
            // POST to copy endpoint
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: driveKeys.all});
        },
    });
}
```

---

## Yjs State Manipulation

The safe approach, which the research correctly identifies:

1. `new Y.Doc()` -- fresh isolated document
2. `Y.applyUpdate(doc, stateData)` -- load from disk
3. Mutate using standard APIs (`map.set()`, `xmlElement.setAttribute()`)
4. `Y.encodeStateAsUpdate(doc)` -- serialize
5. Write to copied database
6. `doc.destroy()` -- cleanup

This is safe because Yjs treats mutations as new operations from a new client. The resulting state is a valid CRDT
document. No binary manipulation. No CRDT invariant violations.

**The tricky part: comment marks on XmlText.** Tiptap's `comment` mark stores `chatId` as a formatting attribute
on text runs. Yjs `XmlText.toDelta()` exposes these as `delta[i].attributes.comment`, but there is no
`updateMarkAttribute()` API. The practical approach:

1. For each `Y.XmlText` node with comment marks in its delta:
   - Extract the delta
   - Walk delta entries, rewrite `attributes.comment.chatId` values
   - Delete the XmlText content
   - Re-insert from the modified delta
2. Wrap in a `doc.transact()` for atomicity

This is the same approach Tiptap's own import/export uses. It is safe for a copy because no collaborators are
connected to the copy's Y.Doc.

---

## Frontend UI for Copy/Duplicate

Add a "Duplicate" context menu item to the drive table:

**File: `packages/ui/src/components/layout/drive/drive-table.tsx`**

- Add `Copy` icon from lucide-react
- Add `onDuplicate` callback prop
- Add menu item between "Edit access" and separator/delete:
  ```
  Duplicate
  ```
- For single items only (not multi-select, to keep it simple initially)

**Behavior:**
- Clicking "Duplicate" calls the `useCopyPath` mutation with `targetParentId` set to the item's own `parentId`
  (duplicate in place)
- On success, the drive list refreshes (query invalidation) and a toast shows "Document duplicated"
- The new document appears with name `Original#1.eigendoc` (using `getUniqueFileName`)

No progress indicator needed for Phase 1. Documents in Eigen are typically small (< 10MB). If large document
support becomes a concern, add async copy with SSE notification later.

---

## Concrete File Changes

### New Files

| File | Purpose |
|---|---|
| `apps/api/src/lib/collab/copy-references.ts` | Yjs rewriting logic for all document types |
| `apps/api/src/lib/chat/copy-references.ts` | SQLite attachment rewriting for chat |

### Modified Files

| File | Change |
|---|---|
| `apps/api/src/lib/mount/mount.ts` | Add `copyPath()` method |
| `apps/api/src/lib/drive/drive.ts` | Add `copyDocument()` method |
| `apps/api/src/routes/drive.ts` | Add `POST .../path/:pathId/copy` route |
| `packages/lib/src/core/drive/hooks/use-drive.ts` | Add `useCopyPath()` hook |
| `packages/ui/src/components/layout/drive/drive-table.tsx` | Add "Duplicate" context menu item |
| `packages/lib/src/types/sse.ts` | No change needed -- `DRIVE_FILE_CREATED` already exists |

---

## What About MOVE Across Mounts?

Cross-mount moves are not currently implemented and do not need to be addressed here.

If implemented in the future, a cross-mount move is semantically "copy + delete original". It should use the same
`copyDocument()` pipeline (copy to target mount with reference rewriting), then delete the source. This is identical
to the copy flow with an extra deletion step.

Within the same mount, moves are already reference-safe because `movePath()` only changes `parentId` -- the pathId
(and therefore all references) stays unchanged. No action needed.

---

## Garbage Collection for Orphaned Media

Orphaned media files (uploaded to `media/` but no longer referenced in the document content) are copied along with
everything else. This is correct -- the copy should be a faithful reproduction.

A separate cleanup mechanism could be built later:

1. Load the Yjs state and extract all referenced pathIds
2. List all files in `media/` and `chat/`
3. Delete files not found in the reference set

This should be:
- Manual or admin-triggered (not automatic)
- Never run while collaborators are connected
- A separate feature, not part of the copy pipeline

The copy algorithm should NOT try to skip orphaned files. Doing so requires parsing the Yjs state during the copy
tree walk, which is both slower and riskier than copying everything and rewriting afterward.

---

## Testing Strategy

### Unit Tests

**File: `apps/api/tests/copy-references.test.ts`**

1. **URL rewriting**: Given a URL with a known pathId and a mapping, assert the output URL has the new pathId. Assert
   external URLs are unchanged. Assert URLs with unknown pathIds are unchanged.

2. **Eigendoc Yjs rewriting**: Create a Y.Doc with the `'default'` XmlFragment containing `resizableImage` nodes
   with known `src` URLs and `comment` marks with known `chatId` values. Apply the rewriter with a mapping. Assert
   all `src` URLs have new pathIds. Assert all `chatId` values are remapped.

3. **Eigenslides Yjs rewriting**: Create a Y.Doc with `'objects'` and `'slides'` Maps containing image objects with
   `src` and `sourcePath`, and slides with `backgroundImage` and `backgroundImageSourcePath`. Apply the rewriter.
   Assert all fields are remapped.

4. **Eigenstickies Yjs rewriting**: Create a Y.Doc with `'tasks'` Map containing cards with `chatId`. Apply the
   rewriter. Assert `chatId` values are remapped.

5. **Chat SQLite rewriting**: Create an in-memory SQLite database with the chat schema, insert messages with
   `attachments` arrays. Apply the rewriter. Assert all attachment pathIds are remapped. Assert `read_state` is
   cleared.

### Integration Tests

**File: `apps/api/tests/drive-copy.test.ts`**

1. Create a document with media files and embedded chats. Copy it. Assert:
   - The copy exists with a new pathId
   - All media files exist in the copy's `media/` folder with new pathIds
   - Image URLs in the copy's Yjs state point to the copy's media files
   - Embedded chats in the copy have new pathIds
   - Chat attachments in the copy point to the copy's chat media files
   - Deleting the original does not break the copy's media

2. Copy a document with no media. Assert the copy is valid and has empty `media/` and `chat/` folders.

3. Copy a regular folder (non-document). Assert files are copied with new UUIDs.

4. Copy a document while it has an active collab session. Assert the copy contains at least the last snapshotted
   state (may miss in-flight updates -- this is acceptable).

### Manual Verification

- Duplicate an eigendoc with images. Open the copy. All images render.
- Delete the original. Open the copy. All images still render.
- Duplicate an eigendoc with comments. Open the copy. Click a comment highlight. It opens the copy's chat, not the
  original's.
- Duplicate slides with images and background images. All render correctly.
- Duplicate a stickies board. Open a card's chat. It is the copy's chat.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Yjs state corruption during rewriting | Low | High | Use standard Yjs APIs only. Never manipulate binary state. Write comprehensive unit tests |
| Comment mark rewriting breaks text formatting | Medium | Medium | Use delta export/reimport approach. Test with multi-format text (bold + italic + comment) |
| Copy is slow for large documents (100+ images) | Low | Low | Acceptable for Phase 1. Add async copy with progress reporting if needed |
| SQLite database locked during copy | Low | Medium | WAL mode guarantees reader isolation. Copy reads a consistent snapshot |
| Mapping incomplete (missed children) | Low | High | Use the same recursive tree walk pattern as `deletePath()`. Test with deeply nested structures |
| New reference types added later without updating rewriter | Medium | Medium | Document the rewriter contract. Add a checklist to the "add new extension" process |

---

## Phases

### Phase 1: Mount.copyPath() + Drive.copyDocument() for Eigendoc

**Scope**: Copy regular files/folders and eigendocs with image reference rewriting. No embedded chat rewriting yet.

**Files**:
- `apps/api/src/lib/mount/mount.ts` -- add `copyPath()`
- `apps/api/src/lib/drive/drive.ts` -- add `copyDocument()`
- `apps/api/src/lib/collab/copy-references.ts` -- eigendoc Yjs rewriter
- `apps/api/src/routes/drive.ts` -- add copy route
- `packages/lib/src/core/drive/hooks/use-drive.ts` -- add `useCopyPath()`
- `packages/ui/src/components/layout/drive/drive-table.tsx` -- add "Duplicate" menu item
- `apps/api/tests/copy-references.test.ts` -- unit tests

**Acceptance**: Duplicating an eigendoc produces an independent copy with working images.

### Phase 2: Eigenslides + Eigenstickies Rewriting

**Scope**: Add Yjs rewriters for slides (src, sourcePath, backgroundImage, backgroundImageSourcePath) and stickies
(chatId).

**Files**:
- `apps/api/src/lib/collab/copy-references.ts` -- add slides and stickies rewriters

**Acceptance**: Duplicating slides and stickies produces independent copies with working images and chat references.

### Phase 3: Chat Attachment Rewriting

**Scope**: Rewrite `attachments` arrays in copied `.eigenchat` databases. Clear `read_state`.

**Files**:
- `apps/api/src/lib/chat/copy-references.ts` -- chat SQLite rewriter
- Update `Drive.copyDocument()` to call chat rewriter for embedded chats

**Acceptance**: Duplicating a document with comment chats that have attachments produces fully independent copies.
Deleting original does not break copy's chat attachments.

### Phase 4: Cross-Owner Copy

**Scope**: When user B copies a document shared by user A, rewrite `ownerId` in all URLs in addition to pathIds.
Handle mounting the source document from user A's drive and creating the copy in user B's drive.

**Files**:
- `apps/api/src/lib/collab/copy-references.ts` -- extend URL rewriter to handle ownerId/mountId transformation
- `apps/api/src/routes/drive.ts` -- adjust copy route to accept cross-owner source

**Acceptance**: User B can duplicate a shared document into their own drive. All references point to user B's copy.

### Phase 5 (Optional): Document Templates

**Scope**: "Save as Template" and "Create from Template" using the copy pipeline. Templates are just documents
in a special folder that get copied (with empty content for the Yjs state but preserved structure).

This is a product feature that builds on the copy infrastructure, not a copy feature itself. Defer until templates
are a product priority.
