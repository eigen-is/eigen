import { Database, SQLiteError } from 'bun:sqlite';
import * as path from 'node:path';
import { getDataRoot, getServerDataPath } from './lib/config/paths';

// Two API processes on one data dir corrupt its databases (each thinks it is the only writer), so the second one
// refuses to start. An open write transaction on a SQLite file is the lock: a POSIX file lock the OS drops when the
// process dies. Its own module so index.ts can import it ahead of ./app, whose modules open server databases as they load.
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
