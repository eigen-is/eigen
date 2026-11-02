import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDatabases, UnopenableDatabaseError } from '../../lib/backup/materialize-mount';
import { SHARE_REGISTRY_DB_CONFIG } from '../../lib/share/db-config';
import { TEST_DATA_DIR } from '../setup';
import { holdLock } from './backup-test-helpers';

// The database check a restore and a rollback end on reads files another process may be writing, such as the live
// API's. A writer that holds its lock for a moment must be waited out, not read as a database at version 0 or one
// that is damaged.

const dir = mkdtempSync(join(TEST_DATA_DIR, 'check-databases-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function stampedDatabase(name: string, version: number): string {
    const filePath = join(dir, name);
    const db = new Database(filePath);
    try {
        db.run('CREATE TABLE __schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
        db.run('INSERT INTO __schema_version (id, version) VALUES (1, ?)', [version]);
    } finally {
        db.close();
    }
    return filePath;
}

describe('checkDatabases', () => {
    test('waits out a writer, then judges the database as it is', async () => {
        const current = stampedDatabase('current.db', SHARE_REGISTRY_DB_CONFIG.currentVersion);
        let lock = await holdLock(current, 1000);
        await checkDatabases([{ filePath: current, config: SHARE_REGISTRY_DB_CONFIG }]);
        expect(await lock.exited).toBe(0);

        const newer = stampedDatabase('newer.db', SHARE_REGISTRY_DB_CONFIG.currentVersion + 1);
        lock = await holdLock(newer, 1000);
        await expect(checkDatabases([{ filePath: newer, config: SHARE_REGISTRY_DB_CONFIG }])).rejects.toThrow(
            'newer than this server',
        );
        expect(await lock.exited).toBe(0);
    }, 20_000);

    test('calls a database that is damaged or newer unopenable, and a lock held past the wait no verdict', async () => {
        const check = (filePath: string) => checkDatabases([{ filePath, config: SHARE_REGISTRY_DB_CONFIG }]);
        const newer = stampedDatabase('newer-verdict.db', SHARE_REGISTRY_DB_CONFIG.currentVersion + 1);
        await expect(check(newer)).rejects.toBeInstanceOf(UnopenableDatabaseError);
        const text = join(dir, 'text.db');
        writeFileSync(text, 'not a database at all, only text that is long enough to fill a header of one');
        await expect(check(text)).rejects.toBeInstanceOf(UnopenableDatabaseError);

        // A rollback reads this as a check that could not run, so it keeps today's data rather than put a backup back.
        const busy = stampedDatabase('busy.db', SHARE_REGISTRY_DB_CONFIG.currentVersion);
        const lock = await holdLock(busy, 7000);
        const error = await check(busy).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(UnopenableDatabaseError);
        expect(await lock.exited).toBe(0);
    }, 30_000);

    // The stamp and the quick_check are read on one open, so a lock that outlasts the wait for the stamp fails the
    // check there. It must not read as version 0 and let a newer database through once the lock is gone.
    test('a newer database whose writer outlasts one wait is not passed', async () => {
        const newer = stampedDatabase('newer-busy.db', SHARE_REGISTRY_DB_CONFIG.currentVersion + 1);
        const lock = await holdLock(newer, 7000);
        const checked = checkDatabases([{ filePath: newer, config: SHARE_REGISTRY_DB_CONFIG }]);
        await expect(checked).rejects.toThrow();
        expect(await lock.exited).toBe(0);
    }, 30_000);

    test('lets other work run between databases, so the API serves while it checks a large home', async () => {
        const current = stampedDatabase('many.db', SHARE_REGISTRY_DB_CONFIG.currentVersion);
        const targets = Array.from({ length: 120 }, () => ({ filePath: current, config: SHARE_REGISTRY_DB_CONFIG }));
        let served = false;
        setImmediate(() => {
            served = true;
        });
        await checkDatabases(targets);
        expect(served).toBe(true);
    });
});
