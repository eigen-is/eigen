# Storage & Mount System

> **TLDR**: Home is the per-user singleton managing DB connections + domain services. Drive uses Mounts with pluggable
> storage backends (LocalKeyStorage, LocalStorage, S3). Mail/Contacts use LocalFilesystem directly. Data lives in
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
Lazy-initializes services via `init()`. Auto-destructs after 5min inactivity via `touch()` — awaits graceful
shutdown before removing from factory cache.

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
| `LocalKeyStorage` | `local-key-storage.ts` | Drive mounts (`local-key`)     | Flat `data/{uuid}.ext`   |
| `LocalStorage`    | `local-storage.ts`     | Drive mounts (`local`)         | Full directory hierarchy |
| `S3Storage`       | `s3-storage.ts`        | Remote storage (`s3`)          | S3-compatible objects    |

**Path safety**: All local backends validate resolved paths against traversal (`..`). `S3Storage` validates key
segments to prevent escaping the configured prefix.

**`StorageFile` type** (`types.ts`): `BunFile | S3File` — a lazy file reference. `read()` returns a `StorageFile`
without reading data into memory. Callers stream or buffer as needed (e.g., `file.arrayBuffer()`,
`new Response(file)`). This keeps large file serving zero-copy on local storage.

**`StorageBackend` interface** (`types.ts`):

| Method      | Returns             | Notes                                        |
|-------------|---------------------|----------------------------------------------|
| `read`      | `StorageFile`       | Lazy reference (BunFile or S3File)           |
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
| `thumbs/`        | Thumbnails (always local, WebP/JPEG)            |
| `tmp/`           | Temp files for remote sync + interrupted uploads |
| `tmp/previews/`  | Cached file previews (cleaned after 7 days)      |

**Document types**: `folder`, `file`, `doc`, `stickies`, `slides`, `sheets`, `chat`

**Thumbnails** (`apps/api/src/lib/shared/thumbnails.ts`): Generated on upload for image formats via sharp.
Supports JPEG, PNG, WebP, GIF, TIFF, HEIC (via heic-convert fallback), and exiftool embedded preview extraction.
Stored as WebP (default) or JPEG.

## User Data Layout

```
data/home/{userId}/
├── settings.json
├── mounts/
│   ├── default/
│   │   ├── metadata.db
│   │   ├── data/
│   │   ├── thumbs/
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
- `StorageBackend` — interface implemented by all three storage backends

See: [DATABASE.md](DATABASE.md) for schema details, [ACL.md](ACL.md) for permissions
