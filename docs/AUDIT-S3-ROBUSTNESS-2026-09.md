# S3 Robustness Audit (2026-09): slow and stalling S3

> **TLDR**: The write-behind queue for `data.db` holds up: edits coalesce, a stalled PUT loses no data, and a restart replays every staged copy. The real risk sits on the read side and around teardown. No S3 read has a deadline of Eigen's own, so a stalled GET waits about 6 minutes and a trickling one waits forever (DL-1). Home teardown awaits that GET, so one stuck document hangs every request for its owner (DL-2). A process killed mid-GET leaves a truncated working copy that every later open adopts and fails on (DL-6). A whole-server snapshot of an s3 install holds no bucket object at all (BK-1).

This audit covers the S3 path when the bucket is slow, stalls or fails: every HEAD, GET, PUT and DELETE, what bounds it, what it pins while it waits, and what a restart, a backup, an update or a restore does with it. Each robustness gap has a test that asserts the correct behavior and runs as `test.failing`, so the suite stays green and the test flips when the gap is fixed. Stalls are injected in two ways: `FaultStorage` (with `parkWrites` and `waitForParked`) for queue and backup work, and a fake S3 endpoint on a raw socket that the real `S3Storage` and Bun's real `S3Client` talk to, for every read and wire-level fault (no answer, headers then silence, a body cut short, 5xx, an empty 200). Bucket-level behavior (a bucket that does not exist, key encoding) runs against a live MinIO.

Verdict. What holds: a GET that fails in-process never leaves a working copy behind; an empty, cut-short or missing download is never opened as a fresh document and never uploaded back; a client never gets an editable blank document; the collab socket survives a load of any length; concurrent opens share one load; a streaming download releases its upstream GET when the client leaves; the upload semaphore and the thumbnail semaphore are never held across a read; the per-home restore is resumable by construction. What does not hold is every bound on time. Bun's `S3Client` is the only thing that ends a stalled request, its bound is an inactivity timeout, and the teardown, shutdown and backup paths all await S3 work without a deadline of their own. The four high findings are that one missing primitive (a deadline on an S3 call) and its consequences, plus the whole-server snapshot that silently holds none of an s3 install's bytes.

Code paths below are relative to `apps/api/src/` (`lib/mount/mount.ts` is `apps/api/src/lib/mount/mount.ts`, `test/...` is `apps/api/src/test/...`). Other paths are relative to the repo root. Tests are cited as `file`, `describe > test`.

## Bun's S3Client under a stalled endpoint

Bun 1.4.2's `S3Client` has one bound: an inactivity timeout of about 360 s. `S3Options` has no timeout or signal field (`bun-types` `s3.d.ts`), and `S3Storage` passes none (`lib/storage/s3-storage.ts:244-252`).

| Upstream behavior | What the client does |
|---|---|
| HEAD never answered | rejects `S3Error` code `Timeout` at 360.1 s |
| GET sends headers and half the body, then silence | `Bun.write(path, s3File)` rejects `Timeout` at 360.1 s; the half body sits at `path` meanwhile |
| GET body trickles 1 byte/s (or 1 byte per 20 s) | never times out: still pending past 10 min, file growing |
| PUT to a listener that accepts and never answers | rejects `Timeout` at 360.1 s |
| Connection closed (FIN) mid-body | rejects `ConnectionClosed` at once, partial bytes on disk |
| Connection reset (RST) mid-body | rejects `ConnectionClosed`, at once in 15 of 20 runs, after about 57 s in 5 of 20 |
| 404 / 500 / 503 on the GET | rejects `S3Error` with the provider code, 0-byte file on disk |
| Body shorter than its Content-Length | rejects `ConnectionClosed`; a short body never resolves as success |
| Reader of `s3File.stream()` canceled, or the browser aborts a `new Response(s3File.stream())` | upstream socket closes at once |
| HEAD on a bucket that does not exist (MinIO) | resolves `false`, the same 404 a missing key gets |
| Body over 5 MiB | goes up as a multipart upload; a killed or failed write leaves the upload listed in the bucket |

To reproduce: `Bun.listen` a TCP server on `127.0.0.1` that accepts and writes nothing (or writes an `HTTP/1.1 200` header with a Content-Length and then one byte per second), point `new S3Client({ endpoint: 'http://127.0.0.1:<port>', bucket: 'b', accessKeyId: 'x', secretAccessKey: 'x' })` at it, and time `client.file('k').exists()` or `Bun.write('/tmp/out', client.file('k'))`. The silent server rejects at about 360 s; the trickling one never does.

## Sequence of a collab open from S3

A cold document on an s3 mount opens in this order:

1. `useCollabDoc` builds a `WebsocketProvider` on `/ws/collab/:ownerId/:mountId/:pathId`, with `?epoch=` on a reconnect (`packages/lib/src/core/collab/hooks/use-collab-doc.ts:106-119`). y-websocket 3.1.0 starts its 30 s silence watchdog (`y-websocket.js:436-451`).
2. Caddy forwards the upgrade with no stream timeout (`docker/caddy/site.Caddyfile:37-44`); the host snippets allow 24 h (`docker/proxy/eigen.nginx.conf:34`, `docker/proxy/eigen.apache.conf:22`).
3. The `auth: true` macro answers an unauthenticated upgrade itself (`routes/collab.ts:181-188`).
4. `open` registers a session whose `opened` promise gates `message` and `close` (`routes/collab.ts:190-193, 272-274, 289-291`).
5. Before any await, `startLoadingHeartbeat` sends an empty awareness frame and repeats it every 10 s (`routes/collab.ts:204-205`, `lib/collab/loading-heartbeat.ts:12, 24-31`).
6. A reconnect naming another data epoch closes `COLLAB_HOME_REPLACED_CLOSE` (`routes/collab.ts:211-215`).
7. The socket joins the per-home restore sweep (`routes/collab.ts:219`).
8. `getSharedDrive` resolves the owner's Home (cold `Home.init` on first use), then `canRead`; a refusal closes 1008 (`routes/collab.ts:220-224`).
9. `drive.getCollabDocument` reaches `CollabRegistry.get`, one `createAsyncSingleton` per document, so every concurrent caller awaits the same build (`lib/drive/sharedDrive.ts:184`, `lib/drive/drive.ts:1011`, `lib/drive/collab-registry.ts:24-39`).
10. The factory checks the collab type and runs `new CollabDocument(drive, path).init()` (`lib/drive/collab-registry.ts:29-34`).
11. `init` finds `data.db` and `comments.db`, warms `comments.db` fire-and-forget, and awaits `drive.openDatabase` for `data.db` (`lib/collab/collabDocument.ts:215-237`).
12. `Mount.openDatabase` reaches `openDocumentDb`, one singleton per pathId in `mount.documentDbs`; it waits for an in-flight close of the same pathId and deletes the map entry if the build throws (`lib/mount/mount.ts:1027`, `lib/mount/document-db.ts:34-69`).
13. `buildDocumentDb` picks `tmp/<pathId>` and builds a `ManagedDatabase` with the S3 callbacks and `mustExist` (`lib/mount/document-db.ts:109-202`), then `managed.open()` (`:204`).
14. `openCold` runs `onOpen` first (`lib/core/managed-database.ts:83-84`).
15. `onOpen` adopts a surviving temp if `isViableRecoveryTemp` passes, else discards it; restores from a pending staged copy if one exists; else probes `storage.exists` (false is `ApiError(503)`) and calls `downloadKeyToTemp` (`lib/mount/document-db.ts:114-151`, `lib/mount/helpers.ts:149-154`, `lib/storage/s3-storage.ts:297-306`).
16. `downloadKeyToTemp` clears the old temp and journals, then `Bun.write(tempPath, storage.read(key))`: the GET runs inside `Bun.write`, straight onto the working-copy path. A rejected GET removes the partial temp and rethrows the raw `S3Error` (`lib/mount/mount.ts:958-979`).
17. With `mustExist`, `openCold` refuses a missing or 0-byte working copy with `ApiError(503)`, opens with `create: false`, sets WAL and pragmas, runs migrations, and closes the raw handle if any of that throws (`lib/core/managed-database.ts:89-130`). The 30 s sync timer starts (`:136-140`).
18. A recovered temp is force-dirtied (`lib/mount/document-db.ts:212-214`).
19. `init` builds the `Y.Doc` and `DbProvider`; `loadYjsState` reads the newest snapshot and the tail updates in one transaction and skips any blob that fails to decode (`lib/collab/collabDocument.ts:240-242`, `lib/collab/yjs-loader.ts:35-107`).
20. `init` wires the update and awareness broadcasts (`lib/collab/collabDocument.ts:243-273`).
21. The route sends the epoch frame, then `subscribe` clears the linger timer and sends sync-step-1 through `sendFrame` (`routes/collab.ts:227-228`, `lib/collab/collabDocument.ts:329-336`).
22. The 15 s keepalive starts and pins the owner's Home on every tick (`routes/collab.ts:237-242`).
23. `finally` stops the loading heartbeat and resolves `opened` (`routes/collab.ts:257-260`).
24. The client answers sync-step-1; the first `sync` latches `loaded`, and only then does the editor leave the loading screen (`use-collab-doc.ts:124-135`).
25. On a throw in steps 8 to 21 the route closes `COLLAB_HOME_REPLACED_CLOSE` for `HomeRestoringError`, 1013 `storage-unavailable` for an `ApiError` 503, and 1008 for anything else (`routes/collab.ts:250-256`). The client retries 1013 every 5 s under "Storage is temporarily unavailable" (`use-collab-doc.ts:184-188`). On 1008, y-websocket reconnects on its own backoff capped at 2.5 s, forever, and the loading screen reads "Storage is responding slowly, still connecting…" after 10 s (`packages/ui/src/components/layout/app/collab-loading-state.tsx:6, 21-25`).

### Under a slow download

| Case | What happens |
|---|---|
| 60 s download | The heartbeat resets y-websocket's 30 s watchdog; Bun's WebSocket idle timeout (120 s default, `sendPings` on, no override in `app.ts:58-63`) never fires; `idleTimeout: 200` covers HTTP only (`server.ts:47`). The socket stays open and syncs when the GET lands. |
| 5 min download that keeps moving | Same, and it completes. But the owner's Home is not pinned while the open is pending (the keepalive starts after it, `routes/collab.ts:237-242`; only the owner's own SSE pins a user Home, `lib/home/sse-stream.ts:33-38`), so a shared document whose owner is offline outlives the 5 min idle window (`lib/home/home.ts:37, 114-125`) and the Home's teardown parks on the load (DL-2). |
| Never-completing download | A silent GET rejects at about 360 s, the route closes 1008 (DL-4), y-websocket reconnects within 2.5 s into another full attempt (DL-1). A trickling GET never ends: the loading screen stays up. |
| A second client | Shares the load: both singletons hand every caller the same promise (`collab-registry.ts:26-38`, `document-db.ts:40-65`). One GET, one `CollabDocument`. |
| Reconnect mid-download | The in-flight load is reused, not canceled and not leaked. The dead socket's `open` finishes after the load, subscribes a closed socket, and its `close` handler then cleans it up (`routes/collab.ts:37-45, 291-293`). Until the load settles each abandoned socket holds its heartbeat interval, sweep entry and pending close handler. |
| All sockets leave mid-load | The last unsubscribe schedules the 60 s linger close (`collabDocument.ts:349-351, 367-375`). A close that lands on a successful in-flight open closes what the open built, with no cached handle and no temp left. |

Tests: `test/collab/collab-open-from-s3.test.ts`, `a stalled download > keeps the socket open on the loading heartbeat, then syncs once the GET completes`, `> is shared: two opens during the stall wait on one GET and get the same document`, `> survives a reconnect: the new socket reuses the in-flight load and the closed one is dropped`; `test/storage/docdb-open-close-race.test.ts`, `an open still loading from storage > a close landing mid-load closes what the open built: no cached handle, no temp left`.

### Partial, empty, 404 and 5xx downloads

No download shape opens as a fresh empty document or reaches the bucket. The invariant in `docs/SYNC.md:45-46` holds for every row below; what fails is the close code.

| data.db GET outcome | What the open does | Close code | Stored object |
|---|---|---|---|
| HEAD 404 (object gone) | `ApiError(503)` before any GET (`document-db.ts:148-150`) | 1013 | untouched |
| HEAD failure | `S3Storage.exists` throws `ApiError(503)` | 1013 | untouched |
| GET 404 after HEAD 200 | temp removed, raw `S3Error NoSuchKey` rethrown | 1008 (DL-4) | untouched |
| GET 500 / 503 | temp removed, raw `S3Error` rethrown | 1008 (DL-4) | untouched |
| GET cut short | temp removed (`mount.ts:966-971`) | 1008 (DL-4) | untouched |
| GET stalls | as above after about 360 s | 1008 (DL-1, DL-4) | untouched |
| 200 with an empty body | `mustExist` refuses the 0-byte temp (`managed-database.ts:89-98`); the next open discards it | 1013 | untouched |
| Stored object truncated by a page or more | first PRAGMA throws `SQLITE_CORRUPT` | 1008 | untouched |

A working copy missing less than one page at its tail opens without error (SQLite zero-fills it), but no transport shape produces one: Bun rejects any body shorter than its Content-Length. Process death mid-GET is the exception, see DL-6.

Tests: `test/collab/collab-open-from-s3.test.ts`, `a failed download > a body cut short fails the open, leaves no temp and never touches the stored object`, `> an empty 200 is refused as storage-unavailable, never opened as a fresh document`; `test/storage/slow-download.test.ts`, `S3 reads that fail > a data.db GET that dies midway leaves no working copy, and the next open reads the whole object`.

## Slow downloads: every GET path

All reads go through `S3Storage.read` / `readRange` (a lazy `S3File`; the request runs when the caller consumes it) and `exists` / `size` (`lib/storage/s3-storage.ts:269-315`). None takes a signal or a deadline; the one S3 request with a deadline is the bucket-config `signedS3Request` (`s3-storage.ts:153`). `Mount.readKey` and `readRange` call the raw `S3File.exists()`, not `S3Storage.exists` (`mount.ts:870-871, 882-883`).

| Surface | Read | Idle bound |
|---|---|---|
| REST download and embed | `routes/drive.ts:158-169, 318-324` → `lib/drive/serve-file.ts:47-61` | 200 s (`server.ts:47`) |
| WebDAV GET | `lib/webdav/resource.ts:52-66` | 200 s |
| Previews | `lib/preview/preview-cache.ts:337-394`, `lib/preview/svg-media-inline.ts:177-198` | 200 s |
| Copy (REST, WebDAV COPY) | `lib/mount/copy.ts:57-60`, `lib/drive/copy-across.ts:35-37` | none: `routes/drive.ts:176`, `lib/webdav/webdav-router.ts:148` exempt |
| Export, convert, import-from-drive | `lib/document/transform/collab-source.ts:13`, `lib/import/import-document.ts:82-84`, `routes/drive.ts:303-307` | none: `routes/drive.ts:227, 243, 292` exempt |
| Collab open | `collabDocument.ts:234, 237` → `downloadKeyToTemp` | WebSocket, heartbeat every 10 s |
| Version snapshot and restore | `lib/versioning/snapshot.ts:177-179`, `lib/versioning/restore.ts:30` | 200 s on the route; container lock held (DL-3) |
| Reindex (background) | `lib/search/extract-text.ts:62-63`, `lib/document/stickies.ts:24`, `lib/document/chat.ts:16` | none |
| Per-home backup | `lib/backup/snapshot-mount.ts:262-279` | none, holds the job slot (DL-1) |

What the client sees with a stalled GET:

| Path | 30 s | 120 s | 10 min |
|---|---|---|---|
| Download, embed, preview, WebDAV GET, HEAD stalled | nothing | nothing | connection closed with no response at 200 s; the server's HEAD runs on to 360 s |
| Same, body stalled after headers | partial body | partial body | truncated download at 200 s of silence; the upstream GET closes with it |
| Copy, export, convert, import-from-drive | pending | pending | 500 "Internal server error" at about 360 s (DL-4); a trickle is still pending |
| Collab editor, cold open | loading screen | loading screen, "responding slowly" | close 1008 at about 360 s, reconnect, another cold open; a trickle keeps the loading screen |

A client disconnect aborts the upstream GET only once the body streams. Before the first byte, the HEAD in `readKey` / `readRange` and the whole `downloadKeyToTemp` take no signal, so a disconnect or the 200 s idle close leaves them running (`request.signal` aborts, the handler does not). Export passes `request.signal` only to the transform runner (`lib/export/export-document.ts:44-46`).

## Slow uploads

| Question | Answer | Evidence |
|---|---|---|
| Edits during a stalled queued PUT | Each dirty sync stages a new copy and upserts the one pending row; the running drain is still inside its await, so the kick coalesces. Edits pile into one row behind the in-flight PUT and no parallel PUT starts. After the 120 s ceiling the retry PUTs the newest row while the timed-out request is still on the wire; orphan repair re-stages an ack that an older landing would regress. Side effect: superseded staged copies leak (UP-5). | `lib/mount/upload-queue.ts:114-133, 297-314, 397-458`; `test/storage/upload-queue-stall.test.ts`, `edits while a PUT is stalled > later syncs coalesce into one pending row behind the stalled PUT; no parallel PUT starts` |
| Edits during a stalled direct PUT (plain files) | No ceiling, no semaphore, no ordering, no cancel tracking (UP-2, UP-3, UP-4). | `mount.ts:494, 898-918, 981-993` |
| Staged copies on restart | `reconcile` runs at mount init before the tmp sweep: rows whose staged copy exists replay, unreferenced staged copies are deleted, a row whose copy is gone is dropped with no log line. A document's crash temp in `tmp/` is kept by the sweep and adopted on the next open. A user upload's temp (random UUID) is orphaned and swept after 1 h at a later init. A direct PUT that committed before the kill leaves an object with no row, by design. | `upload-queue.ts:155-176`; `mount.ts:199, 210, 235-258, 492`; `document-db.ts:117-127, 212-214` |
| Kill mid-drain | `./eigen update` and `./eigen stop` run `docker compose stop`: SIGTERM through tini, SIGKILL after `stop_grace_period: 30s`. `./eigen restart` runs `docker compose up -d --wait`, which recreates a changed container under the same grace and `docker rm -f`s containers of removed services. No data is lost: the row and staged copy are durable before the producer returns, and `performUpload` touches no database once `closing`. | `eigen:456-466, 479-491, 891-922`; `docker-compose.yml:74`; `upload-queue.ts:121-128, 328-330`; `upload-queue-stall.test.ts`, `shutdown drain with a stalled PUT > a PUT stalled past the shutdown deadline keeps its row, and the next boot uploads it` |
| Shutdown deadline | Not a bound: it is read only at the top of each loop turn, so an in-flight PUT runs to 120 s and a semaphore wait has no bound; it starts only after the transform close and the backup-job drain (UP-1). | `upload-queue.ts:193-195, 210, 219`; `server.ts:67-74` |
| Duplicate writes | Replay after death, orphan repair and the parallel retry after a timeout all re-PUT whole objects to id-stable keys: idempotent, at most one extra PUT per event. | `upload-queue.ts:354-380` |
| Multipart | Bun uses multipart above 5 MiB; the queue's ceiling does not abort it, so the orphan keeps sending parts while the retry opens a second one. Interrupted uploads stay in the bucket (UP-7). | Bun behavior above; `upload-queue.ts:299-314` |

## Robustness findings

### High

**DL-1 (also CO-1, BK-4): no S3 call has a deadline of Eigen's own.** The only bound is Bun's 360 s inactivity timeout, which a trickling backend never trips, and it is longer than every other ceiling in the system (idle 200 s, PUT 120 s).
- Evidence: `lib/storage/s3-storage.ts:269-275` (`read`, `readRange` return a bare `this.client.file(...)`), `:283-315` (`delete`, `exists`, `size` await with no signal); `lib/mount/mount.ts:870-871, 882-883, 966`; the write side has `Promise.race` against `UPLOAD_PUT_TIMEOUT_MS` (`lib/mount/upload-queue.ts:291-314`), the read side has no counterpart. On the backup side: `lib/backup/jobs.ts:58-80` refuses every job on a Home while one runs and holds the slot across a safety-copy delete; `lib/backup/safety-copy.ts:177` probes and deletes with no bound.
- Scenario: the provider black-holes a GET. The editor shows the loading screen for 6 minutes, every collaborator who opens the document joins the same load, then the socket closes 1008 and reconnects into the same wait. A download closes empty at 200 s while the server's HEAD runs to 360 s. Copy and export sit 6 minutes and return 500. A per-home backup sits in "mount files" and every restore, backup, verify or safety-copy delete of that Home answers 409 until the API restarts. With a trickling provider none of these ever ends.
- Tests: `test/storage/slow-download.test.ts`, `Stalled S3 reads > a download whose HEAD stalls answers 503 instead of waiting on the backend`, `Stalled S3 reads > a document open whose data.db GET stalls mid-body answers 503`; `test/backup/slow-bucket.test.ts`, `Backup of an s3 mount whose bucket stalls or loses objects > a GET that never answers ends the backup job, so the home can be restored again`, `Backup safety-copy delete on a bucket that never answers > a delete against a bucket that never answers gives the home slot back`. A fix should expose the ceiling as a shrinkable field, as `UploadQueue.putTimeoutMs` is, so these tests shrink it below their 1 s bound.

**DL-2 (also CO-2): Home teardown awaits a document open parked in its GET, so one stalled GET wedges every request for that owner.**
- Evidence: `lib/home/get-home.ts:57-67` awaits a destructing Home's `shutdown()` before building a replacement; `lib/home/home.ts:184-215` awaits `drive.destruct()`; `lib/drive/drive.ts:1266-1281` awaits `documents.destructAll()` then `closeAllDatabases()`; `lib/drive/collab-registry.ts:88-90` and `lib/mount/document-db.ts:318-320` `await getter()` on the in-flight build. `lib/mount/content-reindex-queue.ts:13-17` bounds only its own drain await; the extract's `openDatabase` getter is still awaited unbounded by `closeAllDatabases`, so its comment's claim does not hold. SIGTERM walks the same chain (`server.ts:77`, `get-home.ts:166-174`).
- Scenario: Alice opens Bob's shared document while Bob is offline; the GET black-holes. Bob's Home idles out at 5 minutes and its teardown parks on Alice's load. Every request that resolves Bob's Home (HTTP, SSE, collab, CalDAV, CardDAV, WebDAV) hangs until the GET times out, about a minute for a user Home, forever under a trickle. A team Home (30 min idle) reaches it only under a trickle. The case that keeps this high: `./eigen update` in that window parks shutdown into the 30 s SIGKILL, which is the entry to DL-6. A failed open that stays registered (CO-5) re-runs its full load at the next teardown and parks the same way.
- Tests: `test/storage/slow-download.test.ts`, `Stalled S3 reads > mount teardown finishes while a document open waits on its data.db GET`, `A stalled GET and the Home > the owner's next request gets a Home while the idle one waits on a stalled document GET`; `test/storage/docdb-open-close-race.test.ts`, `an open still loading from storage > mount teardown settles while an open is parked on storage`.

**DL-6: a process death mid-GET leaves a truncated working copy that every later open adopts as crash recovery and fails on.** The document stays unopenable until an operator deletes `tmp/<pathId>`. No bytes are lost: the good object stays in the bucket.
- Evidence: `lib/mount/mount.ts:966` streams onto the live working-copy path with no side file and rename; `mount.ts:235-258` keeps any tmp entry named after a live path id; `lib/mount/document-db.ts:117-127` adopts it when `isViableRecoveryTemp` passes; `lib/mount/helpers.ts:147-154` checks only the 16-byte SQLite magic and a 50% size floor that applies only at 64 KiB and up, so any prefix of a smaller document passes; `lib/core/managed-database.ts:107-130` closes the handle on `SQLITE_CORRUPT` and nothing discards the temp.
- Scenario: a user opens a large document while the bucket is slow; `./eigen update` sends SIGTERM; shutdown parks on the open (DL-2); SIGKILL at 30 s. After boot every open of that document (editor, preview, export, reindex, backup) fails with `SQLITE_CORRUPT`, on every attempt. A 60% prefix fails; a 40% prefix of a large document is discarded and re-fetched. For chats a version restore escapes it (a new `data.db` id); for other types only a manual delete or a whole-Home restore does.
- Test: `test/storage/slow-download.test.ts`, `S3 reads that fail > a working copy truncated by a process death mid-GET is re-fetched on the next open`. The same shape fails identically through the real `S3Storage` against MinIO.

**BK-1: a whole-server snapshot holds no s3 object, so restore and rollback of an s3 install put old metadata over the bucket as it is now.** On an install whose drives are s3, the operator's only whole-server backup holds none of the file or document bytes, and the command reports success.
- Evidence: `cli/snapshot.ts:258-260` archives `data/` and `.env.production` only; the CLI has no S3 awareness. `paths` rows carry a key and never a version (`versionId` appears nowhere outside `checkS3Versioning` / `setS3Versioning`), so even a versioned bucket cannot make old rows resolve to old objects. Keys are id-stable (`lib/mount/document-db.ts:164`), so an edit after the snapshot overwrites the object the restored row names. First boot runs `purgeTrash` (`lib/mount/mount.ts:215-218`, `lib/mount/trash.ts:211-220`), which deletes by key every restored trashed row past retention, including one the user has un-trashed since. `cli/snapshot.ts:186` says a full snapshot can bring back what a breaking release converts; for s3 content it cannot.
- Scenario: `./eigen backup` at T0; users edit and delete files; the operator runs `./eigen restore` or `./eigen rollback`. Edited files show their post-T0 content, deleted files are listed but download nothing and documents of that kind answer 503. The Drive is neither state. `./eigen backup` printed "full, 12 MB" for a server with gigabytes of files.
- Test: `test/cli/snapshot-s3.test.ts`, `Whole-server snapshot of an s3 mount > a full snapshot brings an s3 file back as it was when the snapshot was made`. The plain test `> a full snapshot holds the mount database and its staged uploads, a light one the database alone` pins what the tar holds.

### Medium

**DL-4 (also CO-3, ST-1): a failed S3 read surfaces as a raw `S3Error`, so HTTP answers 500 and collab closes 1008, never the 503 and 1013 an unreachable backend speaks.**
- Evidence: the only mapping is `S3Storage.exists` (`lib/storage/s3-storage.ts:297-306`); `lib/mount/mount.ts:870-871, 882-883` call `S3File.exists()` directly; `mount.ts:966-971` rethrows the raw error; `routes/collab.ts:252-256` sends only `ApiError` 503 to 1013; `lib/core/errors.ts:28-30` answers anything else 500 and logs it as `API Error:`; `packages/lib/src/core/collab/hooks/use-collab-doc.ts:184-188` acts only on 1013.
- Scenario: the provider answers the HEAD and 503s the GET (Hetzner throttling does this). Every open closes 1008, the tab shows "responding slowly" instead of "Storage is temporarily unavailable", and every open tab re-downloads on y-websocket's 2.5 s cadence instead of the 5 s storage pause, pushing traffic at a provider that is shedding load. Downloads and previews answer 500.
- Tests: `test/storage/slow-download.test.ts`, `S3 reads that fail > a download whose HEAD fails answers 503`, `S3 reads that fail > a document open whose data.db GET dies midway answers 503`; `test/collab/collab-open-from-s3.test.ts`, `a failed download > a 5xx on the GET closes with storage-unavailable, like an unreachable exists()`.

**DL-3: a version snapshot holds the container lock across its S3 GET.**
- Evidence: `lib/versioning/snapshot.ts:25-32` runs `takeSnapshot` under `withPathLock`; with no open handle and nothing staged, `stageManagedDbCopy` does a HEAD and a GET (`snapshot.ts:177-179`). `lib/backup/snapshot-mount.ts:262-263` takes the same lock for every managed database. `lib/mount/mount.ts:602-617` waits with no deadline, and `ChatRoom.init` is a lock taker too (`mount.ts:600-601`).
- Scenario: a backup on a slow-bucket night parks on one container's GET; a user who saves or restores a version of that document, or opens that chat, waits up to 6 minutes, forever under a trickle.
- Test: `test/storage/slow-download.test.ts`, `Stalled S3 reads > the container lock frees while a version snapshot waits on its S3 GET`.

**UP-2: direct (non-queued) S3 PUTs have no ceiling and skip the destination semaphore.** File uploads, editor saves and WebDAV PUTs on an s3 mount wait up to 6 minutes on a stalled bucket.
- Evidence: bare `storage.write` at `lib/mount/mount.ts:494` (`createFile`), `:900` (`writeFile`), `:990` (`uploadFromTemp`, used by `createFileFromTemp` `:535` and `writeFileFromTemp` `:927`); callers `lib/drive/upload.ts:37`, `lib/drive/drive.ts:655, 664` (editor and WebDAV). `S3Storage.write` takes no signal (`s3-storage.ts:277-281`). None goes through `getUploadSemaphore`.
- Scenario: a user uploads a photo while the bucket stalls. The request gets an empty reply at 200 s and the UI reports a failure; the handler still awaits the PUT, and when it lands the row appears and `DRIVE_FILE_UPLOADED` fires. A retry creates `photo (2).jpg`. Any number of such PUTs run at once against the struggling provider.
- Test: `test/storage/upload-queue-stall.test.ts`, `direct (non-queued) PUTs > a stalled upload PUT settles within the PUT ceiling the queue uses`.

**BK-3: a per-home backup of an s3 mount whose objects or bucket are gone verifies green with none of them.**
- Evidence: `lib/mount/mount.ts:867-875` returns `null` when `exists()` is false; `lib/backup/snapshot-mount.ts:271-279` reads null as "the row has no bytes yet" and skips it; `lib/versioning/snapshot.ts:177-178` does the same for a container database, which `snapshot-mount.ts:260-261` reads as "deleted since the tree read". A HEAD on a bucket that does not exist is a 404, so `exists()` is false. `test/backup/snapshot.test.ts` (`skips a container database whose stored bytes are gone and finishes the snapshot`) pins the current behavior with exactly the shape of a lost object.
- Scenario: the bucket is emptied, deleted, or the mount's bucket name is edited to a wrong one. Create backup ends done and verified, holding `metadata.db` with every row and no file. Deleting the pre-restore safety copy after restoring it can then delete the old objects if the bucket comes back. A tell for the fix: a row with `size > 0` and a hash whose object is absent is a lost object, not a touched file whose upload never landed.
- Tests: `test/backup/slow-bucket.test.ts`, `Backup of an s3 mount whose bucket stalls or loses objects > a mount whose objects are gone from the bucket fails the backup`; `test/storage/s3-minio-backup.test.ts` (live), `Backup of an s3 mount whose bucket is gone (MinIO) > a bucket that no longer exists fails the backup instead of archiving the mount empty`.

**ST-3: `StorageBackend.delete` returns `false` both for "absent" and for "failed", so a delete that fails during an outage leaves the bytes with nobody told.**
- Evidence: `lib/storage/s3-storage.ts:283-295` and `lib/storage/local-storage.ts:34-46` both catch and return `false`; `lib/mount/mount.ts:773` ignores the result after the row is gone (`:766`); `lib/mount/upload-queue.ts:340, 422` add a `.catch` that can never fire; `lib/backup/safety-copy.ts:174-177` probes `exists` first to tell the two apart. `S3Storage.delete` sends a HEAD before every DELETE.
- Scenario: a permanent delete, or the invariant-7 re-delete after an orphaned PUT lands, fails during an outage. One generic log line, no retry, and the user's deleted bytes stay in the bucket for good.
- No test: the fix is a contract change (a throwing, idempotent DELETE); a test pins it once chosen. Fix together with ST-5.

**ST-5: permanent delete and empty-trash run per-file S3 HEAD and DELETE sequentially inside the request, with no ceiling.**
- Evidence: `lib/drive/drive.ts:512-518` → `lib/mount/trash.ts:186-208` → `lib/mount/mount.ts:772-773`, two unbounded requests per file. The routes (`routes/drive.ts:637, 671`) are not idle-exempt, so the 200 s idle close (`server.ts:47`) cuts them mid-loop.
- Scenario: a user empties a trash of 500 files while the provider is slow: 1,000 sequential calls, an empty reply at 200 s, and a trash that is partly emptied while the UI shows a failure. The cancel must stay awaited (invariant 7); the object delete need not, but dropping the `await` alone widens ST-3, so the two want one durable delete path.
- No test: the remedy changes the delete contract (ST-3).

**ST-6: `Drive.uploadFiles` leaks every remaining streamed temp when one file's finalize throws.**
- Evidence: `lib/drive/drive.ts:409-429` cleans only the failing file's temp; files after it were already streamed to `tmp/` by `streamFilesToTemp`. The only sweep is at mount init, for files older than 1 h (`mount.ts:210`).
- Scenario: a 10-file upload to an s3 mount whose PUTs fail. File 1 throws, files 2 to 10 stay in `tmp/`, and every retry leaks nine more until the Home re-inits more than an hour later.
- No test: needs a multi-file upload whose first finalize throws; small to add with the fix.

**UP-3 (low-medium): overlapping overwrites of one plain file are not serialized, so an older PUT that lands last wins.**
- Evidence: `lib/mount/mount.ts:898-918` and `lib/drive/drive.ts:639-672` take no path lock; the editor's conflict check (`routes/editor.ts:27-38`) and WebDAV's `If-Match` (`lib/webdav/resource.ts:110-129`) run before the PUT; the row update follows completion order.
- Scenario: A saves `notes.md` and the PUT stalls; B saves, lands, and gets success; A's older PUT lands. The object and the row are A's; B's edit is gone. B's next save does get a conflict, too late. Collab documents are not affected. The window is PUT latency: milliseconds on a healthy bucket, minutes on a stalled one.
- Test: `test/storage/upload-queue-stall.test.ts`, `direct (non-queued) PUTs > two overlapping overwrites of one file end on the bytes of the later write`.

**BK-5 (low-medium): a per-home backup never reads the crash temp an unclean shutdown leaves, so it archives the stale bucket object.**
- Evidence: `lib/versioning/snapshot.ts:152-181` reads the open handle, then the pending staged copy, then the stored object, never `mount.getTempPath(pathId)`, while `lib/mount/document-db.ts:117-127` adopts that temp as live state on the next open.
- Scenario: a document edited since its last upload; the API is SIGKILLed; nobody reopens it; the admin backs up the Home. The archive holds the older bytes, and restoring it rolls the tail edits back. Per-home backup is manual, so this is rare on eigen.is.
- Test: `test/backup/slow-bucket.test.ts`, `Backup of an s3 mount whose bucket stalls or loses objects > a document whose last edits survive only in its crash temp is archived with them`. Fix after DL-6 (see the order of work): with DL-6 open, reading the temp would archive a truncated file.

### Low

**UP-1 (also BK-6, ST-10): the shutdown drain budget is not a bound and starts late, so a stop with a stalled bucket or a running backup job ends in SIGKILL.** No data is lost: rows and staged copies replay on boot.
- Evidence: `lib/mount/upload-queue.ts:193-195` a flush that finds a running loop only sets the deadline; `:210` reads it only at the loop top; `:219` awaits `semaphore.run`, whose slot wait is unbounded (`utils/semaphore.ts:18-24`) and whose PUT runs to 120 s. `server.ts:67-74` runs `documentTransformRunner.close()` (5 s, `lib/document/transform/runner.ts:53`) and `drainBackupJobs()` (30 s for a backup or verify, unbounded for a restore, `lib/backup/jobs.ts:29, 141-142`) before `setShutdownDrainDeadline`. Inside a mount close the reindex close (120 s) and thumbnail jobs (30 s each) come first. `docker-compose.yml:74` grants 30 s.
- Scenario: `./eigen update` while a PUT is stalled or a per-home backup runs. The stop waits out the full 30 s and exits 137; later mounts of a multi-mount Home never close their databases, no document gets its final close-sync, and the light pre-update snapshot then holds neither the tails nor the staged bytes.
- Tests: `test/storage/upload-queue-stall.test.ts`, `shutdown drain with a stalled PUT > the shutdown flush returns by its deadline while a PUT is stalled`, `> the shutdown flush returns by its deadline while the destination semaphore is held`. BK-6 has no test: it is process-plus-Docker timing, and `test/backup/process-lifecycle.test.ts` (`Backup across signals`) already pins that shutdown waits for jobs.

**UP-4: a permanent delete during a direct overwrite PUT leaves the deleted bytes in the bucket.**
- Evidence: `lib/mount/mount.ts:753-773` cancels only the queue, then deletes; the direct PUT (`mount.ts:900`) is tracked nowhere, so its late landing recreates the object; the writer gets `ApiError(500, 'Failed to get updated file')` (`lib/drive/drive.ts:677-678`).
- Scenario: a save stalls, the owner empties the trash, the PUT lands. The object is orphaned for good; nothing sweeps orphans.
- Test: `test/storage/upload-queue-stall.test.ts`, `direct (non-queued) PUTs > a permanent delete during a stalled overwrite PUT leaves no object behind`.

**UP-5: staged copies superseded while another copy of the same key is mid-PUT are leaked.**
- Evidence: `lib/mount/upload-queue.ts:129-131` skips the unlink when `inFlight.has(storageKey)`, but `inFlight` is keyed by storage key (`:59, :286`), not by staged file. With s1 mid-PUT, sync 3 finds `prevStaging = s2` and keeps it though nothing references it. Only `reconcile` at mount init reclaims it (`:166-171`).
- Scenario: an hour of editing a 50 MB sheet under stalled PUTs leaves about 120 copies (6 GB) in `staging/` until the Home re-inits. Documents on eigen.is are small, hence low.
- Test: `test/storage/upload-queue-stall.test.ts`, `edits while a PUT is stalled > staged copies superseded behind a stalled PUT are removed`.

**UP-6: the create reconcile can report success for a container that provisioning later rolls back.**
- Evidence: `lib/drive/drive.ts:282` inserts the row before provisioning, `:295-299` rolls it back with no SSE; the create-mode HEAD (`lib/mount/document-db.ts:85-88`) has no ceiling; `packages/lib/src/core/drive/reconcile-create.ts:52-60` gives up at 15 s and matches any new id with the expected name, including a row still provisioning.
- Scenario: the HEAD stalls past 15 s and then errors (a late success would be fine). The hook reports "created", the server rolls back silently, and the user sits in an editor for a document that 503s and later vanishes.
- Test: `test/drive/create-stall.test.ts`, `Drive.create with a stalled storage probe > a listing taken while the create is still provisioning does not show the container`.

**UP-7: incomplete multipart uploads stay in the bucket on process death and on failed large writes.**
- Evidence: Bun uses multipart above 5 MiB; a `kill -9` mid-upload and a write that rejected `ConnectionClosed` both leave the upload listed. The queue's 120 s race does not abort it. Cleanup depends on the `AbortIncompleteMultipartUpload` 7-day rule (`packages/lib/src/constants/s3.ts:13`, written by `setS3LifecycleRule`, `lib/storage/s3-storage.ts:212-222`), which exists only after "Enable safe defaults". Whether Bun sends `AbortMultipartUpload` when the endpoint is still reachable is unverified.
- No test: `FaultStorage` cannot model multipart, and a live test would SIGKILL a child mid-upload through a stalling proxy.

**BK-2: `./eigen restore` replays the snapshot's staged uploads over the keys the kept-aside `data/` still names.**
- Evidence: `lib/mount/upload-queue.ts:155-175` re-enqueues every persisted row to its id-stable key; `cli/snapshot.ts:479-484` rekeys nothing, while the per-home restore gives every s3 row a fresh key (`lib/backup/materialize.ts:136-147`). The first-boot trash purge and an adopted crash temp act on the same shared keys.
- Scenario: a full snapshot taken with an upload still staged; the upload lands afterward and editing continues; the operator restores, then moves `data.pre-restore-*` back. That document opens with snapshot-time bytes. It needs a full snapshot with pending uploads or crash temps; the default light one carries neither.
- Test: `test/cli/snapshot-s3.test.ts`, `Whole-server snapshot of an s3 mount > a restore leaves the bucket objects of the data/ it keeps aside as they were`.

**CO-4: a failed open's cleanup deletes whatever sits in its cache slot, so a successor's database stays open outside the cache.**
- Evidence: `lib/mount/document-db.ts:57-62` deletes the slot without an identity check; its siblings are guarded (`:254-256, 327-329`). Open A parks on storage, a close takes A's getter, open B installs getter B, A fails and deletes B's entry. B runs its 30 s timer uncached and teardown never closes it; the next open adopts B's live temp.
- Test: `test/storage/docdb-open-close-race.test.ts`, `an open still loading from storage > an open that fails after a close took its slot leaves the successor's cache entry alone`. The fix is `if (mount.documentDbs.get(pathId) === getter)`.

**CO-5: a collab load that failed stays registered as an open document.**
- Evidence: `lib/drive/collab-registry.ts:26-38` never removes a failed getter; `utils/singleton.ts:23-26` resets on rejection, so `destructAll` (`:88-91`) and `enforceReadAccessBelow` (`:69-73`) re-run the whole load; `lib/versioning/restore.ts:59` reads `hasCollabDocument` as "was open" and skips the close, leaving the restored document loaded until teardown.
- Scenario: an open fails in an S3 blip; a later share change downloads the document again to walk zero connections; the next teardown re-runs the load and parks on it (DL-2).
- Test: `test/collab/collab-open-from-s3.test.ts`, `a failed download > a load that failed leaves no open-document entry behind`.

**DL-5: a copy whose source GET dies midway leaves its partial temp in `tmp/`.**
- Evidence: `lib/mount/copy.ts:59-61` writes the temp before the `try` whose `finally` (`:80-82`) cleans it; `writeTempWithHash` leaves cleanup to the caller. `Drive.createFileFromData` (`lib/drive/drive.ts:464-483`) does it right.
- Test: `test/storage/slow-download.test.ts`, `S3 reads that fail > a copy whose source GET dies midway leaves nothing in tmp/`.

## Standards findings

Grouped by rule. ST-1, ST-3, ST-5 and ST-6 are robustness findings above; ST-24 is split between DL-1 and UP-2 in the drift table. `scripts/check-standards.ts` passes; its three hits in the audited files (the documented seam cast at `lib/mount/document-db.ts:68`, the method-bearing `interface` in `lib/storage/types.ts`, the control-character biome-ignore at `lib/mount/helpers.ts:20`) are not findings.

### Error handling (CODE-STANDARDS.md:16, :37; CODE-EXAMPLES.md:50)

- **ST-2 (low)**: `S3Storage.exists` re-wraps its own `ApiError(400)` from `getKey` as a 503 (`lib/storage/s3-storage.ts:300-305`, `:258-265`); `delete` and `size` swallow the same 400 into `false` / `null`. A corrupt row's key then closes 1013 and retries forever instead of failing.
- **ST-4 (low)**: the linger close swallows a failed teardown without a log line (`lib/collab/collabDocument.ts:371`, also `:282`, `:299`). A close-time staging failure leaves the crash temp (bytes survive) and no trace of why the last edits never reached the bucket.

### Typing (AGENTS.md:19; CODE-STANDARDS.md:22-23, :26, :28)

- **ST-7 (medium)**: tests reach private fields through `as unknown as`, and one cast already makes an assertion vacuous. `test/storage/versioning.test.ts:394` casts `drive.documents` to a `Map`, but it is a `CollabRegistry` with no `size`, so `:411` compares `undefined` with `undefined`. The same shape drives `holdRetries` and `shrinkPutTimeout` in `test/fault-storage-helpers.ts:221-223, 271-293`; a rename of `backoffMs` silently brings back the restart race `FaultMount` exists for. Also `test/storage/sync-resilience.test.ts:872, 892, 937`, `test/collab/collab-close-linger.test.ts:65`, `test/storage/versioning.test.ts:195, 222, 334`. The neighboring convention is a non-private field with an `// internal` note naming its users (`lib/mount/mount.ts:57-88`).
- **ST-8 (low)**: missing return types on public domain methods (`lib/collab/collabDocument.ts:295, 329, 338, 381, 394`); a hand-typed row in `lib/backup/safety-copy.ts:99` where its neighbor derives from `$inferSelect` (`lib/backup/snapshot-mount.ts:31`).

### One source of truth (AGENTS.md:22; ARCHITECTURE.md:119)

- **ST-9 (low)**: the rule for a row's storage key is written twice: `lib/mount/mount.ts:714-746` and `lib/backup/snapshot-mount.ts:89-107` ("Mirrors Mount.resolveStoragePath"). A key-layout change would make backup read keys Mount never wrote; today that drop is silent through BK-3.
- **ST-10 (low, the constants half of UP-1)**: the shutdown budgets live in five modules and do not fit the 30 s grace: `server.ts:20` (20 s), `lib/document/transform/runner.ts:53` (5 s), `lib/backup/jobs.ts:29` (30 s), `lib/mount/content-reindex-queue.ts:17` (120 s), `lib/shared/thumbnails.ts:73` (30 s), `docker-compose.yml:74` (30 s). `REINDEX_CLOSE_TIMEOUT_MS` restates `UPLOAD_PUT_TIMEOUT_MS` (`lib/mount/upload-queue.ts:25`) as a second literal. `idleTimeout: 200` is restated as prose in `server.ts:40-45`, `routes/drive.ts:224-225`, `docs/STORAGE.md:212` and `docs/EXPORT.md:81, 84`. Unnamed one-off literals: `lib/storage/s3-storage.ts:153` (5000), `lib/shared/thumbnails.ts:73` (30_000).
- **ST-11 (low)**: "is this mount remote" has five spellings: `lib/mount/mount.ts:1008-1015`, `lib/mount/helpers.ts:181-184`, `lib/backup/materialize.ts:94-95`, `lib/backup/safety-copy.ts:142`. A fourth storage type would count as remote in `Mount` but get no queue.
- **ST-12 (low)**: `pending_uploads` has two writers with two staging-name conventions: `UploadQueue.enqueueStaged` (`lib/mount/upload-queue.ts:114-133`, `${uuid}.db`) and `materializeMount` (`lib/backup/materialize.ts:152-164`, bare UUID, direct INSERT).
- **ST-13 (low)**: `'data.db'` is spelled in nine modules and backup keeps its own set of container database names (`lib/backup/snapshot-mount.ts:50-52`); a third managed database would be archived as a plain file with no lock and no `VACUUM INTO`.
- **ST-14 (low)**: the schema-stamp reader exists three times with different rules (`lib/core/managed-database.ts:146-153`, `lib/backup/materialize.ts:52-63`, `lib/core/blob-store.ts:36`); a text stamp passes the restore check and fails on first load.
- **ST-15 (low)**: `PRAGMA busy_timeout = 5000` in four modules (`lib/core/managed-database.ts:115`, `lib/mount/helpers.ts:132`, `lib/core/blob-store.ts:30`, `lib/mail/maildb.ts:23`).

### Test-only surface on production code (WORKING-METHOD.md:18)

- **ST-16 (low, the root of ST-7)**: knobs only tests use, through two mechanisms: private fields (`lib/mount/upload-queue.ts:65-68`, `lib/collab/collabDocument.ts:195`, `lib/mount/content-reindex-queue.ts:41-42`) and a parameter (`lib/collab/loading-heartbeat.ts:24`). `Mount.flushContentReindex`, `drainPendingUploads` and `pendingUploadCount` have no production caller (`lib/mount/mount.ts:1047-1066`); `Drive.flushContentReindex` (`lib/drive/drive.ts:735-741`) and `provisionManagedDbs` (`:1128-1136`) lack a `// Called by:` note.

### Comments (CODE-STANDARDS.md:36)

- **ST-17 (low)**: production comments transcribe incidents, removed-spec phases and review argument: dated incidents at `lib/mount/document-db.ts:121, 209`, `lib/core/managed-database.ts:91`, `lib/collab/loading-heartbeat.ts:9`; "Phase 1a/1b" and "§3" labels at `lib/mount/document-db.ts:13, 105, 108, 185, 206`, `lib/mount/mount.ts:71, 131, 1054`, `lib/sync/index.ts:1`, which resolve only through `docs/SYNC.md:58-82`; review argument at `lib/mount/helpers.ts:174-180`, `lib/backup/restore.ts:173`, `lib/mount/upload-queue.ts:78-80`.
- **ST-18 (low)**: stale pointers: `docker-compose.yml:71-72` names `index.ts` for `SHUTDOWN_DRAIN_BUDGET_MS` (it is `server.ts:20`); `test/storage/upload-queue-failure-injection.test.ts:119` cites old line numbers and `:127, :168` a 0 to 2 s backoff that `FaultMount` pins at 60 s; `test/storage/sync-resilience.test.ts:409-410` names `uploadClosing` (the field is `closing`); `test/storage/docdb-open-close-race.test.ts:14` cites a doc that does not exist; test titles carry review ids ("Gap 1", "P2-6a", "Finding 1", "Batch-2 review") in `sync-resilience.test.ts`; `packages/lib/src/core/collab/hooks/use-collab-doc.ts:165-168` says y-websocket "would retry every 100ms", while 3.1.0 backs off to 2.5 s.

### Imports (CODE-EXAMPLES.md:173)

- **ST-19 (low)**: aggregate specifiers (`@workspace/lib/constants`, `@workspace/lib/types`) beside domain subpaths in `lib/mount/mount.ts:4-14`, `lib/drive/serve-file.ts:1`, `lib/mount/helpers.ts:3`, `lib/mount/db-config.ts:1`, `lib/drive/drive.ts:2-11`, `lib/storage/types.ts:3`.

### Tests (TESTING.md:9, :12, :14, :65, :74)

- **ST-20 (low)**: real sleeps where the neighbor is deterministic: `test/storage/upload-queue-chaos.test.ts:118, 163, 193` (`Bun.sleep(120)` where `drainPendingUploads` suffices; `:187-193` never calls `restorePutTimeout`); `test/storage/sync-resilience.test.ts:255, 273` use `writeDelayMs`, which TESTING.md rules out, the second spending 2 s and asserting `elapsedMs < 4_000`.
- **ST-21 (low)**: `upload-queue-chaos.test.ts` and `upload-queue-failure-injection.test.ts` pin the same three behaviors with their own setup, and both sit in `test/storage/` instead of mirroring `lib/mount/`; `docdb-open-close-race.test.ts` covers `lib/mount/document-db.ts` from `test/storage/` with its own `provisionDoc`; `s3-minio.test.ts:45-54` re-implements `createGetLocalDatabase`; `fault-storage.test.ts:21-24` hand-rolls `restoreEnvAfterEach`.
- **ST-22 (low)**: `test/storage/storage.test.ts:7` writes into the repo's real `data/` instead of `data-test/`.
- **ST-23 (low)**: the test `FaultStorage` does not fail the way `S3Storage` fails: `test/fault-storage-helpers.ts:136-141` throws a plain `Error` where `S3Storage.exists` throws `ApiError(503)`, and `:94-99` throws synchronously from `read` where the real one is lazy. `test/drive/create-resilience.test.ts:62-63` asserts only `rejects.toThrow()`, so a 503-to-500 regression stays green. The suites that talk to the fake S3 endpoint pin the 503 and 1013 shapes directly.

### Docs drift

| Doc claim | Code | Drift |
|---|---|---|
| `docs/SYNC.md:5-6` "A slow/failing S3 backend becomes background lag, never a request hang" | `lib/mount/document-db.ts:86, 148-151`; `lib/mount/mount.ts:494, 900, 990` | true for `data.db` writes only; reads and plain-file PUTs block requests (DL-1, UP-2) |
| `docs/SYNC.md:23-24` "`create` ... return[s] after the *local* write" | `lib/mount/document-db.ts:85-88` | create waits on an unbounded HEAD first (UP-6) |
| `docs/ARCHITECTURE.md:43` "Write-behind S3 uploads: stage + enqueue" | `lib/mount/mount.ts:535` → `:990` | user uploads are synchronous PUTs (UP-2) |
| `docs/SYNC.md:44` adopts a temp "only if it's a valid, non-collapsed SQLite" | `lib/mount/helpers.ts:147-154` | "valid" is a 16-byte magic check (DL-6) |
| `docs/SYNC.md:45-46` "worst case a transient 503, never a wipe" | `lib/core/managed-database.ts:107-130`; `lib/mount/document-db.ts:117-127` | the wipe half holds; the result is a permanent `SQLITE_CORRUPT` (DL-6) |
| `docs/SYNC.md:50`, `:76-77` (invariant 7) no resurrection | `lib/mount/mount.ts:772-773` | holds for queued uploads only (UP-4); a failed re-delete is silent (ST-3) |
| `docs/SYNC.md:66-67` (invariant 2) a staged copy is deleted once its PUT acks | `lib/mount/upload-queue.ts:129-131` | superseded copies leak behind a stalled PUT (UP-5) |
| `docs/SYNC.md:89` "Each PUT is raced against a ~120 s client-side ceiling" | `lib/mount/upload-queue.ts:297-314` | queue only (UP-2); a timed-out PUT releases its permit, so in-flight requests to one destination grow past 4 every 120 s |
| `docs/SYNC.md:97-98` residual "(logged when detectable)" | `lib/mount/upload-queue.ts:330` | a PUT settling after teardown returns silently |
| `docs/SYNC.md:114-116` the flush is "bounded by `SHUTDOWN_DRAIN_BUDGET_MS`" | `lib/mount/upload-queue.ts:210, 219` | not a bound (UP-1) |
| `docs/SYNC.md:136-137` 30 s grace "so the shutdown drain (20 s) can finish" | `server.ts:67-74`; `lib/backup/jobs.ts:29, 141-142` | the budget starts after up to 35 s (UP-1) |
| (none) | `lib/mount/upload-queue.ts:162-165` | reconcile drops a row whose staged copy is gone, with no log line |
| `docs/COLLAB.md:28` storage-unavailable opens "close with their own codes" | `routes/collab.ts:252-256`; `lib/mount/mount.ts:966-971` | a GET failure after a good HEAD closes 1008 (DL-4) |
| `docs/COLLAB.md` "The route speaks first during a cold load" | `lib/mount/mount.ts:966` | the heartbeat keeps the socket alive; nothing bounds the load (DL-1) |
| `lib/mount/content-reindex-queue.ts:13-17` "a black-holed backend would otherwise park teardown forever" | `lib/mount/document-db.ts:318-320` | teardown still parks on the extract's open (DL-2) |
| `docs/STORAGE.md:46-48` callers may use `new Response(file)` | `lib/drive/serve-file.ts:58-59` | wrong for an `S3File`, which must be streamed (ST-25) |
| `docs/STORAGE.md:52-63` `StorageBackend` table | `lib/storage/s3-storage.ts:283-315` | `delete` and `size` failure contracts undocumented (ST-26) |
| `docs/STORAGE.md:71` `exists-throw` is "the shape `mount/document-db.ts` raises for an unreachable object" | `lib/mount/document-db.ts:90, 149`; `lib/storage/s3-storage.ts:304` | document-db raises it for a missing object; the unreachable shape is `S3Storage.exists` (ST-26) |
| `docs/STORAGE.md:117` a new id with the expected name "is exactly 'created by this request'" | `lib/drive/drive.ts:282, 295-299` | a row still provisioning can roll back (UP-6) |
| `docs/STREAMING_UPLOADS.md:77` multipart "needed for files > 5GB" (out of scope) | Bun behavior | Bun already uses multipart above 5 MiB; interrupted uploads are undocumented (UP-7) |
| `docs/BACKUP.md:13` s3 objects are "downloaded out of the bucket"; `:172` "A backup fails if a bucket cannot be read" | `lib/mount/mount.ts:867-875`; `lib/backup/snapshot-mount.ts:271-279` | an absent object or bucket reads as "no bytes" (BK-3) |
| `docs/BACKUP.md:14` freshest-first, "the newest local bytes" | `lib/versioning/snapshot.ts:152-181` | the crash temp is never read (BK-5) |
| `docs/BACKUP.md:53`, `:175` one job per Home | `lib/backup/jobs.ts:58-80` | the slot has no time bound (DL-1) |
| `docs/BACKUP.md:164` "A full one holds all of `data/`" and the not-in-a-snapshot list; `docker/SETUP-GUIDE.md:202, 212, 216` | `cli/snapshot.ts:258-260` | an s3 mount's bytes are not in `data/` and not listed as missing (BK-1) |
| `docs/BACKUP.md:164` a light snapshot "leaves out each mount's file folders" | `cli/snapshot.ts:45-47` | `LIGHT_SKIPS` drops every folder under a mount, `staging/` and `tmp/` included; on another host the pending rows are dropped (ST-27) |
| `docs/BACKUP.md:166`; `docker/SETUP-GUIDE.md:223`; `cli/snapshot.ts:84-88` what a restore replaces "is kept aside" | `lib/mount/upload-queue.ts:155-175` | the kept-aside copy's objects are overwritten by replay (BK-2) |
| `test/storage/sync-resilience.test.ts:284` "The deadline bounds when the loop STARTS new PUTs" | `lib/mount/upload-queue.ts:219` | a PUT queued behind the semaphore starts after the deadline (UP-1) |
| `docker-compose.yml:71-72` `SHUTDOWN_DRAIN_BUDGET_MS` in `index.ts` | `server.ts:20` | wrong file (ST-18) |

### Followed cleanly

Every S3-touching Drive method a route reaches has a `SharedDrive` wrapper with a permission check (read, write or owner, `lib/drive/sharedDrive.ts:121-548`). No audited file calls `getHome()` for another user's data (none in `lib/backup`, `lib/mount`, `lib/storage`, `lib/sync`, `lib/collab`). User input never shapes an S3 key beyond the extension: keys are `buildStorageKey(uuid, name)` (`lib/mount/helpers.ts:94-103`) after `validateName` (`:34-47`), `S3Storage.getKey` refuses `..` and empty segments (`lib/storage/s3-storage.ts:255-267`), and keys with `?`, `#`, `%2f`, spaces and non-ASCII round-trip byte-identical against MinIO. Every backend lib import is React-free, with no domain barrel. Every tracked `*.test.ts` lives under `<workspace>/src/test/` (`scripts/check-test-layout.ts` passes). Every fire-and-forget carries a `.catch`, and no bare async result is used as a boolean.

## Backup and update behavior per flow

### `./eigen backup`

The launcher stops every container (`docker compose stop`, SIGTERM, 30 s grace, `eigen:479-484`), the CLI tars the quiet `data/` plus `.env.production` (`cli/snapshot.ts:249-263`), and Eigen starts again. The snapshot never talks to S3.

- Snapshotted for an s3 mount: a full snapshot holds `mounts/<id>/metadata.db` plus `staging/` (staged copies whose PUT has not acked, with their `pending_uploads` rows), `tmp/` (crash temps) and `thumbs/`. A light one holds `metadata.db` only (`LIGHT_SKIPS`, `cli/snapshot.ts:45-47`). Neither holds a bucket object (BK-1). Bucket versioning plays no part.
- Slow or unreachable bucket: the snapshot itself is unaffected. The stop before it drains for 20 s at most (UP-1); what it cannot flush stays staged, which a full snapshot carries and a light one does not. The command reports success either way.
- A per-home backup job running at the stop spends the whole grace in `drainBackupJobs`, and the API is SIGKILLed before any Home closes (UP-1).

The per-home backup (admin pane, `snapshotHome`) does hold the objects: it walks the mount's `paths` table and copies each row's bytes freshest-first, a container database through `stageManagedDbCopy` under the container lock, a plain file through `readKey` (`lib/backup/snapshot-mount.ts:235-284`). A read that throws fails the backup with `storage unreachable (<code>)` (`:221-225`). A read that stalls holds the job and the Home's slot until restart (DL-1). An absent object is skipped and the backup verifies green (BK-3). A crash temp is never read (BK-5). A container copy's GET holds that container's lock (DL-3).

### `./eigen update`

`update_apply` (`eigen:891-922`) stops Eigen, saves `snapshot --pre-update` with the running build, switches the pins and starts the new version. The snapshot is full unless `--light` is given and no release since the running one is breaking (`cli/snapshot.ts:186-188`).

- For an s3 mount neither kind holds document content. A breaking release that converts documents writes the converted bytes to the bucket, and no snapshot can undo that (BK-1).
- Uploads pending at the stop: the drain flushes what it can in 20 s; the rest stays in `staging/` with its rows, and a document that missed its final close-sync (the SIGKILL case) keeps its tail in `tmp/`. A full snapshot contains both; a light one has the rows but not the staged bytes. The update itself loses nothing: first boot replays the rows (`lib/mount/upload-queue.ts:155-175`) and the next open adopts each crash temp.
- A light rollback swaps `metadata.db` back and leaves `staging/` and `tmp/` in place: a snapshot-time row whose staged copy remains replays it, a row whose copy has since uploaded is dropped (the object keeps the newest bytes), and a staged copy made after the update with no row in the old `metadata.db` is deleted by `reconcile`. How far back an s3 document goes depends on which uploads landed in between.

### `./eigen restore`, `./eigen rollback` and the per-home restore

The CLI unpacks the snapshot while Eigen runs, stops Eigen, and swaps with renames: a full snapshot replaces `data/` whole, a light one replaces the light set file by file (`cli/snapshot.ts:290-304, 479-484`). The replaced state goes aside as `data.pre-restore-<UTC>`. Nothing contacts the bucket and nothing rekeys.

- Needs from the bucket: every object the restored `metadata.db` names, at the same id-stable key, unchanged. That is usually untrue (BK-1). A file edited since reads its new bytes; a file deleted since has a row and no object (downloads find nothing, a document open answers 503, never opens empty). Staged uploads replay over keys the kept-aside `data/` names (BK-2). The first-boot trash purge deletes by key.
- Slow or unreachable bucket: the command is unaffected; it shows only after start.
- Resumable: the command is not resumable; it either swaps or leaves the old state in place.

The per-home restore (admin pane, `restoreHome`) never talks to the bucket during the job. `replaceHomeFolder` extracts and verifies locally, evicts the Home and moves the folder aside (`lib/backup/restore.ts:58-114`); `materializeMount` gives every s3 row a fresh key `${id}-r${stamp}`, moves each archived file into `staging/` and writes a `pending_uploads` row (`lib/backup/materialize.ts:136-165`). The restore needs only that the bucket eventually accepts PUTs, never overwrites or deletes an object, and leaves the `.pre-restore-` copy pointing at objects that hold its bytes. A slow bucket neither slows nor fails it: the restored Home serves every file from staging while PUTs wait. The upload half is resumable by construction; an interrupted install is rolled back (`restore.ts:93-103`, or by boot recovery after a process death) and a rerun from the same artifact works, with new keys.
- Tests: `test/backup/slow-bucket.test.ts`, `Backup restore of an s3 mount onto a bucket that takes no PUTs > the restore finishes without the bucket, serves its files, and lands them after a restart`, `> a restore that failed midway runs again from the same artifact`.

A safety-copy delete (`lib/backup/safety-copy.ts:127-187`) deletes only keys that neither the live Home nor another copy references, keeps the folder and answers 503 if any delete fails, and holds the Home's slot with no bound against a bucket that never answers (DL-1).

### First start after an update or a restore

Boot does not block on S3. `server.ts:27-32` runs local recovery and listens; Homes open lazily; `Mount.init` does only local work, starts the `reconcile` drain without awaiting it and fires `purgeTrash` in the background (`lib/mount/mount.ts:153-229`). Listings, search and metadata work from `metadata.db`. A document with a staged copy or a crash temp opens from local disk. A document whose only copy is in the bucket opens through an unbounded HEAD and GET (DL-1), and a truncated temp left by a SIGKILL mid-GET fails every open (DL-6). The Home is never read-only, and no document comes up empty: the `mustExist` guard and `isViableRecoveryTemp` refuse an empty working copy.

## Simplification proposal

### Three missing primitives

1. **No S3 request can be given a deadline or aborted.** Five mechanisms approximate one: the PUT `Promise.race`, orphan tracking, the loop-top drain deadline, the backup-job budget and the reindex close cap, plus the client-side create reconcile. None covers reads.
2. **"Where are the freshest bytes for key K" has four sources and four resolvers, none complete.** `readKey` and `readRange` (staged, object), `onOpen` (crash temp, staged, object), `stageManagedDbCopy` (handle, staged, object). BK-5 is the crash temp missing from the last one.
3. **S3 is written by two roads**: queued for `data.db`, direct for files. Every guarantee (ceiling, semaphore, ordering, cancel) is built once and holds for half the writes.

### Target invariants

- **I1.** Every S3 request is one call on `S3Storage` that carries a deadline and the process shutdown signal, aborts its socket when either fires, and fails as `ApiError(503)` naming the key. A missing object is `null` or `false`, never an error; a bad key is `ApiError(400)` before any request. A GET runs on an idle deadline reset per chunk; a PUT and a HEAD on a total deadline scaled by size. **Proposal to prototype, not established:** do the HTTP through `fetch(file.presign({ method }), { signal, body })`, since `presign` is the one Bun S3 surface whose result can go through a `fetch` that takes an `AbortSignal` (`bun-types` `s3.d.ts:414-462, 732-767`); Bun keeps credentials and signing. `signedS3Request` (`lib/storage/s3-storage.ts:111-155`) already runs bucket-config calls as a hand-signed `fetch` with `AbortSignal.timeout(5000)`. Before committing, check a 20 MB `BunFile` PUT body (multipart is lost with a single presigned PUT), the idle timer on a trickling GET, and error codes on 404 and 5xx.
- **I2.** `tmp/<pathId>` exists only as the working copy of an open database or as the marker of an unclean shutdown. It is created by rename from a complete download into `tmp/<uuid>`. Mount init turns every leftover one into a staged copy (`quick_check`, `VACUUM INTO`, enqueue, unlink) before the queue drains and before the sweep; one that fails `quick_check` is discarded and logged.
- **I3.** S3 is written only by the upload queue. Every producer (data.db sync and close, user upload, editor save, WebDAV PUT, version snapshot, per-home restore) stages bytes and enqueues through `UploadQueue.enqueueStaged`. The newest row per key wins, and `deletePath`'s cancel covers every write. An upload is done when it is staged, the meaning a restore already uses.
- **I4.** The freshest bytes for a key resolve in one function on `Mount`: the open handle (`VACUUM INTO`), else the pending staged copy, else the object. Every reader calls it; nothing else calls `storage.read`.
- **I5.** Teardown never awaits a build, and process shutdown is one `AbortSignal` with one budget that every S3 request, drain and backup job chains onto. `stop_grace_period` is that budget plus a margin.

A sixth already holds and stays: a per-home restore gives every s3 row a fresh key.

### Keep, merge, delete

| Mechanism | Verdict | Findings removed |
|---|---|---|
| `S3Storage` error handling: `exists` → 503, `delete` pre-HEAD → `false`, `size` → `null`, lazy `read` (`lib/storage/s3-storage.ts:269-315`) | merge into I1 | DL-1, DL-4, ST-1, ST-2, ST-3, ST-5's round-trips, ST-23 shrinks, ST-26; one request per read and per delete instead of two |
| PUT ceiling `UPLOAD_PUT_TIMEOUT_MS` race (`lib/mount/upload-queue.ts:291-314`) | merge into I1 | UP-7's parallel multipart |
| Orphan tracking, `lastAcked` re-stage, commit-order distrust (`upload-queue.ts:14-19, 354-380, 393-458`) | delete after I1 | ST-17's densest comments, ST-20, ST-21's suite overlap |
| `isSqliteFile` before the PUT, `isDatabase` column, `PENDING_UPLOAD_KIND_VERSION` (`upload-queue.ts:268-281`, `lib/backup/materialize.ts:100-107`) | delete: third guard on one invariant, closed at the source by `mustExist` and I2 | the restore gate, `docs/BACKUP.md:160` |
| Dev injector `EIGEN_STORAGE_FAULT` (`lib/storage/fault-storage.ts`) | delete | ST-26's shape claim, the second fault double |
| `downloadKeyToTemp` onto the live path (`lib/mount/mount.ts:958-979`) | merge into I2 (download to `tmp/<uuid>`, rename) | DL-6 |
| Open-time crash adoption: `isViableRecoveryTemp`, `recoveredFromCrash`, `markDirty` (`lib/mount/document-db.ts:114-135, 206-214`, `lib/mount/helpers.ts:142-154`) | merge into I2 (boot-time adoption) | BK-5, the DL-6 residue |
| `readKey`, `readRange`, `onOpen`'s staged branch, `stageManagedDbCopy` with two orders (`mount.ts:867-886`, `document-db.ts:136-147`, `lib/versioning/snapshot.ts:146-181`) | merge into I4 | BK-5, DL-3 (the GET moves out of the lock) |
| Direct s3 PUTs in `createFile`, `createFileFromTemp`, `writeFile`, `writeFileFromTemp` (`mount.ts:494, 535, 900, 927`) | delete on s3 (I3); keep on local | UP-2, UP-3, UP-4, the SYNC.md and ARCHITECTURE.md drift |
| Create-mode HEAD (`document-db.ts:85-88`), `createWithReconcile` and `CreateUnconfirmedError`, the inner rollback in `provisionManagedDbs` (`lib/drive/drive.ts:1136-1157`) | delete once create is local end to end | UP-6, the "Create reconcile" section of STORAGE.md |
| Teardown awaiting builds (`document-db.ts:318-320`, `lib/drive/collab-registry.ts:88-91`), loop-top deadline, `drainBackupJobs` budget, `REINDEX_CLOSE_TIMEOUT_MS`, the `server.ts:62-80` order | merge into I5 (close only `peek()`ed instances; one shutdown signal) | DL-2, CO-2, UP-1, BK-6, ST-10, the compose comment |
| `inFlight` keyed by storage key (`upload-queue.ts:59`) | keep, keyed by staging path | UP-5 |
| Failed-build delete in `openDocumentDb` (`document-db.ts:57-62`) | keep, identity-guarded | CO-4 |
| `CollabRegistry` entry of a failed load | keep the registry, drop the failed entry | CO-5 |
| `uploadFiles` temp cleanup (`drive.ts:409-429`) | keep, clean every remaining temp | ST-6 |
| `storageKeyOf` / `flatStorageKey` in backup (`lib/backup/snapshot-mount.ts:89-107`) | delete, call `Mount.getStorageKey` | ST-9 |
| `materializeMount`'s direct `pending_uploads` INSERT (`materialize.ts:152-164`) | keep the fresh keys, enqueue through `UploadQueue` | ST-12 |
| Five "is remote" predicates | merge into two getters on `Mount` | ST-11 |
| Test facades (`mount.ts:1047-1066`) and test-only private fields | delete, or non-private fields with an `// internal` note | ST-7, ST-16 |
| Legacy absolute `stagingPath` pass-through (`upload-queue.ts:85-90`) | delete once `SELECT count(*) FROM pending_uploads WHERE stagingPath LIKE '/%'` is 0 on every eigen.is mount | none |
| `withPathLock` (`mount.ts:602-624`) | keep; take it after the object GET | DL-3 |

### Order of work

1. **I1: `S3Storage` with deadlines, one error contract, an idempotent throwing delete; delete `fault-storage.ts`.** Fixes DL-1 (high), DL-4, ST-1 to ST-3. Independent. Risk medium: it is under every S3 call, but the interface is six methods and the MinIO suite plus the fake-endpoint suites pin it. Prototype the presign `fetch` first.
2. Cheap wins, one PR: `inFlight` by staging path (UP-5), identity guard (CO-4), drop a failed registry entry (CO-5), clean every upload temp (ST-6), `writeFile` under `withPathLock` (UP-3), log a dropped `reconcile` row, fail a backup on an absent object whose row has a size and a hash (BK-3). Independent. Risk low.
3. **I2 part one: download to `tmp/<uuid>`, rename on completion.** Fixes DL-6 (high). Independent. Risk low.
4. **BK-1, a decision rather than a simplification:** `./eigen backup` and `./eigen restore` say that an s3 install's bytes are not in a snapshot, the docs list the bucket as not in any snapshot, and bucket versioning becomes part of s3 setup; the per-home archive stays the complete one. Later, `./eigen restore` rekeys s3 rows the way `materializeMount` does. Addresses BK-1 (high) and BK-2. Independent. Risk low.
5. **I5: `closeAllDatabases` closes only `peek()`ed instances and a build that lands after `closing` closes itself; one shutdown signal and budget owned by `server.ts`, with the job budget and reindex cap derived from it and `stop_grace_period` set to budget plus 10 s.** Fixes DL-2 (high), CO-2, UP-1, BK-6, ST-10. Needs step 1. Risk medium: shutdown ordering.
6. I2 part two: boot-time adoption at `Mount.init` before `reconcile()`; delete open-time recovery. Fixes BK-5, through the one adoption gate and an open plus `VACUUM INTO` (a raw copy without its `-wal` loses exactly the tail BK-5 wants). Needs step 3. Risk medium-high: it touches the `data.db` lifecycle and `pending_uploads` together, so it lands alone, with the crash-recovery suites green before and after and a full `./eigen backup` of eigen.is first.
7. I4: one resolver on `Mount`; the object GET happens before the container lock. Fixes DL-3. After step 6. Risk low-medium.
8. Delete orphan tracking, `UPLOAD_PUT_TIMEOUT_MS` and the `isSqliteFile` / `isDatabase` guard. Needs step 1. Risk medium: the remaining residual (a PUT whose body fully arrived before the abort lands with the earlier server timestamp, so a newer retry still wins) is the one SYNC.md already accepts for process death; SYNC.md states it as the one residual.
9. I3: s3 writes stage and enqueue; `materializeMount` enqueues through the queue. Fixes UP-2, UP-4. After step 8. Risk medium: "uploaded" comes to mean staged.
10. Delete the create-path HEAD, the inner rollback and `createWithReconcile`. Fixes UP-6. After step 9. Risk low.
11. Delete the test facades, the legacy pass-through, the backup key copy and the extra predicates; strip incident dates, Phase labels and review ids from comments; rewrite SYNC.md around I1 to I5. Docs and comments only.

### What not to simplify

- The frozen `VACUUM INTO` copy as the upload payload: every later invariant leans on the payload being immutable and WAL-complete.
- Durable `pending_uploads` rows rather than an in-memory queue: they make restart, host move and idle teardown safe.
- One semaphore per destination, not per process: a team mount on another bucket must not queue behind one slow provider.
- `mustExist` with `create: false`: the one guard on "never open empty" that refuses at the SQLite boundary, where the fact is known.
- Delete-before-close and `closingDocumentDbs`: the open/close race suite reproduces what they prevent.
- The container path lock around replace and copy; only the object GET moves out from under it.
- The loading heartbeat, the close linger, `connectionsByOwner` and the data epoch: they answer client constants and restore semantics, not S3 behavior.
- Fresh keys on the per-home restore: the reason a safety copy of an s3 Home is complete.
- `archive.ts`'s own tar, and the two Yjs loaders' different corruption policies (`lib/collab/yjs-loader.ts`: skip for a live document, fail loud for a restore).

## Test environment

| File | Covers |
|---|---|
| `test/storage/slow-download.test.ts` (new) | DL-1 to DL-6 over the fake S3 endpoint; pins that an in-process GET failure leaves no working copy and that an abandoned stream closes its upstream GET |
| `test/collab/collab-open-from-s3.test.ts` (new) | the collab route over a real WebSocket and a real `S3Client`: heartbeat through a stall, a shared load, a reconnect, a cut body, an empty 200; DL-4 (as CO-3) and CO-5 |
| `test/storage/docdb-open-close-race.test.ts` (changed) | `an open still loading from storage`: close during a load, DL-2 (as CO-2), CO-4 |
| `test/storage/upload-queue-stall.test.ts` (new) | UP-1 to UP-5; pins coalescing behind a stalled PUT and replay after a deadline |
| `test/drive/create-stall.test.ts` (new) | UP-6 |
| `test/backup/slow-bucket.test.ts` (new) | BK-3, BK-4 (as DL-1), BK-5; pins the resumable per-home restore and a rerun after a failed one |
| `test/cli/snapshot-s3.test.ts` (new) | the real CLI `snapshot` and `restore` on an s3 install: BK-1, BK-2; pins what a full and a light tar hold |
| `test/storage/s3-minio-backup.test.ts` (changed) | live MinIO: BK-3 on a bucket that does not exist |
| `test/fake-s3-server.ts` (new harness) | `FakeS3Server`, the raw TCP S3 endpoint the real `S3Storage` talks to, with per-key `stall`, `stall-body`, `cut`, `empty` and `fail` faults; used by the first two files |

Run one file from `apps/api`:

```
cd apps/api && bun test --preload ./src/test/preload.ts src/test/storage/slow-download.test.ts
```

The live suites (`s3-minio.test.ts`, `s3-minio-backup.test.ts`) skip unless `S3_TEST_ENDPOINT` is set:

```
cd apps/api && S3_TEST_ENDPOINT=http://localhost:9000 bun test --preload ./src/test/preload.ts src/test/storage/s3-minio-backup.test.ts
```

The `minio/minio` and `minio/mc` images on docker.io no longer pull, so `scripts/s3-local/docker-compose.yml` does not start as written. `cgr.dev/chainguard/minio` works; there is no `mc`, so the bucket is a folder created inside `/data`:

```
docker run -d --name eigen-minio -p 9000:9000 -p 9001:9001 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin cgr.dev/chainguard/minio server /data --console-address :9001
docker exec eigen-minio mkdir -p /data/eigen
```
