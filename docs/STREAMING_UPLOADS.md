# Streaming Uploads for Drive

> **Status**: Implemented

## TLDR

File uploads previously buffered entire files in memory ~3x (Elysia File + ArrayBuffer + Buffer copy). Now all file
uploads (single and multi-file) go through a single endpoint using `@mjackson/multipart-parser`. Each file is
written to a mount temp file, hashed incrementally, then moved to storage — but only the write side streams: the
parser buffers each part fully in memory before yielding it, so memory is ~1x file size per concurrent upload (see
Memory Profile). The old buffered endpoint and the separate multi-file endpoint (`/files/:pathId`) have been
removed.

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
  → streamFilesToTemp(mount, request, maxSize) — parses each file (fully buffered by the parser,
    see Memory Profile), writes it to mount tmp/, hashes incrementally
  → for each result: finalizeUpload() (lib/drive/upload.ts):
    → deduplicate filename against siblings
    → mount.createFileFromTemp() — move temp→storage, insert DB row
    → store originalName, emit SSE, then background: generate thumbnail + cleanupTemp()
  → return DrivePath[]
```

### Key Files

| File | Role |
|------|------|
| `apps/api/src/lib/drive/streaming.ts` | `streamFilesToTemp()` — multipart parsing + temp file writing |
| `apps/api/src/lib/drive/drive.ts` | `uploadFiles()` — parent + permission checks, per-batch watcher fan-out |
| `apps/api/src/lib/drive/upload.ts` | `finalizeUpload()` — dedupe → `createFileFromTemp` → SSE/history + thumbnail kick |
| `apps/api/src/lib/drive/sharedDrive.ts` | `uploadFiles()` — delegates to underlying `Drive` after ACL write permission check |
| `apps/api/src/lib/mount/mount.ts` | `createFileFromTemp()` + stale temp cleanup on init |
| `apps/api/src/lib/config/enforcement.ts` | `getUploadMaxSize()` — returns min(maxUploadSize, remainingQuota) |
| `apps/api/src/routes/drive.ts` | Thin route: 3 lines |

### Size Enforcement

Per-file size limit is enforced by `@mjackson/multipart-parser`'s `maxFileSize` option during parsing. The limit is
`min(serverMaxUploadSize, remainingMountQuota)`, computed in `getUploadMaxSize()` before streaming starts. If the mount
is already full, the request is rejected immediately (507) without reading the body.

### Memory Profile

`@mjackson/multipart-parser` (0.10.1) yields a part only after accumulating its entire body in memory
(`MultipartPart.content` is a buffered `Uint8Array[]`). The write side is streaming (temp write + incremental
hash), so the old ~3x copies are genuinely gone, but each concurrent upload still holds ~1x its file size in RAM.

This makes `maxUploadSizeMB` (default 35 MB) effectively a memory knob: an admin raising it to 2 GB converts every
concurrent upload into a 2 GB RSS spike. If large uploads become a goal, swap to a parser that exposes part bodies
as streams — `writeTempWithHash` is already stream-shaped, so only `streamFilesToTemp` changes.

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

## Dependency

`@mjackson/multipart-parser` (v0.10.1) — web-standard multipart parser. Zero transitive dependencies (just
`@mjackson/headers`). Works on Bun. The parser reads the request body stream but yields each `MultipartPart` only
after buffering its entire body as `content: Uint8Array[]` chunks — see Memory Profile.

## Out of Scope

- **Resumable uploads** (tus protocol) — can be layered on later.
- **S3 multipart upload API** — needed for files > 5GB on S3 backends.
