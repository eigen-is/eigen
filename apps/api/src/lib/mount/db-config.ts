import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const MOUNT_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'mount-metadata',
    currentVersion: 5,
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
        {
            // Non-file rows (folders + eigendoc containers) shift from "always 0" to
            // lazy-computed: NULL = needs recompute, populated on first read.
            version: 3,
            up: (db) =>
                db.exec(`
                UPDATE paths SET size = NULL WHERE type != 'file';
            `),
        },
        {
            // Write-behind upload queue (Phase 1b). Additive; never touches existing rows.
            version: 4,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS pending_uploads (
                    storageKey TEXT PRIMARY KEY,
                    stagingPath TEXT NOT NULL,
                    attempt INTEGER NOT NULL DEFAULT 0,
                    enqueuedAt INTEGER NOT NULL,
                    nextAttemptAt INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_pending_uploads_next ON pending_uploads(nextAttemptAt);
            `),
        },
        {
            // File history + watch (Phase 1). Additive; never touches existing rows.
            version: 5,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS file_events (
                    id TEXT PRIMARY KEY,
                    pathId TEXT NOT NULL,
                    eventType TEXT NOT NULL,
                    actorUserId TEXT NOT NULL,
                    actorEmail TEXT NOT NULL,
                    details TEXT,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
                    FOREIGN KEY (pathId) REFERENCES paths(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_file_events_path_created ON file_events(pathId, createdAt);

                CREATE TABLE IF NOT EXISTS path_watchers (
                    pathId TEXT NOT NULL,
                    userId TEXT NOT NULL,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
                    PRIMARY KEY (pathId, userId),
                    FOREIGN KEY (pathId) REFERENCES paths(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_path_watchers_user ON path_watchers(userId);
            `),
        },
    ],
};
