# S3 / Eigendoc Persistence TODO

Tracking work surfaced by the **2026-05-30 chat data-loss incident** on
`eigen.is` production. A user opened `chat_with_daniel` and saw an empty
chat. Investigation found:

- The chat's S3-backed `data.db` (`2f3e79df-9362-4989-b4c1-392764862557.db`)
  contained only an empty schema (36 KB, 0 rows in `messages`, no
  `read_state`).
- Other chats in the same mount (`chat_met_robbie`: 63 rows, `Eigen Chat`:
  18, `Sevillagangsters`: 18, etc.) were intact. Single-chat regression,
  not bucket-wide loss.
- User reports the chat had ~2 months of messages prior — so the S3 object
  was actively overwritten with an empty schema at some point.
- The Hetzner Object Storage bucket (`eigen-drive`) had versioning
  **disabled** at the time of the incident, so there is no prior version
  of the object to roll back to. **The chat data is permanently lost.**
  Versioning has since been enabled (see Recoverability posture below)
  along with a 90-day noncurrent-version expiration lifecycle rule, so
  future incidents are recoverable.
- Recovery via Hetzner server snapshots was attempted (7 daily snapshots
  available, May 23–29). The oldest restorable snapshot had an empty
  `tmp/` for this mount — the API hadn't downloaded `chat_with_daniel`'s
  `data.db` in the 5 min before the snapshot, so no cached copy survived.
  Walking forward through snapshots would only help if the API had
  recently accessed the chat AND that download still held real data.
- Cross-check on prod showed `updatedAt == createdAt` and `size == 0`
  on **every** chat data.db row in this mount, including chats that
  demonstrably have content in S3 (`chat_met_robbie`: 63 rows on S3 but
  metadata says size 0 / never updated). So `syncDocumentDbSize` is
  broken for chat data.dbs across the board — these columns are a stale
  signal, not evidence about which chats did or didn't persist. We cannot
  distinguish "daniel was wiped later" from "daniel was never persisted"
  from metadata alone. (Tracked separately as hardening item #6 below.)

**Root cause is still unknown.** What the code review surfaced is a set of
safety-net failures: they don't actively wipe data, but they make this
class of failure invisible in logs and unrecoverable when it happens.

For architecture see [STORAGE.md](STORAGE.md). The relevant files are
`apps/api/src/lib/mount/mount.ts` (S3 cache layer) and
`apps/api/src/lib/core/managed-database.ts` (open/sync/close lifecycle).

---

## Open: root-cause investigation

Find what overwrites a non-empty S3 `data.db` with an empty schema.
Hypotheses to verify or rule out:

1. **`storage.exists(key)` returning false transiently** during S3 hiccups.
   In `mount.ts:962–974 onOpen`, a `false` from `exists()` skips the
   download and `BunDatabase(..., { create: true })` creates a fresh
   empty file. Next sync uploads that empty file over the good S3 object.
   - Reproduce: stub `exists()` to return false once, open a chat with
     existing S3 data, post a message, wait for sync, check S3 object.
   - Fix shape: throw on `exists()` failure rather than silently skipping
     the download. Distinguish "404, object truly missing" from
     "request failed."

2. **`downloadToTemp` short-writing**. `Bun.write(tempPath, file)` is not
   verified. If the S3 read returns 0 bytes (304, redirect, partial), the
   tmp file is empty, and the next sync uploads empty.
   - Fix shape: after download, assert `statSync(tempPath).size ===
     storage.size(key)`, retry on mismatch.

3. **Close + concurrent open race** (see Hardening #2 below). If a write
   ever fell into this race, it would lose only the new writes — not wipe
   existing data — so probably not the active culprit on its own. But in
   combination with #1 or #2, a fresh empty file could escape to S3.

4. **External cause** — manual bucket operation, lifecycle policy, replay
   of an old empty version, restore-from-snapshot that grabbed an earlier
   empty version, an MC/aws CLI typo. Worth ruling out before chasing
   code further.

5. **Single-write upload path**. Audit any code that calls
   `storage.write(storageKey, ...)` directly (mount.ts:346, 876, 922). If
   `uploadFromTemp` is ever called with an empty `tempFile`, S3 is
   overwritten with 0 bytes / empty schema. There's no minimum-size
   guard.

Until 1–4 are ruled out, treat all S3-backed eigendoc `data.db` files
(chat, doc, stickies, slides, sheets) as at risk.

## Open: hardening

The following make data-loss incidents diagnosable and recoverable. None
of them is the root cause, but each one would have shortened today's
investigation or prevented the loss.

### 1. Crash-recovery tmp survival is mostly fictional

`mount.ts:962` logs `[Mount] Recovering from crash: using existing tmp
file for ${pathId}` — implying the tmp file is a recovery artifact.
But:

- `ManagedDatabase.close` calls `deleteJournalFiles()` (deletes `-wal`,
  `-shm`) on every graceful close.
- `Mount` `onClose` calls `cleanupTemp(pathId)` deleting the main `.db`
  tmp file on every graceful close.
- `Mount.init` calls `cleanupStaleFiles(tmpDir, 60 * 60 * 1000)` —
  anything older than 1h is wiped on startup.

Net: recovery only works if the API crashes mid-write **and** restarts
within an hour. Decide what we actually want:

- **Option A — true crash recovery:** keep the tmp + WAL + SHM together
  until the NEXT successful upload (not next graceful close). Replace
  the 1h sweep with "delete only if a successful sync has happened
  since this file was last touched."
- **Option B — drop the recovery story:** remove the misleading "Recovering
  from crash" comment, accept that S3 is the only source of truth, and
  add monitoring so close-time sync failures alarm.

### 2. Race: concurrent close + open can unlink a live DB file

`mount.ts:1005–1014 closeDatabase`:

```
documentDbs.delete(pathId);   // map cleared first
const db = await getter();
await db.close();             // sync, truncate, close, deleteJournalFiles, cleanupTemp
```

If a request arrives between `delete` and the end of `db.close`:

1. New `openDatabase(pathId)` sees empty map → new singleton.
2. New `onOpen` finds tempPath still on disk (close hasn't deleted it
   yet) → "Recovering from crash" → skips download.
3. `new BunDatabase(tempPath, { create: true })` opens the existing file.
4. Old `close` finishes: `onClose → cleanupTemp` unlinks tempPath.
5. New DB now has an open fd to an unlinked file. Writes survive only in
   that fd; nothing on disk for `uploadFromTemp` to find.
6. New sync calls `uploadFromTemp` → `tempFile.exists()` → false →
   silent no-op. All writes since step 5 lost.

**Fix shape:** serialise close vs open per `pathId` (`pathLocks`-style
mutex around the whole open/close cycle), or have `close` keep the entry
in `documentDbs` until cleanup is fully done.

### 3. Silent upload skip

`mount.ts:918–924 uploadFromTemp`:

```typescript
if (await tempFile.exists()) {
    await this.storage.write(storageKey, tempFile);
}
```

If tempFile doesn't exist when sync fires (race in #2, or manual cleanup,
or any unexpected disk state), this silently does nothing. No log, no
error, no telemetry. Writes that were visible to the live session are
silently lost on next download.

**Fix shape:** treat missing tempFile as an invariant violation — log
loudly with `pathId`/`storageKey`/`size-on-open` and throw. The caller
in `ManagedDatabase.sync` should not swallow.

### 4. `closeAllDatabases` swallows close errors

`mount.ts:1019–1024`:

```typescript
try {
    const db = await getter();
    await db.close();
} catch {}
```

If `close()` throws (e.g., S3 unreachable during sync), the error
disappears. The map entry is already cleared, so the next open creates
fresh — possibly empty — state. No way to know an upload failed.

**Fix shape:** at minimum, `console.error('[Mount] close failed for',
pathId, err)`. Consider keeping the entry around for retry on next
request.

### 5. `Mount.upload` is not logged

`Mount.download` has a `[timing] Mount.download ...` log line.
`uploadFromTemp` does not. Today's investigation showed 17 downloads
and 0 uploads in 24h not because uploads were missing, but because
uploads aren't logged at all. The first thing we needed to know
("are uploads even being attempted for this object?") was unanswerable
from logs.

**Fix shape:** add the matching `[timing] Mount.upload <key> <KB>
<ms>ms` log.

### 6. `paths.size` AND `paths.updatedAt` are stuck at creation values for every chat `data.db`

Confirmed on prod: every chat row in the affected mount shows
`size = 0` AND `updatedAt = createdAt` in metadata.db — including chats
with confirmed message rows on S3 (`chat_met_robbie` has 63 rows but
metadata says size 0 / never updated). `syncDocumentDbSize` is wired
into `onSync` and `onClose` and should be writing both columns. So
either:

- It's never running for chats (but their S3 objects DO change — so
  uploads happen via a path that bypasses `syncDocumentDbSize`); OR
- It runs but the writes to mount metadata don't stick (e.g. the mount's
  own ManagedDatabase isn't being checkpointed, or the writes are
  clobbered by another path that resets `size/updatedAt`).

Find which by tracing every call to `syncDocumentDbSize` and adding a
log at entry/exit. If it's not even being invoked for chats, check the
chat-specific sync flow (does ChatRoom open via `drive.openDatabase` or
something that uses different callbacks?).

This isn't *the* data-loss bug, but:
1. It broke today's triage — `size: 0` made us think files were empty
   when they weren't.
2. It removes an obvious "is the chat persisting?" health-check signal.
3. Fixing it gives us `SELECT name, size FROM paths WHERE name='data.db'
   AND size < 40000` as a one-line scan to spot suspiciously-empty
   containers across a mount.

## Open: rearchitecture

### A — Versioning as a ManagedDatabase property (file-level snapshots)

Today eigendoc versioning lives inside `data.db` (Yjs-specific, embedded
in the doc's own state). Move it out: snapshot the entire `data.db` to a
sibling `versioning/data-<timestamp>.db` file in the same container.
Restore is a file copy back.

Wins:

- Generalises to any `ManagedDatabase`, not just Yjs documents (chat
  history, sheets state, etc. all get versioning for free).
- Working `data.db` stays small (no version-log bloat in the live DB).
- Snapshot/restore is a `StorageBackend` copy primitive — cheap across
  backends (S3 `CopyObject` is server-side O(1); LocalStorage and
  LocalKeyStorage are plain file copies). Should be added as a
  `StorageBackend.copy(src, dst)` method so the snapshot code stays
  storage-agnostic.
- Combined with the strict `openDatabase` from proposal 1, gives a real
  recovery path: when `openDatabase` throws (storage object missing /
  unreachable / suspiciously empty), we can prompt "restore from latest
  snapshot".

Design questions to pin down before coding:

- **Snapshot trigger.** On close-if-dirty plus an hourly tick while
  open. Close-only loses snapshots for long-lived sessions. Retention:
  keep last N per container + daily for D days; prune older.
- **Restore semantics.** Explicit user action only. Close live DB →
  storage-backend copy `versioning/data-<ts>.db` → `data.db` → reopen.
  Not an automatic fallback (would mask real bugs).
- **Yjs versioning migration.** Drop in-DB Yjs versioning once
  file-level snapshots exist. One-way migration; needs careful
  rollout.
- **Sheet retention.** Sheet `data.db` files can be large; cap
  retention more aggressively than chat.

## Open: recoverability posture

Document and configure expected S3 setup so we don't end up unable to
recover from incidents like this one:

- **Bucket versioning** should be on for any bucket storing eigendoc
  `data.db` files. Without it, today's loss is unrecoverable from S3
  alone.
- **Lifecycle policy** for older versions should leave enough retention
  for at least one weekly incident review (e.g. 90 days). Tune to
  storage cost vs. recovery window.
- **Host backups of `/opt/eigen/data`** (Hetzner snapshots, restic, etc.)
  cover the local databases (auth, metadata.db, mail.db, etc.) that
  aren't in S3. Should be documented per deployment.
- Server settings page or admin doc should warn operators when S3
  versioning is off on a configured bucket.

## Done

Nothing yet — opened during 2026-05-30 incident.
