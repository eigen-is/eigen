import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const MAIL_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'mail',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS emails (
                    id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    fromShort TEXT NOT NULL,
                    textShort TEXT NOT NULL,
                    size INTEGER NOT NULL DEFAULT 0,
                    date INTEGER NOT NULL,
                    isRead INTEGER NOT NULL DEFAULT 0,
                    isFlagged INTEGER NOT NULL DEFAULT 0,
                    isDraft INTEGER NOT NULL DEFAULT 0,
                    isReplied INTEGER NOT NULL DEFAULT 0,
                    hasAttachments INTEGER NOT NULL DEFAULT 0,
                    mailbox TEXT NOT NULL,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch())
                );
                CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox);
                CREATE INDEX IF NOT EXISTS idx_emails_mailbox_isRead ON emails(mailbox, isRead);
                CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);

                CREATE TABLE IF NOT EXISTS email_labels (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch())
                );

                CREATE TABLE IF NOT EXISTS emails_to_labels (
                    emailId TEXT NOT NULL,
                    labelId TEXT NOT NULL,
                    PRIMARY KEY (emailId, labelId),
                    FOREIGN KEY (emailId) REFERENCES emails(id) ON DELETE CASCADE,
                    FOREIGN KEY (labelId) REFERENCES email_labels(id) ON DELETE CASCADE
                );
            `),
        },
    ],
};
