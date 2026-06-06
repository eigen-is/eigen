# Durable async SQLite→S3 sync

> **Status — IMPLEMENTED (Phase 1a + Phase 1b), 2026-06-05, branch `feat/sync-resilience`.**
> Phase 1a (crash-recovery durability) and Phase 1b (the write-behind pipeline) are built, tested,
> and `bun run check`-green. The as-built design **diverges** from the original proposal below on the
> worker lifecycle (the proposal's "stateless worker resolves backends by `mountId` and keeps draining
> after idle teardown" is impossible — `metadata.db` closes on `Home.destruct`). See **§ As-built notes**
> at the end for the divergences (registry-free worker, `flushNow` drain, staging-path supersession
> instead of a content-hash marker, `onOpen` recovery from staging). The empirical `bun:sqlite` claims
> were re-verified independently before building. Original design (for context) follows.
>
> **Status — Proposed, not implemented.** Design for review; reviewed independently by three Opus
> agents (convergent on the load-bearing findings; the third empirically verified the `bun:sqlite`
> behaviour below) and revised. Motivated by the 2026-06-05 Hetzner Object Storage incident
> (`memory`/`project_hetzner_s3_write_incidents`): a stickies card creation took 3.5–15s, then failed
> with S3 `503 ServiceUnavailable`, because creating the card's chat synchronously PUTs a freshly-built
> `data.db` to S3 *before* the request returns. This proposal (a) closes a pre-existing **data-loss**
> gap on crash recovery — cheaply, first — then (b) decouples the S3 upload from the request path and
> teardown so a slow/failing backend becomes background lag, not an app-wide hang/error, **without**
> weakening durability.
>
> Primary touch-points: `apps/api/src/lib/core/managed-database.ts` (sync/close/dirty),
> `apps/api/src/lib/mount/mount.ts` (`uploadFromTemp` `:1002`, `cleanupTemp` `:1017`,
> `cleanupStaleFiles` on init `:150`, `buildDocumentDb` callbacks `:1106-1144`, create-flush `:1156`,
> `snapshotContainerDataDb` `:452`/`copyPath` `:416`, `replaceContainerDataDb` `:499`, delete/trash
> `:655`/`:729`), `apps/api/src/index.ts` (process-shutdown drain), `apps/api/src/lib/scheduler/`
> (retry sweep), and a new `pending_uploads` table in each mount's `metadata.db` + one process-global
> upload worker.

## Problem statement

Every document/chat/sheet is a SQLite `data.db` living as a **local temp file** on the host bind-mount
(`/opt/eigen/data` in prod; `./data:/app/data` in the in-repo compose), uploaded **whole** to S3 on
sync. The upload (`Mount.uploadFromTemp` `mount.ts:1002` → `storage.write`, `storage/types.ts:12` →
`S3Storage.write` `s3-storage.ts:114`, **no retry/backoff**) is **synchronous and awaited** in three
places, and the request path hits the worst:

- **`ManagedDatabase.sync()`** (`managed-database.ts:136`) does `await onSync()`, gated on `isDirty`.
- **The create-flush** (`mount.ts:1156`, guard `mode === 'create' && this.needsTempCopy` `:1155`):
  `await db.flush()` so the object exists before returning. Runs **on the create request**. A single
  logical create is **2+ PUTs**: `CollabDocument.create` provisions `data.db` **and** `comments.db`
  (`collabDocument.ts:152-155`); `ChatRoom.create` provisions `data.db` (`chat.ts:40`).
- **`close()`** (`managed-database.ts:184`): `await sync()` on idle-timeout / shutdown.

Healthy S3 (~20–50ms) hides this. When Hetzner's write path degrades (200ms → 3s → 15–31s → 503, as
observed) the coupling surfaces as: (1) request-path hangs/failures; (2) shutdown truncation —
graceful shutdown drains by awaiting every DB's flush within Docker's **default 10s** grace
(`docker-compose.yml` sets no `stop_grace_period`), and closes are **sequential within a drive**
(`Mount.closeAllDatabases` `:1173` and `Drive.destruct` `:1042`, mount loop `:1054`, are `for` loops;
cross-home `shutdownAllHomes` and cross-subsystem `Home.destruct` are parallel `allSettled`), so one
15–31s flush serializes its whole drive → SIGKILL mid-drain; (3) a latent crash-recovery **data-loss**
gap (below). Reads/metadata are unaffected (HEAD stayed 2–3ms).

## Goals / non-goals

**Goals**
- **First, cheaply:** make recent-write durability survive a crash/restart (close the data-loss gap).
- Take the S3 upload **off the request path** (create returns after the *local* write).
- Survive a slow/failing backend with **no data loss** and **no app-wide hang** — background lag +
  retry, not errors.
- Reduce redundant full-file PUTs / S3 version bloat where cheap.

**Non-goals (deferred)**
- WAL-frame shipping / delta sync (Litestream model) — bigger rewrite; see *Future*.
- Multi-writer replication / cross-host live sync.
- Changing the local-temp-file + whole-file-object storage model itself.

## Scope: S3 backends only

The queue applies **only to `isRemote` (s3)** mounts. Backend taxonomy (`mount.ts:1035`):
`needsTempCopy = isRemote || isPathBased`, so `local` (path-based) **also** goes through
`uploadFromTemp` — but its "upload" is a local-filesystem copy (`LocalStorage.write` = `Bun.write`,
durable on completion) that never 503s; async-queuing it would *weaken* durability for zero benefit.
`local-key` writes straight to the backing file (no temp, no upload). **So every Phase-1b change
branches on `this.isRemote`; `local`/`local-key` keep today's synchronous behaviour.** (The Phase-1a
crash-recovery fix is the one exception — correct for any temp-copy backend.)

## Fit with the Home/Mount sharding model

State shards with `ownerId`; the worker is stateless per-process — leaving the relay seam untouched
(AGENTS.md: "only `home-relay.ts` changes when homes move servers"):

```
Home (sharding + lifecycle unit)
└─ Drive
   └─ Mount  ── owns: storage backend, documentDbs cache; enqueues uploads
      └─ metadata.db → pending_uploads  (durable LOCAL state; moves with the home)
                       staging/<key>.<marker>.db  (frozen payload on disk; moves with the home)

per-process (stateless, per-server):  one SyncWorker + concurrency semaphore + scheduler retry-sweep
      └─ drains every live mount's pending_uploads → PUT → ack → delete staging + row
```

- **Pending state → the Mount's `metadata.db`** (`pending_uploads(storageKey PK, marker, stagingPath,
  attempt, enqueuedAt)` + a per-key `lastAckedMarker`). The mount's `metadata.db` is a **local**
  ManagedDatabase (no S3), so the queue's own state is **synchronously durable and never on the async
  path**. It's transactional with the path rows (delete/rollback purge markers atomically — invariant
  7) and **moves with the mount** when the Home relocates. Staging payloads live in a dedicated
  per-mount `staging/` dir (see invariant 2).
- **Enqueue → the Mount** (stages a frozen copy, upserts its `pending_uploads`, notifies the worker).
- **Worker + semaphore + retry-sweep → one process-global, *stateless* layer.** Review #1 already
  blessed a process-wide concurrency *limiter* over per-mount state; the worker is the same category —
  stateless coordination over sharded durable state. It resolves a mount's storage backend by
  `mountId`, so it can finish an upload even after that Mount object is idle-destructed. Per-server →
  nothing migrates when homes shard; the new server's worker drains the moved `pending_uploads`.
- **Why not a per-Mount worker:** a worker tied to Mount lifetime dies on idle teardown (`home.ts:120`,
  5-min timer), stranding its pending uploads until the mount is reopened. The global worker keeps
  draining while the process lives.

## Current behaviour + the two latent gaps

- **Dirty tracking** is in-memory per-connection: `isDirty = total_changes() !== lastSyncedChanges`
  (`managed-database.ts:129`); `total_changes()` resets on reopen, `openCold` sets
  `lastSyncedChanges = 0`. A reopened **unchanged** DB is correctly not dirty. Truly-idle DBs are
  skipped at the 30s tick — but **any active editor re-dirties every tick** (`DbProvider.storeUpdate`
  writes one row per Yjs update, `collabDocument.ts:58`), so hot docs re-PUT the *whole* file each
  interval. The redundancy to attack is **full-file re-PUT per delta**, not "syncing when clean."
- **Same-process create→open is safe today.** `createDatabase` leaves the DB open and cached in
  `documentDbs`; a later strict `openDatabase` reuses the cached getter (`mount.ts:1062`) and never
  re-checks `storage.exists()`. The create-flush's value is purely the *cross-process / post-restart*
  existence guarantee.

**Gap 1 — crash-recovery resync (DATA LOSS), confirmed real.** A temp with **unsynced** writes (a sync
that 503'd, or writes within the 30s window before a crash) is reused on reopen (`onOpen` "Recovering
from crash", `mount.ts:1115`), but `total_changes()` resets → `isDirty=false`. If the doc is then
opened and closed **without a new write**, `cleanupTemp` (`onClose`) deletes the temp and those writes
**never reach S3**, with no guard. Most plausible cause of the 2026-05-30 chat loss; *active* whenever
syncs fail. **Most urgent fix; needs no queue.**

**Gap 2 — WAL-frames RPO.** `sync()` runs `wal_checkpoint(PASSIVE)` (best-effort) then uploads **only**
the main `.db`; `-wal`/`-shm` are never uploaded and are deleted on close. Committed frames PASSIVE
couldn't fold in are absent from S3 until a later sync. (A *torn read* of the `.db` does not happen
today — single writer, WAL writes go to `-wal`, the `.db` only mutates during the synchronous
checkpoint.)

## Design overview

A **durable, per-Mount-state, write-behind upload pipeline**. Producers (`sync`, create, close)
**enqueue** and return; one process-global worker performs the PUT with retry/backoff; **local state is
never discarded until S3 acks**; pending uploads are recorded **durably** so a restart replays them. Not
fire-and-forget — that loses data (teardown deletes temp/WAL out from under the in-flight PUT;
`process.exit` races it). At-least-once, last-write-wins, idempotent (stable `paths.file` UUID key).

**The unifying primitive is a frozen staging copy made with `VACUUM INTO`.** At enqueue time the
producer captures a consistent, WAL-complete snapshot to `staging/<key>.<marker>.db` via
`VACUUM INTO`; the worker uploads *that*, not the live temp. **`VACUUM INTO` is used for all sizes** —
`db.serialize()` was empirically verified to return **unopenable** images for WAL-mode file DBs in Bun
1.3.14 (every `data.db` here is WAL, `managed-database.ts:66`), even after a TRUNCATE checkpoint, so it
is **not** usable; `VACUUM INTO` works for tiny and large DBs alike and captures committed-but-
uncheckpointed WAL frames (verified), which also closes gap 2. This one mechanism resolves four things:
WAL-completeness, the longer-async-window torn-read risk (frozen copy), the version-snapshot race (§3 —
snapshots read staging, not S3), and non-blocking close (§ shutdown — close stages + enqueues, never
awaits the PUT).

## Core invariants

1. **The upload payload is a frozen `VACUUM INTO` staging copy**, captured at enqueue, decoupled from
   the live temp DB.
2. **Staging lives in a dedicated per-mount `staging/` dir that the `cleanupStaleFiles` startup sweep
   (`mount.ts:150`) never purges**, and survives until its marker's PUT acks; then it's deleted. (Only
   *staging* must survive — the live temp may be `cleanupTemp`'d on close once staged.)
3. **The persisted `lastAckedMarker` (staged-content hash) advances only on ack**, survives restart.
4. **At most one in-flight upload per storage key; newest enqueued marker wins** (`pending_uploads`
   PK = storageKey, upsert).
5. **Every enqueue is durably recorded (local `metadata.db`) before the producer returns**, and
   **startup reconciliation runs *before* `cleanupStaleFiles`** — replay can't lose to the sweep.
6. **Uploads are idempotent** (stable UUID key + overwrite); replay is harmless.
7. **Permanent delete cancels a path's pending markers + staging** — never resurrect deleted bytes.
   The **chat byte-replace restore** quiesces the queue for the container first.

## Detailed design

### 1. Crash-recovery durability fix — Phase 1a (no queue, stays synchronous)
When `onOpen` recovers a surviving temp (`mount.ts:1114`), mark the DB dirty so the next (existing,
synchronous) `sync()` re-uploads it. Closes gap 1: unsynced bytes always re-reach S3 on next access,
and `cleanupTemp` can no longer silently drop them. A few lines, no new subsystem, independently
shippable, fixes the most dangerous bug first. (A surviving temp implies a prior crash — clean close
`cleanupTemp`s it — so force-dirty is safe and not wasteful.)

### 2. The upload pipeline — Phase 1b
Per-Mount `enqueue(storageKey, stagingPath, marker)` upserts `pending_uploads` (durable) + stages +
notifies. One process-global `SyncWorker` drains with **per-key serialization** under the global
semaphore, last-write-wins. On ack: set `lastAckedMarker`, delete staging + the pending row. On
5xx/timeout: exponential backoff + **full jitter**, capped budget; never drop. A
`scheduleInterval('sync-retry-sweep', …)` (registered in `scheduler/jobs.ts`) periodically re-drives
any `pending_uploads` whose backoff is due across live mounts. `sync()` no longer advances the
watermark — the worker does, on ack; `isDirty` is computed against `lastAckedMarker` so an un-acked
upload self-heals.

### 3. Staging + consistent version snapshots (resolves the close ↔ snapshot conflict)
`onSync` stages a `VACUUM INTO` copy and enqueues, instead of awaiting `uploadFromTemp`. **Version
snapshots must read the staging copy, never S3 and never the ack.** Today `snapshotContainerDataDb`
(`mount.ts:452`) does `flush()` then `copyPath` (`:475`), and `copyPath` reads `storage.read(srcKey)`
(`:433`) — the **S3 object**, which under async is stale (pre-enqueue). Fix: source the version copy
from the container `data.db`'s **local staging file** (staging via `VACUUM INTO` if none is pending),
write `versions/<ts>.db`, and enqueue *that*. This keeps version snapshots correct **and** keeps
`close()` non-blocking — the close-time `snapshotIfDue(true)` (`managed-database.ts:190`, fires for any
DB whose config sets `snapshot`: collab + chat, `writesPerSnapshot:100`; `comments.db` has none) no
longer needs an S3 round-trip. Close ordering: `clearInterval` → stage + enqueue (no await) → snapshot
from staging (local) → `rawDb.close()` → `deleteJournalFiles` → `cleanupTemp` of the live temp.

### 4. Change detection / the marker
Keep `total_changes()` as the cheap in-session dirty gate. The **durable** signal is a single per-key
**staged-content hash** (`lastAckedMarker`). Because `VACUUM INTO` writes the staged file directly
(not through the streaming `writeTempWithHash` helper, which only serves regular uploads/copies), the
hash is a **separate pass over the staged file** — small, localized. One mechanism, not "hash or
counter": a counter bumped in every domain's write transaction is invasive; the staged hash is
self-consistent with last-write-wins and lets us skip a re-PUT when staged bytes equal
`lastAckedMarker`. **`bun:sqlite` 1.3.14 has no `commit_hook`/`update_hook`/backup API** (verified) —
the design uses only `VACUUM INTO`.

### 5. Create path (the latency fix)
`buildDocumentDb(mode='create' && isRemote)` builds the schema locally, then **enqueues** instead of
`await db.flush()` (`mount.ts:1156`). Create returns once the local temp + schema + durable pending
marker exist; existence is then guaranteed by (a) open+cached DB for same-process opens, (b) `onOpen`
recovery, (c) startup replay. A logical create is 2+ DBs, so `provisionManagedDbs` enqueues each and
its rollback loop (`drive.ts:909`) must **purge all** their pending markers + staging (invariant 7).
`local`/`local-key` keep the synchronous flush.

### 6. Delete / trash / restore — cancel-pending semantics
- **Permanent delete** (`deletePath`, removes the storage key `mount.ts:655`): cancel pending markers +
  delete staging for that key, then delete. A queued PUT must not resurrect the object (invariant 7).
- **Trash** (S3 has no rename-to-`.trash`; the object stays, the path is flagged `:746`): **keep** any
  pending upload — the bytes are still the doc's current, restorable state; nothing to resurrect.
- **Restore** — two paths, only one needs quiescing:
  - **Chat byte-replace** (`replaceContainerDataDb` `mount.ts:499`, via `restore.ts:35`: closes the live
    DB, deletes the old path row + storage key, recreates `data.db` under a **new** key): **quiesce the
    queue for the container first** — cancel/await + delete staging for the **old** key, so an in-flight
    PUT can't resurrect or race the replace; the post-restore `data.db` enqueues fresh.
  - **Yjs restore** (`restoreYjsContainer`, `restore.ts:42-65`): mutates the live Y.Doc in place, never
    deletes the data.db key → can't resurrect; last-write-wins covers it; **no quiescing needed.**
  Restore is a live route, so the chat-path quiescing is **Phase 1b**, not deferred.

### 7. Startup reconciliation — Phase 1b
On mount/home open, **before `cleanupStaleFiles`**, read `pending_uploads` and re-enqueue every un-acked
entry (and any orphaned staging whose hash ≠ `lastAckedMarker`). Backstops the create guarantee and the
crash path; ordering before the sweep is invariant 5.

### 8. Shutdown / drain — Phase 1b
- **Idle-timeout teardown** (`home.ts:120` → `Home.destruct`): close just stages + enqueues; **no
  drain** — the process lives on and the global worker keeps draining. (Resolves the prior
  contradiction: the destruct cascade only *enqueues*.)
- **Process shutdown** (`index.ts:17`): `server.stop()` → `await shutdownAllHomes()` (closes stage +
  enqueue their final state) → **bounded global drain** of the worker (`min(stop_grace_period − margin,
  N)`) → `process.exit`. Anything un-drained stays in `pending_uploads` → replayed next boot. The
  worker resolves backends by `mountId`, so it can drain after `shutdownAllHomes`. Raise
  `stop_grace_period` in compose so healthy drains finish; because closes enqueue (don't await PUTs) the
  deadline is meaningful.
- **Backpressure / concurrency:** start the semaphore **conservative (≈4)** — piling parallel PUTs onto
  a throttling provider amplifies a "Slow Down"; full-jitter backoff, optionally adaptive on ack
  latency. Bound the queue and **bound staging *disk*** (oldest-first eviction / cap): a long outage
  with hot large sheets accumulates staging copies, and a full bind-mount also breaks local writes, so
  the "intake continues during an outage" guarantee needs a disk ceiling.

### 9. Observability — Phase 1b
The `[timing] Mount.upload` log (`mount.ts:1014`) still fires, but from the worker, so the
**request-correlated** signal is lost. Add **queue depth, oldest-pending age, per-key retry count, ack
latency** as structured logs + a gauge — otherwise the next outage is invisible until users notice.

## Touch-points

| Area | File:line | Change |
|---|---|---|
| Crash-recovery (1a) | `mount.ts:1114` (`onOpen`) | recovered temp → mark dirty so next sync re-uploads |
| Dirty/marker | `core/managed-database.ts:129,136,184` | persisted staged-hash marker; `sync()`/`close()` enqueue, don't await PUT |
| Stage + upload | `mount.ts:1002,1017` | `onSync` `VACUUM INTO`-stages + enqueues; `cleanupTemp` cleans live temp only |
| Staging dir vs sweep | `mount.ts:150` (`cleanupStaleFiles`) | staging in a dedicated dir the sweep skips; reconcile before sweep |
| DB callbacks | `mount.ts:1106-1144` | rework `onSync`/`onClose`; **branch on `isRemote`** |
| Create-flush | `mount.ts:1156` | `isRemote` → enqueue instead of `await db.flush()` |
| Version snapshot | `mount.ts:452` / `copyPath:416,433` | source from **local staging**, not `storage.read` (S3) |
| Restore (chat) | `mount.ts:499` (`replaceContainerDataDb`) / `restore.ts:35` | quiesce queue for old key before replace |
| Delete / trash | `mount.ts:655` / `:746` | permanent delete cancels pending+staging; trash keeps pending |
| Create rollback | `drive.ts:909` (`provisionManagedDbs` loop) | purge **all** per-DB pending markers on rollback |
| Pending store | `mount/db-config.ts` (+`mount/schema.ts`) | `pending_uploads` table + `lastAckedMarker` |
| Worker + semaphore | `lib/sync/` (new) + `utils/` semaphore + `scheduler/jobs.ts` sweep | one process-global worker; ~15-line semaphore |
| Startup replay | mount/home open | reconcile `pending_uploads` before `cleanupStaleFiles` |
| Shutdown | `index.ts:17` | bounded global drain after `shutdownAllHomes`, before exit |
| Observability | worker + logging | depth / oldest-age / retry / ack-latency |
| Ops (independent) | `docker-compose.yml` + S3 | `stop_grace_period`; **S3 noncurrent-version lifecycle rule — ship now** |

## Failure modes → mitigation

| Scenario | Today | With this design |
|---|---|---|
| Crash with unsynced temp | reopen→idle-close deletes temp (loss) | **Phase 1a**: recovery marks dirty → re-uploaded |
| Create during slow S3 | request hangs / 503s | returns instantly; uploads in background |
| Slow flush at shutdown | sequential close → SIGKILL truncates | closes enqueue; bounded global drain; replay on boot |
| Idle teardown mid-upload | (sync, blocks) | close enqueues; global worker keeps draining |
| Version snapshot under async | n/a (sync today) | sources local staging, not stale S3 (§3) |
| Chat restore vs in-flight upload | n/a | queue quiesced for old key first (§6) |
| Permanent delete vs pending PUT | n/a | pending cancelled → no resurrect |
| S3 503 storm | every write errors | local writes land; bounded queue retries w/ backoff |
| Long outage fills disk | n/a | staging disk cap + oldest-first eviction |
| Startup sweep vs staging | n/a | reconcile before `cleanupStaleFiles`; staging dir exempt |
| Host disk lost | recent writes lost | unchanged (residual RPO; Litestream-class) |

## Complexity & fit with the codebase philosophy

CODE-STANDARDS.md prizes "flat and direct… no manager classes… no unnecessary complexity." A durable
at-least-once async pipeline needs most of these parts, but to stay in spirit: **split the work** (the
cheap correctness fix isn't gated behind the async subsystem); the **semaphore is a ~15-line counting
primitive in `utils/`**, not a configurable class; **reuse `scheduler/`** for the retry sweep (don't
build a job framework); `lib/sync/` is one focused worker module — the largest single new subsystem in
`docs/`, isolated to Phase 1b and reviewable on its own.

## Phased rollout (data-loss fix first)

1. **Phase 1a — crash-recovery durability fix.** §1 only. No queue, sync stays synchronous. Closes the
   **data-loss** gap. Small, safe, ship first.
2. **Ship independently, anytime — S3 noncurrent-version lifecycle rule.** Orthogonal; fixes the
   version-bloat half of the incident with none of this machinery.
3. **Phase 1b — write-behind pipeline (the latency fix).** Per-Mount `pending_uploads` + staged-hash
   marker + one global worker/semaphore/sweep; decouple create + close; §3 snapshot-from-staging; §6
   delete/restore cancellation; §7 startup replay (before the sweep); §8 bounded drain + conservative
   concurrency + disk cap; §9 observability. Scoped to `isRemote`.
4. **Future — WAL-shipping** (below).

## Open questions / risks

- **Cross-host create before replay:** with home-relay sharding, a strict `openDatabase` from another
  host could 404 a just-created object before replay. Single-host today; keep create synchronous for
  the rare cross-home case, or have the relay wait on the pending marker.
- **Staging-copy cost** for large hot sheets every sync (§3) — `isDirty`-gated; throttle or accept;
  ultimately solved by WAL-shipping.
- **Adaptive vs fixed concurrency** — start fixed (≈4), measure, iterate.

## Testing strategy

- **Build** a fault-injection `StorageBackend` wrapper (`storage/types.ts`) that delays / 503s / drops
  PUTs — net-new (`mount.test.ts`/`storage.test.ts` only exercise `local`/`local-key`).
- **Phase 1a / crash mid-upload:** kill before any sync (and between enqueue and ack) → reopen / startup
  replay restores the object; doc opens with all writes.
- **Shutdown during outage:** SIGTERM with a backed-up queue → bounded drain, clean exit, full replay.
- **Idle teardown mid-upload:** force idle destruct during an in-flight PUT → upload still completes.
- **Concurrency / last-write-wins:** rapid writes during an in-flight upload → final S3 object = local.
- **Version snapshot under async (§3):** version equals staged bytes, not stale S3.
- **Chat restore vs pending (§6):** in-flight PUT during restore can't resurrect the old object.
- **Startup sweep (inv. 5):** a >1h-old staging file from an outage is replayed, not swept.

## Key decisions

- **Data-loss fix first, standalone** (Phase 1a) — cheapest, most urgent, no async machinery.
- **`VACUUM INTO` for all sizes** — the single frozen-staging primitive; unifies WAL-completeness,
  torn-read safety, non-stale snapshots, non-blocking close. **Not** `serialize()` (unopenable for WAL
  DBs in Bun 1.3.14, empirically verified) and **not** the (non-existent) backup API.
- **State per-Mount; worker/semaphore/sweep process-global & stateless** — shards with the Home,
  survives idle teardown, `home-relay.ts` untouched; `local`/`local-key` stay synchronous.
- **Durable write-behind, not fire-and-forget** — *don't-discard-until-ack* + *persist-the-pending-
  intent* + *replay-on-boot* (before the sweep) makes async safe.
- **One marker = staged-content hash** (separate hash pass), not hash-or-counter.
- **Conservative concurrency + disk-bounded staging** — a provider slowdown punishes parallelism and
  unbounded local spill.
- **Keep whole-file objects for now**; WAL-shipping is the end-state, out of scope here.

## Future: WAL-shipping (Litestream model)

Shipping changed WAL frames instead of whole files is *inherently* "only real changes" + "less data" +
async + transactionally consistent (checksummed frames, point-in-time recovery, ~1s RPO), and kills the
version-bloat and staging-cost problems at the source. Cost: Litestream is one-DB-per-instance; our
many-small-DBs model needs a custom WAL-shipping layer. Park as strategic direction once Phase 1 lands.

## As-built notes (divergences from the design above)

The original design's load-bearing flaw was the **worker lifecycle**: it assumed a process-global,
stateless worker that "resolves a mount's storage backend by `mountId`" and "keeps draining after idle
teardown." The actual architecture makes that impossible — `Home.destruct()` closes every managed DB
(incl. each mount's `metadata.db`, which holds `pending_uploads`) and clears the map; mounts live only
in the per-Home `Drive.mounts`; the S3 backend is built from `MountConfig.s3Config`, which is gone with
the Home. There is no surviving registry. So the build diverges:

1. **Registry-free worker.** The only process-global state (`lib/sync/sync-worker.ts`) is a concurrency
   `Semaphore` (`utils/semaphore.ts`) + a `Set` of **live** mounts with pending work + the shutdown
   deadline. The queue itself is per-Mount in `metadata.db`. A mount **unregisters on teardown**; its
   leftover pending rows + staging files are **replayed on the next `Mount.init()`**
   (`reconcilePendingUploads`, before the tmp sweep — invariant 5). The retry sweep + shutdown drain
   only ever touch live mounts, so nothing needs to reach a destructed one. `home-relay.ts` untouched.
2. **`onOpen` recovers from staging.** Under async, a clean close during an outage cleans the live temp
   but the upload hasn't acked. So `onOpen` (for `isRemote`) recovers from the **staging copy** when a
   pending row exists, before falling back to a (stale/absent) storage download — otherwise a reopen
   mid-outage would 503 or read stale bytes. (Crash recovery from the live temp + Phase 1a force-dirty
   still takes precedence.)
3. **No persistent content-hash marker.** The proposal's `lastAckedMarker` (a per-key staged-content
   hash, separate hash pass) was dropped: the cheap in-session `total_changes()` gate already suppresses
   the only redundancy a hash would catch, and the genuine redundancy (full re-PUT per delta on a hot
   doc) is unsolvable without WAL-shipping anyway. Last-write-wins + supersession use the **staging file
   path** as the marker (UUID-named, unique per enqueue; PK upsert; the worker re-checks
   `row.stagingPath` immediately before and after each PUT). One fewer table, no hashing cost.
4. **`flushNow` drain, not `ignoreBackoff`.** A single due-loop (`nextAttemptAt <= now`) where a failed
   PUT backs its row off into the future — so the loop drains each row once and **never spins** on a
   dead backend. The shutdown flush + tests pass `flushNow` (reset all backoffs → one immediate attempt
   each) bounded by an absolute `deadline`; the retry sweep respects backoff.
5. **Shutdown drain is per-mount, after the final enqueues.** `index.ts` sets a process-global
   `setShutdownDrainDeadline(...)` before `shutdownAllHomes()`; each `Mount.closeAllDatabases` closes its
   docs (final close-time enqueues) **then** flushes its queue bounded by that deadline, before
   `metadata.db` closes. Idle teardown leaves the deadline null → no flush → replay on reopen. This
   catches the final shutdown writes, which a single global drain *before* `shutdownAllHomes` would miss.
6. **Chat-restore quiescing falls out of delete.** `replaceContainerDataDb` already closes + `deletePath`s
   the old `data.db` key; `deletePath`'s `cancelPendingUpload` (added for invariant 7) handles the
   quiescing, and `createFile` writes the replacement under a **new** key synchronously. No separate
   quiesce step needed.

**Scope as built:** Phase 1a (any temp-copy backend) + Phase 1b (`isRemote`/S3 only; `local`/`local-key`
keep synchronous writes). Observability is partial (§9): `Mount.pendingUploadCount` queue-depth getter +
the existing per-upload `[timing]`/`[sync] failed` logs; structured gauges for oldest-pending-age and
ack-latency are not yet added. The S3 noncurrent-version lifecycle rule + the `docker-compose`
`stop_grace_period` raise are ops changes tracked separately (not code in this branch beyond the 20 s
`SHUTDOWN_DRAIN_BUDGET_MS` constant, which assumes a grace period above it).

### Review findings + residual limitations (post-multi-agent review)

Three independent Opus reviews (correctness/data-loss, code-quality, test-coverage) ran against the
branch. The one real bug they surfaced is fixed; the rest are documented trade-offs.

- **Resurrection during an in-flight PUT — FIXED.** A permanent-delete/restore landing *during* a PUT
  (after `performUpload`'s pre-PUT re-check) would let the completed PUT recreate the just-deleted
  object as an orphan. `performUpload` now, on a PUT that succeeded but whose row is *gone* (cancelled,
  not merely superseded), issues a compensating `storage.delete` — the key is a dead UUID, never reused,
  so this can't clobber a fresh object. Covered by the "delete during an in-flight PUT" test (verified to
  fail without the guard). The fault-injection `StorageBackend` reads the body up-front like a real S3
  PUT so this window is actually reproduced.
- **Version snapshot during a concurrent close — residual, low severity.** If a snapshot's
  `documentDbs` lookup misses in the narrow window between `closeDatabase`'s map-delete and the close's
  own sync, it sources from a pending staging copy or storage, which can be up to one sync interval
  behind — a slightly-stale *version-history* entry, never live-doc data loss. Mitigated by sourcing the
  live `VACUUM INTO` first when cached; the residual is the cache-miss window. Not worth a deadlock-prone
  cross-lock with the close path.
- **Idle-teardown widens the outage RPO — accepted.** A home that idle-destructs mid-outage leaves its
  queued uploads on the host bind-mount until the home is next opened or the process restarts (replay),
  rather than draining immediately (no surviving registry — by design). Same disk durability as today's
  temp files; only a host-disk-loss *during* that window loses the queued bytes (Litestream-class
  residual). Healthy S3 acks in ms, long before the 5-min idle timer, so this only bites during a
  multi-minute outage.
- **`VACUUM INTO` corruption — not reachable.** `VACUUM INTO` fsyncs its output file before returning,
  and the pending row is inserted *after* `stageCopy` returns, so the staged copy is durable-before-row;
  a crash can't leave a referenced-but-partial staging file. Any corruption would also be caught on
  open, not silently served. No per-PUT integrity check added.
- **Shutdown drain budget is whole-process.** `SHUTDOWN_DRAIN_BUDGET_MS` bounds when the loop *starts*
  new PUTs, not an already-in-flight one (≈ deadline + one PUT). Multi-mount homes drain mounts
  sequentially, so the budget is first-mount-biased; anything undrained replays on boot — safe, just
  not fair. A PUT that overruns the grace period is SIGKILLed and replayed.
- **Deliberately synchronous `metadata.db` access.** The pipeline uses the sync `bun:sqlite` API (no
  `await`) on purpose: `enqueueUpload` must persist before returning, and the drain's post-PUT
  bookkeeping must have no `await` between the `uploadClosing` teardown guard and the DB access. Adding
  `await` for stylistic consistency would inject interleaving points and re-open the teardown race.

### Ops

- **`stop_grace_period: 30s`** on the `eigen-api` service (`docker-compose.yml`) — gives the SIGTERM
  drain (`SHUTDOWN_DRAIN_BUDGET_MS=20s`) room to finish before Docker SIGKILLs; un-drained uploads
  replay on boot regardless.
- **S3 noncurrent-version expiration on `eigen-drive`.** Bucket versioning is now ON (good — it would
  have made the 2026-05-30 chat wipe recoverable), but the pipeline re-PUTs whole `data.db` files, so
  every sync creates a new version and noncurrent versions accumulate without bound. Add a lifecycle
  rule to expire them (and abort stale multipart uploads). `NoncurrentDays` is the recovery-window ↔
  storage-cost knob — 30 d is recovery-safe; drop toward 7 d if hot-doc version bloat dominates cost
  (WAL-shipping later removes the whole-file churn). Hetzner Object Storage is S3-compatible:
  ```bash
  cat > /tmp/eigen-lifecycle.json <<'JSON'
  { "Rules": [ {
      "ID": "expire-noncurrent-versions",
      "Filter": {},
      "Status": "Enabled",
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
  } ] }
  JSON
  AWS_ACCESS_KEY_ID=<key> AWS_SECRET_ACCESS_KEY=<secret> \
    aws s3api put-bucket-lifecycle-configuration \
      --endpoint-url https://nbg1.your-objectstorage.com \
      --bucket eigen-drive --lifecycle-configuration file:///tmp/eigen-lifecycle.json
  # verify: aws s3api get-bucket-lifecycle-configuration --endpoint-url https://nbg1.your-objectstorage.com --bucket eigen-drive
  ```
