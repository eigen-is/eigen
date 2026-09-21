import { Semaphore } from '../../utils/semaphore';
import type { LocalFilesystem } from './local-filesystem';
import { isSafePathSegment } from './path-utils';

// The domain-neutral half of a file+index store: one file per resource under a directory, indexed by a
// database the domain owns. No SQL lives here — a domain hands in plain rows and callbacks and keeps its
// tables. What is shared is the file/key rules, the write gate that keeps a file and its index row a pair,
// and the stat diff a reconcile pass sits on. Contacts is one such store; see docs/CONTACTS.md § Storage
// model — files as truth.

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

// The stat pair an index row stores. The mtime is rounded here, once, so a writer and every later pass
// compare the same number.
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

// A read of a resource file the index still lists. A vanished file is not a 500: mark it so the next drain
// settles the row, and answer this request as a miss.
export async function readResourceFile(
    storage: LocalFilesystem,
    filePath: string,
    gate: WriteGate,
    key: string,
): Promise<Uint8Array | null> {
    try {
        return await storage.file(filePath).bytes();
    } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
            gate.markDirty(key);
            return null;
        }
        throw e;
    }
}

// Sweep crash leftovers from `dir`: ONLY writeAtomic's own temp files. Anything else — a stray name, a
// hand-placed dotfile — is data we didn't create, so the index passes warn-skip it instead. Unlinks rather
// than deletes: `delete` reaps newly-empty parents, which on a directory whose only content is debris would
// remove it out from under the init that just created it.
export async function cleanupTempFiles(storage: LocalFilesystem, dir: string): Promise<void> {
    for (const name of await storage.list(dir)) {
        if (name.startsWith('.') && name.includes('.tmp-')) {
            await storage.unlink(`${dir}/${name}`);
        }
    }
}

// The one enumerate seam a reconcile and a rebuild share, warn-skipping a non-conforming name and a
// case-variant duplicate. Returns the survivors in sorted order — callers rely on it for stable tie-breaks,
// so a key collision resolves the same way every pass.
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

// The stat-only comparison both index passes sit on: a directory listing against the index rows, keyed the
// same way. A same-stat pair is none of the three, so a clean book reads nothing. Nothing here reads, hashes
// or writes — the domain owns all three. `stale` lets it call a same-stat pair changed anyway, for drift the
// stats cannot see (a derived file of its own gone missing).
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

// Drop prepared items whose uid is already owned by a row the transaction will leave in place — the UNIQUE
// index would otherwise throw inside the write and brick the whole pass. `owners` maps each uniqueness scope
// (the uid, or the uid within its collection) to the row id that will hold it after the pass; an item
// updating its own incumbent keeps that row's slot, any other collision is skipped and warned — never
// deleted — with the earliest uri winning.
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
            console.warn(`indexed-file-store: skipping ${uri} — its UID is already claimed by another resource`);
            continue;
        }
        owners.set(scope, id);
        kept.push(item);
    }
    return kept;
}

// The one-slot write gate every mutation runs through, so a file write and its index commit stay a pair and
// preconditions are evaluated against the state they'll overwrite. It also carries the dirty set: a resource
// whose file wrote but whose index commit threw is marked here, and the next call — mutation or read —
// re-indexes it before observing the index, so nothing is ever served past a torn write. `recover` is the
// domain's re-index; it receives the whole dirty list and settles it in whatever order it likes. Process
// death takes the set with it, which is what a domain's durable write journal is for.
export class WriteGate {
    private readonly lock = new Semaphore(1);
    private readonly dirty = new Set<string>();

    constructor(private readonly recover: (keys: string[]) => Promise<void>) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        return this.lock.run(async () => {
            await this.drain();
            return fn();
        });
    }

    // The fail-closed read guard, free on the hot path: an empty set takes no lock. Mutations drain inside
    // `run`, so only lock-free reads call this — the body of a `run` never can, because the drain at its
    // entry leaves the set empty and every path that marks a key inside the lock rethrows straight out.
    async ensureDrained(): Promise<void> {
        if (this.dirty.size) await this.lock.run(() => this.drain());
    }

    markDirty(key: string): void {
        this.dirty.add(key);
    }

    // Init's recovery seam: finish the work a process death cut in half. It may not be fatal — a home whose
    // init throws is a home the user cannot open at all — so a key that won't recover is dropped with a
    // warning, and the domain's journal row brings it back on the next init.
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

    // Caller holds the lock. A recovery that throws leaves its whole batch marked for the next drain.
    private async drain(): Promise<void> {
        if (this.dirty.size === 0) return;
        const keys = [...this.dirty];
        await this.recover(keys);
        for (const key of keys) this.dirty.delete(key);
    }
}
