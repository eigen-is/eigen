# Streaming Uploads

> **TLDR:** Every Drive upload, one file or many, is one `POST /drive/:ownerId/:mountId/file/:pathId` whose body Eigen's own streaming multipart parser reads (`apps/api/src/lib/multipart/`). Each file streams from the wire into a mount temp file, hashed chunk by chunk as it arrives, and then moves into storage. Memory stays constant whatever the file size, so `maxUploadSizeMB` is a policy knob, not a memory knob. The size limit holds per file and cuts the request off mid-stream.

Uploads come from Drive's upload dialog and drag and drop, from an image an editor puts in its document's `media/` folder ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md)), and from chat and comment attachments. Each lands in a mount, one drive of a Home over local disk or an S3 bucket ([STORAGE.md § A mount is a paths table](STORAGE.md#a-mount-is-a-paths-table-over-one-of-three-backends)). On its way in, an upload meets the quota, which sets how large each file may be ([QUOTA.md](QUOTA.md)), and file history, which tells the folder's watchers ([FILE-HISTORY.md](FILE-HISTORY.md)).

## Elysia never reads the upload body

The route declares `parse: 'none'`, so Elysia leaves the request body alone and `Drive.uploadFiles` hands it to the parser. The client appends every file as a `file` field of one `FormData` and posts it once, with XHR for progress in the upload dialog. Before any byte is read, the route computes the size limit with `getUploadMaxSize` ([QUOTA.md](QUOTA.md)). A mount that is already full answers 507 without reading the body.

Mail draft attachments (`Mail.uploadDraftAttachment`, `apps/api/src/lib/mail/mail-domain.ts`) use the same parser.

## Each file part streams to a temp file

The parser yields flat events: `part` with the parsed headers, `chunk` with body bytes as they arrive, and `end` with the part's size. `streamFilesToTemp` (`apps/api/src/lib/drive/streaming.ts`) writes each file part's chunks into the mount's `tmp/` under a random UUID and feeds an incremental sha256 on the way. A chunk is a view into the network buffer, so it must be consumed before the next event.

Memory is constant. Each upload in flight holds one 256 KB `FileSink` buffer. The parser holds back at most a part's headers (8 KiB at most) and a possible partial boundary at a chunk's tail.

Then `finalizeUpload` (`apps/api/src/lib/drive/upload.ts`) moves each temp into storage and writes its row. It records one history row per file, but `Drive.uploadFiles` notifies watchers once per batch, tagged with the parent folder, so a hundred files are one notification ([FILE-HISTORY.md](FILE-HISTORY.md)). The thumbnail runs in the background and removes the temp when it is done. When one file fails, its temp and those of every file after it are removed.

## The size limit holds per file and cuts the request off mid-stream

The parser's `maxFileSize` throws before it yields the chunk that would cross the limit, so no more of the body is read. The request answers 413 and every temp of that request is removed. It answers 413 even when the limit came from the remaining quota rather than the server's cap.

The limit is per file part. Every part of a multi-file upload may use the whole remaining quota, so a batch can end past the mount's quota: quotas are a soft limit ([QUOTA.md](QUOTA.md)). The server's own `maxRequestBodySize` is `MAX_REQUEST_BODY_BYTES` (1 GiB, `packages/lib/src/constants/mount.ts`), a backstop under the parser.

An upload is not resumable. A dropped connection starts over.

## A crashed upload's temp is swept at the next mount init

The mount's startup `tmp/` sweep ([SYNC.md § A crash temp is adopted and re-synced](SYNC.md#a-crash-temp-is-adopted-and-re-synced)) clears the partials an interrupted upload leaves behind. Upload temps have random names, so the sweep's one exception, a document's crash temp named after its row, never covers them.

## A plain file goes to the bucket in the request

`createFileFromTemp` calls `uploadFromTemp`, which PUTs the temp file (`storage.write(key, Bun.file(tempPath))`) on every backend. Unlike a container database it takes no queue, so on an `s3` mount the request waits for the bucket, with no ceiling on that PUT ([ROADMAP.md](ROADMAP.md)). Bun's `S3Client` sends a body over 5 MiB as a multipart upload. An interrupted one stays in the bucket until the lifecycle rule's abort of incomplete uploads removes it ([SYNC.md](SYNC.md#the-bucket-needs-versioning-and-a-noncurrent-version-expiry-rule)).

## The parser is ours

`apps/api/src/lib/multipart/` derives from `@mjackson/multipart-parser` (MIT) but yields body bytes as events instead of buffering each part whole. Upstream buffers on purpose, because its earlier per-part body stream deadlocked with its synchronous generator design. The flat event shape sidesteps that. It has no dependencies and supports exactly one case: a browser- or fetch-generated `multipart/form-data` body read from a web `ReadableStream` on Bun.

## See also

- [QUOTA.md](QUOTA.md): how the upload limit is computed
- [SYNC.md](SYNC.md): the queued uploads of container databases
- [STORAGE.md](STORAGE.md): mounts and backends
