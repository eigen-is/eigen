// The migrations of a home's shared.db, which holds what the home keeps about other owners' paths, such as the paths
// shared with its user and the paths its user lately opened or was notified about. A Drive opens it when its home
// loads.

import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './shared-schema';

export const SHARED_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'shared',
    currentVersion: 3,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS shared_paths (
                    id TEXT PRIMARY KEY,
                    mountId TEXT NOT NULL,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL,
                    parentId TEXT,
                    size INTEGER DEFAULT 0,
                    thumbnail TEXT,
                    ownerId TEXT NOT NULL,
                    mimeType TEXT NOT NULL,
                    acl TEXT,
                    visibility TEXT DEFAULT 'private',
                    sharingRestricted INTEGER NOT NULL DEFAULT 0,
                    details TEXT,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch())
                );
            `),
        },
        {
            version: 2,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS recent_paths (
                    ownerId TEXT NOT NULL,
                    mountId TEXT NOT NULL,
                    pathId TEXT NOT NULL,
                    lastActivityAt INTEGER NOT NULL,
                    PRIMARY KEY (ownerId, mountId, pathId)
                );
            `),
        },
        {
            version: 3,
            up: (db) =>
                db.exec(`
                CREATE TABLE shared_pointers (
                    ownerId TEXT NOT NULL,
                    mountId TEXT NOT NULL,
                    pathId TEXT NOT NULL,
                    sharedAt INTEGER NOT NULL,
                    PRIMARY KEY (ownerId, mountId, pathId)
                );
                INSERT INTO shared_pointers SELECT ownerId, mountId, id, createdAt FROM shared_paths;
                DROP TABLE shared_paths;
                ALTER TABLE shared_pointers RENAME TO shared_paths;
            `),
        },
    ],
};
