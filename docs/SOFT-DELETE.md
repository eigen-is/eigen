# Soft Delete / Recycle Bin

> **TLDR**: Delete becomes "move to trash". Two new columns on `paths` (`trashedAt`, `trashRoot`). Storage
> files stay in place for key-based/S3 backends; path-based (`local`) backend moves files to a `.trash/`
> directory within the mount's data dir. Trash counts toward quota. Auto-purge after configurable retention
> (default 30 days). Full-stack: backend + API + frontend trash view.

## Schema Changes

Add to the `paths` table in `apps/api/src/lib/mount/schema.ts`:

| Column      | Type                  | Default | Purpose                                                  |
|-------------|-----------------------|---------|----------------------------------------------------------|
| `trashedAt` | INTEGER (timestamp)   | NULL    | When the item was trashed. NULL = not trashed            |
| `trashRoot` | INTEGER (0/1)         | NULL    | 1 = directly trashed by user (shown in trash view). NULL = descendant of a trashed folder |

Bump schema version in `apps/api/src/lib/mount/db-config.ts`.

### Indexes

| Index                    | Definition                                                        | Purpose                          |
|--------------------------|-------------------------------------------------------------------|----------------------------------|
| `idx_paths_trashed`      | `trashedAt WHERE trashedAt IS NOT NULL`                           | Trash listing and expired purge  |
| `idx_paths_trash_root`   | `(trashRoot, trashedAt) WHERE trashRoot = 1`                     | Trash view (top-level items)     |
| `idx_paths_parent_trash` | `(parentId, trashedAt)`                                           | Folder listings with trash filter|

The existing `parentId` index is replaced by the compound `idx_paths_parent_trash` to cover the common
`WHERE parentId = ? AND trashedAt IS NULL` query pattern.

## Trash Semantics

### Trashing a file

1. Set `trashedAt` = now, `trashRoot` = 1
2. Handle path-based storage rename (see [Path-Based Storage](#path-based-local-storage))
3. Propagate ACL removal (revoke shared access, same as current delete)
4. Emit `DRIVE_PATH_TRASHED` SSE event

### Trashing a folder

1. Close collab documents recursively (same as current delete)
2. Set `trashedAt` = now, `trashRoot` = 1 on the folder
3. Recursively set `trashedAt` = now on all descendants `WHERE trashedAt IS NULL` (skip already-trashed items).
   Descendants get `trashRoot` = NULL — they are not independently trashed
4. Handle path-based storage rename on the top-level folder only (descendants move with it)
5. Propagate ACL removal recursively
6. Emit `DRIVE_PATH_TRASHED` SSE event

### Permanent delete

Uses existing `mount.deletePath()` logic unchanged. Called from trash management endpoints only.

### `parentId` does not change on trash

The item stays in its position in the folder tree. It is hidden from normal listings by the
`WHERE trashedAt IS NULL` filter. This is critical for path-based storage (see below) and simplifies
restore.

## Restore

### Restoring a file

1. Verify the original parent still exists (`parentId` is unchanged, check it's not trashed/deleted)
   - If parent is gone or trashed: restore to mount root instead
2. Check for name conflicts in the target folder (using existing `assertUniqueName` with trash filter)
   - On conflict: generate unique name via `getUniqueFileName()`
3. Handle path-based storage rename-back (see [Restore on Path-Based Storage](#restore-on-path-based-storage))
4. Clear `trashedAt` and `trashRoot`
5. Re-propagate ACL (re-share with collaborators)
6. Emit `DRIVE_PATH_RESTORED` SSE event

### Restoring a folder

1. Same parent-existence check as files. Restore to mount root if parent is gone
2. Same name-conflict handling
3. Handle path-based storage rename-back on the top-level folder only
4. Clear `trashedAt` and `trashRoot` on the folder
5. Recursively clear `trashedAt` on descendants, **skipping** any with `trashRoot = 1`
   (these were independently trashed before the folder and should stay in trash)
6. Re-propagate ACL for the folder and restored descendants
7. Emit `DRIVE_PATH_RESTORED` SSE event

### Edge cases

| Scenario | Behavior |
|----------|----------|
| Parent was permanently deleted while item was in trash | Restore to mount root |
| Parent is itself trashed | Restore to mount root (don't silently restore into trash) |
| Name conflict at restore target | Auto-rename via `getUniqueFileName()` |
| File trashed, then parent folder trashed | Both appear in trash view (`trashRoot = 1`). Restoring folder skips the independently-trashed file |
| Permanently delete a folder from trash | All descendants are permanently deleted, including independently-trashed children |

## Path-Based (`local`) Storage

This is the only storage type that requires file-system operations on trash/restore. `local-key` and `s3`
backends address files by UUID-based keys, so no renaming is needed — the DB flag is sufficient.

### Problem

`local` storage uses hierarchical paths: `data/projects/report.pdf`. If a file is trashed and a new file
with the same name is created in the same folder, both would resolve to the same on-disk path.

### Solution: `.trash/` directory

Each mount with `local` storage gets a `.trash/` directory inside its `data/` dir (created during
`mount.init()`). When trashing:

**Trashing a file:**
1. Current on-disk path: `data/projects/report.pdf`
2. Move to: `data/.trash/{pathId}.{ext}` (flat namespace, no collisions)
3. Update `file` column to `.trash/{pathId}.{ext}`
4. Store original `file` value in `details.trashedFile`

**Trashing a folder:**
1. Current on-disk path: `data/projects/my-folder/`
2. Move to: `data/.trash/{pathId}/`
3. Update the folder's `file` column to `.trash/{pathId}`
4. Store original `file` value in `details.trashedFile`
5. **Descendants need no file column changes** — `resolveStoragePath()` walks the `parentId` chain and
   concatenates `file` values, so children automatically resolve through the moved parent
   (e.g., child resolves to `.trash/{folderId}/child-name`)

### Restore on path-based storage

1. Compute target path from the parent chain using the original `file` value from `details.trashedFile`
2. Move from `.trash/{pathId}` back to the target location via `storage.rename()`
3. Restore the `file` column from `details.trashedFile`
4. Clear `details.trashedFile`

### Key-based and S3 storage

No file movement needed. Files are addressed by UUID keys (`{pathId}.{ext}`) that don't change.
Only the DB columns are updated on trash/restore.

## Query Changes

Existing mount queries that must add `AND trashedAt IS NULL`:

| Method             | Reason                                              |
|--------------------|-----------------------------------------------------|
| `listFolder`       | Don't show trashed items in folder listings          |
| `getChildByName`   | Trashed items shouldn't block name lookups           |
| `assertUniqueName` | Allow creating files with same name as trashed items |
| `getPathsByMimeType`| Exclude trashed items from type-filtered views      |
| `getPathsWithACL`  | Trashed items shouldn't appear in shared views       |

Queries that must **not** filter trashed items:

| Method           | Reason                                                |
|------------------|-------------------------------------------------------|
| `getPath`        | Needed for restore, breadcrumbs, permanent delete     |
| `getTotalSize`   | Trash counts toward quota                             |
| `getFileCount`   | Trash counts toward total                             |
| `getBreadcrumb`  | Needed for restore context                            |

## New Mount Methods

```
trashPath(pathId)              — flag item + descendants as trashed, handle storage rename
restorePath(pathId)            — clear trash flags, handle storage rename-back
listTrash()                    — SELECT ... WHERE trashRoot = 1 ORDER BY trashedAt DESC
emptyTrash()                   — permanently delete all trashed items
purgeExpiredTrash(maxAgeDays)  — permanently delete items where trashedAt + maxAgeDays < now
getTrashSize()                 — total size of trashed items (for UI badge / info)
```

## Drive-Level Changes

`Drive` methods that wrap mount operations with ACL propagation, collab cleanup, and SSE emission:

```
trashPath(mountId, pathId)             — soft-delete + ACL revocation + SSE
restorePath(mountId, pathId)           — restore + ACL re-propagation + SSE
listTrash(mountId)                     — list top-level trashed items
permanentlyDelete(mountId, pathId)     — hard-delete from trash (existing deletePath)
emptyTrash(mountId)                    — permanently delete all trash
```

`SharedDrive` wraps all new methods with permission checks (write permission required for all operations).

## API Routes

| Endpoint | Method | Action |
|----------|--------|--------|
| `/drive/:ownerId/:mountId/file/:pathId` | DELETE | **Becomes soft-delete** (trash) |
| `/drive/:ownerId/:mountId/folder/:pathId` | DELETE | **Becomes soft-delete** (trash) |
| `/drive/:ownerId/:mountId/trash` | GET | List trash contents |
| `/drive/:ownerId/:mountId/trash/:pathId/restore` | POST | Restore from trash |
| `/drive/:ownerId/:mountId/trash/:pathId` | DELETE | Permanent delete single item |
| `/drive/:ownerId/:mountId/trash` | DELETE | Empty entire trash |

Existing DELETE endpoints change from hard-delete to soft-delete. Frontend mutations keep working
with safer semantics.

## SSE Events

| Event | Trigger | Frontend action |
|-------|---------|-----------------|
| `DRIVE_PATH_TRASHED` | Item moved to trash | Remove from folder cache, update trash badge |
| `DRIVE_PATH_RESTORED` | Item restored from trash | Add to folder cache, update trash badge |
| `DRIVE_FILE_DELETED` | Permanent delete (unchanged) | Remove from trash cache |
| `DRIVE_FOLDER_DELETED` | Permanent delete (unchanged) | Remove from trash cache |

## Auto-Purge

New server setting in `ServerSettings`:

```
trashRetentionDays: number  // default: 30
```

Purge runs at two points:
1. **`mount.init()`** — clean expired items when a Home initializes (catches active users)
2. **`listTrash()`** — lazy purge before returning results (ensures fresh data)

Purge logic: permanently delete all items where `trashedAt + retentionDays < now`, processing
`trashRoot = 1` items first (so folder permanent-delete cascades to descendants).

## Frontend Changes

### Drive sidebar
- "Trash" navigation item with badge showing trashed item count

### Trash view
- List of top-level trashed items (`trashRoot = 1`)
- Columns: name, type, original location, trashed date
- Sort by trashed date (newest first)
- Actions per item: Restore, Delete permanently
- "Empty trash" button with confirmation dialog

### Delete confirmation
- Change text from "Delete permanently?" to "Move to trash"
- Remove warning tone — trashing is safe and reversible

### New hooks (`packages/lib/src/core/drive/hooks/`)
```
useListTrash(ownerId, mountId)
useRestorePath(ownerId, mountId)
usePermanentlyDelete(ownerId, mountId)
useEmptyTrash(ownerId, mountId)
useTrashCount(ownerId, mountId)          — for sidebar badge
```

### New SSE handlers
- `DRIVE_PATH_TRASHED` → invalidate parent folder + increment trash count
- `DRIVE_PATH_RESTORED` → invalidate target folder + decrement trash count

### Query keys
```typescript
export const driveKeys = {
    // ... existing keys ...
    trash: () => [...driveKeys.all, 'trash'] as const,
    trashList: (mountId: string) => [...driveKeys.trash(), mountId] as const,
    trashCount: (mountId: string) => [...driveKeys.trash(), 'count', mountId] as const,
};
```
