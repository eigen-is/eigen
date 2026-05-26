import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const MOUNT_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'mount-metadata',
    currentVersion: 2,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS paths (
                    id TEXT PRIMARY KEY,
                    file TEXT NOT NULL DEFAULT '',
                    name TEXT NOT NULL,
                    type TEXT NOT NULL,
                    parentId TEXT,
                    ownerId TEXT NOT NULL,
                    mimeType TEXT NOT NULL,
                    size INTEGER DEFAULT 0,
                    thumbnail TEXT,
                    acl TEXT,
                    visibility TEXT DEFAULT 'private',
                    sharingRestricted INTEGER NOT NULL DEFAULT 0,
                    details TEXT,
                    hash TEXT,
                    trashedAt INTEGER,
                    trashedFrom TEXT,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch()),
                    FOREIGN KEY (parentId) REFERENCES paths(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_paths_ownerId ON paths(ownerId);
                CREATE INDEX IF NOT EXISTS idx_paths_type ON paths(type);
                CREATE INDEX IF NOT EXISTS idx_paths_mimeType ON paths(mimeType);
                CREATE INDEX IF NOT EXISTS idx_paths_parentId_name ON paths(parentId, name);
                CREATE INDEX IF NOT EXISTS idx_paths_type_parentId ON paths(type, parentId);
                CREATE INDEX IF NOT EXISTS idx_paths_trashed_from
                    ON paths(trashedFrom, trashedAt) WHERE trashedFrom IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_paths_parent_trash
                    ON paths(parentId, trashedAt);
            `),
        },
        {
            version: 2,
            up: (db) =>
                db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS paths_fts USING fts5(
                    name,
                    content='paths',
                    content_rowid='rowid',
                    tokenize='porter unicode61'
                );

                CREATE TRIGGER IF NOT EXISTS paths_ai AFTER INSERT ON paths BEGIN
                    INSERT INTO paths_fts(rowid, name) VALUES (new.rowid, new.name);
                END;

                CREATE TRIGGER IF NOT EXISTS paths_ad AFTER DELETE ON paths BEGIN
                    INSERT INTO paths_fts(paths_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
                END;

                -- Gate on name change so trivial updates (size/hash/thumbnail/trashedAt/acl/details)
                -- don't churn the FTS shadow tables. mail's draft updates rewrite multiple indexed
                -- columns and can't usefully gate; drive only indexes name, so the gate is safe.
                CREATE TRIGGER IF NOT EXISTS paths_au AFTER UPDATE ON paths
                    WHEN old.name IS NOT new.name
                BEGIN
                    INSERT INTO paths_fts(paths_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
                    INSERT INTO paths_fts(rowid, name) VALUES (new.rowid, new.name);
                END;

                INSERT INTO paths_fts(rowid, name) SELECT rowid, name FROM paths;
            `),
        },
    ],
};
