# Soft Delete / Recycle Bin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hard-delete with soft-delete (trash) so files/folders can be restored. Full-stack: schema, mount, drive, routes, frontend.

**Architecture:** Two new columns (`trashedAt`, `trashedFrom`) on the `paths` table. On trash, items are reparented to root with original parent stored in `trashedFrom`. Path-based (`local`) storage moves files to a `.trash/` directory. Key-based/S3 need no file movement. `getActivePath()` guard prevents access to trashed items. See `docs/SOFT-DELETE.md` for the complete spec.

**Tech Stack:** Bun, Elysia, Drizzle ORM (SQLite), React 19, TanStack Router/Query, Eden Treaty

**Spec:** `docs/SOFT-DELETE.md` — read this before starting any task.

---

### Task 1: Schema, types, and server settings

**Files:**
- Modify: `apps/api/src/lib/mount/schema.ts`
- Modify: `apps/api/src/lib/mount/db-config.ts`
- Modify: `packages/lib/src/types/drive.ts`
- Modify: `packages/lib/src/types/sse.ts`
- Modify: `packages/lib/src/types/settings.ts`
- Modify: `apps/api/src/lib/config/server-settings.ts`
- Modify: `apps/api/src/lib/mount/mount.ts` (toDrivePath)

- [ ] **Step 1: Add `trashedAt` and `trashedFrom` columns to the Drizzle schema**

In `apps/api/src/lib/mount/schema.ts`, add to the `paths` table:

```typescript
trashedAt: integer('trashedAt', { mode: 'timestamp' }),
trashedFrom: text('trashedFrom'),
```

- [ ] **Step 2: Add migration version 2 to db-config.ts**

In `apps/api/src/lib/mount/db-config.ts`, bump `currentVersion` to 2 and add a second migration entry:

```typescript
{
    version: 2,
    up: (db) =>
        db.exec(`
            ALTER TABLE paths ADD COLUMN trashedAt INTEGER;
            ALTER TABLE paths ADD COLUMN trashedFrom TEXT;

            CREATE INDEX IF NOT EXISTS idx_paths_trashed_from
                ON paths(trashedFrom, trashedAt) WHERE trashedFrom IS NOT NULL;

            DROP INDEX IF EXISTS idx_paths_parentId;
            CREATE INDEX IF NOT EXISTS idx_paths_parent_trash
                ON paths(parentId, trashedAt);
        `),
},
```

- [ ] **Step 3: Add `trashedAt` to the `DrivePath` type**

In `packages/lib/src/types/drive.ts`, add to the `DrivePath` type:

```typescript
trashedAt: Date | null;
```

- [ ] **Step 4: Add SSE event type constants**

In `packages/lib/src/types/sse.ts`, add to `SSEventType`:

```typescript
DRIVE_PATH_TRASHED: 'drive:path-trashed',
DRIVE_PATH_RESTORED: 'drive:path-restored',
```

- [ ] **Step 5: Add `trashRetentionDays` to ServerSettings**

In `packages/lib/src/types/settings.ts`, add to the `ServerSettings.quotas` type:

```typescript
trashRetentionDays: number;
```

In `apps/api/src/lib/config/server-settings.ts`, add to the `settingsStore` defaults under `quotas`:

```typescript
trashRetentionDays: 30,
```

- [ ] **Step 6: Update `toDrivePath` in mount.ts to include `trashedAt`**

In `apps/api/src/lib/mount/mount.ts`, update the `toDrivePath` method to map the new column:

```typescript
trashedAt: row.trashedAt ?? null,
```

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (or only pre-existing errors unrelated to this change)

- [ ] **Step 8: Commit**

Commit message: `feat(drive): add trashedAt/trashedFrom schema columns and trash types`

---

### Task 2: Mount query filters, getActivePath, listFolderAll

**Files:**
- Modify: `apps/api/src/lib/mount/mount.ts`
- Test: `apps/api/src/test/mount.test.ts`

**Context:** Read `docs/SOFT-DELETE.md` sections "Query Changes", "Internal helpers", and "Access guards".

- [ ] **Step 1: Write failing tests for query filtering**

Add a new `describe('Trash query filtering')` block in `apps/api/src/test/mount.test.ts`. Test against both `local-key` and `local` mount types. Create a file, trash it (direct DB update setting `trashedAt` + `trashedFrom` + reparent to root), then verify:

- `listFolder(rootId)` does NOT include the trashed item
- `getChildByName(originalParent, name)` returns null
- `getPath(pathId)` still returns the trashed item
- `getTotalSize()` still counts the trashed item's size
- `getActivePath(pathId)` throws for trashed items
- `getActivePath(pathId)` works for active items

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/api/src/test/mount.test.ts`
Expected: New tests FAIL (methods don't exist yet / no filtering)

- [ ] **Step 3: Add `trashedAt IS NULL` filter to listing queries**

In `apps/api/src/lib/mount/mount.ts`, modify these methods to add `isNull(paths.trashedAt)`:

- `listFolder`: `and(eq(paths.parentId, parentId), isNull(paths.trashedAt))`
- `getChildByName`: add `isNull(paths.trashedAt)` to the existing `and()` clause
- `assertUniqueName`: add `isNull(paths.trashedAt)` to the existing `and()` clause
- `getPathsWithACL`: add `and(existingCondition, isNull(paths.trashedAt))`
- `getPathsByMimeType`: add `isNull(paths.trashedAt)` to the outer conditions array AND add `AND ${paths.trashedAt} IS NULL` inside the CTE seed query (`WHERE ${paths.type} IN (...)`)

Import `isNull` from `drizzle-orm` if not already imported.

- [ ] **Step 4: Add `listFolderAll()` private method**

```typescript
async listFolderAll(parentId: string): Promise<DrivePath[]> {
    const results = await this.db.select().from(paths).where(eq(paths.parentId, parentId)).all();
    return results.map((r) => this.toDrivePath(r));
}
```

This is the same as the original `listFolder` without the trash filter. Used by internal recursive helpers.

- [ ] **Step 5: Add `getActivePath()` method**

```typescript
async getActivePath(pathId: string): Promise<DrivePath> {
    const path = await this.getPath(pathId);
    if (!path) throw new ApiError(404, 'Path not found');
    if (path.trashedAt) throw new ApiError(404, 'File is in trash');
    return path;
}
```

- [ ] **Step 6: Add root guard to `deletePath()`**

At the top of `deletePath()`, after `if (!pathEntry) return;`, add:

```typescript
if (pathEntry.parentId === null) throw new ApiError(400, 'Cannot delete root folder');
```

- [ ] **Step 7: Run tests**

Run: `bun test apps/api/src/test/mount.test.ts`
Expected: All new tests PASS

- [ ] **Step 8: Commit**

Commit message: `feat(mount): add trash query filters, getActivePath, listFolderAll`

---

### Task 3: Mount trashPath and restorePath

**Files:**
- Modify: `apps/api/src/lib/mount/mount.ts`
- Test: `apps/api/src/test/mount.test.ts`

**Context:** Read `docs/SOFT-DELETE.md` sections "Trash Semantics", "Restore", "Path-Based Storage", and "Direct DB update". Key insight: the entire trash/restore DB update must use direct `db.update(paths).set(...)`, NOT `updatePath()`, because `updatePath()` triggers `assertUniqueName` and path-based storage rename.

- [ ] **Step 1: Create `.trash/` directory in `init()` for path-based storage**

In `mount.init()`, after the existing directory creation block for `previewsDir`, add:

```typescript
if (this.isPathBased) {
    const trashDir = path.join(this.dataDir, '.trash');
    if (!fs.existsSync(trashDir)) {
        fs.mkdirSync(trashDir, { recursive: true });
    }
}
```

- [ ] **Step 2: Write failing tests for trashPath**

Add `describe('Trash operations')` in mount.test.ts. Test with both `local-key` and `local` storage:

- Trash a file: verify `trashedAt` set, `trashedFrom` = original parent, `parentId` = root
- Trash a file: verify `acl` column preserved
- Trash a folder: folder + all descendants get `trashedAt`
- Trash a folder: descendants get `trashedFrom = null`
- Trash a folder: already-trashed descendants skipped
- Trash root folder: throws
- Trash non-existent path: throws
- `listTrash()` returns only `trashedFrom IS NOT NULL` items, ordered desc

For `local` storage:
- Trash file: moves to `data/.trash/{pathId}.ext` on disk
- Trash file: `file` column updated
- Trash folder: moves to `data/.trash/{pathId}/` on disk
- After trash, create new file with same name: no collision

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test apps/api/src/test/mount.test.ts`

- [ ] **Step 4: Implement `trashPath()`**

Key implementation:
- Get path, verify exists and not root
- Get root folder ID
- Wrap in `withPathLock(pathId)`
- For path-based: compute old storage key via `resolveStoragePath`, compute trash key as `.trash/${buildStorageKey(pathId, name)}`, call `storage.rename(oldKey, trashKey)` FIRST
- Direct DB update: `db.update(paths).set({ trashedAt: now, trashedFrom: item.parentId, parentId: rootId, file: trashKey (if path-based), updatedAt: now }).where(eq(paths.id, pathId))`
- For containers: recursive UPDATE on descendants `WHERE trashedAt IS NULL AND id IN (recursive CTE from parentId)`
- Return updated path

Note: Drizzle `mode: 'timestamp'` stores dates as unix epoch integers. The raw SQL for the recursive descendant update should use integer timestamps consistently.

- [ ] **Step 5: Implement `listTrash()`**

```typescript
async listTrash(): Promise<DrivePath[]> {
    const results = await this.db
        .select()
        .from(paths)
        .where(sql`${paths.trashedFrom} IS NOT NULL`)
        .orderBy(sql`${paths.trashedAt} DESC`)
        .all();
    return results.map((r) => this.toDrivePath(r));
}
```

- [ ] **Step 6: Run trash tests**

Run: `bun test apps/api/src/test/mount.test.ts`

- [ ] **Step 7: Write failing tests for restorePath**

- Restore file: clears `trashedAt`, `trashedFrom`, restores `parentId`
- Restore folder: clears on folder + non-independently-trashed descendants
- Restore folder: descendants with `trashedFrom IS NOT NULL` stay trashed
- Restore when parent deleted: restores to root
- Restore when parent trashed: restores to root
- Restore with name conflict: auto-renames
- Restore non-trashed item: throws
- For `local` storage: moves back, `file` = `name`

- [ ] **Step 8: Implement `restorePath()`**

Key implementation:
- Verify `trashedFrom IS NOT NULL`
- Determine target parent: check if `trashedFrom` parent exists and is not trashed, else root
- Check name conflict at target with `assertUniqueName`, use `getUniqueFileName` if needed
- Wrap in `withPathLock(pathId)`
- For path-based: compute target path from parent + `name`, rename from `.trash/` back
- Direct DB update: set `parentId`, clear `trashedAt`/`trashedFrom`, set `file = name` (path-based)
- Recursive clear `trashedAt` on descendants, skip `trashedFrom IS NOT NULL`
- Return updated path

- [ ] **Step 9: Run all mount tests**

Run: `bun test apps/api/src/test/mount.test.ts`
Expected: All PASS

- [ ] **Step 10: Commit**

Commit message: `feat(mount): implement trashPath and restorePath with path-based storage support`

---

### Task 4: Mount permanentlyDeleteFromTrash and purgeTrash

**Files:**
- Modify: `apps/api/src/lib/mount/mount.ts`
- Test: `apps/api/src/test/mount.test.ts`

**Context:** Read `docs/SOFT-DELETE.md` sections "Permanent delete" and "Auto-Purge".

- [ ] **Step 1: Write failing tests**

- Permanently delete file from trash: removes DB row + storage + thumbnail
- Permanently delete folder from trash: removes folder + descendants
- Permanently delete folder: finds independently-trashed children (reparented to root, `trashedFrom IN (...)`)
- `purgeTrash()` no args: deletes all
- `purgeTrash(30)`: only expired items
- `purgeTrash()` on empty trash: no-op

- [ ] **Step 2: Implement `permanentlyDeleteFromTrash()`**

For folders: collect all descendant IDs (using existing recursive walk by parentId). Then query for any items whose `trashedFrom` is in that set. Delete those orphans first. Then call `deletePath(pathId)`.

Add helper `collectDescendantIds(parentId)` similar to existing `collectDescendantFileIds`.

- [ ] **Step 3: Implement `purgeTrash(maxAgeDays?)`**

If `maxAgeDays` is provided, query items where `trashedFrom IS NOT NULL AND trashedAt < cutoff`. Otherwise list all trash. Call `permanentlyDeleteFromTrash` for each.

- [ ] **Step 4: Add auto-purge in `init()`**

At end of `init()`, fire-and-forget purge of expired items using `getServerSettings().quotas.trashRetentionDays`. Use `.catch()` to log errors.

- [ ] **Step 5: Run tests**

Run: `bun test apps/api/src/test/mount.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

Commit message: `feat(mount): implement permanentlyDeleteFromTrash, purgeTrash, and auto-purge`

---

### Task 5: Drive trash/restore/management and access guards

**Files:**
- Modify: `apps/api/src/lib/drive/drive.ts`
- Modify: `apps/api/src/lib/drive/sharedDrive.ts`
- Test: `apps/api/src/test/drive.test.ts`

**Context:** Read `docs/SOFT-DELETE.md` sections "Drive-Level Changes", "Access guards", "ACL preservation".

- [ ] **Step 1: Switch Drive methods from `getPath` to `getActivePath`**

In `drive.ts`, update all methods in the spec's "Methods that switch to getActivePath()" list. Change `mount.getPath(pathId)` calls to `mount.getActivePath(pathId)`. Include `resolveFile()`.

- [ ] **Step 2: Change `deleteFile`/`deleteFolder` to delegate to `trashPath`**

Replace existing delete logic with calls to a new `trashPath()`. Move collab-close and ACL-propagation logic from `deleteFolder` into `trashPath`.

- [ ] **Step 3: Implement Drive.trashPath()**

ACL revocation, collab document close, then `mount.trashPath()`, then SSE emit with `oldParentId`.

Update `closeCollabDocumentsRecursively` and `propagateACLRemovalRecursively` to use `mount.listFolderAll()` instead of `mount.listFolder()` (make `listFolderAll` public on Mount).

- [ ] **Step 4: Implement Drive.restorePath()**

Call `mount.restorePath()`, then re-propagate ACL via `propagateACLChange(path, null, path.acl)` for the item and descendants with ACL. Emit `DRIVE_PATH_RESTORED`.

- [ ] **Step 5: Implement Drive.listTrash(), permanentlyDelete(), emptyTrash()**

Straightforward delegations to mount methods with permission checks and SSE events.

- [ ] **Step 6: Add SharedDrive wrappers**

Wrap all new Drive methods with permission checks using `withWritePermission` (or `withReadPermission` for listTrash).

- [ ] **Step 7: Write integration tests**

Add `describe('Trash')` block in `drive.test.ts`:
- DELETE file/folder returns 200, items trashed
- GET trash listing works
- POST restore works
- DELETE from trash permanently deletes
- DELETE all trash empties
- Access trashed file via download returns 404
- Restore with name conflict auto-renames

- [ ] **Step 8: Run all tests**

Run: `bun run test`
Expected: All PASS

- [ ] **Step 9: Commit**

Commit message: `feat(drive): implement trash/restore/permanent-delete with ACL propagation and access guards`

---

### Task 6: API routes

**Files:**
- Modify: `apps/api/src/routes/drive.ts`

- [ ] **Step 1: Verify existing DELETE endpoints**

Existing DELETE handlers call `drive.deleteFile()`/`drive.deleteFolder()` which now delegate to `trashPath()`. No route changes needed for soft-delete behavior.

- [ ] **Step 2: Add trash management routes**

Add routes for: GET trash listing, POST restore, DELETE permanent single, DELETE empty all. Follow existing route patterns (auth, params, response shape).

- [ ] **Step 3: Run tests**

Run: `bun run test`
Expected: All PASS

- [ ] **Step 4: Commit**

Commit message: `feat(routes): add trash management endpoints`

---

### Task 7: Frontend hooks, query keys, and SSE handlers

**Files:**
- Modify: `packages/lib/src/core/drive/hooks/use-drive.ts`
- Modify: `packages/lib/src/core/drive/sse-handlers.ts`

**Context:** Follow existing patterns in `use-drive.ts` exactly. Use `onMutationError` for error handling.

- [ ] **Step 1: Add trash query keys to `driveKeys`**

- [ ] **Step 2: Add `useListTrash` query hook**

- [ ] **Step 3: Add `useRestorePath`, `usePermanentlyDelete`, `useEmptyTrash` mutation hooks**

- [ ] **Step 4: Add `invalidateTrash` helper and SSE handlers**

Handle `DRIVE_PATH_TRASHED` (invalidate old parent folder + trash) and `DRIVE_PATH_RESTORED` (invalidate target folder + trash).

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`

- [ ] **Step 6: Commit**

Commit message: `feat(drive-hooks): add trash query/mutation hooks and SSE handlers`

---

### Task 8: Frontend trash view and UI changes

**Files:**
- Modify: Drive app sidebar navigation
- Create: Trash view route/component in `apps/drive/`
- Modify: `packages/ui/src/components/layout/drive/drive-delete-item.tsx`

**Context:** Explore `apps/drive/src/routes/` and `packages/ui/src/components/layout/drive/` for patterns.

- [ ] **Step 1: Explore existing frontend structure**

Read sidebar nav, route patterns, and the delete dialog before writing code.

- [ ] **Step 2: Add "Trash" to drive sidebar**

Use `Trash2` icon from lucide-react. Badge with item count from `useListTrash` data length.

- [ ] **Step 3: Create trash route and view**

Route showing trashed items list with name, type, trashed date. Actions: Restore, Delete permanently. "Empty trash" button with confirmation.

- [ ] **Step 4: Update delete confirmation dialog**

Change title to "Move to trash", description to mention restore, button text to "Move to trash".

- [ ] **Step 5: Manual verification**

Run `bun run serve`, test the full flow: delete -> trash view -> restore -> permanent delete -> empty trash.

- [ ] **Step 6: Run checks**

Run: `bun run check`

- [ ] **Step 7: Commit**

Commit message: `feat(drive-ui): add trash view, sidebar item, and soft-delete confirmation`

---

### Task 9: Final integration and docs

**Files:**
- Modify: `docs/SOFT-DELETE.md`, `docs/STORAGE.md`, `AGENTS.md`

- [ ] **Step 1: Run full check**

Run: `bun run check`
Expected: All PASS

- [ ] **Step 2: Update docs**

- `AGENTS.md`: add `.trash/` to data layout, mention soft-delete in common pitfalls
- `docs/STORAGE.md`: add brief trash section
- `docs/SOFT-DELETE.md`: mark as implemented

- [ ] **Step 3: Commit**

Commit message: `docs: update documentation with trash/soft-delete details`
