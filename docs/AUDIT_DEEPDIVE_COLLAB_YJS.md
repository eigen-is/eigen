# Deep-dive: collab/Yjs persistence + snapshot lifecycle, and WS maxPayloadLength (audit #1, #5)

> **Status (2026-07-12):** verified, no production code changed. Two independent passes converged. This is
> the surface the audit called "the highest-consequence, hardest-to-test in the system." **Result: the exact
> Yjs core the audit feared is sound; the real data-loss bug is one layer up, in the chat restore path.**
>
> **Branch:** `fix/api-audit-2026-07` (HEAD `08bda417`).
> **Original audit:** the 2026-07-11 `apps/api` audit (report removed after all findings shipped — see git history), "spend more time" item #1; finding #5.
> **Sibling deep-dives:** `AUDIT_DEEPDIVE_CALDAV_TZ.md`, `AUDIT_DEEPDIVE_UPLOAD_QUEUE.md`, `AUDIT_DEEPDIVE_MAILPARSER.md`.

## How to resume this cold

1. Read `AGENTS.md` + `docs/CODE-STANDARDS.md`. Yjs gotcha: server-side `instanceof` on Yjs types after
   `Y.applyUpdate` fails — detect an AbstractType via `_start != null`. eigen.is is LIVE: Yjs roots / DB
   schemas are FROZEN — none of the fixes below need a migration.
2. Read: `apps/api/src/lib/collab/collabDocument.ts` (`DbProvider.storeUpdate`/`createSnapshot`,
   `applySnapshotState`), `apps/api/src/lib/collab/yjs-loader.ts`, `apps/api/src/lib/mount/document-db.ts`
   (`onSync`/`onClose`, `closingDocumentDbs`), `apps/api/src/lib/versioning/snapshot.ts`
   (`replaceContainerDataDb`, `takeSnapshot`) + `restore.ts`, `apps/api/src/lib/drive/collab-registry.ts`,
   `apps/api/src/lib/chat/chat.ts` (`ChatRoom.init`/`create`), `packages/lib/src/core/collab/yjs-utils.ts`
   (`restoreYjsDoc`), and `apps/api/src/app.ts` (root `websocket` config).
3. Red/green regression tests preserved in `docs/superpowers/api-audit-deepdive-tests/`:
   `collab-restore-race.test.ts` (T7 = the chat-wipe P1, RED), `collab-lifecycle-race.test.ts` (7 green net,
   committed at worktree `@7cfcdf86`), `collab-ws-payload.test.ts` (2 green + 1 red for #5). Copy into
   `apps/api/src/test/` and run:
   `cd apps/api && bun test --preload ./src/test/preload.ts --concurrency 1 src/test/collab-restore-race.test.ts`.
4. Line numbers below may have drifted — **locate by symbol name**.

## The audited core is SOUND (checked, not findings)

Both passes attacked `createSnapshot`'s transaction × `onSync` staging × `applySnapshotState` with
adversarial interleavings (65+ race iterations total, microtask/macrotask jitter). Every suspected window is
closed by a specific mechanism — do not re-investigate these:

- `DbProvider.storeUpdate`/`createSnapshot` are **fully synchronous** (bun:sqlite) inside one JS turn —
  encode → insert-snapshot → delete-updates cannot interleave with a new update. The `'update'` handler is
  registered **before** the broadcast handler, so `data.db(snapshot+updates) ⊇ live doc state` at all times;
  update rows are deleted only inside the transaction that inserts the superseding snapshot.
- Snapshot/close deadlocks are closed by `tryWithPathLock` skip-if-contended + `peek()` (never awaiting the
  factory); pinned by `docdb-open-close-race.test.ts` at the Mount layer and now by the full collab layer.
- Restore vs close: registry delete-before-destruct + re-registration guard + `Mount.closingDocumentDbs`
  serialize correctly. The audit-suspected `wasOpen` TOCTOU in `restore.ts` is **cleared** —
  `hasCollabDocument`/`getCollabDocument` run in one synchronous block.
- `onSync` captures the `total_changes()` watermark **before** awaiting staging, so a write landing mid-stage
  stays dirty (re-staged next tick, never dropped). No tail-loss path.

**Verdict on the audit's item #1:** the instinct ("data loss lives here") was right; the **specific suspects
were wrong**. The real wipe is in the chat byte-overwrite restore path, below.

---

## NEW P1 — chat restore racing a message post wipes the chat (not in audit)

> **✅ FIXED — Unit 3** (`fix/api-audit-2026-07`). `ChatRoom.init` takes the container path lock (thin
> `Drive.withPathLock` delegation) around the missing-data.db branch, re-checking existence under the
> lock; T7 committed as `apps/api/src/test/collab-restore-race.test.ts` (trimmed to the chat-restore
> net). Belt-and-braces retry in `replaceContainerDataDb` deliberately omitted — after the lock fix no
> unlocked `data.db` creator remains.

**Where:** `versioning/snapshot.ts` `replaceContainerDataDb` (~:145) holds the container path lock while
doing close → `deletePath(data.db)` → `createFileFromTemp('data.db', …)`. But `chat/chat.ts` `ChatRoom.init`
(~:44-49) auto-creates a missing `data.db` **without taking the container lock**, and `Drive.getChat` builds a
fresh `ChatRoom` on every request.

**Failure scenario (deterministic — reproduced on iteration 0 in both runs):** a message posted in the
delete→recreate window finds `data.db` missing, provisions a fresh **empty** one; restore's
`createFileFromTemp` then throws `assertUniqueName` ("A file or folder named 'data.db' already exists"), the
restore returns 4xx, and the chat continues on the empty db, which syncs to storage. Observed: restore errors
and the message history is reduced to just the messages posted during the race — earlier versions gone.

**Blast radius / mitigations:** chat only — the four Yjs doc types are safe because their restore preserves
`data.db` identity (Yjs surgery, not byte-overwrite). The pre-restore snapshot (taken before the wipe) holds
the lost messages in `versions/`, and re-running the restore self-heals — but the user-visible outcome is an
errored restore plus an emptied chat.

**Fix direction:** in `ChatRoom.init`, take `mount.withPathLock(containerId)` around the "data.db missing →
`ChatRoom.create`" branch and re-check existence under the lock (rare cold path — no hot-path cost). This
serializes the auto-create against `replaceContainerDataDb`. Belt-and-braces: in `replaceContainerDataDb`, if
`createFileFromTemp` hits a duplicate `data.db`, delete the usurper and retry once (restore discards
concurrent posts anyway). Then commit `collab-restore-race.test.ts` (T7) as the net. No frozen-format impact.

**Test:** `collab-restore-race.test.ts` › **T7** "chat restore racing message posts — one data.db, coherent
message set" (RED until fixed).

---

## #5 — WebSocket maxPayloadLength — **ALREADY FIXED @08bda417; deep-dive confirms it's correct, direction corrected**

> **✅ NET COMMITTED — P3 cleanup** (`chore/collab-p3-cleanup`). `collab-ws-payload.test.ts` ported to
> `apps/api/src/test/` as the regression net; all 3 cases green against the landed 128 MB config.

**Status:** Unit 2 set `maxPayloadLength: 128 * 1024 * 1024` on the root `websocket` config in `app.ts`. (The
verification worktrees were branched off a **pre-Unit-2** commit, so they observed it unset and "found" it —
it is landed.) Both passes independently validated the fix:

- Confirmed empirically on Bun 1.3.14: default is **16 MB for received frames** (15 MB delivered, 17 MB kills
  the socket with an abnormal **1006**, not a clean 1009). `perMessageDeflate` does not help — the limit is on
  the **decoded** size.
- **The audit's causal story is backwards.** The ~48 MB frame is the server's syncStep2 reply (server→client),
  which the cap does **not** govern (48 MB s2c delivered fine under default config). The cap bites
  **client→server**: sheets' `flushSnapshot` (`apps/sheets/src/components/sheets/hooks/use-sheet.ts` ~:25-43)
  puts the whole workbook JSON in **one** update = one frame on tab close/unmount. Measured: 2.9 MB @ 26k
  cells, **16.7 MB @ 150k cells (already over the 16 MB default)**, 44.5 MB @ 400k cells. Also bites a giant
  single paste and a long-offline client's syncStep2 diff.
- **Consequence when it fired (pre-fix):** the unload-time flush is silently lost (no reconnect on unload).
  Data usually survived because the ops-clear rode in the same lost update (server keeps `snapshot_old` + full
  ops, client replays on open) — but `state.snapshot` then never consolidated for >16 MB sheets and the ops
  array grew unbounded (ever-slower opens). Hard-loss case: a client re-syncing an offline-accumulated >16 MB
  diff entered a reconnect kill-loop and those edits died with the tab.
- **128 MB is the right value** (≈ 2.6–2.9× the documented ~48 MB worst case; the audit's 64 MB was thin).
  Config-only, no frozen-format impact. **Chunking is noise** at current scale (revisit only past ~1M cells).
  The audit's claim that #5 is "the observable tip of this [persistence] iceberg" is **noise** — it's an
  unrelated transport receive-cap.
- **Trade-off to note:** any authed reader can now send 128 MB frames (write-permission is checked only after
  full receipt, `collabDocument.ts` ~:347-350) — bounded memory cost, accepted.

**Test:** `collab-ws-payload.test.ts` (the RED-by-design one goes green with the landed fix).

---

## New minor findings (all P3 — no new data-loss windows)

> **✅ FIXED — P3 cleanup** (`chore/collab-p3-cleanup`, 2026-07-13).
> **#1** restore now generates a unique per-invocation temp id (`randomUUID`) via
> `downloadToTemp(pathId, tempId)`; the live-working-copy guard moved to `tempId`. Pinned by
> `versioning.test.ts` › "concurrent restores of the same snapshot" (RED pre-fix: `no such table:
> doc_snapshots` on the first concurrent pair).
> **#2** accepted for the BLOCKING path only: `snapshotContainerDataDb` (manual save, pre-restore
> snapshot) now waits out an in-flight close of the container's data.db before copying. The
> tick/close path must NOT wait — a close-time snapshot runs inside the very close that registered
> the `closingDocumentDbs` slot, so awaiting it self-wedges (caught red-handed by
> `docdb-open-close-race.test.ts` (iii) during this fix). Its torn-copy sub-case is now acknowledged
> in the `takeSnapshot` comment instead.
> **#3 DECLINED — a throw is actively harmful, not nice-to-have:** `doc.emit('update')` runs inside
> yjs's transaction-cleanup `finally`; a throwing handler leaves `doc._transactionCleanups` stale,
> after which cleanup never runs again for that doc — every later update goes unpersisted AND
> unbroadcast, silently, until reopen (verified against yjs 13 source). The log-only catches are
> correct; both now carry WHY comments in `DbProvider` so a future fail-loud pass doesn't escalate.
> **#4** comment corrected: restore.ts deliberately holds no lock; the surgery is synchronous.
> **#5** remains a documented product note (retention behavior), unchanged.
> **#6** `replayYjsState` returns a `blobsSkipped` count; `readYjsStateFromFile` (restore path) fails
> loud with `ApiError(422)` before any state touches the live doc — live loads (`loadYjsState`) stay
> lenient, since a throw there would make a doc with one corrupt row unopenable and unexportable.
> Pinned by `versioning.test.ts` › "restore from a corrupt snapshot fails 422" (RED pre-fix: 200 +
> half-empty doc).

1. **Concurrent restores of one container share one temp path** (`restore.ts` uses `mount.getTempPath(target.id)`):
   R1's `cleanupTemp` can delete under R2 → `readYjsStateFromFile` (create-allowed open) materialises an empty
   db and throws `no such table` → 500 + a stray empty temp. Aborts cleanly, never silent partial state.
   **Minimal fix:** a unique temp id per restore invocation (`randomUUID`, the `replaceContainerDataDb` pattern).
2. **Version snapshot racing a close can copy stale (theoretically torn) bytes:** registry close never takes the
   container lock, so `takeSnapshot`'s `peek()` finds nothing mid-close and copies storage/staged bytes
   predating the close's final sync; on local backends the file copy can overlap the checkpoint. Bounded: a
   degraded `versions/<ts>.db` **entry** — live data.db unaffected; corruption surfaces loudly at restore time.
   Only the torn-copy sub-case is unacknowledged in comments. Optional fix: await `mount.closingDocumentDbs`
   before the storage fallback.
3. **`DbProvider.storeUpdate`/`createSnapshot` swallow SQLite errors** (log-only): a failed insert with no
   later successful update row is the one hole where an acknowledged edit lives only in memory. Self-heals on
   any later update (snapshots capture full state). Escalating to a throw would be nice-to-have, not urgent.
4. **Stale comment:** `collabDocument.ts` `applySnapshotState` says "Caller (versioning/restore.ts) holds the
   container lock"; `restore.ts` explicitly never holds a lock across steps. Harmless today (tests show the lock
   isn't needed for the Yjs surgery); fix the one-line comment so a future editor doesn't rely on it.
5. **Product note, not a bug:** any post-save snapshot (incl. close-time auto-snapshots) prunes older same-hour
   versions — a manual save can vanish within the hour. That is `DEFAULT_RETENTION`'s documented
   newest-per-hour-bucket behavior; restore's download-before-prune ordering correctly protects in-flight restores.
6. **Endorsement (existing proposal):** `replayYjsState`'s silent corrupt-blob skip (PROPOSAL_DATA_INTEGRITY
   seam F) is the one thing that could turn narrow corruption into a silently half-empty restore — fail loud
   (`ApiError(422)`) instead. Worth doing.

## Suggested landing order

1. **Chat-restore P1** — path-lock `ChatRoom.init`'s auto-create branch; commit T7 as the net. This is the
   only data-loss item on this surface.
2. **#5** is already landed — just port `collab-ws-payload.test.ts` as the regression net if desired.
3. P3s (unique temp id, comment fix, corrupt-blob fail-loud) are opportunistic — do while in the file.
