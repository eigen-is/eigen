# Proposal: Streaming Uploads for Drive

## TLDR

The upload pipeline currently buffers entire files in memory ~3x (Elysia File + ArrayBuffer + Buffer copy). At 35MB
this is fine; at 1GB it means ~3GB RAM per concurrent upload. This proposal eliminates the 3x multiplier by receiving
the raw body as a single ArrayBuffer (~1x), parsing the multipart framing ourselves, and writing directly to a temp
file. Peak memory drops from ~3x to ~1x file size, enabling a higher upload limit (1GB+) on modest hardware.

A future Phase 2 can achieve constant ~64KB memory via true request body streaming (see end of doc).

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
| Single-file upload (`/file/:pathId`) | **Replaced** with streaming implementation |
| Multi-file upload (`/files/:pathId`) | **No change** — stays buffered (10MB per file is fine) |
| Upload progress indicator | **No change** — `XHR.upload.onprogress` tracks bytes sent by the browser, independent of server-side buffering |
| Thumbnail generation | **No change** — `saveThumbnail()` already accepts file paths; Sharp streams from disk internally |
| Frontend upload hooks | **No change** — same URL, same FormData, same XHR |
| `writeFile()` (inline editing) | **No change** — small text files already in memory |

## Design

### Core Idea

Replace the existing single-file upload route's body parsing. Instead of letting Elysia buffer the full `File`, use
`parse: 'arrayBuffer'` to get the raw body, then write it to a mount temp file while computing hash and size
incrementally. After streaming completes, move the temp file to storage, then insert the DB row.

```
HTTP body → write chunks to mount tmp file
           → CryptoHasher.update() per chunk
           → accumulate size (abort if limit exceeded)
  → stream complete:
    → check storage quota (abort if exceeded)
    → move temp file to storage (mount.uploadFromTemp)
    → insert DB row (mount.createFileRecord)
    → generate thumbnail from storage file (background)
```

### Why Not a New Endpoint?

Adding `/file-stream/:pathId` alongside `/file/:pathId` creates a parallel API surface that must eventually be
removed. Since the frontend sends the same FormData either way, the simplest approach is to replace the existing
endpoint's parsing strategy. The frontend doesn't change at all.

### Memory Usage

~1x file size (one ArrayBuffer), down from ~3x. Plus Sharp's working memory for thumbnail generation (only for
images, capped at 12000x12000px). For constant ~64KB memory regardless of file size, see Phase 2 at the end.

## Implementation

### 1. Stream Multipart Body to Temp File

New utility function in `apps/api/src/lib/drive/streaming.ts`. Parses multipart from a raw `ArrayBuffer` body by
extracting the boundary from `Content-Type`, finding file headers within the multipart data, and writing file content
to a temp file in chunks while computing the hash incrementally.

Elysia's `parse: 'arrayBuffer'` gives us the raw body without constructing a `File` object. This is the same pattern
used by the mail delivery route (`routes/mail.ts:32`). The auth macro resolves from `request.headers`, so custom
`parse` does not affect authentication.

**Size enforcement**: Without Elysia's `t.File({maxSize})`, the server has no built-in protection. The streaming
function must enforce a byte limit as it reads, aborting immediately if exceeded. This replaces the current
`enforceFileUpload()` size check.

**Quota enforcement**: Before streaming starts, check remaining storage quota on the mount. If remaining quota is
zero, reject immediately. After streaming completes and the exact size is known, do a precise quota check before
moving to storage.

```typescript
// apps/api/src/lib/drive/streaming.ts

type StreamResult = {
    tempId: string;
    hash: string;
    size: number;
    mimeType: string;
    fileName: string;
};

async function streamToTemp(
    mount: Mount,
    contentType: string,
    body: ArrayBuffer,
    maxSize: number
): Promise<StreamResult> {
    const tempId = randomUUID();
    const tempPath = mount.getTempPath(tempId);

    try {
        const {fileName, mimeType, data} = parseMultipartFile(contentType, body);

        if (data.byteLength > maxSize) {
            throw new ApiError(413, 'File exceeds maximum upload size');
        }

        const hasher = new Bun.CryptoHasher('sha256');
        hasher.update(new Uint8Array(data));
        const hash = hasher.digest('hex');

        await Bun.write(tempPath, data);

        return {tempId, hash, size: data.byteLength, mimeType, fileName};
    } catch (e) {
        await mount.cleanupTemp(tempId);
        throw e;
    }
}
```

The `parseMultipartFile()` helper extracts the single file part from a multipart body. For single-file uploads this
is straightforward: find the boundary from `Content-Type`, locate the `Content-Disposition` header with filename, and
return the data between the headers and the closing boundary.

```typescript
function parseMultipartFile(contentType: string, body: ArrayBuffer): {
    fileName: string;
    mimeType: string;
    data: ArrayBuffer;
} {
    // Extract boundary from Content-Type header
    // Find file part headers (Content-Disposition with filename, Content-Type)
    // Return the data slice between headers and closing boundary
}
```

> **Note on true streaming**: The `parse: 'arrayBuffer'` approach still reads the full body into an ArrayBuffer before
> our code runs. This eliminates the ~3x multiplier (no File object, no Buffer copy) but does not achieve constant
> memory. For constant-memory streaming, we would need `parse: 'none'` to access `request.body` as a ReadableStream,
> plus a streaming multipart parser. This is a good Phase 2 optimization — the current approach solves the immediate
> problem (35MB limit → 1GB+) with minimal complexity and zero new dependencies.

### 2. Mount.createFileFromTemp()

New method on Mount. Like `createFile()` but for files already written to a temp path. Handles the full sequence
internally: validate name → compute storage key → move temp to storage → insert DB row. All private methods
(`isPathBased`, `buildStorageKey`, `resolveStoragePathForNew`) stay encapsulated.

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

### 3. Drive.uploadFile() — Replace Internals

Replace the implementation of the existing `uploadFile()` method. The signature stays the same (it still returns
`DrivePath`), but internally it streams to temp instead of buffering. The route also changes to pass the raw request
instead of a parsed `File`.

**Route change** (`apps/api/src/routes/drive.ts`):

With `parse: 'arrayBuffer'`, Elysia reads the raw body and provides it as `body`. The request body stream is consumed
at that point, so we pass `body` (the ArrayBuffer) and the content-type header to the drive method — not the Request
object.

```typescript
.post("/drive/:ownerId/:mountId/file/:pathId", async ({params, body, user, request}) => {
    const maxSize = getMaxUploadSize();
    const {home, quotas} = await resolveQuotas(params.ownerId, user.id, params.mountId);
    const currentSize = await home.drive.size(params.mountId);
    const remainingQuota = quotas.mountMax - currentSize;

    if (remainingQuota <= 0) {
        throw new ApiError(413, 'Storage quota exceeded');
    }

    const drive = await getSharedDrive(params.ownerId, user);
    const contentType = request.headers.get('content-type') ?? '';
    return await drive.uploadFileStreaming(
        params.mountId, params.pathId,
        contentType, body as ArrayBuffer,
        Math.min(maxSize, remainingQuota)
    );
}, {auth: true, parse: 'arrayBuffer'})
```

**Drive method** (`apps/api/src/lib/drive/drive.ts`):

```typescript
async uploadFileStreaming(
    mountId: string,
    parentId: string,
    contentType: string,
    body: ArrayBuffer,
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

    const result = await streamToTemp(mount, contentType, body, maxSize);

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
    contentType: string, body: ArrayBuffer, maxSize: number
): Promise<DrivePath> {
    if (!(await this.canWrite(mountId, parentId, this.user))) {
        throw new ApiError(403, 'No write permission');
    }
    return this.sharedDrive.uploadFileStreaming(mountId, parentId, contentType, body, maxSize);
}
```

### 5. uploadFile() Stays for Multi-File

`uploadFiles()` calls `uploadFile()` internally, so `uploadFile()` must remain. Both methods coexist:

- `uploadFile(mountId, parentId, file: File)` — used by multi-file endpoint, buffered, 10MB per file limit
- `uploadFileStreaming(mountId, parentId, contentType, body, maxSize)` — used by single-file endpoint, temp-file based

## Connection Abort Handling

If the client disconnects mid-upload, Elysia's `parse: 'arrayBuffer'` will fail before our code runs — no temp file
is created, nothing to clean up. If the disconnect happens after parsing (during `createFileFromTemp` or thumbnail
generation), the `finally` block calls `mount.cleanupTemp()`. No special handling needed.

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

This handles server crashes that leave temp files behind. The 1-hour window is generous — uploads complete in seconds
to minutes.

## File Changes

| File | Change |
|------|--------|
| `apps/api/src/routes/drive.ts` | Replace single-file upload route: `parse: 'arrayBuffer'`, pre-stream quota check |
| `apps/api/src/lib/drive/streaming.ts` | **New** — `streamToTemp()` and `parseMultipartFile()` |
| `apps/api/src/lib/drive/drive.ts` | Add `uploadFileStreaming()` method |
| `apps/api/src/lib/drive/sharedDrive.ts` | Add `uploadFileStreaming()` wrapper with write permission |
| `apps/api/src/lib/mount/mount.ts` | Add `createFileFromTemp()` method, add tmp cleanup on init |

**No changes needed to**: `StorageBackend` interface, frontend hooks, upload UI, thumbnail generation, multi-file
upload endpoint.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Orphaned temp files on crash | Low | Cleanup files > 1 hour old on mount init |
| Partial upload on disconnect | Low | Temp file cleaned up in `finally` block |
| `parse: 'arrayBuffer'` + auth | None | Auth resolves from headers, not body. Same pattern as mail delivery route |
| Manual multipart parsing edge cases | Low | Single-file multipart is well-defined; test with various browsers |
| S3 files > 5GB | Medium | Limit to 5GB initially; S3 multipart upload as future optimization |
| Unbounded upload size | Addressed | Size limit enforced during streaming; quota checked before and after |

## Out of Scope

- **True constant-memory streaming** — `parse: 'arrayBuffer'` still buffers the body once. For constant ~64KB memory,
  we would need `parse: 'none'` + a streaming multipart parser. This is a Phase 2 optimization if needed — the
  current approach already eliminates the 3x multiplier and raises the practical limit to 1GB+.
- **Resumable uploads** (tus protocol) — separate concern, can be layered on later.
- **S3 multipart upload API** — needed for files > 5GB on S3 backends. Not needed for initial release.
