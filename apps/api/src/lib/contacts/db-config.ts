import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const CONTACTS_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'contacts',
    currentVersion: 3,
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
                CREATE INDEX IF NOT EXISTS idx_contacts_to_labels_labelId ON contacts_to_labels(labelId);
            `),
        },
        {
            // CardDAV refit: reshape the index around cards-as-truth (uri/uid/etag + a one-row book
            // carrying the ctag/syncGen, plus a tombstone log for sync-collection removals). The v1
            // rows are DROPPED, not migrated — once the file-backed refit lands the index is rebuilt
            // at init from the vCard files on disk, which become the source of truth (Decision 2).
            // Runs inside ManagedDatabase's BEGIN/ROLLBACK, so a failure leaves the db at v1 untouched.
            version: 2,
            up: (db) =>
                db.exec(`
                DROP TABLE IF EXISTS contacts_to_labels;
                DROP TABLE IF EXISTS contacts;
                DROP TABLE IF EXISTS labels;

                CREATE TABLE IF NOT EXISTS contacts (
                    id TEXT PRIMARY KEY,
                    uri TEXT NOT NULL,
                    uriKey TEXT NOT NULL,
                    uid TEXT NOT NULL,
                    firstName TEXT NOT NULL,
                    lastName TEXT NOT NULL,
                    eigenId TEXT NOT NULL DEFAULT '',
                    isGroup INTEGER NOT NULL DEFAULT 0,
                    data TEXT,
                    etag TEXT NOT NULL,
                    cardCtag INTEGER NOT NULL,
                    mtime INTEGER NOT NULL,
                    size INTEGER NOT NULL,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch())
                );

                CREATE TABLE IF NOT EXISTS book (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    ctag INTEGER NOT NULL DEFAULT 0,
                    syncGen INTEGER NOT NULL DEFAULT 1,
                    ownerSeeded INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS contact_tombstones (
                    uri TEXT PRIMARY KEY,
                    uriKey TEXT NOT NULL,
                    deletedAtCtag INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS labels (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    nameKey TEXT NOT NULL,
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

                CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_uriKey ON contacts(uriKey);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_uid ON contacts(uid);
                CREATE INDEX IF NOT EXISTS idx_contacts_eigenId ON contacts(eigenId);
                CREATE INDEX IF NOT EXISTS idx_contacts_cardCtag ON contacts(cardCtag);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_nameKey ON labels(nameKey);
                CREATE INDEX IF NOT EXISTS idx_contact_tombstones_ctag ON contact_tombstones(deletedAtCtag);
                CREATE INDEX IF NOT EXISTS idx_contact_tombstones_uriKey ON contact_tombstones(uriKey);
                CREATE INDEX IF NOT EXISTS idx_contacts_to_labels_labelId ON contacts_to_labels(labelId);

                INSERT OR IGNORE INTO book (id, ctag, syncGen) VALUES (1, 0, 1);
            `),
        },
        {
            // Some persistent v2 databases predate uriKey being added to the unshipped v2 tombstone shape.
            // Heal those databases forward; fresh databases already have the column and only ensure the index.
            version: 3,
            up: (db) => {
                const hasUriKey = db
                    .query<{ name: string }, []>('PRAGMA table_info(contact_tombstones)')
                    .all()
                    .some((column) => column.name === 'uriKey');
                if (!hasUriKey) {
                    db.exec(`
                        ALTER TABLE contact_tombstones ADD COLUMN uriKey TEXT NOT NULL DEFAULT '';
                        UPDATE contact_tombstones SET uriKey = lower(uri);
                    `);
                }
                db.exec('CREATE INDEX IF NOT EXISTS idx_contact_tombstones_uriKey ON contact_tombstones(uriKey);');
            },
        },
    ],
};
