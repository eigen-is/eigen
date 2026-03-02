# Database Architecture

This document describes the database architecture for the Eigen API server.

## Overview

The application uses SQLite databases managed through Drizzle ORM. Databases are organized into two categories:

1. **Server-level databases** - Global databases for auth and config
2. **User-level databases** - Per-user databases managed through `Home` and `Mount`

## Database Inventory

| Database | Path | Manager | Purpose |
|----------|------|---------|---------|
| **Auth** | `{server}/users3.db` | `auth.ts` (direct) | User authentication (better-auth) |
| **Config** | `{server}/config.db` | `config.ts` (direct) | System configuration |
| **Mount Metadata** | `{home}/mounts/{id}/metadata.db` | `Mount` | Drive file/folder structure |
| **Shared Paths** | `{home}/mounts/shared.db` | `Home.getLocalDatabase()` | Files shared with user |
| **Contacts** | `{home}/eigen.contacts/contacts.db` | `Home.getLocalDatabase()` | User contacts |
| **Mail** | `{home}/eigen.mail/mail.db` | `Home.getLocalDatabase()` | Email metadata |
| **Collab Docs** | Mount storage backend (key: `{dataDbPathId}`) | `Mount.openDatabase()` | YJS document updates |

## Core Components

### ManagedDatabase (`src/lib/core/managed-database.ts`)

The central class for database management with:

- **Versioned migrations** - Incremental schema changes tracked in `__schema_version` table
- **WAL mode** - SQLite Write-Ahead Logging for safety
- **Dirty tracking** - Mark databases as dirty after writes for sync
- **Auto-sync** - Periodic sync for remote storage (configurable interval)
- **Sync callbacks** - `onOpen`, `onSync`, `onClose` hooks for remote storage

```typescript
type DatabaseConfig<S> = {
    name: string;           // For logging
    currentVersion: number; // Target schema version
    schema: S;              // Drizzle schema
    migrations: Migration[]; // Version-ordered migrations
};

type SyncCallbacks = {
    onOpen?: () => Promise<void>;   // Download from remote
    onSync?: () => Promise<void>;   // Upload to remote
    onClose?: () => Promise<void>;  // Cleanup temp files
};
```

### DatabaseConfig Files

Each domain has a `db-config.ts` defining its schema and migrations:

- `src/lib/collab/db-config.ts` - COLLAB_DB_CONFIG
- `src/lib/contacts/db-config.ts` - CONTACTS_DB_CONFIG
- `src/lib/mail/db-config.ts` - MAIL_DB_CONFIG
- `src/lib/drive/db-config.ts` - SHARED_DB_CONFIG
- `src/lib/mount/db-config.ts` - MOUNT_DB_CONFIG

## Database Access Patterns

### Local-Only Databases (Contacts, Mail, Shared)

Opened via `Home.getLocalDatabase()`:

```typescript
const managedDb = await home.getLocalDatabase(CONTACTS_DB_CONFIG, 'eigen.contacts/contacts.db');
const db = managedDb.db; // Drizzle instance
```

- Databases are singletons per path (opened once, reused)
- No remote sync needed
- Closed automatically on Home destruction

### Mount Metadata Database

The mount metadata database is opened via `ManagedDatabase` using `MOUNT_DB_CONFIG`.

- The file lives at `{home}/mounts/{id}/metadata.db`
- Schema is versioned via `__schema_version` like other user databases

### Mount-Based Databases (Collab Documents)

Eigendocs and Stickies are represented as folders. When a collab document is opened, the system ensures there is a `data.db` file under that folder and uses that file's `pathId` as the storage key for the SQLite database.

```
test.eigendoc/          (pathId: abc123, mimeType: application/eigendoc)
└── data.db             (pathId: xyz789, mimeType: application/x-sqlite3)
```

Key points:

- The database is stored using the `data.db` file's `pathId` (not the folder's)
- For **local-key** mounts: `data.db` bytes are stored on disk under `{home}/mounts/{id}/data/{dataDbPathId}`
- For **s3** mounts: `data.db` bytes are stored in the S3 backend under a key derived from `{dataDbPathId}` (with an optional prefix)

### Storage Type Detection

```typescript
// In Mount class
get isRemote(): boolean {
    return this.config.storageType !== 'local-key';
}
```

For remote-capable storage backends (for example `s3`), `Mount.openDatabase()` uses a local temp file and sync callbacks:
- `onOpen`: Download from remote storage to temp
- `onSync`: Upload temp file to remote storage
- `onClose`: Cleanup temp file

## Singleton Pattern

Both `Home` and `Mount` use the singleton pattern for database management:

```typescript
// Map of path -> singleton factory
private managedDatabases: Map<string, () => Promise<ManagedDatabase<any>>> = new Map();

// Get or create database
if (!this.managedDatabases.has(key)) {
    this.managedDatabases.set(key, createAsyncSingleton(factory));
}
return this.managedDatabases.get(key)!();
```

This ensures:
- Each database is opened only once
- Concurrent access returns the same instance
- Proper cleanup on destruction

## Migration System

Migrations are versioned and run automatically on database open:

```typescript
const CONTACTS_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'contacts',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) => db.exec(`
                CREATE TABLE IF NOT EXISTS contacts (...);
                CREATE TABLE IF NOT EXISTS labels (...);
                CREATE TABLE IF NOT EXISTS contacts_to_labels (...);
            `)
        }
        // Future migrations: version 2, 3, etc.
    ]
};
```

The `__schema_version` table tracks the current version. Only pending migrations run.

## Considerations

### Why Local-Only for Contacts/Mail?

Contacts and Mail are stored locally only (not synced to remote storage) because:
- They are user-specific and don't need cross-device sync via file storage
- Email sync happens through IMAP, not file sync
- Simpler architecture without remote storage complexity

### Why ManagedDatabase Instead of Direct Drizzle?

- **Consistent patterns** - All user databases use the same interface
- **Versioning** - Built-in migration support
- **Remote readiness** - Easy to add remote sync later
- **Dirty tracking** - Know when to sync without diffing

### Storage Key Construction

For mount-based databases, the `pathId` (UUID) from metadata.db is used as the storage key. This provides:
- Stable keys that survive file renames
- Unique keys per document
- Direct mapping to the drive structure

## File Structure

```
src/lib/core/
├── managed-database.ts   # ManagedDatabase class, openLocalDatabase helper
├── constants.ts          # Default labels, paths
└── index.ts              # Exports

src/lib/{domain}/
├── schema.ts             # Drizzle schema definitions
├── db-config.ts          # DatabaseConfig with migrations
└── {domain}.ts           # Business logic using ManagedDatabase
```
