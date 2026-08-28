# Proposal: Data integrity + verified backups

> **Status — Proposal, written 2026-07-05, re-verified against code 2026-08-04. Seam F shipped;
> the rest not started.** The P0 roadmap row "Data integrity + verified backups": semantic restore
> tests, integrity checks at every write path, scheduled corruption detection with alerts. Effort M.
>
> **Shipped 2026-07-13** (`16faf466`, Yjs deep-dive P3 tail): **seam F** — `replayYjsState` returns
> `blobsSkipped` and `readYjsStateFromFile` throws `ApiError(422, 'Snapshot is corrupted…')`, so a
> restore from a snapshot with unreadable Yjs blobs aborts instead of silently degrading
> (`../../apps/api/src/lib/collab/yjs-loader.ts`); plus the Phase-1 regression test "restore from a corrupt
> snapshot fails 422 and leaves the live doc untouched" (`../../apps/api/src/test/storage/versioning.test.ts`).
> That skip-count return is also Phase 3's prerequisite, so §3's semantic verification now builds on
> an existing signal.
>
> **Still to build:** there is no `lib/integrity/`, the scheduler still registers only
> `guest-cleanup`, and `../../scripts/backup.sh` still tars the live `../../data` tree. Phase 1 is reduced to
> seams A/C/E/G, the post-ack size verify (B), and moving `isSqliteFile` into `lib/integrity/`.
> Phases 2–5 are untouched — every one remains to build. The 2026-07-06 storage-audit fixes overlap
> only as *reactive* guards (notably audit item 9, which closed the failed-read half of seam E —
> see §1).

> **TLDR**: Eigen's stated core weakness is "I would not yet trust it with data you cannot afford to
> lose." The write paths already carry strong *reactive* guards (the `mustExist` open guard, the
> crash-temp viability check, the write-behind queue's seven invariants) — every one added after an
> incident. This proposal adds the *proactive* layer: (1) cheap validity checks at each seam where new
> bytes replace good bytes, (2) a paced background sweep that finds corruption and metadata↔storage
> drift before a user does, (3) semantic verification of backups — CRDT bytes aren't
> byte-comparable, so "the backup works" means "it decodes into a Y.Doc with the declared roots
> populated" — applied to version snapshots and to a made-safe `../../scripts/backup.sh` (today it tars
> live WAL databases), and (4) boring alerting through the existing notification center. No new
> subsystem; every piece extends a named existing pattern.

## Problem

Three production incidents define the threat model:

- **2026-05-30 (chat data loss).** A temp `data.db` surviving an unclean shutdown looked clean to the
  fresh connection (`total_changes()` resets), so its unsynced bytes were silently dropped at close.
  Fixed by `ManagedDatabase.markDirty` (Phase 1a, [SYNC.md](../SYNC.md)).
- **2026-06-08 (stickies wipe).** The Phase 1a fix itself: a failed/empty S3 GET left a 0-byte temp —
  itself a *valid empty SQLite* — which `openCold` opened as a fresh doc and `markDirty` then
  re-uploaded **over the good stored object**. Two live docs wiped, re-wiped on every redeploy. Fixed
  by the `mustExist` guard in `ManagedDatabase.openCold` (refuse a missing/0-byte working copy) plus
  `isViableRecoveryTemp` in `lib/mount/helpers.ts` (refuse a non-SQLite or collapsed temp).
- **2026-07-03 (nbg1 degradation).** Slow S3 → 500s on create → duplicate docs. A one-off read-only
  scan (container rows with no non-trashed `data.db` child) confirmed 0 orphans — but that scan was
  hand-written during the incident. It should be a permanent, scheduled check.

The pattern: **a write path replacing good bytes with bad bytes**, and each guard added *after* the
bytes were lost. Between incidents, nothing looks. A corrupted `data.db` on S3, a stuck upload
backing off for days, a metadata row whose object vanished — all are silent until a user opens the
doc. And the "backup" primitives (per-container version snapshots in `lib/versioning/`, S3 bucket
versioning) are never exercised: a snapshot of an already-corrupt database is a corrupt backup,
discovered at restore time, which is the worst possible time.

The roadmap row says effort M, "no frozen-format impact (new tests/checks)". That is *almost* right —
see § Frozen-format: the sweep's resumable cursor wants one additive `metadata.db` migration.

## Goals

1. **No write seam replaces good bytes with unvalidated bytes.** Every path where a copy of a
   database supersedes stored state gets a validity check proportional to its frequency.
2. **Corruption is found by the server, not the user.** A scheduled sweep covers every managed
   database and metadata↔storage consistency, paced so S3 mounts aren't hammered, resumable across
   restarts.
3. **Version snapshots are verified semantically.** "Verified" is defined per artifact class; for
   collab docs it means the Yjs state decodes and the declared roots are present and populated.
4. **Failures reach a human** via the existing notification center + structured logs, with dedup so
   a persistent failure alerts once, and a clean pass clears it.
5. **The eigen way**: plain functions over existing classes, checks live at the seams they guard, the
   sweep mirrors the scheduler + reindex-queue patterns that already exist.

## Non-goals

- **Restore tooling / UX.** The version-history UI and `restoreContainer` exist and work; this
  verifies what they restore *from*, it doesn't change them.
- **S3 bucket versioning setup.** That safety net is
  [PROPOSAL_S3_VERSIONING_UX.md](PROPOSAL_S3_VERSIONING_UX.md).
- **CRDT format migration.** Separate concurrent proposal (`PROPOSAL_CRDT_MIGRATION.md`). Its
  pre-migration snapshots want exactly the semantic verification built here — the shared primitive
  is called out below so the two don't diverge.
- **WAL-frame shipping (Litestream model).** The strategic replacement for whole-file re-PUT;
  orthogonal and out of scope ([SYNC.md](../SYNC.md) § Residual limitations).
- **Create/open resilience under degraded storage.** The 2026-07-03 UX + atomicity follow-ups are
  [PROPOSAL_CREATE_RESILIENCE.md](PROPOSAL_CREATE_RESILIENCE.md); the scan of record it cites is
  this proposal's sweep check 2.
- **Regenerable artifacts** (FTS indexes, thumbnails, previews). Corruption there is rebuilt, not
  alerted.

## Current state (grounded)

What already exists, so the design extends rather than reinvents:

- **`ManagedDatabase`** (`lib/core/managed-database.ts`): WAL mode, versioned migrations, dirty
  tracking via `total_changes()`, the `mustExist` guard (refuses missing/0-byte working copies on
  "open existing"), `stageCopy` (`VACUUM INTO` — WAL-complete frozen copy), `markDirty` crash
  recovery. No content validation anywhere: a staged copy is enqueued unexamined.
- **Write-behind pipeline** (`lib/mount/upload-queue.ts`, `lib/sync/`, `lib/mount/document-db.ts`):
  per-mount durable queue in `metadata.db.pending_uploads`, per-destination semaphore, backoff,
  replay on reopen. `performUpload` treats a resolved PUT as an ack — no post-PUT verification that
  the object landed whole. A row can back off indefinitely; `pendingCount` exists but nothing reads
  it on a schedule.
- **Recovery guards** (`lib/mount/helpers.ts`): `isSqliteFile` (16-byte magic probe; currently
  module-private — only `isViableRecoveryTemp` is exported) and `isViableRecoveryTemp` (magic +
  collapse-ratio vs last-known size) — used only on the crash-temp adoption path today. Both are
  exactly the cheap probes the other seams need; they should be reused, not duplicated.
- **Versioning** (`lib/versioning/snapshot.ts`, `restore.ts`): `snapshotContainerDataDb` copies
  `data.db` → `versions/<iso-ts>.db` (self-locked, flush-first, retention-pruned);
  `replaceContainerDataDb` replaces the chat `data.db` — post-audit-item-9 it stream-hashes the
  snapshot into a mount temp (`writeTempWithHash`) *before* the delete, so a failed source read
  leaves `data.db` intact, but it still validates nothing about the bytes it stages;
  `restoreContainer` does Yjs surgery for collab types via `readYjsStateFromFile`. The Yjs path
  decodes (an implicit probe) and — since seam F shipped — `replayYjsState`
  (`lib/collab/yjs-loader.ts`) returns `blobsSkipped`, on which `readYjsStateFromFile` throws
  `ApiError(422)`: a snapshot that lost updates now fails the restore loudly instead of "restoring
  fine" as a half-empty doc.
- **Storage backends** (`lib/storage/`): `LocalStorage` and `S3Storage` expose
  `read/write/delete/exists/size`. Neither lists keys — the reverse consistency direction (objects
  without rows) is currently unreachable. `checkS3Connection` already does a write/read/delete probe
  + versioning check at config time.
- **Scheduler** (`lib/scheduler/`): `scheduleInterval(name, ms, fn)` with error isolation; one
  registered job (`guest-cleanup`, daily) in `jobs.ts`. Guest-cleanup also shows the enumeration
  pattern: query the auth DB for users, skip live homes via `atHome()`.
- **Pacing pattern** (`lib/mount/content-reindex-queue.ts`): per-mount, self-scheduled, batch-capped
  (100 rows/turn), durable via the `contentDirty` bit on `paths` (metadata.db v6) — resumable across
  restarts by construction. The sweep mirrors this shape.
- **Alert channel** (`lib/notification-center/`): `home.notifications.persist({...})` with
  tag-upsert dedup + coalesce; `sendToHome(userId, { type: 'notification', ... })` in
  `home-relay.ts` delivers cross-home; `getOrgOwner()` / `getOrgRole()` (`lib/user/user.ts`)
  identify admins.
- **Semantic layer** (`../../packages/lib/src/core/collab/yjs-utils.ts`, `lib/collab/yjs-loader.ts`):
  `readYjsStateFromFile` opens a snapshot `data.db` raw (no migrations) and replays it into a
  Y.Doc; `EIGEN_DOC_TYPE_INFO[type].yjsRoots` (`../../packages/lib/src/types/drive.ts`) declares each
  container type's root schema. Server-side gotcha, already documented in `restoreYjsDoc`: roots
  hydrated via `Y.applyUpdate` are `AbstractType` — `instanceof` fails; force-type via
  `doc.getMap/getArray/getText/getXmlFragment` (or the `_start != null` idiom) before reading.
- **Integrity anchors in `metadata.db`**: `paths.hash` (sha256, set by `Mount.computeHash` on
  upload/write/copy of plain files — *not* maintained for managed `data.db` rows, whose `size` is
  refreshed by `syncDocumentDbSize` but whose `hash` goes stale) and `paths.size`.
- **Existing tests**: `managed-database.test.ts` pins `mustExist` (missing + 0-byte);
  `sync-resilience.test.ts` has a dedicated "data-loss guard" describe pinning the 2026-06-08 shape
  (0-byte temp discarded, content-empty temp doesn't collapse a larger object) plus queue
  reconcile/backoff/cancel; `versioning.test.ts` covers save/restore round-trips, rejects a
  malformed snapshot *name*, and (since seam F) pins the collab corrupt-*file* case — "restore from
  a corrupt snapshot fails 422 and leaves the live doc untouched". The chat (`replaceContainerDataDb`)
  side of that fixture is still missing.

## Design

### 1. Write-path integrity checks

The seams, from reading the write paths end to end. Principle: **the check runs before bytes replace
good bytes**, and its cost is proportional to seam frequency.

| Seam | Code | Failure it stops | Check | Cost / when |
|---|---|---|---|---|
| **A. Staged-copy enqueue** | `UploadQueue.enqueueStaged` (both producers — `onSync` in `document-db.ts` and `snapshotDataDbToVersionStaged` — pass through it) | A truncated/failed `VACUUM INTO` (disk full, crash mid-write) becoming the object S3 serves forever | `isSqliteFile(stagingPath)` + non-zero size. On failure: throw — the sync fails, the DB stays dirty, next tick retries; bad bytes never enter the queue | ~16-byte read. **Always** |
| **B. Upload ack** | `UploadQueue.performUpload`, after a successful PUT | A truncated PUT the provider acked anyway | `storage.size(key)` vs staged-copy size; mismatch = treated as PUT failure (backoff + retry, alert after N attempts) | One HEAD per acked upload. **Always** (see D3) |
| **C. Local synchronous sync** | the non-queue branch of `onSync` in `document-db.ts` (path-based `local` mounts call `mount.uploadFromTemp` directly) | Partial temp copy overwriting the stored file | `isSqliteFile` on the live temp (`getTempPath(pathId)`) before the `uploadFromTemp` call. NOT inside `Mount.uploadFromTemp` itself — that is a general-purpose upload also used by `createFileFromTemp`/`writeFileFromTemp` for plain, non-SQLite user files | **Always** |
| **D. Version snapshot creation** | `snapshotContainerDataDb` → `copyPath` / `stageDataDbSnapshot` | Archiving garbage — and retention then *pruning the good snapshots* to make room for it | `PRAGMA quick_check` on the new snapshot copy + semantic verify (§3), async off the container lock | Snapshots fire per `writesPerSnapshot` (100) — infrequent. **Always**, async |
| **E. Restore replacement** | `replaceContainerDataDb` (chat path). Post-audit-item-9 the replacement is already staged via `writeTempWithHash` *before* the delete, which closes the failed-read half of this seam | A snapshot that *reads* fine but holds truncated/corrupt bytes replacing the live `data.db` | `isSqliteFile` + `quick_check` + expected tables present (`messages`, `read_state`) on the staged temp (`mount.getTempPath(tempId)`), after `writeTempWithHash` and before `closeDatabase`/`deletePath` run | Rare, user-triggered. **Always** |
| **F. Restore decode (collab)** — **shipped 2026-07-13** (`16faf466`) | `restoreContainer` → `readYjsStateFromFile` | `replayYjsState` silently skipping corrupt blobs → restore "succeeds" into a half-empty doc | Surface the skip count from `replayYjsState`; a restore whose source skipped blobs fails loud (`ApiError(422)`) instead of silently degrading | **Always** |
| **G. Container copy** | `Mount.copyPath` / `copyPathAcross` (container `data.db` children) | A truncated S3 GET on the bridge copy producing a corrupt duplicate | `isSqliteFile` on the copied `data.db` bytes; size vs source row as sanity | Rare. **Always** |
| **H. Crash-temp adoption** | already guarded — `mustExist` + `isViableRecoveryTemp` | The 2026-06-08 class | No change; pin with tests (§ Testing) | — |

Container `comments.db` files (comments.db v3, in-document search) ride the same managed
document-DB lifecycle as `data.db` — seams A–C cover them with no extra work.

One ordering fix rides along with seam A: `snapshotDataDbToVersionStaged` creates the
`versions/<iso-ts>.db` row (`touchFile`) *before* staging + enqueueing, so a probe that throws in
`enqueueStaged` would strand a version row with no object and no pending upload — and a retry mints
a new timestamp, leaving the orphan until retention prunes it. On that path, probe the staged copy
before `touchFile` (or delete the row on throw).

Two deliberate *non*-checks, because the grounded failure modes say so:

- **No byte-size-ratio check on staged copies.** `VACUUM INTO` legitimately shrinks a bloated
  `data.db` dramatically (sheets accumulate up to ~100× doc size in `doc_updates` before snapshot
  consolidation), so "staged copy much smaller than previous object" is normal, not suspicious. The
  collapse-ratio idiom stays where it is correct — crash-temp adoption, where the temp should be the
  stored db *plus* unsynced writes, never a fraction of it. Where a "did we lose content?" question
  matters (seam D), the check is *structural*: for collab configs, the copy must contain ≥ 1 row
  across `doc_snapshots` ∪ `doc_updates` when the live doc is non-trivial.
- **No `quick_check` on the 30 s hot sync path** (seam A). The staged copy is written by SQLite
  itself from a healthy open connection; page-level corruption there implies disk-level trouble that
  the scheduled sweep (§2) exists to catch. The header probe is free; a full page walk per sync per
  open doc is not. (Open question D1.)

Implementation shape: `isSqliteFile` moves from `lib/mount/helpers.ts` into the new
`lib/integrity/checks.ts` alongside `quickCheck(path)` and `hasTables(path, names)` — plain
functions, re-exported where the mount code already imports them. Seam code calls them inline; no
wrapper classes, no check registry.

### 2. Scheduled corruption sweep

A new job in `scheduler/jobs.ts` — `scheduleInterval('integrity-sweep', SIX_HOURS, runIntegritySweep)`
— driving plain functions in `lib/integrity/sweep.ts`.

**Enumeration** follows guest-cleanup: owners come from the auth DB (users) + the org's teams, then
each home's data is read **from disk** (`data/home/{id}`, `data/team/{id}` — layout per
[STORAGE.md](../STORAGE.md)), *not* via `getHome()` — spinning up every Home's services six times a day
would defeat idle eviction and keep every mailbox watcher warm. The "never `getHome()` for another
user's data" rule is a request-path sharding seam; a per-server maintenance job over the local data
dir is on the right side of it — when homes shard across servers, each server sweeps its own disk.
Mount configs (S3 credentials) come from the home's `settings.json`, same as `Drive.init` reads them.
A home directory with no matching auth row is itself a finding (orphan home).

**A second connection on a live home's database is NOT safe here — the `atHome()` skip is
mandatory, not an optimisation.** `ManagedDatabase.close()` runs `wal_checkpoint(TRUNCATE)` →
`close()` → `deleteJournalFiles()` (post-audit-item-4: only after a genuinely clean close — a
lazy/zombie close keeps the journals, which strengthens this argument). With a sweep connection also open: the
checkpoint silently can't complete, SQLite doesn't auto-remove the WAL (close isn't the last
connection), and the unlink then deletes a WAL still holding committed-but-uncheckpointed frames
under the sweep's handle — a crash in that window loses them, and a fresh open racing the unlink
creates a new WAL while the old inode is still mapped (the documented SQLite corruption scenario).
`Mount.cleanupTemp` at close gives live container temps the same shape. So disk-level opens are for
**cold homes only**: check `atHome()` before opening *and again after* — if the home went live
mid-check, discard the result and move on. A live home's databases are instead checked through the
home's own cached handles: `ManagedDatabase.stageCopy` a frozen `VACUUM INTO` copy and probe that
(the seam-D mechanics, reused). The `readYjsStateFromFile` open-raw precedent applies only to
immutable archive copies, never live files. Cold DBs open read-write without writing (bun:sqlite's
`readonly` is flaky).

**Per home, cheap tier** (local SQL + stat, no storage calls — checks 2–5 run fully every pass;
check 1 rotates under a per-pass budget):

1. `PRAGMA quick_check` on every home-level DB: `metadata.db` per mount, `mail.db`, `contacts.db`,
   `calendar.db`, `notifications.db`, `shared.db`. Budgeted and rotated, not "all, every pass" —
   `quick_check` holds a read snapshot for a full page walk, and holding one across a GB-scale
   `mail.db` starves checkpoints; a big DB gets checked on its turn.
2. **Orphaned-container scan** — the exact 2026-07-03 query, made permanent: container-type rows
   (`doc/stickies/slides/sheets/chat`) with no non-trashed `data.db` child.
3. **Stuck uploads** — `pending_uploads` rows with `enqueuedAt` older than a threshold (24 h) or
   `attempt` beyond the backoff ceiling: a silent outage or a poisoned destination, invisible today.
4. **Local storage presence** — for `local`/`local-key` mounts, `paths` rows (non-trashed,
   non-folder) vs `fs.existsSync` on the resolved key; exact size match for plain files, presence +
   sane floor for managed `data.db` rows (their row size tracks the *live temp*, not the vacuumed
   object — an exact match is wrong by design).
5. **Maildir presence** — mail bodies are maildir files indexed by `mail.db`
   (`eigen.mail/Maildir/`, [STORAGE.md](../STORAGE.md)); nothing checks the index against them today.
   A vanished or 0-byte message file is silent until the user opens it — or is silently reconciled
   out of the index by the next mailbox sync — and mail has no version snapshots. Cross-check
   `mail.db` message rows against a maildir readdir; flag missing/empty message files. All local,
   same cost class as check 4.

**Per mount, paced tier** (storage GET/HEAD budget — cursored, resumes across restarts):

6. **S3 presence/size** — same as check 4 but each row costs a HEAD. Batched (100 rows/turn, the
   `REINDEX_BATCH` number), bounded per destination per pass, ordered by a new
   `paths.integrityCheckedAt` column (the `contentDirty`/`contentIndexedAt` v6 precedent — see
   § Frozen-format). `ORDER BY integrityCheckedAt ASC LIMIT n` *is* the resumable cursor: a restart
   loses nothing, the least-recently-verified rows are always next. The invariant it buys: every
   path verified at least once per N days, N observable from the column itself.
7. **Deep container check (sampled from the same cursor)** — for container `data.db` rows: fetch the
   bytes (pending staged copy → live temp → storage object, freshest-first, same order
   `stageDataDbSnapshot` uses — the live-temp source only on cold homes; an open doc is probed via
   its `ManagedDatabase.stageCopy`, per the live-home rule above), `quick_check`, then the semantic
   probe of §3 against the latest version snapshot.

The reverse direction — storage objects with no `paths` row — needs key listing the
`StorageBackend` interface doesn't have. Local mounts get it cheaply (`readdir` vs rows) in the
cheap tier; S3 needs an optional `list?()` backed by Bun's `S3Client` listing. Deferred to the last
phase (Open question D6): stray objects are cost/litter, not loss; rows-without-objects is the loss
direction and ships first.

### 3. Semantic snapshot verification (verified backups)

CRDT bytes are not comparable across save cycles — two byte-different `data.db` files can encode the
same document, and a byte-identical copy of a corrupt file is a faithful backup of garbage. So
"verified" is defined semantically, per artifact class, and implemented as **one shared primitive**:

```
verifySnapshotDb(tempPath, containerType) → { ok, measures, skippedBlobs, error? }
```

in `lib/versioning/verify.ts` — next to `snapshot.ts`/`restore.ts`, operating on a snapshot file
the way `readYjsStateFromFile` does (raw `bun:sqlite` open, no ManagedDatabase migrations on an
immutable archive). Steps:

1. `isSqliteFile` + `PRAGMA quick_check`.
2. **Collab types** (`doc/stickies/slides/sheets`): replay into a fresh `Y.Doc` via the yjs-loader
   path, with `replayYjsState` extended to *return* its corrupted-blob skip count — a verification
   that ignores skipped blobs would pass a half-lost snapshot. Then force-type the declared roots
   from `EIGEN_DOC_TYPE_INFO[type].yjsRoots` (the `restoreYjsDoc` idiom — `instanceof` on
   `applyUpdate`-hydrated roots misclassifies; `_start != null` is the presence check) and measure
   each: map key count, array length, text/fragment length.
3. **Chat**: plain SQLite — expected tables (`messages`, `read_state`) present + row counts.
4. Return the measures; the *caller* decides tolerance.

**"Verified" per artifact class:**

| Artifact | Verified means |
|---|---|
| Collab `data.db` snapshot | Decodes with `skippedBlobs === 0`; every declared root present; roots non-empty when the live doc's roots are non-empty (live measured from the open `CollabDocument` if cached, else a decode of the current `data.db`). Exact-count equality is deliberately NOT required — the snapshot is older than live by design |
| Chat `data.db` snapshot | `quick_check` clean; tables present; message count sane vs live (≤ live modulo deletions — flagged only at zero-vs-nonzero) |
| `metadata.db`, `mail.db`, home DBs | No in-app snapshot artifact exists (versioning is per-container only); their only backup is the whole-server tar, made safe + verified in Phase 5 (D7). Live verification = the sweep's `quick_check` + the seam guards + (mail) the maildir presence check (sweep check 5) |
| Plain files | `size` matches row; sampled re-hash vs `paths.hash` (populated for plain files; managed rows excluded — their hash is stale by design) |

**When verification runs:** (a) at snapshot creation (seam D) — fire-and-forget with `.catch` off
the container lock, so a close-time snapshot never blocks teardown; a failed verify alerts *and*
marks the snapshot suspect rather than deleting it (a suspect snapshot of a corrupt live db is still
evidence); (b) in the sweep's deep tier — latest snapshot per sampled container, compared against
live. The CRDT-migration proposal's pre-migration snapshots call the same `verifySnapshotDb` before
any migration touches the container — the shared primitive both proposals want. Scoping that
primitive precisely: `verifySnapshotDb` is a *validity probe* — decode + roots-present + measures.
The per-type semantic-*equality* comparator the CRDT migration needs (proving an old-format and a
migrated doc equivalent) is NOT built here; that is new work owned by the CRDT proposal, built with
its first real migration.

### 4. Alerts

No new subsystem. Every finding produces:

1. **A structured log line** — `[integrity] <check> <ownerId>/<mountId>/<pathId> <detail>` — always,
   for grep/journald.
2. **A notification to the org owner** (and org admins) via the existing relay:
   `sendToHome(adminUserId, { type: 'notification', notification: {...} })` — the `HomeMessage`
   variant that already exists. Affected end-users are *not* notified: they can't act on "your
   database failed quick_check", and alarming them is worse than fixing it.

**Dedup / clearing.** The notification tag-upsert dedups the bell, but a re-`persist` every sweep
would re-toast every 6 hours. Alert *state* lives in a server-level `JsonStore`
(`data/server/integrity-state.json` — the `server-config.ts`/`server-settings.ts` pattern):
`{ [findingKey]: { firstSeen, lastSeen } }` where `findingKey` is
`<check>:<ownerId>:<mountId>:<pathId|db>`. Notify only on a key's first appearance; refresh
`lastSeen` on repeats; on a clean pass for a previously-failing key, drop it and persist one
"resolved" notification. A JSON file is enough — the state is small (findings should be rare), server
scoped, and regenerable from a full sweep.

## Frozen-format

- **One additive `metadata.db` migration** (next version after v7 — verified 2026-07-06: v7,
  the storage-audit's unique-active-name index, is the current latest): `paths.integrityCheckedAt`
  (nullable integer), the sweep's cursor — same shape as v6's `contentDirty`/`contentIndexedAt`.
  Additive, backfill-free (NULL = never checked = first in line). The roadmap row's "no
  frozen-format impact" is imprecise on exactly this point; flagged for the deliberate-migration
  decision Eigen-is-live requires. Coordination note: this column and the CRDT-migration proposal's
  `paths.collabFormat` contend for the same next `metadata.db` version slot — whichever lands
  second takes the next number.
- Nothing else touches a persisted format: all checks are reads; `pending_uploads`, snapshot layout,
  Yjs roots, and the notification schema are unchanged. `integrity-state.json` is a new server-local
  file, not a format change.

## Open questions

- **D1 — `quick_check` on the hot sync seam (A)?** Always / sampled / never. A page walk per 30 s
  sync per open doc, on copies SQLite itself just wrote. *Recommendation:* never on seam A (header
  probe only); always on the infrequent seams D/E/G; disk-level rot is the sweep's job. Revisit if
  the sweep ever catches a corrupt staged copy the header probe passed.
- **D2 — Where does the sweep cursor live?** Additive `paths` column vs per-mount JSON.
  *Recommendation:* the column (v6 precedent, resumable by construction, observable with plain SQL);
  accept the one migration.
- **D3 — Post-ack size HEAD on every upload (seam B)?** One extra request per acked PUT.
  *Recommendation:* yes — it is noise next to the PUT it verifies, and it converts "truncated PUT
  discovered at next open, possibly after the local temp is gone" into "retry now while the staged
  copy still exists". Drop to sampled only if provider rate limits complain.
- **D4 — Verify new snapshots synchronously or async?** *Recommendation:* async fire-and-forget with
  `.catch` → alert; a close-time snapshot must never block teardown (the close path is already
  deadline-sensitive). The pre-restore snapshot inside `restoreContainer` is the one place to verify
  *synchronously* — it is the rollback anchor for a destructive operation.
- **D5 — Who is alerted?** Org owner only vs all org admins vs affected user. *Recommendation:* org
  owner + admins (`getOrgRole`-gated), never end-users. Self-hosted single-admin instances get one
  bell either way.
- **D6 — Reverse scan (stray objects)?** Needs `StorageBackend.list?()`. *Recommendation:* defer to
  the last phase; local mounts get the readdir version in the cheap tier for free, S3 listing lands
  with the optional interface method when the loss-direction checks are proven.
- **D7 — Safe whole-server backup: keep `backup.sh` a shell script, or drive it from the API?**
  Today it tars the live `../../data` tree — no checkpoint, no `-wal`/`-shm` handling — so a tar taken
  mid-write captures torn SQLite files, and per §3 the home DBs have no other backup artifact. In
  scope (Phase 5): this proposal builds exactly the primitives that make owning it nearly free.
  *Recommendation:* keep it a script, but copy-then-tar: per-DB `VACUUM INTO` a staging dir
  (`sqlite3` CLI), tar the staging dir, then a post-backup verify pass (`quickCheck` on every
  copied DB, sampled `verifySnapshotDb` over containers) against the tar's contents.
- **D8 — Alert on semantic shrink of a live doc between sweeps?** *Recommendation:* no. Users
  legitimately delete content; version history + bucket versioning are the recovery net for that.
  Only decode/validity failures alert — alarm fatigue kills alerting systems faster than missed
  alerts do.

## Phasing

Each phase ships independently; the cheapest highest-value check goes first.

1. **Write-seam guards (S).** *Seam F shipped 2026-07-13 with its regression test; the rest is what's
   left.* `lib/integrity/checks.ts` (`isSqliteFile` moved out of `lib/mount/helpers.ts`, `quickCheck`,
   `hasTables`); probes at seams A, C, E, G; post-ack size verify (B); the missing regression test
   pinning seam E (below). No schema change, no scheduler — pure hardening of the incident class that
   has actually bitten twice.
2. **Sweep, cheap tier + alerts (S–M).** `lib/integrity/sweep.ts` + the `jobs.ts` registration:
   quick_check over home DBs + metadata.db, the permanent orphaned-container scan, stuck
   `pending_uploads`, local presence/size, orphan-home detection; `integrity-state.json` dedup +
   org-owner notifications. Everything reads what already exists.
3. **Semantic verification (M).** `verifySnapshotDb` + `replayYjsState` skip-count return +
   verify-at-snapshot-creation (seam D) + the sweep's paced deep tier with the
   `integrityCheckedAt` migration and per-destination HEAD budgets.
4. **Reverse scan (S).** Optional `StorageBackend.list?()` (Bun `S3Client` listing + local readdir);
   stray-object findings routed through the same alert state.
5. **Verified whole-server backup (S–M).** ⚠️ Reviewer-driven scope addition (accepted by push,
   2026-07-05) — **requires an explicit go from the owner before implementation starts.**
   Replace `backup.sh`'s live tar with copy-then-tar:
   per-DB `VACUUM INTO` a staging dir, tar the staging dir, then a post-backup verify pass
   (`quickCheck` on every copied DB, sampled `verifySnapshotDb` over containers) — the home DBs'
   only backup artifact becomes a verified one (D7).

## Testing

How the checks are themselves tested (`../../apps/api/src/test`, temp-mount pattern from `mount.test.ts`,
fault injection from `sync-resilience.test.ts`):

- **Corruption fixtures, detected at every seam**: take a real container `data.db`, then (a)
  truncate mid-file, (b) zero page 1, (c) 0-byte it, (d) valid-SQLite-wrong-schema. Assert seam A
  refuses to enqueue (a–c), seam E refuses to replace and leaves the live chat `data.db` intact
  (a–d), `verifySnapshotDb` fails each with the right error class.
- **Semantic round-trip on real fixtures** (`test/fixtures/` exists): create doc/stickies/sheets
  containers, write content, snapshot, `verifySnapshotDb` → roots present, measures match live;
  delete a `doc_updates` row from the snapshot copy → `skippedBlobs > 0` → verify fails.
- **The incident regression, completed.** Already pinned: `mustExist` missing/0-byte
  (`managed-database.test.ts`) and the crash-temp guard (`sync-resilience.test.ts` "data-loss
  guard"), plus the collab half of the corrupt-*file* restore — `versioning.test.ts` "restore from a
  corrupt snapshot fails 422 and leaves the live doc untouched" (seam F, 2026-07-13). **Missing today
  and added in Phase 1**: the chat half — feed a truncated snapshot into `replaceContainerDataDb` and
  assert it throws with the live `data.db` unchanged (seam E).
- **Sweep detection**: plant, in a temp home, one orphaned container (folder row, no `data.db`
  child), one stuck `pending_uploads` row (old `enqueuedAt`), one zeroed-page `mail.db`, one `paths`
  row whose object was deleted, one deleted maildir file behind a live `mail.db` row — one sweep
  pass reports all five; fixing each and re-sweeping clears its alert state (first-seen dedup +
  resolved notification asserted via the notification list). Plus the live-home rule: a sweep pass
  over a home held open by the test skips its DBs (`atHome()` mandatory) and covers them once the
  home is evicted.
- **Backup round-trip (Phase 5)**: run the copy-then-tar backup against a temp data dir with an
  open, mid-write DB; extract the tar; every copied DB passes `quickCheck` and a container passes
  `verifySnapshotDb` — proving the copy happened via `VACUUM INTO`, not a torn live read.
- **Post-ack verify**: FaultyStorage-style backend that acks a PUT but stores truncated bytes —
  upload is retried, not acked; alert fires after the attempt threshold.
- **Pacing**: an S3 mount with more rows than one batch performs ≤ budget HEADs per pass and resumes
  from the cursor after a simulated restart (new sweeper instance, same temp dir).
