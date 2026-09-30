# S3 Sync

> **TLDR:** On an `s3` mount every container database (`data.db`, `comments.db`) is a local temp file that goes to the bucket whole. A sync stages a frozen `VACUUM INTO` copy and records a durable `pending_uploads` row in the mount's `metadata.db`. A per-mount `UploadQueue` (`apps/api/src/lib/mount/upload-queue.ts`, process-global parts in `apps/api/src/lib/sync/`) uploads it in the background with retry and backoff. So a slow or failing bucket becomes upload lag, never a hung request or lost bytes. Four things are not obvious from the code. Local bytes are never discarded before the bucket acks. Reads serve the staged copy before the stored object. An empty or collapsed working copy can never overwrite a good object. A timed-out PUT is tracked until it settles, so it can neither roll an object back nor bring a deleted one back. `local` and `local-key` mounts write synchronously.

## A sync stages a frozen copy and returns

```
write → ManagedDatabase (WAL, local temp)
  └─ onSync: VACUUM INTO staging/<uuid>.db → pending_uploads row in metadata.db
        └─ UploadQueue.drain → [per-destination Semaphore] → storage.write(S3) → ack: delete row + staged copy
```

A sync never awaits the PUT. `onSync` (`apps/api/src/lib/mount/document-db.ts`) writes a `VACUUM INTO` copy to the mount's `staging/` folder and calls `enqueueStaged`, which writes the row before it returns and kicks the drain. So `close` and the 30 s sync tick return after the local write. `VACUUM INTO` captures committed frames still in the WAL, so the copy is complete without a checkpoint, and it is frozen while the live file keeps changing.

Only container databases and the plain files a per-home restore stages go through the queue. A container create first checks that the key is free, a HEAD under the storage deadline. Reads and plain-file PUTs (uploads, editor saves, WebDAV) still wait on the bucket: reads under the idle deadline in [STORAGE.md](STORAGE.md#every-storage-read-has-a-30-s-idle-deadline), a direct PUT with no ceiling at all ([ROADMAP.md](ROADMAP.md)).

## Only `s3` mounts queue

A queue exists only when `buildUploadDestinationKey` (`apps/api/src/lib/mount/helpers.ts`) returns a key, which it does for storage type `s3`. `local` and `local-key` keep synchronous writes: a local write never 503s, and queuing it would only weaken its on-completion durability. The crash-temp recovery ([A crash temp is adopted and re-synced](#a-crash-temp-is-adopted-and-re-synced)) applies to both temp-copy backends, `s3` and `local`.

## Code comments cite seven numbered invariants

Comments and tests name these by number ("invariant 7"). Some cite four more labels: Phase 1a is the crash-temp recovery, Phase 1b the write-behind pipeline, §3 staging and version snapshots, and §9 the queue-depth count (`pendingCount`).

1. The payload is a frozen `VACUUM INTO` staged copy, captured at enqueue, never the live temp. The row's `paths.size` is stat'd from that staged copy too (`syncDocumentDbSize`), so it matches the object that range requests and WebDAV HEAD are served against. On `local` and `local-key` the live file is the object, and the size comes from it.
2. Staged copies live in the per-mount `staging/` folder, which the startup `tmp/` sweep never touches. A staged copy lives until its PUT acks.
3. Local bytes count as synced only on ack. `ManagedDatabase` moves its dirty watermark once the copy is staged and its row written. The row is the durable marker, and only an ack clears it.
4. At most one pending upload per storage key, and the newest staged copy wins (a primary-key upsert on `pending_uploads`). The superseded copy is deleted unless it is mid-PUT, in which case the worker deletes it afterwards.
5. Every enqueue is on disk in `metadata.db` before the producer returns, and `UploadQueue.reconcile` runs before the `tmp/` sweep at mount init, so replay can't lose to it.
6. Uploads are idempotent: stable UUID keys and whole-file overwrites, so a replay is harmless.
7. Permanent delete and the chat-restore replace cancel the pending upload and its staged copy, so a queued or in-flight PUT never brings deleted bytes back.

## Pending uploads survive a restart

`pending_uploads` lives in `metadata.db`, so a restart or a Home reopen resumes every un-acked upload. `reconcile` re-enqueues each row whose staged copy exists and drops, with a log line, each row whose copy is gone. It deletes staged files no row names, which a crash between staging and the row insert leaves behind.

A row stores the staged copy's basename, resolved against the mount's current `staging/` folder, and passes an absolute legacy value through. So moving the data folder to another host, a per-home restore or a changed bind mount keeps every pending row. A whole-server restore (`./eigen restore`) replays the archive's pending uploads unless the live mount already uploaded, replaced or canceled them ([BACKUP.md](BACKUP.md#an-s3-mount-keeps-its-bucket-as-it-is)).

A Home that idles out during an outage keeps its queued bytes on local disk until it is next opened. That is the same durability as the temp files: losing the host disk in that window loses them.

## A crash temp is adopted and re-synced

A temp that survived an unclean shutdown holds bytes storage may lack. So does one left by a failed final sync, since `onClose` keeps the temp when `syncFailed` is set. On the next open `buildDocumentDb` adopts it and calls `ManagedDatabase.markDirty`. Without that, the fresh connection's `total_changes()` starts at 0, the database looks clean, and the close-time `cleanupTemp` would silently drop the unsynced bytes.

The mount's startup sweep removes `tmp/` files older than an hour, but never one named after a `paths` row, nor its journals. That is a crash temp, and only the next open of its document adopts it.

## An empty or collapsed working copy never overwrites a good object

**Invariant: an empty or invalid working copy never overwrites a non-trivial stored object. The worst case is a transient 503, never a wipe.** Adopting a crash temp is only safe if it holds real data. A failed or empty GET leaves a 0-byte temp, which is itself a valid empty SQLite file, and `markDirty` would then upload that emptiness over the good object.

- `buildDocumentDb` adopts a temp only if `isViableRecoveryTemp` passes: it has the SQLite header and is not collapsed against the size the row knows, with its `-wal` counted. Otherwise it discards the temp through `Mount.cleanupTemp`, journals included, and re-fetches. A `-wal` left beside the re-fetched file would be replayed into it.
- `Drive.openDatabase` and `createDatabase` pass their intent down as the mount's `mode`, which becomes `ManagedDatabase`'s `mustExist`. A `mustExist` open uses `{ create: false }` and refuses a missing or 0-byte working copy with a 503.
- A download or a staged-copy recovery writes a `tmp/<uuid>` side file and renames it onto the working-copy path (`replaceTempFrom`). A process killed mid-GET leaves no partial temp for the next open to adopt.

Which failure answers 410 and which 503 is in [STORAGE.md](STORAGE.md#a-gone-object-answers-410-an-outage-503).

## Reads serve the staged copy first

A pending staged copy holds bytes newer than the stored object, so every read on the mount serves it first: `readKey`, `readRange` and `downloadToTemp` (`apps/api/src/lib/mount/mount.ts`). `downloadKeyToTemp` is the raw GET that skips it, and both its callers look at the staged copy before they call it: `downloadToTemp`, and a document open, which looks at the crash temp, then the staged copy, then the object. So a reopen, a copy, a copy across mounts and a backup read the newest bytes during an outage, never a stale or missing object.

## Version snapshots are queued too

On an `s3` mount a version snapshot takes its bytes from the freshest local copy and enqueues its own upload (§3, `apps/api/src/lib/versioning/snapshot.ts`). So a close-time snapshot never blocks on the bucket. It copies a pending staged copy with no await between the existence check and the copy, so a concurrent enqueue cannot unlink it mid-read. How versions are kept is in [STORAGE.md](STORAGE.md#version-snapshots-live-inside-the-container).

## A cancel beats a PUT in flight

Deleting a file first closes every cached database under it (`closeCachedDbsUnder`), so a dirty one can't re-stage its dead key on a later tick. Then `deletePath` cancels the pending upload and deletes the object. The chat-restore replace and a failed container create both delete through it.

`performUpload` re-checks the row just before and just after its PUT. A PUT that lands after its row was cancelled has just brought the object back, so the queue deletes it again. That is safe because the key is a dead UUID that is never reused.

## Each destination has its own semaphore

`getUploadSemaphore` keeps one limiter per S3 destination (endpoint plus bucket), not one per process. What it protects is one provider's rate limit. So a slow or dead provider backs up only its own uploads, never those of team mounts and user-owned endpoints pointing at other buckets.

Each queued PUT races `UPLOAD_PUT_TIMEOUT_MS` (120 s), because `S3Storage` can't abort a request. A timeout counts as a failure and backoff takes over. Without it a black-holed request would park the drain and hold its semaphore slot, and a few such hangs would starve every mount sharing the limiter.

## A timed-out PUT is tracked until it settles

A timed-out request may still land in the bucket later, so the queue tracks it as an in-process orphan (`trackOrphan`).

- An ack while an orphan is unsettled keeps the acked bytes in memory and re-uploads them through the guarded path once the orphan settles. Without that, a late landing would roll the object back, **permanently if no further sync occurs**.
- A cancel re-issues the object delete when the orphan settles, so invariant 7 holds whichever of cancel and timeout comes first.
- An ack whose orphans all settled while its own PUT was in flight re-PUTs at once. Settlement order says nothing about commit order, so a landed orphan may have committed after it.

Two cases stay unrepaired. An orphan that settles after the queue's `close()` is only logged (`landed after a newer upload acked`, `cannot re-upload … queue closed`). An orphan whose fully sent body the server commits after the process died lands with no log line. Bucket versioning is the recovery for both.

## A staged database that isn't SQLite is dropped, not uploaded

Before a PUT, a staged copy whose row says `isDatabase` must pass the SQLite header check (`isSqliteFile`). One that fails is a disk fault after `VACUUM INTO`, and uploading it would ack garbage over the good object. The queue drops it loudly, so the object stays last-good and the next dirty sync re-stages from the live temp. `isDatabase` is false only for the plain files a per-home restore stages (`apps/api/src/lib/backup/materialize.ts`), which have no header to check.

## Backoff belongs to each queue

A failed upload backs off with full jitter, capped (`uploadBackoffMs`), and the queue schedules its own retry for when the earliest row is due. There is no global registry of mounts and no sweep. The only process-global state is the destination-to-semaphore map (infra strings, no user data), the backoff function and the shutdown deadline.

## Idle teardown leaves the queue, shutdown drains it

- **Idle teardown** closes the queue. Its rows and staged copies replay on the next open.
- **Process shutdown**: `server.ts` sets a deadline (`SHUTDOWN_DRAIN_BUDGET_MS`, 20 s), awaits `drainACLFanOuts()`, since an in-flight fan-out reopens recipient homes, and then runs `shutdownAllHomes`. Each mount flushes its queue after its final close-time enqueues and stops waiting at the deadline, even with a PUT or a semaphore slot stalled. Then it closes the queue: no PUT starts after that, and one still in flight leaves its row. Anything undrained replays on boot.

The budget covers the whole process. It starts after the transform runner closes and running backup jobs settle, but before the ACL fan-outs drain, so a slow fan-out leaves less of it for the mounts. A Home with several mounts drains them one after another.

## The API container gets 30 s to stop

`docker-compose.yml` gives `eigen-api` a `stop_grace_period` of 90 s: a running backup job gets 30 s first ([BACKUP.md](BACKUP.md#the-whole-server-backup-runs-inside-the-api)), then the 20 s drain, and both finish before SIGKILL. A long restore, which is waited out in full, can still end in SIGKILL, and its rows replay on boot.

## The bucket needs versioning and a noncurrent-version expiry rule

Versioning makes an accidental overwrite recoverable, and it is the recovery for the two orphan cases a timed-out PUT leaves unrepaired ([A timed-out PUT is tracked until it settles](#a-timed-out-put-is-tracked-until-it-settles)). Because every sync re-PUTs the whole file, old versions pile up, so a lifecycle rule expires them. The same rule aborts incomplete multipart uploads after 7 days.

The admin app's S3 config card sets both ("Bucket safety", "Enable safe defaults", `hardenS3Bucket` behind `POST /settings/s3harden` and `/setup/s3harden`). It matches its rule by ID (`S3_LIFECYCLE_RULE_ID`, `packages/lib/src/constants/s3.ts`), so a repeat updates the rule instead of adding one. A lifecycle configuration Eigen didn't write is never rewritten. The card reports it and shows the `aws s3api` commands to run by hand instead, as it does for a key that can't read the bucket's settings. The operator's side is the [bucket safety article](../apps/index/src/data/support/admin/s3-bucket-safety.md).

## See also

- [STORAGE.md](STORAGE.md): mounts, backends, the storage deadline and 410 against 503
- [DATABASE.md](DATABASE.md): `ManagedDatabase`, the dirty watermark and the document-db slot
- [BACKUP.md](BACKUP.md): what a backup and a restore do with pending uploads
- [STREAMING_UPLOADS.md](STREAMING_UPLOADS.md): plain-file uploads, which PUT directly
