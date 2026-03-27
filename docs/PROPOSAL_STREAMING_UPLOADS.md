# Proposal: Streaming Uploads for Drive

## TLDR

The upload pipeline currently buffers entire files in memory ~3x (Elysia File + ArrayBuffer + Buffer copy). At 35MB
this is fine; at 1GB it means ~3GB RAM per concurrent upload. This proposal replaces the buffered pipeline with true
streaming: chunks are written to disk as they arrive, keeping memory at ~256KB per upload regardless of file size.

One new dependency: `@mjackson/multipart-parser` — web-standard streaming multipart parser, zero transitive
dependencies, tested on Bun.

## Current State

```
HTTP multipart → Elysia parses full File into memory
  → drive.uploadFile() calls file.arrayBuffer() → Buffer.from(buffer)
    → mount.createFile() receives Buffer, computes hash, writes to storage, inserts DB row
    → saveThumbnail() loads buffer into Sharp
```

**Current limits**: 35MB single file, 10MB per file in batch upload (configured in `server-settings.ts`).

**Peak memory per upload**: ~3x file size (Elysia's `File` + `ArrayBuffer` from `.arrayBuffer()` + `Buffer` copy).

## What Changes, What Doesn't

| Concern | Impact |
|---------|--------|
| Single-file upload (`POST /file/:pathId`) | **Replaced** with streaming implementation |
| Multi-file upload (`POST /files/:pathId`) | **No change** — stays buffered (10MB per file is fine) |
| Upload progress indicator | **No change** — `XHR.upload.onprogress` tracks bytes sent by the browser, independent of server-side buffering |
| Thumbnail generation | **No change** — `saveThumbnail()` already accepts file paths; Sharp streams from disk internally |
| Frontend upload hooks | **No change** — same URL, same FormData, same XHR |
| `writeFile()` (inline editing) | **No change** — small text files already in memory |

## Design

### Core Idea

Use `parse: 'none'` on the upload route so Elysia doesn't consume the request body. Parse the multipart stream
with `@mjackson/multipart-parser`, which yields file parts as `ReadableStream<Uint8Array>`. Write chunks to a temp
file via `Bun.file().writer()` (FileSink), computing hash and size incrementally. After the stream completes, move
the temp file to storage and insert the DB row.

```
HTTP request body (unconsumed ReadableStream)
  → parseMultipartRequest() yields streaming file parts
    → for each chunk:
      → writer.write(chunk)     — FileSink buffers to disk
      → hasher.update(chunk)    — incremental SHA-256
      → size += chunk.length    — abort if limit exceeded
  → stream complete:
    → check storage quota
    → move temp file to storage (mount.uploadFromTemp)
    → insert DB row (mount.createFileFromTemp)
    → generate thumbnail from storage file (background)
```

### Why Not a New Endpoint?

The frontend sends the same FormData either way. Replacing the existing route's parsing strategy avoids a parallel API
surface and means zero frontend changes.

### Key Technology Choices

**`parse: 'none'`** — Elysia's official body parsing bypass. The auth macro resolves from `request.headers`, not the
body, so authentication is unaffected. With `parse: 'none'`, `request.body` is an unconsumed `ReadableStream`.

**`@mjackson/multipart-parser`** (v0.10.1) — Pure web standard APIs (ReadableStream, Request). Zero dependencies.
Tested and benchmarked on Bun. Each parsed part exposes `.body` as a `ReadableStream<Uint8Array>` for true streaming.
Busboy/fastify-busboy use Node streams and have [documented compatibility issues](https://github.com/oven-sh/bun/issues/3085)
with Bun — avoid them.

**`Bun.file().writer()`** (FileSink) — Bun's reliable streaming file write API. Buffers up to `highWaterMark` bytes
before flushing to disk. Note: `Bun.write(path, stream)` has a [known bug](https://github.com/oven-sh/bun/issues/17459)
where files may not be created — FileSink is the correct approach.

### Memory Usage

~256KB per upload (FileSink buffer) regardless of file size. Plus Sharp's working memory for thumbnail generation
(only for images, capped at 12000x12000px).

## Implementation

### 1. streamToTemp()

New utility in `apps/api/src/lib/drive/streaming.ts`. Parses the multipart request, streams the file to a mount temp
file, and computes hash + size incrementally.

```typescript
// apps/api/src/lib/drive/streaming.ts

import {randomUUID} from 'crypto';
import {parseMultipartRequest} from '@mjackson/multipart-parser';
import type {Mount} from '../mount';
import {ApiError} from '../core';

type StreamResult = {
    tempId: string;
    hash: string;
    size: number;
    mimeType: string;
    fileName: string;
};

export async function streamToTemp(
    mount: Mount,
    request: Request,
    maxSize: number
): Promise<StreamResult> {
    const tempId = randomUUID();
    const tempPath = mount.getTempPath(tempId);
    const writer = Bun.file(tempPath).writer({highWaterMark: 256 * 1024});
    const hasher = new Bun.CryptoHasher('sha256');
    let size = 0;
    let mimeType = 'application/octet-stream';
    let fileName = 'unnamed';

    try {
        for await (const part of parseMultipartRequest(request)) {
            if (!part.isFile || !part.filename) continue;

            fileName = part.filename;
            mimeType = part.mediaType || 'application/octet-stream';

            const reader = part.body.getReader();
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;

                size += value.byteLength;
                if (size > maxSize) {
                    throw new ApiError(413, 'File exceeds maximum upload size');
                }

                hasher.update(value);
                writer.write(value);
            }

            break; // single-file upload — only process first file part
        }

        await writer.end();
    } catch (e) {
        await writer.end();
        await mount.cleanupTemp(tempId);
        throw e;
    }

    if (size === 0) {
        await mount.cleanupTemp(tempId);
        throw new ApiError(400, 'No file found in request');
    }

    return {tempId, hash: hasher.digest('hex'), size, mimeType, fileName};
}
```

### 2. Mount.createFileFromTemp()

New method on Mount. Handles the full sequence internally: validate name, compute storage key, move temp to storage,
insert DB row. All private methods (`isPathBased`, `buildStorageKey`, `resolveStoragePathForNew`) stay encapsulated.

```typescript
// apps/api/src/lib/mount/mount.ts

async createFileFromTemp(
    parentId: string,
    name: string,
    mimeType: string,
    size: number,
    hash: string,
    tempId: string
): Promise<string> {
    validateName(name);
    await this.assertUniqueName(parentId, name);
    const fileId = randomUUID();
    const fileValue = this.isPathBased ? name : buildStorageKey(fileId, name);

    const storageKey = this.isPathBased
        ? await this.resolveStoragePathForNew(parentId, fileValue)
        : fileValue;

    // Storage write before DB insert (crash safety: orphaned file > orphaned row)
    await this.uploadFromTemp(storageKey, tempId);

    await this.db.insert(paths).values({
        id: fileId,
        file: fileValue,
        name,
        type: 'file',
        parentId,
        ownerId: this.ownerId,
        mimeType,
        size,
        hash,
        acl: null,
        createdAt: new Date(),
        updatedAt: new Date()
    });

    return fileId;
}
```

### 3. Route + Drive Method

**Route** (`apps/api/src/routes/drive.ts`) — replace the single-file upload route:

```typescript
.post("/drive/:ownerId/:mountId/file/:pathId", async ({params, request, user}) => {
    const maxSize = getMaxUploadSize();
    const {home, quotas} = await resolveQuotas(params.ownerId, user.id, params.mountId);
    const currentSize = await home.drive.size(params.mountId);
    const remainingQuota = quotas.mountMax - currentSize;

    if (remainingQuota <= 0) {
        throw new ApiError(413, 'Storage quota exceeded');
    }

    const drive = await getSharedDrive(params.ownerId, user);
    return await drive.uploadFileStreaming(
        params.mountId, params.pathId, request,
        Math.min(maxSize, remainingQuota)
    );
}, {auth: true, parse: 'none'})
```

**Drive method** (`apps/api/src/lib/drive/drive.ts`):

```typescript
async uploadFileStreaming(
    mountId: string,
    parentId: string,
    request: Request,
    maxSize: number
): Promise<DrivePath> {
    const mount = this.getMount(mountId);
    const parent = await mount.getPath(parentId);
    if (!parent || parent.type !== 'folder') {
        throw new ApiError(404, 'Parent folder not found');
    }

    if (!(await this.canWrite(mountId, parentId, this.owner))) {
        throw new ApiError(403, 'No write permission');
    }

    const result = await streamToTemp(mount, request, maxSize);

    try {
        let safeName = result.fileName.replace(/[/\\]/g, '_');
        const existing = await mount.getChildByName(parentId, safeName);
        if (existing) {
            const siblings = await mount.listFolder(parentId);
            const usedNames = new Set(siblings.map(s => s.name.toLowerCase()));
            safeName = getUniqueFileName(safeName, usedNames);
        }

        const pathId = await mount.createFileFromTemp(
            parentId, safeName, result.mimeType, result.size, result.hash, result.tempId
        );

        const uploadedFile = await mount.getPath(pathId);
        if (!uploadedFile) throw new ApiError(500, 'Failed to get uploaded file');
        this.emit(SSEventType.DRIVE_FILE_UPLOADED, uploadedFile);

        if (safeName !== result.fileName) {
            await mount.updatePath(pathId, {details: {originalName: result.fileName}});
        }

        // Thumbnail from storage file path (not memory) — background, non-blocking
        // storageFile.name! gives Sharp a disk path so it streams internally
        mount.getStorageFile(pathId).then(async (storageFile) => {
            const thumbnail = await saveThumbnail(
                mount.thumbsDir, pathId, storageFile.name!, result.mimeType, safeName
            );
            if (thumbnail) {
                await mount.updatePath(pathId, {
                    thumbnail: thumbnail.fileName,
                    details: {
                        ...(uploadedFile.details ?? {}),
                        width: thumbnail.width,
                        height: thumbnail.height
                    },
                });
                this.emit(SSEventType.DRIVE_FILE_UPLOADED, (await mount.getPath(pathId))!);
            }
        }).catch((e) => console.error(`Thumbnail generation failed for ${pathId}:`, e));

        return uploadedFile;
    } finally {
        await mount.cleanupTemp(result.tempId);
    }
}
```

### 4. SharedDrive Wrapping

Add to `sharedDrive.ts` with the same write-permission guard:

```typescript
public async uploadFileStreaming(
    mountId: string, parentId: string,
    request: Request, maxSize: number
): Promise<DrivePath> {
    if (!(await this.canWrite(mountId, parentId, this.user))) {
        throw new ApiError(403, 'No write permission');
    }
    return this.sharedDrive.uploadFileStreaming(mountId, parentId, request, maxSize);
}
```

### 5. uploadFile() Stays for Multi-File

`uploadFiles()` calls `uploadFile()` internally, so `uploadFile()` must remain. Both methods coexist:

- `uploadFile(mountId, parentId, file: File)` — used by multi-file endpoint, buffered, 10MB per file limit
- `uploadFileStreaming(mountId, parentId, request, maxSize)` — used by single-file endpoint, streaming

## Connection Abort Handling

If the client disconnects mid-upload, the `ReadableStream` read will throw. The `streamToTemp()` catch block calls
`writer.end()` and `mount.cleanupTemp()` to remove the partial temp file. No special handling needed.

## Crash Recovery

Mount already cleans up old preview cache files on init (`mount.ts:116-124`). Add the same pattern for `tmp/`:

```typescript
// In Mount.init(), after creating tmp dir:
const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
for (const entry of fs.readdirSync(this.tmpDir)) {
    const filePath = path.join(this.tmpDir, entry);
    try {
        if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch {}
}
```

## S3 and Non-Local Mounts

`createFileFromTemp()` calls `mount.uploadFromTemp(storageKey, tempId)` which calls
`this.storage.write(storageKey, Bun.file(tempPath))`. The `StorageBackend.write()` interface accepts `BunFile` on all
backends — S3Storage uploads the BunFile to S3. No new interface methods needed.

For files > 5GB on S3, the S3 API requires multipart upload. This can be added later as an optimization in
`S3Storage.write()` without changing the Drive/Mount layer.

## File Changes

| File | Change |
|------|--------|
| `apps/api/src/routes/drive.ts` | Replace single-file upload route: `parse: 'none'`, pre-stream quota check |
| `apps/api/src/lib/drive/streaming.ts` | **New** — `streamToTemp()` using `@mjackson/multipart-parser` |
| `apps/api/src/lib/drive/drive.ts` | Add `uploadFileStreaming()` method |
| `apps/api/src/lib/drive/sharedDrive.ts` | Add `uploadFileStreaming()` wrapper with write permission |
| `apps/api/src/lib/mount/mount.ts` | Add `createFileFromTemp()` method, add tmp cleanup on init |
| `package.json` | Add `@mjackson/multipart-parser` dependency |

**No changes needed to**: `StorageBackend` interface, frontend hooks, upload UI, thumbnail generation, multi-file
upload endpoint.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Orphaned temp files on crash | Low | Cleanup files > 1 hour old on mount init |
| Partial upload on disconnect | Low | Temp file cleaned up in catch block |
| `parse: 'none'` + auth | None | Auth resolves from headers. Verified: Elysia supports `parse: 'none'` |
| `@mjackson/multipart-parser` maturity | Low | v0.10.1, zero deps, web standard APIs, tested on Bun |
| S3 files > 5GB | Medium | Limit to 5GB initially; S3 multipart upload as future optimization |
| Unbounded upload size | Addressed | Size enforced per-chunk in `streamToTemp()`; quota checked before streaming |
| `Bun.file().writer()` reliability | None | FileSink is Bun's recommended streaming write API |

## Out of Scope

- **Resumable uploads** (tus protocol) — separate concern, can be layered on later.
- **S3 multipart upload API** — needed for files > 5GB on S3 backends. Not needed for initial release.
