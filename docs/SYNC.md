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
  resumes un-acked uploads (`UploadQueue.reconcile`, before the stale-temp sweep). `stagingPath` stores a
  **basename**, resolved against the mount's `staging/` dir at read time (legacy absolute rows pass
  through), so a host migration / restore-from-backup / bind-mount change doesn't drop pending rows.
- **Crash recovery (Phase 1a)** — a temp that survived an unclean shutdown is force-dirtied on reopen
  (`ManagedDatabase.markDirty`) so its unsynced bytes re-reach storage instead of being dropped by the
  close-time cleanup. Closes the original data-loss bug; needs no queue. (It also *introduced* one — see
  Recovery integrity below.)
- **Recovery integrity (2026-06-08 fix)** — force-dirtying a recovered temp is only safe if the temp holds
  real data. A failed/empty S3 GET could leave a 0-byte temp, which `openCold` opened as a fresh EMPTY db
  and `markDirty` then re-uploaded *over the good object* — two live stickies docs were wiped this way (and
  re-wiped on every later redeploy). The open-vs-create intent is threaded `Drive.openDatabase` vs
  `createDatabase` → Mount `mode` → `ManagedDatabase.mustExist`: a `mustExist` open uses `{ create: false }`
  and **refuses a missing or 0-byte working copy** in `openCold`, and `buildDocumentDb` (`lib/mount/document-db.ts`) adopts a
  surviving temp only if it's a valid, non-collapsed SQLite (else it discards it and re-fetches the
  authoritative object). **Invariant: an empty/invalid working copy can never overwrite a non-trivial
  stored object — worst case a transient 503, never a wipe.**
- **Freshest-first reads** — `Mount.readFile` serves a pending staged copy before the storage object, so
  reopen, copy/duplicate, and copy-across all read the newest bytes during an outage, never a stale/absent
  S3 object.
- **No resurrection** — permanent delete + chat restore cancel the pending upload; if a PUT finishes after
  a cancel — including a timed-out orphaned PUT landing late — the queue deletes the resurrected object
  (the key is a dead UUID, never reused).
- **Consistent version snapshots** — version copies source the freshest *local* bytes (never a stale S3
  read) and are themselves queued, so a close-time snapshot never blocks on the backend.

## Numbered invariants

Code comments cite these by number ("invariant 2", "invariant 7"). The numbering comes from the
original design spec (`docs/PROPOSAL_SYNC_RESILIENCE.md`, removed once implemented — see git history)
and is fixed; restated here in as-built terms so the references resolve:

1. **The upload payload is a frozen `VACUUM INTO` staged copy**, captured at enqueue — never the live
   temp DB.
2. **Staged copies live in the dedicated per-mount `staging/` dir, which the `cleanupStaleFiles`
   startup sweep never touches**; a staged copy survives until its PUT acks, then it's deleted.
3. **The sync watermark advances only on ack** — local bytes are never treated as synced (or
   discarded) while an upload is pending. (As built, the pending row itself is the durable marker;
   the proposal's persisted content hash was dropped.)
4. **At most one pending upload per storage key; the newest enqueued staging wins** (PK upsert on
   `pending_uploads`).
5. **Every enqueue is durably recorded in `metadata.db` before the producer returns**, and startup
   reconciliation (`UploadQueue.reconcile`) runs **before** the tmp sweep — replay can't lose to it.
6. **Uploads are idempotent** (stable UUID keys, whole-file overwrite); replay is harmless.
7. **Permanent delete and the chat-restore replace cancel the pending upload + staged copy** — a
   queued or in-flight PUT must never resurrect deleted bytes.

Section references ("§3", "§9") point at the same spec's detailed-design sections: §1 crash-recovery
fix (Phase 1a) · §2 upload pipeline (Phase 1b) · §3 staging + consistent version snapshots ·
§4 change detection · §5 create path · §6 delete/trash/restore · §7 startup reconciliation ·
§8 shutdown/drain · §9 observability.

## Concurrency

- **One `Semaphore` per S3 destination** (`endpoint+bucket`), not one per process (`lib/sync/index.ts` →
  `getUploadSemaphore`). A slow or down provider only backs up its own uploads and never blocks uploads to
  other destinations — important once team mounts and user-owned endpoints point at different buckets.
  Each PUT is raced against a **~120 s client-side ceiling** (`S3Storage` can't abort); a timeout counts as
  a failure, so backoff takes over instead of a black-holed request parking the drain and its semaphore.

- **Orphan repair.** A timed-out request may still land server-side later, so the queue tracks it as an
  **in-process orphan** (`trackOrphan`). An ack while an orphan is unsettled retains the acked bytes in
  memory and re-uploads them through the guarded path once the orphan settles — without this the late
  landing would regress the object **permanently if no further sync occurs**. A cancel re-issues the object
  delete on settlement, so invariant 7 holds through timeouts whichever of cancel and timeout comes first.
  Residual: an orphan whose fully-transmitted body the server commits after process death or queue teardown
  lands unrepaired (logged when detectable; bucket versioning is the recovery).

- **Commit order is distrusted.** An ack whose orphans all settled while its own PUT was in flight re-PUTs
  immediately. A staged copy that fails the SQLite magic check (`isSqliteFile`) is dropped loudly before the
  PUT — the object stays last-good instead of acking garbage.

- **Backoff is local.** Failed uploads back off (full-jitter, capped) and the queue **self-schedules** its
  own retry — there is no global registry or sweep. The only process-global state is the
  destination→semaphore map (infra strings, no per-user data), the backoff function, and the shutdown
  deadline.

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
| `lib/mount/upload-queue.ts` | The per-mount `UploadQueue` — enqueue / drain / backoff / cancel / reconcile + staging + orphan tracking |
| `lib/sync/index.ts` | Process-global bits: per-destination semaphore map, backoff, shutdown deadline |
| `lib/mount/document-db.ts` | The `onSync` / `onOpen` / `onClose` callbacks + snapshot wiring. Open-vs-close is serialized per pathId: a close registers in `Mount.closingDocumentDbs` and a concurrent open of the same pathId waits for it before building, so a fresh instance never shares the closing one's temp/journal files |
| `lib/core/managed-database.ts` | `markDirty` (crash recovery), `stageCopy` (`VACUUM INTO`), `mustExist` open guard (refuse a missing/0-byte working copy) |
| `lib/mount/schema.ts` + `db-config.ts` | The `pending_uploads` table (additive migration v4) |

## Ops

- **`stop_grace_period: 30s`** on the `eigen-api` service (`docker-compose.yml`) so the shutdown drain
  (`SHUTDOWN_DRAIN_BUDGET_MS = 20 s`) can finish before SIGKILL; undrained uploads replay on boot.
- **Enable bucket versioning + a noncurrent-version expiry rule** on the S3 bucket. Versioning makes
  accidental overwrites recoverable; because the pipeline re-PUTs whole files, a lifecycle rule expires old
  versions so they don't accumulate forever. The admin app does both from the S3 config card ("Bucket safety" →
  "Enable safe defaults", `POST /settings/s3harden`). The same rule by hand, for a key that isn't allowed to
  change bucket settings — keep the rule ID, the app matches on it:
  ```bash
  cat > /tmp/lifecycle.json <<'JSON'
  { "Rules": [ { "ID": "eigen-expire-noncurrent", "Filter": {}, "Status": "Enabled",
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 } } ] }
  JSON
  aws s3api put-bucket-lifecycle-configuration --endpoint-url https://nbg1.your-objectstorage.com \
    --bucket eigen-drive --lifecycle-configuration file:///tmp/lifecycle.json
  ```
  `NoncurrentDays` trades recovery window against storage cost. A lifecycle configuration Eigen didn't author
  is never rewritten: the card reports it and shows the commands instead. Rule ID and defaults live in
  `packages/lib/src/constants/s3.ts`; the design is in
  [PROPOSAL_S3_VERSIONING_UX.md](proposals/PROPOSAL_S3_VERSIONING_UX.md).

## Residual limitations

- A move/rename on `local` can strand one in-flight sync: `onSync` re-resolves the storage key on every
  sync but holds no path lock, so a rename landing between that resolution and the write sends that one
  sync's bytes to the pre-move path (a `createPath: true` zombie tree) and the watermark marks them
  synced — a tail write stays stranded until the next dirty sync. Accepted: a path lock wouldn't close
  it (an ancestor rename locks the folder's id, not the data.db's); id-stable `s3`/`local-key` keys are
  immune.
- A home that idle-destructs mid-outage leaves queued bytes on local disk until it's next opened (same
  durability as the temp files; a host-disk loss in that window is the Litestream-class residual RPO).
- The shutdown drain budget is whole-process; a multi-mount home drains its mounts sequentially.
- Whole-file re-PUT per sync is the redundancy WAL-frame shipping (Litestream model) would remove — the
  strategic next step, out of scope today.
- Conditional writes (`If-Match` on ETag) would make stale orphaned PUTs fail 412 server-side even across
  process death, closing the logged-only residual above — unresearched (S3-compatible support on
  Hetzner/MinIO and Bun `S3Client` header control are open questions).
