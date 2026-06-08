# Async SQLite→S3 Sync

> **TLDR**: Every document/chat/sheet `data.db` is a local temp file uploaded whole to S3 on sync.
> Uploads are **write-behind** — a sync stages a frozen `VACUUM INTO` copy and enqueues it; a per-mount
> `UploadQueue` drains it in the background with retry + backoff. A slow/failing S3 backend becomes
> background lag, never a request hang or data loss. Crash-recovered temps re-sync, queued bytes survive
> restarts. **S3 mounts only** — `local`/`local-key` write synchronously.

Motivated by a Hetzner Object Storage incident where creating a chat synchronously PUT a fresh `data.db`
and hung/503'd the request. Two parts: a standalone crash-recovery durability fix, and the write-behind
pipeline.

## How it works

```
write → ManagedDatabase (WAL, local temp)
  └─ onSync: VACUUM INTO staging/<uuid>.db  →  pending_uploads row in metadata.db
        └─ UploadQueue.drain → [per-destination Semaphore] → storage.write(S3) → ack: delete row + staging
```

A sync no longer awaits the PUT. It writes a **frozen, WAL-complete** `VACUUM INTO` copy to a per-mount
`staging/` dir and records a durable row in the mount's `metadata.db` (`pending_uploads`). The
`UploadQueue` uploads that copy in the background and clears the row on ack. So `create`, `close`, and the
30 s auto-sync tick all return after the *local* write.

## Durability

- **Local bytes are never discarded until S3 acks** — the staged copy + the pending row persist until the
  upload succeeds.
- **Replay on boot / reopen** — `pending_uploads` is durable in `metadata.db`, so a restart or home-reopen
  resumes un-acked uploads (`UploadQueue.reconcile`, before the stale-temp sweep).
- **Crash recovery (Phase 1a)** — a temp that survived an unclean shutdown is force-dirtied on reopen
  (`ManagedDatabase.markDirty`) so its unsynced bytes re-reach storage instead of being dropped by the
  close-time cleanup. Closes the original data-loss bug; needs no queue.
- **Newest-from-staging on reopen** — during an outage a reopened doc reads the staged copy (newest bytes),
  not a stale/absent S3 object.
- **No resurrection** — permanent delete + chat restore cancel the pending upload; if a PUT finishes after
  a cancel, the queue deletes the resurrected object (the key is a dead UUID, never reused).
- **Consistent version snapshots** — version copies source the freshest *local* bytes (never a stale S3
  read) and are themselves queued, so a close-time snapshot never blocks on the backend.

## Concurrency

One `Semaphore` **per S3 destination** (`endpoint+bucket`), not one per process
(`lib/sync/sync-worker.ts` → `getUploadSemaphore`). A slow/down provider only backs up its own uploads and
never blocks uploads to other destinations — important once team mounts + user-owned endpoints point at
different buckets. Failed uploads back off (full-jitter, capped) and the queue **self-schedules** its own
retry — there is no global registry or sweep. The only process-global state is the destination→semaphore
map (infra strings, no per-user data), the backoff function, and the shutdown deadline.

## Teardown

- **Idle teardown** — the queue stops; leftover pending rows + staged copies replay on the next open.
- **Process shutdown** — `index.ts` sets a deadline before `shutdownAllHomes`; each mount flushes its queue
  (bounded by `SHUTDOWN_DRAIN_BUDGET_MS`) after the final close-time enqueues, then closes. Anything
  undrained replays on boot.

## Scope

S3 (`isRemote`) mounts only. `local` / `local-key` keep synchronous writes — a local copy never 503s, and
queuing it would only weaken its on-completion durability. The crash-recovery fix (Phase 1a) applies to any
temp-copy backend.

## Key files

| File | Responsibility |
|---|---|
| `lib/mount/upload-queue.ts` | The per-mount `UploadQueue` — enqueue / drain / backoff / cancel / reconcile + staging |
| `lib/sync/sync-worker.ts` | Process-global bits: per-destination semaphore map, backoff, shutdown deadline |
| `lib/mount/mount.ts` | The `onSync` / `onOpen` / `onClose` callbacks + snapshot wiring |
| `lib/core/managed-database.ts` | `markDirty` (crash recovery), `stageCopy` (`VACUUM INTO`) |
| `lib/mount/schema.ts` + `db-config.ts` | The `pending_uploads` table (additive migration v4) |

## Ops

- **`stop_grace_period: 30s`** on the `eigen-api` service (`docker-compose.yml`) so the shutdown drain
  (`SHUTDOWN_DRAIN_BUDGET_MS = 20 s`) can finish before SIGKILL; undrained uploads replay on boot.
- **Enable bucket versioning + a noncurrent-version expiry rule** on the S3 bucket. Versioning makes
  accidental overwrites recoverable; because the pipeline re-PUTs whole files, a lifecycle rule expires old
  versions so they don't accumulate forever:
  ```bash
  cat > /tmp/lifecycle.json <<'JSON'
  { "Rules": [ { "ID": "expire-noncurrent-versions", "Filter": {}, "Status": "Enabled",
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 } } ] }
  JSON
  aws s3api put-bucket-lifecycle-configuration --endpoint-url https://nbg1.your-objectstorage.com \
    --bucket eigen-drive --lifecycle-configuration file:///tmp/lifecycle.json
  ```
  `NoncurrentDays` trades recovery window against storage cost. See
  [PROPOSAL_S3_VERSIONING_UX.md](PROPOSAL_S3_VERSIONING_UX.md) for doing this from the admin UI.

## Residual limitations

- A home that idle-destructs mid-outage leaves queued bytes on local disk until it's next opened (same
  durability as the temp files; a host-disk loss in that window is the Litestream-class residual RPO).
- The shutdown drain budget is whole-process; a multi-mount home drains its mounts sequentially.
- Whole-file re-PUT per sync is the redundancy WAL-frame shipping (Litestream model) would remove — the
  strategic next step, out of scope today.
