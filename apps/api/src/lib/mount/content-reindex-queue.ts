import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from './mount';

// Re-extract any one container at most once per window: an append-heavy chat or a long edit
// session keeps re-marking the dirty bit, but the cap stops it re-extracting a big body every
// time (reads contentIndexedAt).
export const CONTENT_REINDEX_CAP_SECONDS = 120;

// Rows drained per loop turn — keeps the first post-migration backfill (which marks every
// container + text file dirty) flowing in steady batches instead of one giant query.
const REINDEX_BATCH = 100;

// Ceiling on awaiting the in-flight drain at close. The current extract does unbounded storage GETs
// via the doc loaders, so a black-holed backend would otherwise park teardown forever — and
// idle-home eviction has no SIGKILL backstop (process shutdown does). Mirrors the upload queue's
// per-PUT ceiling (UPLOAD_PUT_TIMEOUT_MS); generous so a genuinely slow extract still finishes.
const REINDEX_CLOSE_TIMEOUT_MS = 120_000;

export type ContentExtractor = (mount: Mount, path: DrivePath) => Promise<string>;

// Per-mount, self-scheduled content reindexer — the read-side mirror of UploadQueue. The durable
// queue is the contentDirty bit on `paths` (no separate table, no staged copies: a reindex re-reads
// live state at drain time, so there is nothing to freeze, and the bit coalesces many edits into one
// re-extract). Producers (file writes, container onSync, copy, the v6 backfill) set the bit then
// call kick(); a single drain loop drains due rows off the request path and self-times the next pass
// for rows still inside the cap window. No process-global sweep.
export class ContentReindexQueue {
    private readonly mount: Mount;
    private readonly extract: ContentExtractor;
    private readonly label: string;

    // draining: one loop at a time (concurrent kicks coalesce). closing: one-way teardown gate.
    private draining: Promise<void> | null = null;
    // Per-path write generation. The drain compares the value it read before the extract with
    // the one after, so a write landing mid-extract keeps the dirty bit instead of having it
    // cleared by the older body's success. Entries live only while a path is dirty; a missing
    // one reads as 0, which after a restart is the safe answer (the bit is still set).
    private readonly generations = new Map<string, number>();
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private closing = false;
    // Deadline on close()'s drain await (see REINDEX_CLOSE_TIMEOUT_MS). A field so tests can shrink it.
    private closeTimeoutMs = REINDEX_CLOSE_TIMEOUT_MS;

    constructor(deps: { mount: Mount; extract: ContentExtractor; label: string }) {
        this.mount = deps.mount;
        this.extract = deps.extract;
        this.label = deps.label;
    }

    // One row's body just changed: record the write and drain soon. The seam for rows
    // CREATED by this write (no extract can be in flight for a fresh id, so ordering
    // against the insert doesn't matter). Rows that already exist must split the two
    // calls around their DB write instead — see bumpGeneration.
    markDirty(pathId: string): void {
        this.bumpGeneration(pathId);
        this.kick();
    }

    // Fences an overwrite against an in-flight extract of the same path. Call BEFORE
    // the DB write that sets the bit: an extract completing in between then sees a
    // generation mismatch and keeps the bit — bumped after, it would compare equal and
    // clear the newer write. kick() stays after the write, because kicked early a
    // drain can run before the bit lands, find nothing, and nothing re-drives it.
    bumpGeneration(pathId: string): void {
        this.generations.set(pathId, (this.generations.get(pathId) ?? 0) + 1);
    }

    // A dirty bit was just set (or persisted ones await on open) — drain soon. Coalesces.
    kick(): void {
        if (this.closing) return;
        this.drain().catch((err) => console.error(`[content-reindex] drain failed for ${this.label}:`, err));
    }

    // Drain due dirty rows now and await completion. One loop at a time; concurrent calls coalesce.
    drain(): Promise<void> {
        if (this.draining) return this.draining;
        this.draining = this.runDrainLoop().finally(() => {
            this.draining = null;
        });
        return this.draining;
    }

    // Mount teardown: stop scheduling and AWAIT the in-flight drain so the current extract finishes.
    // That extract opens a doc DB via mount.openDatabase and leaves it for the mount lifecycle to
    // close; awaiting here lets closeAllDatabases close it before it clears documentDbs — otherwise
    // the post-clear open leaks. Only the current extract is drained: leftover dirty rows replay on
    // the next mount open (the bit is the durable queue). The await is BOUNDED (see
    // REINDEX_CLOSE_TIMEOUT_MS): past the deadline teardown proceeds and the hung extract is accepted
    // as leaked — the pre-await class, now confined to the black-holed-backend tail.
    async close(): Promise<void> {
        this.closing = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (!this.draining) return;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.draining,
                new Promise<void>((resolve) => {
                    timeout = setTimeout(() => {
                        console.error(
                            `[content-reindex] close for ${this.label} exceeded ${this.closeTimeoutMs}ms; proceeding`,
                        );
                        resolve();
                    }, this.closeTimeoutMs);
                }),
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    private async runDrainLoop(): Promise<void> {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        while (!this.closing) {
            const batch = this.mount.getContentDirtyPaths(CONTENT_REINDEX_CAP_SECONDS, REINDEX_BATCH);
            if (batch.length === 0) break;
            for (const path of batch) {
                if (this.closing) return;
                // Read before the extract: the body this job returns is the document as of now.
                const generation = this.generations.get(path.id) ?? 0;
                try {
                    const body = await this.extract(this.mount, path);
                    if (body) this.mount.upsertPathContent(path.id, body);
                    else this.mount.clearPathContent(path.id);
                    // Clear the dirty bit only on a completed extract (empty counts) — a throw below must
                    // leave it set so a transient failure isn't silently dropped from body search. A write
                    // that landed while the extract ran keeps it set too: its content is not in this body,
                    // and the cap window defers the re-extract exactly like a failure.
                    if ((this.generations.get(path.id) ?? 0) === generation) {
                        this.generations.delete(path.id);
                        this.mount.markContentIndexed(path.id);
                    } else {
                        this.mount.markContentIndexAttempted(path.id);
                    }
                } catch (err) {
                    // The index is regenerable — log and move on so one bad body never stalls the loop.
                    // Stamp the attempt but keep contentDirty = 1: the cap defers the retry to a later
                    // drain, so a transient S3 hiccup re-extracts instead of dropping until the next write.
                    console.error(`[content-reindex] extract failed for ${path.id}:`, err);
                    this.mount.markContentIndexAttempted(path.id);
                }
            }
        }
        if (this.closing) return;
        // Rows re-dirtied inside the cap window aren't due yet — re-drive exactly when the earliest
        // becomes due (our own timer, no poll). A freshly-dirtied row reads as due-now.
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
