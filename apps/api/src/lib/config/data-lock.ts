import { Database, SQLiteError } from 'bun:sqlite';

// In data/server/: the API holds it while it runs, and the swap of ./eigen restore while it replaces data/.
export const DATA_LOCK_FILE = 'instance.lock';

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
