# Proposal: Content Hashing for Drive Files

## TLDR

Add a SHA-256 `contentHash` column to the paths table and compute it during upload. This is ~20 lines of code with
negligible performance cost. It gives us upload integrity verification, a foundation for duplicate detection, and the
schema groundwork for future external change detection -- without committing to the complex reconciliation machinery
that the research document over-architects.

## Summary of Findings

The research document (RESEARCH_FILE_HASHING.md) is thorough and mostly accurate. Its key claims hold up:

- `LocalStorage` (path-based, human-readable filenames) is the default storage backend. Every `Drive.init()` calls
  `createDefaultMountConfig()` with no arguments, which defaults to `storageType: 'local'`. The setup wizard's
  `local-id` / `local-fullnames` distinction is stored in server config but never actually flows through to mount
  creation -- `Drive` always creates a `local` mount. This means external file modification is a real concern.
- SHA-256 via `Bun.CryptoHasher` is the right choice. Hardware-accelerated, zero dependencies, already in the runtime.
- Hashing at upload time is essentially free: ~15ms worst case at the 35MB upload limit.
- Excluding eigen container types (.eigendoc, .eigenstickies, etc.) from hashing is correct. These are directories
  containing live SQLite databases with WAL journals -- hashing the `.db` file is meaningless.
- The schema change is trivial and non-breaking.

## Honest ROI Assessment

**Phase 1 (schema + hash on upload): Worth doing now.**
- Effort: a few hours, not a full day
- Risk: near zero
- Value: upload integrity verification, the `contentHash` field starts populating, duplicate detection becomes a
  trivial SQL query whenever we want it

**Phase 2 (on-access verification / external change detection): Not worth doing now.**
The research document gives this a "do soon" rating, but the actual complexity is higher than it lets on:
- The `StorageBackend` interface has no `stat()` method. Adding one requires changes to all three backends.
- Reconciliation after detecting a change (update size, regenerate thumbnails, update shared paths, emit SSE events)
  is not ~20 lines -- it touches `Mount`, `Drive`, ACL propagation, and the thumbnail pipeline.
- The Home singleton destructs after 5 minutes of inactivity. On-access checks only work while the home is alive,
  meaning files modified while the user is away will not be detected until the next access anyway. This makes the
  detection feel inconsistent to users.
- For LocalStorage mounts, `size + mtime` (via `fs.stat()`) is a far cheaper and simpler change-detection heuristic
  than full content hashing. Git uses this approach for its index. If external change detection becomes a priority,
  start with mtime comparison, not hash recomputation.

**Phase 3+ (duplicate finder UI, reconciliation tools): Premature.**
These are product features that should be prioritized based on user demand, not because the hash column exists. The
hash column does not go stale if we defer these.

**Deduplication: Not worth it.** The research correctly dismisses this. Per-user Home isolation, cheap self-hosted
storage, and `LocalStorage` incompatibility with content-addressed storage make it a non-starter.

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Hashing adds latency to uploads | Negligible | ~15ms at 35MB; dominated by network transfer and thumbnail generation |
| `contentHash` is null for BunFile data | Low | BunFile uploads can be streamed. Acceptable to leave hash null for now and handle when needed |
| Zero-byte files all hash identically | None | Correct behavior. `e3b0c44...` is the valid SHA-256 of empty input |
| Race condition: file written while hashing | None for upload path | Data is in memory. Only relevant for Phase 2 on-access checks |
| Large files (future limit increase >1GB) | Low | Switch to streaming hash (already documented in research). Not needed at current 35MB limit |
| Shared paths missing hash | Low | Include in `receiveACLChange()` propagation |

## Minimal Implementation

### Schema Change

**`apps/api/src/lib/mount/schema.ts`** -- add to paths table:

```typescript
export const paths = sqliteTable('paths', {
    // ... existing columns ...
    contentHash: text('contentHash'),
    contentHashedAt: integer('contentHashedAt', {mode: 'timestamp'}),
});
```

**`apps/api/src/lib/mount/db-config.ts`** -- add migration v2:

```typescript
export const MOUNT_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'mount-metadata',
    currentVersion: 2,
    schema,
    migrations: [
        // ... existing migration v1 ...
        {
            version: 2,
            up: (db) => db.exec(`
                ALTER TABLE paths ADD COLUMN contentHash TEXT;
                ALTER TABLE paths ADD COLUMN contentHashedAt INTEGER;
                CREATE INDEX idx_paths_contentHash ON paths(contentHash);
            `)
        }
    ]
};
```

**`apps/api/src/lib/drive/sharedschema.ts`** -- add to shared_paths:

```typescript
export const sharedPaths = sqliteTable('shared_paths', {
    // ... existing columns ...
    contentHash: text('contentHash'),
});
```

**`apps/api/src/lib/drive/db-config.ts`** -- add migration v2:

```typescript
export const SHARED_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'shared',
    currentVersion: 2,
    schema,
    migrations: [
        // ... existing migration v1 ...
        {
            version: 2,
            up: (db) => db.exec(`
                ALTER TABLE shared_paths ADD COLUMN contentHash TEXT;
            `)
        }
    ]
};
```

### Type Change

**`packages/lib/src/types/drive.ts`** -- add to DrivePath:

```typescript
export type DrivePath = {
    // ... existing fields ...
    contentHash: string | null;
}
```

### Hashing Logic

**`apps/api/src/lib/mount/mount.ts`** -- add private helper and update `createFile()` and `writeFile()`:

```typescript
private computeHash(data: Buffer | Uint8Array | ArrayBuffer): string {
    const hashData = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(hashData);
    return hasher.digest("hex");
}
```

In `createFile()`, after the existing insert, compute and store the hash if data is a buffer type (not BunFile):

```typescript
if (data !== undefined && !(data instanceof Blob)) {
    const hashable = data instanceof ArrayBuffer ? data : data;
    const contentHash = this.computeHash(hashable);
    await this.db.update(paths)
        .set({contentHash, contentHashedAt: new Date()})
        .where(eq(paths.id, fileId));
}
```

Or, more efficiently, include `contentHash` in the initial insert by computing it before the INSERT.

In `writeFile()`, compute hash after the write:

```typescript
if (Buffer.isBuffer(data) || data instanceof Uint8Array || data instanceof ArrayBuffer) {
    const contentHash = this.computeHash(data);
    // size is already computed; include hash in the same updatePath call
    await this.updatePath(pathId, {size, contentHash});
}
```

### Mapping Updates

**`apps/api/src/lib/mount/mount.ts`** -- update `toDrivePath()`:

```typescript
private toDrivePath(row: typeof paths.$inferSelect): DrivePath {
    return {
        // ... existing fields ...
        contentHash: row.contentHash ?? null,
    };
}
```

**`apps/api/src/lib/drive/drive.ts`** -- update `receiveACLChange()`:

Add `contentHash: path.contentHash` to both the insert values and the update set in `receiveACLChange()`.

Update `getSharedPathsWithMe()` and `getMimeTypeContents()` shared-path mappings to include `contentHash`.

## Concrete File Changes

| File | Change |
|------|--------|
| `apps/api/src/lib/mount/schema.ts` | Add `contentHash`, `contentHashedAt` columns |
| `apps/api/src/lib/mount/db-config.ts` | Migration v2, bump `currentVersion` to 2 |
| `apps/api/src/lib/mount/mount.ts` | `computeHash()` helper, update `createFile()`, `writeFile()`, `toDrivePath()` |
| `apps/api/src/lib/drive/sharedschema.ts` | Add `contentHash` column |
| `apps/api/src/lib/drive/db-config.ts` | Migration v2, bump `currentVersion` to 2 |
| `apps/api/src/lib/drive/drive.ts` | Update `receiveACLChange()`, `getSharedPathsWithMe()`, `getMimeTypeContents()` mappings |
| `packages/lib/src/types/drive.ts` | Add `contentHash` to `DrivePath` type |

## Phases

### Phase 1: Schema + Upload Hashing (Done)

Implemented as a `hash` field (not `contentHash`) on the paths table. No `contentHashedAt` — unnecessary without Phase 2.

- Added `hash TEXT` to mount schema and migration
- `computeHash()` private method on Mount using `Bun.CryptoHasher('sha256')`, supports Buffer/Uint8Array/ArrayBuffer/BunFile
- Hash computed in `createFile()` (included in initial insert) and `writeFile()` (included in updatePath)
- `hash: string | null` added to `DrivePath` type and `toDrivePath()` mapping
- Shared paths not updated (out of scope) — mapped as `hash: null`
- Tests added: hash on create, null hash without data, hash on write, identical/different content hashing

### Phase 2: External Change Detection (Defer)

When external file modification becomes a reported pain point:

- Add `mtime` comparison (cheaper than re-hashing) to `readFile()` for local mounts
- Only re-hash when size or mtime differs
- Consider whether `size + mtime` alone is sufficient (it is for most cases)
- Requires extending `StorageBackend` with `stat()` or using `fs.stat()` directly via `getPath()`

### Phase 3: Duplicate Finder (When Desired as Product Feature)

- Trivial SQL query once hashes exist
- Pure product decision, no technical blockers
- Should be prioritized like any other feature request

## What the Research Got Wrong or Overstated

1. **ROI of Phase 2.** The research rates on-access verification as "do soon" but underestimates the implementation
   surface. It is not a weekend project -- it touches the storage interface, the mount class, the drive class, the
   thumbnail pipeline, SSE events, and potentially the frontend. Size + mtime comparison would solve 90% of the
   problem at 10% of the cost.

2. **`contentHashedAt` necessity.** For Phase 1 (upload-only hashing), this column is unnecessary -- the hash is
   always fresh at write time. It only becomes useful in Phase 2 for mtime comparison. Including it now is fine since
   schema changes are cheap during dev, but it is dead weight until Phase 2.

3. **Streaming hash for BunFile.** The research includes a `computeContentHashStreaming()` function for BunFile
   inputs. In the current codebase, `createFile()` receives data that is already in memory (the upload route calls
   `file.arrayBuffer()` before passing to `mount.createFile()`). The streaming path is only needed if upload limits
   increase significantly or if the upload pipeline is refactored to avoid loading files into memory. Not needed now.

4. **The disconnect between setup config and mount config.** The research claims `LocalStorage` is the default because
   `createDefaultMountConfig()` defaults to `'local'`. This is correct, but it buries a deeper issue: the setup
   wizard's `local-id` / `local-fullnames` storage type choice is stored in `ServerConfig` but never actually
   consumed by `Drive.init()`. Every user always gets a `local` (path-based) mount regardless of what was selected
   during setup. This is likely a bug or incomplete feature, not an intentional design choice. If this is fixed to
   route `local-id` to `local-key` storage, the external modification concern diminishes significantly.
