import { Database, SQLiteError } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Two API processes on one data dir corrupt its databases (each thinks it is the only writer), so the second one
// refuses to start. An exclusive SQLite transaction is the lock: a POSIX file lock the OS drops when the process dies.
// The caller keeps the returned connection referenced for the life of the process.
export function holdInstanceLock(dataRoot: string): Database {
    const serverDir = path.join(dataRoot, 'server');
    fs.mkdirSync(serverDir, { recursive: true });
    const db = new Database(path.join(serverDir, 'instance.lock'), { create: true });
    try {
        db.run('PRAGMA locking_mode = EXCLUSIVE;');
        db.run('BEGIN EXCLUSIVE;');
    } catch (err) {
        db.close();
        if (!(err instanceof SQLiteError) || err.code !== 'SQLITE_BUSY') throw err;
        console.error(`Another Eigen API process is already using the data dir ${path.resolve(dataRoot)}; exiting.`);
        process.exit(1);
    }
    return db;
}
