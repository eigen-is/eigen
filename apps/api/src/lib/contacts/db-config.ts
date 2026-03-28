import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const CONTACTS_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'contacts',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS contacts (
                    id TEXT PRIMARY KEY,
                    firstName TEXT NOT NULL,
                    lastName TEXT NOT NULL,
                    eigenId TEXT NOT NULL,
                    avatar TEXT,
                    data TEXT,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch())
                );

                CREATE TABLE IF NOT EXISTS labels (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch())
                );

                CREATE TABLE IF NOT EXISTS contacts_to_labels (
                    contactId TEXT NOT NULL,
                    labelId TEXT NOT NULL,
                    PRIMARY KEY (contactId, labelId),
                    FOREIGN KEY (contactId) REFERENCES contacts(id) ON DELETE CASCADE,
                    FOREIGN KEY (labelId) REFERENCES labels(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_contacts_eigenId ON contacts(eigenId);
            `),
        },
    ],
};
