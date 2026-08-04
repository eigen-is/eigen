# Storage & Mount System

> **TLDR**: Home is the per-user singleton managing DB connections + domain services. Drive uses Mounts with pluggable
> storage backends (LocalStorage, S3). Mail/Contacts use LocalFilesystem directly. Data lives in
> `data/home/{userId}/`, teams in `data/team/{teamId}/`, orgs in `data/org/{orgId}/`.

## Architecture

```
Home (per-user singleton)
├── Drive → Mount(s) → StorageBackend + metadata.db
├── Mail → LocalFilesystem + mail.db
├── Contacts → LocalFilesystem + contacts.db
├── Calendar → calendar.db
└── Notifications → notifications.db
```

**Home** (`apps/api/src/lib/home/home.ts`): Manages DB connections, SSE broadcasting, domain class lifecycle.
Lazy-initializes services via `init()`. Auto-destructs after inactivity via `touch()` — 5 min for `UserHome`,
30 min for `TeamHome` (`TEAM_HOME_IDLE_MS`, `apps/api/src/lib/home/team-home.ts`: team homes have no SSE
keep-alive pin, so they need the longer window). Awaits graceful shutdown before removing from factory cache.

**Subclasses**: `UserHome` (full services: Drive, Mail, Contacts, Calendar, Notifications),
`TeamHome` (Drive + Calendar), `OrgHome` (minimal — filesystem only).

**Lifecycle** (`apps/api/src/lib/home/get-home.ts`):

- `getHome(ownerId)` — lazily constructs and caches Home instances as async singletons (resolves user/team/org via `parseOwnerId()`)
- `evictHome(ownerId)` — explicitly shuts down a cached Home and removes it (used for user deletion)
- `shutdownAllHomes()` — gracefully shuts down all cached Home instances (used on server exit)
- `shutdown()` — instance method to close all databases and clear the inactivity timer

## Storage Backends

All in `apps/api/src/lib/storage/`:

| Backend           | File                   | Use Case                       | Pattern                  |
|-------------------|------------------------|--------------------------------|--------------------------|
| `LocalStorage`    | `local-storage.ts`     | Drive mounts (`local` + `local-key`) | Directory hierarchy (`local`) or flat `data/{uuid}.ext` (`local-key`) |
| `S3Storage`       | `s3-storage.ts`        | Remote storage (`s3`)          | S3-compatible objects    |

**Path safety**: `LocalStorage` and `LocalFilesystem` validate resolved paths against traversal (`..`) via the
shared `resolveWithinBase` guard (`apps/api/src/lib/core/path-utils.ts`). `S3Storage` validates key segments to
prevent escaping the configured prefix.

**`StorageFile` type** (`types.ts`): `BunFile | S3File` — a lazy file reference. `read()` returns a `StorageFile`
without reading data into memory. Callers stream or buffer as needed (e.g., `file.arrayBuffer()`,
`new Response(file)`). This keeps large file serving zero-copy on local storage.

**`StorageBackend` interface** (`types.ts`):

| Method      | Returns             | Notes                                        |
|-------------|---------------------|----------------------------------------------|
| `read`      | `StorageFile`       | Lazy reference (BunFile or S3File)           |
| `readRange?`| `StorageFile`       | Optional — byte range `[start, end)` for ranged serving |
| `write`     | `Promise<number>`   | Accepts Buffer, Uint8Array, ArrayBuffer, BunFile |
| `delete`    | `Promise<boolean>`  |                                               |
| `exists`    | `Promise<boolean>`  |                                               |
| `size`      | `Promise<number \| null>` |                                         |
| `getPath?`  | `string`            | Local backends only — absolute filesystem path |
| `mkdir?`    | `Promise<void>`     | LocalStorage only                            |
| `rename?`   | `Promise<void>`     | LocalStorage only                            |
| `deleteDir?`| `Promise<boolean>`  | LocalStorage only                            |

**LocalFilesystem** (`apps/api/src/lib/core/local-filesystem.ts`): Separate class for Mail/Contacts with extended fs
methods (list, listDirs, stat, dirSize, watch, etc). Exposed as `home.fs`.

## Mount System

A Mount bundles Drive file storage (`apps/api/src/lib/mount/mount.ts`):

| Component        | Purpose                                         |
|------------------|-------------------------------------------------|
| `metadata.db`    | Paths, labels (Drizzle ORM)                     |
| `data/`          | File storage via StorageBackend                 |
| `thumbs/`        | Thumbnails (always local, WebP)                 |
| `tmp/`           | Temp files for remote sync + interrupted uploads |
| `staging/`       | Frozen `VACUUM INTO` upload payloads, S3 mounts only. Deliberately outside `tmp/` so the stale sweep can't purge an un-acked copy |
| `data/.trash/`   | Soft-deleted files (path-based storage only)     |
| `tmp/previews/`  | Cached file previews (cleaned after 7 days)      |

Eigen containers keep one more directory of their own: `versions/`, inside the container, holding the
file-level snapshots described below. Both collab docs and chats opt into it.

**Document types**: `folder`, `file`, `doc`, `stickies`, `slides`, `sheets`, `chat`

**Thumbnails** (`apps/api/src/lib/shared/thumbnails.ts`): Generated on upload for images **and videos** (video
frame grab), each in a Worker that loads sharp, capped by a semaphore so a large export can't spawn one worker
per file. Supports JPEG, PNG, WebP, GIF, TIFF, HEIC (via heic-convert fallback), and exiftool embedded preview
extraction. Stored as WebP.

## User Data Layout

```
data/home/{userId}/
├── settings.json
├── mounts/
│   ├── default/
│   │   ├── metadata.db
│   │   ├── data/
│   │   ├── thumbs/
│   │   ├── staging/          (S3 mounts only)
│   │   └── tmp/
│   │       └── previews/
│   └── shared.db
├── eigen.mail/
│   ├── mail.db
│   └── Maildir/
├── eigen.contacts/
│   ├── contacts.db
│   └── avatars/
├── eigen.calendar/
│   └── calendar.db
└── eigen.notifications/
    └── notifications.db
```

Team data: `data/team/{teamId}/` — Drive + Calendar only, plus `settings.json` for mount/calendar config.
Org data: `data/org/{orgId}/` — minimal (filesystem only, no domain services).

## Key Types

- `DrivePath` (`packages/lib/src/types/drive.ts`) — file/folder metadata (id, mountId, name, type, parentId,
  ownerId, mimeType, size, thumbnail, acl, visibility, sharingRestricted, details, hash, createdAt, updatedAt)
- `DriveACL` — access control entry (`{id, read, write}`)
- `MountConfig` (`packages/lib/src/types/mount.ts`) — mount settings (id, name, storageType, isDefault, s3Config)
- `StorageFile` (`apps/api/src/lib/storage/types.ts`) — `BunFile | S3File`, lazy file reference returned by `read()`
- `StorageBackend` — interface implemented by both storage backends

## Folder Sizes (lazy cache)

Folder rows cache their recursive size in `paths.size`; `NULL` means "stale". Mutations don't
recompute — they NULL the whole ancestor chain (`invalidateSizesFrom`, or `invalidateAncestorsOf`
for content writes). The next read that hydrates the folder (`toDrivePath`) recomputes the subtree
bottom-up inside one transaction and writes the totals back (`computeAndCacheFolderSize`), reusing
any still-cached descendant totals. Two consequences worth knowing: **GET paths perform writes**
(a listing after a deep invalidation recomputes and caches synchronously — relevant for any future
read-replica idea), and the first listing after a large move/delete pays the recompute; every later
read is a plain column read. Trash-view rows (`trashedFrom IS NOT NULL`) are excluded from parent
totals, but trashed bytes still count toward the quota via `getTotalSize`.

## Soft Delete (Trash)

Delete operations are soft — items are moved to trash instead of being permanently deleted. Two columns on
`paths`: `trashedAt` (timestamp) and `trashedFrom` (original parentId). On trash, items are reparented to
the mount root. Path-based (`local`) storage moves files to `data/.trash/{pathId}.ext`; key-based and S3
need no file movement. Trash counts toward quota. Auto-purge after configurable retention (default 30 days).

See: [SOFT-DELETE.md](SOFT-DELETE.md) for full design.

## File Versioning

File-level snapshots live in `<container>/versions/<iso-ts>.db` (`apps/api/src/lib/versioning/`).
Trigger: opt-in `snapshot` config fires `ManagedDatabase.snapshotIfDue()` from `tick()`/`close()`.
Mechanics in `versioning/snapshot.ts` — plain functions over the mount, `Mount` keeps the facades:
`snapshotContainerDataDb` is self-locked on the container (save/pre-restore paths block on the
lock), while the timer/close paths go through `trySnapshotContainerDataDb` (skip-if-contended, so a
close can never park on a held container lock). `replaceContainerDataDb` overwrites chat `data.db`
bytes in place. Restore orchestration in `versioning/restore.ts`: grab the target into the OS temp
dir, take a pre-restore snapshot, then Yjs surgery (collab docs) vs chat byte-overwrite — no lock
held across steps, nothing staged inside the container. Routes live in the drive router
(`routes/drive.ts`): `/drive/:o/:m/file/:p/versions[/save | /:name/restore]`.

## Copy / Move

Move stays in-mount (`Drive.movePath`). Copy goes anywhere (`apps/api/src/lib/drive/copy-across.ts`):
same owner+mount uses the fast same-storage `Drive.copyPath` → `Mount.copyPath` (recursive,
container-aware); cross-mount/owner uses the recursive bridge `copyPathAcross` (download +
`createFileFromData` per node, `createFolder` typed for containers). Containers copy safely by
design — eigen-doc containers reference internal children by NAME, not pathId, so a byte copy is a
valid independent doc; copy flushes the live `data.db` first and skips the `versions/` snapshot
folder. Route `POST /drive/:o/:m/path/:p/copy` (body `{targetOwnerId, targetMountId, targetParentId,
name?}`) picks fast-path vs bridge, dedups the destination name at the route level (kept out of
`Drive.copyPath` so WebDAV COPY keeps overwrite/409 semantics), and rejects copying/moving a folder
into its own subtree via `Mount.isSelfOrDescendant`. Cross-mount MOVE is deferred — it would change
`ownerId/mountId/pathId`, breaking shares, links, and history.

See: [DATABASE.md](DATABASE.md) for schema details, [ACL.md](ACL.md) for permissions
