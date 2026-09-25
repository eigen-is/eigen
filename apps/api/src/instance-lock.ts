import * as path from 'node:path';
import { DATA_LOCK_FILE, lockDataDir } from './lib/config/data-lock';
import { getDataRoot, getServerDataPath } from './lib/config/paths';

// Two API processes on one data dir corrupt its databases.
function holdInstanceLock() {
    const lock = lockDataDir(getServerDataPath(DATA_LOCK_FILE));
    if (lock) return lock;
    console.error(`Another Eigen API process is already using the data dir ${path.resolve(getDataRoot())}; exiting.`);
    process.exit(1);
}

// Exported so the connection stays referenced for the life of the process.
export const instanceLock = holdInstanceLock();
