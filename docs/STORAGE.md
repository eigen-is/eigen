# Storage & Mount System

Technical documentation for the storage layer, mount system, and file management architecture.

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                            Home                                 │
│  Singleton per user. Manages DB connections and SSE events.     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐   ┌─────────────────┐   ┌───────────────┐  │
│  │      Drive      │   │      Mail       │   │   Contacts    │  │
│  │                 │   │                 │   │               │  │
│  │  Mount          │   │  LocalFilesystem   │   │  LocalFilesystem │  │
│  │  └─LocalKey     │   │  maildb (SQL)   │   │  contacts.db  │  │
│  │    Storage      │   │                 │   │  avatars/     │  │
│  └─────────────────┘   └─────────────────┘   └───────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Components:**

| Component    | Description                                                                                                                                 |
|--------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| **Home**     | Per-user singleton. Manages database connections (one per file), SSE notifications, and app instances. Exposes `LocalFilesystem` as `home.fs`. |
| **Mount**    | Drive storage unit containing metadata DB, file storage backend, temp directory, and thumbnails. Currently single default mount per user.   |
| **Drive**    | Business logic layer on top of Mount. Handles ACL, thumbnails, sharing, and collaborative documents.                                        |
| **Mail**     | Uses `LocalFilesystem` directly for Maildir file storage, plus SQLite for metadata.                                                            |
| **Contacts** | Uses `LocalFilesystem` for avatars, SQLite for contact data.                                                                                   |

**Current Limitations:**
- `Home.getZip()` not implemented

## 2. Storage Layer

Three pluggable storage backends in `lib/storage/`:

| Backend             | Use Case                | Storage Pattern                                   |
|---------------------|-------------------------|---------------------------------------------------|
| **LocalKeyStorage** | Drive mounts (`local-key` / `local-id`) | Flat `data/{uuid}` files                          |
| **LocalStorage**    | Path-based storage (`local` / `local-fullnames`) | Full directory hierarchy with extended fs methods |
| **S3Storage**       | Remote storage (`s3`)  | S3-compatible object storage                      |

All backends implement the `StorageBackend` interface (read, write, delete, exists, size).
`LocalStorage` additionally provides filesystem operations: mkdir, rename, deleteDir.
`LocalFilesystem` is a separate class used by Home.fs for Mail/Contacts with extended filesystem methods (list, listDirs, dirExists, fileExists, dirSize, readdir, stat, etc.).

**StorageBackend Interface**:
- `read(key)` - Get file handle (BunFile or S3File)
- `write(key, data)` - Write data, returns bytes written
- `delete(key)` - Delete file, returns success
- `exists(key)` - Check if file exists
- `size(key)` - Get file size or null
- `getPath?(key)` - Get absolute file path (local storage only)
- `mkdir?(key)` - Create directory (LocalStorage only)
- `rename?(oldKey, newKey)` - Rename file/directory (LocalStorage only)
- `deleteDir?(key)` - Delete directory recursively (LocalStorage only)

## 3. Mount System

A Mount bundles everything needed for Drive file storage:

| Component     | Purpose                                         |
|---------------|-------------------------------------------------|
| `metadata.db` | SQLite database for paths, labels (Drizzle ORM) |
| `data/`       | File storage via `LocalKeyStorage`              |
| `thumbs/`     | Thumbnails (always local, even for S3 mounts)   |
| `tmp/`        | Temp files for collaborative editing            |

**Key types** (`lib/mount/types.ts`):
- `PathEntry` – File/folder metadata (id, name, type, parentId, ownerId, mimeType, size, thumbnail, acl, labels, visibility, details)
- `ACLEntry` – Access control (email, read, write, public)
- `MountConfig` – Mount configuration (id, name, storageType, isDefault, s3Config)

**Thumbnails** (`lib/shared/thumbnails.ts`):
- Supports image formats (jpeg, png, gif, webp, svg, bmp, tiff)
- Generated on upload, stored locally in `thumbs/` as WebP
- Video/PDF thumbnails not currently supported

**Document types**: Supports `folder`, `file`, `doc` (`.eigendoc`), `stickies` (`.eigenstickies`), `slides` (`.eigenslides`), `sheets` (`.eigensheets`), `chat` (`.eigenchat`)

**Path-based storage**: When using `LocalStorage`, documents are stored as directory hierarchies matching their metadata paths.

**Key-based storage**: When using `LocalKeyStorage`/`S3Storage`, files are stored by UUID keys with extension preservation.

**Collaborative documents**: For remote/path-based storage, document databases are synced to temp files during editing and uploaded on change.

## 4. Applications

### 4.1 Drive
Business logic layer (~500 lines) providing:
- **Folder/file operations** with ACL checks
- **Thumbnail** generation and serving
- **Sharing** – cross-user ACL propagation via `shared.db`
- **Collaborative documents** – Y.js with SQLite persistence

**ACL inheritance**: If a path has no ACL, inherits from parent recursively.

### 4.2 Mail
- Uses `LocalFilesystem` for Maildir file structure
- Uses `mail.db` (SQLite) for email metadata
- Indexes on mailbox, date, read status for performance

### 4.3 Contacts  
- Uses `LocalFilesystem` for avatar images (with thumbnail generation)
- Uses SQLite for contact data and labels

### 4.4 Home
- Provides `LocalFilesystem` as `home.fs` for general file operations
- Manages per-user database connections and SSE events
- Coordinates cleanup and resource management

## 5. User Data Layout

```
/data/home/{userId}/
├── mounts/
│   ├── default/
│   │   ├── metadata.db      # Paths + labels (Drizzle ORM)
│   │   ├── data/            # Files stored by UUID (includes collab data.db files)
│   │   ├── thumbs/          # Thumbnails (WebP format)
│   │   └── tmp/             # Temp files for remote sync
│   └── shared.db            # Paths shared with this user
│
├── eigen.mail/
│   ├── mail.db              # Email metadata
│   └── Maildir/             # Email files (Maildir format)
│
└── eigen.contacts/
    ├── contacts.db          # Contact data
    └── avatars/             # Avatar images
```

**Collab documents** (`.eigendoc`, `.eigenstickies`) are folders in metadata.db containing a `data.db` file. The `data.db` is stored via the storage backend using its own pathId as the key.

For S3 mounts: `metadata.db`, `tmp/`, and `thumbs/` stay local; file data goes to S3.

## 6. Database Schemas

### metadata.db (per mount)

| Table             | Purpose                                                                           |
|-------------------|-----------------------------------------------------------------------------------|
| `paths`           | File/folder metadata with parentId FK, acl JSON, visibility, details, indexes on parentId/ownerId/type |
| `labels`          | User-defined labels (name, color)                                                 |
| `paths_to_labels` | Many-to-many relationship                                                         |

### shared.db

| Table          | Purpose                                                                                    |
|----------------|--------------------------------------------------------------------------------------------|
| `shared_paths` | Paths shared with this user from other users (includes `mountId` to identify source mount) |

### mail.db

| Table            | Purpose                                                   |
|------------------|-----------------------------------------------------------|
| `emails`         | Email metadata with indexes on mailbox, date, read status |
| `emailLabels`    | Email labels                                              |
| `emailsToLabels` | Many-to-many relationship                                 |

### Collab document (per doc)

| Table           | Purpose                                                                             |
|-----------------|-------------------------------------------------------------------------------------|
| `doc_updates`   | Incremental Y.js update blobs for real-time collaborative editing                   |
| `doc_snapshots` | Periodic full Y.js state snapshots for fast loading (created every 100 updates)     |

*Note: The system keeps a maximum of 50 revisions in `doc_snapshots` and clears `doc_updates` when a new snapshot is created to manage database size.*
