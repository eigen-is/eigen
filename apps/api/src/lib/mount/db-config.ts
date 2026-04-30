import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const MOUNT_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'mount-metadata',
    currentVersion: 1,
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
    ],
};
