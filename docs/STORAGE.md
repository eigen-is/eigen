# Storage & Mount System

> **TLDR**: Home is the per-user singleton managing DB connections + domain services. Drive uses Mounts with pluggable
> storage backends (LocalKeyStorage, LocalStorage, S3). Mail/Contacts use LocalFilesystem directly. Data lives in
`data/home/{userId}/`, teams in `data/team/{teamId}/`.

## Architecture

```
Home (per-user singleton)
├── Drive → Mount(s) → StorageBackend + metadata.db
├── Mail → LocalFilesystem + mail.db
├── Contacts → LocalFilesystem + contacts.db
└── Calendar → calendar.db
```

**Home** (`apps/api/src/lib/home/home.ts`): Manages DB connections, SSE notifications, domain class lifecycle.
Lazy-initializes services via `init()`. Auto-destructs after 5min inactivity via `touch()` — awaits graceful
shutdown before removing from factory cache.

**Subclasses**: `UserHome` (full services), `TeamHome` (Drive + Calendar only), `OrgHome` (minimal).

**Lifecycle** (`apps/api/src/lib/home/get-home.ts`):

- `getHome(ownerId)` — lazily constructs and caches Home instances as async singletons
- `evictHome(ownerId)` — explicitly shuts down a cached Home and removes it (used for user deletion)
- `shutdown()` — public method to gracefully close all databases and clear the inactivity timer

## Storage Backends

All in `apps/api/src/lib/storage/`:

| Backend           | File                   | Use Case                       | Pattern                  |
|-------------------|------------------------|--------------------------------|--------------------------|
| `LocalKeyStorage` | `local-key-storage.ts` | Drive mounts (local-id)        | Flat `data/{uuid}.ext`   |
| `LocalStorage`    | `local-storage.ts`     | Drive mounts (local-fullnames) | Full directory hierarchy |
| `S3Storage`       | `s3-storage.ts`        | Remote storage                 | S3-compatible objects    |

**Path safety**: All local backends validate paths against traversal (`..`). `S3Storage` also validates keys
to prevent escaping the configured prefix.

**Interface** (`types.ts`): `read`, `write`, `delete`, `exists`, `size`. LocalStorage adds `mkdir`, `rename`,
`deleteDir`.

**LocalFilesystem** (`apps/api/src/lib/core/local-filesystem.ts`): Separate class for Mail/Contacts with extended fs
methods (list, listDirs, stat, etc). Exposed as `home.fs`.

## Mount System

A Mount bundles Drive file storage (`apps/api/src/lib/mount/mount.ts`):

| Component     | Purpose                         |
|---------------|---------------------------------|
| `metadata.db` | Paths, labels (Drizzle ORM)     |
| `data/`       | File storage via StorageBackend |
| `thumbs/`     | Thumbnails (always local, WebP) |
| `tmp/`        | Temp files for remote sync      |

**Document types**: `folder`, `file`, `doc`, `stickies`, `slides`, `sheets`, `chat`

**Thumbnails** (`apps/api/src/lib/shared/thumbnails.ts`): Generated on upload for image formats, stored as WebP.

## User Data Layout

```
data/home/{userId}/
├── mounts/
│   ├── default/
│   │   ├── metadata.db
│   │   ├── data/
│   │   ├── thumbs/
│   │   └── tmp/
│   └── shared.db
├── eigen.mail/
│   ├── mail.db
│   └── Maildir/
├── eigen.contacts/
│   ├── contacts.db
│   └── avatars/
└── eigen.calendar/
    └── calendar.db
```

Team data: `data/team/{teamId}/` (same structure, Drive + Calendar only).

## Key Types

- `PathEntry` — file/folder metadata (id, name, type, parentId, acl, visibility, hash, etc.)
- `ACLEntry` — access control (`{id, read, write}`)
- `MountConfig` — mount settings (id, name, storageType, s3Config)

See: [DATABASE.md](DATABASE.md) for schema details, [ACL.md](ACL.md) for permissions
