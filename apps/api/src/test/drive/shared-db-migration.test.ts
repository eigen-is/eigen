import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { SHARED_DB_CONFIG } from '../../lib/drive/db-config';

function migrate(db: Database, from: number, to: number): void {
    for (const migration of SHARED_DB_CONFIG.migrations) {
        if (migration.version > from && migration.version <= to) migration.up(db);
    }
}

describe('shared.db v3 migration', () => {
    test('a v2 database keeps each row as its pointer and its share date, and nothing else', () => {
        const db = new Database(':memory:');
        migrate(db, 0, 2);
        db.exec(`
            INSERT INTO shared_paths (id, mountId, name, type, parentId, size, thumbnail, ownerId, mimeType, acl, createdAt, updatedAt)
            VALUES ('path-1', 'default', 'a.txt', 'file', 'folder-1', 7, 'a.webp', 'owner-1', 'text/plain', '[]', 1700000000, 1800000000),
                   ('path-2', 'photos', 'b', 'folder', NULL, 0, NULL, 'team_2', 'inode/directory', NULL, 1750000000, 1750000000);
            INSERT INTO recent_paths (ownerId, mountId, pathId, lastActivityAt) VALUES ('owner-1', 'default', 'path-1', 1);
        `);

        migrate(db, 2, 3);

        expect(db.query('SELECT * FROM shared_paths ORDER BY pathId').all()).toEqual([
            { ownerId: 'owner-1', mountId: 'default', pathId: 'path-1', sharedAt: 1700000000 },
            { ownerId: 'team_2', mountId: 'photos', pathId: 'path-2', sharedAt: 1750000000 },
        ]);
        expect(db.query('SELECT COUNT(*) AS rows FROM recent_paths').get()).toEqual({ rows: 1 });
    });

    test('a new database takes one row per path of an owner', () => {
        const db = new Database(':memory:');
        migrate(db, 0, SHARED_DB_CONFIG.currentVersion);
        const insert = "INSERT INTO shared_paths (ownerId, mountId, pathId, sharedAt) VALUES ('o', 'm', 'p', 1)";
        db.exec(insert);
        expect(() => db.exec(insert)).toThrow();
    });
});
