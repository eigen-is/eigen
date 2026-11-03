// The content reindex of one mount: it extracts the text of a changed file or container, such as a doc
// or a chat, for Drive's content search. Its queue is the contentDirty bit on the paths row, so it reads
// the live state when a row is due and many edits become one extract. A producer, such as a file write
// or a container sync, sets the bit and calls kick(). One drain loop works off the request path and
// times its own next pass for rows still inside the cap window.

import type { DrivePath } from '@workspace/lib/types/drive';
import { settlesWithin } from '../../utils/timing';
import { ApiError } from '../core';
import type { Mount } from './mount';

// A path is extracted at most once in this many seconds, counted from its contentIndexedAt. A busy chat
// or a long edit session sets the dirty bit again and again, and a big body must not be read each time.
export const CONTENT_REINDEX_CAP_SECONDS = 120;

// The rows one turn of the loop reads. A backfill marks every container and text file dirty at once, and
// it then runs in steady batches instead of one huge query.
const REINDEX_BATCH = 100;

// How long close() waits for the drain in flight. Teardown aborts the storage reads of an extract, but
// the rest of the extract has no bound of its own. An idle Home close has no process kill behind it, as
// a shutdown has, so this wait is the bound. It is the same as the upload queue's PUT timeout, and long
// enough for a slow extract to finish.
const REINDEX_CLOSE_TIMEOUT_MS = 120_000;

export type ContentExtractor = (mount: Mount, path: DrivePath) => Promise<string>;

export class ContentReindexQueue {
    private readonly mount: Mount;
    private readonly extract: ContentExtractor;
    private readonly label: string;

    // The one drain loop that runs. A kick while it runs joins it.
    private draining: Promise<void> | null = null;
    // A count of writes per path. The drain reads it before and after an extract. When it moved, a write
    // landed during the extract, and the dirty bit stays set, because the body misses that write. An entry
    // lives only while its path is dirty. A missing one reads as 0, which is safe after a restart, because
    // the bit is still set then.
    private readonly generations = new Map<string, number>();
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private closing = false;
    // A field, so tests can shrink REINDEX_CLOSE_TIMEOUT_MS.
    private closeTimeoutMs = REINDEX_CLOSE_TIMEOUT_MS;

    public constructor(deps: { mount: Mount; extract: ContentExtractor; label: string }) {
        this.mount = deps.mount;
        this.extract = deps.extract;
        this.label = deps.label;
    }

    // Counts a write and drains soon, for a row this write created. No extract can run for a new id, so
    // the order against the insert doesn't matter. A write to a row that exists calls bumpGeneration
    // before it writes and kick after it.
    public markDirty(pathId: string): void {
        this.bumpGeneration(pathId);
        this.kick();
    }

    // Counts an overwrite, so an extract of the same path that runs now keeps the dirty bit. It runs before
    // the write that sets the bit. Counted after the write, an extract that ends in between would find the
    // count unchanged and clear the bit of the newer write. kick() goes after the write: a drain kicked
    // before it could find no dirty row, and then nothing would drain the row.
    public bumpGeneration(pathId: string): void {
        this.generations.set(pathId, (this.generations.get(pathId) ?? 0) + 1);
    }

    // Drains soon, after a dirty bit was set or when a mount opens with dirty rows. A kick during a drain
    // joins that drain.
    public kick(): void {
        if (this.closing) return;
        this.drain().catch((err) => console.error(`[content-reindex] drain failed for ${this.label}:`, err));
    }

    // Drains the dirty rows that are due, and resolves when it is done. A call during a drain joins it.
    public drain(): Promise<void> {
        if (this.draining) return this.draining;
        this.draining = this.runDrainLoop().finally(() => {
            this.draining = null;
        });
        return this.draining;
    }

    // Mount teardown: stop scheduling and wait for the drain in flight, so the current extract
    // finishes. That extract may hold a document database through mount.withDatabase, and the close
    // sweep of closeAllDatabases would otherwise wait for it. Only the current extract is drained.
    // The other dirty rows replay on the next mount open, because the bit is the durable queue. The
    // wait ends after REINDEX_CLOSE_TIMEOUT_MS, and then teardown goes on without the extract.
    public async close(): Promise<void> {
        this.closing = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (!this.draining) return;
        this.draining.catch((err) => console.error(`[content-reindex] drain failed for ${this.label} at close:`, err));
        if (!(await settlesWithin(this.draining, this.closeTimeoutMs))) {
            console.error(`[content-reindex] close for ${this.label} exceeded ${this.closeTimeoutMs}ms; proceeding`);
        }
    }

    // Teardown aborts the mount's reads before it closes this queue. The rows still dirty wait for the
    // next open.
    private get stopped(): boolean {
        return this.closing || this.mount.downloads.signal.aborted;
    }

    private async runDrainLoop(): Promise<void> {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        while (!this.stopped) {
            const batch = this.mount.getContentDirtyPaths(CONTENT_REINDEX_CAP_SECONDS, REINDEX_BATCH);
            if (batch.length === 0) break;
            for (const path of batch) {
                if (this.stopped) return;
                // Read before the extract, because the body it returns is the document as it is now.
                const generation = this.generations.get(path.id) ?? 0;
                try {
                    const body = await this.extract(this.mount, path).catch((err: unknown) => {
                        // A gone object answers 410 to every open. It is indexed as empty, and a version
                        // restore marks it dirty again.
                        if (err instanceof ApiError && err.status === 410) return '';
                        throw err;
                    });
                    if (body) this.mount.upsertPathContent(path.id, body);
                    else this.mount.clearPathContent(path.id);
                    // Only an extract that completed clears the dirty bit, an empty one included. A write
                    // that landed while the extract ran keeps the bit, because this body misses it. The cap
                    // window then holds off the next extract, as it does after a failure.
                    if ((this.generations.get(path.id) ?? 0) === generation) {
                        this.generations.delete(path.id);
                        this.mount.markContentIndexed(path.id);
                    } else {
                        this.mount.markContentIndexAttempted(path.id);
                    }
                } catch (err) {
                    // An aborted read says nothing about the body: leave the row due.
                    if (this.stopped) return;
                    // The index can always be built again, so one bad body only logs and never stops the
                    // loop. The attempt is stamped and the bit stays set, so the cap holds off the retry to a
                    // later drain. A short storage outage is then retried, not dropped until the next write.
                    console.error(`[content-reindex] extract failed for ${path.id}:`, err);
                    this.mount.markContentIndexAttempted(path.id);
                }
            }
        }
        if (this.stopped) return;
        // A row marked dirty again inside the cap window is not due yet. The queue's own timer drains
        // again when the earliest one is due. A row marked dirty for the first time is due at once.
        const dueAt = this.mount.earliestPendingReindexAt(CONTENT_REINDEX_CAP_SECONDS);
        if (dueAt !== null) this.scheduleRetry(Math.max(0, dueAt - Date.now()));
    }

    private scheduleRetry(delayMs: number): void {
        if (this.closing) return;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.drain().catch((err) => console.error(`[content-reindex] retry drain failed for ${this.label}:`, err));
        }, delayMs);
    }
}
