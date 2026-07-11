# Streaming Uploads for Drive

> **Status**: Implemented

## TLDR

File uploads previously buffered entire files in memory ~3x (Elysia File + ArrayBuffer + Buffer copy). Now all file
uploads (single and multi-file) go through a single endpoint using our own streaming multipart parser
(`apps/api/src/lib/multipart/`). Each file streams from the network to a mount temp file in constant memory —
body bytes are hashed and written chunk-by-chunk as they arrive on the wire — then moved to storage. The old
buffered endpoint and the separate multi-file endpoint (`/files/:pathId`) have been removed.

## Architecture

### Single Endpoint

`POST /drive/:ownerId/:mountId/file/:pathId` — handles 1 or more files.

Frontend always appends files as `'file'` fields in FormData. Backend uses `parse: 'none'` so Elysia does not consume
the request body, then `parseMultipartRequest()` iterates over file parts.

```
Frontend: FormData.append('file', file) for each file → XHR POST (progress tracking works as before)
    ↓
Route: parse: 'none' → getUploadMaxSize() → drive.uploadFiles(mountId, parentId, request, maxSize)
    ↓
Drive.uploadFiles():
  → streamFilesToTemp(mount, request, maxSize) — consumes parser events, streaming each file's
    body chunks into mount tmp/ with an incremental sha256 as they arrive
  → for each result: finalizeUpload() (lib/drive/upload.ts):
    → deduplicate filename against siblings
    → mount.createFileFromTemp() — move temp→storage, insert DB row
    → store originalName, emit SSE, then background: generate thumbnail + cleanupTemp()
  → return DrivePath[]
```

### Key Files

| File | Role |
|------|------|
| `apps/api/src/lib/multipart/` | Streaming multipart parser — yields `part`/`chunk`/`end` events |
| `apps/api/src/lib/drive/streaming.ts` | `streamFilesToTemp()` — consumes parser events, writes temp files |
| `apps/api/src/lib/drive/drive.ts` | `uploadFiles()` — parent + permission checks, per-batch watcher fan-out |
| `apps/api/src/lib/drive/upload.ts` | `finalizeUpload()` — dedupe → `createFileFromTemp` → SSE/history + thumbnail kick |
| `apps/api/src/lib/drive/sharedDrive.ts` | `uploadFiles()` — delegates to underlying `Drive` after ACL write permission check |
| `apps/api/src/lib/mount/mount.ts` | `createFileFromTemp()` + stale temp cleanup on init |
| `apps/api/src/lib/config/enforcement.ts` | `getUploadMaxSize()` — returns min(maxUploadSize, remainingQuota) |
| `apps/api/src/routes/drive.ts` | Thin route: 3 lines |

### Size Enforcement

Per-file size limit is enforced by the parser's `maxFileSize` option during parsing: the request is aborted the
moment a part's body exceeds the limit, mid-stream, before further bytes are read. The limit is
`min(serverMaxUploadSize, remainingMountQuota)`, computed in `getUploadMaxSize()` before streaming starts. If the mount
is already full, the request is rejected immediately (507) without reading the body.

### Memory Profile

Constant, independent of file size. The parser yields body bytes as events while the part is still arriving; the
only bytes ever held back are a potential partial boundary at a network chunk's tail (at most a few dozen bytes).
Each in-flight upload holds one 256 KB `FileSink` write buffer. `maxUploadSizeMB` (default 35 MB) is purely a
policy knob, not a memory knob.

### Crash Recovery

`Mount.init()` cleans up temp files older than 1 hour from `tmp/` on startup. This handles server crashes that leave
partial uploads behind.

### S3 and Non-Local Mounts

`createFileFromTemp()` calls `mount.uploadFromTemp(storageKey, tempId)` which calls
`storage.write(storageKey, Bun.file(tempPath))`. The `StorageBackend.write()` interface accepts
`Buffer | Uint8Array | ArrayBuffer | BunFile` on all backends. No new interface methods needed.

## What Was Removed

- `POST /drive/:ownerId/:mountId/files/:pathId` — separate multi-file endpoint (merged into `/file/:pathId`)
- `Drive.uploadFile()` / `Drive.uploadFileStreaming()` — replaced by single `Drive.uploadFiles()`
- `SharedDrive.uploadFile()` / `SharedDrive.uploadFileStreaming()` — replaced by single `SharedDrive.uploadFiles()`
- `enforceFileUpload()` / `enforceBatchUpload()` — replaced by `getUploadMaxSize()`
- `getMaxBatchUploadSize()` — no longer needed (one limit for all uploads)
- `getDriveFilesUploadUrl()` — frontend no longer branches on file count

## Parser

`apps/api/src/lib/multipart/` — our own streaming parser, derived from `@mjackson/multipart-parser` (MIT) but
reshaped to yield flat `part` (parsed headers) / `chunk` (body bytes) / `end` (total size) events instead of
buffering whole parts. Upstream buffers deliberately (its earlier per-part `body` stream deadlocked with its sync
generator design); the event shape sidesteps that. Zero dependencies; supports exactly our use case:
browser/fetch-generated `multipart/form-data` read from a web `ReadableStream` on Bun. Mail draft attachments
(`MailDomain.uploadDraftAttachment`) use the same parser.

## Out of Scope

- **Resumable uploads** (tus protocol) — can be layered on later.
- **S3 multipart upload API** — needed for files > 5GB on S3 backends.
