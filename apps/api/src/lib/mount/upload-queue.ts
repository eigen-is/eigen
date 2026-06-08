import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { and, asc, count, eq, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { StorageBackend } from '../storage';
import { getUploadSemaphore, uploadBackoffMs } from '../sync';
import type * as schema from './schema';
import { pendingUploads } from './schema';

type Db = BunSQLiteDatabase<typeof schema>;

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
// setTimeout, so there is no process-global sweep or registry. Producers (sync/close/create,
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
    private readonly inFlight = new Set<string>();
    private draining: Promise<void> | null = null;
    private deadline: number | null = null;
    private closing = false;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

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

    getPendingStagingPath(storageKey: string): string | null {
        const row = this.db
            .select({ stagingPath: pendingUploads.stagingPath })
            .from(pendingUploads)
            .where(eq(pendingUploads.storageKey, storageKey))
            .get();
        return row?.stagingPath ?? null;
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
        const now = Date.now();
        const prevStaging = this.getPendingStagingPath(storageKey);
        this.db
            .insert(pendingUploads)
            .values({ storageKey, stagingPath, attempt: 0, enqueuedAt: now, nextAttemptAt: now })
            .onConflictDoUpdate({
                target: pendingUploads.storageKey,
                set: { stagingPath, attempt: 0, enqueuedAt: now, nextAttemptAt: now },
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
            if (fs.existsSync(row.stagingPath)) {
                referenced.add(path.basename(row.stagingPath));
            } else {
                // staged copy gone (crash between deleting it and deleting the row on ack) — drop the row
                this.db.delete(pendingUploads).where(eq(pendingUploads.storageKey, row.storageKey)).run();
            }
        }
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
    private async performUpload(storageKey: string, stagingPath: string, attempt: number): Promise<void> {
        if (this.closing) return;
        const current = this.getPendingStagingPath(storageKey);
        if (current !== stagingPath) {
            // superseded by a newer enqueue, or cancelled — our staged copy is no longer current
            await bestEffortUnlink(stagingPath);
            return;
        }
        const file = Bun.file(stagingPath);
        if (!(await file.exists())) {
            // staged copy vanished (cancelled mid-flight) — drop the orphan row
            if (!this.closing) {
                this.db
                    .delete(pendingUploads)
                    .where(and(eq(pendingUploads.storageKey, storageKey), eq(pendingUploads.stagingPath, stagingPath)))
                    .run();
            }
            return;
        }

        this.inFlight.add(storageKey);
        let putOk = false;
        try {
            const start = Bun.nanoseconds();
            await this.storage.write(storageKey, file);
            putOk = true;
            const ms = (Bun.nanoseconds() - start) / 1_000_000;
            console.log(`[timing] Mount.upload ${storageKey} ${(file.size / 1024) | 0}KB ${ms.toFixed(1)}ms`);
        } catch (err) {
            console.error(
                `[sync] upload failed for ${storageKey} (attempt ${attempt + 1}):`,
                err instanceof Error ? err.message : err,
            );
        } finally {
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
            this.db.delete(pendingUploads).where(eq(pendingUploads.storageKey, storageKey)).run();
        }
        await bestEffortUnlink(stagingPath);
    }
}

// Best-effort delete of a local file (a staged copy) — already-gone is fine.
async function bestEffortUnlink(fullPath: string): Promise<void> {
    try {
        const file = Bun.file(fullPath);
        if (await file.exists()) await file.delete();
    } catch {}
}
