# Proposal: Streaming Uploads for Drive

## TLDR

The upload pipeline currently buffers entire files in memory. At 35MB this is fine; at 1GB it means 1GB of RAM per
concurrent upload. Streaming uploads write incoming data directly to disk in chunks, keeping memory usage constant
(~64KB per upload) regardless of file size. The hash, size, and storage write all happen incrementally as chunks arrive.

## Current State

The upload pipeline is fully buffered at every stage:

```
HTTP multipart → Elysia parses full File into memory
  → drive.uploadFile() calls file.arrayBuffer() → Buffer.from(buffer)
    → mount.createFile() receives Buffer, computes hash, inserts DB row
      → storage.write() writes full buffer to disk via Bun.write()
    → saveThumbnail() loads full buffer into Sharp
```

**Current limits**: 35MB single file (`routes/drive.ts:91`), 10MB multi-file (`routes/drive.ts:98`).

**Peak memory per upload**: ~3x file size (Elysia's `File` object + `ArrayBuffer` from `.arrayBuffer()` + `Buffer`
copy via `Buffer.from()`).

## Problem

At 1GB: ~3GB RAM per concurrent upload. 5 concurrent uploads = 15GB. This is unsustainable for a self-hosted app that
should run on modest hardware.

## Existing Infrastructure to Reuse

Mount already has a `tmp/` directory and helper methods for temp file management:

- `mount.tmpDir` — `{baseDir}/tmp`, created on mount init
- `mount.getTempPath(id)` — deterministic temp path from ID
- `mount.uploadFromTemp(storageKey, tempId)` — moves temp file to storage via `storage.write(Bun.file(tempPath))`
- `mount.cleanupTemp(tempId)` — safe delete with error handling

`storage.write()` already accepts `BunFile`, so passing a temp file handle is efficient without needing any new
storage interface methods.

`saveThumbnail()` already accepts `string` (file path) as source. `generateThumbnail()` now passes file paths
directly to `sharp(filePath)`, so Sharp streams from disk internally without buffering the entire image.

## Design

### Core Idea

Stream multipart body chunks directly to a temp file in mount's existing `tmp/` directory. Compute hash and size
incrementally. After the stream completes, move temp file to storage via `uploadFromTemp()`, then insert the DB row.

```
HTTP multipart chunks → mount tmp file (streaming write)
                      → CryptoHasher.update() per chunk
                      → accumulate size
                      → enforce size limit (abort if exceeded)
  → stream complete:
    → move temp file to storage (uploadFromTemp)
    → insert DB row (with hash + size)
    → generate thumbnail from storage path
```

Note: the file is moved to storage **before** the DB row is inserted. If storage write fails, there is no orphaned
DB row to clean up.

### Memory Usage

~64KB per upload (one read buffer) regardless of file size, plus Sharp's working memory for thumbnail generation
(only for images, capped at 12000x12000px).

## Implementation

### 1. Streaming Multipart Parsing

Elysia's `t.File()` buffers the full file. Instead, use Bun's raw request body stream directly for the upload route.
Elysia must be told to skip body parsing for this route via `parse: 'none'` (or `type: 'none'`).

**`apps/api/src/routes/drive.ts`** — new streaming upload endpoint:

```typescript
.post("/drive/:ownerId/:mountId/file-stream/:pathId", async ({params, request, user}) => {
    const drive = await getSharedDrive(params.ownerId, user);
    return await drive.uploadFileStreaming(params.mountId, params.pathId, request);
}, {auth: true, parse: 'none'})
```

**Multipart parsing options:**

- **`@fastify/busboy`** — battle-tested streaming parser, but built for Node.js streams. Requires a compatibility
  shim to work with Bun's web-standard `ReadableStream` (e.g., `Readable.fromWeb(request.body)`). Verify Bun
  compatibility before committing to this.
- **Manual boundary parsing** — simpler than it sounds for single-file uploads: read boundary from `Content-Type`,
  scan chunks for boundary markers, emit data between them. Error-prone for edge cases (boundary split across chunks).
- **Bun-native alternative** — check if Bun exposes a streaming multipart API (it may in future versions).

Recommendation: prototype with `@fastify/busboy` + `Readable.fromWeb()` first. If Bun compatibility is problematic,
fall back to manual boundary parsing (acceptable for single-file upload which is the primary use case).

### 2. streamToTemp()

The core streaming function. Parses multipart, writes chunks to a mount temp file, and computes hash + size
incrementally. **Must enforce a size limit** — without Elysia's `t.File({maxSize})`, the server has no built-in
protection against unbounded uploads.

```typescript
async function streamToTemp(mount: Mount, request: Request, maxSize: number): Promise<{
    tempId: string;
    hash: string;
    size: number;
    mimeType: string;
    fileName: string;
}> {
    const tempId = randomUUID();
    const tempPath = mount.getTempPath(tempId);
    const writer = Bun.file(tempPath).writer();
    const hasher = new Bun.CryptoHasher('sha256');
    let size = 0;
    let mimeType = 'application/octet-stream';
    let fileName = 'unnamed';

    try {
        for await (const chunk of parseMultipartFile(request)) {
            if (chunk.type === 'header') {
                mimeType = chunk.mimeType;
                fileName = chunk.fileName;
            } else {
                size += chunk.data.byteLength;
                if (size > maxSize) {
                    throw new ApiError(413, `File exceeds maximum size of ${maxSize} bytes`);
                }
                hasher.update(chunk.data);
                writer.write(chunk.data);
            }
        }
        await writer.end();
    } catch (e) {
        await writer.end();
        await mount.cleanupTemp(tempId);
        throw e;
    }

    return {tempId, hash: hasher.digest('hex'), size, mimeType, fileName};
}
```

Note: uses `mount.getTempPath()` and `mount.cleanupTemp()` rather than inventing a parallel temp file scheme.

### 3. Drive.uploadFileStreaming()

**`apps/api/src/lib/drive/drive.ts`** — new method. Must also be wrapped in `SharedDrive` with `withWritePermission`
(same as existing `uploadFile`).

```typescript
async uploadFileStreaming(mountId: string, parentId: string, request: Request): Promise<DrivePath> {
    const mount = this.getMount(mountId);
    // ... permission checks, name deduplication (same as current uploadFile) ...

    const {tempId, hash, size, mimeType, fileName} = await streamToTemp(mount, request, MAX_STREAMING_UPLOAD_SIZE);

    try {
        // Move temp file to storage FIRST (before DB insert)
        const storageKey = mount.isPathBased ? safeName : buildStorageKey(fileId, safeName);
        await mount.uploadFromTemp(storageKey, tempId);

        // Now insert DB row — if this fails, orphaned storage file is less dangerous than orphaned DB row
        const pathId = await mount.createFileFromStorage(parentId, safeName, mimeType, size, hash, storageKey);

        // Thumbnail from storage (not memory)
        const [thumbnail, imageDetails] = await Promise.all([
            saveThumbnail(mount.thumbsDir, pathId, mount.getStoragePath(pathId), mimeType),
            extractImageDetails(mount.getStoragePath(pathId), mimeType)
        ]);
        // ... update path with thumbnail + details, emit SSE ...
    } finally {
        await mount.cleanupTemp(tempId);
    }
}
```

### 4. generateThumbnail() — Already Fixed

`generateThumbnail()` in `thumbnails.ts` now passes file paths directly to `sharp(filePath)` instead of buffering
via `Bun.file(source).arrayBuffer()`. No new function needed — `saveThumbnail()` already accepts string paths.

## SharedDrive Wrapping

`uploadFileStreaming()` must be added to `SharedDrive` with the same write-permission guard as `uploadFile()`:

```typescript
// sharedDrive.ts
public async uploadFileStreaming(mountId: string, parentId: string, request: Request) {
    return this.withWritePermission(mountId, parentId,
        () => this.sharedDrive.uploadFileStreaming(mountId, parentId, request));
}
```

Without this, shared drive users bypass permission checks on the streaming endpoint.

## Migration Strategy

### Phase 1: Add streaming endpoint alongside existing

Keep the existing buffered `/drive/:ownerId/:mountId/file/:pathId` endpoint as-is. Add the new streaming endpoint at a
different path. Update the frontend upload hook to use the streaming endpoint. This allows rollback by switching the
frontend back.

### Phase 2: Raise size limits

Once streaming is verified, raise single-file limit from 35MB to 1GB (or whatever target). The buffered endpoint can
keep its 35MB limit as a fallback.

### Phase 3: Remove buffered endpoint

Once the streaming endpoint is stable, remove the old buffered endpoint and the `uploadFile()` method. Update
`createFile()` to no longer accept data buffers — files are always created via `createFileFromStorage()` or
`touchFile()`.

## What About Multi-File Uploads?

The multi-file endpoint (`/drive/:ownerId/:mountId/files/:pathId`) accepts multiple files at 10MB each. These are
typically small files from drag-and-drop. The current buffered approach is fine for this use case — 10MB * N files is
manageable. No streaming needed here.

## What About writeFile()?

`writeFile()` is used for inline editing saves (small text files, max 5MB). These are already in memory as strings
converted to buffers. No streaming needed — the current buffered approach is appropriate for this use case.

## Out of Scope

- **Resumable uploads** (tus protocol) — valuable for very large files over unreliable connections, but a separate
  concern. Can be layered on top of this streaming infrastructure later.
- **Upload progress tracking** — requires SSE or WebSocket feedback channel. The streaming endpoint itself doesn't
  need modification, but the frontend would need a progress listener. Consider for a follow-up.
- **S3 multipart upload API** — for S3 storage, files > 5GB require S3's multipart upload API. Initial implementation
  can use buffered S3 write from temp file (which works up to 5GB). Optimize to S3 multipart later if needed.

## File Changes

| File | Change |
|------|--------|
| `apps/api/src/routes/drive.ts` | New streaming upload endpoint with `parse: 'none'` |
| `apps/api/src/lib/drive/drive.ts` | `uploadFileStreaming()` method |
| `apps/api/src/lib/drive/sharedDrive.ts` | Wrap `uploadFileStreaming()` with write permission |
| `apps/api/src/lib/mount/mount.ts` | `createFileFromStorage()` method (insert row for already-stored file) |
| `apps/api/src/lib/shared/thumbnails.ts` | **Done** — `generateThumbnail()` now uses `sharp(filePath)` for string sources |
| `packages/lib/src/core/drive/hooks/use-drive.ts` | Point upload hook at streaming endpoint |

Note: no changes needed to `StorageBackend` interface — `storage.write()` already accepts `BunFile`, and
`mount.uploadFromTemp()` already handles the temp-to-storage transfer.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Orphaned temp files on crash | Low | Cleanup on mount init: delete files in `tmp/` older than 1 hour (use existing `cleanupTemp()` pattern) |
| Partial upload on disconnect | Low | Temp file cleaned up in `finally`; DB row only created after storage write succeeds |
| `@fastify/busboy` + Bun compat | Medium | Prototype early; fall back to manual boundary parsing for single-file case |
| S3 files > 5GB | Medium | Initial limit of 5GB on S3 backends; S3 multipart upload as follow-up |
| Unbounded upload size | High | **Must enforce size limit** in `streamToTemp()` — no Elysia `maxSize` on raw body |
| Thumbnail OOM on very large images | Low | Already guarded by 12000x12000px limit in Sharp; `sharp(filePath)` already fixed to avoid buffer copy |
| `fs.rename()` fails across filesystems | None | Temp dir is inside the mount dir (same filesystem) |
| No concurrent upload limit | Medium | Consider a semaphore or per-user upload slot limit to prevent disk I/O saturation |
