# Storage & Mount System Refactoring

> **Goal**: Clean up the messy drive/filesystem implementation into a scalable, maintainable architecture that supports multiple storage backends and drive mounts.

> **Status**: FINAL PLAN - Ready for implementation

## Table of Contents
1. [Current Problems](#1-current-problems)
2. [Target Architecture](#2-target-architecture)
3. [New Directory Structure](#3-new-directory-structure)
4. [Storage Layer](#4-storage-layer)
5. [Thumbnail Handling](#5-thumbnail-handling)
6. [Mount System](#6-mount-system)
7. [Drive Application](#7-drive-application)
8. [Home Class](#8-home-class)
9. [User Data Layout](#9-user-data-layout)
10. [Database Schemas](#10-database-schemas)
11. [Implementation Phases](#11-implementation-phases)
12. [Files to Delete](#12-files-to-delete)

## Constraints

- **No data migration** - existing data may be deleted
- **Single default mount** for now, architecture supports multiple mounts for future
- **No API/frontend changes** for multi-mount yet
- **Zip export disabled** for now
- **Database singleton pattern** - Home manages all DB connections (one connection per database)

---

## 1. Current Problems

| Problem | Location | Impact |
|---------|----------|--------|
| Duplicate schemas | `drive/schema.ts` = `filesystem/metadatadbschema.ts` | Confusion |
| Two FileSystem classes | `home/filesystem.ts` vs `filesystem/filesystem.ts` | Unused code |
| Drive.ts is 1000+ lines | `drive/drive.ts` | Hard to maintain |
| No mail indexes | `mail/schema.ts` | Slow queries |
| Unused infrastructure | `filesystem/` directory | Dead code |
| No mount abstraction | Hardcoded paths | Can't support multiple drives |

---

## 2. Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│                         Home                             │
│  (manages all DB connections - singleton pattern)        │
├─────────────────────────────────────────────────────────┤
│  Mount (default)              │  Apps                   │
│  ──────────────               │  ─────                  │
│  • metadata.db                │  • Mail (uses home.fs)  │
│  • data/ (LocalKeyStorage)    │  • Contacts (uses home.fs)│
│  • thumbs/ (always local)     │                         │
│  • tmp/ (collab temp)         │                         │
└─────────────────────────────────────────────────────────┘
```

**Key Principles:**
- **Home** = Owns all database connections (singleton per DB file)
- **Mount** = Drive storage unit (metadata DB + storage backend + temp + thumbs)
- **Mail/Contacts** = Standalone apps, NOT mounts
- **Storage backends** = Pluggable (local-key, local-path, S3)
- **Thumbnails** = Per-mount `thumbs/` directory (always local, even for S3)

---

## 3. New Directory Structure

```
lib/
├── storage/                     # Layer 1: Raw storage backends
│   ├── types.ts                 # StorageBackend interface
│   ├── local-key-storage.ts     # UUID filenames (Drive)
│   ├── local-path-storage.ts    # Directory hierarchy (Mail)
│   └── s3-storage.ts            # S3 remote storage (future)
│
├── shared/                      # Shared utilities
│   └── thumbnails.ts            # generateThumbnail(), saveThumbnail(), deleteThumbnail()
│
├── mount/                       # Layer 2: Mount abstraction
│   ├── types.ts                 # MountConfig, PathEntry
│   ├── schema.ts                # Drizzle schema for paths
│   └── mount.ts                 # Mount class (metadata + storage + tmp + thumbs)
│
├── drive/                       # Layer 3: Business logic (~400 lines)
│   ├── drive.ts                 # Uses Mount + shared/thumbnails
│   ├── acl.ts                   # ACL logic extracted
│   ├── shared-drive.ts          # Shared access (existing)
│   └── collab.ts                # CollabDocument (move from collab/)
│
├── mail/                        # Unchanged structure
│   ├── maildir.ts
│   ├── maildb.ts
│   └── schema.ts                # + ADD INDEXES
│
├── contacts/                    # Unchanged structure
│   ├── contacts.ts
│   └── schema.ts
│
└── home/
    └── home.ts                  # Simplified: DB connections + mount + apps
```

---

## 4. Storage Layer

### 4.1 StorageBackend Interface

```typescript
// lib/storage/types.ts
export interface StorageBackend {
  read(fileId: string): BunFile | S3File;
  write(fileId: string, data: Buffer | ArrayBuffer): Promise<number>;
  delete(fileId: string): Promise<boolean>;
  exists(fileId: string): Promise<boolean>;
  size(fileId: string): Promise<number | null>;
}
```

### 4.2 Implementations

**LocalKeyStorage** - Files stored as `data/{uuid}` (flat)
```typescript
// lib/storage/local-key-storage.ts
export class LocalKeyStorage implements StorageBackend {
  constructor(baseDir: string) // Creates baseDir/data/
}
```

**LocalPathStorage** - Files stored in directory hierarchy (Maildir compat)
```typescript
// lib/storage/local-path-storage.ts
export class LocalPathStorage implements StorageBackend {
  constructor(baseDir: string)
  mkdir(dirPath: string): Promise<void>    // Extra for Mail
  readdir(dirPath: string): Promise<string[]>
}
```

**S3Storage** - Files stored in S3
```typescript
// lib/storage/s3-storage.ts
export class S3Storage implements StorageBackend {
  constructor(config: S3Config)
}

interface S3Config {
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}
```

---

## 5. Thumbnail Handling

### Problem

Thumbnails are generated from files and need to be:
- Fast to serve (locally cached)
- Regeneratable (derived data, not source of truth)
- Working with S3 mounts (download → generate → store locally)

### Solution: Per-Mount Thumbs + Shared Generator

**Each mount has its own `thumbs/` directory** (always local, even for S3 mounts):

```
mounts/default/
├── metadata.db
├── tmp/
├── data/       # actual files
└── thumbs/     # thumbnails (always local)
    └── {pathId}.webp
```

**Shared thumbnail generation utility** that any app can use:

```typescript
// lib/shared/thumbnails.ts
export interface ThumbnailOptions {
  maxSize?: number;    // Default: 256
  quality?: number;    // Default: 80
  format?: 'webp' | 'jpeg';  // Default: 'webp'
}

export async function generateThumbnail(
  source: BunFile | Buffer,
  mimeType: string,
  options?: ThumbnailOptions
): Promise<Buffer | null>

export function getThumbnailPath(thumbsDir: string, id: string): string

export async function saveThumbnail(
  thumbsDir: string,
  id: string,
  source: BunFile | Buffer,
  mimeType: string,
  options?: ThumbnailOptions
): Promise<string | null>  // Returns relative path or null if not supported

export async function deleteThumbnail(thumbsDir: string, id: string): Promise<void>
```

### Usage by Apps

| App | Thumbnail Directory | Usage |
|-----|---------------------|-------|
| **Drive** | `mounts/{mountId}/thumbs/` | File previews (images, videos, PDFs) |
| **Contacts** | `eigen.contacts/avatars/` | Contact avatars (ARE thumbnails) |
| **Mail** | None | No thumbnails needed |

### Supported Formats

```typescript
const THUMBNAIL_SUPPORTED_MIMES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'video/mp4', 'video/webm',
  'application/pdf'
];
```

### For S3 Mounts

When a file is uploaded to an S3 mount:
1. File is uploaded to S3
2. Thumbnail is generated from the upload buffer (before or after)
3. Thumbnail is stored **locally** in `mounts/{mountId}/thumbs/`

This ensures fast thumbnail serving regardless of storage backend.

---

## 6. Mount System

### 6.1 Mount Types

```typescript
// lib/mount/types.ts
interface MountConfig {
  id: string;
  name: string;                    // "My Drive", "Work Files"
  storageType: 'local-key' | 's3';
  isDefault: boolean;
  localPath?: string;              // For local: "mounts/default"
  s3Config?: S3Config;             // For S3
}

interface PathEntry {
  id: string;
  name: string;
  type: 'folder' | 'file' | 'doc' | 'stickies';
  parentId: string | null;
  ownerId: string;
  mimeType: string;
  size: number;
  thumbnail: string | null;
  acl: ACLEntry[] | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ACLEntry {
  email: string;
  read: boolean;
  write: boolean;
  public?: boolean;
}
```

### 6.2 Mount Class

Each mount contains:
- `metadata.db` - SQLite database for file metadata (connection managed by Home)
- `tmp/` - Temp directory for collab operations
- `thumbs/` - Thumbnail directory (always local, even for S3)
- Storage backend - Where files actually live

```typescript
// lib/mount/mount.ts
class Mount {
  readonly id: string;
  readonly name: string;
  
  // Metadata operations
  async getRootFolder(): Promise<PathEntry | null>
  async getPath(pathId: string): Promise<PathEntry | null>
  async listFolder(parentId: string): Promise<PathEntry[]>
  async createFolder(parentId: string, name: string): Promise<string>
  async createFile(parentId: string, name: string, mimeType: string, size: number): Promise<string>
  async updatePath(pathId: string, updates: Partial<PathEntry>): Promise<void>
  async deletePath(pathId: string): Promise<void>
  
  // File operations
  async readFile(pathId: string): Promise<Blob>
  async writeFile(pathId: string, data: Buffer): Promise<number>
  getStorageFile(pathId: string): BunFile | S3File
  
  // Temp operations (for collab)
  getTempPath(pathId: string): string
  async downloadToTemp(pathId: string): Promise<string>
  async uploadFromTemp(pathId: string): Promise<void>
  
  // Stats
  async getTotalSize(): Promise<number>
  async getFileCount(): Promise<number>
}
```

### 6.3 Mount Registry (Future)

> **Note**: For now, we use a single default mount. Mount registry will be added when multi-mount is needed.

When implemented, stored in user's `config.db`:

```typescript
// lib/mount/mount-registry.ts (future)
class MountRegistry {
  async init(): Promise<void>                    // Creates default mount if none
  async getDefaultMount(): Promise<Mount>
  async listMounts(): Promise<MountInfo[]>
  async getMount(mountId: string): Promise<Mount>
}
```

---

## 7. Drive Application

Simplified to ~400 lines. Adds business logic on top of Mount:

```typescript
// lib/drive/drive.ts
class Drive {
  // Mount management
  async listMounts(): Promise<MountInfo[]>
  async getMount(mountId: string): Promise<Mount>
  
  // Folder operations (with ACL checks)
  async getRootFolder(mountId?: string): Promise<PathEntry | null>
  async getFolderContents(mountId: string, folderId: string): Promise<PathEntry[]>
  async createFolder(mountId: string, parentId: string, name: string): Promise<string>
  
  // File operations (with ACL checks + thumbnails)
  async uploadFile(mountId: string, parentId: string, file: File): Promise<string>
  async downloadFile(mountId: string, fileId: string): Promise<Blob | null>
  async deleteFile(mountId: string, fileId: string): Promise<void>
  
  // ACL
  async updateACL(mountId: string, pathId: string, acl: ACLEntry[]): Promise<void>
  
  // Collab documents
  async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument>
  async closeCollabDocument(mountId: string, pathId: string): Promise<void>
}
```

### ACL Logic (Extracted)

```typescript
// lib/drive/acl.ts
export async function canRead(path: PathEntry, user: User, getPath: PathGetter): Promise<boolean>
export async function canWrite(path: PathEntry, user: User, getPath: PathGetter): Promise<boolean>
export function getEffectiveACL(path: PathEntry, getPath: PathGetter): ACLEntry[] | null
```

ACL inheritance: If path has no ACL, inherit from parent recursively.

---

## 8. Home Class

Home manages all database connections (singleton per DB file) and provides apps:

```typescript
// lib/home/home.ts
class Home {
  readonly user: User;
  readonly homeDir: string;
  
  // Database connection management (singleton pattern)
  private databases: Map<string, Database>;
  async getDatabase(path: string, onCreate: (db: Database) => Promise<void>): Promise<Database>
  async closeDatabase(path: string): void
  
  // Apps (initialized via Home)
  readonly mount: Mount;       // Default mount, gets DB via home.getDatabase()
  readonly drive: Drive;       // Uses mount
  readonly mail: Maildir;      // Gets DB via home.getDatabase()
  readonly contacts: Contacts; // Gets DB via home.getDatabase()
  
  async init(): Promise<Home>
  static async get(user: User): Promise<Home>
  
  // Notifications
  subscribe(ws: ServerWebSocket): void
  unsubscribe(ws: ServerWebSocket): void
  notify(event: EigenNotification): void
}
```

### Database Connection Pattern

```typescript
// Example: How Mount gets its database
class Mount {
  constructor(private home: Home, private config: MountConfig) {}
  
  async init() {
    this.db = await this.home.getDatabase(
      `mounts/${this.config.id}/metadata.db`,
      async (db) => { /* create tables */ }
    );
  }
}
```

---

## 9. Mail & Contacts (Minimal Changes)

Both apps are **NOT mounts** - they keep their current structure but use `home.getDatabase()`:

### Mail Changes
- Add indexes for performance:
```sql
CREATE INDEX idx_emails_mailbox ON emails(mailbox);
CREATE INDEX idx_emails_date ON emails(date DESC);
CREATE INDEX idx_emails_mailbox_date ON emails(mailbox, date DESC);
```

### Contacts
- No structural changes needed

---

## 10. User Data Layout

```
/data/home/{userId}/
├── config.db                   # Mount registry + user settings
│
├── mounts/                     # Drive mounts
│   ├── default/
│   │   ├── metadata.db        # File metadata
│   │   ├── tmp/               # Collab temp files
│   │   ├── data/              # Files (uuid names)
│   │   └── thumbs/            # Thumbnails (always local)
│   └── {mount-id}/            # Additional mounts
│       └── ...
│
├── eigen.mail/                 # Mail
│   ├── mail.db
│   └── Maildir/
│
└── eigen.contacts/             # Contacts
    ├── contacts.db
    └── avatars/
```

For S3 mounts: `metadata.db` and `tmp/` stay local, files go to S3.

---

## 11. Database Schemas

### metadata.db (per mount)
```sql
CREATE TABLE paths (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  parentId TEXT,
  ownerId TEXT NOT NULL,
  mimeType TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  thumbnail TEXT,
  acl TEXT,
  createdAt INTEGER,
  updatedAt INTEGER,
  FOREIGN KEY (parentId) REFERENCES paths(id) ON DELETE CASCADE
);

CREATE INDEX idx_paths_parentId ON paths(parentId);
CREATE INDEX idx_paths_ownerId ON paths(ownerId);
CREATE INDEX idx_paths_type ON paths(type);

CREATE TABLE labels (...);
CREATE TABLE paths_to_labels (...);
```

### mail.db
```sql
CREATE TABLE emails (...);  -- existing schema
CREATE INDEX idx_emails_mailbox ON emails(mailbox);
CREATE INDEX idx_emails_date ON emails(date DESC);
CREATE INDEX idx_emails_mailbox_date ON emails(mailbox, date DESC);
CREATE INDEX idx_emails_mailbox_read ON emails(mailbox, isRead);
```

---

## 12. Implementation Phases

| Phase | Task | Est. Time | Files |
|-------|------|-----------|-------|
| 1 | Create storage layer | 1h | `lib/storage/types.ts`, `lib/storage/local-key-storage.ts` |
| 2 | Create shared thumbnails | 1h | `lib/shared/thumbnails.ts` |
| 3 | Create mount types + schema | 30m | `lib/mount/types.ts`, `lib/mount/schema.ts` |
| 4 | Create Mount class | 2-3h | `lib/mount/mount.ts` |
| 5 | Extract ACL logic | 1h | `lib/drive/acl.ts` |
| 6 | Rewrite Drive | 3-4h | `lib/drive/drive.ts` |
| 7 | Update Home | 1h | `lib/home/home.ts` |
| 8 | Add mail indexes | 30m | `lib/mail/schema.ts` |
| 9 | Delete old files + test | 1-2h | See below |

**Total estimated time: ~12 hours**

> **Note**: Multi-mount support (MountRegistry, API changes, frontend) deferred to future phase.

---

## 13. Files to Delete

After refactoring, delete the entire `lib/filesystem/` directory:

```
DELETE: lib/filesystem/           # Entire directory (all files unused/replaced)
  - database.ts
  - filesystem.ts  
  - metadatadb.ts
  - metadatadbschema.ts
  - localstorage.ts
  - pathstorage.ts
  - s3storage.ts
  - storage.ts

DELETE: lib/home/filesystem.ts    # Replaced by Mount + storage layer
```

> **Note**: We're writing fresh storage implementations rather than moving old files.
> The old implementations have inconsistent interfaces and user-coupling we don't want.

---

## Summary

- **Home** = Owns all database connections (singleton pattern)
- **Mount** = Drive storage abstraction (single default for now, multi-mount ready)
- **Thumbnails** = Shared utility + per-mount thumbs/ directory (always local)
- **Mail/Contacts** = Standalone apps (unchanged, just add mail indexes)
- **Storage backends** = Pluggable (local-key for Drive, local-path for Mail)
- **ACL** = Inherited from parent, extracted to `lib/drive/acl.ts`
- **No data migration** - existing data can be deleted
