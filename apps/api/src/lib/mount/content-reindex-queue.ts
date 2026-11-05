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

// How long close() waits for the drain in flight. An idle Home close has no process kill behind it, as a
// shutdown has, so this is the only bound on the parts of an extract that are not storage reads.
const REINDEX_CLOSE_TIMEOUT_MS = 120_000;

export type ContentExtractor = (mount: Mount, path: DrivePath) => Promise<string>;

export class ContentReindexQueue {
    private readonly mount: Mount;
    private readonly extract: ContentExtractor;
    private readonly label: string;

    // The one drain loop that runs. A kick while it runs joins it.
    private draining: Promise<void> | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private closing = false;

    public constructor(deps: { mount: Mount; extract: ContentExtractor; label: string }) {
        this.mount = deps.mount;
        this.extract = deps.extract;
        this.label = deps.label;
    }

    // Teardown aborts the mount's reads before it closes this queue. The rows still dirty wait for the
    // next open.
    private get stopped(): boolean {
        return this.closing || this.mount.downloads.signal.aborted;
    }

    // Waits for the extract in flight, which may hold a document database that the close sweep would
    // otherwise wait for. The other dirty rows replay on the next open, because the bit is the queue.
    public async close(): Promise<void> {
        this.closing = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (!this.draining) return;
        this.draining.catch((err) => console.error(`[content-reindex] drain failed for ${this.label} at close:`, err));
        if (!(await settlesWithin(this.draining, REINDEX_CLOSE_TIMEOUT_MS))) {
            console.error(
                `[content-reindex] close for ${this.label} exceeded ${REINDEX_CLOSE_TIMEOUT_MS}ms; proceeding`,
            );
        }
    }

    // Drains soon, after a dirty bit was set or when a mount opens with dirty rows. It goes after the write
    // that sets the bit, because a drain kicked before it could find no dirty row and never drain the row.
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
                // Cleared before the extract, so a write that lands while it runs sets the bit again, and
                // the body this extract misses is read on a later pass.
                this.mount.clearContentDirty(path.id);
                try {
                    const body = await this.extract(this.mount, path).catch((err: unknown) => {
                        // A gone object answers 410 to every open. It is indexed as empty, and a version
                        // restore marks it dirty again.
                        if (err instanceof ApiError && err.status === 410) return '';
                        throw err;
                    });
                    if (body) this.mount.upsertPathContent(path.id, body);
                    else this.mount.clearPathContent(path.id);
                } catch (err) {
                    this.mount.markContentDirty(path.id);
                    // An aborted read says nothing about the body: leave the row due.
                    if (this.stopped) return;
                    // The index can always be built again, so one bad body only logs and never stops the loop.
                    console.error(`[content-reindex] extract failed for ${path.id}:`, err);
                }
                // Stamped after a failure too, so the cap holds off the retry and a short storage outage is
                // retried on a later drain.
                this.mount.markContentIndexed(path.id);
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
