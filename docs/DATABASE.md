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
| Contacts        | `{home}/eigen.contacts/contacts.db`             | The address book itself: a row's `vcard` BLOB holds the card's bytes and is the truth — the projected columns (`firstName`, `lastName`, `isGroup`, `data`, `uid`, `etag`) and the label junction all rebuild from it. **Plus** the metadata that lives only here: label ids + colors, the server-owned `eigenId`, the one-row `book` (`ctag`, `syncGen`, `ownerSeeded`) and `contact_tombstones` (`apps/api/src/lib/contacts/schema.ts`). `CONTACTS_DB_CONFIG` is at `currentVersion: 5`, whose migration **drops** every v4 table rather than converting it. See [CONTACTS.md](CONTACTS.md) |
| Mail            | `{home}/eigen.mail/mail.db`                     | Email metadata + FTS5 full-text index (`emails_fts`). `MAIL_DB_CONFIG` is at `currentVersion: 5`. See [SEARCH.md](SEARCH.md) |
| Calendar        | `{home}/eigen.calendar/calendar.db`             | The calendar itself: a `resources` row's `ics` BLOB holds one VCALENDAR's bytes and is the truth — the projected columns (`uid`, `etag`, `hasUnindexedRecurrence`) and every `events` row rebuild from it. **Plus** the metadata that lives only here: a calendar's name, color, visibility and default flag, its `shares`, `ctag` and `syncGen`, the `resource_tombstones` and the recipient-side `shared_calendars` (`apps/api/src/lib/calendar/schema.ts`). `CALENDAR_DB_CONFIG` is at `currentVersion: 2`, whose migration carries `calendars` and `shared_calendars` over, **drops** v1's `events` and `event_tombstones`, and creates the blob shape fresh. See [CALENDAR.md](CALENDAR.md) |
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
    synchronous?: 'FULL'; // for a database that holds the truth rather than an index of it
};
```

`snapshot` is what drives file versioning: `snapshotIfDue()` calls `onSnapshot`, which returns `'taken'` or
`'skipped'` (skipped when the container lock is contended, so a close never parks on it). `onClose` receives a
`syncFailed` flag — true when the close-time sync threw, meaning the working copy holds bytes storage does not.

### Lifecycle

1. `open(autoSyncMs)` — opens DB, runs pending migrations, starts sync timer (default 30s)
2. `sync()` — runs `onSync` callback + `PRAGMA wal_checkpoint(PASSIVE)` (non-blocking). Skips if not dirty. The
   dirty watermark is captured before `onSync` runs and advanced only after it returns, so a throwing `onSync` leaves
   the db dirty: the next tick retries, `flush()` propagates the error, and `close()` still tears down and passes
   `syncFailed` to `onClose`
3. `close()` — syncs, `PRAGMA wal_checkpoint(TRUNCATE)`, closes DB. The close is strict: drizzle's statements are finalized as they run (`withAutoFinalize`), so the file is released before the next open of the same path. The `-wal` and `-shm` files are SQLite's: the last connection to close removes them, after an exclusive lock proves no other connection (in any process) still has the file. Never unlink them by hand — a connection in another process keeps writing into the unlinked WAL, and its writes are lost or corrupt the file. `openCold` sets `SQLITE_FCNTL_PERSIST_WAL` to 0, because macOS's system SQLite otherwise keeps both files after the last close. The one exception is a temp with no connection on it that is being thrown away or replaced: its `-wal` and `-shm` go with it (`Mount.cleanupTemp`, which a download or a staged-copy recovery also runs before writing the fresh main file), because SQLite replays a leftover `-wal` into whatever main file next appears at that path. The mount's startup tmp sweep keeps a crash temp's journals along with the temp, since they hold its unsynced tail

### Migrations

Each migration runs in a transaction (`BEGIN`/`COMMIT`/`ROLLBACK`). If a migration fails partway through, all
changes are rolled back and the version is not updated.

**Future-version guard** (`managed-database.ts`, `runMigrations`): before applying anything, `open()` refuses a
DB whose stored `__schema_version` is *higher* than the binary's `config.currentVersion` — it throws
`ApiError(503)` instead of opening it. This protects the rollback case: after a deploy migrates a DB forward,
downgrading to an older server would otherwise silently open (and keep writing to) a schema it doesn't
understand, corrupting it. The operator sees a 503 for that domain until the binary is rolled forward to a
version that knows the on-disk schema; nothing on disk is touched in the meantime.

The same read refuses a stamp that is not an integer (503 `unreadable schema stamp`): only our own migrations write it,
and a non-number compares false against every migration, so without the guard the db would open with nothing migrated
and fail on its first query instead of at open. A missing stamp row cannot go unnoticed either: `INSERT OR IGNORE`
recreates it at 0, every migration re-runs and the first `CREATE TABLE` fails inside its own transaction. Any failure
inside `open()` closes the raw handle before rethrowing, so the same file reopens cleanly once repaired.

### Pragmas

`journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`

A database whose rows are the truth rather than an index of something else asks for one more: `DatabaseConfig.synchronous?: 'FULL'` makes `openCold` run `PRAGMA synchronous = FULL` right after the WAL pragma. It is set per open, never stored in the file, so it holds for every connection that config opens. `CONTACTS_DB_CONFIG` and `CALENDAR_DB_CONFIG` set it — the vCard and VCALENDAR bytes live in their rows, so an acknowledged CardDAV or CalDAV PUT must survive a power loss, and both write at address-book volume. Every other database takes whatever the SQLite build defaults a WAL database to, and only the two that ask are guaranteed FULL. That default is not the same everywhere: bun's bundled SQLite (the Linux builds, so production and CI) stays at FULL, while macOS's system library is compiled with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` and drops to NORMAL on entering WAL. So the option buys nothing in production today and everything on a developer's laptop — and a crash on an index database costs at most the last commits of something that can be rebuilt.

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

### Instance lock

One API process owns a data dir. `index.ts` imports `src/instance-lock.ts` and only then loads the server (`src/server.ts`) with `await import`, whose modules open server databases as they load. The import is dynamic because a static one guarantees no order in the `buildfordocker` bundle: `--splitting` hoists `auth.ts` and its top-level `users3.db` open into a shared chunk that evaluates before the entry's own code. `instance-lock.ts` calls `lockDataDir()` (`src/lib/config/data-lock.ts`), which opens `{server}/instance.lock` (`getServerDataPath`) as a SQLite database, runs `PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE;` and keeps the connection for the life of the process. `IMMEDIATE`, not `EXCLUSIVE`: two processes starting together both read the empty file first, and `BEGIN EXCLUSIVE` then fails them both, while `BEGIN IMMEDIATE` lets exactly one through. A second API on the same data dir gets `SQLITE_BUSY` and exits with code 1, naming the data dir. The lock is a POSIX file lock, so the OS drops it however the holder ends, SIGKILL included, and a `bun --watch` reload takes it again. The open transaction keeps an `instance.lock-journal` beside it, 512 bytes and no pages, which a SIGKILL leaves behind; the next holder rolls it back as a no-op, so it is harmless. Tests that boot `app` in-process never take the lock; `test/backup/process-lifecycle.test.ts` spawns `src/index.ts`, so each child takes it on its own data root. `./eigen backup` and the swap of `./eigen restore` take the same lock through `lockDataDir()` (`src/cli/snapshot.ts`) and refuse while an API holds it, so they only run with Eigen stopped; seeding and migration scripts don't take it.

The lock only reaches as far as the file system carries POSIX locks. A Docker Desktop bind mount does not pass them between a container and the host, so an API in the container and one on the host over the same folder both start.

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
