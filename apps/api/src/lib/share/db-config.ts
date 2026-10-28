// The schema versions of the share registry's database, the server-wide eigen.db. The registry opens it through
// openLocalDatabase, which runs the migrations a database file has not had yet.

import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const SHARE_REGISTRY_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'share-registry',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS share_registry (
                    fromUserId TEXT NOT NULL,
                    targetIdentifier TEXT NOT NULL,
                    PRIMARY KEY (fromUserId, targetIdentifier)
                );

                CREATE INDEX IF NOT EXISTS idx_share_registry_target ON share_registry(targetIdentifier);
            `),
        },
    ],
};
