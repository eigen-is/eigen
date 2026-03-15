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

**Current limits**: 35MB single file (`routes/drive.ts:87`), 10MB multi-file (`routes/drive.ts:94`).

**Peak memory per upload**: ~3x file size (File object + ArrayBuffer + Buffer copy).

## Problem

At 1GB: ~3GB RAM per concurrent upload. 5 concurrent uploads = 15GB. This is unsustainable for a self-hosted app that
should run on modest hardware.

## Design

### Core Idea

Stream multipart body chunks directly to a temp file. Compute hash and size incrementally as chunks are written. After
the stream completes, move the temp file to final storage. Generate thumbnails from the file on disk, not from memory.

```
HTTP multipart chunks → temp file (streaming write)
                      → CryptoHasher.update() per chunk
                      → accumulate size
  → stream complete:
    → move temp file to storage
    → insert DB row (with hash + size)
    → generate thumbnail from disk path (if image)
```

### Memory Usage

~64KB per upload (one read buffer) regardless of file size, plus Sharp's working memory for thumbnail generation
(only for images, capped at 12000x12000px).

## Implementation

### 1. Streaming Multipart Parsing

Elysia's `t.File()` buffers the full file. Instead, use Bun's raw request body stream directly for the upload route.

**`apps/api/src/routes/drive.ts`** — new streaming upload endpoint:

```typescript
.post("/drive/:ownerId/:mountId/file-stream/:pathId", async ({params, request, user}) => {
    const drive = await getSharedDrive(params.ownerId, user);
    return await drive.uploadFileStreaming(params.mountId, params.pathId, request);
}, {auth: true})
```

Parse the multipart boundary from `Content-Type`, then stream body chunks. Use a lightweight multipart parser that emits
file data chunks without buffering the whole file. Options:

- **`@fastify/busboy`** — battle-tested streaming multipart parser, works with any ReadableStream
- **Manual boundary parsing** — simple for single-file uploads but error-prone for edge cases

Recommendation: `@fastify/busboy`. It's a single dependency with no sub-dependencies, and handles all multipart edge
cases (chunked boundaries, nested parts, etc.).

### 2. Drive.uploadFileStreaming()

**`apps/api/src/lib/drive/drive.ts`** — new method:

```typescript
async uploadFileStreaming(
    mountId: string,
    parentId: string,
    request: Request
): Promise<DrivePath> {
    const mount = this.getMount(mountId);
    const parent = await mount.getPath(parentId);
    // ... permission checks, name deduplication (same as current uploadFile) ...

    // Stream to temp file, computing hash + size incrementally
    const {tempPath, hash, size, mimeType, fileName} = await streamToTemp(mount.tmpDir, request);

    try {
        // Create DB record + move temp file to storage
        const pathId = await mount.createFileFromTemp(parentId, safeName, mimeType, size, hash, tempPath);

        // Thumbnail from disk (not memory)
        const storagePath = await mount.getStoragePath(pathId);
        const [thumbnail, imageDetails] = await Promise.all([
            saveThumbnailFromPath(mount.thumbsDir, pathId, storagePath, mimeType),
            extractImageDetailsFromPath(storagePath, mimeType)
        ]);
        // ... update path with thumbnail + details, emit SSE ...
    } finally {
        // Clean up temp file if it still exists (e.g. on error)
        try { await unlink(tempPath); } catch {}
    }
}
```

### 3. streamToTemp() Helper

The core streaming function. Parses multipart, writes chunks to a temp file, and computes hash + size incrementally.

```typescript
async function streamToTemp(tmpDir: string, request: Request): Promise<{
    tempPath: string;
    hash: string;
    size: number;
    mimeType: string;
    fileName: string;
}> {
    const tempPath = join(tmpDir, `upload-${randomUUID()}`);
    const writer = Bun.file(tempPath).writer();
    const hasher = new Bun.CryptoHasher('sha256');
    let size = 0;
    let mimeType = 'application/octet-stream';
    let fileName = 'unnamed';

    // Parse multipart stream — extract file metadata from headers, stream data chunks
    for await (const chunk of parseMultipartFile(request)) {
        if (chunk.type === 'header') {
            mimeType = chunk.mimeType;
            fileName = chunk.fileName;
        } else {
            hasher.update(chunk.data);
            writer.write(chunk.data);
            size += chunk.data.byteLength;
        }
    }

    await writer.end();
    return {tempPath, hash: hasher.digest('hex'), size, mimeType, fileName};
}
```

### 4. Mount.createFileFromTemp()

**`apps/api/src/lib/mount/mount.ts`** — new method that accepts a temp file path instead of a buffer:

```typescript
async createFileFromTemp(
    parentId: string,
    name: string,
    mimeType: string,
    size: number,
    hash: string,
    tempPath: string
): Promise<string> {
    validateName(name);
    await this.assertUniqueName(parentId, name);
    const fileId = randomUUID();
    const fileValue = this.isPathBased ? name : buildStorageKey(fileId, name);

    await this.db.insert(paths).values({
        id: fileId, file: fileValue, name, type: 'file',
        parentId, ownerId: this.ownerId, mimeType, size, hash,
        acl: null, createdAt: new Date(), updatedAt: new Date()
    });

    const storageKey = this.isPathBased
        ? await this.resolveStoragePath(fileId)
        : fileValue;
    await this.storage.moveFrom(tempPath, storageKey);

    return fileId;
}
```

### 5. StorageBackend.moveFrom()

**`apps/api/src/lib/storage/types.ts`** — add to interface:

```typescript
export interface StorageBackend {
    // ... existing methods ...
    moveFrom(sourcePath: string, key: string): Promise<void>;
}
```

Implementations:
- **LocalStorage / LocalKeyStorage**: `fs.rename(sourcePath, targetPath)` (atomic on same filesystem, which it will be
  since temp files are in the same mount directory)
- **S3Storage**: Read temp file as stream → `S3File.write()`, then delete temp file. Or use Bun S3's
  `file.write(Bun.file(sourcePath))` which handles the streaming internally.

### 6. Thumbnail Generation from Disk

**`apps/api/src/lib/shared/thumbnails.ts`** — Sharp already accepts file paths:

```typescript
async function saveThumbnailFromPath(
    thumbsDir: string,
    pathId: string,
    filePath: string,
    mimeType: string
): Promise<string | null> {
    if (!SUPPORTED_THUMBNAIL_TYPES.includes(mimeType)) return null;
    // Sharp accepts file paths directly — it streams internally, no full buffer needed
    const image = sharp(filePath);
    // ... same resize/convert logic ...
}
```

This is actually better than the current approach because Sharp can stream from disk instead of holding the full image
in memory.

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
`createFile()` to no longer accept data buffers — files are always created via `createFileFromTemp()` or `touchFile()`.

## File Changes

| File | Change |
|------|--------|
| `apps/api/src/routes/drive.ts` | New streaming upload endpoint |
| `apps/api/src/lib/drive/drive.ts` | `uploadFileStreaming()` method |
| `apps/api/src/lib/mount/mount.ts` | `createFileFromTemp()` method |
| `apps/api/src/lib/storage/types.ts` | `moveFrom()` on StorageBackend interface |
| `apps/api/src/lib/storage/local-storage.ts` | `moveFrom()` implementation (fs.rename) |
| `apps/api/src/lib/storage/local-key-storage.ts` | `moveFrom()` implementation (fs.rename) |
| `apps/api/src/lib/storage/s3-storage.ts` | `moveFrom()` implementation (stream + delete) |
| `apps/api/src/lib/shared/thumbnails.ts` | `saveThumbnailFromPath()` using file path instead of buffer |
| `packages/lib/src/core/drive/hooks/use-drive.ts` | Point upload hook at streaming endpoint |

## What About writeFile()?

`writeFile()` is used for inline editing saves (small text files, max 5MB). These are already in memory as strings
converted to buffers. No streaming needed — the current buffered approach is appropriate for this use case.

## What About Multi-File Uploads?

The multi-file endpoint (`/drive/:ownerId/:mountId/files/:pathId`) currently accepts multiple files at 10MB each via
`t.Files()`. For streaming, process each file part sequentially from the multipart stream — the parser emits parts in
order. Same `streamToTemp()` call per part.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Orphaned temp files on crash | Low | Cleanup on mount init: delete files in `tmp/` older than 1 hour |
| Partial upload on disconnect | Low | Temp file is cleaned up in `finally` block; DB row is only created after stream completes |
| `@fastify/busboy` dependency | Low | Well-maintained, no sub-deps, used by Node.js core internally |
| S3 multipart upload complexity | Medium | Start with buffered S3 write from temp file; optimize to S3 multipart upload later if needed |
| Thumbnail OOM on very large images | Low | Already guarded by 12000x12000px limit in Sharp; Sharp streams from disk |
| `fs.rename()` fails across filesystems | None | Temp dir is inside the mount dir (same filesystem) |
