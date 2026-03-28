import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './sharedschema';

export const SHARED_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'shared',
    currentVersion: 1,
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
    ],
};
