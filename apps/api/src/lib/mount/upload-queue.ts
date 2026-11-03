// The queue that uploads the changes of an S3 mount in the background. A write is saved on disk first and lands in
// the bucket later, so saving stays fast and survives a restart. A failed upload tries again after a growing delay,
// and uploads to the same bucket share a limit. Each mount has one queue, and the mount starts, drains and stops it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { and, asc, count, eq, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { settlesWithin } from '../../utils/timing';
import type { StorageBackend } from '../storage';
import { isSqliteFile } from './helpers';
import type * as schema from './schema';
import { pendingUploads } from './schema';
import { getUploadSemaphore, uploadBackoffMs } from './upload-limits';

type Db = BunSQLiteDatabase<typeof schema>;

// The PUTs of one key that timed out but may still land (see trackOrphan). It counts those not settled
// yet, says whether a cancel ran meanwhile, and keeps the bytes of the last ack, which go up again over a
// late landing. isDatabase keeps the kind of that copy, so a restored plain file is not checked as a database.
type OrphanState = { count: number; canceled: boolean; isDatabase: boolean; lastAcked?: Buffer };

// The longest one PUT may take. A request lost in the network would otherwise never end. The drain loop
// would wait for it, its place in the destination's limit would stay taken, and backoff would never start,
// so four such hangs would stop every mount that shares the limit. It is long, so a slow PUT completes.
export const UPLOAD_PUT_TIMEOUT_MS = 120_000;

export type UploadQueueDeps = {
    // The mount's metadata.db, which holds the pending_uploads table.
    db: Db;
    storage: StorageBackend;
    stagingDir: string;
    // Uploads to one S3 destination share one limit, because a provider limits the rate per destination.
    // It holds infrastructure strings only, no user data.
    destinationKey: string;
    // The mount id, for logs.
    label: string;
};

// Each pending upload is a row in metadata.db's pending_uploads and a frozen staged copy on disk. The
// queue drains them through the destination's limit. A failed upload backs off and schedules its own
// retry, so there is no global sweep. A writer, such as a sync, a close or a version snapshot, stages a
// copy and calls enqueueStaged. A home restore writes its rows directly, and the mount's init picks them
// up. A delete or a restore calls cancel, the mount's open calls reconcile, and its close calls close.
export class UploadQueue {
    private readonly db: Db;
    private readonly storage: StorageBackend;
    private readonly stagingDir: string;
    private readonly destinationKey: string;
    private readonly label: string;

    // The staged copies whose PUT runs, so enqueueStaged doesn't delete one under its upload.
    private readonly inFlight = new Set<string>();
    // Timed-out PUTs that may still land in the bucket later (see trackOrphan). Memory is enough: a
    // request dies with its process, and close() waits for those still live before a mount reopens.
    private readonly orphans = new Map<string, OrphanState>();
    // Every PUT still on the wire, timed-out ones included, so close() can wait for them.
    private readonly liveWrites = new Set<Promise<number>>();
    // The one drain loop that runs. A drain called while it runs joins it.
    private draining: Promise<void> | null = null;
    // closing stops every new drain and PUT. closed follows once close() stopped waiting, and from then
    // on metadata.db may close at any moment.
    private closing = false;
    private closed = false;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Fields, so tests can shrink the PUT timeout and hold back the jittered retry.
    private putTimeoutMs = UPLOAD_PUT_TIMEOUT_MS;
    private backoffMs = uploadBackoffMs;

    public constructor(deps: UploadQueueDeps) {
        this.db = deps.db;
        this.storage = deps.storage;
        this.stagingDir = deps.stagingDir;
        this.destinationKey = deps.destinationKey;
        this.label = deps.label;
    }

    // How many uploads wait, for the logs and the status checks.
    public get pendingCount(): number {
        const row = this.db.select({ c: count() }).from(pendingUploads).get();
        return row?.c ?? 0;
    }

    // Runs when the mount opens. It drains every pending upload again, after a restart or a Home that
    // reopened, and deletes the staged copies no row points to, which a crash before the row insert
    // leaves. It runs before the mount's tmp sweep, so a staged copy it keeps is not deleted.
    public reconcile(): void {
        const rows = this.db.select().from(pendingUploads).all();
        const referenced = new Set<string>();
        for (const row of rows) {
            const staging = this.resolveStagingPath(row.stagingPath);
            if (fs.existsSync(staging)) {
                referenced.add(path.basename(staging));
            } else {
                // The staged copy is gone, after a crash between the two deletes of an ack or after a
                // restore of the whole server. The row goes too.
                console.warn(
                    `[sync] dropping pending upload for ${row.storageKey}: staged copy ${path.basename(staging)} is gone`,
                );
                this.db.delete(pendingUploads).where(eq(pendingUploads.storageKey, row.storageKey)).run();
            }
        }
        // A failed read or delete only leaves stray files on disk, and must not stop the queue.
        try {
            for (const entry of fs.readdirSync(this.stagingDir)) {
                if (!referenced.has(entry)) fs.unlinkSync(path.join(this.stagingDir, entry));
            }
        } catch {}
        if (referenced.size > 0) {
            this.drain().catch((err) => console.error(`[sync] drain failed for ${this.label}:`, err));
        }
    }

    // Stops the queue when its mount closes: no drain or retry starts after this. Then it waits up to
    // waitMs for the PUTs still on the wire. A Home that closes may reopen at once, and an old PUT that
    // landed after the new queue acked would overwrite the newer bytes. Leftover rows replay on the next
    // mount open. For a graceful shutdown, call drain({flushNow}) first.
    public async close(waitMs = this.putTimeoutMs): Promise<void> {
        this.closing = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.liveWrites.size > 0 && !(await settlesWithin(Promise.allSettled(this.liveWrites), waitMs))) {
            console.error(`[sync] ${this.label} closed with ${this.liveWrites.size} PUT(s) still on the wire`);
        }
        this.closed = true;
    }

    // A staged copy gets a name of its own. The `.db` ending is left from when the queue only uploaded
    // databases, and nothing reads it. What a copy holds is in its row's isDatabase.
    public newStagingPath(): string {
        return path.join(this.stagingDir, `${crypto.randomUUID()}.db`);
    }

    // The absolute path of the pending staged copy of storageKey, or null when none is pending. Mount
    // reads the file there when it recovers or copies a database.
    public getPendingStagingPath(storageKey: string): string | null {
        const row = this.db
            .select({ stagingPath: pendingUploads.stagingPath })
            .from(pendingUploads)
            .where(eq(pendingUploads.storageKey, storageKey))
            .get();
        return row ? this.resolveStagingPath(row.stagingPath) : null;
    }

    // Records a staged copy as the pending upload of storageKey and starts a drain. isDatabase says what
    // the copy holds: a managed database, which gets the SQLite header check before its PUT, or a plain
    // file, which only a restore stages. The row is written before this returns. The newest copy wins.
    // The copy it replaces is deleted, unless its PUT runs, and then the upload deletes it when it ends.
    public enqueueStaged(storageKey: string, stagingPath: string, isDatabase: boolean): void {
        // Only the file name is stored, so the staged copy is still found after the data folder moved,
        // such as to a new host. An absolute path would miss there, and reconcile would drop the row.
        const stored = path.basename(stagingPath);
        const now = Date.now();
        const prevStaging = this.getPendingStagingPath(storageKey);
        this.db
            .insert(pendingUploads)
            .values({ storageKey, stagingPath: stored, attempt: 0, enqueuedAt: now, nextAttemptAt: now, isDatabase })
            .onConflictDoUpdate({
                target: pendingUploads.storageKey,
                set: { stagingPath: stored, attempt: 0, enqueuedAt: now, nextAttemptAt: now, isDatabase },
            })
            .run();
        if (prevStaging && prevStaging !== stagingPath && !this.inFlight.has(prevStaging)) {
            void bestEffortUnlink(prevStaging);
        }
        this.drain().catch((err) => console.error(`[sync] drain failed for ${this.label}:`, err));
    }

    // Cancels the pending upload of storageKey and deletes its staged copy. A permanent delete and a chat
    // restore call it, so a queued PUT can't bring back an object they removed. performUpload reads the
    // row again right before and after its PUT, so a cancel during the PUT still stops it, and the object
    // it brought back is deleted.
    public async cancel(storageKey: string): Promise<void> {
        const orphan = this.orphans.get(storageKey);
        if (orphan) {
            // A timed-out PUT may still land after the delete that follows this cancel. The flag makes
            // orphanSettled delete the object again.
            orphan.canceled = true;
            orphan.lastAcked = undefined;
        }
        const staging = this.getPendingStagingPath(storageKey);
        this.db.delete(pendingUploads).where(eq(pendingUploads.storageKey, storageKey)).run();
        if (staging) await bestEffortUnlink(staging);
    }

    // Drains the due pending uploads through the destination's limit. A failed PUT moves the next attempt
    // of its row into the future, so the loop skips it and never spins on a dead backend. flushNow makes
    // every row due at once, for the shutdown flush and for tests.
    public async drain(opts: { flushNow?: boolean } = {}): Promise<void> {
        if (opts.flushNow) this.db.update(pendingUploads).set({ nextAttemptAt: Date.now() }).run();
        if (this.draining) return this.draining;
        this.draining = this.runDrainLoop().finally(() => {
            this.draining = null;
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
            const row = this.db
                .select()
                .from(pendingUploads)
                .where(lte(pendingUploads.nextAttemptAt, Date.now()))
                .orderBy(asc(pendingUploads.enqueuedAt))
                .limit(1)
                .get();
            if (!row) break;
            await semaphore.run(() => this.performUpload(row.storageKey, row.stagingPath, row.attempt, row.isDatabase));
        }
        if (this.closing) return;
        // The queue's own timer drains again when the earliest row that backed off is due.
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

    // PUTs one staged copy to its storage key. It reads the row again right before the PUT, so a cancel or
    // a newer copy since the loop read it stops the upload. After an ack it deletes the row, if it is still
    // this copy's, and the staged copy. When a cancel came during the PUT, it deletes the object the PUT
    // brought back. A failed PUT backs the row off and keeps both for a retry. It never throws.
    private async performUpload(
        storageKey: string,
        storedStaging: string,
        attempt: number,
        isDatabase: boolean,
    ): Promise<void> {
        if (this.closing) return;
        // storedStaging is the row's own value. The file operations use the absolute path, and the row
        // writes match the stored value.
        const stagingPath = this.resolveStagingPath(storedStaging);
        const current = this.getPendingStagingPath(storageKey);
        if (current !== stagingPath) {
            // A newer copy replaced this one, or the upload was canceled.
            await bestEffortUnlink(stagingPath);
            return;
        }
        const file = Bun.file(stagingPath);
        if (!(await file.exists())) {
            // A cancel or a newer copy deleted the staged copy before its PUT began. The delete only
            // drops a row that still points at this copy.
            if (!this.closing) this.deletePendingRow(storageKey, storedStaging);
            return;
        }
        // Only a managed database has a header to check, and a VACUUM INTO copy without one is a disk
        // fault. A restore's plain files, such as PNGs, PDFs and text, have none, and dropping them here
        // would lose most of a restored s3 mount.
        if (isDatabase && !isSqliteFile(stagingPath)) {
            // Uploading this copy would put garbage over the good object, so it is dropped. The object
            // keeps its last good bytes, the loss is the writes in this copy, and the next sync stages
            // again from the live temp. During a teardown both stay, and the next open drops them.
            console.error(`[sync] dropping corrupt staged copy for ${storageKey} (${stagingPath})`);
            if (this.closing) return;
            this.deletePendingRow(storageKey, storedStaging);
            await bestEffortUnlink(stagingPath);
            return;
        }

        // close() may have run during the awaits above; no PUT starts after it.
        if (this.closing) return;
        // The orphans of this key when the PUT starts. If they all settle during the PUT, nobody knows
        // whether a landed one committed before or after it (see the ack below).
        const orphansAtStart = this.orphans.get(storageKey);
        this.inFlight.add(stagingPath);
        let putOk = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const start = Bun.nanoseconds();
            // StorageBackend.write takes no abort signal, so a race bounds it. A timeout counts as a
            // failed PUT, never as an ack, and the row backs off. The request may still land at any later
            // time, so the timeout also tracks it as an orphan. An ack or a cancel of this key before it
            // settles is then repeated once it does (see trackOrphan).
            const write = this.storage.write(storageKey, file);
            this.liveWrites.add(write);
            const forget = () => this.liveWrites.delete(write);
            write.then(forget, forget);
            const timeoutMs = this.putTimeoutMs;
            await Promise.race([
                write,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => {
                        const orphan = this.trackOrphan(storageKey, write, isDatabase);
                        // A cancel during this PUT found no orphan to flag, because it is tracked
                        // only now. During an upload a missing row can only mean a cancel: acks run
                        // one at a time, and a newer copy keeps the row. So the flag is set here.
                        if (!this.closing && this.getPendingStagingPath(storageKey) === null) {
                            orphan.canceled = true;
                        }
                        reject(new Error(`PUT exceeded ${timeoutMs}ms`));
                    }, timeoutMs);
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
            this.inFlight.delete(stagingPath);
        }

        // During a teardown the row and the staged copy stay for the next open. metadata.db may be
        // closing, so nothing reads it.
        if (this.closing) return;

        const after = this.getPendingStagingPath(storageKey);
        const stillCurrent = after === stagingPath;

        if (putOk && after === null) {
            // A permanent delete or a chat restore canceled the row during the PUT, which brought a
            // deleted object back, so it is deleted again. The key is a UUID that is never used again, so
            // no new object can be hit. A row that points at a newer copy was replaced, not canceled.
            if (!(await this.storage.delete(storageKey))) {
                console.warn(`[sync] PUT for canceled ${storageKey} landed and its object stays behind`);
            }
        }
        if (!putOk && stillCurrent) {
            // A failed PUT of the current row backs off for a retry and keeps the staged copy.
            const next = attempt + 1;
            this.db
                .update(pendingUploads)
                .set({ attempt: next, nextAttemptAt: Date.now() + this.backoffMs(next) })
                .where(eq(pendingUploads.storageKey, storageKey))
                .run();
            return;
        }
        // An ack of the current row clears the row. In every case left, the staged copy is not needed.
        if (putOk && stillCurrent) {
            if (orphansAtStart && !this.orphans.has(storageKey)) {
                // Every orphan of this key settled during this PUT. A landed one may have committed after
                // it, because the order of settling says nothing about the order of commits. So the row
                // and the staged copy stay, and the PUT runs again at once, after the orphan's commit.
                console.warn(`[sync] orphan settled during PUT of ${storageKey}, uploading again`);
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
                // A timed-out PUT of this key may still land over this ack. The acked bytes are kept, so
                // orphanSettled can upload them again.
                try {
                    orphan.lastAcked = fs.readFileSync(stagingPath);
                    console.warn(
                        `[sync] acked ${storageKey} with ${orphan.count} unsettled timed-out PUT(s), keeping the acked bytes`,
                    );
                } catch (err) {
                    console.error(`[sync] failed to retain acked bytes for ${storageKey}:`, err);
                }
            }
        }
        await bestEffortUnlink(stagingPath);
    }

    // Drops the pending row only while it points at this staged copy, so the row of a newer copy stays.
    private deletePendingRow(storageKey: string, storedStaging: string): void {
        this.db
            .delete(pendingUploads)
            .where(and(eq(pendingUploads.storageKey, storageKey), eq(pendingUploads.stagingPath, storedStaging)))
            .run();
    }

    // A PUT that outlived its timeout is an orphan. Its request keeps running and may land after a newer
    // PUT of the key acked, which rolls the object back, for good if nothing syncs again. Or it lands
    // after a cancel and brings a deleted object back. It is tracked until it settles, so orphanSettled
    // can repair both.
    private trackOrphan(storageKey: string, write: Promise<number>, isDatabase: boolean): OrphanState {
        let orphan = this.orphans.get(storageKey);
        if (!orphan) {
            orphan = { count: 0, canceled: false, isDatabase };
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
        if (orphan.canceled) {
            // The key was deleted for good while this PUT ran, and one that landed brought the object
            // back. It is deleted again. The key is a UUID that is never used again, so no new object
            // can be hit.
            if (landed) {
                console.error(`[sync] orphaned PUT for ${storageKey} landed after cancel, deleting the object again`);
            }
            void this.storage.delete(storageKey).then((gone) => {
                if (!gone) console.warn(`[sync] orphaned PUT for canceled ${storageKey}: its object stays behind`);
            });
            return;
        }
        // No ack was kept. Either nothing acked over the orphans, and a pending row uploads again on its
        // own. Or an ack runs right now, and its performUpload uploads again when it finds the orphans
        // gone. A landing is logged, so a PUT that landed past its timeout can still be found.
        if (!orphan.lastAcked) {
            if (landed) {
                console.warn(
                    `[sync] orphaned PUT for ${storageKey} landed with no kept ack, and a pending upload replaces it`,
                );
            }
            return;
        }
        if (landed) {
            console.error(
                `[sync] orphaned PUT for ${storageKey} landed after a newer upload acked, uploading the acked bytes again`,
            );
        }
        // While close() waits, metadata.db is still open, and the row staged below replays at the next open.
        if (this.closed) {
            console.error(`[sync] cannot re-upload ${storageKey}: queue closed, check the object against versioning`);
            return;
        }
        // A pending row holds newer bytes than the kept ack, and it lands after the orphan anyway.
        if (this.getPendingStagingPath(storageKey) !== null) return;
        // The kept bytes go through the queue again, so they land after the orphan. That happens even when
        // the orphan failed: a lost response can hide a commit, and the same PUT twice does no harm.
        try {
            const stagingPath = this.newStagingPath();
            fs.writeFileSync(stagingPath, orphan.lastAcked);
            this.enqueueStaged(storageKey, stagingPath, orphan.isDatabase);
        } catch (err) {
            console.error(`[sync] failed to re-stage acked bytes for ${storageKey}:`, err);
        }
    }

    // Turns a row's stagingPath into an absolute path. A new row stores only the file name, so a data
    // folder that moved still finds its staged copies. An older row may hold an absolute path, which passes.
    private resolveStagingPath(stored: string): string {
        return path.isAbsolute(stored) ? stored : path.join(this.stagingDir, stored);
    }
}

// Deletes a staged copy if it is there. A failure only leaves a stray file.
async function bestEffortUnlink(fullPath: string): Promise<void> {
    try {
        const file = Bun.file(fullPath);
        if (await file.exists()) await file.delete();
    } catch {}
}
