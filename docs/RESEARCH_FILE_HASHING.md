# Research: Content Hashing for Drive File Metadata

> Adding content hashes to Drive's file metadata for integrity verification, external change detection, and as
> a foundation for future sync/dedup features.

## Verdict

**Phase 1 (hash on upload) is worth doing.** It is ~20 lines of code, zero measurable performance cost at Eigen's
upload limits, and gives us integrity verification, duplicate file detection, and the groundwork for sync. The default
mount type is `local` (path-based with human-readable filenames), making external change detection a real concern rather
than a theoretical one.

**Phase 2 (on-access verification for LocalStorage) is worth doing soon.** Since the default mount uses `LocalStorage`,
users are likely to interact with the filesystem directly. Without detection, Eigen's metadata silently goes stale.

**Dedup infrastructure and Merkle trees are not worth building.** The per-user Home isolation model and cheap self-hosted
storage make the ROI negligible.

## Current State Analysis

### How Drive Stores Files Today

Drive uses a **Mount** system (`apps/api/src/lib/mount/mount.ts`) that pairs a `metadata.db` (SQLite via Drizzle ORM)
with a pluggable storage backend. The metadata schema (`apps/api/src/lib/mount/schema.ts`) tracks:

```
paths table:
  id          TEXT PRIMARY KEY   -- UUID
  file        TEXT NOT NULL ''   -- storage key (UUID.ext for local-key, filename for local)
  name        TEXT NOT NULL      -- display name
  type        TEXT NOT NULL      -- folder | file | doc | stickies | slides | sheets | chat
  parentId    TEXT               -- tree structure (FK to paths.id ON DELETE CASCADE)
  ownerId     TEXT NOT NULL
  mimeType    TEXT NOT NULL
  size        INTEGER DEFAULT 0  -- bytes (set on upload, updated on writeFile)
  thumbnail   TEXT
  acl         TEXT (JSON)        -- DriveACL[] | null
  visibility  TEXT DEFAULT 'private'
  details     TEXT (JSON)        -- originalName, width, height, duration, pageCount, etc.
  createdAt   INTEGER DEFAULT (unixepoch())
  updatedAt   INTEGER DEFAULT (unixepoch())

Indexes: idx_paths_parentId, idx_paths_ownerId, idx_paths_type
Also: labels table, paths_to_labels junction table
Current migration version: 1 (see MOUNT_DB_CONFIG in db-config.ts)
```

There is **no content hash, no checksum, no ETag, nothing linking metadata to actual file contents** beyond the `file`
storage key and the `size` field.

### Storage Backends

| Backend           | Key Strategy              | File Identity   | External Mutation Risk                         |
|-------------------|---------------------------|-----------------|------------------------------------------------|
| `LocalKeyStorage` | Flat `data/{uuid}.ext`    | UUID is the key | Low (opaque names)                             |
| `LocalStorage`    | Full path `data/a/b/c.txt`| Filesystem path | **High** (readable names, user could edit)     |
| `S3Storage`       | S3 prefix + key           | S3 object key   | Low (API-only access)                          |

**`LocalStorage` is the default.** `createDefaultMountConfig()` defaults to `storageType: 'local'`. This means most
Eigen deployments use the backend most vulnerable to external modification.

The `StorageBackend` interface (`apps/api/src/lib/storage/types.ts`) exposes `read()`, `write()`, `delete()`,
`exists()`, `size()`, and optionally `getPath()`, `mkdir()`, `rename()`, `deleteDir()`. Note: there is no `stat()` or
`mtime()` method -- adding on-access verification will require either extending the interface or using `fs.stat()`
directly via `getPath()`.

### What Eigen Tracks About File Content

Today, the only content-related metadata is:
- **`size`** -- set on upload via `buffer.byteLength`, updated in `Mount.writeFile()`. Not rechecked otherwise.
- **`thumbnail`** -- generated on upload for images via `saveThumbnail()`. Not regenerated if the file changes.
- **`details`** -- image dimensions, original name. Static after upload.
- **`updatedAt`** -- updated on any `updatePath()` call. Tracks metadata changes, not content changes.

There is **no mechanism to detect** that a file's actual bytes have changed since the last known state.

### Eigen File Types (Container Types)

Eigen's custom document types (.eigendoc, .eigenstickies, .eigenslides, .eigensheets, .eigenchat) are **directories**
containing a `data.db` SQLite database with Yjs state. These are fundamentally different from regular files:
- Their "content" is a database that changes through collaborative editing via Yjs updates
- The `data.db` is managed by `ManagedDatabase` with WAL mode, busy timeout, and sync callbacks
- For remote/path-based storage, the database is downloaded to a temp file on open and uploaded back on sync
  (see `Mount.openDatabase()`)
- Hashing a live SQLite database is unreliable (WAL journal, in-flight transactions, checkpoint timing)
- These should be excluded from content hashing entirely

### Upload Limits

Two upload endpoints exist in the drive router (`apps/api/src/routes/drive.ts`):
- Single file: `t.File({maxSize: 35 * 1024 * 1024})` -- 35MB max
- Multi-file: `t.Files({maxSize: 10 * 1024 * 1024})` -- 10MB per file max

These limits bound the worst-case hashing cost.

## Use Cases

### Worth Building

**1. External Change Detection for `LocalStorage` Mounts**

This is the strongest motivation. Since `LocalStorage` is the default, files live in a regular directory tree with
human-readable names. External tools can modify them:

- User edits a `.txt` file in their text editor
- Sync tools (Dropbox, Syncthing, rsync) write new versions into the mount's `data/` directory
- A script batch-processes images, replacing originals
- User manually reorganizes files at the OS level

Without content hashes, Eigen cannot know that the file it displays metadata for has changed. The `size` field may be
stale, the thumbnail may be wrong, the `updatedAt` timestamp is meaningless.

With content hashes, Eigen can detect mismatches on access and trigger reconciliation: update size, regenerate
thumbnails, notify the user via SSE.

**2. Upload Integrity Verification**

After writing a file to storage (especially S3), a content hash lets us verify the write was successful. This catches
truncated uploads, network corruption, and storage backend bugs. Cheap to implement since the data is already in memory
at upload time.

**3. Duplicate File Finder**

With hashes stored and indexed, a "find duplicate files" user-facing feature is a trivial query:

```sql
SELECT contentHash, GROUP_CONCAT(name), COUNT(*) as copies, SUM(size) as wastedBytes
FROM paths
WHERE contentHash IS NOT NULL AND type = 'file'
GROUP BY contentHash
HAVING COUNT(*) > 1;
```

This is a real user feature that costs nothing once hashes exist. It does not require dedup infrastructure -- just a
read-only query and a UI to display results with options to delete duplicates.

**4. Foundation for Mobile/Offline Sync**

If Eigen ever supports multi-device sync or offline editing, content hashes are essential for detecting conflicts. Two
devices editing the same file while offline need to know whether their versions diverge. Git, Dropbox, and Syncthing all
rely on content hashes for this. Building the hash infrastructure now means sync can be layered on without a
data migration later.

### Not Worth Building Now

**Storage Deduplication** -- Per-user Home isolation makes cross-user dedup architecturally awkward. Within-user dedup
saves little storage and adds reference counting complexity to every delete. `LocalStorage` is incompatible with
content-addressed storage entirely. Storage is cheap for self-hosted deployments.

**Email Attachment Deduplication** -- Email attachments are stored inline in `.eml` files (Maildir format in
`eigen.mail/`). The mail parser (`mail-parser/stream-hash.js`) already computes MD5 checksums per attachment, but
attachments are not stored separately -- they live inside the raw email file. Deduplicating attachments would require
extracting them into a shared content store and rewriting the email rendering pipeline. The complexity far exceeds the
storage savings. Not worth it.

**Merkle Trees for Directory Integrity** -- Write amplification on every file change, and Eigen's mutable tree does not
benefit from subtree change detection. Skip.

**Client-Side Hash Verification** -- Browser File API hashing is slow for large files. Size + lastModified is sufficient
as a fast heuristic for skipping no-op re-uploads.

## Hash Algorithm

### Candidates

| Algorithm   | Output   | Bun CryptoHasher | Measured Speed (Bun) | Crypto-Strength |
|-------------|----------|------------------|----------------------|-----------------|
| SHA-256     | 256-bit  | Built-in         | ~2.3 GB/s            | Yes             |
| BLAKE2b-256 | 256-bit  | Built-in         | ~0.9 GB/s            | Yes             |
| BLAKE3      | 256-bit  | **Not supported** | N/A                 | Yes             |
| SHA-512     | 512-bit  | Built-in         | Not benchmarked      | Yes             |
| MD5         | 128-bit  | Built-in         | Not benchmarked      | Broken          |

### Recommendation: SHA-256

- **Built into Bun** via `Bun.CryptoHasher("sha256")` -- zero dependencies
- **Fast in Bun** -- benchmarked at ~2.3 GB/s on Apple Silicon. At Eigen's 35MB upload limit, worst case is ~15ms.
  This is faster than the often-cited ~0.5-1 GB/s because Bun uses hardware-accelerated SHA-256 (ARM SHA extensions)
- **BLAKE3 is not available** -- `Bun.CryptoHasher("blake3")` throws "Unsupported algorithm". Would require the
  `blake3` npm package (native addon). Not worth the dependency since SHA-256 is already fast enough.
- **BLAKE2b-256 is slower** -- benchmarked at ~0.9 GB/s in Bun, roughly half the speed of SHA-256. Despite being
  designed to be fast, SHA-256 wins on Bun because of hardware acceleration.
- **Universal standard** -- S3 ETags (non-multipart), HTTP `Content-Digest`, SRI all use SHA-256. Interoperability is
  free.
- **Already used in the codebase** -- the mail parser uses `crypto.createHash('md5')` for attachment checksums
  (`stream-hash.js`). Calendar uses `createHash('md5')` for event ETags (`calendar.ts:45`). SHA-256 is a natural
  upgrade.

## Proposed Schema Changes

### Migration v2: Add `contentHash` Column

In `apps/api/src/lib/mount/db-config.ts`, add migration version 2:

```typescript
{
    version: 2,
    up: (db) => db.exec(`
        ALTER TABLE paths ADD COLUMN contentHash TEXT;
        ALTER TABLE paths ADD COLUMN contentHashedAt INTEGER;
        CREATE INDEX idx_paths_contentHash ON paths(contentHash);
    `)
}
```

In `apps/api/src/lib/mount/schema.ts`:

```typescript
export const paths = sqliteTable('paths', {
    // ... existing columns ...
    contentHash: text('contentHash'),
    contentHashedAt: integer('contentHashedAt', {mode: 'timestamp'}),
});
```

Design decisions:
- **Nullable** -- folders, collab documents, and not-yet-hashed files have `null`
- **`contentHashedAt`** -- lets us detect stale hashes (compare with filesystem mtime for LocalStorage)
- **Hex string** -- 64 characters for SHA-256. Human-readable, grep-able, portable. Negligible overhead vs raw bytes in
  SQLite.
- **Index on `contentHash`** -- enables duplicate file queries and hash-based lookups

### Shared Paths Schema Update

In `apps/api/src/lib/drive/sharedschema.ts`, add the same column to `sharedPaths`:

```typescript
export const sharedPaths = sqliteTable('shared_paths', {
    // ... existing columns ...
    contentHash: text('contentHash'),
});
```

The shared paths db-config (`SHARED_DB_CONFIG` in `apps/api/src/lib/drive/db-config.ts`) needs its own migration v2.

### DrivePath Type Update

In `packages/lib/src/types/drive.ts`:

```typescript
export type DrivePath = {
    // ... existing fields ...
    contentHash: string | null;
}
```

Note: `contentHashedAt` is internal metadata -- no need to expose it in the client-facing type.

### Mount.toDrivePath() Update

The `toDrivePath()` private method in `mount.ts` (line 638) maps DB rows to `DrivePath`. It must include the new field:

```typescript
private toDrivePath(row: typeof paths.$inferSelect): DrivePath {
    return {
        // ... existing fields ...
        contentHash: row.contentHash ?? null,
    };
}
```

### Drive.receiveACLChange() Update

The `receiveACLChange()` method in `drive.ts` propagates metadata to `sharedPaths`. The insert and update calls must
include `contentHash`.

## Hashing Strategy

### When to Hash

**On upload (synchronous, in Mount.createFile()):**

The file data is already in memory. At Eigen's upload limits (35MB single, 10MB multi), hashing adds at most ~15ms.
Fold the hash computation into `createFile()` so it is part of the initial INSERT:

```typescript
async createFile(
    parentId: string,
    name: string,
    mimeType: string,
    size: number,
    data: Buffer | Uint8Array | ArrayBuffer | BunFile | undefined
): Promise<string> {
    // ... existing validation and key computation ...

    let contentHash: string | null = null;
    if (data !== undefined && !(data instanceof Bun.file('')?.constructor)) {
        const hashData = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(hashData);
        contentHash = hasher.digest("hex");
    }

    await this.db.insert(paths).values({
        // ... existing values ...
        contentHash,
        contentHashedAt: contentHash ? new Date() : null,
    });

    // ... existing storage write ...
    return fileId;
}
```

**On write (synchronous, in Mount.writeFile()):**

`writeFile()` already reads the data to compute size. Hash it at the same time:

```typescript
async writeFile(pathId: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
    // ... existing storage write and size computation ...

    const hashData = Buffer.isBuffer(data) || data instanceof Uint8Array
        ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;

    let contentHash: string | null = null;
    if (hashData) {
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(hashData);
        contentHash = hasher.digest("hex");
    }

    await this.updatePath(pathId, {size, ...(contentHash ? {contentHash, contentHashedAt: new Date()} : {})});
    return written;
}
```

**On access for `LocalStorage` mounts (lazy, Phase 2):**

When a file is accessed, stat the file and compare size with metadata. If they differ, re-hash. This catches external
modifications without background scanning.

**Not recommended: Background scanning** -- reads every file, thrashes I/O, keeps the Home singleton alive past its
5-minute inactivity timeout, and for S3 backends means downloading every file. On-demand hashing covers the files users
actually access.

### What to Hash

| Path Type   | Hash? | Reason                                                   |
|-------------|-------|----------------------------------------------------------|
| `file`      | Yes   | Regular files -- the primary target                      |
| `folder`    | No    | No content                                               |
| `doc`       | No    | Live `data.db` with WAL -- not meaningful to hash        |
| `stickies`  | No    | Same as doc                                              |
| `slides`    | No    | Same as doc                                              |
| `sheets`    | No    | Same as doc                                              |
| `chat`      | No    | Same as doc, plus media subdirectory                     |

For container types, the Yjs state is the content and it lives in a SQLite database that changes through collaborative
operations. WAL mode means the `.db` file alone does not represent the full state. The correct "hash" of a Yjs
document would be the hash of the encoded Yjs state vector, which is a different concept entirely and not useful for
the file integrity use case.

### Streaming Hash for Large Files

For files that arrive as `BunFile` (e.g., from temp storage), use streaming to avoid loading the entire file into
memory:

```typescript
async function computeContentHashStreaming(file: BunFile): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    const stream = file.stream();
    for await (const chunk of stream) {
        hasher.update(chunk);
    }
    return hasher.digest("hex");
}
```

This is confirmed to work correctly with `Bun.CryptoHasher` -- incremental updates produce the same digest as a single
update with the concatenated data.

## External Change Detection (Phase 2)

### The Problem

With `LocalStorage` mounts (the default), the `data/` directory is a regular filesystem tree. Files can change through
direct user edits, sync tools, scripts, or OS-level file operations. Eigen's metadata becomes stale.

### Detection Strategy

**Tier 1: On-Access Verification**

When a file is read through the Drive API (download, embed):

1. Get the storage path via `Mount.getPath()` (available on local backends)
2. `fs.stat()` the file (size, mtime)
3. Compare size with `paths.size`
4. If mismatch: read file, compute SHA-256, update `size`, `contentHash`, `contentHashedAt`, `updatedAt`
5. If image and hash changed: regenerate thumbnail via `saveThumbnail()`
6. Emit SSE event `DRIVE_FILE_EXTERNALLY_MODIFIED`

This is lazy, zero-overhead for unchanged files, and naturally covers files users care about.

**Tier 2: Folder Listing Stat Check**

When listing a folder's contents, stat each child file to check if size differs from metadata. Flag mismatched entries
in the API response so the frontend can show an indicator. This requires only `fs.stat()` calls, no hashing.

Note: the `StorageBackend` interface currently lacks a `stat()` method. For Tier 2, either extend the interface or use
`fs.stat()` directly via the `getPath()` method that `LocalStorage` and `LocalKeyStorage` both expose.

**Tier 3: Filesystem Watcher (future, optional)**

`fs.watch()` / FSEvents / inotify on the `data/` directory. Caveats: resource-intensive for deep trees, the Home
singleton destructs after 5 minutes of inactivity (see `home.ts:81`), so watcher ownership is unclear. Not essential if
Tier 1 and 2 exist.

### Other Backends

- **`LocalKeyStorage`**: Files have UUID names. External modification is unlikely. No detection needed.
- **`S3Storage`**: Compare stored hash with S3 ETag on access. S3 ETag equals MD5 for non-multipart uploads, but for
  multipart uploads it is a different format. For full verification, store our own SHA-256 and re-download to verify
  (expensive). Practical approach: trust S3 integrity and verify only when explicitly requested.

## Cross-Cutting Concerns

### Interaction with ACL Propagation

When a file's ACL changes, `Drive.receiveACLChange()` propagates metadata to the `sharedPaths` table in other users'
shared databases. The `contentHash` field must be included in both the INSERT and UPDATE paths of this method, or shared
file views will lack hash information.

### Interaction with File Rename/Move

`Mount.updatePath()` handles renames and moves. For `LocalStorage`, it also renames the storage file via
`storage.rename()`. A rename/move does not change file content, so `contentHash` should remain unchanged. No special
handling needed -- `updatePath()` only updates the columns passed to it.

### Interaction with Collab Document Close

When a collab document is closed (`Drive.closeCollabDocument()`), it calls `mount.updatePath(pathId, {size})` to update
the size. This is the container's total size, not a file content size. Since collab documents are excluded from hashing,
this is not affected.

### Team Drives

Teams use the same `Drive` class via `TeamHome`. The hashing implementation in `Mount` applies equally to team mounts.
No special handling needed.

### No Migration Backward Compatibility Needed

Per project rules: "No migrations or backward compatibility -- data is throwaway during dev." The schema change can be a
clean addition to db-config.ts without worrying about existing data. When metadata.db is recreated, files will get
hashed on their next upload or write.

## Performance Impact

### Upload Path (Measured)

SHA-256 hashing benchmarked on Apple Silicon with `Bun.CryptoHasher`:

| File Size | Hash Time | Notes                       |
|-----------|-----------|-----------------------------|
| 1 MB      | ~0.4 ms   | Negligible                  |
| 10 MB     | ~4.3 ms   | Below multi-file upload max |
| 35 MB     | ~15 ms    | Single-file upload max      |

At ~2.3 GB/s throughput, hashing is faster than thumbnail generation (sharp resize + WebP encode) and far faster than
the network transfer. The upload path impact is unmeasurable in practice.

### Storage Overhead

- 64 bytes per file (SHA-256 hex string in SQLite TEXT column)
- Plus ~80 bytes per entry for the B-tree index
- For 10,000 files: ~1.4 MB total -- negligible

## Implementation Plan

### Phase 1: Schema + Upload Hashing (Do Now)

**Effort: ~1 day**

1. Add `contentHash` and `contentHashedAt` columns to `paths` table (migration v2 in
   `apps/api/src/lib/mount/db-config.ts`)
2. Add `contentHash` column to `sharedPaths` table (migration v2 in `apps/api/src/lib/drive/db-config.ts`)
3. Update Drizzle schema in `apps/api/src/lib/mount/schema.ts` and `apps/api/src/lib/drive/sharedschema.ts`
4. Update `DrivePath` type in `packages/lib/src/types/drive.ts`
5. Compute hash in `Mount.createFile()` and `Mount.writeFile()`
6. Include `contentHash` in `Mount.toDrivePath()` mapping
7. Include `contentHash` in `Drive.receiveACLChange()` propagation

No frontend changes needed. The hash is stored silently and returned in API responses.

### Phase 2: On-Access Verification for LocalStorage (Do Soon)

**Effort: ~2-3 days**

1. Add `Mount.verifyContentHash()` private method
2. In `Mount.readFile()`, for path-based mounts: stat the file, compare size with metadata, re-hash if mismatched
3. In `Mount.listFolder()`, add a lightweight stat check for path-based mounts
4. Add SSE event type for external modification notification
5. Frontend: show a subtle indicator on externally modified files

### Phase 3: Duplicate File Finder UI (When Desired)

**Effort: ~2 days**

1. Add a `Mount.findDuplicates()` method using the indexed `contentHash` column
2. Expose via API route (GET `/drive/:ownerId/:mountId/duplicates`)
3. Frontend: display grouped duplicates with total wasted space and delete options

### Phase 4: Reconciliation Tools (When Needed)

**Effort: ~3-5 days**

1. `Mount.scanForChanges()` -- walk filesystem, compare with metadata
2. `Mount.reconcile()` -- update metadata to match filesystem reality
3. Handle orphaned files (on disk but not in metadata) and missing files (in metadata but not on disk)
4. Expose via admin API

### Not Planned

- Storage deduplication infrastructure (reference counting, shared content store)
- Email attachment deduplication (attachments are inline in .eml files)
- Merkle tree directory hashing
- Block-level hashing / delta sync
- Filesystem watchers
- Client-side hash verification
- BLAKE3 (not available in Bun; SHA-256 is faster due to hardware acceleration)
