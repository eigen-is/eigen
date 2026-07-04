# Soft Delete / Trash

> **TLDR**: Delete moves items to trash instead of permanently deleting them. Two columns on `paths`
> (`trashedAt`, `trashedFrom`) track trash state. On trash, `parentId` is reparented to root and the original
> parent stored in `trashedFrom`. Path-based (`local`) storage moves files to a `.trash/` directory; key-based
> and S3 need no file movement. Trash counts toward quota. Auto-purge after configurable retention (default
> 30 days). Full-stack: mount → drive → SharedDrive → routes → hooks → trash view UI.

## Schema

Two columns on the `paths` table (`apps/api/src/lib/mount/schema.ts`):

| Column        | Type                | Default | Purpose                                               |
|---------------|---------------------|---------|-------------------------------------------------------|
| `trashedAt`   | INTEGER (timestamp) | NULL    | When the item was trashed. NULL = not trashed         |
| `trashedFrom` | TEXT                | NULL    | Original `parentId` before trashing (for restore)     |

`trashedFrom` doubles as the **trash-root indicator**: `trashedFrom IS NOT NULL` means this item was directly
trashed by the user (shown in the trash view). Descendants of a trashed folder have `trashedAt` set but
`trashedFrom = NULL` — they are implicitly trashed via their parent.

`trashedAt` is exposed on the `DrivePath` type (`packages/lib/src/types/drive.ts`) for frontend rendering
and the `getActivePath()` guard. `trashedFrom` is server-side only.

Migration version 2 in `apps/api/src/lib/mount/db-config.ts`:

```sql
ALTER TABLE paths ADD COLUMN trashedAt INTEGER;
ALTER TABLE paths ADD COLUMN trashedFrom TEXT;

CREATE INDEX idx_paths_trashed_from ON paths(trashedFrom, trashedAt) WHERE trashedFrom IS NOT NULL;
DROP INDEX idx_paths_parentId;
CREATE INDEX idx_paths_parent_trash ON paths(parentId, trashedAt);
```

The compound `idx_paths_parent_trash` replaces the original `parentId` index to cover the common
`WHERE parentId = ? AND trashedAt IS NULL` query pattern.

## Architecture

```
Route (thin handler)  →  SharedDrive (ACL + ownership checks)  →  Drive (collab + ACL propagation + SSE)  →  Mount (DB + storage)
```

All four layers have trash-specific methods. Existing `deleteFile`/`deleteFolder` routes now delegate to
`trashPath()` internally (soft-delete semantics).

## Mount Layer

**File**: `apps/api/src/lib/mount/mount.ts`

### trashPath(pathId)

1. Store original `parentId` in `trashedFrom`
2. Set `trashedAt` = now, `parentId` = root folder ID
3. For path-based storage: move to `.trash/{pathId}.{ext}` (see [Path-Based Storage](#path-based-local-storage))
4. For folders: recursively set `trashedAt` on descendants via CTE (`WHERE trashedAt IS NULL` — skip
   already-trashed items). Descendants keep `trashedFrom = NULL` and their `parentId` unchanged

Uses `withPathLock(pathId)` to prevent concurrent trash/restore operations. Direct DB update (not
`updatePath()`) to avoid name-uniqueness checks and duplicate storage moves.

### restorePath(pathId)

1. Verify original parent from `trashedFrom`:
   - If parent exists and is not trashed → restore there
   - If parent is gone or trashed → restore to mount root
2. Check name conflicts → auto-rename via `getUniqueFileName()` if needed
3. For path-based storage: move back from `.trash/` to target location, set `file = name`
4. Clear `trashedAt` and `trashedFrom`, set `parentId` to target folder
5. For folders: recursively clear `trashedAt` on descendants, **skipping** any with
   `trashedFrom IS NOT NULL` (independently trashed before the folder — these stay in trash)

### listTrash()

Returns items where `trashedFrom IS NOT NULL`, ordered by `trashedAt DESC`. Does not include descendants
(they have `trashedFrom = NULL`).

### permanentlyDeleteFromTrash(pathId)

Hard-deletes a trashed item. For folders, also finds independently-trashed children that were reparented to
root (via `WHERE trashedFrom IN (folderId, ...descendantIds)`) and deletes them first. Then cascades to
remaining children via `deletePath()`. Throws 400 if item is not in trash.

### purgeTrash(maxAgeDays?)

- With `maxAgeDays`: deletes items where `trashedAt < (now - maxAgeDays)`
- Without args: deletes all trashed items (empty trash)
- Runs automatically on `mount.init()` when `quotas.trashRetentionDays > 0`

### Query Filtering

Queries that add `AND trashedAt IS NULL` to exclude trashed items:

| Method              | Reason                                               |
|---------------------|------------------------------------------------------|
| `listFolder`        | Don't show trashed items in folder listings          |
| `getChildByName`    | Trashed items shouldn't block name lookups           |
| `assertUniqueName`  | Allow creating files with same name as trashed items |
| `getPathsByMimeType`| Exclude trashed items from type-filtered views       |
| `getPathsWithACL`   | Trashed items shouldn't appear in shared views       |

Queries that intentionally include trashed items:

| Method           | Reason                                                |
|------------------|-------------------------------------------------------|
| `getPath`        | Needed for restore, breadcrumbs, permanent delete     |
| `getTotalSize`   | Trash counts toward quota                             |
| `getFileCount`   | Trash counts toward total                             |

### listFolderAll(parentId)

Returns all children including trashed. Used internally by `closeCollabDocumentsRecursively()`,
`propagateACLRemovalRecursively()`, and `collectDescendantFileIds()` — these need to see all items regardless
of trash state.

### getActivePath(pathId)

Wraps `getPath()` with a trash guard — throws 404 "File is in trash" if `trashedAt` is set. All Drive methods
that previously called `getPath()` for regular file access use `getActivePath()` instead. Only trash-specific
operations (restore, permanent delete, listTrash) continue using `getPath()`. This makes the safe path the
default.

## Drive Layer

**File**: `apps/api/src/lib/drive/drive.ts`

Drive methods wrap mount operations with collab cleanup, ACL propagation, and SSE emission:

| Method | Behavior |
|--------|----------|
| `trashPath(mountId, pathId)` | Close collab docs → propagate ACL removal → `mount.trashPath()` → emit `DRIVE_PATH_TRASHED` |
| `restorePath(mountId, pathId)` | `mount.restorePath()` → re-propagate ACL for item + descendants → emit `DRIVE_PATH_RESTORED` |
| `listTrash(mountId)` | Delegates to `mount.listTrash()` |
| `permanentlyDelete(mountId, pathId)` | `mount.permanentlyDeleteFromTrash()` → emit `DRIVE_FILE_DELETED`/`DRIVE_FOLDER_DELETED` |
| `emptyTrash(mountId)` | `mount.purgeTrash()` (no maxAgeDays = delete all) |

**Ordering for folders**: collab close and ACL propagation happen **before** setting `trashedAt`, because they
use `listFolderAll()` to walk descendants.

### ACL Preservation

The `acl` column is preserved when an item is trashed (not cleared). This enables restore to re-share with
original collaborators:

- **On trash**: `propagateSharedPathChange(path, path.acl, null)` — revokes shared access, removes `sharedPaths`
  entries. The `acl` column stays intact on the owner's row.
- **On restore**: `propagateSharedPathChange(path, null, path.acl)` — re-creates `sharedPaths` entries using the
  preserved ACL.
- **On permanent delete**: ACL propagation is skipped — already revoked during trash.

## SharedDrive Layer

**File**: `apps/api/src/lib/drive/sharedDrive.ts`

| Method | Permission |
|--------|------------|
| `trashPath` | `withWritePermission()` on the path |
| `restorePath` | Drive owner only (`isEffectiveOwnerSync()`) |
| `listTrash` | Delegates directly (owner's trash) |
| `permanentlyDelete` | Drive owner only |
| `emptyTrash` | Drive owner only |

`isEffectiveOwnerSync(ownerId, memberships)` returns true if the user is the drive owner or a member of the
team that owns the drive.

## API Routes

**File**: `apps/api/src/routes/drive.ts`

| Endpoint | Method | Action |
|----------|--------|--------|
| `/drive/:ownerId/:mountId/file/:pathId` | DELETE | Soft-delete (trash) |
| `/drive/:ownerId/:mountId/folder/:pathId` | DELETE | Soft-delete (trash) |
| `/drive/:ownerId/:mountId/trash` | GET | List trash contents |
| `/drive/:ownerId/:mountId/trash/:pathId/restore` | POST | Restore from trash |
| `/drive/:ownerId/:mountId/trash/:pathId` | DELETE | Permanent delete single item |
| `/drive/:ownerId/:mountId/trash` | DELETE | Empty entire trash |

Existing DELETE endpoints now soft-delete. Frontend mutations keep working with safer semantics.

## SSE Events

| Event | Trigger | Frontend action |
|-------|---------|-----------------|
| `DRIVE_PATH_TRASHED` | Item moved to trash | Remove from old parent folder cache + update trash cache |
| `DRIVE_PATH_RESTORED` | Item restored from trash | Add to target folder cache + update trash cache |
| `DRIVE_FILE_DELETED` | Permanent delete | Remove from trash cache |
| `DRIVE_FOLDER_DELETED` | Permanent delete | Remove from trash cache |

`DRIVE_PATH_TRASHED` includes `oldParentId` (from `trashedFrom`) so the frontend knows which folder cache to
invalidate. Same call pattern as `DRIVE_PATH_MOVED`.

**SSE handlers** (`packages/lib/src/core/drive/sse-handlers.ts`):

```typescript
case SSEventType.DRIVE_PATH_TRASHED:
    invalidateItemDeleted(queryClient, path.ownerId, path.mountId, event.oldParentId, ...);
    invalidateTrash(queryClient, path.ownerId, path.mountId);

case SSEventType.DRIVE_PATH_RESTORED:
    invalidateItemCreated(queryClient, path.ownerId, path.mountId, path.parentId, path.mimeType);
    invalidateTrash(queryClient, path.ownerId, path.mountId);
```

## Frontend

### Hooks

**File**: `packages/lib/src/core/drive/hooks/use-drive.ts`

```typescript
driveKeys.trash = (ownerId) => [...driveKeys.owner(ownerId), 'trash']
driveKeys.trashList = (ownerId, mountId) => [...driveKeys.trash(ownerId), mountId]

useListTrash(ownerId, mountId)       // GET /drive/:ownerId/:mountId/trash → DrivePath[]
useRestorePath(ownerId, mountId)     // POST .../trash/:pathId/restore
usePermanentlyDelete(ownerId, mountId) // DELETE .../trash/:pathId
useEmptyTrash(ownerId, mountId)      // DELETE .../trash
invalidateTrash(queryClient, ownerId, mountId) // Helper for SSE handlers
```

All mutations invalidate `driveKeys.trashList` on success.

### Trash View

**File**: `apps/drive/src/routes/_auth.trash.tsx`

Uses `ColumnLayout` + `Column` with toolbar. Shows a table of top-level trashed items with:
- File icon + name (Eigen extensions stripped)
- Trashed date (formatted via `formatDateTime()`)
- Hover actions: Restore (`RotateCcw`) and Delete permanently (`Trash2`) via `TooltipButton`
- Right-click context menu with the same actions
- "Empty trash" button in toolbar (with `DeleteDialog` confirmation)
- `EmptyState` when trash is empty

### Sidebar

**File**: `apps/drive/src/components/drive/drive-sidebar.tsx`

"Trash" item at the bottom of the sidebar with a `Badge` showing the trashed item count (from
`useListTrash()`). Badge hidden in condensed mode.

## Path-Based (`local`) Storage

The only storage type requiring file-system operations on trash/restore. `local-key` and `s3` backends
address files by UUID keys that never collide — only DB columns change.

### Problem

`local` storage uses hierarchical paths: `data/projects/report.pdf`. If a file is trashed and a new file with
the same name is created, both resolve to the same disk path.

### Solution: `.trash/` directory

Each mount with `local` storage has a `.trash/` directory inside `data/`, created during `mount.init()`.
Follows the same pattern as the
[freedesktop.org Trash specification](https://specifications.freedesktop.org/trash-spec/latest/): files moved
to a flat directory keyed by unique ID.

**Trashing a file:**
1. Move `data/projects/report.pdf` → `data/.trash/{pathId}.pdf` via `storage.rename()`
2. Update `file` column to `.trash/{pathId}.pdf`
3. `resolveStoragePath()` now resolves through root → `.trash/{pathId}.pdf`

**Trashing a folder:**
1. Move `data/projects/my-folder/` → `data/.trash/{pathId}/` via `storage.rename()`
2. Update folder's `file` column to `.trash/{pathId}`
3. Descendants' `file` columns are unchanged — `resolveStoragePath()` resolves through
   root → `.trash/{pathId}` → child-name

**Restoring:**
1. Move from `.trash/` back to target location
2. Set `file = name` (original value recoverable from `name` since they're always kept in sync)

### Direct DB update

The entire trash DB update must be a single direct `db.update(paths).set(...)` call, **not** through
`updatePath()`. Two reasons:
1. `updatePath()` triggers `assertUniqueName(root, name)` — can fail if an active item at root has the same
   name
2. For path-based storage, `updatePath()` triggers `storage.rename()` — but the storage move was already done
   separately

## Auto-Purge

Configurable in `ServerSettings.quotas` (`apps/api/src/lib/config/server-settings.ts`):

```
trashRetentionDays: 30  // default
```

Purge runs on `mount.init()` only — cleans expired items when a Home initializes. Items older than
`trashRetentionDays` are permanently deleted via `permanentlyDeleteFromTrash()`.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Parent permanently deleted while item in trash | Restore to mount root |
| Parent is itself trashed | Restore to mount root |
| Name conflict at restore target | Auto-rename via `getUniqueFileName()` |
| File trashed, then parent folder trashed | Both appear in trash view. Restoring folder skips the independently-trashed file |
| Permanently delete folder from trash | All descendants deleted, including independently-trashed children reparented to root |
| Collab document in trash accessed via WebSocket | Blocked by `getActivePath()` guard |
| Trash root folder | Throws 400 |

## Known Limitations

- **Shared access fully revoked on trash.** Collaborators lose access immediately. On restore, they get a
  fresh "shared with you" notification rather than seamless restoration.
- **Labels on trashed items preserved** in the DB. Label-based views filter trashed items via
  `trashedAt IS NULL`.
- **Concurrent editing during trash**: brief window between reading the collab list and closing connections
  where a new WebSocket could connect. Same race condition as the pre-existing hard-delete flow.

## Tests

**File**: `apps/api/src/test/mount.test.ts`

Comprehensive test coverage across:
- **Trash basics**: sets columns correctly, recursive folder trash, skips already-trashed descendants,
  rejects root folder, preserves ACL
- **Query filtering**: `listFolder` excludes, `getPath` includes, `getActivePath` throws 404, name reuse
  after trash
- **Trash listing**: returns `trashedFrom IS NOT NULL` only, ordered by `trashedAt DESC`
- **Restore**: clears flags, restores to original or root, auto-renames on conflict, preserves independently
  trashed descendants
- **Permanent delete**: removes item + descendants, finds reparented children via `trashedFrom IN (...)`
- **Auto-purge**: respects `maxAgeDays`, runs on `mount.init()`
- **Path-based storage**: verifies `.trash/` moves, content readability after trash, no disk collisions
- **Key-based storage**: verifies no file movement needed
- **SharedDrive ACL**: write permission for trash, owner-only for restore/permanent delete/empty

## Cleanup TODO

See `docs/TODO-SOFT-DELETE-CLEANUP.md`: the separate `deleteFile`/`deleteFolder` routes and hooks could be
consolidated into a single `trashPath` route, but deferred since the current one-liner wrappers work and the
routes are part of the public API.
