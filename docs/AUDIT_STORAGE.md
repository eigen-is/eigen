# Storage foundation audit — `storage/`, `mount/`, `drive/` (2026-07-05)

_Scope: `apps/api/src/lib/storage/` (LocalStorage, S3Storage), `apps/api/src/lib/mount/` (Mount +
trash/copy/document-db/upload-queue/search-index/content-reindex-queue/db-config),
`apps/api/src/lib/drive/` (Drive, SharedDrive + extracted bodies), `lib/core/managed-database.ts`,
`lib/sync/`, `lib/versioning/`. ~7,100 LOC, all read in full._

_Method: full read of every in-scope file; three targeted sweeps (seam/caller integrity, test-coverage
map, docs/proposals cross-reference); runtime probes against the real `Mount` class (path-based `local`
on APFS) and the real `S3Storage` against a local MinIO (`scripts/s3-local`). Baseline test suite green:
1613 pass / 95 files. No code was changed._

## Verdict

**The base is solid.** The layering (Route → SharedDrive → Drive → Mount → StorageBackend) held up under
adversarial reading: the seam sweep found **zero** facade bypasses in production code — nothing outside
`mount/*.ts` + `versioning/snapshot.ts` touches `mount.db`/`mount.storage`/`mount.documentDbs`, WebDAV
goes entirely through SharedDrive with the container write-guard applied on every mutating verb, and the
one `getHome`-direct route (`/request-access`) is a justified no-permission-yet case. The 2026-07-01
audit's P1/P2 classes (stale resolved-path captures, cache resurrection, un-serialized same-name create,
missing PUT timeout) are all closed **and pinned by tests** — `sync-resilience.test.ts` alone is an
exemplary regression net. The invariant-comment discipline (crash-ordering, watermark-before-await,
delete-before-close, freshest-first reads) is the strongest I've seen in this codebase.

What remains is **not architectural**. No redesign is needed and none is recommended. The residual risk
concentrates in three places:

1. the path-based `local` backend (the self-host default), where names are storage paths — one confirmed
   data-loss bug (`.trash` aliasing) and two robustness gaps (Unicode-case aliasing, no name-length cap);
2. HTTP caching of served bodies, which relies on every frontend consumer remembering `?v=` instead of
   the server sending an ETag it already has in `paths.hash`;
3. S3-specific code that no test has ever executed (now partially probed against MinIO — mostly correct,
   two warts).

Known, already-proposed work is cited but not re-reported: fd budget (PROPOSAL_FD_BUDGET), atomic
eigendoc create (PROPOSAL_CREATE_RESILIENCE), integrity sweep + `verifySnapshotDb`
(PROPOSAL_DATA_INTEGRITY), durable relay outbox (PROPOSAL_HOME_RELAY_OUTBOX), bucket versioning UX
(PROPOSAL_S3_VERSIONING_UX).

## P1 findings

### A user folder named `.trash` aliases the real trash directory → trash wipe [certain, probe-confirmed]

On path-based `local` mounts, trashed bytes live at `data/.trash/` **inside** the data dir
(`mount.ts:127-129`), while user folders resolve to `data/<name>` — the same namespace. `validateName`
(`mount/helpers.ts:8-18`) does not reserve the name. Probe against the real `Mount`:

1. `createFolder(root, '.trash')` **succeeds**; the row's storage path resolves to `data/.trash` — the
   real trash dir (`storage.mkdir` silently no-ops because init already created it).
2. Files created inside the user's `.trash` folder land physically **among the trashed bytes**.
3. `deletePath(userTrashFolder)` → `storage.deleteDir('.trash')` **deletes every trashed file's bytes on
   the mount**. `data/.trash` is gone.
4. A subsequent `restorePath` of any previously-trashed item fails permanently
   (`Cannot rename: source path not found`) — rows survive, bytes don't.

Reachable via the drive API (`Drive.createFolder` only rewrites `/`/`\`) and WebDAV MKCOL. A folder
named `.trash` **moved** to the mount root hits the same alias. SOFT-DELETE.md documents the location
but not the reserved-name collision.

**Fix (small):** reject the name `.trash` (case-insensitively — see the Unicode finding) in
`validateName`, which covers create, rename, upload-dedupe and WebDAV in one place; conflict-rename it
in `restorePath` like any sibling collision. Optionally, longer-term, relocate trash to a sibling of
`data/` (like `staging/`) so the reserved name disappears — that needs a per-mount migration for
existing installs, so the name guard is the right first move.

## P2 findings

### Unicode-case aliasing clobbers files on case-insensitive filesystems [certain on APFS, probe-confirmed]

`assertUniqueName` and the v7 unique index both fold with SQLite's ASCII-only `LOWER()` — a deliberate,
documented pairing (`db-config.ts:224-225`). The residual tail: `Ärger.txt` and `ärger.txt` are distinct
to the index but the **same file** on a case-insensitive filesystem (macOS APFS, Windows, some
SMB/NFS-backed data dirs). Probe on APFS, path-based mount:

- both rows created; **one** file on disk;
- the second upload silently replaced the first row's bytes (row A now reads row B's content);
- deleting row B deleted row A's bytes — row A permanently dangles.

This is the same clobber class the v7 index closed for ASCII, surviving for non-ASCII case pairs. Linux
prod (ext4, Docker) is unaffected; self-hosters on macOS/Windows volumes are exposed.

**Fix (small):** in `assertUniqueName`/`getChildByName` for `isPathBased` mounts only, additionally
compare with JS `toLowerCase()` (stricter fold; over-rejecting a legitimate `É`/`é` sibling pair on a
path-based mount is the safe direction, and id-keyed backends keep today's exact semantics). The v7
index stays as the ASCII race net.

### Served file bodies: 24h `public` cache with no validator; consumers must each remember `?v=` [certain]

`serve-file.ts:20` sends `Cache-Control: public, max-age=86400` with **no ETag / Last-Modified**;
`/preview` and `/thumb` do the same (`routes/drive.ts:273,502`). Staleness after an in-place content
change is only prevented where the frontend appends `?v=updatedAt` — which it does for FilePreview,
grid/tile thumbnails and the text-preview route, but **not** for:

- `media-resolver.tsx:86,107` — embedded doc/chat media (`getDrivePreviewUrl`, no `?v=`);
- `attachment-chip.tsx:34` + `use-attachment-meta.ts:19` — attachment thumbnails;
- `getDriveDownloadUrl` (`api.ts:137`) — download actions.

Overwrite one of those files (WebDAV PUT, inline edit of embedded text, future features) and viewers see
day-old bytes. The convention also has to be re-remembered by every future consumer. Separately,
`public` on authenticated bodies is one shared-cache misconfiguration away from a leak — nothing between
Bun and the browser caches today, but the header claims more than intended.

**Fix (small):** emit `ETag: "<paths.hash>"` (with the id+mtime+size fallback WebDAV already uses,
`webdav/xml.ts:90-93`) and honor `If-None-Match` in `serve-file.ts`; switch to
`Cache-Control: private, max-age=0, must-revalidate` or keep the max-age alongside the ETag. This makes
the `?v=` convention a nicety instead of a correctness requirement, reuses the hash column, and matches
the WebDAV GET path. (One same-second revalidation caveat: see the inline-edit note below.)

### Uploads buffer the whole file in RAM; STREAMING_UPLOADS.md overstates streaming [certain]

`@mjackson/multipart-parser` 0.10.1 yields a part only after accumulating its **entire body** as
`content: Uint8Array[]` (verified in the parser source; `MultipartPart.content` is a buffered chunk
array). So `streamFilesToTemp` (`drive/streaming.ts:23-50`) holds each uploaded file fully in memory
before the temp write — the doc's "written to a mount temp file, hashed incrementally" describes the
0.6-era streaming API, not the current one. What *was* fixed (the ~3× copy) is real; memory is now ~1×
file size per concurrent upload.

Bounded today by `maxUploadSizeMB` default **35 MB**, so this is a latent constraint, not an incident:
an admin raising the cap to, say, 2 GB silently converts every concurrent upload into a 2 GB RSS spike.

**Fix:** short term, document the real bound (here and in STREAMING_UPLOADS.md) and treat
`maxUploadSizeMB` as a memory knob. If large uploads become a goal (the doc already defers tus/S3
multipart), swap to a parser that exposes part bodies as streams — `writeTempWithHash` is already
stream-shaped, so only `streamFilesToTemp` changes.

### Chat `data.db`/`comments.db` open-vs-close is ordered, not mutually excluded [likely]

Collab (Yjs) docs are serialized by `CollabRegistry` (delete-before-close + reopen-aware teardown,
`collab-registry.ts:42-57`). Chat `data.db` and every `comments.db` are **not** in that registry: they
open via `Mount.openDatabase` directly (`chat.ts:58`, `comment-index.ts:101`) with no lock, while
`closeCachedDbsUnder` (trash `mount/trash.ts:25`, delete `mount.ts:706`, chat restore
`snapshot.ts:131`) closes them guarded only by call ordering. A `GET /chat` or comment read landing in
the close window builds a fresh `ManagedDatabase` on the **same temp file**: the new open can adopt the
closing DB's live temp as "crash recovery", after which the old close's `cleanupTemp`/journal unlink
pulls the file out from under it — on `local`, subsequent syncs then fail (`uploadFromTemp: tempfile
missing`) until reopen, losing the tail. The onSync row-existence re-check (`document-db.ts:145`)
protects against dead-key resurrection but not against this interleaving.

Not probe-confirmed (needs a precisely-timed interleave), but every ingredient is real and the trigger —
someone posting into a chat while it's being trashed/restored — is plausible.

**Fix (medium):** serialize `openDocumentDb`/`closeDatabase` per `pathId` on the existing
`withPathLock`, or register chat/comments DBs in the same registry pattern as collab docs. A targeted
interleaving test (open during `closeCachedDbsUnder`) belongs next to `mount-mutation-sync.test.ts`.

## P3 findings

- **`S3Storage.size()` returns `NaN`** [certain, MinIO-probe]. Bun's `S3File.size` is a synchronous
  `NaN` (bun-types deliberately comments out the `Promise<number>` typing). No production caller reaches
  it on the S3 path (`StorageBackend.size` is only called for local avatar files), so it's a lying dead
  method: either implement via `await file.stat()` or drop `size` from the interface.
- **No filename length cap** [certain, probe]. A 300-char name on `local` → raw `ENAMETOOLONG` as a 500
  (no row leaked — crash-ordering held). Same name succeeds on `s3`/`local-key`, so a tree that's valid
  on one backend fails to copy to another. Fix: cap at 255 bytes in `validateName`.
- **`ManagedDatabase.close()` aborts if `onSync` throws** — the raw db stays open (fd + working copy)
  because `await this.sync()` (`managed-database.ts:230`) precedes the close with no try/finally.
  Callers catch and log, so it's a bounded leak per failed close; a `finally` around the teardown makes
  close unconditional.
- **Inline-edit conflict detection has 1-second granularity** — `updatedAt` is stored in whole seconds
  (`mode: 'timestamp'`), and `prepareSaveContent` compares equality, so two saves within the same second
  can silently drop one. Narrow, self-inflicted (two editors), worth a note next to the code more than a
  fix; becomes relevant if the hash-ETag from the caching fix is reused for If-Match here (hash has no
  such granularity limit).
- **Container `data.db` rows keep a stale `hash`** — `syncDocumentDbSize` updates `size` only, so the
  WebDAV ETag for container internals never changes. Already recorded in PROPOSAL_DATA_INTEGRITY; noted
  here for completeness.
- **S3 keys aren't normalized for empty segments** [MinIO-probe]: a leading-slash key produces
  `prefix//x` and an opaque `XMinioInvalidObjectName` 500. All current keys are internally constructed
  (UUID-based), so unreachable from user input today — worth a one-line guard next to the `..` check.
- **The one real `computeHash` full-buffer path**: `replaceContainerDataDb` (`snapshot.ts:134`) passes a
  `BunFile` of the whole chat `data.db` to `createFile`, whose `computeHash` does `arrayBuffer()` — the
  entire restored chat DB in memory to hash it. Everything else hashes incrementally
  (`writeTempWithHash`) or over already-in-memory buffers. Route it through the streaming hasher.

## Consistency and clarity notes

The code reads well — flat, direct, invariants written down where they're load-bearing. Remaining
paper-cuts, all cheap:

- **Two policies for bad names**: `Drive.createFolder`/`finalizeUpload` silently rewrite `/`,`\` → `_`;
  `renamePath` → `validateName` → 400 for the same input. Pick one (silent-sanitize at the upload
  boundary is defensible; folder *creation* could just 400 like rename).
- **Two conflict-suffix conventions**: `getUniqueFileName` produces `name#2.txt` (`drive/naming.ts`);
  the v7 dedup migration produces `name (2).txt` (`db-config.ts:264-272`). Cosmetic, but they'll both
  surface to users.
- **Stale seam comment**: `mount.ts:44-49` says internals are used by "mount/*.ts + versioning/
  snapshot.ts", but `drive/history.ts` is a third (constructor-injected, legitimate) peer of
  `mount.db`/the `paths` schema. Add it to the comment.
- **`/request-access`** (`routes/drive.ts:535`) is the one route that skips the Drive facade without an
  inline escape-hatch comment — it's correct (caller has no permission yet, by definition), it just
  needs the same `// Called by / why` breadcrumb the others have.
- **Folder-size caching is undocumented**: the `size = NULL` → lazy recursive recompute-and-cache scheme
  (`toDrivePath` → `computeAndCacheFolderSize`, invalidation via `invalidateSizesFrom`) appears in no
  doc, and it makes GET paths perform writes — surprising for future readers and for any future
  read-replica idea. A paragraph in STORAGE.md fixes it.
- **Hot-path console noise**: `[timing] Mount.upload/download`, `[collab] Synced`,
  `syncDocumentDbSize ...` log unconditionally every 30s per open doc. In prod this buries real signals
  (the queue's failure logs). A `DEBUG`-gated logger (or dropping the per-sync lines) is enough.

## Performance notes

Nothing alarming; SQLite + the index set from migration v1 carry the query load fine. Worth knowing:

- **Folder delete on id-keyed backends is serial**: `deletePath` recurses per child, one storage DELETE
  per file (HTTP round-trip on S3) plus a re-walk of `collectDescendantIds` per level. Hard deletes are
  rare (trash-first; `purgeTrash` is the bulk consumer, off the request path), so acceptable — if it
  ever hurts, batch per-level and push deletes through the existing per-destination semaphore.
- **Recursive ACL/collab walks on trash** (`propagateACLRemovalRecursively`,
  `closeCollabDocumentsRecursively`) query per node; a subtree `WHERE acl IS NOT NULL` CTE would be one
  query. Only matters for very large shared trees.
- **First listing after a deep size-invalidation** recomputes the whole subtree's folder sizes
  synchronously in the read path. Cached afterwards; fine at current scale.
- **SharedDrive double-checks** (owner-side `canRead` inside Drive after the wrapper already gated) cost
  an extra breadcrumb CTE + membership lookup per shared-access call. By design (Drive stays safe when
  called internally); keep.
- `S3Storage.exists()+read` and `exists()+size` pairs cost two round-trips where one GET/stat would do —
  micro, only revisit if S3 latency ever shows up in traces.

## Test-coverage gaps

Coverage of the sync pipeline, trash, versioning and the v7 migration is genuinely strong (the full map
is in the audit working notes; highlights of what's **missing**):

1. **`S3Storage` itself is never instantiated by any test** — the "s3" tests run a LocalStorage-backed
   fake. The MinIO harness this audit used (`scripts/s3-local`) is exactly the missing piece: a small
   `S3_TEST_ENDPOINT`-gated suite covering read/write/range/delete, the `..` guard, and the S3-mount
   trash→restore→permanent-delete round-trip (all probe-verified green today — pin them).
2. **The primary upload route's size/quota rejection** (413/507 on `POST .../file/:parentId`) is untested
   — quota is pinned on copy/import/editor/sheets paths but not the main one.
3. **`ManagedDatabase` migration rollback** (BEGIN/ROLLBACK on a throwing migration) is unexercised.
4. **No systematic SharedDrive gating test.** The union type structurally forces a wrapper to exist, but
   nothing verifies each wrapper's *body* actually checks the right permission (read vs write vs
   owner-only) — today that's pinned piecemeal. An enumeration test (call every SharedDrive method as a
   stranger; expect 403 except the documented ungated ones) turns a whole bug class into a test failure.
5. `Mount.copyPath` marking copied containers `contentDirty` is unasserted; `createFileFromTemp` has no
   dedicated crash-ordering test.

## Strengths — what not to touch

Recording these so future refactors don't "clean up" load-bearing decisions:

- **Crash-ordering discipline**: storage-write-before-DB-insert on create; DB-delete-before-storage on
  delete; every ordering has a comment explaining which failure mode it buys. The long-name probe
  confirmed the invariant holds under real fs errors (no row leaked).
- **The write-behind upload queue** (`upload-queue.ts`): durable rows in the mount's own metadata.db,
  newest-wins supersede, cancel-mid-flight deleting the resurrected object, PUT timeout treated as
  failure-never-ack, full-jitter backoff, self-scheduled retries, per-destination semaphores. This is
  the best-engineered file in scope.
- **The incident-born guards**: `mustExist`/0-byte refusal in `ManagedDatabase.openCold`,
  `isViableRecoveryTemp` collapse rejection, `markDirty` crash recovery, freshest-first
  `readFile`/`stageDataDbSnapshot`. Each maps to a dated data-loss incident and each is test-pinned.
- **The SharedDrive union seam** — compiler-enforced ACL coverage for new Drive methods, verified intact
  by the caller sweep; WebDAV riding the same seam instead of growing its own checks.
- **The v7 dedup migration** (`db-config.ts:191-283`) — live-db dedup that mirrors SQLite's exact fold
  semantics, restore-cohort aware, idempotent. Migration-craft reference for the CRDT work ahead.
- **Version retention** — bucketed keep-newest anchored to snapshot time, with a simulator script.
- **Self-scheduling queues everywhere** (upload, reindex, history-prune cancel) — no global pollers, no
  registries; teardown ordering in `closeAllDatabases` is carefully documented.

## The `hash` column: keep it, use it more

Raised during this audit: is the SHA-256 in `paths.hash` worth keeping? **Yes.**

- It already has a live consumer: the WebDAV ETag (`webdav/xml.ts:90`), where a content-derived
  validator is strictly better than mtime for sync clients.
- It's nearly free where it's computed: hashed incrementally during the streamed temp write on every
  upload/copy/overwrite path (`writeTempWithHash`); the single full-buffer case is the chat-restore path
  above.
- It's the natural fix for the P2 caching finding (HTTP ETag on `serve-file.ts`) — the strongest reason
  to keep it.
- PROPOSAL_DATA_INTEGRITY's sweep and any future dedup/conditional-GET build on it.

The costs to fix are the two warts already listed: stream-hash the chat-restore path, and (per the
proposal) accept or repair the stale hash on managed `data.db` rows.

## Recommendation summary

| # | Finding | Sev | Effort | Status (2026-07-06) |
|---|---------|-----|--------|---------------------|
| 1 | Reserve `.trash` in `validateName` (+ restore conflict-rename) | P1 data-loss | S | SHIPPED — NFKC-folded reservation; restore conflict-renames legacy rows; move guard closes the re-parent vector |
| 2 | JS case-fold uniqueness check on path-based mounts | P2 data-loss (mac/Win self-host) | S | SHIPPED — non-ASCII fallback fold, path-based only; stored-side-only residual (U+212A class) documented in code |
| 3 | `ETag: paths.hash` + `If-None-Match` in `serve-file.ts`; drop bare `public` | P2 correctness | S | SHIPPED — ETag/304 on download+embed, `private, no-cache`; previews/thumbs `private, max-age` + `?v=` centralized in the URL builders; `/p/avatar` stays `public` by design |
| 4 | Serialize doc-DB open/close per pathId (or registry for chat/comments DBs) + interleave test | P2 robustness | M | SHIPPED — open waits on `closingDocumentDbs`; skip-if-contended close/tick snapshots; `peek()`-only reads in snapshot.ts; plus strict GC-assisted close fixing the latent zombie-close→`SQLITE_IOERR_VNODE` reopen bug |
| 5 | Correct STREAMING_UPLOADS.md; treat `maxUploadSizeMB` as a memory knob (streaming parser only if large uploads become a goal) | P2 doc/latent | S (doc) | SHIPPED — doc corrected (incl. mount-full = 507, not 413); parser unchanged by design |
| 6 | `validateName` length cap (255 bytes) | P3 | S | SHIPPED — byte-counted; accepted residual: a conflict-rename on a name within 4 bytes of the cap can still exceed it |
| 7 | Fix-or-drop `S3Storage.size()`; guard empty key segments | P3 | S | SHIPPED — `stat()`-based size (MinIO-pinned); empty-segment guard beside the `..` check |
| 8 | try/finally in `ManagedDatabase.close()` | P3 | S | SHIPPED — teardown unconditional; refined per review: a FAILED close-sync keeps the temp as the crash-recovery marker; failed `open()` also releases its handle |
| 9 | Stream-hash `replaceContainerDataDb` | P3 | S | SHIPPED — `writeTempWithHash` + `createFileFromTemp`, staged before the delete so a failed read leaves data.db intact |
| 10 | MinIO-gated S3 test suite; upload-route quota test; migration-rollback test; SharedDrive gating enumeration | tests | M | SHIPPED — `s3-minio.test.ts` (S3_TEST_ENDPOINT-gated, verified live); 413+507 quota legs; rollback pin; 53-member gating enumeration with exhaustiveness trip-wire |
| 11 | Consistency paper-cuts (name policy, conflict suffixes, seam comment, `/request-access` comment, document folder-size cache, debug-gate hot-path logs) | polish | S | SHIPPED except log-gating — dropped by owner decision (the timing/sync logs stay on in prod); suffixes unified on `name (2).txt`; folder create 400s like rename |

Items 1–3 and 6–9 are each an afternoon or less and remove almost all of the residual base-layer risk;
item 4 is the only one needing design care. Nothing here blocks building on the current base.

_Status recorded 2026-07-06 after the three audit branches merged (`fix/storage-audit-small`,
`fix/docdb-open-close-race`, `test/storage-audit-gaps`). Every fix landed TDD-red-first, passed an
independent review subagent plus a simplify pass, and the caching change was verified against the
running app (200/304/206/overwrite probes). Full suite at merge: 1713 pass / 0 fail._
