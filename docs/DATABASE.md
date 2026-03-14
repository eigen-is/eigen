# Database Architecture

> **TLDR**: SQLite via Drizzle ORM. Each domain has its own `db-config.ts` with schema + versioned migrations.
`ManagedDatabase` handles versioning, WAL mode, auto-sync, and dirty tracking. Databases are singletons per path.
> Server-level DBs in `data/server/`, user-level in `data/home/{userId}/`.

## Database Inventory

| Database       | Path                                   | Purpose                                                       |
|----------------|----------------------------------------|---------------------------------------------------------------|
| Auth           | `{server}/users3.db`                   | User auth (better-auth managed)                               |
| Eigen          | `{server}/eigen.db`                    | Share registry ([SHARE-PROPAGATION.md](SHARE-PROPAGATION.md)) |
| Mount metadata | `{home}/mounts/{id}/metadata.db`       | Drive file/folder structure                                   |
| Shared paths   | `{home}/mounts/shared.db`              | Files shared with this user                                   |
| Contacts       | `{home}/eigen.contacts/contacts.db`    | Contact data                                                  |
| Mail           | `{home}/eigen.mail/mail.db`            | Email metadata                                                |
| Calendar       | `{home}/eigen.calendar/calendar.db`    | Calendars, events, shared calendars                           |
| Collab docs    | Via storage backend (`{dataDbPathId}`) | Yjs snapshots + updates                                       |
| Chat rooms     | Via storage backend (`{dataDbPathId}`) | Messages + read state                                         |

## ManagedDatabase

**File**: `apps/api/src/lib/core/managed-database.ts`

Core database wrapper providing:

- **Versioned migrations** via `__schema_version` table
- **WAL mode** for concurrent reads
- **Dirty tracking** — marks DB dirty after writes for sync
- **Auto-sync** — periodic sync at configurable interval
- **Sync callbacks** — `onOpen`, `onSync`, `onClose` for remote storage

```typescript
type DatabaseConfig<S> = {
    name: string;
    currentVersion: number;
    schema: S;
    migrations: Migration[];
};
```

### Lifecycle

1. `open(autoSyncMs)` — opens DB, runs pending migrations, starts sync timer
2. `sync()` — runs `onSync` callback + WAL checkpoint
3. `close()` — flushes, closes, cleans up WAL/SHM files

### Pragmas

`journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`

## Domain Config Files

Each domain defines its schema and migrations in `db-config.ts`:

| Config                | File                                     |
|-----------------------|------------------------------------------|
| `MOUNT_DB_CONFIG`     | `apps/api/src/lib/mount/db-config.ts`    |
| `SHARED_DB_CONFIG`    | `apps/api/src/lib/drive/db-config.ts`    |
| `CONTACTS_DB_CONFIG`  | `apps/api/src/lib/contacts/db-config.ts` |
| `MAIL_DB_CONFIG`      | `apps/api/src/lib/mail/db-config.ts`     |
| `COLLAB_DB_CONFIG`    | `apps/api/src/lib/collab/db-config.ts`   |
| `CHAT_ROOM_DB_CONFIG` | `apps/api/src/lib/chat/db-config.ts`     |
| `CALENDAR_DB_CONFIG`  | `apps/api/src/lib/calendar/db-config.ts` |

## Access Patterns

### Local databases (Contacts, Mail, Calendar, Shared)

Opened via `Home.getLocalDatabase(config, path)`. Singletons per path — opened once, reused. No remote sync.

### Mount-based databases (Collab, Chat)

Collab documents and chats are Drive folders containing a `data.db` file. The `data.db`'s `pathId` is used as the
storage key:

```
test.eigendoc/          (pathId: abc123)
└── data.db             (pathId: xyz789, stored via storage backend)
```

For remote storage (S3): `Mount.openDatabase()` downloads to temp, syncs periodically, uploads on close.

### Singleton pattern

Both `Home` and `Mount` use `createAsyncSingleton()` (`apps/api/src/utils/singleton.ts`) to ensure each database opens
only once.

## Schema Tables

See [STORAGE.md](STORAGE.md) for mount metadata/shared schemas. See [CHAT.md](CHAT.md), [CALENDAR.md](CALENDAR.md) for
domain-specific schemas.
