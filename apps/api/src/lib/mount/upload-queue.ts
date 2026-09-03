import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { and, asc, count, eq, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { StorageBackend } from '../storage';
import { getUploadSemaphore, uploadBackoffMs } from '../sync';
import { isSqliteFile } from './helpers';
import type * as schema from './schema';
import { pendingUploads } from './schema';

type Db = BunSQLiteDatabase<typeof schema>;

// A timed-out PUT whose request is still live in-process (see trackOrphan): how many are unsettled
// for the key, whether a cancel() ran while they were pending, and the last acked bytes retained to
// re-assert over a late-landing orphan.
type OrphanState = { count: number; cancelled: boolean; lastAcked?: Buffer };

// Client-side ceiling on a single PUT. A TCP-black-holed request (nbg1's slow→503 class; a hang is
// adjacent) would otherwise never resolve: the drain loop can't advance past the await, the
// destination semaphore stays held, and backoff never triggers — four such hangs starve every mount
// sharing the limiter. Generous so a genuinely slow-but-live PUT still completes.
const UPLOAD_PUT_TIMEOUT_MS = 120_000;

export type UploadQueueDeps = {
    db: Db; // the mount's metadata.db (owns the pending_uploads table)
    storage: StorageBackend;
    stagingDir: string;
    // Groups uploads that hit the same S3 destination (one provider's rate-limit domain) onto a
    // shared concurrency limiter — infra strings only, no user data.
    destinationKey: string;
    label: string; // for logs (the mount id)
};

// Per-mount write-behind upload queue for S3 mounts: durable rows in metadata.db's pending_uploads +
// frozen staged copies on disk, drained through the per-destination concurrency limiter with
// full-jitter backoff. Self-scheduling — a failed upload backs off and re-drives itself via
// setTimeout, so there is no process-global sweep or registry. Timed-out PUTs are tracked as
// in-process orphans and repaired when they settle (trackOrphan). Producers (sync/close/create,
// snapshots) stage a copy then call enqueueStaged; delete/restore call cancel; mount init calls
// reconcile; shutdown calls drain({flushNow,deadline}) then close.
export class UploadQueue {
    private readonly db: Db;
    private readonly storage: StorageBackend;
    private readonly stagingDir: string;
    private readonly destinationKey: string;
    private readonly label: string;

    // inFlight: keys whose staged copy is mid-PUT, so enqueueStaged won't delete it from under the
    // worker. draining: one drain loop at a time (concurrent calls coalesce). deadline: read each loop
    // iteration so a flush can bound an already-running loop. closing: one-way teardown gate.
    // orphans: timed-out PUTs that may still land server-side later (see trackOrphan) — in-process
    // only, which is sound because an orphan's request (barring a fully-transmitted body the server
    // commits late) dies with the process.
    private readonly inFlight = new Set<string>();
    private readonly orphans = new Map<string, OrphanState>();
    private draining: Promise<void> | null = null;
    private deadline: number | null = null;
    private closing = false;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Per-PUT client-side deadline (see UPLOAD_PUT_TIMEOUT_MS). A field so tests can shrink it.
    private putTimeoutMs = UPLOAD_PUT_TIMEOUT_MS;

    constructor(deps: UploadQueueDeps) {
        this.db = deps.db;
        this.storage = deps.storage;
        this.stagingDir = deps.stagingDir;
        this.destinationKey = deps.destinationKey;
        this.label = deps.label;
    }

    newStagingPath(): string {
        return path.join(this.stagingDir, `${randomUUID()}.db`);
    }

    // Resolve a stored stagingPath to an absolute path. New rows store a basename (relocation-safe);
    // legacy rows may hold an absolute path — join basenames against the current stagingDir so a
    // moved/restored data dir still finds the staged copy, and pass any absolute value through.
    private resolveStagingPath(stored: string): string {
        return path.isAbsolute(stored) ? stored : path.join(this.stagingDir, stored);
    }

    // The full on-disk path of the pending staged copy for storageKey, or null if none. External
    // callers (Mount recovery/copy) fs-check the returned path, so it must be absolute.
    getPendingStagingPath(storageKey: string): string | null {
        const row = this.db
            .select({ stagingPath: pendingUploads.stagingPath })
            .from(pendingUploads)
            .where(eq(pendingUploads.storageKey, storageKey))
            .get();
        return row ? this.resolveStagingPath(row.stagingPath) : null;
    }

    // Queue depth (observability, §9).
    get pendingCount(): number {
        const row = this.db.select({ c: count() }).from(pendingUploads).get();
        return row?.c ?? 0;
    }

    // Record a ready staged copy as the pending upload for storageKey and kick the drain. Durable:
    // the row is written synchronously before this returns. Newest staging wins (PK upsert); a
    // superseded staged copy is deleted unless it's mid-PUT (the worker deletes that one on completion).
    enqueueStaged(storageKey: string, stagingPath: string): void {
        // Store only the basename so a data-dir relocation (host migration / restore-from-backup)
        // still resolves the staged copy against the current stagingDir (schema.ts "moves with the
        // Home"). An absolute path would miss on the new host and reconcile would drop the row.
        const stored = path.basename(stagingPath);
        const now = Date.now();
        const prevStaging = this.getPendingStagingPath(storageKey);
        this.db
            .insert(pendingUploads)
            .values({ storageKey, stagingPath: stored, attempt: 0, enqueuedAt: now, nextAttemptAt: now })
            .onConflictDoUpdate({
                target: pendingUploads.storageKey,
                set: { stagingPath: stored, attempt: 0, enqueuedAt: now, nextAttemptAt: now },
            })
            .run();
        if (prevStaging && prevStaging !== stagingPath && !this.inFlight.has(storageKey)) {
            void bestEffortUnlink(prevStaging);
        }
        this.drain().catch((err) => console.error(`[sync] drain failed for ${this.label}:`, err));
    }

    // Cancel any pending upload for storageKey and delete its staged copy (idempotent). Called by
    // permanent delete + chat-restore replace so a queued PUT can't resurrect a removed object
    // (invariant 7). performUpload re-checks the row immediately before/after its PUT, so a cancel
    // that lands mid-flight still aborts the upload and removes any object the PUT resurrected.
    async cancel(storageKey: string): Promise<void> {
        const orphan = this.orphans.get(storageKey);
        if (orphan) {
            // A timed-out PUT is still on the wire and may resurrect the object after the delete
            // that follows this cancel — flag it so orphan settlement re-issues the delete.
            orphan.cancelled = true;
            orphan.lastAcked = undefined;
        }
        const staging = this.getPendingStagingPath(storageKey);
        this.db.delete(pendingUploads).where(eq(pendingUploads.storageKey, storageKey)).run();
        if (staging) await bestEffortUnlink(staging);
    }

    // On mount open, re-enqueue every persisted pending upload (resume a restart / home-reopen) and
    // sweep orphaned staged copies (a crash between staging and the row insert). Must run before the
    // mount's tmp sweep so a recovered staged copy can't be purged.
    reconcile(): void {
        const rows = this.db.select().from(pendingUploads).all();
        const referenced = new Set<string>();
        for (const row of rows) {
            const staging = this.resolveStagingPath(row.stagingPath);
            if (fs.existsSync(staging)) {
                referenced.add(path.basename(staging));
            } else {
                // staged copy gone (crash between deleting it and deleting the row on ack) — drop the row
                this.db.delete(pendingUploads).where(eq(pendingUploads.storageKey, row.storageKey)).run();
            }
        }
        // Best-effort: a readdir/unlink fault leaves orphans on disk but must not block the queue start.
        try {
            for (const entry of fs.readdirSync(this.stagingDir)) {
                if (!referenced.has(entry)) fs.unlinkSync(path.join(this.stagingDir, entry));
            }
        } catch {}
        if (referenced.size > 0) {
            this.drain().catch((err) => console.error(`[sync] drain failed for ${this.label}:`, err));
        }
    }

    // Stop the queue (mount teardown): no more drains, cancel the pending retry. Leftover rows replay
    // on the next mount open. For a graceful shutdown, call drain({flushNow,deadline}) first.
    close(): void {
        this.closing = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    // Drain due pending uploads through the destination's concurrency limiter. One loop at a time;
    // concurrent calls coalesce. A failed PUT backs its row off into the future, so the due-selection
    // drops it and the loop never spins on a dead backend. flushNow resets every backoff so the
    // shutdown flush + tests get one immediate attempt at each; deadline bounds the flush.
    async drain(opts: { flushNow?: boolean; deadline?: number } = {}): Promise<void> {
        if (opts.deadline !== undefined) this.deadline = opts.deadline;
        if (opts.flushNow) this.db.update(pendingUploads).set({ nextAttemptAt: Date.now() }).run();
        if (this.draining) return this.draining;
        this.draining = this.runDrainLoop().finally(() => {
            this.draining = null;
            this.deadline = null;
        });
        return this.draining;
    }

    private async runDrainLoop(): Promise<void> {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        const semaphore = getUploadSemaphore(this.destinationKey);
        while (!this.closing) {
            if (this.deadline !== null && Date.now() >= this.deadline) break;
            const row = this.db
                .select()
                .from(pendingUploads)
                .where(lte(pendingUploads.nextAttemptAt, Date.now()))
                .orderBy(asc(pendingUploads.enqueuedAt))
                .limit(1)
                .get();
            if (!row) break;
            await semaphore.run(() => this.performUpload(row.storageKey, row.stagingPath, row.attempt));
        }
        if (this.closing) return;
        // Re-drive backed-off rows exactly when the earliest becomes due — our own timer, no sweep.
        const earliest = this.db
            .select({ nextAttemptAt: pendingUploads.nextAttemptAt })
            .from(pendingUploads)
            .orderBy(asc(pendingUploads.nextAttemptAt))
            .limit(1)
            .get();
        if (earliest) this.scheduleRetry(Math.max(0, earliest.nextAttemptAt - Date.now()));
    }

    private scheduleRetry(delayMs: number): void {
        if (this.closing) return;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.drain().catch((err) => console.error(`[sync] retry drain failed for ${this.label}:`, err));
        }, delayMs);
    }

    // PUT one staged copy to its storage key. Re-checks the row immediately before the PUT so a
    // cancel/restore/supersede that landed since dequeue aborts it. On success: clear the row iff
    // still ours, delete the staged copy, and — if the row was cancelled mid-PUT — delete the object
    // the PUT just resurrected. On failure: back off and leave both for a later retry. Never throws.
    private async performUpload(storageKey: string, storedStaging: string, attempt: number): Promise<void> {
        if (this.closing) return;
        // storedStaging is the row's stagingPath column (a basename for new rows, absolute for legacy);
        // resolve it for filesystem ops but key DB writes off the stored value it was matched on.
        const stagingPath = this.resolveStagingPath(storedStaging);
        const current = this.getPendingStagingPath(storageKey);
        if (current !== stagingPath) {
            // superseded by a newer enqueue, or cancelled — our staged copy is no longer current
            await bestEffortUnlink(stagingPath);
            return;
        }
        const file = Bun.file(stagingPath);
        if (!(await file.exists())) {
            // staged copy vanished mid-flight (cancelled, or superseded before inFlight was set);
            // the keyed delete only drops a row still pointing at this staging
            if (!this.closing) this.deletePendingRow(storageKey, storedStaging);
            return;
        }
        if (!isSqliteFile(stagingPath)) {
            // Poison staged copy (disk fault after VACUUM INTO): uploading it would ack garbage
            // over the good object. Drop it — the object stays last-good, the loss is bounded to
            // the writes in this copy, and the next dirty sync re-stages from the live temp.
            // When tearing down, leave both for boot replay to re-check and drop.
            console.error(`[sync] dropping corrupt staged copy for ${storageKey} (${stagingPath})`);
            if (this.closing) return;
            this.deletePendingRow(storageKey, storedStaging);
            await bestEffortUnlink(stagingPath);
            return;
        }

        // Orphans present when this PUT is issued: if they all settle while it is in flight, the
        // commit order against a landed one is unknown (see the ack branch below).
        const orphansAtStart = this.orphans.get(storageKey);
        this.inFlight.add(storageKey);
        let putOk = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const start = Bun.nanoseconds();
            // StorageBackend.write takes no abort signal, so bound it with Promise.race; a timeout is
            // treated exactly like a PUT failure (putOk stays false → backoff below), never as an ack.
            // The timed-out request stays live in-process and can land server-side at any later time,
            // so the timeout also registers it as an orphan: an ack or cancel of this key while it is
            // unsettled is re-asserted once it settles (see trackOrphan), instead of being silently
            // regressed or resurrected.
            const write = this.storage.write(storageKey, file);
            await Promise.race([
                write,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => {
                        const orphan = this.trackOrphan(storageKey, write);
                        // A cancel that landed during this PUT found no orphan to flag (we register
                        // only now, at timeout). Within an in-flight upload a vanished row can only
                        // mean cancel — acks are serialized per queue and a supersede keeps the
                        // row — so flag it here.
                        if (!this.closing && this.getPendingStagingPath(storageKey) === null) {
                            orphan.cancelled = true;
                        }
                        reject(new Error(`PUT exceeded ${this.putTimeoutMs}ms`));
                    }, this.putTimeoutMs);
                }),
            ]);
            putOk = true;
            const ms = (Bun.nanoseconds() - start) / 1_000_000;
            console.log(`[timing] Mount.upload.queued ${storageKey} ${(file.size / 1024) | 0}KB ${ms.toFixed(1)}ms`);
        } catch (err) {
            console.error(
                `[sync] upload failed for ${storageKey} (attempt ${attempt + 1}):`,
                err instanceof Error ? err.message : err,
            );
        } finally {
            if (timeout) clearTimeout(timeout);
            this.inFlight.delete(storageKey);
        }

        // Tearing down — leave the row + staged copy untouched for boot replay (metadata.db may be
        // closing, so skip all DB access).
        if (this.closing) return;

        const after = this.getPendingStagingPath(storageKey);
        const stillCurrent = after === stagingPath;

        if (putOk && after === null) {
            // The row was CANCELLED (permanent delete / chat restore) while our PUT was in flight, so
            // the PUT just resurrected a deleted object. Delete it (invariant 7). The key is a dead
            // UUID — never reused — so this can't clobber a fresh object. (A row that merely changed
            // stagingPath was superseded, not cancelled: leave it, the newer staging overwrites it.)
            await this.storage.delete(storageKey).catch(() => {});
        }
        if (!putOk && stillCurrent) {
            // Failed and still the current pending row → back off for a retry; keep the staged copy.
            const next = attempt + 1;
            this.db
                .update(pendingUploads)
                .set({ attempt: next, nextAttemptAt: Date.now() + uploadBackoffMs(next) })
                .where(eq(pendingUploads.storageKey, storageKey))
                .run();
            return;
        }
        // Acked (still ours) → clear the row. Every remaining case drops the now-unneeded staged copy.
        if (putOk && stillCurrent) {
            if (orphansAtStart && !this.orphans.has(storageKey)) {
                // Every orphan for this key settled while our PUT was in flight — a landed one may
                // have committed server-side after ours (settlement order says nothing about commit
                // order), so this ack isn't trustworthy. Keep the row + staged copy and re-PUT
                // immediately: the retry is issued after the orphan's commit, so it lands after it.
                console.warn(`[sync] orphan settled during PUT of ${storageKey} — re-uploading`);
                this.db
                    .update(pendingUploads)
                    .set({ nextAttemptAt: Date.now() })
                    .where(eq(pendingUploads.storageKey, storageKey))
                    .run();
                return;
            }
            this.db.delete(pendingUploads).where(eq(pendingUploads.storageKey, storageKey)).run();
            const orphan = this.orphans.get(storageKey);
            if (orphan) {
                // A timed-out PUT for this key is still on the wire and could land over this ack.
                // Retain the acked bytes so orphan settlement can re-assert them.
                try {
                    orphan.lastAcked = fs.readFileSync(stagingPath);
                    console.warn(
                        `[sync] acked ${storageKey} with ${orphan.count} unsettled timed-out PUT(s) — retaining acked bytes`,
                    );
                } catch (err) {
                    console.error(`[sync] failed to retain acked bytes for ${storageKey}:`, err);
                }
            }
        }
        await bestEffortUnlink(stagingPath);
    }

    // Drop the pending row only while it still points at THIS staged copy, so a newer enqueue survives.
    private deletePendingRow(storageKey: string, storedStaging: string): void {
        this.db
            .delete(pendingUploads)
            .where(and(eq(pendingUploads.storageKey, storageKey), eq(pendingUploads.stagingPath, storedStaging)))
            .run();
    }

    // A PUT that outlived the client-side ceiling is an ORPHAN: its request keeps running and can
    // land server-side after a newer PUT for the key acked (regressing the object — permanently if
    // nothing syncs again) or after a cancel() (resurrecting a deleted object). Track it until it
    // settles so orphanSettled can repair both.
    private trackOrphan(storageKey: string, write: Promise<number>): OrphanState {
        let orphan = this.orphans.get(storageKey);
        if (!orphan) {
            orphan = { count: 0, cancelled: false };
            this.orphans.set(storageKey, orphan);
        }
        orphan.count++;
        write.then(
            () => this.orphanSettled(storageKey, orphan, true),
            () => this.orphanSettled(storageKey, orphan, false),
        );
        return orphan;
    }

    private orphanSettled(storageKey: string, orphan: OrphanState, landed: boolean): void {
        orphan.count--;
        if (orphan.count > 0) return;
        this.orphans.delete(storageKey);
        if (orphan.cancelled) {
            // The key was permanently deleted while this PUT was on the wire; if it landed it
            // resurrected the object — delete it again (invariant 7). The key is a dead UUID,
            // never reused, so this can't clobber a fresh object.
            if (landed) {
                console.error(`[sync] orphaned PUT for ${storageKey} landed after cancel — re-deleting the object`);
            }
            void this.storage.delete(storageKey).catch(() => {});
            return;
        }
        // No ack was retained: either nothing was acked over the orphans (a landed orphan
        // re-asserted its own bytes and any pending row re-drives itself), or an ack is mid-flight
        // (its performUpload re-PUTs when it finds the orphans gone — see the ack branch). Log
        // landed settles so a >ceiling PUT that eventually landed stays diagnosable.
        if (!orphan.lastAcked) {
            if (landed) {
                console.warn(
                    `[sync] orphaned PUT for ${storageKey} landed with no retained ack — a pending re-upload (if any) supersedes it`,
                );
            }
            return;
        }
        if (landed) {
            console.error(
                `[sync] orphaned PUT for ${storageKey} landed after a newer upload acked — re-uploading the acked bytes`,
            );
        }
        if (this.closing) {
            console.error(`[sync] cannot re-upload ${storageKey}: queue closed — check the object against versioning`);
            return;
        }
        // A pending row holds newer bytes than the retained ack — it lands after the orphan anyway.
        if (this.getPendingStagingPath(storageKey) !== null) return;
        // Re-enter the guarded path so a correct write lands strictly after the orphan. Re-upload
        // even when the orphan rejected: a lost response can hide a server-side commit, and the
        // re-PUT is idempotent.
        try {
            const stagingPath = this.newStagingPath();
            fs.writeFileSync(stagingPath, orphan.lastAcked);
            this.enqueueStaged(storageKey, stagingPath);
        } catch (err) {
            console.error(`[sync] failed to re-stage acked bytes for ${storageKey}:`, err);
        }
    }
}

// Best-effort delete of a local file (a staged copy) — already-gone is fine.
async function bestEffortUnlink(fullPath: string): Promise<void> {
    try {
        const file = Bun.file(fullPath);
        if (await file.exists()) await file.delete();
    } catch {}
}
