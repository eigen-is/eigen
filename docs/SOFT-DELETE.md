# Soft Delete and Trash

> **TLDR:** A delete moves a Drive item to trash instead of erasing it. Two columns on `paths` hold the state, and the item is re-parented to the mount root. The code is `apps/api/src/lib/mount/trash.ts` (rows and bytes) and `apps/api/src/lib/drive/trash.ts` (collab close, sharing, SSE, history). Four things are not obvious. Only `local` storage moves bytes, into `data/.trash/`. Trash revokes every share, and restore brings them back without a new email. Trash is the drive owner's alone. Expired trash is purged only when a mount opens, which is when its Home loads, and trashed bytes count toward the quota until then.

Everything in Drive goes to the same trash: a plain file, a folder, or an Eigen document such as a doc or a chat room, which is a container folder. A delete in the Drive app and a WebDAV `DELETE` both trash, and the owner restores or erases from Drive's Trash view. Each item is a row in its mount's `paths` table. A mount is one drive of a Home, with its own `metadata.db` and one storage backend ([STORAGE.md § A mount is a paths table](STORAGE.md#a-mount-is-a-paths-table-over-one-of-three-backends)).

The one idea is that trash is a state of the row, not a copy. A trashed row stays in its mount, every lookup skips it, and restore clears the state. Around that change, trash reaches the shared pieces an item touches. It closes the collab documents under the item ([COLLAB.md](COLLAB.md)), updates its sharing ([ACL.md](ACL.md)), tells the open apps over SSE, and records history for the item's watchers ([FILE-HISTORY.md](FILE-HISTORY.md)).

## Two columns mark trash, and the item moves to the root

`trashedAt` is the time an item went to trash, `NULL` while it is live. `trashedFrom` holds its original parent, so restore knows where to put it back. `trashedFrom` also marks the trash root: set means the user trashed this item directly, and it is what the trash view lists. The descendants of a trashed folder get `trashedAt` but keep `trashedFrom` empty, since they are trashed through their parent. `DrivePath` carries `trashedAt`. `trashedFrom` stays on the server.

The item is re-parented to the mount root, so its row no longer names the folder it left. That is why `DRIVE_PATH_TRASHED` carries `oldParentId`: the client needs it to drop the right folder from its cache.

## Trashed rows drop out of lookups, not out of `getPath`

Listings, name lookups, shared views and mime queries add `trashedAt IS NULL`, and the unique name index covers untrashed rows only. So a trashed item disappears everywhere and its name is free again. Content access (download, embed, copy, watch, a collab socket) goes through `Mount.getActivePath`, which answers 404 "File is in trash".

`getPath` still returns a trashed row, because restore and breadcrumbs need it. `getTotalSize` counts it, so trash counts toward the quota. The recursive walks (collab close, sharing, descendant collection) use `listFolderAll`, which includes trashed children.

## Only `local` moves bytes into `.trash/`

`local-key` and `s3` address bytes by id, so a trash only changes columns ([STORAGE.md](STORAGE.md#a-mount-is-a-paths-table-over-one-of-three-backends)). On `local` a key is the name path, so a trashed file and a new file of the same name would share one path on disk. A `local` mount therefore keeps a flat `data/.trash/` keyed by id, after the idea of the [freedesktop.org Trash spec](https://specifications.freedesktop.org/trash-spec/latest/):

- A file is renamed to `.trash/{pathId}.{ext}`, and its `file` column follows.
- A folder is renamed to `.trash/{pathId}`. Its descendants keep their `file` values and resolve through the renamed folder.
- Restore renames it back and sets `file` to the restored name.

Any case or compatibility variant of `.trash` is a reserved name on every mount, so no user item can alias the directory. Both renames take the tree lock exclusively ([STORAGE.md](STORAGE.md#on-local-a-key-is-a-name-path-so-renames-lock-the-whole-tree)).

## Trash closes what is open under the item first

Before any column changes, `Drive.deletePath` closes every collab document under the item and `Mount.trashPath` flushes and closes every cached database. A still-open database would otherwise keep syncing its `data.db` to the old key: a folder rebuilt outside `.trash/` on `local`, a revived object on `s3`. A collab socket that opens between the collab close and the trash write still gets the document, because `getActivePath` passes until `trashedAt` is set. So the trash closes the collab documents under the item a second time once the row is trashed, which ends any session opened in that window.

## Trash revokes every share, and restore re-shares without an email

The `acl` column survives trashing. Trash calls `propagateSharedPathChange(path, acl, null)` for the item and every descendant with an ACL: collaborators lose access at once and their `shared.db` rows go, but the owner's `acl` stays. Restore calls it with `(acl, acl)`. The added set is then empty, so collaborators get their access back without a second invite email. Permanent delete skips the call, since trash already revoked everything.

## Restore goes back to the original folder when it still can

The item returns to `trashedFrom` if that folder exists and is not trashed itself, else to the mount root. A name conflict there, or a reserved name, gets a ` (n)` suffix. The name is checked again under the lock, because on `local` a storage rename would replace a file a create put there in the meantime. A descendant with its own `trashedFrom` stays in trash, since the user trashed it separately.

## Permanent delete takes the separately trashed descendants with it

A folder's permanent delete first removes every trash root whose `trashedFrom` lies inside the folder. Those items hang under the mount root, and once the folder is gone they could never be restored to it. The delete itself is `Mount.deletePath`: rows first, then storage ([STORAGE.md](STORAGE.md)).

## Only the drive owner sees and manages trash

`SharedDrive` lets the effective owner alone (`isEffectiveOwnerSync`: the owner, or a member of the owning team) list, restore, permanently delete and empty. `listTrash` has its own check, so a collaborator cannot enumerate what the owner deleted. Trashing needs write access. A path shared directly with the caller is left instead of trashed ([ACL.md](ACL.md)).

`Drive.emptyTrash` loops `permanentlyDelete` per item, so every item gets the same sharing, SSE and history handling. Trashing the mount root is a 400.

## Expired trash is purged only when a Home loads

`Mount.init` purges trash roots older than `quotas.trashRetentionDays` (30 by default, `apps/api/src/lib/config/server-settings.ts`). A Home opens its mounts when it loads, so that is the only time the purge runs. A disabled mount never opens, and neither does a mount whose Home nobody loads, so both keep their trash past the window. A value of 0 turns the purge off, but the settings route accepts only 1 and up ([ROADMAP.md](ROADMAP.md)). The purge calls `Mount.permanentlyDeleteFromTrash` directly, so it sends no SSE and notifies no watcher.

History and watcher notifications for trash, restore and permanent delete are in [FILE-HISTORY.md](FILE-HISTORY.md#chain-rewriting-mutations-record-their-own-events).

## See also

- [STORAGE.md](STORAGE.md): mounts, backends and locks
- [ACL.md](ACL.md): propagation and leaving a share
- [QUOTA.md](QUOTA.md): the size a mount counts
