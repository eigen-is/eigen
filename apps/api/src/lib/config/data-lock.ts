// What keeps two writers off one data folder. A file lock refuses a second process on the same kernel, and a lease
// file with a heartbeat refuses one the lock does not reach, such as the Mac host beside a Docker Desktop container.
// The API holds both while it runs, and the swap of ./eigen restore checks them before it replaces data/. Everything
// here is synchronous, so both can run it before anything else opens a database.

import { Database, SQLiteError } from 'bun:sqlite';
import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isRecord } from '@workspace/lib/guards';

// In data/server/: the API holds it while it runs, and the swap of ./eigen restore while it replaces data/.
export const DATA_LOCK_FILE = 'instance.lock';
// In data/server/ beside it: only the API writes it, the swap only reads it.
export const DATA_LEASE_FILE = 'instance.lease';
export const LEASE_HEARTBEAT_MS = 5_000;
// A lease that did not move in this time has no live holder. It is six heartbeats long because a synchronous boot or
// VACUUM blocks the holder's event loop, and so its heartbeat, for a while.
export const LEASE_WAIT_MS = 30_000;
// A lease that does not parse cannot say whose it is.
const UNKNOWN_HOLDER = 'an unknown host (the lease does not parse)';

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
// file locks need not reach. A bind mount keeps the device number of the file system it shows. A 9p or virtiofs view
// of the same folder has its own.
export function lockScope(file: string): Pick<DataLease, 'kernel' | 'dev'> {
    const kernel =
        process.platform === 'linux'
            ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
            : `${process.platform}:${hostname()}`;
    return { kernel, dev: statSync(dirname(file)).dev };
}

// A missing lease, or one that does not parse, is no lease.
export function readLease(file: string): DataLease | null {
    const text = readLeaseText(file);
    return text === null ? null : parseLease(text);
}

// A rename in one folder is atomic, so a reader sees the old lease or the new one. There is no fsync: a lease lost in
// a power cut is the same as none.
export function writeLease(file: string, lease: DataLease): void {
    const temp = join(dirname(file), `.${basename(file)}.tmp-${lease.id}`);
    writeFileSync(temp, JSON.stringify(lease));
    renameSync(temp, file);
}

// Who holds a lease from outside the caller's lock scope that is still heartbeating, or null. A lease from inside it
// has no live holder, because the caller holds the file lock it would hold. A lease that does not parse may be from
// anywhere, so it is waited on too. No clock is compared across machines: a lease is live only when it changed during
// the wait.
export function liveLeaseHolder(file: string, warn: (message: string) => void): string | null {
    const before = readLeaseText(file);
    if (before === null) return null;
    const lease = parseLease(before);
    const scope = lockScope(file);
    if (lease?.kernel === scope.kernel && lease.dev === scope.dev) return null;
    const holder = lease ? describeHolder(lease) : UNKNOWN_HOLDER;
    const last = lease ? `, last heartbeat ${lease.heartbeatAt}` : '';
    warn(
        `The data dir lease is held by ${holder}${last}; waiting ${LEASE_WAIT_MS / 1000} s to see whether it is alive.`,
    );
    Bun.sleepSync(LEASE_WAIT_MS);
    const after = readLeaseText(file);
    if (after === null) return null;
    if (after === before) {
        warn('The data dir lease did not move, so it is stale.');
        return null;
    }
    const moved = parseLease(after);
    return moved ? describeHolder(moved) : UNKNOWN_HOLDER;
}

// Only a regular file is read, never through a symlink, so a FIFO or a device planted in its place cannot hang or fill
// the swap, which runs as root. O_NONBLOCK makes the open of a FIFO return at once. The check is on the opened file, so
// nothing can replace the path between the check and the read. Null when there is no lease.
function readLeaseText(file: string): string | null {
    let fd: number;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
        if (err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ELOOP')) return null;
        throw err;
    }
    try {
        return fstatSync(fd).isFile() ? readFileSync(fd, 'utf8') : null;
    } finally {
        closeSync(fd);
    }
}

function parseLease(text: string): DataLease | null {
    try {
        const value: unknown = JSON.parse(text);
        return isDataLease(value) ? value : null;
    } catch {
        return null;
    }
}

function isDataLease(value: unknown): value is DataLease {
    return (
        isRecord(value) &&
        typeof value['id'] === 'string' &&
        typeof value['host'] === 'string' &&
        typeof value['kernel'] === 'string' &&
        typeof value['dev'] === 'number' &&
        typeof value['pid'] === 'number' &&
        typeof value['platform'] === 'string' &&
        typeof value['startedAt'] === 'string' &&
        typeof value['heartbeatAt'] === 'string'
    );
}

function describeHolder(lease: DataLease): string {
    return `${lease.host}, pid ${lease.pid} (${lease.platform})`;
}
