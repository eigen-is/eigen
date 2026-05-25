import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const MAIL_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'mail',
    currentVersion: 3,
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
                CREATE INDEX IF NOT EXISTS idx_emails_to_labels_labelId ON emails_to_labels(labelId);
            `),
        },
        {
            version: 2,
            up: (db) =>
                db.exec(`
                ALTER TABLE emails ADD COLUMN fromAddress TEXT NOT NULL DEFAULT '';
                ALTER TABLE emails ADD COLUMN toShort TEXT NOT NULL DEFAULT '';
                ALTER TABLE emails ADD COLUMN toAddress TEXT NOT NULL DEFAULT '';
                ALTER TABLE emails ADD COLUMN recipientsAll TEXT NOT NULL DEFAULT '';
            `),
        },
        {
            version: 3,
            up: (db) =>
                db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
                    subject, fromShort, fromAddress, toShort, toAddress, recipientsAll, textShort,
                    content='emails',
                    content_rowid='rowid',
                    tokenize='porter unicode61'
                );

                CREATE TRIGGER IF NOT EXISTS emails_ai AFTER INSERT ON emails BEGIN
                    INSERT INTO emails_fts(rowid, subject, fromShort, fromAddress, toShort, toAddress, recipientsAll, textShort)
                    VALUES (new.rowid, new.subject, new.fromShort, new.fromAddress, new.toShort, new.toAddress, new.recipientsAll, new.textShort);
                END;

                CREATE TRIGGER IF NOT EXISTS emails_ad AFTER DELETE ON emails BEGIN
                    INSERT INTO emails_fts(emails_fts, rowid, subject, fromShort, fromAddress, toShort, toAddress, recipientsAll, textShort)
                    VALUES ('delete', old.rowid, old.subject, old.fromShort, old.fromAddress, old.toShort, old.toAddress, old.recipientsAll, old.textShort);
                END;

                CREATE TRIGGER IF NOT EXISTS emails_au AFTER UPDATE ON emails BEGIN
                    INSERT INTO emails_fts(emails_fts, rowid, subject, fromShort, fromAddress, toShort, toAddress, recipientsAll, textShort)
                    VALUES ('delete', old.rowid, old.subject, old.fromShort, old.fromAddress, old.toShort, old.toAddress, old.recipientsAll, old.textShort);
                    INSERT INTO emails_fts(rowid, subject, fromShort, fromAddress, toShort, toAddress, recipientsAll, textShort)
                    VALUES (new.rowid, new.subject, new.fromShort, new.fromAddress, new.toShort, new.toAddress, new.recipientsAll, new.textShort);
                END;

                -- Populate from existing rows. No-op on a fresh database; fills the index on
                -- upgrade. Idempotent on re-run because the migration framework's version gate
                -- prevents this block from running twice.
                INSERT INTO emails_fts(rowid, subject, fromShort, fromAddress, toShort, toAddress, recipientsAll, textShort)
                SELECT rowid, subject, fromShort, fromAddress, toShort, toAddress, recipientsAll, textShort FROM emails;
            `),
        },
    ],
};
