import type { DatabaseConfig } from '../core/managed-database';
import { DEFAULT_RETENTION } from '../versioning/retention';
import * as schema from './schema';

export const COLLAB_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'collab',
    currentVersion: 1,
    schema,
    snapshot: { policy: DEFAULT_RETENTION, writesPerSnapshot: 100 },
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS doc_updates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    updateData BLOB NOT NULL,
                    createdAt INTEGER DEFAULT (unixepoch())
                );
                CREATE TABLE IF NOT EXISTS doc_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    stateData BLOB NOT NULL,
                    lastUpdateId INTEGER NOT NULL,
                    createdAt INTEGER DEFAULT (unixepoch())
                );
            `),
        },
    ],
};
