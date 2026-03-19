# Backend Review: Drive (Storage, Mounts, ACL, Previews, Share Propagation)

**Scope:** `apps/api/src/lib/{drive,mount,storage,preview,share,shared}/`, `apps/api/src/routes/drive.ts`
**Reviewed:** 2026-03-19

---

## Architecture Overview

The Drive domain is the file-storage backbone of Eigen. Its architecture follows a clean layered pattern:

### Class Hierarchy

- **`Drive`** (`apps/api/src/lib/drive/drive.ts`) -- the primary domain class, owned by a `Home` singleton. Manages
  mounts, file operations, ACL enforcement, collab document lifecycle, preview generation, and SSE emission. One
  instance per user/team Home.
- **`SharedDrive`** (`apps/api/src/lib/drive/sharedDrive.ts`) -- a permission-gating wrapper. Created when
  `ownerId !== user.id` (user is accessing someone else's drive). Every method either delegates to the owner's `Drive`
  instance with a permission check, or throws 403. Uses composition-via-inheritance: extends `Drive` but overrides
  `init()` to a no-op and delegates all methods to `this.sharedDrive`.
- **`Mount`** (`apps/api/src/lib/mount/mount.ts`) -- bundles a metadata DB (Drizzle ORM), a storage backend, a thumbs
  dir, a tmp dir, and a previews dir. Each Home can have multiple mounts (default + user-configured).

### Storage Backends

Three implementations of the `StorageBackend` interface (`apps/api/src/lib/storage/types.ts`):

| Backend           | File                   | Key Pattern              | Path Traversal Protection         |
|-------------------|------------------------|--------------------------|-----------------------------------|
| `LocalKeyStorage` | `local-key-storage.ts` | Flat `{uuid}.{ext}`      | `path.resolve` + startsWith check |
| `LocalStorage`    | `local-storage.ts`     | Full directory hierarchy | `path.resolve` + startsWith check |
| `S3Storage`       | `s3-storage.ts`        | S3 key prefix            | None (keys are S3 objects)        |

### ACL System

Defined in `apps/api/src/lib/drive/acl.ts`. Purely additive inheritance: `canRead`/`canWrite` check the local ACL, then
recurse to parents. No deny mechanism. Supports user emails and `team_` prefixed group IDs. Three visibility levels:
`private`, `public-read`, `public-write`.

### Share Propagation

When ACLs change, `acl-propagation.ts` pushes updates to each affected user's `shared.db`. The share registry (
`apps/api/src/lib/share/`) stores `(fromUserId, targetIdentifier)` pairs for users who don't exist yet. On account
creation or team join, `reconciliation.ts` pulls pending shares.

### Preview System

`apps/api/src/lib/preview/` provides:

- **Image previews**: sharp resize to WebP (max 2560px screen, 512px thumb), exiftool fallback for RAW/PSD/HEIC
- **Text previews**: markdown-it for .md, lowlight for code, DOMPurify sanitization
- **Video/audio/PDF**: redirect to embed URL
- **Cache**: file-based in `mount.previewsDir`, keyed by `{pathId}-{updatedAt}.{ext}`, 7-day cleanup

---

## Critical Issues

### 1. `getSharedDrive` does not validate caller's access to the ownerId

**File:** `apps/api/src/lib/drive/get-drive.ts:12-24`

```typescript
export async function getSharedDrive(ownerId: string, user: User) {
    if (!user?.id) {
        throw new ApiError(401, 'User is required');
    }
    if (ownerId !== user.id) {
        const home = await getHome(ownerId);
        return new SharedDrive(home, user);
    } else {
        return getDrive(user);
    }
}
```

When `ownerId !== user.id`, a `SharedDrive` is created without verifying that the caller has any relationship to the
ownerId. Any authenticated user can construct a `SharedDrive` for any other user or team. The `SharedDrive` methods then
check path-level ACLs, but several operations leak information even without ACL access:

- `listMounts()` (line 46-48) returns mount metadata (names, storage types, sizes, file counts) for any user's drive
  without any permission check -- it delegates directly to `this.sharedDrive.listMounts()`.
- `size()` (line 56-58) returns 0 for SharedDrive, so no leak there.
- `getRootFolder()` (line 50-53) returns the root if `canRead` passes, but the root folder's `ownerId` is exposed in the
  attempt.

The CLAUDE.md rule states: "Routes must validate that the caller has access to the specified ownerId (owns it or is a
team member)." This validation is missing from `getSharedDrive`.

**Impact:** Information disclosure -- any authenticated user can enumerate mount names, storage types, and sizes for any
other user's drive. A user could also discover the existence of another user's Home by observing whether
`getHome(ownerId)` throws 404 vs. succeeds.

**Fix:** Before creating `SharedDrive`, verify the caller either:

1. Is the owner
2. Is a team member (if ownerId is team-prefixed)
3. Has at least one shared path from that owner (check share registry or shared.db)

Or move the validation to a middleware/guard on the router.

### 2. `SharedDrive.movePath` does not check write permission on target parent

**File:** `apps/api/src/lib/drive/sharedDrive.ts:193-198`

```typescript
public async movePath(mountId: string, pathId: string, targetParentId: string): Promise<DrivePath> {
    if (!(await this.canWrite(mountId, pathId, this.user))) {
        throw new ApiError(403, 'No write permission');
    }
    return this.sharedDrive.movePath(mountId, pathId, targetParentId);
}
```

`SharedDrive.movePath` only checks write permission on the source path, then delegates to the owner's `Drive.movePath`.
The owner's `Drive.movePath` (line 333-338) does check both source and target write permissions, but those checks use
`this.owner` (the drive owner), not the calling user. Since the drive owner always has full access, the target-parent
write check passes trivially.

A user with write access to file X but only read access to folder Y can move X into Y through the shared drive.

**Impact:** Users can move items into folders where they only have read permission, bypassing the ACL model.

**Fix:** Add `canWrite(mountId, targetParentId, this.user)` check in `SharedDrive.movePath`:

```typescript
public async movePath(mountId: string, pathId: string, targetParentId: string): Promise<DrivePath> {
    if (!(await this.canWrite(mountId, pathId, this.user))) {
        throw new ApiError(403, 'No write permission');
    }
    if (!(await this.canWrite(mountId, targetParentId, this.user))) {
        throw new ApiError(403, 'No write permission on target folder');
    }
    return this.sharedDrive.movePath(mountId, pathId, targetParentId);
}
```

---

## Important Issues

### 3. `getStorageFile` casts S3File to BunFile -- thumbnails and previews fail on S3 mounts

**File:** `apps/api/src/lib/mount/mount.ts:444-447`

```typescript
async getStorageFile(pathId: string): Promise<BunFile> {
    const storageKey = await this.getStorageKey(pathId);
    return this.storage.read(storageKey) as BunFile;
}
```

For S3 storage, `read()` returns `S3File`. The `as BunFile` cast silences TypeScript. The caller at `drive.ts:247` does
`storageFile.name!` to get the file path for thumbnail generation, and `preview-cache.ts:47` does the same for screen
previews. For S3 mounts, `name` returns the S3 key (e.g., `prefix/uuid.ext`), not a local filesystem path.

`saveThumbnail` and `generateImagePreview` treat string `source` as a local file path. Sharp cannot read from an S3 key,
so it fails silently and returns null. Thumbnails and image previews silently fail on all S3-backed mounts.

**Impact:** No thumbnails or image previews for S3 mounts. No error is reported to the user; files simply appear without
thumbnail/preview.

**Fix:** For remote mounts, download to temp before thumbnail/preview generation. Alternatively, change `getStorageFile`
to return `BunFile | S3File` and handle both cases in callers.

### 4. `SharedDrive` inherits `getSharedPathsWithMe`, `getSharedPathsByMe`, and `getSharedWith` with explicit throws

**File:** `apps/api/src/lib/drive/sharedDrive.ts:226-236`

These methods now throw `ApiError(403)` instead of crashing, which is correct. However, the routes at `drive.ts:19-26`
still call these through `getSharedDrive()`:

```typescript
.get("/drive/:ownerId/shared/by-me", async ({params, user}) => {
    const drive = await getSharedDrive(params.ownerId, user);
    return await drive.getSharedPathsByMe();
}, {auth: true})
.get("/drive/:ownerId/shared/with-me", async ({params, user}) => {
    const drive = await getSharedDrive(params.ownerId, user);
    return await drive.getSharedPathsWithMe();
}, {auth: true})
```

When `ownerId !== user.id`, these routes return 403. The routes should either restrict `ownerId` to `user.id` only, or
bypass `getSharedDrive` and call the owner's drive directly (as the `/drive/:ownerId/shared-with-me` route at line 27-30
correctly does). The current behavior means team drives cannot query shared paths at all.

**Impact:** 403 errors on shared-path queries for team drives and cross-user scenarios. Functionally broken for any
multi-user sharing workflow that needs to list "what have I shared" from a team context.

**Fix:** Restrict these routes to `ownerId === user.id` or use `getHome(user.id).drive` directly.

### 5. `removeMount` does not clean up mount metadata database

**File:** `apps/api/src/lib/drive/drive.ts:101-110`

```typescript
async removeMount(mountId: string): Promise<void> {
    if (mountId === this.defaultMountId) {
        throw new ApiError(400, 'Cannot remove default mount');
    }
    const mount = this.mounts.get(mountId);
    if (mount) {
        await mount.closeAllDatabases();
    }
    this.mounts.delete(mountId);
}
```

`closeAllDatabases()` only closes document-level databases in `documentDbs`. The mount's own metadata database (opened
during `init()` via `this.getLocalDatabase(MOUNT_DB_CONFIG, dbPath)`) is not closed. The `ManagedDatabase` holds an open
SQLite connection and may have a sync timer running. There is also no physical storage cleanup (the mount's `data/`,
`thumbs/`, `tmp/` directories remain).

**Impact:** Resource leak -- open SQLite connection and potential sync timer per removed mount. On repeated mount
add/remove cycles, connections accumulate until Home destructs. No storage reclamation.

**Fix:** Add a `close()` method to `Mount` that closes the metadata DB, then call it from `removeMount`.

### 6. S3Storage has no path traversal protection

**File:** `apps/api/src/lib/storage/s3-storage.ts:40-42`

```typescript
private getKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
}
```

Unlike `LocalKeyStorage` and `LocalStorage`, `S3Storage.getKey` performs no validation on the key. A key containing
`../` could potentially escape the prefix scope in the S3 bucket. Currently, all keys are internally generated (UUIDs
via `buildStorageKey` for local-key, or mount-resolved paths for local), so user input doesn't reach S3 keys directly.
But if any future code path passes user-controlled data to S3 storage operations, the lack of validation would be
exploitable.

**Impact:** Low currently (defense-in-depth). Keys are always internally generated. But the inconsistency across
backends is a maintenance hazard.

**Fix:** Add key validation to `S3Storage.getKey`:
```typescript
private getKey(key: string): string {
    if (key.includes('..') || key.startsWith('/')) {
        throw new Error('Invalid storage key');
    }
    return this.prefix ? `${this.prefix}/${key}` : key;
}
```

### 7. `mimeType` route uses single-dash replacement

**File:** `apps/api/src/routes/drive.ts:206`

```typescript
return await drive.getMimeTypeContents(params.mimeType.replace('-', '/'), {excludeDocumentChildren: true});
```

`String.replace` with a string first argument only replaces the first occurrence. For standard MIME types like
`image-png` this works fine (one dash becomes the slash). But Eigen's custom MIME types like `application-eigendoc` also
only have one dash, so this is correct. However, if a MIME subtype ever contains a dash (e.g.,
`application/vnd-ms-excel`), this would not round-trip correctly. The URL param would be `application-vnd-ms-excel`, and
only the first dash gets replaced, producing `application/vnd-ms-excel` -- which is actually correct by coincidence.

**Impact:** None currently. The behavior is coincidentally correct for all MIME types, since `/` only appears once (
between type and subtype).

### 8. `filterRedundantACL` first-match semantics may miss permission escalations

**File:** `apps/api/src/lib/drive/acl.ts:112-126`

```typescript
const inherited = new Map<string, { read: boolean, write: boolean }>();
let current = path.parentId ? await getPath(path.parentId) : null;
while (current) {
    if (current.acl) {
        for (const entry of current.acl) {
            const key = entry.id.toLowerCase();
            if (!inherited.has(key)) {
                inherited.set(key, {read: entry.read, write: entry.write});
            }
        }
    }
    current = current.parentId ? await getPath(current.parentId) : null;
}
```

When the same ACL ID appears in multiple ancestor ACLs, only the first (nearest) match is recorded. Since ACLs are
additive, the correct behavior is to merge (OR) all inherited permissions. Consider: parent has
`{bob, read: true, write: false}`, grandparent has `{bob, read: true, write: true}`. The current code records
`{read: true, write: false}` from parent, missing grandparent's write grant.

If a child then tries to add `{bob, read: true, write: true}`, `filterRedundantACL` sees `writeCovered = false` (parent
only has read), so it keeps the entry. This is actually fine -- the entry is not stripped when it should be. The bug
manifests in the other direction: if the child tries to add `{bob, read: true, write: false}`, the filter sees it as
fully covered (read covered by parent's read, write not requested), so it strips the entry. This is correct behavior.

Actually, re-examining: the additive model means `canWrite` walks up to grandparent and finds write=true regardless. So
`filterRedundantACL` being conservative (keeping entries that an OR-merge would strip) is safe -- it just means slightly
more ACL entries than necessary. The ACL still functions correctly because the runtime `canRead`/`canWrite` does its own
recursive walk.

**Impact:** Minor redundancy in stored ACL entries. No functional impact on access control.

---

## Minor Issues

### 9. `SharedDrive.openDatabase` and `closeDatabase` skip ACL checks

**File:** `apps/api/src/lib/drive/sharedDrive.ts:214-224`

These methods delegate directly to the owner's drive without permission checks. Callers (collab system, chat) perform
their own access checks before calling these, and the `pathId` is internally derived. The risk is low but breaks the
pattern.

**Impact:** Defense-in-depth concern only.

### 10. `uploadFile` parent type check is stricter than `createFolder`

**File:** `apps/api/src/lib/drive/drive.ts:219` vs `drive.ts:159`

- `createFolder` checks `isContainerType(parent.type)` -- allows creating subfolders inside docs, chats, etc.
- `uploadFile` checks `parent.type !== 'folder'` -- only allows uploading into plain folders.

This asymmetry is intentional (collab types manage their own child files through the collab system, not through direct
upload), but it is undocumented.

### 11. `buildDriveEvent` uses `as SSEvent` cast

**File:** `apps/api/src/lib/drive/sse-events.ts:73`

The `as SSEvent` cast bypasses type checking on the constructed event object. If the `SSEvent` type evolves, invalid events would be silently produced.

### 12. `getUniqueFileName` Date.now fallback not collision-safe

**File:** `apps/api/src/lib/drive/naming.ts:20`

After 10,000 counter iterations, falls back to `Date.now()` without checking against `usedNames`. Practically
unreachable and guarded by `assertUniqueName` at DB level.

### 13. `S3Storage.write` return type may not always be `number`

**File:** `apps/api/src/lib/storage/s3-storage.ts:48-52`

The `StorageBackend` interface declares `write` returns `Promise<number>`. `S3File.write()` behavior may vary by Bun
version. The return value is only used by `mount.writeFile` which independently computes size from input data, so this
is a type-safety concern only.

### 14. Preview cache does not invalidate on file content update

**File:** `apps/api/src/lib/preview/preview-cache.ts:14-17`

Cache keys use `{pathId}-{updatedAt}`. When a file is updated via `writeFileContent`, the `updatedAt` timestamp changes,
so a new cache entry is generated. However, old cache entries for the same pathId with a previous timestamp remain on
disk until the 7-day cleanup. On busy systems with frequent edits, preview cache could accumulate significantly.

**Impact:** Disk space usage. No correctness issue since the latest timestamp is always used.

---

## Strengths

### Solid path traversal protection

Both `LocalKeyStorage.getFilePath` and `LocalStorage.resolve` use `path.resolve` + `startsWith` checks to block
traversal attacks. The mount `validateName` function catches `.`, `..`, `/`, `\`, and null bytes at the API boundary.
Test coverage for these checks is thorough (`mount.test.ts` lines 287-343).

### Clean storage abstraction

The `StorageBackend` interface is minimal and well-designed. The three implementations handle their respective storage
models cleanly. The `Mount` class abstracts storage details from `Drive`, handling key generation, temp file management,
and database lifecycle.

### Robust ACL model

The additive inheritance model is simple and predictable. `canRead`/`canWrite` recursion to parents is correct. The
`filterRedundantACL` optimization prevents ACL bloat without affecting correctness. Email normalization (lowercase)
prevents case-sensitivity issues.

### Well-structured preview pipeline

The preview system cleanly separates image/text/redirect paths with proper caching. DOMPurify sanitization on text
previews prevents XSS. The exiftool fallback chain (sharp -> exiftool extract -> sharp) handles edge cases for
RAW/PSD/HEIC formats.

### ACL propagation with share registry

The push-based propagation with a registry fallback for non-existent users is a solid design. The reconciliation hooks
on user creation and team member addition ensure no shares are lost. The idempotency test confirms no duplicate entries
on repeated reconciliation.

### Comprehensive concurrency handling

`withPathLock` in Mount provides per-path mutual exclusion for rename/move operations on path-based storage.
`createAsyncSingleton` for collab document DBs prevents duplicate opens. These prevent the most common concurrency
issues in file operations.

### Error isolation

`propagateACLChange` catches errors per-user (line 34), preventing one failure from blocking others. `destruct()`
catches per-document errors. Storage delete errors are caught and logged. Thumbnail generation failures return null --
uploads succeed without thumbnails.

---

## Test Coverage Analysis

### Well-covered areas

- **Mount operations** (`mount.test.ts`): 28 tests covering CRUD, rename, move, delete, breadcrumb for both local-key
  and local storage. Name validation has 10 dedicated tests.
- **Storage backends** (`storage.test.ts`): 18 tests for LocalKeyStorage and LocalStorage, including path traversal
  rejection.
- **Drive API** (`drive.test.ts`): ~50 tests covering folder operations, file upload/download, sharing/ACL, ACL
  inheritance, visibility, breadcrumbs, email validation, doc/stickies/slides/sheets creation.
- **Share registry** (`share-registry.test.ts`): Integration tests for share propagation, pull routes, reconciliation
  for new users and team members, idempotency.
- **Previews** (`preview.test.ts`): Text/image/video preview generation and caching, thumbnail generation,
  `isExiftoolCandidate` logic.
- **Team drives** (`org-drive.test.ts`): Team mount management, drive operations through team ownerId, file sharing
  across team members.

### Gaps

1. **S3 storage backend**: Zero tests. All mount tests use local-key or local storage. S3-specific behavior (thumbnail
   failures, preview failures, temp file management) is completely untested.
2. **`SharedDrive.movePath` target permission**: No test verifying that a user with read-only access to a target folder
   cannot move files into it.
3. **`listMounts` information disclosure**: No test verifying that a non-owner user cannot enumerate mount metadata.
4. **`removeMount` lifecycle**: No test verifying metadata DB closure after mount removal.
5. **Concurrent uploads**: No race-condition test for duplicate filename detection when two uploads of the same name
   happen simultaneously.
6. **`SharedDrive` shared-path route behavior**: No test confirming that `/drive/:ownerId/shared/by-me` returns 403 for
   non-owner access (and whether that's the desired behavior).
7. **Preview cache accumulation**: No test for stale preview cleanup behavior.

---

## File Reference

| File                                                                                   | Issue # | Severity  |
|----------------------------------------------------------------------------------------|---------|-----------|
| `apps/api/src/lib/drive/get-drive.ts:12-24`                                            | 1       | Critical  |
| `apps/api/src/lib/drive/sharedDrive.ts:193-198`                                        | 2       | Critical  |
| `apps/api/src/lib/mount/mount.ts:444-447`                                              | 3       | Important |
| `apps/api/src/lib/drive/sharedDrive.ts:226-236` + `apps/api/src/routes/drive.ts:19-26` | 4       | Important |
| `apps/api/src/lib/drive/drive.ts:101-110`                                              | 5       | Important |
| `apps/api/src/lib/storage/s3-storage.ts:40-42`                                         | 6       | Important |
| `apps/api/src/routes/drive.ts:206`                                                     | 7       | Minor     |
| `apps/api/src/lib/drive/acl.ts:112-126`                                                | 8       | Minor     |
| `apps/api/src/lib/drive/sharedDrive.ts:214-224`                                        | 9       | Minor     |
| `apps/api/src/lib/drive/drive.ts:219 vs 159`                                           | 10      | Minor     |
| `apps/api/src/lib/drive/sse-events.ts:73`                                              | 11      | Minor     |
| `apps/api/src/lib/drive/naming.ts:20`                                                  | 12      | Minor     |
| `apps/api/src/lib/storage/s3-storage.ts:48-52`                                         | 13      | Minor     |
| `apps/api/src/lib/preview/preview-cache.ts:14-17`                                      | 14      | Minor     |

---

## Relevant Documentation

- [STORAGE.md](../docs/STORAGE.md) -- Home singleton, mount system, storage backends
- [ACL.md](../docs/ACL.md) -- Additive ACL inheritance model
- [SHARE-PROPAGATION.md](../docs/SHARE-PROPAGATION.md) -- Push-based sharing, share registry
- [PREVIEWS.md](../docs/PREVIEWS.md) -- Preview generation pipeline
- [DATABASE.md](../docs/DATABASE.md) -- ManagedDatabase, migration system
- [CONTRIBUTING.md](../docs/CONTRIBUTING.md) -- Code patterns and development workflow
