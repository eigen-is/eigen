import type {DatabaseConfig} from '../core/managed-database';
import * as schema from './schema';

export const COLLAB_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'collab',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) => db.exec(`
                CREATE TABLE IF NOT EXISTS doc_updates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    updateData BLOB NOT NULL,
                    createdAt INTEGER DEFAULT (unixepoch())
                );
            `)
        }
    ]
};
