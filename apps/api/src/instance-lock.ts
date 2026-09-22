import { Database, SQLiteError } from 'bun:sqlite';
import * as path from 'node:path';
import { getDataRoot, getServerDataPath } from './lib/config/paths';

// Two API processes on one data dir corrupt its databases; an open write transaction is a lock the OS drops on exit.
function holdInstanceLock(): Database {
    const db = new Database(getServerDataPath('instance.lock'), { create: true });
    try {
        db.run('PRAGMA locking_mode = EXCLUSIVE;');
        // IMMEDIATE, not EXCLUSIVE: two processes starting together both hold SHARED, and EXCLUSIVE fails them both.
        db.run('BEGIN IMMEDIATE;');
        return db;
    } catch (err) {
        db.close();
        if (!(err instanceof SQLiteError) || err.code !== 'SQLITE_BUSY') throw err;
        console.error(
            `Another Eigen API process is already using the data dir ${path.resolve(getDataRoot())}; exiting.`,
        );
        process.exit(1);
    }
}

// Exported so the connection stays referenced for the life of the process.
export const instanceLock = holdInstanceLock();
