# BE Code Review: Drive

## Summary

The Drive backend is well-structured with clean separation between the `Drive` class (business logic), `Mount` (storage
abstraction), `SharedDrive` (ACL-enforced proxy), and routing. The ACL system with additive inheritance is sound.
However, there are several missing `await` calls on async operations, path sanitization gaps in the rename flow, and the
`SharedDrive` class needs careful attention around its constructor pattern. The share propagation and preview systems
are solid overall.

## Critical Issues

### 1. Missing `await` on `receiveACLChange` database writes

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, lines 623-626
- **Issue**: The `sharedDb.delete()` and `sharedDb.update()` and `sharedDb.insert()` calls at lines 623, 628, 639 use
  `.run()` synchronously but the method `receiveACLChange` is `async`. While Drizzle's synchronous SQLite `.run()`
  should execute immediately with Bun's synchronous SQLite driver, the pattern is inconsistent with the rest of the
  codebase and fragile if the driver changes.
- **Why it matters**: If the database operations were ever to become async (e.g., switching to a different driver),
  these would silently become fire-and-forget.
- **Suggested fix**: No immediate fix needed for correctness with Bun's synchronous SQLite, but consider consistency by
  using `await` for all DB operations.

### 2. Missing `await` on `addRegistryEntry` in `acl-propagation.ts`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/acl-propagation.ts`, line 18
- **Issue**: `addRegistryEntry` is an `async` function (it calls `await getEigenDb()` inside), but it is called without
  `await` at line 18: `await addRegistryEntry(path.ownerId, acl.id)`. Actually, looking more carefully, line 18 does
  have `await`. Let me recheck... Yes, line 18 has `await`. However, in `registry.ts` line 7, `addRegistryEntry` calls
  `db.insert(...).run()` without `await`, which is fine for synchronous SQLite. No issue here.
- **Why it matters**: N/A after recheck.

### 3. Rename path does not sanitize `newName` for path traversal

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, line 360-375
- **Issue**: `renamePath` passes `newName` directly to `mount.updatePath`. While `updatePath` calls `validateName` which
  checks for `/`, `\\`, `\0`, `.` and `..`, this validation only runs when `updates.name !== undefined`. The name does
  get validated. However, the route at `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/drive.ts` line 161
  accepts `body.newName` with only `t.String()` validation -- no length limit.
- **Why it matters**: A user could submit an extremely long name (e.g., 10MB string) causing resource exhaustion or
  database issues.
- **Suggested fix**: Add `t.String({maxLength: 255})` to the rename route body schema, and similarly for folder/file
  creation names.

### 4. `SharedDrive` constructor calls `super(sharedHome)` which sets `this.owner` to the shared home's owner

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/sharedDrive.ts`, lines 11-19
- **Issue**: `SharedDrive extends Drive` and calls `super(sharedHome)`, which sets `this.owner = home.user` (Drive's
  constructor at line 63). The `SharedDrive` also stores `this.user = user` (the accessing user). This means
  `SharedDrive` has TWO user references: the inherited `this.owner` (from `Drive`) which is the resource owner, and
  `this.user` which is the accessing user. This is confusing but functionally correct because `SharedDrive` overrides
  all methods to delegate to `this.sharedDrive` with ACL checks using `this.user`.
- **Why it matters**: If any method is added to `Drive` without a corresponding override in `SharedDrive`, it will
  execute with the resource owner's identity but without ACL checks. This is documented as a known pitfall in CLAUDE.md.
- **Suggested fix**: Add a comment in `SharedDrive` to remind developers that every new public method in `Drive` needs
  an override. Consider a linting/test mechanism to detect missing overrides.

### 5. `SharedDrive.init()` is a no-op but base `Drive.init()` is required for functionality

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/sharedDrive.ts`, lines 43-44
- **Issue**: `SharedDrive.init()` is an empty method. This is correct because `SharedDrive` delegates to
  `this.sharedDrive` which is already initialized. But `getSharedDrive()` in `get-drive.ts` creates
  `new SharedDrive(home, user)` without calling `init()`. Since `init()` is a no-op, this is fine, but the pattern is
  unclear.
- **Why it matters**: Low risk -- just a readability concern.

### 6. `handleMovePath` in `drive-layout.tsx` has no try/catch or error toast

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/drive/drive-layout.tsx`, lines
  110-113
- **Issue**: `movePath.mutateAsync` is called without error handling. If the move fails, the error is swallowed.
- **Why it matters**: Violates the "every mutation needs error feedback" rule from CLAUDE.md.
- **Suggested fix**: Wrap in try/catch with `toast.error()`.

### 7. `handleSave` in `drive-access-dialog.tsx` has no try/catch

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/drive/drive-access-dialog.tsx`,
  lines 26-31
- **Issue**: `updateACL.mutateAsync` is called without try/catch. If the mutation fails, the promise rejects unhandled,
  and `setIsSubmitting(false)` at line 30 is never reached, leaving the dialog in a permanent "submitting" state.
- **Why it matters**: Both a UX bug (stuck dialog) and a CLAUDE.md rule violation (missing error feedback).
- **Suggested fix**: Wrap in try/catch, add `toast.error()`, ensure `setIsSubmitting(false)` runs in a `finally` block.

### 8. `uploadFile` allows uploading to collab-type containers

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, lines 218-268
- **Issue**: `uploadFile` checks `parent.type !== 'folder'` at line 221, which means it blocks upload into collab-type
  containers (doc, stickies, etc.) and chat containers, since those are not `'folder'`. This is correct behavior. No
  issue.

### 9. `deleteFile` delegates to `deleteFolder` for collab types without write check on parent

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, lines 301-319
- **Issue**: `deleteFile` checks `canWrite` on the file itself (line 313), but for collab types it delegates to
  `deleteFolder` (line 309) which also checks `canWrite` on the pathId (line 285). The `SharedDrive` version of
  `deleteFile` checks `withParentWritePermission` (line 193), while the base `Drive.deleteFile` checks write on the file
  itself. This inconsistency means in the base Drive (own files), you need write on the file, but via SharedDrive you
  need write on the parent. For collab types routed through `deleteFolder`, the base Drive checks write on the collab
  folder itself.
- **Why it matters**: The permission model for deletion is inconsistent between `Drive` and `SharedDrive`, though in
  practice the base Drive only runs for the owner who always has write access.
- **Suggested fix**: Consider unifying: deletion should check write permission on the parent folder, consistent with
  typical filesystem semantics.

### 10. `movePath` ancestor check can NPE

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, lines 344-351
- **Issue**: Line 349: `ancestor = (await mount.getPath(ancestor.parentId))!;` uses `!` assertion. If `getPath` returns
  null (e.g., database inconsistency), the next iteration accesses `ancestor.parentId` which throws. Line 350 does check
  `if (!ancestor) break;` but the `!` assertion on line 349 suppresses the TypeScript null check.
- **Why it matters**: Could cause an unhandled runtime error in edge cases.
- **Suggested fix**: Remove the `!` assertion:
  `const next = await mount.getPath(ancestor.parentId); if (!next) break; ancestor = next;`

## Pattern Violations

### Missing name length validation on route schemas

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/drive.ts`, multiple locations
- **Issue**: `t.String()` is used without `maxLength` for `folderName`, `fileName`, `newName`. Combined with
  `t.String()` for `targetParentId`, there's no server-side validation on string length.
- **Pattern**: CLAUDE.md says "Sanitize user-provided paths and filenames"
- **Suggested fix**: Add `t.String({minLength: 1, maxLength: 255})` to all name fields.

### `createCollabDoc` does not sanitize `name` for control characters

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, line 679
- **Issue**: The `name` parameter is concatenated with an extension but not sanitized for control characters. While
  `Mount.createFolder` calls `validateName` which checks for `/`, `\\`, `\0`, it does not check for other control
  characters (`\x01`-`\x1f`).
- **Why it matters**: Control characters in filenames can cause issues with some filesystems and HTTP headers.
- **Suggested fix**: Extend `validateName` in `mount.ts` to reject control characters:
  `if (/[\x00-\x1f]/.test(name)) throw ...`

### `createFolder` name sanitization uses only `/` and `\\`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, line 169
- **Issue**: `folderName.replace(/[/\\]/g, '_')` silently replaces slashes but does not reject the input. Control
  characters, `..`, etc. are handled by `validateName` in `mount.ts`, but the Drive-level replace could mask issues.
- **Why it matters**: The silent replacement may surprise users who intended to create a folder with a specific name.
- **Suggested fix**: Reject names containing `/` or `\\` instead of silently replacing. Let `validateName` handle it.

## Security Concerns

### 1. Download `Content-Disposition` header uses `originalName` from `details`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/drive.ts`, line 115
- **Issue**: `path.details?.originalName` is user-provided data stored during upload. It's sanitized with
  `replace(/[\x00-\x1f"\\]/g, '_')` which handles control chars, double quotes, and backslashes. However, the RFC 6266
  spec requires RFC 5987 encoding for non-ASCII characters. The current approach works for ASCII filenames but could
  produce invalid headers with Unicode names.
- **Why it matters**: Non-ASCII filenames in the `Content-Disposition` header may not download correctly across all
  browsers.
- **Suggested fix**: Use RFC 5987 encoding: `filename*=UTF-8''${encodeURIComponent(displayName)}` alongside the ASCII
  fallback.

### 2. `embed` route does not set `Content-Type` header

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/drive.ts`, lines 122-127
- **Issue**: The `/embed/:fileName` endpoint returns file data for inline display (video, audio, PDF) but does not
  explicitly set `Content-Type`. Elysia may infer it from the response, but for user-uploaded files, the stored
  `mimeType` should be used.
- **Why it matters**: Incorrect MIME type could cause browsers to mishandle the file or create XSS vectors (e.g.,
  serving HTML as the embed).
- **Suggested fix**: Set `set.headers['Content-Type'] = path.mimeType;` and potentially add
  `Content-Security-Policy: sandbox` for HTML content.

### 3. `getThumbnail` extracts `pathId` from `fileName` parameter

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, line 460
- **Issue**: `fileName.split('.')[0]` is used to extract the pathId from the URL parameter. This is used to look up a
  thumbnail file on disk. The `fileName` comes from the URL path segment `/:fileName`. While this is just used as a
  lookup key and the thumbnail path is joined with `thumbsDir`, the approach of parsing user input to derive a
  filesystem path ID is fragile.
- **Why it matters**: Low risk since the pathId is just used as a flat filename in the thumbs directory, but the pattern
  is worth noting.

### 4. No rate limiting on file upload routes

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/drive.ts`, lines 90-105
- **Issue**: While quota enforcement exists via `enforceFileUpload`/`enforceBatchUpload`, there's no rate limiting to
  prevent rapid-fire upload requests that could overwhelm the server.
- **Why it matters**: A malicious user could send many small files rapidly to stress the server.
- **Suggested fix**: Add rate limiting middleware to upload routes.

## Data Integrity

### 1. `propagateACLChange` silently swallows errors

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/acl-propagation.ts`, lines 33-35
- **Issue**: When propagating ACL changes to other users, errors are caught and logged but the operation continues. This
  means some users may not receive share updates.
- **Why it matters**: Silent partial failures can lead to inconsistent sharing state.
- **Suggested fix**: Consider accumulating errors and retrying failed propagations, or adding them to a retry queue.

### 2. `uploadFile` deduplication creates counter-suffixed name but original name tracking is misleading

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, lines 229-237, 252-255
- **Issue**: When a file with the same name exists, `getUniqueFileName` generates a new name (e.g., `file#1.txt`). The
  `originalName` stored in `details` is set to `safeName` (the sanitized original, line 255), but this is the same
  regardless of whether deduplication occurred. The actual stored filename (`safeName` which may be renamed) is the
  `name` field.
- **Why it matters**: The `originalName` detail always stores the pre-dedup name, which is correct for download
  purposes. No issue after closer inspection.

### 3. `deleteFolder` recurses to close collab documents and propagate ACL removal

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, lines 274-299
- **Issue**: `closeCollabDocumentsRecursively` and `propagateACLRemovalRecursively` both recurse through the folder
  tree, and then `mount.deletePath` also recurses to delete descendants. This means the tree is traversed three times.
- **Why it matters**: Performance concern for deeply nested folders with many files. Not a correctness bug.
- **Suggested fix**: Consider combining the recursive operations into a single traversal.

### 4. Race condition in `getUniqueFileName` check

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, lines 232-236
- **Issue**: The existence check at line 232 and the listing at line 234 are not atomic with the creation at line 240.
  Another concurrent upload of the same file name could create a duplicate.
- **Why it matters**: With concurrent uploads, `assertUniqueName` in `mount.createFile` will catch this and throw a 409,
  so it's handled but not gracefully.

## Code Quality

### 1. `SharedDrive` has significant code duplication

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/sharedDrive.ts`
- **Issue**: Every method in `SharedDrive` follows the pattern: check permission, delegate to `this.sharedDrive`. The
  `withReadPermission` and `withWritePermission` helpers reduce some duplication, but the creation methods (lines
  122-176) all repeat the same pattern without using the helpers.
- **Suggested fix**: Use `withWritePermission` consistently for creation methods, passing `parentId` and a lambda.

### 2. `getPathsByMimeType` SQL query formatting

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mount/mount.ts`, lines 566-628
- **Issue**: The SQL template literal for `excludeDocumentChildren` produces poorly formatted SQL with lots of
  whitespace due to JavaScript template literal handling. While functionally correct, it's hard to read.
- **Suggested fix**: Use a more compact string or a helper to build the recursive CTE.

### 3. `toHtml` function in `text-preview.ts` uses `any`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/preview/text-preview.ts`, lines 79-97
- **Issue**: The `toHtml` function parameter uses inline type with `any[]` and `Record<string, any>`. This is a local
  utility function so the impact is limited, but it could use the actual lowlight AST types.
- **Suggested fix**: Import and use the `hast` types from the lowlight library.

### 4. Dead parameter in `logStructure`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/mount/mount.ts`, line 711
- **Issue**: `logStructure` is marked with `@ts-ignore` and described as a debug utility. It uses emoji characters in
  console output.
- **Why it matters**: Minor -- debug code left in production. Should be removed or gated behind a debug flag.

## Architecture

### 1. `SharedDrive` extends `Drive` rather than implementing an interface

- **Issue**: The inheritance-based approach means `SharedDrive` must override every method of `Drive` that should have
  different behavior. An interface-based approach (e.g., `IDrive` interface implemented by both `Drive` and
  `SharedDrive`) would make missing overrides a compile-time error.
- **Why it matters**: This is the #1 pitfall documented in CLAUDE.md for the Drive domain.
- **Suggested fix**: Extract an `IDrive` interface and have both classes implement it. This would turn the runtime risk
  into a compile-time error.

### 2. Preview cache uses filesystem timestamp in cache key

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/preview/preview-cache.ts`, lines 14-16
- **Issue**: `getScreenCacheKey` uses `updatedAt.getTime()` which depends on the Date serialization from SQLite. If the
  timestamp has millisecond precision issues (SQLite stores as integer seconds via `unixepoch()`), the cache key could
  collide incorrectly.
- **Why it matters**: Stale previews could be served if the timestamp granularity is too coarse.

### 3. Collab document singleton uses `owner.id` in key but `SharedDrive` delegates to the owner's Drive

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/drive/drive.ts`, line 544
- **Issue**: The singleton key is `${this.owner.id}.${mountId}.${pathId}`. Since `SharedDrive` delegates
  `getCollabDocument` to `this.sharedDrive` (the owner's Drive instance), the singleton is correctly per-owner. This is
  correct.

## Positive Patterns

1. **Clean ACL inheritance model**: The additive, recurse-to-parent ACL check is simple and correct.
   `filterRedundantACL` prevents ACL bloat.

2. **`SharedDrive` ACL proxy**: Wrapping the owner's Drive with permission checks is a solid pattern for cross-user
   access.

3. **Storage backend abstraction**: The `Mount` class cleanly abstracts `LocalKeyStorage`, `LocalStorage`, and
   `S3Storage` behind a common interface with proper temp-file handling for remote backends.

4. **Optimistic concurrency for inline editing**: The `expectedUpdatedAt` / conflict response pattern is
   well-implemented.

5. **Singleton pattern for document databases**: `createAsyncSingleton` ensures each document DB opens only once,
   preventing resource leaks.

6. **SSE event builder pattern**: The template-based `buildDriveEvent` is clean and extensible.

7. **Quota enforcement at route level**: File uploads are checked against quotas before reaching the business logic.

8. **`validateName` in Mount**: Centralized name validation prevents path traversal at the storage layer.

## Recommendations

| Priority | Issue                                                                                 | Location                                             |
|----------|---------------------------------------------------------------------------------------|------------------------------------------------------|
| P0       | Add try/catch with `toast.error()` to `handleMovePath` and `handleSave` in ACL dialog | `drive-layout.tsx:110`, `drive-access-dialog.tsx:26` |
| P0       | Fix `setIsSubmitting(false)` not reached on error in ACL dialog                       | `drive-access-dialog.tsx:26-31`                      |
| P1       | Add `maxLength` to all name/string fields in route schemas                            | `apps/api/src/routes/drive.ts`                       |
| P1       | Extend `validateName` to reject control characters `\x01-\x1f`                        | `apps/api/src/lib/mount/mount.ts:34`                 |
| P1       | Set `Content-Type` header on embed route using stored mimeType                        | `apps/api/src/routes/drive.ts:122`                   |
| P1       | Use RFC 5987 encoding for `Content-Disposition` with non-ASCII filenames              | `apps/api/src/routes/drive.ts:115`                   |
| P1       | Fix `movePath` ancestor check to avoid `!` assertion on possibly-null value           | `apps/api/src/lib/drive/drive.ts:349`                |
| P2       | Extract `IDrive` interface to make missing `SharedDrive` overrides a compile error    | Architecture                                         |
| P2       | Reduce code duplication in `SharedDrive` creation methods                             | `sharedDrive.ts:122-176`                             |
| P2       | Add Content-Security-Policy sandbox header for embed route                            | `apps/api/src/routes/drive.ts:122`                   |
| P2       | Consider combining recursive operations in `deleteFolder` into single traversal       | `drive.ts:274-299`                                   |
| P2       | Remove or gate `logStructure` debug method                                            | `mount.ts:711`                                       |
