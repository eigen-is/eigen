# S3 Robustness Audit (2026-09): slow and stalling S3

This audit covers the S3 path when the bucket is slow, stalls or fails: every HEAD, GET, PUT and DELETE, what bounds it, what it holds while it waits, and what a restart, backup, update or restore does with it. The verdict: no steady-state path loses data (the write-behind queue for `data.db` coalesces edits, survives a stalled PUT and replays on restart), but nothing bounded time, so a stalled GET hung a document, then its owner's Home, then shutdown. On this branch every S3 read and metadata call got a deadline and a 503, teardown no longer waits on a download, a download never writes the live working copy, and a handful of leaks and races are fixed. Still open: direct (non-queued) PUTs, a trickling body, two backup edges and a restore edge, listed under [Open](#open).

Test paths are relative to `apps/api/src/test/`. A test marked *failing* runs as `test.failing` and flips to a plain `test` when its gap is fixed.

## Findings

| ID | Finding | Severity | Status | Test |
|---|---|---|---|---|
| DL-1 | No S3 call had a deadline of Eigen's own. Bun's ~360 s inactivity timeout was the only bound, longer than every other ceiling, and a trickle never trips it | high | fixed (idle bound; see trickle under Open) | `storage/slow-download.test.ts`: `a download whose HEAD stalls answers 503 instead of waiting on the backend`, `a document open whose data.db GET stalls mid-body answers 503`; `backup/freshest-first.test.ts`: `a GET that stalls ends the backup job, so the home can be restored again`; `backup/safety-copies.test.ts`: `a delete against a bucket that never answers gives the home slot back` |
| DL-2 | Home teardown awaited a document open parked in its GET, or a content extraction parked in its read, so one stalled GET hung every request for that owner | medium | fixed: teardown aborts both | `storage/slow-download.test.ts`: `the owner's next request gets a Home while the idle one waits on a stalled document GET`, `mount teardown does not wait on a text extraction whose GET stalls`; `storage/docdb-open-close-race.test.ts`: `mount teardown settles while an open is parked on storage` |
| DL-3 | A version snapshot holds the container lock across its S3 GET | low | bounded by the deadline, not removed | `storage/slow-download.test.ts`: `the container lock frees while a version snapshot waits on its S3 GET` |
| DL-4 | A failed S3 read surfaced as a raw `S3Error`: HTTP 500 and collab close 1008 instead of 503 and 1013 | medium | fixed | `storage/slow-download.test.ts`: `a download whose HEAD fails answers 503`; `collab/collab-storage-unavailable.test.ts`: `a 5xx on the GET closes with storage-unavailable, like an unreachable exists()` |
| DL-5 | A copy whose source GET died midway left its temp in `tmp/` | low | fixed | `storage/slow-download.test.ts`: `a copy whose source GET dies midway leaves nothing in tmp/` |
| DL-6 | A process death mid-GET left a truncated working copy that every later open adopted as crash recovery and failed on | medium | fixed | `storage/slow-download.test.ts`: `a data.db GET in progress leaves the live working copy unwritten` |
| DL-7 | The staged-copy recovery in `buildDocumentDb` also wrote straight onto the live working-copy path (missed by the audit) | medium | fixed | path covered by `storage/sync-resilience.test.ts`: `a staged-copy recovery over an orphan -wal beside the temp path yields the staged bytes` |
| DL-8 | Whole-body reads (`arrayBuffer()`, `text()`, the import-from-Drive and mail-attachment loops) in previews, thumbnails, import, inline edit, transforms, extraction and mail had only Bun's bound, and a failed one surfaced as a raw `S3Error` (missed by the audit) | medium | fixed: every whole-body read goes through `consumeStream` | `storage/slow-download.test.ts`: `a whole-body read whose GET stalls mid-body answers 503`, `a whole-body read whose GET fails answers 503, not the raw S3 error` |
| CO-4 | A failed open's cleanup deleted whatever sat in its cache slot, leaving a successor's database open outside the cache | low | fixed | `storage/docdb-open-close-race.test.ts`: `an open that fails after a close took its slot leaves the successor's cache entry alone` |
| CO-5 | A failed collab load stayed registered, so teardown and share changes re-ran the whole load | low | fixed | `collab/collab-storage-unavailable.test.ts`: `a load that failed leaves no open-document entry behind` |
| CO-6 | `closeAllDatabases` deadlocked when the download abort failed a build during an earlier close: the getter re-ran and waited on its own closing entry (found while fixing DL-2) | medium | fixed | `storage/docdb-open-close-race.test.ts`: `mount teardown settles when an open it aborts fails during an earlier close` |
| UP-1 | The shutdown flush read its deadline only at the loop top, so a stalled PUT or semaphore slot ran past it | low | fixed | `storage/upload-queue-stall.test.ts`: `the shutdown flush returns by its deadline while a PUT is stalled`, `the shutdown flush returns by its deadline while the destination semaphore is held` |
| UP-2 | Direct (non-queued) PUTs (uploads, editor saves, WebDAV) have no ceiling and skip the destination semaphore | medium | open | *failing* `storage/upload-queue-stall.test.ts`: `a stalled upload PUT settles within the PUT ceiling the queue uses` |
| UP-3 | Overlapping overwrites of one plain file are not serialized, so an older PUT that lands last wins | low-medium | open | *failing* `storage/upload-queue-stall.test.ts`: `two overlapping overwrites of one file end on the bytes of the later write` |
| UP-4 | A permanent delete during a direct overwrite PUT leaves the deleted bytes in the bucket | low | open | *failing* `storage/upload-queue-stall.test.ts`: `a permanent delete during a stalled overwrite PUT leaves no object behind` |
| UP-5 | Staged copies superseded behind a stalled PUT leaked until the Home re-inited | low | fixed | `storage/upload-queue-stall.test.ts`: `staged copies superseded behind a stalled PUT are removed` |
| UP-6 | Create reconcile (15 s) can report success for a container whose provisioning later rolls back | low | open | none |
| UP-7 | An interrupted multipart upload (Bun uses multipart above 5 MiB) stays in the bucket until the lifecycle rule's 7 days | low | open | none |
| BK-1 | `./eigen backup` holds no s3 object and a row names a key, never a version, so restore and rollback put old metadata over the bucket as it is now | docs/ops | fixed as docs: the CLI warns, [BACKUP.md](BACKUP.md) and the setup guide say so, bucket versioning holds the history | `cli/snapshot-s3.test.ts`: `a full snapshot holds the mount database and its staged uploads, a light one the database alone` (asserts the warning) |
| BK-2 | `./eigen restore` replays the snapshot's staged uploads over the keys the kept-aside `data/` names | low | open | *failing* `cli/snapshot-s3.test.ts`: `a restore leaves the bucket objects of the data/ it keeps aside as they were` |
| BK-3 | A per-home backup whose objects or bucket were gone verified green | medium | fixed for plain files; a container database is still skipped | `backup/freshest-first.test.ts`: `a plain file whose object is gone from the bucket fails the backup`, `a file with no object passes when it has no bytes on record or is deleted mid-walk` |
| BK-5 | A per-home backup never reads the crash temp an unclean shutdown leaves, so it archives the stale object | low-medium | open | *failing* `backup/freshest-first.test.ts`: `a document whose last edits survive only in its crash temp is archived with them` |
| BK-6 | The shutdown drain budget starts after the transform runner closes and backup jobs settle, so a stop during a backup job can end in SIGKILL (nothing lost: rows replay) | low | open, documented in [SYNC.md](SYNC.md) | none |
| ST-3 | `StorageBackend.delete` answered `false` for absent and failed alike, and S3 sent a HEAD before each DELETE | low | contract fixed (`true` for a missing key or bucket, `false` only on failure, one request; a safety-copy delete stops at the first `false`); a failed permanent delete is still only logged | `storage/storage.test.ts`: `delete returns true for a missing file`; `storage/s3-minio.test.ts`: `delete returns true, then exists false, and a second delete or one against a missing bucket still returns true`; `backup/safety-copies.test.ts`: `a delete that cannot reach the bucket keeps the folder and says so` |
| ST-6 | `Drive.uploadFiles` leaked every remaining streamed temp when one finalize threw | low | fixed | `drive/create-resilience.test.ts`: `a failed PUT removes the temp of every file streamed after it` |
| ST-7 | `storage/versioning.test.ts` casts `drive.documents` to a `Map`; a `CollabRegistry` has no `size`, so one assertion compares `undefined` with `undefined` | low | fixed: the assertion and its cast are gone | n/a |
| minor | Comment hygiene, duplicated constants, missing return types, test-only knobs and test tidiness (ST-2, ST-4, ST-5, ST-8 to ST-27). The dev fault injector (`EIGEN_STORAGE_FAULT`) and the optional `readRange` are deleted | low | fix on touch | n/a |

The alias IDs CO-1, CO-2, CO-3, BK-4 and ST-1 fold into the DL rows above.

## How reads and metadata calls are bounded now

Bun 1.4.2's `S3Client` takes no timeout or signal. A silent request rejects `Timeout` after about 360 s, a body that trickles never does, a body shorter than its Content-Length rejects `ConnectionClosed`, and canceling the reader of `s3File.stream()` closes the upstream socket at once.

- **One knob**: `STORAGE_TIMEOUT_MS` (30 s) in `lib/storage/deadline.ts`, shrunk in tests with `setStorageTimeoutMs`.
- **HEAD, stat and DELETE** (`exists`, `size`, `delete`) race the deadline: `exists` and `size` answer `ApiError(503)`, `delete` returns `false`. Bun cannot abort them, so the request runs on in the background; only the caller stops waiting.
- **Streamed reads** (downloads, copy, backup capture, version snapshots through `writeTempWithHash`; whole-body reads through `readStorageFile` and `Mount.readBytes`) run through one loop, `consumeStream`, on an idle deadline reset per chunk, and end with `reader.cancel()`; any failed read answers 503. Gotcha: a `read()` pending when `cancel()` runs resolves `{ done: true }` rather than throwing, so the loop checks a stopped flag, or a canceled download would count as complete.
- **Downloads** of a `data.db` and the staged-copy recovery write a `tmp/<uuid>` side file and rename it onto the working-copy path on success, so a killed process leaves nothing for the next open to adopt.
- **Teardown** aborts `mount.downloads` first (`closeAllDatabases`, `Drive.destruct`), so no close or Home shutdown waits on a download or on a content extraction's read.

The as-built description lives in [STORAGE.md](STORAGE.md) (Deadlines) and [SYNC.md](SYNC.md) (Durability, Teardown). The stall harness (`FakeS3Server`, `FaultStorage`) is in [TESTING.md](TESTING.md); the live MinIO suites need `S3_TEST_ENDPOINT` and `scripts/s3-local`.

## Open

- **UP-2**: a direct PUT has no ceiling and skips the destination semaphore; *failing* `a stalled upload PUT settles within the PUT ceiling the queue uses`.
- **Upload retries**: Bun retries a failed upload up to 3 times (`retry` default), so a stalled direct PUT's real bound is several times 360 s.
- **UP-3**: overlapping overwrites of one plain file are not serialized; *failing* `two overlapping overwrites of one file end on the bytes of the later write`.
- **UP-4**: a delete during a direct overwrite PUT leaves the bytes behind; *failing* `a permanent delete during a stalled overwrite PUT leaves no object behind`.
- **Trickle**: the idle deadline does not catch a body that sends a byte every few seconds, so such a read still has no bound.
- **Served files**: `/download` and `/embed` (`serve-file.ts`) stream `file.stream()` straight into the Response, outside `consumeStream`, so a stalled body is cut only by the server's 200 s `idleTimeout`; no lock or Home is held.
- **DL-3**: the version snapshot still holds the container lock across its GET, now for at most one idle deadline per stall.
- **Permanent miss**: a 404 on a `data.db` answers 503, so the client retries under "Storage is temporarily unavailable" every 5 s forever; `collab/collab-storage-unavailable.test.ts`: `a document whose storage object is gone closes 1013 storage-unavailable` pins today's behavior.
- **BK-2**: a whole-server restore replays staged uploads over the keys the kept-aside `data/` names; *failing* `a restore leaves the bucket objects of the data/ it keeps aside as they were`.
- **BK-3 residual**: a container database whose object is gone is still skipped; `backup/snapshot.test.ts`: `skips a container database whose stored bytes are gone and finishes the snapshot` pins it.
- **BK-5**: a per-home backup ignores the crash temp; *failing* `a document whose last edits survive only in its crash temp is archived with them`.
- **Low, no test**: UP-6, UP-7, BK-6, and a failed permanent delete that is only logged (ST-3).
- **Presigned PUT (deferred)**: `fetch(file.presign({ method: 'PUT' }), { signal, body })` would make a PUT abortable and delete about 110 lines of orphan tracking in `upload-queue.ts`. It needs the signing checked against MinIO and Hetzner, and it loses Bun's multipart for bodies over 5 MiB.

## Dropped

The proposed invariants I1 to I5 (presigned fetch for every read, every write through the queue, boot-time crash-temp adoption, one freshest-bytes resolver, one process shutdown signal) are dropped: a read deadline plus the 503 mapping removes most of their value at a fraction of the change.
