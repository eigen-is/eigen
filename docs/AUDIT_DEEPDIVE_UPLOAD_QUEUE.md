# Deep-dive: S3 write-behind upload queue under failure injection (audit #2)

> **Status (2026-07-12):** verified, no production code changed. Two independent chaos passes converged on
> the same two bugs and the same fix. This is one of the two surfaces the audit told the fix-pass **not** to
> sweep ("needs dedicated concurrency testing, not a drive-by") — this is that testing.
>
> **Update (2026-07-13):** findings 1+2, the staging integrity check, and the SYNC.md wording all shipped on
> `fix/upload-queue-orphan-put` — see the ✅ FIXED blockquotes below. Both preserved test files are committed
> in `apps/api/src/test/`, updated to pin the fixed behavior.
>
> **Branch:** `fix/api-audit-2026-07` (HEAD `08bda417`).
> **Original audit:** the 2026-07-11 `apps/api` audit (report removed after all findings shipped — see git history), P1 finding #2, which documents the *mechanism* as an accepted
> risk; "spend more time" item #2). **Also:** `docs/SYNC.md`.
> **Sibling deep-dives:** `AUDIT_DEEPDIVE_CALDAV_TZ.md`, `AUDIT_DEEPDIVE_COLLAB_YJS.md`, `AUDIT_DEEPDIVE_MAILPARSER.md`.

## How to resume this cold

1. Read `AGENTS.md` + `docs/CODE-STANDARDS.md` + `docs/SYNC.md`.
2. Read: `apps/api/src/lib/mount/upload-queue.ts` (the `UploadQueue`; `performUpload`, `enqueueStaged`,
   `cancel`, `reconcile`), `apps/api/src/lib/mount/document-db.ts` (`onSync`/`onClose` staging),
   `apps/api/src/lib/storage/s3-storage.ts` (`S3Storage.write`), `apps/api/src/lib/sync/`,
   `apps/api/src/utils/semaphore.ts`, and the `pending_uploads` table in `metadata.db`.
3. Red regression tests preserved in `docs/superpowers/api-audit-deepdive-tests/`:
   `upload-queue-chaos.test.ts` (drives the full production path against a reorderable fake S3; ~4.7s,
   deterministic 5/5) and `upload-queue-failure-injection.test.ts` (sibling pass, committed at worktree
   `@87362797`; exposes a pre-existing `putTimeoutMs` seam at `upload-queue.ts:51`). Copy into
   `apps/api/src/test/` and run:
   `cd apps/api && bun test --concurrency 1 src/test/upload-queue-chaos.test.ts` (no `--preload` needed).
4. Line numbers below may have drifted — **locate by symbol name**.

## The lifecycle (verified model)

`markDirty` → `onSync` (`document-db.ts`) stages a frozen `VACUUM INTO` copy → durable `pending_uploads`
upsert (newest-wins PK) → a single coalesced drain loop → per-destination `Semaphore(4)` → PUT with a 120s
`Promise.race` timeout → ack-delete staged copy + row, or full-jitter backoff → `reconcile()` replay on
mount open (before the temp sweep).

**What converges correctly (do not re-investigate):** in-process per-key PUTs are strictly serialized (one
awaited drain loop — no queue-side reorder); process kill mid-PUT (client-driven write dies with the
process, incomplete S3 PUT materializes nothing, durable row replays newest staged bytes on boot); crash
between staging and row-insert, and between ack-unlink and row-delete (`reconcile` sweeps orphan stagings,
drops rows with missing stagings, re-PUT is idempotent); supersede while a PUT is in flight (the `inFlight`
guard protects the mid-PUT staged copy). These are covered by the existing `sync-resilience.test.ts` (24
green) — not duplicated.

**The one non-converging window is the timeout orphan**, below.

---

## Finding 1 — orphaned PUT permanently + silently regresses the object — **REAL, worse than documented (P1)**

> **✅ FIXED** (`fix/upload-queue-orphan-put`). `performUpload`'s timeout registers the still-live write
> promise as an in-process orphan (`trackOrphan`); an ack while orphans are unsettled retains the acked
> bytes on the orphan state, and settlement re-stages them through `enqueueStaged` (skipped when a newer
> row is already pending — it supersedes the retained ack). Red→green:
> `upload-queue-failure-injection.test.ts` (finding-1 test) + `upload-queue-chaos.test.ts` (reorder test,
> flipped from characterizing the bug to pinning the repair, including the settlement log line).

**Where:** `upload-queue.ts` `performUpload`, the accepted-risk comment (~:246-250); timeout clears
`inFlight` (~:264-272); ack destroys the last local copy (~:299-302).

**Why the audit's framing undersells it:** the comment says an orphan "can land AFTER the newer PUT and
**briefly** regress the object **until the next sync**." Two things make "briefly" wrong:

1. **Reachability is not exotic.** `S3Storage.write` is a bare `await s3file.write(data)` on Bun's
   `S3Client` — no abort, no cancellation. After the queue's 120s `Promise.race` gives up, the write promise
   stays alive **in-process** and Bun's client keeps actively driving the upload to completion whenever the
   network recovers. So the orphan lands late without any pathological server — this is exactly the Hetzner
   nbg1 "slow → 503" degradation class this pipeline was built for.
2. **The regression is permanent when the doc then closes.** Sequence: write v2 → its PUT stalls past the
   timeout (orphaned) → write v3 → v3's PUT lands and **acks** (row + staged copy deleted) → clean close
   (`onClose` runs `cleanupTemp`, deleting the local working copy) → orphan v2 lands server-side → object
   regresses v3 → v2. At that point there is **no local copy of v3 anywhere** (temp gone, staging gone, row
   gone) and `pendingUploadCount === 0`. Restart + reopen downloads and serves the regressed object. v3 — once
   durably acked on S3 — is silently, permanently lost. "Until the next sync" only saves you if the doc is
   edited again; "edit then walk away" has no next sync.

The download/adopt path has no size/generation check (`isViableRecoveryTemp` only guards temps), so the
regression is adopted silently. Recoverable only within the bucket-versioning window (30-day noncurrent
expiry) **if someone notices** — and nothing notices.

**Control (the benign half the comment relies on):** with **no** newer write, the retry re-PUTs identical
bytes and the late orphan is harmless. So the comment is accurate about the mechanism; it underestimates the
consequence.

**Verdict:** real, reachable, silent, permanent. For a product whose pitch is data ownership this should not
be an acceptable-risk footnote. **The chaos-test suggestion added real value** — it upgraded "accepted,
brief" to proven silent permanent loss.

---

## Finding 2 — orphan landing after cancel/delete resurrects deleted bytes as an undeletable zombie — **REAL (invariant-7 hole)**

> **✅ FIXED** (`fix/upload-queue-orphan-put`). `cancel()` flags the key's unsettled orphans; settlement
> re-issues `storage.delete` (dead-UUID key, idempotent, safe even during teardown). Pinned by the
> finding-2 test + the chaos zombie test.

**Where:** same `performUpload` timeout path; the resurrection guard (~:281-287) requires `putOk`.

**Why:** the celebrated cancel-mid-PUT guard only works while `performUpload` is still awaiting its own PUT.
A **timed-out** PUT has already returned from `performUpload`; when it lands after a permanent delete
(`cancel()` removed the row + staged copy and `storage.delete` ran), it resurrects the deleted object and
nothing ever deletes it again — the key is a dead UUID no queue/cancel path references. Deleted user data
persists remotely forever. Not user-visible, but a retention/GDPR smell.

**Verdict:** real. Same root cause and same fix as finding 1.

---

## The fix (both passes converged on this)

> **✅ SHIPPED** (`fix/upload-queue-orphan-put`), with one shape change: the ack does **not** park the
> durable row — the preserved red tests themselves pin `pendingUploadCount === 0` and an empty
> `staging/` after an ack — so the acked bytes are retained **in memory** on the per-key orphan state
> and re-staged on settlement. Sound for the key-insight reason (an orphan's request dies with the
> process); the residual is a fully-transmitted body the server commits after process death or queue
> teardown, which is logged when detectable and recoverable via bucket versioning. The ship-regardless
> log is folded into settlement (`landed after a newer upload acked` / `landed after cancel`), plus a
> warn at ack-with-unsettled-orphans time.

**Key insight: an orphan cannot outlive the process** — its HTTP request dies with the process — so purely
**in-process** tracking is sound and covers essentially the entire hazard. `performUpload` already holds the
floating `write` promise (~:251).

**Recommended (~30–50 lines, no schema change, no format change):**
- On timeout, don't abandon the `write` promise — register it in an `orphans: Map<key, Promise[]>`.
- While an orphan for a key is unsettled, an **ack parks the row** (retain the staged copy / remember it as
  last-acked; defer the unlink) instead of deleting it.
- On orphan settlement: if the orphan is no longer current, **re-PUT the retained last-acked bytes** (re-entering
  the guarded path) so a correct write lands *after* the orphan; after a `cancel()`, **re-issue `storage.delete`**.
- When a key's orphan count hits 0, drop the retained copy.
- Process death mid-park is safe: boot `reconcile` re-PUTs the newest bytes.

**Ship-regardless (5 lines, do first):** attach `.then/.catch` to the abandoned write that logs loudly when
an orphan settles after supersession/cancel — e.g. `[sync] ORPHANED PUT for <key> landed after supersession;
object may have regressed`. Converts silent corruption into a diagnosable, versioning-recoverable incident.

**Noise / defer:** conditional writes (`If-Match` on ETag) would make stale orphans 412 server-side even
across process death, but S3-compatible support (Hetzner/MinIO) and Bun `S3Client` header control are open
questions — research task, not the first move. Chunking is unrelated.

---

## Lower-severity notes (characterized, not the priority)

- **Semaphore undercount during stalls:** on timeout the destination-semaphore slot is released while the
  orphaned socket keeps running, so real connections to a degraded destination can exceed
  `MAX_CONCURRENT_UPLOADS_PER_DESTINATION` and orphans accumulate (one per 120s per slot) over a long incident.
  Minor; aggravates the incident that creates it. Same fix (orphan tracking) bounds it.
- **No staging integrity check:** a corrupted/truncated staged copy (local disk fault between `VACUUM INTO`
  and PUT) uploads as-is and **acks**, replacing the good object. Fails **loud** on reopen
  (`openDatabase` → `SQLITE_NOTADB`), and importantly does **not** silently wipe/re-create (the 2026-06-08 wipe
  class does not recur here). Recovery is bucket versioning. Borderline: a one-line `isSqliteFile` check
  (already in `mount/helpers.ts`) before PUT would leave the object stale-good instead of corrupt-loud.
  > **✅ FIXED** (`fix/upload-queue-orphan-put`). `performUpload` refuses a staged copy that fails the
  > SQLite magic check (`isSqliteFile`, now exported from `mount/helpers.ts`): the poison row + staging
  > are dropped loudly and the object stays last-good — the loss is bounded to the writes in that copy.
  > Both corruption tests flipped to pin the stale-good outcome.
- **Doc nit:** `docs/SYNC.md` § Concurrency says the orphan "can briefly regress the object until the next
  sync" — update it to say the regression is **permanent if no further sync occurs** and that it also bypasses
  the no-resurrection invariant.
  > **✅ FIXED** (`fix/upload-queue-orphan-put`). § Concurrency now documents the orphan tracking, the
  > permanent-regression consequence it prevents, the invariant-7 re-delete, and the residual; the
  > no-resurrection bullet covers late-landing orphans.
- **Non-issue confirmed:** the abandoned `write` promise's later rejection is absorbed by `Promise.race`'s
  subscription — no unhandled-rejection crash (verified under Bun).

## Suggested landing order

1. The 5-line orphan-settlement **log** (immediate diagnosability).
2. The in-process **orphan tracking** fix (closes findings 1 + 2). Bring `upload-queue-chaos.test.ts` in as
   the red net.
3. Optional: `isSqliteFile` pre-PUT check; SYNC.md wording.
