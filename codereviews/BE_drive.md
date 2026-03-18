# Backend Review: Drive (Storage, Mounts, ACL, Previews)

**Scope:** `apps/api/src/lib/{drive,mount,storage,preview}/`, `apps/api/src/routes/drive.ts`
**Reviewed:** 2026-03-18

---

## Critical Issues

### 1. Missing `await` on async `matchesACL` in `receiveACLChange`

**File:** `apps/api/src/lib/drive/drive.ts:561`
**Status:** Previously found -- verified and confirmed

```typescript
if (newACL === null || !matchesACL(newACL, this.owner, 'read')) {
```

`matchesACL` is `async` (returns `Promise<boolean>`, defined at `acl.ts:66`). Without `await`, `!matchesACL(...)` evaluates `!Promise` which is always `false`. The unshare branch is taken only when `newACL === null` (full ACL removal). When a user's individual entry is removed but other ACL entries remain (newACL is non-null), the condition short-circuits to `false` and the stale entry is never deleted from `shared.db`.

**Impact:** Stale entries accumulate in shared.db indefinitely. Users continue seeing items in "shared with me" after their access is revoked. Actual access checks (which do `await`) correctly deny access, so this is a data-consistency / UX bug, not a privilege escalation.

**Fix:**
```typescript
if (newACL === null || !(await matchesACL(newACL, this.owner, 'read'))) {
```

### 2. `SharedDrive` missing overrides for `createSlides` and `createSheets`

**File:** `apps/api/src/lib/drive/sharedDrive.ts`
**Status:** New finding

`SharedDrive` overrides `createDoc`, `createStickies`, and `createChat` (delegating to `this.sharedDrive` with write permission checks), but does NOT override `createSlides` or `createSheets`. These are inherited from `Drive`, which calls `this.getMount(mountId)`. Since `SharedDrive.init()` is a no-op, `this.mounts` is empty, so `getMount` throws `ApiError(404, 'Mount not found')` for any mount.

The routes at `drive.ts:62-74` call `drive.createSlides()` and `drive.createSheets()` via `getSharedDrive()`. When `ownerId !== user.id`, this always fails with a 404 error even if the user has write permission.

**Impact:** Creating slides or sheets on shared drives (including team drives) is broken. Only the drive owner can create them.

**Fix:** Add overrides matching the existing pattern:
```typescript
public async createSlides(mountId: string, parentId: string, name: string): Promise<DrivePath> {
    if (!(await this.canWrite(mountId, parentId, this.user))) {
        throw new ApiError(403, 'No write permission');
    }
    return this.sharedDrive.createSlides(mountId, parentId, name);
}

public async createSheets(mountId: string, parentId: string, name: string): Promise<DrivePath> {
    if (!(await this.canWrite(mountId, parentId, this.user))) {
        throw new ApiError(403, 'No write permission');
    }
    return this.sharedDrive.createSheets(mountId, parentId, name);
}
```

---

## Important Issues

### 3. `SharedDrive` inherits broken `getSharedPathsWithMe` and `getSharedPathsByMe`

**File:** `apps/api/src/lib/drive/sharedDrive.ts`
**Status:** Previously found -- verified, impact clarified

`SharedDrive` does not override `getSharedPathsWithMe()`, `getSharedPathsByMe()`, or `getSharedWith()`. These inherited methods access `this.sharedDb`, which is never initialized in `SharedDrive` (set via `init()` which is a no-op). Calling any of these crashes with "Cannot read properties of undefined".

Routes at `drive.ts:19-26` call these through `getSharedDrive()`. If `ownerId !== user.id`, a `SharedDrive` is returned and these methods crash. The routes `/drive/:ownerId/shared/by-me` and `/drive/:ownerId/shared/with-me` are affected.

Separately, the `/drive/:ownerId/shared-with-me` route (line 27-30) correctly bypasses `getSharedDrive` and calls `ownerHome.drive.getSharedWith(user)` directly, so that route works.

**Impact:** 500 error when requesting shared paths for a user other than yourself, or for team drives.

**Fix:** Either override these in `SharedDrive` or restrict the routes to only accept `user.id` as the ownerId.

### 4. Folder deletion does not propagate ACL removal for descendants

**File:** `apps/api/src/lib/drive/drive.ts:285-286`
**Status:** New finding

When deleting a folder, ACL propagation only happens for the folder itself:
```typescript
await mount.deletePath(pathId);
await propagateACLChange(folder, folder.acl, null);
```

If descendants have their own ACL entries, those are deleted from storage (via `mount.deletePath` recursive deletion) but the corresponding `shared.db` entries in recipients' databases are never removed. For example: if folder A has ACL for Bob and subfolder B has ACL for Carol, deleting A removes Bob's shared entry but leaves Carol's entry for the now-deleted subfolder B.

**Impact:** Stale entries in `shared.db` for users who had access to descendants of deleted folders. Same as issue 1: they see phantom items in "shared with me" that return errors when accessed.

**Fix:** Before calling `mount.deletePath`, collect all paths with ACL entries recursively, then propagate null for each after deletion:
```typescript
const pathsWithACL = await this.collectACLPathsRecursively(mount, pathId);
await mount.deletePath(pathId);
for (const p of pathsWithACL) {
    await propagateACLChange(p, p.acl, null);
}
```

### 5. `movePath` allows moving a folder into its own descendant

**File:** `apps/api/src/lib/drive/drive.ts:315-338`
**Status:** Previously found -- verified

The `movePath` method does not check whether `targetParentId` is a descendant of `pathId`. Moving a folder into its own subtree creates an orphan cycle -- the folder and all its descendants become unreachable from root.

The check at line 324-327 verifies the target parent is a folder and the user has write permission on the source, but does not walk the ancestry.

**Impact:** Data corruption -- orphaned subtrees that are invisible in the UI but still consume storage. No way to recover without direct DB manipulation.

**Fix:** Walk from `targetParentId` to root; if `pathId` is encountered, throw 400.

### 6. `movePath` does not check write permission on target parent

**File:** `apps/api/src/lib/drive/drive.ts:329`
**Status:** Previously found -- verified

Only write permission on the source path is checked:
```typescript
if (!(await this.canWrite(mountId, pathId, this.owner))) {
```

No check on `targetParentId`. A user with read access to a folder and write access to a file elsewhere could move that file into the read-only folder. The `SharedDrive.movePath` (line 179-183) also only checks write on the source.

**Impact:** Users can move items into folders where they don't have write permission, bypassing the ACL model.

**Fix:** Add `canWrite(mountId, targetParentId, this.owner)` check.

### 7. `closeCollabDocument` writes mount total size instead of document size

**File:** `apps/api/src/lib/drive/drive.ts:505-509`
**Status:** Previously found -- verified

```typescript
const size = await mount.getTotalSize();
await mount.updatePath(pathId, {size});
```

`mount.getTotalSize()` returns the sum of all file sizes in the entire mount (all files, not just this document). This value is stored as the document's size. As more files are added to the mount, every document that gets closed will have its size inflated to the mount total.

**Impact:** All collab document sizes are wrong in the UI. On a busy mount, sizes could be megabytes larger than reality. Size-based quota calculations would also be affected.

**Fix:** Either compute the document's own DB file size, or skip the size update (the DB path entry doesn't represent a traditional file).

### 8. Content-Disposition header injection via filename

**File:** `apps/api/src/routes/drive.ts:114`
**Status:** Previously found -- verified

```typescript
const displayName = path.details?.originalName || path.name;
set.headers['Content-Disposition'] = `attachment; filename="${displayName}"`;
```

`originalName` comes directly from the uploaded file's original name, stored without sanitization for header-special characters. A filename containing `"`, `\n`, or `\r` produces a malformed or injectable Content-Disposition header. `path.name` is sanitized for `/` and `\` but not for quotes or control characters.

**Impact:** HTTP response splitting/header injection. In practice, modern browsers and Elysia's response handling mitigate most exploitation, but it's still a correctness issue.

**Fix:** Use RFC 5987 encoding or sanitize:
```typescript
const safeName = displayName.replace(/["\\\r\n]/g, '_');
set.headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
```

### 9. `removeMount` does not close mount resources

**File:** `apps/api/src/lib/drive/drive.ts:101-106`
**Status:** Previously found -- verified

```typescript
async removeMount(mountId: string): Promise<void> {
    if (mountId === this.defaultMountId) {
        throw new ApiError(400, 'Cannot remove default mount');
    }
    this.mounts.delete(mountId);
}
```

Open databases in `Mount.documentDbs`, sync timers, and file handles are not closed. The mount's `ManagedDatabase` instances hold open SQLite connections and sync timers that continue running until Home destructs.

**Impact:** Resource leaks (file handles, timers, memory) after mount removal. No physical storage cleanup.

**Fix:** Close the mount's document DBs and metadata DB before removing from the map.

### 10. `getStorageFile` casts S3File to BunFile

**File:** `apps/api/src/lib/mount/mount.ts:444-447`
**Status:** Previously found -- verified, impact clarified

```typescript
async getStorageFile(pathId: string): Promise<BunFile> {
    const storageKey = await this.getStorageKey(pathId);
    return this.storage.read(storageKey) as BunFile;
}
```

For S3 storage, `read()` returns `S3File`. The `as BunFile` cast silences TypeScript. The caller at `drive.ts:243` does `storageFile.name!` to get the file path, which for S3File returns the S3 key (e.g., `prefix/uuid.ext`), not a local filesystem path.

This path is then passed to `saveThumbnail` as the `source` parameter. Inside `generateImagePreview`, when `source` is a string, it's treated as a local file path for sharp to read. For S3 mounts, this path doesn't exist on disk, so sharp fails and returns null. Thumbnails silently fail on S3 mounts.

Similarly, `getScreenPreview` at `preview-cache.ts:47` does `storageFile.name!` for the file path -- image previews also fail silently for S3 mounts.

**Impact:** No thumbnails or image previews for S3-backed mounts. No error reported to the user.

**Fix:** For remote mounts, download to temp before thumbnail/preview generation, or change `getStorageFile` to return a union type.

---

## Minor Issues

### 11. `SharedDrive.openDatabase` and `closeDatabase` skip ACL checks

**File:** `apps/api/src/lib/drive/sharedDrive.ts:200-210`
**Status:** Previously found -- verified, risk assessment adjusted

These methods delegate directly to the owner's drive without permission checks. In practice, callers (collab system, chat) perform their own access checks before calling these, and the `pathId` is internally derived. The risk is low but breaks the pattern that every `SharedDrive` method wraps with permission checks.

**Impact:** Low. Defense-in-depth concern only.

### 12. Path traversal protection inconsistent across storage backends

**File:** `apps/api/src/lib/storage/local-key-storage.ts:16-18` vs `local-storage.ts:18-23`
**Status:** Previously found -- verified, risk assessment adjusted

`LocalStorage.resolve()` has explicit path traversal detection. `LocalKeyStorage.getFilePath()` does not. Keys for `LocalKeyStorage` are always generated internally via `buildStorageKey` (UUID + extension), so the attack surface is minimal. But any future code that passes user-controlled input to `getFilePath` would be vulnerable.

**Impact:** Low (defense-in-depth). Currently safe because keys are always UUID-based.

### 13. `uploadFile` parent type check is stricter than `createFolder`

**File:** `apps/api/src/lib/drive/drive.ts:215` vs `drive.ts:155`
**Status:** Previously found -- verified

- `createFolder` checks `isContainerType(parent.type)` -- allows creating folders inside docs, chats, etc.
- `uploadFile` checks `parent.type !== 'folder'` -- only allows uploading into plain folders.

This asymmetry is likely intentional (collab types manage their own child files through the collab system, not through direct upload), but it's undocumented and could confuse API consumers.

### 14. `getUniqueFileName` Date.now fallback not collision-safe

**File:** `apps/api/src/lib/drive/naming.ts:20`
**Status:** Previously found -- verified

The `Date.now()` fallback after 10,000 counter iterations is not checked against `usedNames`. Two calls in the same millisecond could collide. In practice this path is nearly unreachable (requires 10,000+ files with the same base name), and `assertUniqueName` at the DB level provides a final check.

**Impact:** Negligible. Theoretical only.

### 15. `buildDriveEvent` uses `as SSEvent` cast

**File:** `apps/api/src/lib/drive/sse-events.ts:73`
**Status:** Previously found -- verified

The `as SSEvent` cast bypasses type checking on the constructed event object. If the `SSEvent` type evolves, invalid events would be silently produced.

**Impact:** Type-safety concern only. No runtime impact currently.

### 16. `SharedDrive.breadCrumb` reverses a mutation of the original array

**File:** `apps/api/src/lib/drive/sharedDrive.ts:186-198`
**Status:** New finding

```typescript
public async breadCrumb(mountId: string, pathId: string) {
    const bread = await this.sharedDrive.breadCrumb(mountId, pathId);
    const crumb: DrivePath[] = [];
    while (bread.length > 0) {
        const path = bread.pop();
        ...
    }
    return crumb.reverse();
}
```

The method pops from `bread` (mutating the array from `this.sharedDrive.breadCrumb`), building `crumb` in reverse order (deepest first), then reverses it. The logic is correct but unnecessarily complex. It iterates from deepest to root, breaking when the user loses read access. Items above the user's access boundary are excluded.

The only subtle issue: `bread.pop()` could return `undefined` if `bread` is empty, but the `while (bread.length > 0)` guard prevents that. No bug here, just unusual style.

**Impact:** None. Observation only.

### 17. S3Storage `write` returns `await file.write(data)` but S3File.write may return void

**File:** `apps/api/src/lib/storage/s3-storage.ts:48-52`
**Status:** New finding

```typescript
async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
    const file = this.read(key);
    const written = await file.write(data);
    return written;
}
```

The `StorageBackend` interface declares `write` returns `Promise<number>`. Bun's `S3File.write()` returns `Promise<number>` for most inputs, so this should work. However, unlike `Bun.write()` which always returns the byte count, `S3File.write()` behavior may vary by input type.

**Impact:** Low. The return value is only used by `mount.writeFile` which independently computes size from the input data.

---

## Observations

### Architecture compliance

The code follows documented patterns well:
- Domain class `Drive` owned by `Home` singleton
- Thin routes delegating to `getSharedDrive()`
- Drizzle ORM schemas with `db-config.ts` migrations
- Pluggable storage backends implementing `StorageBackend` interface
- SSE events via `buildDriveEvent()` + `home.notify()`
- Additive ACL inheritance as documented

### SharedDrive composition vs inheritance

`SharedDrive extends Drive` but overrides `init()` to a no-op and delegates all overridden methods to `this.sharedDrive` (the actual owner's Drive instance). This is effectively composition disguised as inheritance. The base class fields (`mounts`, `sharedDb`, `documents`) are never initialized but remain accessible through inherited methods that aren't overridden (creating bugs 2 and 3 above). Switching to composition would eliminate this class of bugs.

### Concurrency

- `withPathLock` in Mount (lines 293-306) provides per-path mutual exclusion for rename/move on path-based storage. Well-implemented using promise-based queuing.
- No locking for concurrent uploads to the same folder. Two concurrent uploads of the same filename could both pass `getChildByName` before either inserts. `assertUniqueName` at insert time provides the final guard, but the second upload would get a 409 error rather than an auto-rename.
- `createAsyncSingleton` for collab document DBs prevents duplicate opens correctly.

### Error handling

- Storage `delete` errors are caught and logged, returning `false` -- graceful degradation.
- Thumbnail generation failures return `null` -- uploads succeed without thumbnails.
- Preview generation failures return `null` -- route returns 404.
- `propagateACLChange` catches errors per-user (line 34), preventing one failure from blocking others.
- `destruct()` catches per-document errors (line 605), preventing cascade failures.

### Edge cases handled well

- Very large images (>12000px) rejected by `sharpResize` (thumbnails.ts:44).
- Preview cache cleanup handles filesystem errors silently.
- Text preview decodes with `fatal: true` to reject binary files.
- Root folder deletion explicitly blocked.
- Name validation catches `.`, `..`, `/`, `\`, and null bytes.

---

## Test Coverage Gaps

1. **S3 storage backend**: No tests. All mount tests use local-key or local storage.
2. **`movePath` into descendant**: No test (because prevention doesn't exist yet -- see issue 5).
3. **`SharedDrive.createSlides`/`createSheets`**: No test (would reveal bug 2).
4. **`SharedDrive.getSharedPathsWithMe`/`getSharedPathsByMe`**: No test (would reveal bug 3).
5. **`removeMount` lifecycle**: No test for resource cleanup on mount removal.
6. **Concurrent uploads**: No race-condition test for duplicate filename detection.
7. **`closeCollabDocument` size**: No test for the stored size value (would reveal bug 7).
8. **`receiveACLChange` unshare**: Tests pass because route-level checks mask the stale shared.db entry from bug 1.
9. **Recursive folder deletion with descendant ACLs**: No test (would reveal bug 4).

---

## File Reference

| File | Line(s) | Issue # | Severity |
|------|---------|---------|----------|
| `apps/api/src/lib/drive/drive.ts` | 561 | 1 | Critical |
| `apps/api/src/lib/drive/sharedDrive.ts` | (missing) | 2 | Critical |
| `apps/api/src/lib/drive/sharedDrive.ts` | inherits | 3 | Important |
| `apps/api/src/lib/drive/drive.ts` | 285-286 | 4 | Important |
| `apps/api/src/lib/drive/drive.ts` | 315-338 | 5 | Important |
| `apps/api/src/lib/drive/drive.ts` | 329 | 6 | Important |
| `apps/api/src/lib/drive/drive.ts` | 505-509 | 7 | Important |
| `apps/api/src/routes/drive.ts` | 114 | 8 | Important |
| `apps/api/src/lib/drive/drive.ts` | 101-106 | 9 | Important |
| `apps/api/src/lib/mount/mount.ts` | 444-447 | 10 | Important |
| `apps/api/src/lib/drive/sharedDrive.ts` | 200-210 | 11 | Minor |
| `apps/api/src/lib/storage/local-key-storage.ts` | 16-18 | 12 | Minor |
| `apps/api/src/lib/drive/drive.ts` | 215 vs 155 | 13 | Minor |
| `apps/api/src/lib/drive/naming.ts` | 20 | 14 | Minor |
| `apps/api/src/lib/drive/sse-events.ts` | 73 | 15 | Minor |
| `apps/api/src/lib/drive/sharedDrive.ts` | 186-198 | 16 | Minor |
| `apps/api/src/lib/storage/s3-storage.ts` | 48-52 | 17 | Minor |
