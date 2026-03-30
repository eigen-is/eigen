import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const NOTIFICATION_CENTER_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'notification-center',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS notifications (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    actorEmail TEXT,
                    title TEXT NOT NULL,
                    body TEXT,
                    tag TEXT UNIQUE,
                    read INTEGER NOT NULL DEFAULT 0,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch())
                );

                CREATE INDEX IF NOT EXISTS idx_notifications_read_createdAt ON notifications(read, createdAt);
                CREATE INDEX IF NOT EXISTS idx_notifications_createdAt ON notifications(createdAt);
            `),
        },
    ],
};
