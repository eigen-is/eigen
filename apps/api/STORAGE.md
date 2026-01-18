# Storage & Mount System

Technical documentation for the storage layer, mount system, and file management architecture.

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [Directory Structure](#2-directory-structure)
3. [Storage Layer](#3-storage-layer)
4. [Thumbnail Handling](#4-thumbnail-handling)
5. [Mount System](#5-mount-system)
6. [Drive Application](#6-drive-application)
7. [Home Class](#7-home-class)
8. [Mail & Contacts](#8-mail--contacts)
9. [User Data Layout](#9-user-data-layout)
10. [Database Schemas](#10-database-schemas)

---

## 1. Architecture Overview

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

**Key Concepts:**
- **Home** – Owns all database connections (singleton per DB file) and provides SSE notifications
- **Mount** – Drive storage unit (metadata DB + storage backend + temp + thumbs)
- **Drive** – Business logic layer with ACL, thumbnails, sharing, and collab documents
- **Mail/Contacts** – Standalone apps using `home.getDatabase()` pattern
- **Storage backends** – Pluggable (`LocalKeyStorage`, `LocalStorage`, `S3Storage`)
- **Thumbnails** – Per-mount `thumbs/` directory (always local, even for S3)

**Current Limitations:**
- Single default mount (architecture supports multiple mounts for future)
- `Home.getZip()` not implemented

---

## 2. Directory Structure

```
lib/
├── storage/                     # Layer 1: Raw storage backends
│   ├── index.ts                 # Re-exports all storage modules
│   ├── types.ts                 # StorageBackend interface, S3Config
│   ├── local-key-storage.ts     # UUID filenames (Drive mounts)
│   ├── local-storage.ts         # Directory hierarchy (Mail, general fs)
│   └── s3-storage.ts            # S3 remote storage
│
├── shared/                      # Shared utilities
│   └── thumbnails.ts            # Thumbnail generation and management
│
├── mount/                       # Layer 2: Mount abstraction
│   ├── index.ts                 # Re-exports mount modules
│   ├── types.ts                 # MountConfig, PathEntry, ACLEntry, MountInfo
│   ├── schema.ts                # Drizzle schema for paths + labels
│   └── mount.ts                 # Mount class (metadata + storage + tmp + thumbs)
│
├── drive/                       # Layer 3: Business logic (~500 lines)
│   ├── drive.ts                 # Uses Mount + shared/thumbnails
│   ├── acl.ts                   # ACL logic extracted
│   ├── schema.ts                # Legacy schema (unused, kept for reference)
│   ├── shared.ts                # Shared database factory
│   ├── sharedDrive.ts           # Shared drive access
│   └── sharedschema.ts          # Schema for shared_paths table
│
├── collab/                      # Collaborative editing
│   ├── collabDocument.ts        # Y.js document management
│   └── schema.ts                # Schema for doc_updates table
│
├── mail/                        # Mail with indexes
│   ├── maildir.ts
│   ├── maildb.ts                # Has MAIL_MIGRATION_SQL with indexes
│   └── schema.ts
│
├── contacts/                    # Contacts
│   ├── contacts.ts
│   └── schema.ts
│
└── home/
    ├── home.ts                  # DB connections + apps + SSE
    └── types.ts                 # HomeInterface
```

---

## 3. Storage Layer

### 3.1 StorageBackend Interface

```typescript
// lib/storage/types.ts
export interface StorageBackend {
  read(fileId: string): BunFile | S3File;
  write(fileId: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number>;
  delete(fileId: string): Promise<boolean>;
  exists(fileId: string): Promise<boolean>;
  size(fileId: string): Promise<number | null>;
}

export type S3Config = {
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
};
```

### 3.2 Implementations

**LocalKeyStorage** - Files stored as `data/{uuid}` (flat structure for Drive mounts)
```typescript
// lib/storage/local-key-storage.ts
export class LocalKeyStorage implements StorageBackend {
  constructor(baseDir: string)  // Creates baseDir/data/
  // Implements all StorageBackend methods
}
```

**LocalStorage** - Full filesystem abstraction (for Mail, Home.fs)
```typescript
// lib/storage/local-storage.ts
export class LocalStorage implements StorageBackend {
  constructor(baseDir: string)
  
  // StorageBackend methods
  read(filePath: string): BunFile
  write(filePath: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number>
  delete(filePath: string): Promise<boolean>
  exists(filePath: string): Promise<boolean>
  size(filePath: string): Promise<number | null>
  
  // Extended filesystem methods
  list(dirPath: string): Promise<string[]>      // List files in directory
  listDirs(dirPath: string): Promise<string[]>  // List subdirectories
  mkdir(dirPath: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  dirExists(dirPath: string): Promise<boolean>
  fileExists(filePath: string): Promise<boolean>
  dirSize(dirPath: string): Promise<number>     // Recursive size calculation
  readdir(dirPath: string, options?): Promise<any[]>
  stat(filePath: string): Promise<Stats>
  unlink(filePath: string): Promise<void>
  file(filePath: string): BunFileWrapper        // Returns wrapper with exists/arrayBuffer/text/json/write
  pathJoin(...paths: string[]): string
  pathBasename(filePath: string): string
}
```

**S3Storage** - Files stored in S3
```typescript
// lib/storage/s3-storage.ts
export class S3Storage implements StorageBackend {
  constructor(config: S3Config)
  // Implements all StorageBackend methods using Bun's S3Client
}
```

---

## 4. Thumbnail Handling

Thumbnails are generated from files and stored locally for fast serving. Each mount has its own `thumbs/` directory (always local, even for S3 mounts):

```
mounts/default/
├── metadata.db
├── tmp/
├── data/       # actual files
└── thumbs/     # thumbnails (always local)
    └── {pathId}.webp
```

### 4.1 Thumbnail API

```typescript
// lib/shared/thumbnails.ts
export type ThumbnailOptions = {
  maxSize?: number;           // Default: 512
  quality?: number;           // Default: 80
  format?: 'webp' | 'jpeg';   // Default: 'webp'
  fit?: 'inside' | 'cover';   // Default: 'inside'
};

export function isThumbnailSupported(mimeType: string): boolean

export async function generateThumbnail(
  source: BunFile | Buffer | string,  // Also accepts file path string
  mimeType: string,
  options?: ThumbnailOptions
): Promise<Buffer | null>

export function getThumbnailPath(
  thumbsDir: string,
  pathId: string,
  format?: 'webp' | 'jpeg'  // Default: 'webp'
): string

export async function saveThumbnail(
  thumbsDir: string,
  pathId: string,
  source: BunFile | Buffer | string,
  mimeType: string,
  options?: ThumbnailOptions
): Promise<string | null>  // Returns "{pathId}.{format}" or null if not supported

export async function deleteThumbnail(thumbsDir: string, pathId: string): Promise<void>

export async function getThumbnail(thumbsDir: string, pathId: string): Promise<Buffer | null>
```

### 4.2 Usage by Apps

| App | Thumbnail Directory | Usage |
|-----|---------------------|-------|
| **Drive** | `mounts/{mountId}/thumbs/` | File previews (images, videos, PDFs) |
| **Contacts** | `eigen.contacts/avatars/` | Contact avatars (ARE thumbnails) |
| **Mail** | None | No thumbnails needed |

### 4.3 Supported Formats

```typescript
const THUMBNAIL_SUPPORTED_MIMES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff'
];
```

> **Note**: Video and PDF thumbnails are not currently supported. The `isThumbnailSupported()` function checks if the mime type starts with `image/`.

### 4.4 S3 Mounts

For S3 mounts, thumbnails are generated from the upload buffer and stored locally in `mounts/{mountId}/thumbs/`. This ensures fast thumbnail serving regardless of storage backend.

---

## 5. Mount System

### 5.1 Types

```typescript
// lib/mount/types.ts
export type MountConfig = {
  id: string;
  name: string;                    // "My Drive", "Work Files"
  storageType: 'local-key' | 's3';
  isDefault: boolean;
  localPath?: string;              // For local: "mounts/default"
  s3Config?: S3Config;             // For S3
  createdAt?: Date;
  updatedAt?: Date;
};

export type PathEntry = {
  id: string;
  name: string;
  type: 'folder' | 'file' | 'doc' | 'stickies';
  parentId: string | null;
  ownerId: string;
  mimeType: string;
  size: number;
  thumbnail: string | null;
  acl: ACLEntry[] | null;
  labels?: string[];               // Optional label IDs
  createdAt: Date;
  updatedAt: Date;
};

export type ACLEntry = {
  email: string;
  read: boolean;
  write: boolean;
  public: boolean;                 // Required, not optional
};

export type MountInfo = {
  id: string;
  name: string;
  storageType: 'local-key' | 's3';
  isDefault: boolean;
  totalSize: number;
  fileCount: number;
};
```

### 5.2 Mount Class

Each mount contains:
- `metadata.db` - SQLite database for file metadata (connection managed by Home)
- `tmp/` - Temp directory for collab operations
- `thumbs/` - Thumbnail directory (always local, even for S3)
- Storage backend - Where files actually live

```typescript
// lib/mount/mount.ts
export class Mount {
  readonly id: string;
  readonly name: string;
  readonly config: MountConfig;
  
  constructor(
    ownerId: string,
    baseDir: string,
    config: MountConfig,
    getDatabase: DatabaseGetter
  )
  
  async init(): Promise<void>
  
  // Directory accessors
  get tmpDir(): string
  get thumbsDir(): string
  get dataDir(): string
  
  // Metadata operations
  async getRootFolder(): Promise<PathEntry | null>
  async getPath(pathId: string): Promise<PathEntry | null>
  async listFolder(parentId: string): Promise<PathEntry[]>
  async createFolder(parentId: string, name: string, type?: 'folder' | 'doc' | 'stickies'): Promise<string>
  async createFile(parentId: string, name: string, mimeType: string, size: number, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<string>
  async updatePath(pathId: string, updates: Partial<Omit<PathEntry, 'id' | 'ownerId' | 'createdAt'>>): Promise<void>
  async deletePath(pathId: string): Promise<void>
  
  // File operations
  async readFile(pathId: string): Promise<ArrayBuffer | null>
  async writeFile(pathId: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number>
  getStorageFile(pathId: string): BunFile
  
  // Temp operations (for collab)
  getTempPath(pathId: string): string
  async downloadToTemp(pathId: string): Promise<string>
  async uploadFromTemp(pathId: string): Promise<void>
  async cleanupTemp(pathId: string): Promise<void>
  
  // Stats
  async getTotalSize(): Promise<number>
  async getFileCount(): Promise<number>
  
  // Query operations
  async getPathsByMimeType(mimeTypePrefix: string): Promise<PathEntry[]>
  async getBreadcrumb(pathId: string): Promise<PathEntry[]>
  
  // Label operations
  async getLabels(): Promise<Label[]>
  async createLabel(name: string, color: string): Promise<string>
  async updateLabel(labelId: string, name: string, color: string): Promise<void>
  async deleteLabel(labelId: string): Promise<void>
  async setPathLabels(pathId: string, labelIds: string[]): Promise<void>
  async getPathLabels(pathId: string): Promise<string[]>
}

export function createDefaultMountConfig(id?: string): MountConfig
```

---

## 6. Drive Application

~500 lines. Adds business logic on top of Mount with ACL checks, thumbnails, and sharing:

```typescript
// lib/drive/drive.ts
export default class Drive {
  constructor(home: HomeInterface)
  async init(): Promise<void>
  
  // Stats
  async size(): Promise<number>
  
  // Folder operations (with ACL checks)
  async getRootFolder(): Promise<PathEntry | null>
  async getPath(pathId: string): Promise<PathEntry | null>
  async getFolderContents(pathId: string): Promise<PathEntry[]>
  async createFolder(parentId: string, folderName: string): Promise<string | undefined>
  async createDoc(parentId: string, docName: string): Promise<string | undefined>
  async createStickies(parentId: string, stickiesName: string): Promise<string | undefined>
  async deleteFolder(pathId: string): Promise<void>
  
  // File operations (with ACL checks + thumbnails)
  async uploadFile(parentId: string, file: File): Promise<string>
  async uploadFiles(parentId: string, files: File[]): Promise<string[]>
  async downloadFile(pathId: string): Promise<ArrayBuffer | null>
  async deleteFile(pathId: string): Promise<void>
  async getThumbnail(fileName: string): Promise<ArrayBuffer | null>
  
  // Path operations
  async movePath(pathId: string, targetParentId: string): Promise<void>
  async renamePath(pathId: string, newName: string): Promise<void>
  async breadCrumb(pathId: string): Promise<PathEntry[]>
  async getMimeTypeContents(mimeType: string): Promise<PathEntry[]>
  
  // ACL
  async updateACL(pathId: string, acl: ACLEntry[] | null): Promise<void>
  getACL(pathId: string): ACLEntry[] | null
  async canRead(pathId: string, user: User): Promise<boolean>
  async canWrite(pathId: string, user: User): Promise<boolean>
  
  // Sharing
  async getSharedPathsWithMe(): Promise<PathEntry[]>
  async getSharedPathsByMe(): Promise<PathEntry[]>
  async receiveACLChange(path: PathEntry, newACL: ACLEntry[] | null): Promise<void>
  
  // Collab documents
  async getCollabDocument(pathId: string): Promise<CollabDocument>
  async closeCollabDocument(pathId: string): Promise<void>
  
  // Database access (for collab)
  async openSQLiteDatabase(parentPathId: string, file: string, onCreate: (db: Database) => Promise<void>): Promise<Database>
  async closeSQLiteDatabase(db: Database): Promise<void>
}

export async function getDrive(user: User): Promise<Drive>
```

### 6.1 ACL Logic

```typescript
// lib/drive/acl.ts
export type PathGetter = (pathId: string) => Promise<PathEntry | null>;

export async function canRead(path: PathEntry, user: User, getPath: PathGetter): Promise<boolean>
export async function canWrite(path: PathEntry, user: User, getPath: PathGetter): Promise<boolean>
export function getEffectiveACL(path: PathEntry, getPath: (pathId: string) => PathEntry | null): ACLEntry[] | null  // Sync version
export function normalizeACL(acl: ACLEntry[] | null): ACLEntry[] | null  // Lowercases emails
```

ACL inheritance: If path has no ACL, inherit from parent recursively.

---

## 7. Home Class

Home manages all database connections (singleton per DB file) and provides apps:

```typescript
// lib/home/home.ts
export class Home implements HomeInterface {
  public user: User;
  public homeDir: string;
  public fs: LocalStorage;           // Filesystem abstraction for home directory
  
  public drive: Drive;               // Drive creates its own Mount internally
  public contacts: Contacts;
  public mail: Maildir;
  
  constructor(user: User)
  
  public async init(): Promise<Home>
  
  // Database connection management (singleton pattern)
  public async getDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>
  public async openSQLiteDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>  // Alias
  public async closeSQLiteDatabase(db: Database): Promise<void>
  
  // SSE notifications (not WebSocket)
  public subscribeSSE(listener: (event: SSEvent) => void): void
  public unsubscribeSSE(listener: (event: SSEvent) => void): void
  public notify(event: SSEvent): void
  
  // Lifecycle
  public touch(): Home                // Resets 5-minute timeout
  public async size(): Promise<{mail: number, contacts: number, drive: number, used: number, max: number}>
  public async getZip(): Promise<...> // Throws "Not implemented"
}

export function getHome(user: User): Promise<Home>  // Singleton factory
```

### 7.1 HomeInterface

```typescript
// lib/home/types.ts
export interface HomeInterface {
  user: User;
  homeDir: string;
  
  getDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;
  openSQLiteDatabase(relativePath: string, onCreate: (db: Database) => Promise<void>): Promise<Database>;
  closeSQLiteDatabase(db: Database): Promise<void>;
  
  subscribeSSE(listener: (event: SSEvent) => void): void;
  unsubscribeSSE(listener: (event: SSEvent) => void): void;
  notify(event: SSEvent): void;
}
```

### 7.2 Database Connection Pattern

```typescript
// Example: How Mount gets its database
class Mount {
  constructor(
    ownerId: string,
    baseDir: string,
    config: MountConfig,
    getDatabase: DatabaseGetter  // Passed from Home
  ) {}
  
  async init() {
    const dbPath = `mounts/${this.config.id}/metadata.db`;
    const rawDb = await this.getDatabase(dbPath, async (db) => {
      db.exec(MOUNT_SCHEMA_SQL);
    });
    this.db = drizzle(rawDb, {schema});
  }
}
```

---

## 8. Mail & Contacts

Both apps are **NOT mounts** - they use `home.getDatabase()` for their SQLite databases:

### 8.1 Mail

Indexes are defined in `maildb.ts` MAIL_MIGRATION_SQL:
```sql
CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_date ON emails(mailbox, date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_read ON emails(mailbox, isRead);
```

### 8.2 Contacts

Uses `home.getDatabase()` pattern for database access.

---

## 9. User Data Layout

```
/data/home/{userId}/
│
├── mounts/                     # Drive mounts
│   ├── default/
│   │   ├── metadata.db        # File metadata (paths, labels)
│   │   ├── tmp/               # Collab temp files
│   │   ├── data/              # Files (uuid names)
│   │   ├── thumbs/            # Thumbnails (always local)
│   │   └── docs/              # Collab document databases
│   │       └── {pathId}/
│   │           └── data.db    # Y.js updates storage
│   └── {mount-id}/            # Additional mounts (future)
│       └── ...
│
├── mounts/shared.db            # Shared paths received from other users
│
├── eigen.mail/                 # Mail
│   ├── mail.db
│   └── Maildir/
│
└── eigen.contacts/             # Contacts
    ├── contacts.db
    └── avatars/
```

For S3 mounts: `metadata.db`, `tmp/`, and `thumbs/` stay local, files go to S3.

---

## 10. Database Schemas

### metadata.db (per mount)
```sql
CREATE TABLE IF NOT EXISTS paths (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  parentId TEXT,
  ownerId TEXT NOT NULL,
  mimeType TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  thumbnail TEXT,
  acl TEXT,
  createdAt INTEGER DEFAULT (unixepoch()),
  updatedAt INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (parentId) REFERENCES paths(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  createdAt INTEGER DEFAULT (unixepoch()),
  updatedAt INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS paths_to_labels (
  pathId TEXT NOT NULL,
  labelId TEXT NOT NULL,
  PRIMARY KEY (pathId, labelId),
  FOREIGN KEY (pathId) REFERENCES paths(id) ON DELETE CASCADE,
  FOREIGN KEY (labelId) REFERENCES labels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_paths_parentId ON paths(parentId);
CREATE INDEX IF NOT EXISTS idx_paths_ownerId ON paths(ownerId);
CREATE INDEX IF NOT EXISTS idx_paths_type ON paths(type);
CREATE INDEX IF NOT EXISTS idx_paths_to_labels_pathId ON paths_to_labels(pathId);
CREATE INDEX IF NOT EXISTS idx_paths_to_labels_labelId ON paths_to_labels(labelId);
```

### shared.db (shared paths from other users)
```sql
CREATE TABLE IF NOT EXISTS shared_paths (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  parentId TEXT,
  size INTEGER DEFAULT 0,
  thumbnail TEXT,
  ownerId TEXT NOT NULL,
  mimeType TEXT NOT NULL,
  acl TEXT,
  createdAt INTEGER DEFAULT (unixepoch()),
  updatedAt INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (parentId) REFERENCES shared_paths(id) ON DELETE CASCADE
);
```

### mail.db
```sql
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  textShort TEXT NOT NULL,
  fromShort TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  date INTEGER NOT NULL,
  isRead INTEGER NOT NULL DEFAULT 0,
  isStarred INTEGER NOT NULL DEFAULT 0,
  isDraft INTEGER NOT NULL DEFAULT 0,
  hasAttachments INTEGER NOT NULL DEFAULT 0,
  mailbox TEXT NOT NULL,
  _isParsed INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER DEFAULT (unixepoch()),
  updatedAt INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_date ON emails(mailbox, date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_read ON emails(mailbox, isRead);
```

### doc data.db (per collab document)
```sql
CREATE TABLE IF NOT EXISTS doc_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  updateData BLOB NOT NULL,
  createdAt INTEGER DEFAULT (unixepoch())
);
```
