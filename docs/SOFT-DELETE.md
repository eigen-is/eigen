# Soft Delete / Recycle Bin

> **TLDR**: Delete becomes "move to trash". Two new columns on `paths` (`trashedAt`, `trashedFrom`).
> On trash, `parentId` is reparented to root and the original parent is stored in `trashedFrom`.
> Path-based (`local`) storage moves files to a `.trash/` directory; key-based/S3 needs no file movement.
> Trash counts toward quota. Auto-purge after configurable retention (default 30 days). Full-stack:
> backend + API + frontend trash view.

## Schema Changes

Add to the `paths` table in `apps/api/src/lib/mount/schema.ts`:

| Column        | Type                | Default | Purpose                                               |
|---------------|---------------------|---------|-------------------------------------------------------|
| `trashedAt`   | INTEGER (timestamp) | NULL    | When the item was trashed. NULL = not trashed         |
| `trashedFrom` | TEXT                | NULL    | Original `parentId` before trashing (for restore)     |

**`trashedFrom` doubles as the trash-root indicator**: `trashedFrom IS NOT NULL` means this item was
directly trashed by the user (shown in trash view). Descendants of a trashed folder have `trashedAt` set
but `trashedFrom = NULL` — they are implicitly trashed via their parent.

Add `trashedAt` to the `DrivePath` type in `packages/lib/src/types/drive.ts` (needed for frontend trash
view rendering and the `getActivePath()` guard). `trashedFrom` is only needed server-side.

Bump schema version in `apps/api/src/lib/mount/db-config.ts`.

### Indexes

| Index                      | Definition                                           | Purpose                            |
|----------------------------|------------------------------------------------------|------------------------------------|
| `idx_paths_trashed_from`   | `(trashedFrom, trashedAt) WHERE trashedFrom IS NOT NULL` | Trash view listing + expired purge |
| `idx_paths_parent_trash`   | `(parentId, trashedAt)`                              | Folder listings with trash filter  |

The existing `parentId` index is replaced by the compound `idx_paths_parent_trash` to cover the common
`WHERE parentId = ? AND trashedAt IS NULL` query pattern.

## Trash Semantics

### Core principle: `parentId` changes to root on trash

On trash, the item's `parentId` is changed to the **mount root folder**. The original `parentId` is stored
in `trashedFrom` for restore. All storage types follow this pattern for uniform query behavior. For
path-based storage it is essential — `resolveStoragePath()` walks the parent chain, so reparenting ensures
it produces the correct `.trash/...` path through root.

### Trashing a file

1. Store original `parentId` in `trashedFrom`
2. Set `trashedAt` = now, `parentId` = root folder ID
3. Handle path-based storage move (see [Path-Based Storage](#path-based-local-storage))
4. Close collab document if applicable
5. Propagate ACL removal: call `propagateACLChange(path, path.acl, null)` — revokes shared access
6. Emit `DRIVE_PATH_TRASHED` SSE event (include `oldParentId` from `trashedFrom`)

### Trashing a folder

**Important ordering**: collab close and ACL propagation happen **before** setting `trashedAt`, because
they use `listFolderAll()` (see [Internal helpers](#internal-helpers-listfolderall)) to walk descendants.

1. Close collab documents recursively (via `listFolderAll`)
2. Propagate ACL removal recursively (via `listFolderAll`)
3. Handle path-based storage move on the top-level folder only (descendants move with it on disk)
4. Store original `parentId` in `trashedFrom` on the folder
5. Set `trashedAt` = now, `parentId` = root folder ID on the folder
6. Recursively set `trashedAt` = now on all descendants `WHERE trashedAt IS NULL` (skip already-trashed
   items). Descendants keep `trashedFrom = NULL` and their `parentId` unchanged (they stay inside the
   moved folder)
7. Emit `DRIVE_PATH_TRASHED` SSE event (include `oldParentId` from `trashedFrom`)

### Crash safety (path-based storage)

For path-based storage, the trash operation involves both a storage rename and DB updates. Following the
existing codebase pattern, the operation runs inside `withPathLock(pathId)` to prevent concurrent access.
Order: **storage rename first, DB update second**. If a crash occurs between the two:

- File is physically in `.trash/` but DB still says it is active at the old path
- Next access resolves the old storage path → 404 from storage
- Recovery: on `mount.init()`, detect items with `trashedAt` set whose `.trash/` file does not exist,
  and check the original path (computable from `trashedFrom` parent chain + `name`) — retry the rename
  if found

This is a rare edge case (process crash during the brief window) and the recovery pass is best-effort.

### Permanent delete

**For a single file**: uses existing `mount.deletePath()` logic. ACL was already revoked during trash,
so permanent delete skips ACL propagation.

**For a trashed folder**: `deletePath()` walks descendants by `parentId`, which correctly finds
non-independently-trashed children (their `parentId` is unchanged). However, independently-trashed items
that were originally inside this folder have been reparented to root — `collectDescendantFileIds` will
miss them.

To handle this, `permanentlyDeleteFromTrash(pathId)` must:
1. Collect all descendant IDs of the folder (via `parentId` walk — finds non-reparented children)
2. Query for any items whose `trashedFrom` is the folder ID or any descendant ID
   (`WHERE trashedFrom IN (folderId, ...descendantIds)`)
3. Permanently delete those orphaned trash entries first
4. Then call `deletePath(pathId)` which cascades to the remaining children

Additionally, `deletePath()` itself should guard against deleting the root folder
(`if parentId === null, throw`) — currently only `deleteFolder()` has this guard.

## Restore

### Restoring a file

1. Verify original parent from `trashedFrom`:
   - If parent exists and is not trashed: restore there
   - If parent is gone or trashed: restore to mount root instead
2. Check for name conflicts in the target folder (using `assertUniqueName` which excludes trashed items)
   - On conflict: generate unique name via `getUniqueFileName()`
3. Handle path-based storage move-back (see [Restore on Path-Based Storage](#restore-on-path-based-storage))
4. Set `parentId` to the target folder (from `trashedFrom` or root)
5. Clear `trashedAt` and `trashedFrom`
6. Re-propagate ACL: call `propagateACLChange(path, null, path.acl)` — `oldACL=null` because sharing was
   revoked on trash, `newACL=path.acl` re-shares with collaborators
7. Emit `DRIVE_PATH_RESTORED` SSE event

### Restoring a folder

1. Same parent-existence check. Restore to mount root if original parent is gone/trashed
2. Same name-conflict handling
3. Handle path-based storage move-back on the top-level folder only
4. Set `parentId` to target, clear `trashedAt` and `trashedFrom` on the folder
5. Recursively clear `trashedAt` on descendants, **skipping** any with `trashedFrom IS NOT NULL`
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
| File trashed, then parent folder trashed | Both appear in trash view (`trashedFrom IS NOT NULL`). Restoring folder skips the independently-trashed file |
| Permanently delete a folder from trash | All descendants are permanently deleted, including independently-trashed children that were reparented to root (found via `trashedFrom IN (...)` query) |
| Collab document in trash accessed via WebSocket | Blocked by `getActivePath()` guard |

## Path-Based (`local`) Storage

This is the only storage type that requires file-system operations on trash/restore. `local-key` and `s3`
backends address files by UUID-based keys that never collide, so no file movement is needed — the DB
changes are sufficient.

### Problem

`local` storage uses hierarchical paths: `data/projects/report.pdf`. If a file is trashed and a new file
with the same name is created in the same folder, both would resolve to the same on-disk path. The `file`
column (which stores the filename segment) must change to avoid collisions.

### Solution: `.trash/` directory

Each mount with `local` storage gets a `.trash/` directory inside its `data/` dir. This directory **must**
be created during `mount.init()` (alongside `thumbs/` and `tmp/`).

The approach follows the same pattern as the
[freedesktop.org Trash specification](https://specifications.freedesktop.org/trash-spec/latest/)
and macOS `~/.Trash`: files are moved to a flat trash directory keyed by unique ID, with original path
metadata stored separately for restore.

**Trashing a file:**
1. Current on-disk path: `data/projects/report.pdf`
2. Move to: `data/.trash/{pathId}.{ext}` via `storage.rename()` (flat namespace, no collisions possible)
3. Update `file` column to `.trash/{pathId}.{ext}`
4. Change `parentId` to root folder

Since `resolveStoragePath()` walks the parent chain and concatenates `file` values, the resolved path
becomes: root (skipped) -> `.trash/{pathId}.{ext}` = `.trash/{pathId}.{ext}`. This correctly points to
`data/.trash/{pathId}.{ext}` on disk.

**Trashing a folder:**
1. Current on-disk path: `data/projects/my-folder/`
2. Move to: `data/.trash/{pathId}/` via `storage.rename()`
3. Update the folder's `file` column to `.trash/{pathId}`
4. Change `parentId` to root folder
5. **Descendants need no `file` column changes** — their `parentId` chain still points through this folder,
   and `resolveStoragePath()` now resolves through root -> `.trash/{pathId}` -> child, producing
   `.trash/{pathId}/child-name`. This correctly matches the physical location after the folder was moved

No need to store the original `file` value separately — for path-based storage, `file` and `name` are
always kept in sync (`createFile` sets `file = name`, `updatePath` updates both on rename). Since `name`
is not changed during trash, the original `file` value can be recovered from `name` on restore.

### Restore on path-based storage

1. Compute target path: resolve the target parent's storage path, append `name`
2. Move from `.trash/{pathId}` back to the target location via `storage.rename()`
3. Set `file = name` (restores the original storage filename segment)

### Direct DB update — do not use `updatePath()`

The **entire trash DB update** (`parentId`, `file`, `trashedAt`, `trashedFrom`) must be a single direct
`db.update(paths).set(...)` call, **not** through `updatePath()`. Two reasons:

1. `updatePath()` with a `parentId` change triggers `assertUniqueName(root, name)` — this can fail if
   an active item at root has the same name. Trash must not be blocked by naming conflicts.
2. For path-based storage, `updatePath()` triggers `storage.rename()` for the `parentId` change — but
   the storage move was already done separately. Running it again would break.

The restore operation has the same constraint for path-based storage: do the storage rename separately,
then use a direct DB update to set `parentId`, `file = name`, and clear `trashedAt`/`trashedFrom`.

### Key-based and S3 storage

No file movement needed. Files are addressed by UUID keys (`{pathId}.{ext}`) that don't change.
Only the DB columns (`trashedAt`, `trashedFrom`, `parentId`) are updated on trash/restore.

## Query Changes

Existing mount queries that must add `AND trashedAt IS NULL`:

| Method              | Reason                                               |
|---------------------|------------------------------------------------------|
| `listFolder`        | Don't show trashed items in folder listings          |
| `getChildByName`    | Trashed items shouldn't block name lookups           |
| `assertUniqueName`  | Allow creating files with same name as trashed items |
| `getPathsByMimeType`| Exclude trashed items from type-filtered views       |
| `getPathsWithACL`   | Trashed items shouldn't appear in shared views       |

**Note on `getPathsByMimeType`**: this method has a recursive CTE (`doc_tree`) that walks containers by
type to exclude document children. The CTE's seed query (`WHERE type IN ('doc', 'stickies', ...)`) must
also include `AND trashedAt IS NULL` — otherwise trashed containers reparented to root would be included
in the exclusion walk, potentially hiding active files whose `parentId` matches a trashed container's ID.

Queries that must **not** filter trashed items:

| Method           | Reason                                                |
|------------------|-------------------------------------------------------|
| `getPath`        | Needed for restore, breadcrumbs, permanent delete     |
| `getTotalSize`   | Trash counts toward quota                             |
| `getFileCount`   | Trash counts toward total                             |
| `getBreadcrumb`  | Needed for restore context                            |

### Internal helpers: `listFolderAll()`

Add a private `listFolderAll(parentId)` method that queries children **without** the `trashedAt IS NULL`
filter. Used internally by:

- `closeCollabDocumentsRecursively()` — must find all children regardless of trash state
- `propagateACLRemovalRecursively()` — must propagate to all children
- `collectDescendantFileIds()` / `deleteDescendantsInTx()` — must find all children for deletion

This removes the fragile dependency on call ordering (where these helpers had to run before `trashedAt`
was set on descendants).

### Access guards: `Mount.getActivePath()`

`getPath()` intentionally returns trashed items (needed for restore, permanent delete, breadcrumbs).
Instead of adding trash checks to every Drive method individually, add a single **`Mount.getActivePath(pathId)`**
method that wraps `getPath()` with a trash check:

```typescript
async getActivePath(pathId: string): Promise<DrivePath> {
    const path = await this.getPath(pathId);
    if (!path) throw new ApiError(404, 'Path not found');
    if (path.trashedAt) throw new ApiError(404, 'File is in trash');
    return path;
}
```

All existing Drive methods that currently call `mount.getPath()` for regular file access switch to
`mount.getActivePath()`. Only trash-specific operations (restore, permanent delete, listTrash) continue
using `getPath()`. This makes the safe path the default — new code is protected without remembering to
add a guard.

Methods that switch to `getActivePath()`:
- `getFolderContents`, `createFolder`, `createCollabDoc`, `createChat`
- `uploadFiles`, `deleteFolder`, `deleteFile`, `movePath`, `renamePath`
- `serveFile`, `downloadFile`, `writeFileContent`, `resolveFile`
- `getEditableContent`, `saveEditableContent`
- `getCollabDocument`, `getPreview`, `getTextPreview`, `getThumbnail`

Note: `resolveFile(mountId, pathId)` (returns `{ mount, path }`) is used by 4 routes — export, preview,
text-preview, and thumbnail. It currently calls `mount.getPath()` and must switch to `getActivePath()`.

Methods that keep using `getPath()` (trash-aware operations):
- `restorePath`, `permanentlyDelete`, `emptyTrash`, `listTrash`
- `breadCrumb` (needs trashed context for restore UI)
- `updateACL` (called internally during restore re-propagation)

Additionally, the WebSocket upgrade handler for collab must check `trashedAt` before accepting a
connection.

### ACL preservation during trash

The `acl` column on the `paths` row is **intentionally preserved** when an item is trashed. It is not
cleared. This serves two purposes:

1. **Restore source**: on restore, `propagateACLChange(path, null, path.acl)` re-shares with the original
   collaborators using the preserved ACL values
2. **Trash view context**: the owner can see who had access to a trashed item

The flow:
- **On trash**: `propagateACLChange(path, path.acl, null)` — tells collaborators "access revoked",
  removes `sharedPaths` entries. The `acl` column on the owner's `paths` row stays intact.
- **On restore**: `propagateACLChange(path, null, path.acl)` — `oldACL=null` because sharing was revoked,
  `newACL=path.acl` (still on the row) re-creates `sharedPaths` entries for collaborators.
- **On permanent delete**: ACL propagation is skipped — it was already revoked during trash.
  `deletePath()` removes the row and its preserved ACL.

## New Mount Methods

```
trashPath(pathId)                  — flag item + descendants, reparent to root, handle storage move
restorePath(pathId)                — restore parentId, clear trash flags, handle storage move-back
listTrash()                        — SELECT ... WHERE trashedFrom IS NOT NULL ORDER BY trashedAt DESC
purgeTrash(maxAgeDays?: number)    — if maxAgeDays: purge expired items; if omitted: purge all (empty trash)
permanentlyDeleteFromTrash(pathId) — trash-aware hard delete (finds reparented children via trashedFrom)
listFolderAll(parentId)            — private, no trash filter, for internal recursive helpers
```

Both `trashPath()` and `restorePath()` must use `withPathLock(pathId)` to prevent race conditions
from concurrent trash/restore operations on the same item.

## Drive-Level Changes

`Drive` methods that wrap mount operations with ACL propagation, collab cleanup, and SSE emission:

```
trashPath(mountId, pathId)             — close collabs + ACL revocation + mount.trashPath + SSE
restorePath(mountId, pathId)           — mount.restorePath + ACL re-propagation + SSE
listTrash(mountId)                     — list top-level trashed items
permanentlyDelete(mountId, pathId)     — mount.permanentlyDeleteFromTrash (skip ACL propagation)
emptyTrash(mountId)                    — mount.purgeTrash() (no maxAgeDays = delete all)
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
| `DRIVE_PATH_TRASHED` | Item moved to trash | Remove from old parent folder cache, update trash cache |
| `DRIVE_PATH_RESTORED` | Item restored from trash | Add to target folder cache, update trash cache |
| `DRIVE_FILE_DELETED` | Permanent delete (unchanged) | Remove from trash cache |
| `DRIVE_FOLDER_DELETED` | Permanent delete (unchanged) | Remove from trash cache |

`DRIVE_PATH_TRASHED` must include `oldParentId` (from `trashedFrom`) so the frontend knows which folder
cache to invalidate. The existing `SSEventDrive` type already has `oldParentId?: string` and
`buildDriveEvent()` already accepts it — no type changes needed, same call pattern as `DRIVE_PATH_MOVED`.

## Auto-Purge

New field in `ServerSettings.quotas` (`packages/lib/src/types/settings.ts`):

```
trashRetentionDays: number  // default: 30
```

Add to the `settingsStore` defaults in `apps/api/src/lib/config/server-settings.ts`.

Purge runs on **`mount.init()`** only — cleans expired items when a Home initializes. This avoids adding
latency to read operations like `listTrash()`. The purge query:
`WHERE trashedFrom IS NOT NULL AND trashedAt < (now - retentionDays)`, processing items via
`permanentlyDeleteFromTrash()` which handles reparented children.

## Frontend Changes

### Drive sidebar
- "Trash" navigation item with badge (count derived from `listTrash` query data)

### Trash view
- List of top-level trashed items (`trashedFrom IS NOT NULL`)
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
```

### New SSE handlers
- `DRIVE_PATH_TRASHED` → invalidate old parent folder (via `oldParentId`) + invalidate trash queries
- `DRIVE_PATH_RESTORED` → invalidate target folder + invalidate trash queries

### Query keys
```typescript
export const driveKeys = {
    // ... existing keys ...
    trash: () => [...driveKeys.all, 'trash'] as const,
    trashList: (mountId: string) => [...driveKeys.trash(), mountId] as const,
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
  a new WebSocket connection could be established. The `trashedAt` guard on `getActivePath()` prevents
  new documents from being opened after the flag is set, but there is a brief window. This is the same
  race condition that exists in the current hard-delete flow.

## Tests

Tests live in `apps/api/test/` alongside the existing drive integration tests. Each group below maps to
one `describe` block. Tests use the existing test helpers (test user, test home, mount creation).

### Mount: trash basics

- trash a file → sets `trashedAt`, `trashedFrom=originalParent`, `parentId=rootId`
- trash a file → `acl` column is preserved (not cleared)
- trash a folder → sets `trashedAt` on folder and all descendants
- trash a folder → descendants get `trashedFrom=NULL` (not shown in trash view)
- trash a folder → already-trashed descendants are skipped (keep their own `trashedFrom`)
- trash root folder → throws 400
- trash non-existent path → throws 404
- `withPathLock` prevents concurrent trash on the same path

### Mount: trash query filtering

- `listFolder` excludes trashed items
- `listFolderAll` includes trashed items
- `getChildByName` excludes trashed items
- `assertUniqueName` ignores trashed items (allows same-name creation)
- `getPathsByMimeType` excludes trashed items (including inside CTE)
- `getPathsWithACL` excludes trashed items
- `getPath` still returns trashed items
- `getTotalSize` includes trashed items (quota)
- `getFileCount` includes trashed items
- `getActivePath` throws 404 for trashed items
- `getActivePath` returns active items normally

### Mount: trash listing

- `listTrash` returns only `trashedFrom IS NOT NULL` items
- `listTrash` ordered by `trashedAt` descending
- `listTrash` empty when nothing is trashed

### Mount: restore basics

- restore a file → clears `trashedAt`, `trashedFrom`, restores `parentId`
- restore a folder → clears flags on folder and all non-independently-trashed descendants
- restore a folder → descendants with `trashedFrom IS NOT NULL` stay trashed
- restore when original parent exists → restores to original parent
- restore when original parent was permanently deleted → restores to root
- restore when original parent is trashed → restores to root
- restore with name conflict → generates unique name via `getUniqueFileName()`
- restore non-trashed item → throws 400
- `withPathLock` prevents concurrent restore on the same path

### Mount: permanent delete

- permanently delete file from trash → removes DB row + storage file + thumbnail
- permanently delete folder from trash → removes folder + all descendants + storage
- permanently delete folder → finds and deletes independently-trashed children (via `trashedFrom IN (...)`)
- `purgeTrash()` (no args) deletes all trashed items
- `purgeTrash()` on empty trash → no-op
- `deletePath` refuses to delete root folder (`parentId === null`)

### Mount: auto-purge

- `purgeTrash(30)` deletes items trashed >30 days ago
- `purgeTrash(30)` keeps items trashed <30 days ago
- purge runs during `mount.init()`

### Path-based (`local`) storage

- trash a file → moves to `data/.trash/{pathId}.ext` on disk
- trash a file → `file` column updated to `.trash/{pathId}.ext`
- trash a folder → moves to `data/.trash/{pathId}/` on disk
- trash a folder → descendants' `file` columns unchanged
- `resolveStoragePath` for trashed file → resolves to `.trash/{pathId}.ext`
- `resolveStoragePath` for child of trashed folder → resolves to `.trash/{folderId}/child`
- trash file, create new file with same name → no disk collision, both accessible
- restore file → moves back from `.trash/` to original location
- restore file → `file` column restored to `name` value
- restore folder → moves back, descendants resolve to original paths
- permanent delete → removes from `.trash/` directory
- `.trash/` directory created during `mount.init()`

### Key-based (`local-key`) and S3 storage

- trash a file → no file movement, storage key unchanged
- restore a file → no file movement, storage key unchanged
- trash + create same-name file → no collision (UUID keys are unique)

### Drive: trash with ACL propagation

- `trashPath` closes collab documents before setting `trashedAt`
- `trashPath` calls `propagateACLChange(path, path.acl, null)` — revokes shared access
- `trashPath` emits `DRIVE_PATH_TRASHED` SSE event with `oldParentId`
- trash a shared folder → each collaborator's `sharedPaths` entry removed
- trash a shared folder → collaborators receive "no longer shared" notification

### Drive: restore with ACL propagation

- `restorePath` calls `propagateACLChange(path, null, path.acl)` — re-shares
- `restorePath` emits `DRIVE_PATH_RESTORED` SSE event
- restore a shared folder → each collaborator's `sharedPaths` entry re-created
- restore a shared folder → collaborators receive "shared with you" notification
- restore folder → re-propagates ACL for each descendant that has ACL set

### Drive: permanent delete from trash

- `permanentlyDelete` skips ACL propagation (already revoked on trash)
- `permanentlyDelete` emits `DRIVE_FILE_DELETED` / `DRIVE_FOLDER_DELETED` SSE event
- `permanentlyDelete` on non-trashed item → throws 400

### Drive: access guards via `getActivePath`

- `serveFile` on trashed item → 404
- `resolveFile` on trashed item → 404 (blocks preview, export, thumbnail routes)
- `getCollabDocument` on trashed item → 404
- `uploadFiles` to trashed folder → 404

### SharedDrive: permission checks

- all trash operations require write permission
- restore requires write permission
- permanent delete requires write permission

### API routes

- `DELETE /drive/:ownerId/:mountId/file/:pathId` → soft-deletes (returns 200, item is trashed)
- `DELETE /drive/:ownerId/:mountId/folder/:pathId` → soft-deletes folder + descendants
- `GET /drive/:ownerId/:mountId/trash` → returns trashed items list
- `POST /drive/:ownerId/:mountId/trash/:pathId/restore` → restores item
- `DELETE /drive/:ownerId/:mountId/trash/:pathId` → permanently deletes
- `DELETE /drive/:ownerId/:mountId/trash` → empties all trash
- all trash routes require auth

### SSE integration

- `DRIVE_PATH_TRASHED` event contains path data + `oldParentId`
- `DRIVE_PATH_RESTORED` event contains path data with `trashedAt` cleared
- frontend handler for `DRIVE_PATH_TRASHED` invalidates old parent folder + trash queries
- frontend handler for `DRIVE_PATH_RESTORED` invalidates target folder + trash queries
