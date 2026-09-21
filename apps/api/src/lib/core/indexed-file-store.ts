import { AsyncLocalStorage } from 'node:async_hooks';
import { Semaphore } from '../../utils/semaphore';
import type { LocalFilesystem } from './local-filesystem';
import { isSafePathSegment } from './path-utils';

// The domain-neutral half of a file+index store: file/key rules, the write gate and the stat diff, with no SQL.
// See docs/CONTACTS.md § Storage model — files as truth.

// Safe as both a filename and a DAV href: the shared segment rule plus the suffix the resource carries.
export function sanitizeResourceUri(raw: string, suffix: string): string | null {
    const uri = raw.normalize('NFC');
    return uri.endsWith(suffix) && isSafePathSegment(uri) ? uri : null;
}

// Two uris that differ only in case or Unicode form are the same resource, because a file system may fold either.
export function uriKeyOf(uri: string): string {
    return uri.normalize('NFC').toLowerCase();
}

export function computeResourceEtag(bytes: Uint8Array): string {
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

// The typed outcome of a DAV write, which the protocol handler turns into a 4xx or a 201/204. No raw throw
// crosses this seam for a client-caused failure — only genuine IO errors bubble. `conflictUri` names the
// resource that already owns the UID, where one exists (RFC 6352 § 6.3.2.1 and its CalDAV twin).
export type PutResourceResult =
    | { ok: true; etag: string; created: boolean }
    | {
          ok: false;
          error: 'precondition' | 'uid-conflict' | 'invalid' | 'too-large' | 'quota';
          message?: string;
          conflictUri?: string;
      };

// The delete twin: a 404 for an unknown uri, a 412 for a stale If-Match. A domain with its own refusal
// extends this union rather than widening it here.
export type DeleteResourceResult = { ok: true } | { ok: false; error: 'not-found' | 'precondition' };

// The mtime is rounded here, once, so a writer and every later pass compare the same number.
export type ResourceStat = { mtime: number; size: number };

export async function statResourceFile(storage: LocalFilesystem, filePath: string): Promise<ResourceStat> {
    const stat = await storage.stat(filePath);
    return { mtime: Math.round(stat.mtimeMs), size: stat.size };
}

// The canonical write: temp file → fsync → rename, then the stat the index row is committed with.
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
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return null;
        throw e;
    }
}

// Unlinks rather than deletes: `delete` reaps a newly-empty parent, taking the resource directory with it.
export async function cleanupTempFiles(storage: LocalFilesystem, dir: string): Promise<void> {
    for (const name of await storage.list(dir)) {
        if (name.startsWith('.') && name.includes('.tmp-')) {
            await storage.unlink(`${dir}/${name}`);
        }
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

export type StatDiff<F, R> = {
    changed: { file: F; row: R }[];
    added: F[];
    vanished: R[];
};

// `stale` lets the domain call a same-stat pair changed anyway, for drift the stats cannot see.
export function diffFileStats<F extends ResourceStat, R extends ResourceStat>(
    files: Map<string, F>,
    rows: Map<string, R>,
    stale?: (row: R) => boolean,
): StatDiff<F, R> {
    const diff: StatDiff<F, R> = { changed: [], added: [], vanished: [] };
    for (const [key, file] of files) {
        const row = rows.get(key);
        if (!row) diff.added.push(file);
        else if (file.mtime !== row.mtime || file.size !== row.size || stale?.(row)) diff.changed.push({ file, row });
    }
    for (const [key, row] of rows) {
        if (!files.has(key)) diff.vanished.push(row);
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

// One slot, so a file write and its index commit stay a pair; a torn write's key stays dirty until `recover`
// settles it, and the next call in — mutation or read — re-indexes it before observing the index.
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

    // Recovery at init may not be fatal — a home whose init throws cannot be opened at all — so a key that
    // won't recover is dropped here and its durable journal row brings it back on the next init.
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
