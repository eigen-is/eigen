# Soft Delete / Trash

> **TLDR**: Delete moves items to trash instead of erasing them. `trashedAt` + `trashedFrom` on `paths` track
> the state; the item is re-parented to the mount root and `trashedFrom` holds the original parent.
> Path-based (`local`) storage also moves the bytes into `data/.trash/`; key-based and S3 do not move anything.
> Trash counts toward quota and auto-purges after `trashRetentionDays` (default 30).

## Schema

Two nullable columns on the `paths` table (`apps/api/src/lib/mount/schema.ts`): `trashedAt` (timestamp, NULL =
not trashed) and `trashedFrom` (the original `parentId`, kept so restore knows where to put the item back).

`trashedFrom` doubles as the **trash-root marker**: `trashedFrom IS NOT NULL` means the user trashed this item
directly, so it is what the trash view lists. Descendants of a trashed folder get `trashedAt` but keep
`trashedFrom = NULL` — they are implicitly trashed through their parent. `trashedAt` is exposed on `DrivePath`
(`packages/lib/src/types/drive.ts`); `trashedFrom` is server-side only.

Both columns, plus `idx_paths_trashed_from` and the compound `idx_paths_parent_trash` (which covers the common
`WHERE parentId = ? AND trashedAt IS NULL` pattern), are part of the **v1 baseline schema** in
`apps/api/src/lib/mount/db-config.ts` — there is no separate trash migration. Migration v2 in that file is the
`paths_fts` name index.

## Layers

```
Route (thin)  →  SharedDrive (ACL + ownership)  →  Drive (collab + ACL propagation + SSE + history)  →  Mount (DB + storage)
```

The trash logic itself lives in two sibling modules, not in the big classes: `apps/api/src/lib/mount/trash.ts`
(DB + storage bodies) and `apps/api/src/lib/drive/trash.ts` (collab close, ACL propagation, SSE, history).
`Mount` and `Drive` keep thin facades that do the liveness and permission checks and delegate.

### Mount

- `trashPath(pathId)` — flush and close cached DBs under the item, then under `withPathLock`: move the bytes to
  `.trash/` (path-based only), set `trashedAt` + `trashedFrom`, re-parent to root, and recursively set
  `trashedAt` on descendants not already trashed. The DB write is a direct `db.update(paths)`, not
  `updatePath()`, so it skips the name-uniqueness check and does not repeat the storage move.
- `restorePath(pathId)` — back to the original parent if it still exists and is not trashed, else to the mount
  root; name conflicts auto-rename via `getUniqueFileName()`. Descendants with `trashedFrom IS NOT NULL` are
  skipped — they were trashed independently and stay in trash.
- `listTrash()` — rows with `trashedFrom IS NOT NULL`, newest first.
- `permanentlyDeleteFromTrash(pathId)` — hard delete; 400 if the item is not in trash. For folders it first
  deletes independently-trashed children re-parented to root (`trashedFrom IN (folderId, ...descendantIds)`).
- `purgeTrash(maxAgeDays?)` — with an age, deletes items older than it; without, empties the trash.

**Query filtering.** `listFolder`, `getChildByName`, `assertUniqueName`, `getPathsByMimeType` and
`getPathsWithACL` all add `trashedAt IS NULL`, so trashed items disappear from listings, name lookups and
shared views, and their names become reusable. `getPath`, `getTotalSize` and `getFileCount` deliberately
include trashed rows — restore and breadcrumbs need the row, and trashed bytes still count toward quota.

Two helpers make that safe by default. `listFolderAll(parentId)` returns children **including** trashed ones —
what the recursive walks (collab close, ACL propagation, descendant collection) need. `getActivePath(pathId)`
wraps `getPath()` and throws 404 "File is in trash" when `trashedAt` is set; regular file access goes through
it, and only restore, permanent delete and `listTrash` still use raw `getPath()`.

### Drive

| Method | Behavior |
|--------|----------|
| `deletePath(mountId, pathId, user?)` | Close collab docs → propagate ACL removal → `mount.trashPath()` → emit `DRIVE_PATH_TRASHED` → record `trashed` history + fan out to watchers |
| `restorePath(mountId, pathId, user?)` | `mount.restorePath()` → re-propagate ACL for the item + descendants → emit `DRIVE_PATH_RESTORED` → record `restored` |
| `listTrash(mountId)` | Delegates to `mount.listTrash()` |
| `permanentlyDelete(mountId, pathId, user?)` | Collect watchers + `trashedFrom` first, then `mount.permanentlyDeleteFromTrash()` → emit `DRIVE_FILE_DELETED` / `DRIVE_FOLDER_DELETED` → notify watchers |
| `emptyTrash(mountId, user?)` | Lists trash and loops `permanentlyDelete` per item, so every item gets the same ACL, SSE and history handling |

For folders, collab close and ACL propagation run **before** `trashedAt` is set, because they walk descendants
via `listFolderAll()`.

**ACL preservation.** The `acl` column survives trashing. Trash calls
`propagateSharedPathChange(path, path.acl, null)` — shared access is revoked and `sharedPaths` rows dropped,
but the owner's `acl` stays. Restore calls it with `(path.acl, path.acl)`: an empty added-diff, so
collaborators are re-shared without a fresh email. Permanent delete skips it — already revoked at trash time.

### SharedDrive

`deletePath` needs `withWritePermission()` on the path. `restorePath`, `permanentlyDelete`, `emptyTrash` and
`listTrash` are all **drive-owner only** (`isEffectiveOwnerSync`, true for the owner or a member of the owning
team) — `listTrash` carries its own explicit check so a non-owner cannot enumerate what the owner deleted.

### Routes

All in `apps/api/src/routes/drive.ts`. Deleting is one route for both files and folders —
`DELETE /drive/:ownerId/:mountId/path/:pathId` (the old separate `file/` and `folder/` DELETE pair is gone).
Trash itself is `GET /trash`, `POST /trash/:pathId/restore`, `DELETE /trash/:pathId` (permanent) and
`DELETE /trash` (empty), all under the same `/drive/:ownerId/:mountId` prefix.

## SSE and hooks

Events: `DRIVE_PATH_TRASHED` (carries `oldParentId` from `trashedFrom`, so the frontend knows which folder
cache to drop), `DRIVE_PATH_RESTORED`, and `DRIVE_FILE_DELETED` / `DRIVE_FOLDER_DELETED` for permanent deletes.
The handlers in `packages/lib/src/core/drive/sse-handlers.ts` invalidate the affected folder plus the trash
list. Hooks (`packages/lib/src/core/drive/hooks/trash.ts`) are `useListTrash`, `useRestorePath`,
`usePermanentlyDelete` and `useEmptyTrash`, all keyed under `driveKeys.trashList` and invalidating it on
success through the same `invalidateTrash()` the SSE handlers use.

## Path-Based (`local`) Storage

The only backend needing filesystem work: `local-key` and `s3` address files by UUID keys that never collide,
so for them only DB columns change. `local` uses hierarchical paths (`data/projects/report.pdf`), so a trashed
file and a new file of the same name would resolve to the same disk path. Each such mount gets a
`data/.trash/` directory at `mount.init()`, following the
[freedesktop.org Trash spec](https://specifications.freedesktop.org/trash-spec/latest/) idea of a flat
directory keyed by unique ID:

- **File**: rename to `.trash/{pathId}.{ext}` and set `file` to that key.
- **Folder**: rename to `.trash/{pathId}/` and set the folder's `file`. Descendants keep their `file` values —
  `resolveStoragePath()` resolves through the renamed parent.
- **Restore**: rename back to the target location and set `file = name`.

## Auto-Purge

`ServerSettings.quotas.trashRetentionDays` (default 30, `apps/api/src/lib/config/server-settings.ts`). Purge
runs from `mount.init()` only — expired items are cleaned when a Home comes up, through
`permanentlyDeleteFromTrash()` like any other permanent delete.

## Frontend

The trash view is `apps/drive/src/routes/_auth.trash.tsx`. It reuses the shared `DriveList` +
`DriveViewControls`, so trash behaves like any other folder, swapping the date column for "Trashed" and
supplying its own context-menu items (Restore, Delete permanently, both multi-select) plus an "Empty trash"
toolbar button. The sidebar "Trash" item and count badge live in
`packages/ui/src/components/layout/sidebar/app-sidebar.tsx`, fed by `useListTrash`.

## Limits

- **Shared access is fully revoked on trash.** Collaborators lose access at once; restore re-shares them.
- **Labels are preserved** on trashed rows; label views filter with `trashedAt IS NULL`.
- **Concurrent editing during trash**: a brief window between reading the collab list and closing connections
  where a new WebSocket can connect — the same race the old hard-delete flow had.
- Trashing the mount root throws 400, and a collab doc in trash opened over WebSocket is blocked by
  `getActivePath()`.
