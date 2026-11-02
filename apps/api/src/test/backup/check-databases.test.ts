import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkDatabases } from '../../lib/backup/materialize-mount';
import { SHARE_REGISTRY_DB_CONFIG } from '../../lib/share/db-config';
import { TEST_DATA_DIR } from '../setup';

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

// Another process holds the database's write lock for `ms`, from the moment this resolves.
async function holdLock(filePath: string, ms: number): Promise<{ exited: Promise<number> }> {
    const script = [
        `import { Database } from 'bun:sqlite';`,
        `const db = new Database(${JSON.stringify(filePath)});`,
        `db.run('BEGIN EXCLUSIVE');`,
        `db.run('UPDATE __schema_version SET version = version WHERE id = 1');`,
        `console.log('locked');`,
        `await Bun.sleep(${ms});`,
        `db.run('COMMIT');`,
        'db.close();',
    ].join('\n');
    const proc = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' });
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('locked');
    return { exited: proc.exited };
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
