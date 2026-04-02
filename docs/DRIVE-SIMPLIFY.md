# Drive Class Simplification Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Simplify `drive.ts` (1037 lines) by extracting inline-editing logic, consolidating delete methods, and removing dead abstractions.

**Architecture:** Three independent refactors — each produces a working, testable commit. No new features; pure simplification.

---

## Current State

`apps/api/src/lib/drive/drive.ts` contains ~55 public methods. Export was already extracted to `apps/api/src/lib/export/export-document.ts` following a clean pattern: the route calls `drive.resolveFile()` to get `{mount, path}`, then calls the extracted function directly. No Drive dependency in the export module.

**Key files:**

| File | Lines | Role |
|------|-------|------|
| `apps/api/src/lib/drive/drive.ts` | 1037 | Core Drive class |
| `apps/api/src/lib/drive/sharedDrive.ts` | 414 | ACL-enforcing proxy |
| `apps/api/src/lib/drive/inline-edit.ts` | 14 | Frontmatter helpers (already extracted) |
| `apps/api/src/routes/drive.ts` | 402 | Drive API routes |
| `apps/api/src/routes/editor.ts` | 41 | Inline editing routes |
| `packages/lib/src/core/drive/hooks/use-drive.ts` | ~300 | Frontend hooks |
| `packages/ui/src/components/layout/drive/drive-layout.tsx` | 360 | Drive UI layout |
| `packages/ui/src/components/layout/drive/drive-delete-item.tsx` | ~50 | Delete dialog (used in FileMenu) |

---

## Task 1: Extract Inline Editing to Separate Module

**What:** Move `getEditableContent()` and `saveEditableContent()` out of `drive.ts` into `apps/api/src/lib/drive/inline-edit.ts` (which already has the pure helpers), following the export extraction pattern.

**Why:** These methods are self-contained content operations (read file, parse frontmatter, check conflicts, write back). They don't interact with collab, ACL propagation, or SSE beyond a simple file write.

**Current flow:**
```
route (editor.ts) → drive.getEditableContent() → mount.getActivePath() + mount.readFile()
route (editor.ts) → drive.saveEditableContent() → drive.writeFileContent() → mount.writeFile()
```

**New flow:**
```
route (editor.ts) → drive.resolveFile() → getEditableContent(mount, path)
route (editor.ts) → drive.resolveFile() → saveEditableContent(mount, path, ...) → mount.writeFile()
```

**Problem:** `saveEditableContent` currently calls `this.writeFileContent()` which does:
1. Permission check (`this.canWrite()`)
2. `mount.writeFile(pathId, data)`
3. SSE emit (`DRIVE_FILE_UPLOADED`)

The permission check is already handled by SharedDrive at the route level. The SSE emit is needed. Two clean options:

**Option A — Route handles SSE (matches export pattern exactly):**
- Extract pure functions that work with mount + path
- Route calls `drive.resolveFile()`, then the extracted function, then `drive.touchAndEmit(mountId, pathId)` for SSE
- Cleanest separation but adds a small Drive method for "write happened, emit event"

**Option B — Extracted module takes a write callback:**
- `saveEditableContent(mount, path, content, ..., writeFn)` where writeFn = `drive.writeFileContent`
- Keeps SSE emission inside Drive
- Slightly less clean

**Recommendation:** Option A. It matches the export pattern and keeps the extracted module dependency-free.

### Files to change

**Modify: `apps/api/src/lib/drive/inline-edit.ts`**

Add two exported functions alongside the existing helpers:

```typescript
// Existing helpers stay as-is
export const MAX_INLINE_EDIT_SIZE = 5 * 1024 * 1024;
export function extractFrontmatter(...) { ... }
export function reattachFrontmatter(...) { ... }

// New: extracted from Drive.getEditableContent (drive.ts:450-476)
export async function getEditableContent(mount: Mount, path: DrivePath) {
    if (path.type !== DRIVE_TYPE_FILE) throw new ApiError(404, 'File not found');
    const editMode = getTextPreviewMode(path.mimeType, path.name);
    if (!editMode) throw new ApiError(400, 'File type not supported for inline editing');
    if (path.size > MAX_INLINE_EDIT_SIZE) throw new ApiError(413, 'File too large for inline editing');

    const file = await mount.readFile(path.id);
    if (!file) throw new ApiError(404, 'File content not found');

    let content: string;
    try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
        throw new ApiError(400, 'File contains invalid UTF-8 encoding');
    }

    const { frontmatter, body } = editMode === 'markdown'
        ? extractFrontmatter(content)
        : { frontmatter: null, body: content };
    return { editMode, content: body, frontmatter, mimeType: path.mimeType, updatedAt: path.updatedAt };
}

// New: extracted from Drive.saveEditableContent (drive.ts:479-501)
// Returns the full content buffer to be written. Conflict detection only.
export function prepareSaveContent(
    path: DrivePath,
    content: string,
    frontmatter: string | null,
    expectedUpdatedAt: string,
    force: boolean,
): { conflict: true; currentUpdatedAt: string } | { conflict: false; data: Buffer } {
    if (path.type !== DRIVE_TYPE_FILE) throw new ApiError(404, 'File not found');
    const currentUpdatedAt = path.updatedAt instanceof Date ? path.updatedAt.toISOString() : String(path.updatedAt);
    if (expectedUpdatedAt !== currentUpdatedAt && !force) {
        return { conflict: true, currentUpdatedAt };
    }
    const fullContent = reattachFrontmatter(content, frontmatter);
    return { conflict: false, data: Buffer.from(fullContent, 'utf-8') };
}
```

**Modify: `apps/api/src/routes/editor.ts`**

```typescript
import { getEditableContent, prepareSaveContent } from '../lib/drive/inline-edit';

// GET: read-only, follows export pattern
.get('/editor/:ownerId/:mountId/:pathId/content', async ({ params, user }) => {
    const drive = await getSharedDrive(params.ownerId, user);
    const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
    return await getEditableContent(mount, path);
}, { auth: true })

// PUT: prepare content, then write through Drive for SSE
.put('/editor/:ownerId/:mountId/:pathId/content', async ({ params, body, user }) => {
    const drive = await getSharedDrive(params.ownerId, user);
    const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
    const result = prepareSaveContent(path, body.content, body.frontmatter ?? null, body.expectedUpdatedAt, body.force ?? false);
    if (result.conflict) return { conflict: true, currentUpdatedAt: result.currentUpdatedAt };
    const updated = await drive.writeFileContent(params.mountId, params.pathId, result.data);
    const updatedAt = updated.updatedAt instanceof Date ? updated.updatedAt.toISOString() : String(updated.updatedAt);
    return { conflict: false, updatedAt };
}, { ... })
```

**Modify: `apps/api/src/lib/drive/drive.ts`**

- Remove `getEditableContent()` method (lines 450-476)
- Remove `saveEditableContent()` method (lines 479-501)
- Remove unused import of `getTextPreviewMode` (if no other users)

**Modify: `apps/api/src/lib/drive/sharedDrive.ts`**

- Remove `getEditableContent()` wrapper (lines 116-117)
- Remove `saveEditableContent()` wrapper (lines 120-131)
- The route now calls `drive.resolveFile()` (which already checks read permission via SharedDrive) + `drive.writeFileContent()` (which checks write permission via SharedDrive)

**Net result:** ~55 lines removed from drive.ts, ~30 lines added to inline-edit.ts. Drive loses 2 public methods and their SharedDrive wrappers.

---

## Task 2: Consolidate Delete Routes and Methods

**What:** Replace `deleteFile()`/`deleteFolder()` with a single `deletePath()` method, unify the two DELETE routes into one, and simplify the frontend hooks.

**Why:** Both `deleteFile` and `deleteFolder` are one-line aliases to `trashPath()`. The split exists from before soft-delete when file and folder deletion had different implementations. Now they're identical. The split forces the frontend to branch on type for every delete call.

**Current state:**
```
Drive:       deleteFile() → trashPath()     deleteFolder() → trashPath()
SharedDrive: deleteFile() → withParent...   deleteFolder() → withParent...   trashPath() → withWrite...
Routes:      DELETE /file/:pathId           DELETE /folder/:pathId
Hooks:       useDeleteFile()                useDeleteFolder()                useDeletePaths() (branches on type)
UI:          drive-layout.tsx uses both     drive-delete-item.tsx uses both
```

**Also fixes:** SharedDrive permission inconsistency — `deleteFile`/`deleteFolder` use `withParentWritePermission` but `trashPath` uses `withWritePermission`. Since these are aliases, they should use the same check.

### Files to change

**Modify: `apps/api/src/lib/drive/drive.ts`**

```typescript
// Remove:
async deleteFolder(mountId: string, pathId: string): Promise<void> {
    return this.trashPath(mountId, pathId);
}
async deleteFile(mountId: string, pathId: string): Promise<void> {
    return this.trashPath(mountId, pathId);
}

// Rename trashPath → deletePath (public API name matches intent):
async deletePath(mountId: string, pathId: string): Promise<void> {
    // ... existing trashPath implementation unchanged ...
}
```

Note: keep `trashPath` as a deprecated alias if needed for the transition, but since chat.ts calls `deleteFile` internally (not through routes), it should switch to `deletePath`.

**Modify: `apps/api/src/lib/drive/sharedDrive.ts`**

```typescript
// Remove deleteFolder, deleteFile, trashPath. Replace with:
public async deletePath(mountId: string, pathId: string) {
    return this.withWritePermission(mountId, pathId, () => this.sharedDrive.deletePath(mountId, pathId));
}
```

**Modify: `apps/api/src/routes/drive.ts`**

```typescript
// Remove:
//   DELETE /drive/:ownerId/:mountId/folder/:pathId  (line 78-86)
//   DELETE /drive/:ownerId/:mountId/file/:pathId    (line 160-168)
// Add:
.delete('/drive/:ownerId/:mountId/path/:pathId', async ({ params, user }) => {
    const drive = await getSharedDrive(params.ownerId, user);
    await drive.deletePath(params.mountId, params.pathId);
    return { success: true };
}, { auth: true })
```

**Modify: `apps/api/src/lib/chat/chat.ts` (line 290)**

```typescript
// Change: await this.drive.deleteFile(this.path.mountId, attachmentId);
// To:     await this.drive.deletePath(this.path.mountId, attachmentId);
```

**Modify: `packages/lib/src/core/drive/hooks/use-drive.ts`**

```typescript
// Remove: useDeleteFile, useDeleteFolder
// Replace useDeletePaths with simplified version:
export function useDeletePaths(ownerId: string, mountId: string = DEFAULT_MOUNT_ID) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (paths: DrivePath[]) => {
            const results = await Promise.allSettled(
                paths.map(async (path) => {
                    const response = await driveApi({ ownerId })({ mountId }).path({ pathId: path.id }).delete();
                    if (response.error) throw new AppError(response);
                    return path;
                }),
            );
            const succeeded = results
                .filter((r): r is PromiseFulfilledResult<DrivePath> => r.status === 'fulfilled')
                .map((r) => r.value);
            for (const path of succeeded) {
                invalidateItemDeleted(queryClient, ownerId, mountId, path.id, path.parentId, path.mimeType);
            }
            const failedCount = results.filter((r) => r.status === 'rejected').length;
            if (failedCount > 0) throw new Error(`Failed to delete ${failedCount} of ${paths.length} items`);
            return succeeded;
        },
        onError: onMutationError,
    });
}
```

**Modify: `packages/ui/src/components/layout/drive/drive-layout.tsx`**

```typescript
// Remove: useDeleteFile, useDeleteFolder imports and instances
// Change handleDeletePaths to use useDeletePaths only:
const deletePathsMutation = useDeletePaths(ownerId, mountId);

const handleDeletePaths = (paths: DrivePath[]) => {
    if (!allowDelete || paths.length === 0) return;
    deletePathsMutation.mutate(paths, {
        onSuccess: () => {
            for (const path of paths) onAfterAction?.('delete', path);
        },
    });
};
```

**Modify: `packages/ui/src/components/layout/drive/drive-delete-item.tsx`**

Same simplification — use `useDeletePaths` instead of branching on type.

**Net result:** ~40 lines removed from hooks, ~15 lines removed from drive.ts, ~10 lines removed from sharedDrive.ts, simplified frontend logic. Fixes the SharedDrive permission inconsistency.

**Eden Treaty note:** Removing the old DELETE routes changes the API surface. Since this is a dev project (no backward compat needed per project conventions), this is fine. The old `/file/:pathId` DELETE and `/folder/:pathId` DELETE are removed; `/path/:pathId` DELETE replaces them.

---

## Task 3: Clean Up Dead Code

**What:** Remove the TODO doc and any leftover dead references from the consolidation.

### Specific items

1. **Remove `docs/TODO-SOFT-DELETE-CLEANUP.md`** — This documents exactly the consolidation done in Task 2. After Task 2, it's fully addressed.

2. **Remove `deleteFile`/`deleteFolder` exports from `drive/index.ts`** (if re-exported).

3. **Check `driveKeys` in use-drive.ts** — After removing `useDeleteFile`/`useDeleteFolder`, verify no query key references are orphaned.

---

## Execution Order

Tasks are independent and can be done in any order, but the recommended sequence:

1. **Task 2** (delete consolidation) — highest value, fixes a real inconsistency
2. **Task 1** (inline editing extraction) — clean structural improvement
3. **Task 3** (dead code) — quick cleanup after Task 2

Each task is a separate commit.

---

## What I Considered But Excluded

**Extracting ACL/sharing methods:** The `receiveACLChange` method (lines 816-873) and sharing registry methods are large but tightly coupled to Drive's `sharedDb` instance and SSE emission. Extracting them would require passing 3+ dependencies. Not worth it.

**Extracting collab methods:** `getCollabDocument`, `closeCollabDocument`, and the recursive helpers use `this.documents` map (Drive instance state). Extraction would mean splitting instance state across modules. Not clean.

**Batch emptyTrash:** Making `emptyTrash` a single mount-level operation instead of looping `permanentlyDelete` would improve performance but adds mount complexity. A separate optimization, not a simplification.

**Consolidating create methods:** `createDoc`/`createStickies`/`createSlides`/`createSheets` already delegate to `createCollabDoc`. The routes are separate because each has different body validation. No real win from consolidation.
