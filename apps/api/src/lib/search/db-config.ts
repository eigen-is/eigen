import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const SEARCH_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'search',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS search_content (
                    rowid INTEGER PRIMARY KEY,
                    kind TEXT NOT NULL,
                    itemId TEXT NOT NULL,
                    bucket TEXT NOT NULL DEFAULT '', -- empty string is a valid value (e.g. mail's inbox), not "unset"
                    title TEXT NOT NULL DEFAULT '',
                    body TEXT NOT NULL DEFAULT '',
                    metadata TEXT NOT NULL DEFAULT '{}',
                    sortKey INTEGER NOT NULL DEFAULT 0
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_search_kind_item
                    ON search_content(kind, itemId);

                CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
                    title,
                    body,
                    content='search_content',
                    content_rowid='rowid',
                    tokenize='porter unicode61'
                );

                CREATE TRIGGER IF NOT EXISTS search_content_ai
                AFTER INSERT ON search_content BEGIN
                    INSERT INTO search_fts(rowid, title, body)
                    VALUES (new.rowid, new.title, new.body);
                END;

                CREATE TRIGGER IF NOT EXISTS search_content_ad
                AFTER DELETE ON search_content BEGIN
                    INSERT INTO search_fts(search_fts, rowid, title, body)
                    VALUES ('delete', old.rowid, old.title, old.body);
                END;

                CREATE TRIGGER IF NOT EXISTS search_content_au
                AFTER UPDATE ON search_content BEGIN
                    INSERT INTO search_fts(search_fts, rowid, title, body)
                    VALUES ('delete', old.rowid, old.title, old.body);
                    INSERT INTO search_fts(rowid, title, body)
                    VALUES (new.rowid, new.title, new.body);
                END;
            `),
        },
    ],
};
