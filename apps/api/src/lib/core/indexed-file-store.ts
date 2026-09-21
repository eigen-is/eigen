import { AsyncLocalStorage } from 'node:async_hooks';
import { Semaphore } from '../../utils/semaphore';
import { isEnoent, type LocalFilesystem } from './local-filesystem';
import { isSafePathSegment } from './path-utils';

// The domain-neutral half of a file+index store, with no SQL. See docs/CONTACTS.md § Storage model — files as truth.

// Safe as both a filename and a DAV href: the shared segment rule plus the suffix the resource carries.
export function sanitizeResourceUri(raw: string, suffix: string): string | null {
    const uri = raw.normalize('NFC');
    return uri.endsWith(suffix) && isSafePathSegment(uri) ? uri : null;
}

// Two uris that differ only in case or Unicode form are the same resource, because a file system may fold either.
export function uriKeyOf(uri: string): string {
    return uri.normalize('NFC').toLowerCase();
}

// A rebuild that lost the stored value would reissue its generation, so the wall clock in seconds floors it.
export function nextSyncGen(stored: number | undefined, now: number): number {
    return Math.max((stored ?? 0) + 1, Math.floor(now / 1000));
}

export function computeResourceEtag(bytes: Uint8Array): string {
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

// Why a body is refused, in the terms both DAV protocols have a precondition element for: bytes that do
// not parse, an object that breaks the resource rules, a component the collection does not hold.
export type InvalidReason = 'data' | 'object' | 'component';

// A client-caused failure is a value here, not a throw: only genuine IO errors bubble past this seam.
// A null etag is a write the server did not store verbatim: it has no validator to hand back (RFC 4791 § 5.3.4).
export type PutResourceResult =
    | { ok: true; etag: string | null; created: boolean }
    | {
          ok: false;
          error: 'precondition' | 'uid-conflict' | 'invalid' | 'no-collection' | 'too-large' | 'quota';
          reason?: InvalidReason;
          message?: string;
          conflictUri?: string;
      };

export type DeleteResourceResult = { ok: true } | { ok: false; error: 'not-found' | 'precondition' };

// The mtime is rounded here, once, so a writer and every later pass compare the same number.
export type ResourceStat = { mtime: number; size: number };

export async function statResourceFile(storage: LocalFilesystem, filePath: string): Promise<ResourceStat> {
    const stat = await storage.stat(filePath);
    return { mtime: Math.round(stat.mtimeMs), size: stat.size };
}

export async function writeResourceFile(
    storage: LocalFilesystem,
    filePath: string,
    bytes: Uint8Array,
): Promise<ResourceStat> {
    await storage.writeAtomic(filePath, bytes);
    return statResourceFile(storage, filePath);
}

// A vanished file is not a 500: it answers as a miss, and the caller marks the key dirty for the next drain.
export async function readResourceFile(storage: LocalFilesystem, filePath: string): Promise<Uint8Array | null> {
    try {
        return await storage.file(filePath).bytes();
    } catch (e) {
        if (isEnoent(e)) return null;
        throw e;
    }
}

// Sorted, because callers tie-break on this order — a key collision must resolve the same way every pass.
export async function listResourceUris(
    storage: LocalFilesystem,
    dir: string,
    suffix: string,
): Promise<{ uri: string; key: string }[]> {
    const seen = new Set<string>();
    const entries: { uri: string; key: string }[] = [];
    const names = (await storage.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    for (const name of names) {
        const uri = sanitizeResourceUri(name, suffix);
        if (!uri) {
            console.warn(`indexed-file-store: ignoring non-conforming entry ${name} in ${dir}/`);
            continue;
        }
        const key = uriKeyOf(uri);
        if (seen.has(key)) {
            console.warn(`indexed-file-store: ignoring case-variant duplicate ${name} in ${dir}/`);
            continue;
        }
        seen.add(key);
        entries.push({ uri, key });
    }
    return entries;
}

export type ResourceFile = ResourceStat & { uri: string };

// What one pass over a resource directory sees. A stat that failed is transient IO, not a removal, so the
// key is remembered separately and the diff below refuses to call it vanished.
export type ResourceScan = { files: Map<string, ResourceFile>; skipped: Set<string> };

export async function statResourceDir(storage: LocalFilesystem, dir: string, suffix: string): Promise<ResourceScan> {
    const files = new Map<string, ResourceFile>();
    const skipped = new Set<string>();
    for (const { uri, key } of await listResourceUris(storage, dir, suffix)) {
        try {
            files.set(key, { uri, ...(await statResourceFile(storage, `${dir}/${uri}`)) });
        } catch (e) {
            skipped.add(key);
            console.warn(`indexed-file-store: skipping ${uri} — could not stat it: ${e}`);
        }
    }
    return { files, skipped };
}

export type StatDiff<R> = {
    changed: { file: ResourceFile; row: R }[];
    added: ResourceFile[];
    vanished: R[];
};

// `stale` lets the domain call a same-stat pair changed anyway, for drift the stats cannot see.
export function diffFileStats<R extends ResourceStat>(
    scan: ResourceScan,
    rows: Map<string, R>,
    stale?: (row: R) => boolean,
): StatDiff<R> {
    const diff: StatDiff<R> = { changed: [], added: [], vanished: [] };
    for (const [key, file] of scan.files) {
        const row = rows.get(key);
        if (!row) diff.added.push(file);
        else if (file.mtime !== row.mtime || file.size !== row.size || stale?.(row)) diff.changed.push({ file, row });
    }
    for (const [key, row] of rows) {
        if (!scan.files.has(key) && !scan.skipped.has(key)) diff.vanished.push(row);
    }
    return diff;
}

// A uid a surviving row owns would throw on the UNIQUE index and brick the pass; a loser is skipped, never deleted.
export function dedupeByUid<T>(
    items: T[],
    owners: Map<string, string>,
    identify: (item: T) => { scope: string; id: string; uri: string },
): T[] {
    const kept: T[] = [];
    for (const item of items) {
        const { scope, id, uri } = identify(item);
        const owner = owners.get(scope);
        if (owner !== undefined && owner !== id) {
            console.warn(
                `indexed-file-store: skipping ${uri} — UID scope ${scope} is already claimed by another resource`,
            );
            continue;
        }
        owners.set(scope, id);
        kept.push(item);
    }
    return kept;
}

// A bulk write (a whole-file import, a device sync) broadcasts ONE list-level event for the per-resource
// events it held back, instead of one per resource — a thousand cards were a thousand broadcasts. The flush
// runs even when the body throws: what landed before it still has to reach the tabs.
export class BroadcastBatch {
    private depth = 0;
    private held = false;

    constructor(private readonly flush: () => void) {}

    // True when the caller's event was held for the batch, false when it is the caller's to broadcast now.
    hold(): boolean {
        if (this.depth === 0) return false;
        this.held = true;
        return true;
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        this.depth++;
        try {
            return await fn();
        } finally {
            this.depth--;
            if (this.depth === 0 && this.held) {
                this.held = false;
                this.flush();
            }
        }
    }
}

// One slot, so a file write and its index commit stay a pair; a torn write's key stays dirty until a drain settles it.
export class WriteGate {
    private readonly lock = new Semaphore(1);
    private readonly dirty = new Set<string>();
    // Marks the async context of the body holding the lock, so re-entry is refused instead of deadlocking.
    private readonly holder = new AsyncLocalStorage<{ active: boolean }>();

    constructor(private readonly recover: (keys: string[], settled: (key: string) => void) => Promise<void>) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.holder.getStore()?.active) throw new Error('WriteGate.run is not reentrant');
        return this.lock.run(async () => {
            const token = { active: true };
            return this.holder.run(token, async () => {
                try {
                    await this.drain();
                    return await fn();
                } finally {
                    token.active = false;
                }
            });
        });
    }

    // Free on the hot path (an empty set takes no lock), and a no-op for the body that drained at its entry.
    async ensureDrained(): Promise<void> {
        if (this.holder.getStore()?.active) return;
        if (this.dirty.size) await this.lock.run(() => this.drain());
    }

    markDirty(key: string): void {
        this.dirty.add(key);
    }

    // Init must not throw — a home that can't init can't be opened — so an unrecoverable key waits for the next one.
    async recoverPending(keys: string[]): Promise<void> {
        for (const key of keys) {
            this.markDirty(key);
            try {
                await this.ensureDrained();
            } catch (e) {
                console.warn(`indexed-file-store: could not recover the pending write of ${key}: ${e}`);
                this.dirty.delete(key);
            }
        }
    }

    // Caller holds the lock. Only a key the domain settled is cleared, so a throw retries just the rest.
    private async drain(): Promise<void> {
        if (this.dirty.size === 0) return;
        await this.recover([...this.dirty], (key) => this.dirty.delete(key));
    }
}
