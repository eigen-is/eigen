import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const WAITLIST_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'waitlist',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS waitlist (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    notes TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending',
                    inviteToken TEXT UNIQUE,
                    inviteExpiresAt INTEGER,
                    invitedAt INTEGER,
                    registeredAt INTEGER,
                    userId TEXT,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
                    updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
                );

                CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status);
                CREATE INDEX IF NOT EXISTS idx_waitlist_inviteToken ON waitlist(inviteToken);
            `),
        },
    ],
};
