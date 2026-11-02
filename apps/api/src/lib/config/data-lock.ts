// What keeps two writers off one data folder. A file lock refuses a second process on the same kernel, and a lease
// file with a heartbeat refuses one the lock does not reach, such as the Mac host beside a Docker Desktop container. The API holds both while it runs, and the swap of ./eigen restore checks them before it
// replaces data/. Everything here is synchronous, so both can run it before anything else opens a database.

import { Database, SQLiteError } from 'bun:sqlite';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

// In data/server/: the API holds it while it runs, and the swap of ./eigen restore while it replaces data/.
export const DATA_LOCK_FILE = 'instance.lock';
// In data/server/ beside it: only the API writes it, the swap only reads it.
export const DATA_LEASE_FILE = 'instance.lease';
export const LEASE_HEARTBEAT_MS = 5_000;
// Two missed heartbeats: a lease that did not move in this time has no live holder.
export const LEASE_WAIT_MS = 2 * LEASE_HEARTBEAT_MS;

// The file systems of a folder a VM shares from its host, such as Docker Desktop's bind mounts: virtiofs today,
// grpcfuse and osxfs in older releases, 9p for Windows drives under WSL2 and for qemu VMs.
const SHARED_MOUNT_TYPES: ReadonlySet<string> = new Set(['virtiofs', 'fuse.grpcfuse', 'fuse.osxfs', '9p']);

// `kernel` and `dev` say whose file lock the holder shares. `host` and `pid` are only for the messages: a container's
// hostname changes when Compose recreates it.
export type DataLease = {
    id: string;
    host: string;
    kernel: string;
    dev: number;
    pid: number;
    platform: string;
    startedAt: string;
    heartbeatAt: string;
};

// An open write transaction is a lock the OS drops on exit, however the holder ends. Null when another process holds it.
export function lockDataDir(file: string): Database | null {
    const db = new Database(file, { create: true });
    try {
        db.run('PRAGMA locking_mode = EXCLUSIVE;');
        // IMMEDIATE, not EXCLUSIVE: two processes starting together both hold SHARED, and EXCLUSIVE fails them both.
        db.run('BEGIN IMMEDIATE;');
        return db;
    } catch (err) {
        db.close();
        if (!(err instanceof SQLiteError) || err.code !== 'SQLITE_BUSY') throw err;
        return null;
    }
}

// The processes that share the file lock on `file`: one kernel, seeing its folder through one file system. On Linux
// the boot id is the same in every container of one VM and in the VM itself, and a restart of the VM changes it. One
// kernel is not enough, because WSL2 runs every distro on one kernel and shares folders between them over 9p, where
// file locks need not reach. A bind mount keeps the device number of the file system it shows; a 9p or virtiofs view
// of the same folder has its own.
export function lockScope(file: string): Pick<DataLease, 'kernel' | 'dev'> {
    const kernel =
        process.platform === 'linux'
            ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
            : `${process.platform}:${hostname()}`;
    return { kernel, dev: statSync(dirname(file)).dev };
}

// A missing or half-readable lease is no lease.
export function readLease(file: string): DataLease | null {
    let text: string;
    try {
        text = readFileSync(file, 'utf8');
    } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
        throw err;
    }
    try {
        const value: unknown = JSON.parse(text);
        return isDataLease(value) ? value : null;
    } catch {
        return null;
    }
}

// A rename in one folder is atomic, so a reader sees the old lease or the new one. There is no fsync: a lease lost in
// a power cut is the same as none.
export function writeLease(file: string, lease: DataLease): void {
    const temp = join(dirname(file), `.${basename(file)}.tmp-${lease.id}`);
    writeFileSync(temp, JSON.stringify(lease));
    renameSync(temp, file);
}

// The lease of a process outside the caller's lock scope that is still heartbeating, or null. A lease from inside it
// has no live holder, because the caller holds the file lock it would hold. No clock is compared across machines: a
// lease is live only when it moved during the wait.
export function liveLeaseAfterWait(file: string): DataLease | null {
    const before = readLease(file);
    if (!before) return null;
    const scope = lockScope(file);
    if (before.kernel === scope.kernel && before.dev === scope.dev) return null;
    console.warn(
        `Data dir lease held by ${before.host} (pid ${before.pid}, ${before.platform}), last heartbeat ${before.heartbeatAt}; waiting ${LEASE_WAIT_MS / 1000} s to see whether it is alive.`,
    );
    Bun.sleepSync(LEASE_WAIT_MS);
    const after = readLease(file);
    if (after && (after.id !== before.id || after.heartbeatAt !== before.heartbeatAt)) return after;
    if (after) console.warn(`The lease of ${before.host} (pid ${before.pid}) did not move, so it is stale.`);
    return null;
}

// The file system type of `root` when it is a folder shared from another machine or VM, or null. `mounts` is the text
// of /proc/mounts, whose mount points escape a space, a tab, a newline and a backslash as octal.
export function sharedMountType(root: string, mounts: string): string | null {
    let found: { point: string; type: string } | undefined;
    for (const line of mounts.split('\n')) {
        const [, escaped, type] = line.split(' ');
        if (!escaped || !type) continue;
        const point = escaped.replace(/\\([0-7]{3})/g, (_, code: string) =>
            String.fromCharCode(Number.parseInt(code, 8)),
        );
        const inside = root === point || root.startsWith(point.endsWith('/') ? point : `${point}/`);
        // The later of two mounts on one point is the one on top.
        if (inside && point.length >= (found?.point.length ?? 0)) found = { point, type };
    }
    return found && SHARED_MOUNT_TYPES.has(found.type) ? found.type : null;
}

function isDataLease(value: unknown): value is DataLease {
    return (
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        typeof value.id === 'string' &&
        'host' in value &&
        typeof value.host === 'string' &&
        'kernel' in value &&
        typeof value.kernel === 'string' &&
        'dev' in value &&
        typeof value.dev === 'number' &&
        'pid' in value &&
        typeof value.pid === 'number' &&
        'platform' in value &&
        typeof value.platform === 'string' &&
        'startedAt' in value &&
        typeof value.startedAt === 'string' &&
        'heartbeatAt' in value &&
        typeof value.heartbeatAt === 'string'
    );
}
