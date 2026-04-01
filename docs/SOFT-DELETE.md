# Soft Delete / Recycle Bin

> **TLDR**: Delete becomes "move to trash". Three new columns on `paths` (`trashedAt`, `trashRoot`,
> `trashedFrom`). On trash, `parentId` is changed to root and original parent is stored in `trashedFrom`.
> Path-based (`local`) storage moves files to a `.trash/` directory; key-based/S3 storage needs no file
> movement. Trash counts toward quota. Auto-purge after configurable retention (default 30 days).
> Full-stack: backend + API + frontend trash view.

## Schema Changes

Add to the `paths` table in `apps/api/src/lib/mount/schema.ts`:

| Column        | Type                | Default | Purpose                                                               |
|---------------|---------------------|---------|-----------------------------------------------------------------------|
| `trashedAt`   | INTEGER (timestamp) | NULL    | When the item was trashed. NULL = not trashed                         |
| `trashRoot`   | INTEGER (0/1)       | NULL    | 1 = directly trashed by user (shown in trash view). NULL = descendant |
| `trashedFrom` | TEXT                | NULL    | Original `parentId` before trashing (for restore). Only set on items with `trashRoot = 1` |

Bump schema version in `apps/api/src/lib/mount/db-config.ts`.

### Indexes

| Index                    | Definition                                     | Purpose                              |
|--------------------------|------------------------------------------------|--------------------------------------|
| `idx_paths_trash_root`   | `(trashRoot, trashedAt) WHERE trashRoot = 1`   | Trash view listing + expired purge   |
| `idx_paths_parent_trash` | `(parentId, trashedAt)`                        | Folder listings with trash filter    |

The existing `parentId` index is replaced by the compound `idx_paths_parent_trash` to cover the common
`WHERE parentId = ? AND trashedAt IS NULL` query pattern. The `idx_paths_trash_root` partial index serves
both the trash listing (`WHERE trashRoot = 1 ORDER BY trashedAt DESC`) and purge queries
(`WHERE trashRoot = 1 AND trashedAt < ?`).

## Trash Semantics

### Core principle: `parentId` changes on trash

On trash, the item's `parentId` is changed to the **mount root folder**. The original `parentId` is stored
in `trashedFrom` for restore. This is essential for path-based storage (see below) — it ensures
`resolveStoragePath()` produces the correct `.trash/...` path by walking through root rather than the
original parent chain.

For consistency, all storage types follow this same pattern.

### Trashing a file

1. Store original `parentId` in `trashedFrom`
2. Set `trashedAt` = now, `trashRoot` = 1, `parentId` = root folder ID
3. Handle path-based storage move (see [Path-Based Storage](#path-based-local-storage))
4. Close collab document if applicable
5. Propagate ACL removal: call `propagateACLChange(path, path.acl, null)` — revokes shared access
6. Emit `DRIVE_PATH_TRASHED` SSE event

### Trashing a folder

**Important ordering**: close collab docs and propagate ACL **before** setting `trashedAt` on descendants,
because `listFolder()` (used by the recursive helpers) filters out trashed items.

1. Close collab documents recursively (uses `listFolder` which still sees all children)
2. Propagate ACL removal recursively (uses `listFolder` which still sees all children)
3. Handle path-based storage move on the top-level folder only (descendants move with it)
4. Store original `parentId` in `trashedFrom` on the folder
5. Set `trashedAt` = now, `trashRoot` = 1, `parentId` = root folder ID on the folder
6. Recursively set `trashedAt` = now on all descendants `WHERE trashedAt IS NULL` (skip already-trashed
   items). Descendants get `trashRoot` = NULL and their `parentId` is unchanged (they stay inside the
   moved folder)
7. Emit `DRIVE_PATH_TRASHED` SSE event

### Permanent delete

Uses existing `mount.deletePath()` logic unchanged. Called from trash management endpoints only.
ACL was already revoked during the trash operation, so permanent delete skips ACL propagation
(the `sharedPaths` entries were already removed on trash).

## Restore

### Restoring a file

1. Verify original parent from `trashedFrom`:
   - If parent exists and is not trashed: restore there
   - If parent is gone or trashed: restore to mount root instead
2. Check for name conflicts in the target folder (using `assertUniqueName` which excludes trashed items)
   - On conflict: generate unique name via `getUniqueFileName()`
3. Handle path-based storage move-back (see [Restore on Path-Based Storage](#restore-on-path-based-storage))
4. Set `parentId` to the target folder (from `trashedFrom` or root)
5. Clear `trashedAt`, `trashRoot`, `trashedFrom`
6. Re-propagate ACL: call `propagateACLChange(path, null, path.acl)` — `oldACL=null` because sharing was
   revoked on trash, `newACL=path.acl` re-shares with collaborators
7. Emit `DRIVE_PATH_RESTORED` SSE event

### Restoring a folder

1. Same parent-existence check. Restore to mount root if original parent is gone/trashed
2. Same name-conflict handling
3. Handle path-based storage move-back on the top-level folder only
4. Set `parentId` to target, clear `trashedAt`, `trashRoot`, `trashedFrom` on the folder
5. Recursively clear `trashedAt` on descendants, **skipping** any with `trashRoot = 1`
   (these were independently trashed before the folder and should stay in trash)
6. Re-propagate ACL for the folder and all restored descendants that have ACL set:
   call `propagateACLChange(item, null, item.acl)` for each
7. Emit `DRIVE_PATH_RESTORED` SSE event

### Edge cases

| Scenario | Behavior |
|----------|----------|
| Parent was permanently deleted while item was in trash | Restore to mount root |
| Parent is itself trashed | Restore to mount root (don't silently restore into trash) |
| Name conflict at restore target | Auto-rename via `getUniqueFileName()` |
| File trashed, then parent folder trashed | Both appear in trash view (`trashRoot = 1`). Restoring folder skips the independently-trashed file |
| Permanently delete a folder from trash | All descendants are permanently deleted, including independently-trashed children |
| Collab document in trash accessed via WebSocket | Guard in `getCollabDocument()`: if `path.trashedAt != null`, throw `ApiError(404)` |

## Path-Based (`local`) Storage

This is the only storage type that requires file-system operations on trash/restore. `local-key` and `s3`
backends address files by UUID-based keys that never collide, so no file movement is needed — the DB
changes are sufficient.

### Problem

`local` storage uses hierarchical paths: `data/projects/report.pdf`. If a file is trashed and a new file
with the same name is created in the same folder, both would resolve to the same on-disk path. The `file`
column (which stores the filename segment) must change to avoid collisions.

### Solution: `.trash/` directory

Each mount with `local` storage gets a `.trash/` directory inside its `data/` dir (created during
`mount.init()`, alongside `thumbs/` and `tmp/`).

The approach follows the same pattern as the [freedesktop.org Trash specification](https://specifications.freedesktop.org/trash-spec/latest/)
and macOS `~/.Trash`: files are moved to a flat trash directory keyed by unique ID, with original path
metadata stored separately for restore.

**Trashing a file:**
1. Current on-disk path: `data/projects/report.pdf`
2. Move to: `data/.trash/{pathId}.{ext}` via `storage.rename()` (flat namespace, no collisions possible)
3. Update `file` column to `.trash/{pathId}.{ext}`
4. Store original `file` value in `details.trashedFile` (merge with existing details, don't replace)
5. Change `parentId` to root folder

Since `resolveStoragePath()` walks the parent chain and concatenates `file` values, the resolved path
becomes: root (skipped) -> `.trash/{pathId}.{ext}` = `.trash/{pathId}.{ext}`. This correctly points to
`data/.trash/{pathId}.{ext}` on disk.

**Trashing a folder:**
1. Current on-disk path: `data/projects/my-folder/`
2. Move to: `data/.trash/{pathId}/` via `storage.rename()`
3. Update the folder's `file` column to `.trash/{pathId}`
4. Store original `file` value in `details.trashedFile`
5. Change `parentId` to root folder
6. **Descendants need no `file` column changes** — their `parentId` chain still points through this folder,
   and `resolveStoragePath()` now resolves through root -> `.trash/{pathId}` -> child, producing
   `.trash/{pathId}/child-name`. This correctly matches the physical location after the folder was moved

### Restore on path-based storage

1. Read original `file` value from `details.trashedFile`
2. Compute target path: resolve the target parent's storage path, append the original `file` value
3. Move from `.trash/{pathId}` back to the target location via `storage.rename()`
4. Restore the `file` column from `details.trashedFile`
5. Remove `trashedFile` key from `details` (keep other details like `originalName`, `width`, `height`
   intact — use `const { trashedFile, ...rest } = details; updatePath(id, { details: rest })`)

**Important**: the `file` column update for path-based storage must use a direct DB update, not
`updatePath()` with a `name` change — `validateName()` rejects names containing `/`, which
`.trash/{pathId}` would contain.

### Key-based and S3 storage

No file movement needed. Files are addressed by UUID keys (`{pathId}.{ext}`) that don't change.
Only the DB columns (`trashedAt`, `trashRoot`, `trashedFrom`, `parentId`) are updated on trash/restore.

## Query Changes

Existing mount queries that must add `AND trashedAt IS NULL`:

| Method              | Reason                                               |
|---------------------|------------------------------------------------------|
| `listFolder`        | Don't show trashed items in folder listings          |
| `getChildByName`    | Trashed items shouldn't block name lookups           |
| `assertUniqueName`  | Allow creating files with same name as trashed items |
| `getPathsByMimeType`| Exclude trashed items from type-filtered views       |
| `getPathsWithACL`   | Trashed items shouldn't appear in shared views       |

Queries that must **not** filter trashed items:

| Method           | Reason                                                |
|------------------|-------------------------------------------------------|
| `getPath`        | Needed for restore, breadcrumbs, permanent delete     |
| `getTotalSize`   | Trash counts toward quota                             |
| `getFileCount`   | Trash counts toward total                             |
| `getBreadcrumb`  | Needed for restore context                            |

### Access guards

`getPath()` intentionally returns trashed items (needed for restore/delete operations). To prevent
regular file access to trashed items, add guards at the **Drive level**:

- `getCollabDocument()`: if `path.trashedAt != null` → throw `ApiError(404, 'File is in trash')`
- `serveFile()`: if `path.trashedAt != null` → throw `ApiError(404, 'File is in trash')`
- `downloadFile()`: if `path.trashedAt != null` → throw `ApiError(404, 'File is in trash')`
- `getEditableContent()`: if `path.trashedAt != null` → throw `ApiError(404, 'File is in trash')`
- WebSocket upgrade handler for collab: check `trashedAt` before accepting connection

## New Mount Methods

```
trashPath(pathId)              — flag item + descendants, move parentId to root, handle storage move
restorePath(pathId)            — restore parentId, clear trash flags, handle storage move-back
listTrash()                    — SELECT ... WHERE trashRoot = 1 ORDER BY trashedAt DESC
emptyTrash()                   — permanently delete all trashed items
purgeExpiredTrash(maxAgeDays)  — permanently delete items where trashRoot = 1 AND trashedAt + maxAge < now
getTrashCount()                — count of top-level trashed items (for sidebar badge, cached in memory)
```

Both `trashPath()` and `restorePath()` must use `withPathLock(pathId)` to prevent race conditions
from concurrent trash/restore operations on the same item.

## Drive-Level Changes

`Drive` methods that wrap mount operations with ACL propagation, collab cleanup, and SSE emission:

```
trashPath(mountId, pathId)             — close collabs + ACL revocation + mount.trashPath + SSE
restorePath(mountId, pathId)           — mount.restorePath + ACL re-propagation + SSE
listTrash(mountId)                     — list top-level trashed items
permanentlyDelete(mountId, pathId)     — hard-delete from trash (existing deletePath, skip ACL propagation)
emptyTrash(mountId)                    — permanently delete all trash
```

`SharedDrive` wraps all new methods with write permission checks.

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

Purge runs on **`mount.init()`** only — cleans expired items when a Home initializes. This avoids adding
latency to read operations like `listTrash()`. The purge query:
`WHERE trashRoot = 1 AND trashedAt < (now - retentionDays)`, processing items via the existing
`deletePath()` which cascades to descendants.

## Frontend Changes

### Drive sidebar
- "Trash" navigation item with badge showing trashed item count

### Trash view
- List of top-level trashed items (`trashRoot = 1`)
- Columns: name, type, original location (from `trashedFrom` + breadcrumb), trashed date
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
- `DRIVE_PATH_TRASHED` → invalidate parent folder + invalidate trash queries
- `DRIVE_PATH_RESTORED` → invalidate target folder + invalidate trash queries

### Query keys
```typescript
export const driveKeys = {
    // ... existing keys ...
    trash: () => [...driveKeys.all, 'trash'] as const,
    trashList: (mountId: string) => [...driveKeys.trash(), mountId] as const,
    trashCount: (mountId: string) => [...driveKeys.trash(), 'count', mountId] as const,
};
```

## Known Limitations

- **Shared access is fully revoked on trash.** Collaborators lose access immediately and get a "no longer
  shared" notification. On restore, they receive a fresh "shared with you" notification rather than a
  seamless restoration. This matches the behavior of permanent delete and is simpler than maintaining
  shared access for trashed items.

- **Labels on trashed items are preserved** in the DB (no cascade delete since the row still exists).
  Label-based views should filter out trashed items using the same `trashedAt IS NULL` filter.

- **Concurrent editing during trash**: between reading the collab document list and closing connections,
  a new WebSocket connection could be established. The `trashedAt` guard on `getCollabDocument()` prevents
  new documents from being opened after the flag is set, but there is a brief window. This is the same
  race condition that exists in the current hard-delete flow.
