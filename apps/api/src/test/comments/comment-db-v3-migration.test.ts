import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { COMMENT_INDEX_DB_CONFIG } from '../../lib/chat/comment-db-config';

function migrateUpTo(db: Database, version: number) {
    for (const m of COMMENT_INDEX_DB_CONFIG.migrations) {
        if (m.version <= version) m.up(db);
    }
}

function ftsMatch(db: Database, term: string): string | undefined {
    return db
        .query<{ chatName: string }, []>(
            `SELECT c.chatName AS chatName FROM comments_fts JOIN comments c ON c.rowid = comments_fts.rowid WHERE comments_fts MATCH '${term}';`,
        )
        .get()?.chatName;
}

describe('comment-db v3 migration', () => {
    test('adds recentText + comments_fts and backfills from lastMessageSnippet', () => {
        const db = new Database(':memory:');
        migrateUpTo(db, 2);
        db.exec(
            "INSERT INTO comments (chatName, lastMessageSnippet) VALUES ('legacy.eigenchat', 'hello pineapple world');",
        );

        const v3 = COMMENT_INDEX_DB_CONFIG.migrations.find((m) => m.version === 3)!;
        v3.up(db);

        const cols = db.query<{ name: string }, []>('PRAGMA table_info(comments);').all();
        expect(cols.some((c) => c.name === 'recentText')).toBe(true);

        const row = db
            .query<{ recentText: string | null }, []>(
                "SELECT recentText FROM comments WHERE chatName = 'legacy.eigenchat';",
            )
            .get();
        expect(row?.recentText).toBe('hello pineapple world');
        expect(ftsMatch(db, 'pineapple')).toBe('legacy.eigenchat');
    });

    test('AFTER UPDATE only re-indexes when recentText changes', () => {
        const db = new Database(':memory:');
        for (const m of COMMENT_INDEX_DB_CONFIG.migrations) m.up(db);
        db.exec("INSERT INTO comments (chatName, recentText) VALUES ('t.eigenchat', 'alpha');");

        // Status-only update must leave the FTS body intact (gate holds).
        db.exec("UPDATE comments SET status = 'resolved' WHERE chatName = 't.eigenchat';");
        expect(ftsMatch(db, 'alpha')).toBe('t.eigenchat');

        // A recentText change re-indexes.
        db.exec("UPDATE comments SET recentText = 'beta' WHERE chatName = 't.eigenchat';");
        expect(ftsMatch(db, 'beta')).toBe('t.eigenchat');
        expect(ftsMatch(db, 'alpha')).toBeUndefined();
    });

    test('deleting a comment row scrubs it from the FTS index', () => {
        const db = new Database(':memory:');
        for (const m of COMMENT_INDEX_DB_CONFIG.migrations) m.up(db);
        db.exec("INSERT INTO comments (chatName, recentText) VALUES ('d.eigenchat', 'gamma');");
        expect(ftsMatch(db, 'gamma')).toBe('d.eigenchat');

        db.exec("DELETE FROM comments WHERE chatName = 'd.eigenchat';");
        expect(ftsMatch(db, 'gamma')).toBeUndefined();
    });

    test('fresh database ends at v3 with recentText present', () => {
        const db = new Database(':memory:');
        for (const m of COMMENT_INDEX_DB_CONFIG.migrations) m.up(db);
        const cols = db.query<{ name: string }, []>('PRAGMA table_info(comments);').all();
        expect(cols.some((c) => c.name === 'recentText')).toBe(true);
    });
});
