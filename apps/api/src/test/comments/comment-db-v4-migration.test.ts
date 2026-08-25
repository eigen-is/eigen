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

function columnNames(db: Database): string[] {
    return db
        .query<{ name: string }, []>('PRAGMA table_info(comments);')
        .all()
        .map((c) => c.name);
}

describe('comment-db v4 migration', () => {
    test('adds only the assignee column to an existing v3 database', () => {
        const db = new Database(':memory:');
        migrateUpTo(db, 3);
        db.exec("INSERT INTO comments (chatName) VALUES ('legacy.eigenchat');");

        const v4 = COMMENT_INDEX_DB_CONFIG.migrations.find((m) => m.version === 4)!;
        v4.up(db);

        // v4 must stay assignee-only forever: dev runtimes stamped it that way mid-build.
        expect(columnNames(db)).toContain('assignee');
        expect(columnNames(db)).not.toContain('title');
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
});

describe('comment-db v5 migration', () => {
    test('heals a database stamped v4 without title (the amended-migration incident)', () => {
        // Exactly the state a dev server left behind after running assignee-only v4.
        const db = new Database(':memory:');
        migrateUpTo(db, 4);
        db.exec("INSERT INTO comments (chatName, assignee) VALUES ('board.eigenchat', 'bob@test.eigen.is');");
        expect(columnNames(db)).not.toContain('title');

        const v5 = COMMENT_INDEX_DB_CONFIG.migrations.find((m) => m.version === 5)!;
        v5.up(db);

        expect(columnNames(db)).toContain('title');
        const row = db
            .query<{ assignee: string | null; title: string | null }, []>(
                "SELECT assignee, title FROM comments WHERE chatName = 'board.eigenchat';",
            )
            .get();
        expect(row?.assignee).toBe('bob@test.eigen.is');
        expect(row?.title).toBeNull();
        db.exec("UPDATE comments SET title = 'Fix header' WHERE chatName = 'board.eigenchat';");
    });

    test('title updates do not churn the FTS shadow', () => {
        const db = new Database(':memory:');
        for (const m of COMMENT_INDEX_DB_CONFIG.migrations) m.up(db);
        db.exec("INSERT INTO comments (chatName, recentText) VALUES ('t.eigenchat', 'alpha');");
        db.exec("UPDATE comments SET title = 'Fix header' WHERE chatName = 't.eigenchat';");
        expect(ftsMatch(db, 'alpha')).toBe('t.eigenchat');
    });

    test('fresh database ends at v5 with assignee and title present', () => {
        const db = new Database(':memory:');
        for (const m of COMMENT_INDEX_DB_CONFIG.migrations) m.up(db);
        expect(COMMENT_INDEX_DB_CONFIG.currentVersion).toBe(5);
        expect(columnNames(db)).toContain('assignee');
        expect(columnNames(db)).toContain('title');
    });
});
