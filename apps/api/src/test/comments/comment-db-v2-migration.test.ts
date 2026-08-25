import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { COMMENT_INDEX_DB_CONFIG } from '../../lib/chat/comment-db-config';

describe('comment-db v2 migration', () => {
    test('ALTER adds createdBy column to an existing v1 database', () => {
        const db = new Database(':memory:');
        const v1 = COMMENT_INDEX_DB_CONFIG.migrations.find((m) => m.version === 1)!;
        v1.up(db);
        db.exec("INSERT INTO comments (chatName) VALUES ('legacy.eigenchat');");

        const v2 = COMMENT_INDEX_DB_CONFIG.migrations.find((m) => m.version === 2)!;
        v2.up(db);

        const cols = db.query<{ name: string }, []>('PRAGMA table_info(comments);').all();
        expect(cols.some((c) => c.name === 'createdBy')).toBe(true);

        const row = db
            .query<{ chatName: string; createdBy: string | null }, []>(
                "SELECT chatName, createdBy FROM comments WHERE chatName = 'legacy.eigenchat';",
            )
            .get();
        expect(row?.chatName).toBe('legacy.eigenchat');
        expect(row?.createdBy).toBeNull();
    });

    test('fresh database v1 then v2 ends in v2 state', () => {
        const db = new Database(':memory:');
        for (const m of COMMENT_INDEX_DB_CONFIG.migrations) m.up(db);
        const cols = db.query<{ name: string }, []>('PRAGMA table_info(comments);').all();
        expect(cols.some((c) => c.name === 'createdBy')).toBe(true);
    });
});
