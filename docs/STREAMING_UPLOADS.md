# Streaming Uploads for Drive

> **TLDR**: All file uploads (single and multi-file) go through one endpoint and our own streaming multipart
> parser (`apps/api/src/lib/multipart/`). Each file streams from the network to a mount temp file in constant
> memory — body bytes are hashed and written chunk-by-chunk as they arrive on the wire — then moved to storage.
> Memory use is independent of file size; `maxUploadSizeMB` is a policy knob, not a memory knob.

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

### Where the code lives

The route is a thin handler in `apps/api/src/routes/drive.ts`; the upload path itself lives in
`apps/api/src/lib/drive/` (`streaming.ts` streams parts to temp, `drive.ts`/`sharedDrive.ts` do the parent and
ACL checks, `upload.ts` finalizes each file) on top of the parser in `apps/api/src/lib/multipart/` and
`createFileFromTemp()` plus stale-temp cleanup in `apps/api/src/lib/mount/`. Quota and size limits come from
`apps/api/src/lib/config/enforcement.ts`.

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
