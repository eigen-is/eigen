import type { DatabaseConfig } from '../core/managed-database';
import * as commentSchema from './comment-schema';

export const COMMENT_INDEX_DB_CONFIG: DatabaseConfig<typeof commentSchema> = {
    name: 'comment-index',
    currentVersion: 5,
    schema: commentSchema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS comments (
                    chatName TEXT PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT 'open',
                    resolvedBy TEXT,
                    resolvedAt INTEGER,
                    lastAuthorEmail TEXT,
                    lastMessageSnippet TEXT,
                    lastActivityAt INTEGER,
                    messageCount INTEGER NOT NULL DEFAULT 0,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch())
                );

                CREATE TABLE IF NOT EXISTS comment_mentions (
                    chatName TEXT NOT NULL,
                    email TEXT NOT NULL,
                    PRIMARY KEY (chatName, email)
                );

                CREATE INDEX IF NOT EXISTS idx_mentions_email ON comment_mentions(email);
                CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
            `),
        },
        {
            version: 2,
            up: (db) => db.exec(`ALTER TABLE comments ADD COLUMN createdBy TEXT;`),
        },
        {
            // Comment-thread body search (in-document search phase 2). Additive + regenerable:
            // recentText holds the newest ~8 KB of each thread (recomputed from the thread's own
            // messages on every comment write — ChatRoom.updateCommentIndex), and comments_fts
            // external-content FTS5 indexes it. The AFTER UPDATE trigger is gated on recentText so
            // the frequent status/activity/count writes don't churn the FTS shadow. Backfill seeds
            // recentText from lastMessageSnippet — the only thread text held in comments.db (full
            // history lives in each thread's own data.db, out of a migration's reach); the recompute
            // heals each legacy thread to its full tail on first activity. Touches ONLY recentText.
            version: 3,
            up: (db) =>
                db.exec(`
                ALTER TABLE comments ADD COLUMN recentText TEXT;

                -- Backfill BEFORE the triggers exist so this UPDATE can't churn the FTS shadow;
                -- the explicit populate below fills the index once.
                UPDATE comments SET recentText = lastMessageSnippet WHERE lastMessageSnippet IS NOT NULL;

                CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
                    recentText,
                    content='comments',
                    content_rowid='rowid',
                    tokenize='porter unicode61'
                );

                CREATE TRIGGER IF NOT EXISTS comments_ai AFTER INSERT ON comments BEGIN
                    INSERT INTO comments_fts(rowid, recentText) VALUES (new.rowid, new.recentText);
                END;

                CREATE TRIGGER IF NOT EXISTS comments_ad AFTER DELETE ON comments BEGIN
                    INSERT INTO comments_fts(comments_fts, rowid, recentText) VALUES ('delete', old.rowid, old.recentText);
                END;

                -- Gate on recentText so status/resolve/activity/count writes don't re-index the body.
                CREATE TRIGGER IF NOT EXISTS comments_au AFTER UPDATE ON comments
                    WHEN old.recentText IS NOT new.recentText
                BEGIN
                    INSERT INTO comments_fts(comments_fts, rowid, recentText) VALUES ('delete', old.rowid, old.recentText);
                    INSERT INTO comments_fts(rowid, recentText) VALUES (new.rowid, new.recentText);
                END;

                -- Populate from the rows just backfilled. No-op on a fresh database.
                INSERT INTO comments_fts(rowid, recentText) SELECT rowid, recentText FROM comments WHERE recentText IS NOT NULL;
            `),
        },
        {
            // Comment assignment (server-authoritative, like resolve). Lowercased member
            // email, NULL = unassigned. Doesn't churn comments_fts — the AFTER UPDATE
            // trigger above is gated on recentText.
            version: 4,
            up: (db) => db.exec(`ALTER TABLE comments ADD COLUMN assignee TEXT;`),
        },
        {
            // Separate from v4: running dev servers stamped v4 as assignee-only mid-build,
            // and a stamped migration can never be amended in place. title = best-effort
            // client-posted card-title cache (refreshed on assign/status) for activity labels.
            version: 5,
            up: (db) => db.exec(`ALTER TABLE comments ADD COLUMN title TEXT;`),
        },
    ],
};
