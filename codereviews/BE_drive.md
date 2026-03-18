# Backend Code Review: Drive (Mount, Storage, ACL, Previews)

## Summary

The Drive domain is well-structured, following project conventions consistently. The code separates concerns cleanly
across Drive (orchestration), Mount (storage + metadata), storage backends (pluggable I/O), ACL (permission logic), and
previews (image/text rendering). The `SharedDrive` proxy pattern for cross-user access is a smart design. Test coverage
is strong for core operations and ACL inheritance.

This review found one critical bug (missing `await` on an async call), several important security and correctness
issues, and a number of minor improvements.

---

## Architecture Compliance

The code follows the documented architecture patterns well:

- Domain class `Drive` is owned by the `Home` singleton, as specified.
- Routes in `apps/api/src/routes/drive.ts` are thin, delegating to `getSharedDrive()`.
- DB schemas use Drizzle ORM with `db-config.ts` migration patterns.
- Storage backends implement the `StorageBackend` interface.
- SSE events use the `buildDriveEvent()` pattern with `home.notify()`.
- ACL uses additive inheritance as documented.
- Thumbnails and previews follow the cache strategy described in PREVIEWS.md.

---

## Issues Found

### Critical

#### 1. Missing `await` on async `matchesACL` in `receiveACLChange`

**File**: `apps/api/src/lib/drive/drive.ts`, line 561

```typescript
if (newACL === null || !matchesACL(newACL, this.owner, 'read')) {
```

`matchesACL` is an `async` function returning `Promise<boolean>`. Without `await`, the expression
`!matchesACL(...)` evaluates `!Promise` which is always `false`. This means the unshare branch is **never taken**
when `newACL` is non-null -- the user's shared.db entry is never deleted when access is revoked via ACL change.

**Impact**: When Alice removes Bob from an ACL, Bob's `shared.db` retains a stale entry. Bob still sees the item in
"shared with me" even though actual access checks (which do `await`) correctly deny access. This is a data consistency
bug -- stale entries accumulate in shared.db indefinitely.

**Fix**: Add `await`:
```typescript
if (newACL === null || !(await matchesACL(newACL, this.owner, 'read'))) {
```

---

### Important

#### 2. No ACL check on `downloadFile` in `Drive` class

**File**: `apps/api/src/lib/drive/drive.ts`, lines 357-364

```typescript
async downloadFile(mountId: string, pathId: string): Promise<ArrayBuffer | null> {
    const mount = this.getMount(mountId);
    const path = await mount.getPath(pathId);
    if (!path || path.type !== DRIVE_TYPE_FILE) {
        return null;
    }
    return await mount.readFile(pathId);
}
```

The `Drive` class itself does not check `canRead` before returning file content. The `SharedDrive` wrapper adds the
check via `withReadPermission`, so cross-user access is protected. However, this means the `Drive` class relies entirely
on its callers for access control on downloads.

The route handler at line 109-119 calls `drive.downloadFile()` through `getSharedDrive()`, which returns either the
owner's `Drive` (no check needed) or a `SharedDrive` (check applied). So the route is safe. But any future internal
caller using `Drive.downloadFile()` directly would bypass ACL.

**Recommendation**: Add a `canRead` check inside `Drive.downloadFile()` for defense-in-depth, matching the pattern used
by `getFolderContents`, `writeFileContent`, etc.

#### 3. No ACL check on `getPreview` and `getTextPreview` in `Drive` class

**File**: `apps/api/src/lib/drive/drive.ts`, lines 382-394

Same pattern as `downloadFile` -- the `Drive` class methods don't check permissions. Again, the `SharedDrive` wrapper
adds the check, so routes are safe. But `Drive.getPreview()` and `Drive.getTextPreview()` should also be
defense-in-depth protected.

#### 4. `SharedDrive.openDatabase` and `SharedDrive.closeDatabase` skip ACL checks

**File**: `apps/api/src/lib/drive/sharedDrive.ts`, lines 200-210

```typescript
public async openDatabase<S extends SchemaType>(...): Promise<ManagedDatabase<S>> {
    return this.sharedDrive.openDatabase(mountId, config, pathId);
}

public async closeDatabase(mountId: string, pathId: string): Promise<void> {
    return this.sharedDrive.closeDatabase(mountId, pathId);
}
```

These methods delegate directly to the owner's drive without any permission check. A user accessing a shared drive
could open or close arbitrary databases if they can construct the right `pathId`. This is likely benign in practice
(these are called internally for collab docs, which check read/write before opening), but it breaks the pattern
established by every other `SharedDrive` method.

**Recommendation**: Wrap with `withReadPermission` (or `withWritePermission` for close).

#### 5. `movePath` allows moving a folder into its own descendant

**File**: `apps/api/src/lib/drive/drive.ts`, lines 315-338

The `movePath` method checks that the target parent is a folder and that the user has write permission, but does not
check whether the target is a descendant of the source. Moving a folder into its own subtree creates an orphan cycle
in the path tree -- the folder and all its descendants become unreachable from the root.

**Recommendation**: Walk up from `targetParentId` to root; if `pathId` is encountered, throw a 400 error.

#### 6. `movePath` does not check write permission on target parent

**File**: `apps/api/src/lib/drive/drive.ts`, line 329

```typescript
if (!(await this.canWrite(mountId, pathId, this.owner))) {
```

Only write permission on the **source** path is checked. The user might not have write permission on the target folder.
Contrast with `SharedDrive.movePath` (line 180) which also only checks source. This allows moving items into folders
where the user cannot create new items.

**Recommendation**: Also check `canWrite(mountId, targetParentId, this.owner)`.

#### 7. `removeMount` does not close mount resources

**File**: `apps/api/src/lib/drive/drive.ts`, lines 101-106

```typescript
async removeMount(mountId: string): Promise<void> {
    if (mountId === this.defaultMountId) {
        throw new ApiError(400, 'Cannot remove default mount');
    }
    this.mounts.delete(mountId);
}
```

When a mount is removed, its databases and open collab documents are not closed. The `Mount` has `documentDbs` that
hold open `ManagedDatabase` instances. These will continue to hold file handles and sync timers until the `Home`
destructs. There is also no cleanup of the mount's physical storage.

#### 8. Content-Disposition header injection via filename

**File**: `apps/api/src/routes/drive.ts`, line 114

```typescript
set.headers['Content-Disposition'] = `attachment; filename="${displayName}"`;
```

If a file name contains a double-quote or newline, this produces a malformed or injectable header. The `displayName`
comes from either `path.details.originalName` or `path.name`. While `path.name` is sanitized (slashes stripped), it is
not sanitized for double-quotes or control characters.

**Recommendation**: Use RFC 5987 `filename*` encoding, or at minimum strip/escape `"` and control chars from the name:
```typescript
const safeName = displayName.replace(/["\\]/g, '_');
set.headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
```

#### 9. Path traversal protection inconsistent across storage backends

**File**: `apps/api/src/lib/storage/local-key-storage.ts` vs `apps/api/src/lib/storage/local-storage.ts`

`LocalStorage.resolve()` (line 18-23) has explicit path traversal detection:
```typescript
if (!resolved.startsWith(this.dataDir + path.sep) && resolved !== this.dataDir) {
    throw new ApiError(400, 'Invalid storage path: path traversal detected');
}
```

`LocalKeyStorage.getFilePath()` (line 16-18) has **no** such check:
```typescript
private getFilePath(key: string): string {
    return path.join(this.dataDir, key);
}
```

While `LocalKeyStorage` keys are UUIDs with extensions (generated by `buildStorageKey`), the `getFilePath` method
accepts any string. If a malicious key like `../../etc/passwd` were passed, it would resolve outside the data directory.

In practice this is safe because keys are always generated internally (UUID-based), but it would be good practice to add
the same traversal guard for defense-in-depth.

#### 10. S3Storage missing `getPath` method

**File**: `apps/api/src/lib/storage/s3-storage.ts`

The `StorageBackend` interface declares `getPath?` as optional, and `S3Storage` does not implement it.
In `Mount.openDatabase()` (mount.ts line 499), when `needsTempCopy` is false (only for `local-key` storage),
the code calls `this.storage.getPath!(...)` with a non-null assertion. If somehow `openDatabase` were called on an
S3 mount without the temp copy path, this would crash at runtime.

Currently `needsTempCopy` is true for S3, so this code path is never reached. But the `!` assertion masks the
potential failure.

---

### Minor

#### 11. `closeCollabDocument` sets path size to mount total size

**File**: `apps/api/src/lib/drive/drive.ts`, lines 505-509

```typescript
const path = await mount.getPath(pathId);
if (path) {
    const size = await mount.getTotalSize();
    await mount.updatePath(pathId, {size});
}
```

This updates the collab document's `size` field with the **entire mount's total size**, not the document's own size.
This appears to be a bug -- the document's size should be the size of its own data.db, not the total of all files in
the mount.

#### 12. `uploadFile` parent type check is stricter than `createFolder`

**File**: `apps/api/src/lib/drive/drive.ts`

- `createFolder` (line 155): checks `isContainerType(parent.type)` -- allows uploading into docs, chats, etc.
- `uploadFile` (line 215): checks `parent.type !== 'folder'` -- only allows uploading into plain folders.

This inconsistency means you can create a folder inside a doc (e.g., to store media files for the doc), but you cannot
upload a file into that same doc container. This is likely intentional (docs manage their own files), but the asymmetry
should be documented.

#### 13. `getUniqueFileName` can produce infinite-like loop

**File**: `apps/api/src/lib/drive/naming.ts`, line 18

The counter caps at 10,000, falling back to `Date.now()`. This is a reasonable safety net, but the `Date.now()` fallback
is not checked against `usedNames`, so it could theoretically collide if called twice in the same millisecond.

#### 14. `getStorageFile` casts S3File to BunFile

**File**: `apps/api/src/lib/mount/mount.ts`, line 446

```typescript
async getStorageFile(pathId: string): Promise<BunFile> {
    const storageKey = await this.getStorageKey(pathId);
    return this.storage.read(storageKey) as BunFile;
}
```

For S3 storage, `read()` returns `S3File`, not `BunFile`. The `as BunFile` cast hides this type mismatch. Callers
(like `saveThumbnail`) use `storageFile.name!` which is `undefined` for S3File objects. The `saveThumbnail` call in
`uploadFile` (line 243) passes this to `saveThumbnail(mount.thumbsDir, pathId, storagePath, ...)` where
`storagePath` would be `undefined`.

For S3 mounts, thumbnails and previews would silently fail because the source path is wrong.

#### 15. `buildDriveEvent` uses `as SSEvent` cast

**File**: `apps/api/src/lib/drive/sse-events.ts`, line 73

The `as SSEvent` cast bypasses type checking on the constructed event object. If the `SSEvent` type changes, this would
silently produce invalid events.

#### 16. `SharedDrive` extends `Drive` but overrides `init()` to do nothing

**File**: `apps/api/src/lib/drive/sharedDrive.ts`, lines 11, 43

```typescript
export default class SharedDrive extends Drive {
    ...
    public async init() {
    }
```

The `constructor` calls `super(sharedHome)` which sets up `Drive` internals. Then `init()` is overridden to be a
no-op. But `SharedDrive` never calls `super.init()`, meaning `this.sharedDb` on the `Drive` base class is never set.
Since `SharedDrive` delegates all calls to `this.sharedDrive`, the base class `sharedDb` is unused. However, this
means `SharedDrive.getSharedPathsWithMe()` would crash if called, because it inherits from `Drive` and would try to
use the uninitialized `sharedDb`. Currently `SharedDrive` does not override `getSharedPathsWithMe()` or
`getSharedPathsByMe()`, so these inherited methods are accessible but broken.

**Recommendation**: Make `SharedDrive` use composition instead of inheritance, or override all inherited methods that
touch `sharedDb`.

#### 17. Redundant ACL filter can produce unexpected null

**File**: `apps/api/src/lib/drive/drive.ts`, lines 451-456

```typescript
if (normalizedACL && normalizedACL.length > 0) {
    const {filtered} = await filterRedundantACL(
        normalizedACL, item, mount.getPath.bind(mount)
    );
    normalizedACL = filtered.length > 0 ? filtered : null;
}
```

If all ACL entries are redundant (already inherited), the ACL is set to `null`. This is correct behavior but may
surprise users -- they add ACL entries, but after save the ACL appears empty because the entries were "optimized away"
by the redundancy filter. The frontend should communicate this.

---

## Robustness

### Concurrency

- The `withPathLock` mechanism in `Mount` (lines 293-306) provides per-path mutual exclusion for rename/move
  operations on path-based storage. This is well-implemented using promise-based queuing.
- However, there is no locking for concurrent uploads to the same folder, which could lead to duplicate name
  detection races. Two concurrent uploads of the same filename could both pass the `getChildByName` check before
  either inserts, though `assertUniqueName` would catch one of them at insert time.
- The `createAsyncSingleton` pattern for collab documents prevents duplicate DB opens.

### Error Handling

- Storage backend errors in `delete` are caught and logged, returning `false` -- operations degrade gracefully.
- Thumbnail generation failures are caught and produce `null` -- uploads succeed even when thumbnails fail.
- Preview generation failures are caught and return `null` -- the route returns 404.
- `propagateACLChange` catches errors per-user (line 34), so one failed propagation does not block others.
- The `destruct()` method catches per-document errors (line 605), preventing one failed close from stopping others.

### Edge Cases

- Very large image dimensions (>12000px) are rejected by `sharpResize` (thumbnails.ts line 44).
- The preview cache cleanup on mount init handles filesystem errors silently.
- Text preview decodes with `fatal: true` to reject binary files masquerading as text.

---

## Test Coverage

### Well-Covered Areas

- **Mount operations**: Both `local-key` and `local` storage backends tested (create, read, write, delete, rename,
  move, breadcrumb, duplicate detection).
- **Name validation**: Thorough testing of path traversal attempts (`.`, `..`, `/`, `\`, null bytes).
- **ACL inheritance**: Extensive multi-level tests (A -> B -> C with various permission combinations).
- **Visibility**: public-read, public-write, private transitions tested.
- **Sharing lifecycle**: Full share -> read -> upgrade -> downgrade -> revoke cycle tested.
- **Previews**: Text (plain, markdown, code), image (PNG, JPEG), video redirect, unsupported types, caching.
- **Team drives**: Team mount creation, cross-member access, team member restrictions.

### Missing Test Coverage

1. **S3 storage backend**: No tests. All mount tests use `local-key` or `local` storage.
2. **`movePath` into descendant**: No test verifying that moving a folder into its own subtree is prevented (because
   it currently is not prevented).
3. **Cross-mount operations**: No tests for operations spanning multiple mounts.
4. **`removeMount`**: No test for mount removal behavior.
5. **Concurrent uploads**: No test for race conditions on duplicate filename detection.
6. **`closeCollabDocument` size update**: No test verifying the size written on close (which currently writes the
   wrong value -- see issue #11).
7. **`receiveACLChange` unshare path**: The missing `await` bug means the unshare path is never tested correctly,
   even though the test suite does test ACL revocation end-to-end (it passes because the route-level permission
   checks work correctly, masking the stale `shared.db` entry).
8. **Exiftool fallback**: Only tested via `isExiftoolCandidate` unit tests; no integration test for actual RAW/PSD
   preview extraction.
9. **Database open/close lifecycle**: No test for `Mount.openDatabase` / `Mount.closeDatabase` with temp file
   management.
10. **`SharedDrive` inherited methods**: No test verifying that `SharedDrive.getSharedPathsWithMe()` or
   `getSharedPathsByMe()` work correctly (they would crash -- see issue #16).

---

## Recommendations

1. **Fix the missing `await` on line 561 of `drive.ts`** -- this is the highest priority. It causes stale shared
   entries to accumulate. Add a targeted test for `receiveACLChange` unshare behavior.

2. **Add move-into-descendant check** in `movePath` to prevent cycle creation.

3. **Add write permission check on move target** -- check `canWrite` on `targetParentId`, not just `pathId`.

4. **Fix `closeCollabDocument` size** -- use the document's own size, not `mount.getTotalSize()`.

5. **Sanitize Content-Disposition filename** -- escape or encode special characters.

6. **Add path traversal guard to `LocalKeyStorage`** -- match the pattern already used in `LocalStorage`.

7. **Add ACL checks to `SharedDrive.openDatabase`/`closeDatabase`** -- wrap with permission checks.

8. **Refactor `SharedDrive`** -- switch from inheritance to composition to avoid exposing broken inherited methods.

9. **Add S3 storage tests** -- even if just with a mocked S3 endpoint, to catch the `getPath` and `BunFile` cast
   issues.

10. **Close mount resources in `removeMount`** -- close open databases and collab documents before removing.

---

## File Reference

| File | Line(s) | Issue |
|------|---------|-------|
| `apps/api/src/lib/drive/drive.ts` | 561 | Critical: missing `await` on `matchesACL` |
| `apps/api/src/lib/drive/drive.ts` | 357-364 | Missing ACL check on `downloadFile` |
| `apps/api/src/lib/drive/drive.ts` | 382-394 | Missing ACL check on `getPreview`/`getTextPreview` |
| `apps/api/src/lib/drive/drive.ts` | 315-338 | No descendant check on move |
| `apps/api/src/lib/drive/drive.ts` | 329 | Missing write check on move target |
| `apps/api/src/lib/drive/drive.ts` | 101-106 | `removeMount` leaks resources |
| `apps/api/src/lib/drive/drive.ts` | 505-509 | Wrong size written on collab close |
| `apps/api/src/lib/drive/sharedDrive.ts` | 200-210 | `openDatabase`/`closeDatabase` skip ACL |
| `apps/api/src/lib/drive/sharedDrive.ts` | 11, 43 | Broken inherited methods via `extends Drive` |
| `apps/api/src/routes/drive.ts` | 114 | Content-Disposition header injection |
| `apps/api/src/lib/storage/local-key-storage.ts` | 16-18 | No path traversal guard |
| `apps/api/src/lib/storage/s3-storage.ts` | (all) | Missing `getPath`, no tests |
| `apps/api/src/lib/mount/mount.ts` | 446 | `BunFile` cast on S3 `read()` result |
| `apps/api/src/lib/drive/sse-events.ts` | 73 | `as SSEvent` cast bypasses type safety |
| `apps/api/src/lib/drive/naming.ts` | 18 | `Date.now()` fallback not collision-safe |
