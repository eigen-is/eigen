import type { DatabaseConfig } from '../core/managed-database';
import * as commentSchema from './comment-schema';

export const COMMENT_INDEX_DB_CONFIG: DatabaseConfig<typeof commentSchema> = {
    name: 'comment-index',
    currentVersion: 1,
    schema: commentSchema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
            CREATE TABLE IF NOT EXISTS comments
            (
                chatName
                TEXT
                PRIMARY
                KEY,
                status
                TEXT
                NOT
                NULL
                DEFAULT
                'open',
                resolvedBy
                TEXT,
                resolvedAt
                INTEGER,
                lastAuthorEmail
                TEXT,
                lastMessageSnippet
                TEXT,
                lastActivityAt
                INTEGER,
                messageCount
                INTEGER
                NOT
                NULL
                DEFAULT
                0,
                createdAt
                INTEGER
                NOT
                NULL
                DEFAULT (
                unixepoch
            (
            ))
                );
            CREATE TABLE IF NOT EXISTS comment_mentions
            (
                chatName
                TEXT
                NOT
                NULL,
                email
                TEXT
                NOT
                NULL,
                PRIMARY
                KEY
            (
                chatName,
                email
            )
                );
            CREATE INDEX IF NOT EXISTS idx_mentions_email ON comment_mentions(email);
            CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
        `),
        },
    ],
};
