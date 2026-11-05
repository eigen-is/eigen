// Makes this API process the only one on its data folder on this kernel, because two of them corrupt its databases.
// The entry point imports it before anything opens a database. It takes the file lock, which refuses a second process
// on this kernel but not one on another, such as the host beside a container, and holds it until the graceful
// shutdown releases it or the process exits.

import * as path from 'node:path';
import { DATA_LOCK_FILE, lockDataDir } from './lib/config/data-lock';
import { getDataRoot, getServerDataPath } from './lib/config/paths';

// releaseInstanceLock closes it, and that use keeps it: a bundle drops a binding nothing reads, and the garbage
// collector would then close the connection and its lock.
const instanceLock = holdInstanceLock();

// Called once the homes are closed by the graceful shutdown.
export function releaseInstanceLock(): void {
    instanceLock.close();
}

function holdInstanceLock() {
    const lock = lockDataDir(getServerDataPath(DATA_LOCK_FILE));
    if (lock) return lock;
    console.error(`Another Eigen API process is already using the data dir ${path.resolve(getDataRoot())}; exiting.`);
    process.exit(1);
}
