import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { MountConfig, S3Config } from '@workspace/lib/types';
import type { BunFile } from 'bun';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import type Drive from '../lib/drive/drive';
import { Mount } from '../lib/mount/mount';
import type { StorageBackend, StorageFile } from '../lib/storage';
import { LocalStorage } from '../lib/storage/local-storage';

// Shared storage double for the resilience suites (upload queue, mutation sync, create/open paths):
// a StorageBackend over a real LocalStorage whose writes can fail, be delayed, hang or be parked,
// whose exists() probes can fail, and whose reads can fail for chosen keys. Omits getPath so a mount
// treats it like S3 (temp-copy path), not a path-based local store.

export type ParkedWrite = {
    key: string;
    bytes: Uint8Array | ArrayBuffer | Buffer;
    landed: boolean;
    commit: () => Promise<void>; // the server applies the bytes; the client response stays pending
    respond: () => void; // deliver the (long-forgotten) client response
    land: () => Promise<void>; // commit + respond
};

export class FaultStorage implements StorageBackend {
    failNextWrites = 0;
    failNextExists = 0;
    writeDelayMs = 0;
    writeCount = 0;
    // Park every write until releaseHungWrites() — models a TCP-black-holed PUT that never
    // resolves, so only the queue's client-side timeout can end the wait.
    hangWrites = false;
    // Park each write individually: the body is captured up-front (as a real PUT streams its
    // request body) and reaches the inner store only when the test lands it — so completions can
    // be reordered exactly like orphaned requests landing late server-side.
    parkWrites = false;
    // Objects whose GET fails: read() throws for these keys. Targets ONE object (e.g. a container's
    // comments.db) where a fail-next counter would hit whichever request happens to come first.
    readonly failReadKeys = new Set<string>();
    readonly parked: ParkedWrite[] = [];
    private hungResolvers: Array<() => void> = [];
    private parkWaiters: Array<() => void> = [];

    constructor(readonly inner: StorageBackend) {}

    // Let any parked writes proceed so a hung PUT promise doesn't linger past the test.
    releaseHungWrites(): void {
        this.hangWrites = false;
        for (const resolve of this.hungResolvers.splice(0)) resolve();
    }

    get parkedCount(): number {
        return this.parked.filter((p) => !p.landed).length;
    }

    // Complete the oldest parked write: its captured bytes land on the backing store NOW — after
    // whatever else the test let happen in between — and its (long-forgotten) promise resolves.
    async releaseOldestParked(): Promise<void> {
        const oldest = this.parked.find((p) => !p.landed);
        if (!oldest) throw new Error('no parked write to release');
        await oldest.land();
    }

    // Resolve when a parked PUT matching the predicate exists (event-driven, so the test can land a
    // PUT within the queue's shrunk client-side timeout).
    async waitForParked(
        match: (p: ParkedWrite) => boolean | Promise<boolean>,
        timeoutMs = 3_000,
    ): Promise<ParkedWrite> {
        const end = Date.now() + timeoutMs;
        for (;;) {
            for (const p of this.parked) {
                if (!p.landed && (await match(p))) return p;
            }
            if (Date.now() > end) throw new Error('waitForParked timeout');
            await new Promise<void>((r) => {
                this.parkWaiters.push(r);
                setTimeout(r, 25);
            });
        }
    }

    async landAllRemaining(): Promise<void> {
        for (const p of this.parked) {
            if (!p.landed) await p.land();
        }
    }

    read(key: string): StorageFile {
        if (this.failReadKeys.has(key)) throw new Error(`injected read failure (503) for ${key}`);
        return this.inner.read(key);
    }
    async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        this.writeCount++;
        // Read the body up-front, like an S3 PUT streaming the request body — so a concurrent
        // unlink of the staging file can't abort an already-started upload. This is what makes
        // the resurrection window (cancel during an in-flight PUT) reproducible.
        const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
        if (this.hangWrites) await new Promise<void>((resolve) => this.hungResolvers.push(resolve));
        if (this.writeDelayMs > 0) await Bun.sleep(this.writeDelayMs);
        if (this.failNextWrites > 0) {
            this.failNextWrites--;
            throw new Error('injected upload failure (503)');
        }
        if (!this.parkWrites) return this.inner.write(key, bytes);
        return new Promise<number>((resolve, reject) => {
            const entry: ParkedWrite = {
                key,
                bytes,
                landed: false,
                commit: async () => {
                    entry.landed = true;
                    await this.inner.write(key, bytes).catch(reject);
                },
                respond: () => resolve(bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length),
                land: async () => {
                    await entry.commit();
                    entry.respond();
                },
            };
            this.parked.push(entry);
            for (const w of this.parkWaiters.splice(0)) w();
        });
    }
    async delete(key: string): Promise<boolean> {
        return this.inner.delete(key);
    }
    async exists(key: string): Promise<boolean> {
        if (this.failNextExists > 0) {
            this.failNextExists--;
            throw new Error('injected exists failure (503)');
        }
        return this.inner.exists(key);
    }
    async size(key: string): Promise<number | null> {
        return this.inner.size(key);
    }
}

const DUMMY_S3: S3Config = {
    endpoint: 'http://127.0.0.1:1',
    bucket: 'test',
    accessKeyId: 'x',
    secretAccessKey: 'y',
    region: 'us-east-1',
    prefix: '',
};

// A distinct bucket per id gives each mount its own destination semaphore (matching the
// per-destination design).
export function createS3MountConfig(id: string): MountConfig {
    return {
        id,
        name: id,
        storageType: 's3',
        isDefault: false,
        s3Config: { ...DUMMY_S3, bucket: `bucket-${id}` },
    };
}

export function createGetLocalDatabase(baseDir: string) {
    return async <S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> => {
        const db = new ManagedDatabase(config, join(baseDir, relativePath));
        await db.open(0);
        return db;
    };
}

// An s3-type mount backed by a FaultStorage over a local directory. Same `id` ⇒ same baseDir +
// backing dir ⇒ a second call simulates a process restart that shares the prior mount's
// metadata.db, staging dir, and "S3" object store. The caller still owns init().
export function createFaultMount(ownerId: string, baseDir: string, id: string): { mount: Mount; fault: FaultStorage } {
    const mount = new Mount(ownerId, baseDir, createS3MountConfig(id), createGetLocalDatabase(baseDir));
    const fault = new FaultStorage(new LocalStorage(join(baseDir, `backing-${id}`)));
    mount.storage = fault;
    return { mount, fault };
}

// Drive keeps its mounts in a private map, and a fault mount only reaches Drive.create (or the
// collab routes) once it is in there. One cast, one place.
function driveMounts(drive: Drive): Map<string, Mount> {
    return (drive as unknown as { mounts: Map<string, Mount> }).mounts;
}

export function registerFaultMount(drive: Drive, mount: Mount): void {
    driveMounts(drive).set(mount.id, mount);
}

export function unregisterFaultMount(drive: Drive, mountId: string): void {
    driveMounts(drive).delete(mountId);
}

// A create-time storage failure only reproduces when the next open really reaches storage: close
// the container's managed dbs and drain the write-behind queue, so neither a live temp nor a staged
// copy can serve that open. Never closeAllDatabases here — it also closes the mount's upload queue
// for good, and every later upload in the file would silently stop.
export async function settleContainer(mount: Mount, containerId: string): Promise<void> {
    for (const name of ['data.db', 'comments.db']) {
        const child = await mount.getChildByName(containerId, name);
        if (child) await mount.closeDatabase(child.id);
    }
    await mount.drainPendingUploads({ flushNow: true });
}

export async function provisionDoc(mount: Mount): Promise<{ containerId: string; dataDbId: string }> {
    const rootId = (await mount.getRootFolder())!.id;
    const containerId = await mount.createFolder(rootId, `doc-${Math.random().toString(36).slice(2)}`, 'doc');
    const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
    return { containerId, dataDbId };
}

// Open a throwaway non-WAL copy of a data.db StorageFile and count its rows (a readonly WAL open
// can't create its -shm sidecar).
export async function countRowsInFile(file: StorageFile | null, tmpDir: string): Promise<number | null> {
    if (!file || !(await file.exists())) return null;
    const verifyPath = join(tmpDir, `verify-${Math.random().toString(36).slice(2)}.db`);
    await Bun.write(verifyPath, await file.arrayBuffer());
    const verify = new Database(verifyPath);
    const row = verify.query('SELECT COUNT(*) as c FROM items').get() as { c: number };
    verify.close();
    return row.c;
}

// Count rows in the object that actually reached the backing store ("S3"/local). Reads storage
// directly — NOT via mount.readFile, which is freshest-first and would surface un-acked staged
// bytes; getStorageKey handles both the flat-key (s3) and hierarchical (local) layouts.
export async function countBackingRows(mount: Mount, id: string, tmpDir: string): Promise<number | null> {
    return countRowsInFile(mount.storage.read(await mount.getStorageKey(id)), tmpDir);
}

export function shrinkPutTimeout(mount: Mount, ms: number): void {
    (mount.uploadQueue as unknown as { putTimeoutMs: number }).putTimeoutMs = ms;
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await cond())) {
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await Bun.sleep(5);
    }
}
