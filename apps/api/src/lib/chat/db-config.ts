import type {DatabaseConfig} from '../core/managed-database';
import * as schema from './schema';

export const CHAT_ROOM_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'chatroom',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) => db.exec(`
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
            `)
        }
    ]
};
