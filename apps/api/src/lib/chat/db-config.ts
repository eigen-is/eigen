import type { DatabaseConfig } from '../core/managed-database';
import { DEFAULT_RETENTION } from '../versioning/retention';
import * as schema from './schema';

export const CHAT_ROOM_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'chatroom',
    currentVersion: 2,
    schema,
    snapshot: { policy: DEFAULT_RETENTION, writesPerSnapshot: 100 },
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    authorId TEXT NOT NULL,
                    authorEmail TEXT NOT NULL,
                    type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    attachments TEXT,
                    whisperTo TEXT,
                    replyTo TEXT,
                    editedAt INTEGER,
                    deletedAt INTEGER,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch())
                );
                CREATE TABLE IF NOT EXISTS read_state (
                    userId TEXT PRIMARY KEY,
                    lastReadMessageId TEXT,
                    lastReadAt INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_messages_createdAt ON messages(createdAt);
                CREATE INDEX IF NOT EXISTS idx_messages_replyTo ON messages(replyTo);
                CREATE INDEX IF NOT EXISTS idx_messages_authorId ON messages(authorId);
            `),
        },
        {
            // Containers reference users by email only — the message row's authorId (and the
            // per-user read_state table, which no route or FE consumes) are dropped. authorEmail
            // already carries authorship; message rows are preserved. Runs inside ManagedDatabase's
            // BEGIN/ROLLBACK, so a failure leaves the db at v1 untouched.
            version: 2,
            up: (db) =>
                db.exec(`
                DROP INDEX IF EXISTS idx_messages_authorId;
                ALTER TABLE messages DROP COLUMN authorId;
                DROP TABLE IF EXISTS read_state;
            `),
        },
    ],
};
