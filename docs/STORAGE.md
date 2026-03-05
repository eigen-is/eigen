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
| **LocalKeyStorage** | Drive mounts            | Flat `data/{uuid}` files                          |
| **LocalFilesystem**    | Mail, Contacts, Home.fs | Full directory hierarchy with extended fs methods |
| **S3Storage**       | Remote storage (ready)  | S3-compatible object storage                      |

All backends implement the `StorageBackend` interface (read, write, delete, exists, size).
`LocalFilesystem` additionally provides filesystem operations: list, mkdir, rename, stat, etc.

## 3. Mount System

A Mount bundles everything needed for Drive file storage:

| Component     | Purpose                                         |
|---------------|-------------------------------------------------|
| `metadata.db` | SQLite database for paths, labels (Drizzle ORM) |
| `data/`       | File storage via `LocalKeyStorage`              |
| `thumbs/`     | Thumbnails (always local, even for S3 mounts)   |
| `tmp/`        | Temp files for collaborative editing            |

**Key types** (`lib/mount/types.ts`):
- `PathEntry` – File/folder metadata (id, name, type, parentId, ownerId, mimeType, size, thumbnail, acl, labels)
- `ACLEntry` – Access control (email, read, write, public)
- `MountConfig` – Mount configuration (id, name, storageType, isDefault)

**Thumbnails** (`lib/shared/thumbnails.ts`):
- Supports image formats (jpeg, png, gif, webp, svg, bmp, tiff)
- Generated on upload, stored locally in `thumbs/` as WebP
- Video/PDF thumbnails not currently supported

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
- Uses `maildb` (SQLite) for email metadata
- Indexes on mailbox, date, read status for performance

### 4.3 Contacts
- Uses `LocalFilesystem` for avatar images (with thumbnail generation)
- Uses SQLite for contact data and labels

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
| `paths`           | File/folder metadata with parentId FK, acl JSON, indexes on parentId/ownerId/type |
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

| Table         | Purpose                                     |
|---------------|---------------------------------------------|
| `doc_updates` | Y.js update blobs for collaborative editing |
