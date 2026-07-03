# Deep-dive: `mount.ts`, storage, and sync

_Companion to [AUDIT.md](AUDIT.md). Scope: `apps/api/src/lib/mount/` (mount.ts 1835 LOC, upload-queue.ts,
content-reindex-queue.ts, db-config.ts), `lib/storage/`, `lib/sync/`._

`Mount` is the storage core: file CRUD, path resolution, three storage backends (`local` hierarchical,
`local-key` flat UUID, `s3`), trash, versioning mechanics, the write-behind upload queue, the content
reindex queue, and the managed document-DB lifecycle. It is the most safety-critical class in the
product and, at 1835 lines, the largest. **Grade: B** — the write-behind pipeline's invariant
discipline is genuinely strong; the residual risk is one class of bug (a resolved path captured across
a mutation) plus a large-but-clean god file.

## The theme: id-stable keys vs resolved-path caching

Almost every finding below is one shape. `s3` and `local-key` build storage keys from the immutable
`pathId`, so a key never changes. `local` — **the default self-host backend**
(`defaults.mount.storageType` resolves to `local`, server-settings.ts:20) — builds keys from the
_hierarchical path_. Anything that caches a `local` key (a sync callback, a staging row, a breadcrumb)
and then survives a move/rename/relocate is now pointing at a dead location. The durable fix is not
more guards; it is **resolve-inside-the-callback** and **evict-the-cache-on-mutation**.

## P1 findings

### Open document DBs sync to a stale path after move/rename on `local` [certain]

`buildDocumentDb` captures the key once:

```ts
// mount.ts:1329
const storageKey = await this.getStorageKey(pathId);
```

and the `onSync`/`onClose` closures reuse it (mount.ts:1384, 1407). But `Drive.movePath`
(drive.ts:526) and `Drive.renamePath` (drive.ts:579) call `mount.updatePath` **without** closing open
collab/chat DBs — `closeCollabDocument*` runs only on trash/delete. So when user B edits a doc while
user A moves or renames its container (or any ancestor folder), `storage.rename` relocates the
directory, and every subsequent 30s sync + the final close-sync writes `data.db` to the **old** path.
`LocalStorage.write` uses `createPath: true` (local-storage.ts:31), so it silently rebuilds a zombie
tree. On reopen, `getStorageKey` resolves the new path → the doc reverts to its move-time state; every
edit after the move is orphaned bytes in the zombie directory.

The same stale capture bites **trashing a chat container**: `closeCollabDocumentsRecursively`
(drive.ts:1398) closes only `isCollabType` (Yjs) docs, so a chat `data.db` and every doc's
`comments.db` stay cached through the trash directory rename, and their close-time sync writes outside
`.trash/`; a later restore loses the last ≤30s.

**Fix:** resolve the key _inside_ the callbacks (`await this.getStorageKey(pathId)`, skip upload if the
row is gone), and close cached `documentDbs` under a container in `trashPath`/`deletePath`. This is the
central data-loss finding in the whole audit and it hits the default backend.

## P2 findings

### `cleanupStaleFiles(tmpDir, 1h)` deletes crash-recovery temps on a delayed restart [likely]

`init` sweeps `tmpDir` at mount open (mount.ts:242), but the live working copies of open document DBs
live in exactly that dir (`getTempPath`, mount.ts:1217), and the crash-recovery `markDirty` path only
runs when a doc is later _opened_. Process dies Friday, restarts Monday → every surviving temp is >1h
old and is unlinked before recovery can adopt it. Loss is bounded (staged copies + `pending_uploads`
replay to the last sync), but the last ≤30s per open doc is gone — precisely the window Phase 1a
exists to close. SYNC.md's "a surviving temp is force-dirtied on reopen" is untrue for delayed
restarts. **Fix:** skip sweeping tmp entries whose basename matches an existing `paths.id` (streaming
temps use random ids that never match, so they're still swept).

### ContentReindexQueue clears the dirty bit on extraction failure [certain]

```ts
// content-reindex-queue.ts:69-80
} catch { /* log */ }
this.mount.markContentIndexed(path.id);   // runs unconditionally → contentDirty = 0
```

A transient `extractText` failure (S3 hiccup, 503) marks the container indexed-with-no-content; it
won't be retried until its _next_ body write. During the v6 backfill this silently drops rarely-edited
docs from body search indefinitely. **Fix:** on failure set `contentIndexedAt = now` but leave
`contentDirty = 1` (the 2-min cap already prevents hot-spinning); distinguish "extracted empty" from
"extract threw."

### `copyPath` reads a possibly-stale storage object for a data.db with a pending upload [certain]

The file branch does `this.storage.read(srcKey)` directly (mount.ts:584); for containers,
`flushContainerDb` only _stages + enqueues_ on remote mounts, so the PUT races the GET. Duplicating an
open doc on an S3 mount yields a copy missing edits since the last _acked_ upload (arbitrarily old
during an outage), and duplicating a just-created doc can 404. Duplicate-then-delete-original = real
loss. The snapshot path already documents and avoids this ("never the stale read the old copyPath
did", mount.ts:697). **Fix:** source bytes the way `stageDataDbSnapshot` does — pending staging copy,
then cached live `stageCopy`, then storage. `copyPathAcross` has the same gap (copy-across.ts:41).

### `pending_uploads.stagingPath` stores absolute paths [certain]

`newStagingPath` joins an absolute path (upload-queue.ts:53), and `reconcile` **deletes** rows whose
`stagingPath` doesn't exist, then unlinks staged files no surviving row references
(upload-queue.ts:105). A host migration / restore-from-backup / bind-mount change while uploads were
pending (exactly the S3-outage scenario the queue exists for) makes every absolute path miss → every
pending row dropped → the staged bytes swept. The schema comment "moves with the Home"
(schema.ts:33) documents the intent the implementation breaks. **Fix:** store the basename, join with
`stagingDir` at read time (with a fallback for existing absolute rows).

### Reindex drain racing teardown re-opens DBs after the cache is cleared [likely]

`closeAllDatabases` closes docs and clears `documentDbs` first, then `reindexQueue.close()` last
(mount.ts:1471). An in-flight `extract` mid-await (which opens a doc DB and deliberately never closes
it) inserts a fresh `ManagedDatabase` into the just-cleared map — nothing ever closes it (leaked
30s timer, fd, temp; dirty syncs would write into the closed metadata.db). Triggered when a v6
backfill drain outlives the 5-min idle timeout. **Fix:** in `closeAllDatabases`, `reindexQueue.close()`
_first_ and await its in-flight drain before closing document DBs.

### Delete/trash never evict cached document DBs → resurrection [likely]

`deletePath` cancels the queued upload (invariant 7) but doesn't `closeDatabase(pathId)`
(mount.ts:869). If the DB is still open and dirty (chat is never closed on trash), the next tick
re-stages and re-enqueues the dead key: on S3 an unreferenced object reappears in the bucket forever;
on `local` a zombie file reappears. **Fix:** `await this.closeDatabase(pathId, {skipFinalSnapshot:true})`
in the delete/trash file branch when `documentDbs.has(pathId)`.

### Concurrent same-name create is un-serialized [possible]

`assertUniqueName` (mount.ts:386) → _await storage write_ (an S3 PUT, seconds) → insert, with no unique
index on `(parentId, name)`. Two concurrent requests (two tabs, WebDAV + web) both pass and both
insert. On `local`, both rows get `file = name` → same disk path → the second write clobbers the first
and deleting either deletes both. **Fix:** a partial unique index
`CREATE UNIQUE INDEX ... ON paths(parentId, lower(name)) WHERE trashedAt IS NULL` in a v7 migration
(matches the existing case-insensitive semantics), letting the insert throw 409.

### No client-side timeout on the queue's PUT [possible]

`await this.storage.write(...)` (upload-queue.ts:217) inside the semaphore, and `S3Storage` sets no
timeout/retry. A TCP-black-holed PUT (the nbg1 incident class is slow→503; a hang is adjacent) never
resolves → the drain loop never advances, backoff never triggers, and the shutdown deadline (checked
_between_ uploads) can't interrupt it. Four such hangs exhaust the destination semaphore for every
mount sharing it. **Fix:** race the PUT against a generous deadline (~120s) and treat a timeout as a
failure so backoff takes over.

## P3 findings

- **Restoring a trashed dirty container never re-kicks the reindexer** (mount.ts:1011) — stale body
  search until the next unrelated write. Add `this.reindexQueue?.kick()` at the end of `restorePath`.
- **Chat version restore leaves the search index on pre-restore content** — `replaceContainerDataDb`
  (mount.ts:713) writes via `createFile` (no `onSync`), so `markContainerContentDirty` never fires.
  Set `contentDirty = 1` + kick inside it.
- **NFC normalization asymmetry** — `getChildByName`/`resolvePath` normalize (mount.ts:354,370) but
  writes store raw; an NFD filename from macOS drag-drop becomes invisible to lookup and an NFC twin
  can coexist. Normalize once in `validateName`.
- **`validateName` accepts control chars that `resolvePath` rejects** (mount.ts:51 vs 373) — a name
  with `\x01` is creatable via the API but unreachable over WebDAV. Add the `[\x00-\x1f]` check
  (AGENTS.md already mandates it).
- **`writeFile` marks `contentDirty` unconditionally**, including binary overwrites (mount.ts:1197),
  costing a pointless drain visit per PNG PUT. Mirror `createFile`'s `isSearchableTextFile` gate.
- **`downloadToTemp` can truncate a live working copy** (mount.ts:1224) — safe today (only version
  files, never opened) but nothing enforces it. Throw if `documentDbs.has(pathId)`.
- **`restorePath` computes the conflict-free name outside the path lock** (mount.ts:1026 vs 1041) —
  two concurrent restores can claim the same name; move the check inside `withPathLock`.

## Duplication

- **type→mime map inlined** in `createFolder` (mount.ts:412) re-lists what `EIGEN_DOC_TYPE_INFO[type].mime`
  already owns — the exact "two lists of one fact" the standards ban. Derive it.
- **`[timing] Mount.upload` log** is emitted from the synchronous PUT (mount.ts:1259) and the queued
  PUT (upload-queue.ts:220) with different meanings under one grep key. Rename one.
- **Spec-only invariant numbering** — comments cite "invariant 2/5/7", "§3", "§9" but the numbered
  spec lives only in gitignored `docs/superpowers/`; committed SYNC.md has no numbering, so the next
  maintainer can't dereference them. Number the invariants in SYNC.md or drop the references.
- The `UploadQueue`/`ContentReindexQueue` scaffolding mirror is a _deliberate_ structural parallel,
  documented as such — correctly not abstracted. Keep it.

## Decomposition proposal for `mount.ts`

`mount.ts` is not tangled — it has clean internal seams — but it's big enough that the "guard one layer
too high" bugs hide in it. The proposal follows the existing `copy-across.ts` precedent: **plain-function
modules taking `mount: Mount` as the first argument, no new classes, no managers.** `Mount` stays the
public facade; internals it must expose get de-`private`d with an `// internal — used by mount/*.ts`
note. Each step compiles and keeps `mount.test.ts` green on its own.

### Responsibility inventory

| # | Responsibility | ~Lines |
|---|---|---|
| A | Pure helpers (`validateName`, `buildStorageKey`, `isSqliteFile`, `isViableRecoveryTemp`) | 51-113 |
| B | Construction / init / dir getters / stale-file cleanup | 115-299 |
| C | Tree reads (`getPath`, `listFolder`, `resolvePath`, `getBreadcrumb`, `getPathsByMimeType`, sizes) | 296-398, 1522-1704 |
| D | Row mapping + folder-size cache (`toDrivePath`, `computeAndCacheFolderSize`) | 1706-1810 |
| E | Storage-key resolution (`getStorageKey`, `resolveStoragePath`, `isRemote/isPathBased`) | 400-406, 824-867 |
| F | CRUD + locking (`createFolder/File`, `updatePath`, `deletePath`, `withPathLock`) | 408-537, 729-946 |
| G | Copy (`copyPath`) | 539-609 |
| H | Versioning mechanics (`snapshotContainerDataDb`, `stageDataDbSnapshot`, `replaceContainerDataDb`) | 611-727 |
| I | Trash (`trashPath`, `restorePath`, `listTrash`, `purgeTrash`, recursive helpers) | 948-1162 |
| J | Raw file IO + temp plumbing (`readFile`, `writeFile`, `downloadToTemp`, `uploadFromTemp`) | 1164-1267 |
| K | Managed document-DB lifecycle (`openDatabase`, `buildDocumentDb`, `close*`, queue facades) | 1281-1520 |
| L | Content index + search (`upsertPathContent`, `getContentDirtyPaths`, `searchPaths`) | 1570-1668 |
| M | Config factories (`createMountConfig`) | 1813-1836 |

### Coupling

- **Universal:** `this.db` + `toDrivePath` (D) touch everything; D depends only on `db` + `mountId`.
- **E (key resolution)** is the load-bearing shared seam (used by F, G, H, I, J, K). Keep it next to
  whatever owns `isPathBased`.
- **`documentDbs` map** is shared by H, K, and _should_ be consulted by F's delete and I's trash (the
  P1/P2 findings). **`uploadQueue`** by K, H, F. **`reindexQueue`** kicked from F, G, J, L.
  **`pathLocks`** by F, H, I — must stay one shared map (snapshot and trash serialize on the same
  container).
- **Independent:** A, M, L (needs only `db` + `toDrivePath` + a kick hook), C.

### Split order (dependency-ordered, each independently reviewable)

1. **`mount/helpers.ts`** (A + M) — pure functions + config factories. Zero state. _(~120 LOC out)_
2. **`mount/search-index.ts`** (L) — functions over `(db, toDrivePath)`; `ContentReindexQueue` already
   takes `mount`, unchanged. _(~130 LOC)_
3. **`mount/copy.ts`** (G) — `copyPath(mount, ...)` mirroring `drive/copy-across.ts`; fix the stale-read
   P2 while moving it. _(~75 LOC)_
4. **`lib/versioning/snapshot.ts`** (H) — the natural home next to `versioning/restore.ts` (already the
   orchestration half). Expose `newStagingPath`/`getPendingStagingPath`/`enqueueStaged` as three
   internal Mount methods rather than the queue object. _(~120 LOC)_
5. **`mount/trash.ts`** (I) — functions over `mount`; self-contained semantics, 6 test suites cover it,
   the safest large extraction. _(~215 LOC)_
6. **`mount/document-db.ts`** (K) — last, because it touches the most private state. Do it **after** the
   P1 fix (recompute keys in callbacks) so the extraction doesn't move a bug. _(~240 LOC)_

End state: `mount.ts` ≈ 900 LOC (B, C, D, E, F, J + thin facades) plus five sibling modules of 75-240
LOC each; `index.ts` re-exports unchanged.

### What should NOT be split

- **E + F + J together** (key resolution, CRUD, temp/IO): the crash-ordering invariants
  ("storage-write before DB-insert", "DB-delete before storage-delete") and the key-resolution rules
  are one interlocked design. Scattering them is how the next stale-key bug gets written. This _is_
  Mount.
- **C + D** (queries + row mapping): short and obvious; every extracted module calls back into them —
  extraction would create 15 one-line delegates for zero gain.
- **`withPathLock`/`pathLocks`**: one instance-owned map, never per-module.
- **No per-backend strategy classes.** The `isPathBased`/`isRemote` branching is honest and local;
  `StorageBackend` is already the right polymorphism seam.

## Strengths

- **Invariant-grade comments where they matter.** Nearly every ordering decision states its failure
  scenario. Rare and valuable in a storage core.
- **The 2026-06 fix is defense-in-depth done right.** `mustExist`/`create:false` at the DB layer,
  SQLite-magic + collapse-ratio checks at adoption, truncated-GET cleanup at download — three
  independent blocks on the empty-overwrite class.
- **`UploadQueue`'s supersede/cancel/resurrection matrix** (upload-queue.ts:193) handles every
  interleaving I could construct, including cancel-mid-PUT, without a lock.
- **Symmetric queue design** — dirty-bit-as-durable-queue + kick + self-timer, identical for uploads
  and reindex. No global sweepers.

## The one seam that closes most of this

Themes 2a, and the delete/trash resurrection P2, and the copy stale-read, all reduce to the same
missing primitive: **the cached `documentDbs` map is decoupled from row mutations.** Move, rename,
trash, and delete mutate rows without consulting the cache; the cache only learns at explicit close.
A single `evictOrRebindCachedDb(pathId)` called from every mutation path — plus resolving keys inside
the sync callbacks — closes the class. That's the highest-leverage change in this document.

---

_Postscript 2026-07-03: decomposition executed on `refactor/mount-split` (merged dc0154f4) — `helpers.ts`, `search-index.ts`, `copy.ts`, `versioning/snapshot.ts`, `trash.ts`, `document-db.ts` extracted; mount.ts 2007→1200 LOC. E+F+J, tree reads, single `pathLocks` map kept in-class per the doc. Deviation: `uploadQueue` de-privatized instead of queue-wrapper methods. Open P3s logged with new locations in the branch report._
