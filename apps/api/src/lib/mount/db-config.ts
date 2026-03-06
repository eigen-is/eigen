import type {DatabaseConfig} from '../core/managed-database';
import * as schema from './schema';

export const MOUNT_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'mount-metadata',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) => db.exec(`
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
                    details TEXT,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch()),
                    FOREIGN KEY (parentId) REFERENCES paths(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS labels (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch())
                );

                CREATE TABLE IF NOT EXISTS paths_to_labels (
                    pathId TEXT NOT NULL,
                    labelId TEXT NOT NULL,
                    PRIMARY KEY (pathId, labelId),
                    FOREIGN KEY (pathId) REFERENCES paths(id) ON DELETE CASCADE,
                    FOREIGN KEY (labelId) REFERENCES labels(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_paths_parentId ON paths(parentId);
                CREATE INDEX IF NOT EXISTS idx_paths_ownerId ON paths(ownerId);
                CREATE INDEX IF NOT EXISTS idx_paths_type ON paths(type);
                CREATE INDEX IF NOT EXISTS idx_paths_to_labels_pathId ON paths_to_labels(pathId);
                CREATE INDEX IF NOT EXISTS idx_paths_to_labels_labelId ON paths_to_labels(labelId);
            `)
        }
    ]
};
