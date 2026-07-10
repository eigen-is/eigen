import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { COMMENT_INDEX_DB_CONFIG } from '../lib/chat/comment-db-config';

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

describe('comment-db v4 migration', () => {
    test('adds assignee column to an existing v3 database', () => {
        const db = new Database(':memory:');
        migrateUpTo(db, 3);
        db.exec("INSERT INTO comments (chatName) VALUES ('legacy.eigenchat');");

        const v4 = COMMENT_INDEX_DB_CONFIG.migrations.find((m) => m.version === 4)!;
        v4.up(db);

        const cols = db.query<{ name: string }, []>('PRAGMA table_info(comments);').all();
        expect(cols.some((c) => c.name === 'assignee')).toBe(true);
        const row = db
            .query<{ assignee: string | null }, []>(
                "SELECT assignee FROM comments WHERE chatName = 'legacy.eigenchat';",
            )
            .get();
        expect(row?.assignee).toBeNull();
    });

    test('assignee updates do not churn the FTS shadow (comments_au gate holds)', () => {
        const db = new Database(':memory:');
        for (const m of COMMENT_INDEX_DB_CONFIG.migrations) m.up(db);
        db.exec("INSERT INTO comments (chatName, recentText) VALUES ('t.eigenchat', 'alpha');");
        db.exec("UPDATE comments SET assignee = 'bob@test.eigen.is' WHERE chatName = 't.eigenchat';");
        expect(ftsMatch(db, 'alpha')).toBe('t.eigenchat');
    });

    test('fresh database ends at v4 with assignee present', () => {
        const db = new Database(':memory:');
        for (const m of COMMENT_INDEX_DB_CONFIG.migrations) m.up(db);
        const cols = db.query<{ name: string }, []>('PRAGMA table_info(comments);').all();
        expect(cols.some((c) => c.name === 'assignee')).toBe(true);
    });
});
