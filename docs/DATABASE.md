# Database Architecture

> **TLDR**: SQLite via Drizzle ORM. Each domain has its own `db-config.ts` with schema + versioned migrations.
> `ManagedDatabase` handles versioning, WAL mode, auto-sync, dirty tracking and snapshots. Databases are
> singletons per path. Server-level DBs in `data/server/`, user-level in `data/home/{userId}/`.

## Database Inventory

| Database        | Path                                            | Purpose                                                  |
|-----------------|-------------------------------------------------|----------------------------------------------------------|
| Auth            | `{server}/users3.db`                            | User auth (better-auth managed)                          |
| Share registry  | `{server}/eigen.db`                             | Share registry ([ACL.md](ACL.md#share-registry))         |
| Notifications   | `{home}/eigen.notifications/notifications.db`   | Per-user notification history                            |
| Mount metadata  | `{home}/mounts/{id}/metadata.db`                | Drive file/folder structure. Also `pending_uploads` (write-behind S3 queue), `file_events` + `path_watchers` (history/watching) and the `paths_fts` name index (`apps/api/src/lib/mount/schema.ts`) |
| Shared paths    | `{home}/mounts/shared.db`                       | Files shared with this user                              |
| Contacts        | `{home}/eigen.contacts/contacts.db`             | Contact data                                             |
| Mail            | `{home}/eigen.mail/mail.db`                     | Email metadata + FTS5 full-text index (`emails_fts`). `MAIL_DB_CONFIG` is at `currentVersion: 4`. See [SEARCH.md](SEARCH.md) |
| Calendar        | `{home}/eigen.calendar/calendar.db`             | Calendars, events, shared calendars                      |
| Collab docs     | Via storage backend (`{dataDbPathId}`)           | Yjs snapshots + updates                                  |
| Chat rooms      | Via storage backend (`{dataDbPathId}`)           | Messages + read state                                    |
| Comment index   | Via storage backend (inside eigendoc containers) | Comment status, mentions per eigendoc                    |

## ManagedDatabase

**File**: `apps/api/src/lib/core/managed-database.ts`

Core database wrapper providing:

- **Versioned migrations** via `__schema_version` table
- **WAL mode** for concurrent reads
- **Dirty tracking** — marks DB dirty after writes for sync
- **Auto-sync** — periodic sync at configurable interval
- **Snapshots** — opt-in file versioning, triggered from the sync tick and from close
- **Sync callbacks** — `onOpen`, `onSync`, `onSnapshot`, `onClose` for remote storage and versioning

```typescript
type DatabaseConfig<S extends SchemaType> = {
    name: string;
    currentVersion: number;
    schema: S;
    migrations: Migration[];
    snapshot?: {
        policy: RetentionPolicy;
        writesPerSnapshot: number; // snapshot once this many writes have accumulated
    };
};
```

`snapshot` is what drives file versioning: `snapshotIfDue()` calls `onSnapshot`, which returns `'taken'` or
`'skipped'` (skipped when the container lock is contended, so a close never parks on it). `onClose` receives a
`syncFailed` flag — true when the close-time sync threw, meaning the working copy holds bytes storage does not.

### Lifecycle

1. `open(autoSyncMs)` — opens DB, runs pending migrations, starts sync timer (default 30s)
2. `sync()` — runs `onSync` callback + `PRAGMA wal_checkpoint(PASSIVE)` (non-blocking). Skips if not dirty
3. `close()` — syncs, `PRAGMA wal_checkpoint(TRUNCATE)`, closes DB, deletes WAL/SHM journal files

### Migrations

Each migration runs in a transaction (`BEGIN`/`COMMIT`/`ROLLBACK`). If a migration fails partway through, all
changes are rolled back and the version is not updated.

### Pragmas

`journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`

## Domain Config Files

Each domain defines its schema and migrations in `db-config.ts`:

| Config                          | File                                                 |
|---------------------------------|------------------------------------------------------|
| `MOUNT_DB_CONFIG`               | `apps/api/src/lib/mount/db-config.ts`                |
| `SHARED_DB_CONFIG`              | `apps/api/src/lib/drive/db-config.ts`                |
| `SHARE_REGISTRY_DB_CONFIG`      | `apps/api/src/lib/share/db-config.ts`                |
| `CONTACTS_DB_CONFIG`            | `apps/api/src/lib/contacts/db-config.ts`             |
| `MAIL_DB_CONFIG`                | `apps/api/src/lib/mail/db-config.ts`                 |
| `COLLAB_DB_CONFIG`              | `apps/api/src/lib/collab/db-config.ts`               |
| `CHAT_ROOM_DB_CONFIG`           | `apps/api/src/lib/chat/db-config.ts`                 |
| `COMMENT_INDEX_DB_CONFIG`       | `apps/api/src/lib/chat/comment-db-config.ts`         |
| `CALENDAR_DB_CONFIG`            | `apps/api/src/lib/calendar/db-config.ts`             |
| `NOTIFICATION_CENTER_DB_CONFIG` | `apps/api/src/lib/notification-center/db-config.ts`  |

## Access Patterns

### Server-level databases (Auth, Share Registry)

Opened once as global singletons. Auth (`users3.db`) is managed directly by better-auth. The share registry
(`eigen.db`) is opened via `openLocalDatabase()` wrapped in `createAsyncSingleton()` in `apps/api/src/lib/share/db.ts`.

### Local databases (Contacts, Mail, Calendar, Shared, Notifications)

Opened via `Home.getLocalDatabase(config, relativePath)`. Singletons per path -- opened once, reused. No remote sync.
The `relativePath` is resolved against the home directory (e.g., `eigen.contacts/contacts.db`).

### Mount-based databases (Collab, Chat, Comment Index)

Collab documents, chats, and comment indices are Drive folders containing database files. The file's `pathId` is used
as the storage key:

```
test.eigendoc/          (pathId: abc123)
├── data.db             (pathId: xyz789, stored via storage backend)
└── comments.db         (pathId: def456, comment index)
```

For remote storage (S3): `Mount.openDatabase()` downloads the object to a mount temp file and works on that
copy. Uploads are **write-behind**: sync and close do not PUT. They stage a frozen `VACUUM INTO` copy in the
mount's `staging/` dir and record a durable `pending_uploads` row in `metadata.db`; a per-mount `UploadQueue`
(`apps/api/src/lib/mount/upload-queue.ts`) drains those rows in the background with retry and backoff, and
clears each row only on ack. A slow or failing backend becomes background lag, never a request hang.
See [SYNC.md](SYNC.md).

### Singleton pattern

Both `Home` and `Mount` use `createAsyncSingleton()` (`apps/api/src/utils/singleton.ts`) to ensure each database opens
only once.

## Schema Tables

See [STORAGE.md](STORAGE.md) for mount metadata/shared schemas. See [CHAT.md](CHAT.md), [CALENDAR.md](CALENDAR.md),
[COMMENTS.md](COMMENTS.md), and [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md) for domain-specific
schemas.
