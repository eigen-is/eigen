// Makes this API process the only one on its data folder, because two of them corrupt its databases. The entry
// point imports it before anything opens a database. It takes the file lock, which refuses a second process on this
// kernel, and then the lease, which refuses one the lock does not reach and is kept alive by a heartbeat until the
// graceful shutdown releases it.

import { rmSync } from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import type { DataLease } from './lib/config/data-lock';
import {
    DATA_LEASE_FILE,
    DATA_LOCK_FILE,
    LEASE_HEARTBEAT_MS,
    liveLeaseAfterWait,
    lockDataDir,
    lockScope,
    readLease,
    writeLease,
} from './lib/config/data-lock';
import { getDataRoot, getServerDataPath } from './lib/config/paths';

const dataRoot = path.resolve(getDataRoot());
const leaseFile = getServerDataPath(DATA_LEASE_FILE);

// Exported so the connection stays referenced for the life of the process.
export const instanceLock = holdInstanceLock();
const lease = holdInstanceLease();
let beatFailed = false;
// Unref'd, so a process that has nothing else to do still exits.
const heartbeat = setInterval(beat, LEASE_HEARTBEAT_MS).unref();

// Called by the graceful shutdown once the homes are closed, so the heartbeat runs through the whole drain.
export function releaseInstanceLease(): void {
    clearInterval(heartbeat);
    if (readLease(leaseFile)?.id === lease.id) rmSync(leaseFile);
}

function holdInstanceLock() {
    const lock = lockDataDir(getServerDataPath(DATA_LOCK_FILE));
    if (lock) return lock;
    console.error(`Another Eigen API process is already using the data dir ${dataRoot}; exiting.`);
    process.exit(1);
}

function holdInstanceLease(): DataLease {
    const live = liveLeaseAfterWait(leaseFile);
    if (live) {
        console.error(
            `Another Eigen API is using the data dir ${dataRoot}: ${live.host}, pid ${live.pid} (${live.platform}), still heartbeating. Two APIs on one data dir corrupt its databases; exiting. If this folder is shared between a container and the host, give each its own data folder.`,
        );
        process.exit(1);
    }
    const now = new Date().toISOString();
    const ours = {
        id: crypto.randomUUID(),
        host: hostname(),
        ...lockScope(leaseFile),
        pid: process.pid,
        platform: process.platform,
        startedAt: now,
        heartbeatAt: now,
    };
    writeLease(leaseFile, ours);
    return ours;
}

// A lease with another id means an API on another kernel took over. This one exits at once, with no graceful
// shutdown, because that would write more.
function beat() {
    try {
        const current = readLease(leaseFile);
        if (current && current.id !== lease.id) {
            console.error(
                `Another Eigen API took over the data dir ${dataRoot}: ${current.host}, pid ${current.pid}; exiting so only one writes.`,
            );
            process.exit(1);
        }
        writeLease(leaseFile, { ...lease, heartbeatAt: new Date().toISOString() });
    } catch (err) {
        // The file lock still holds on this kernel, so the next beat tries again.
        if (!beatFailed) console.error('[instance-lock] could not write the data dir lease:', err);
        beatFailed = true;
    }
}
