import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const CONTACTS_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'contacts',
    currentVersion: 5,
    schema,
    // The book's bytes live here now, so an acknowledged PUT must survive a power loss.
    synchronous: 'FULL',
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
            // v1 rows are DROPPED, not migrated: the vCard files became the source of truth (v5 moves them into the rows).
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
            `),
        },
        {
            // Some v2 databases predate uriKey on the tombstone table; a fresh one only ensures the index.
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
        {
            // Recovery journals init drains: a card write cut between the file rename and its index commit, and a half-applied label rename.
            version: 4,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS pending_card_writes (
                    uri TEXT PRIMARY KEY
                );

                CREATE TABLE IF NOT EXISTS pending_label_renames (
                    labelId TEXT PRIMARY KEY,
                    oldName TEXT NOT NULL,
                    newName TEXT NOT NULL,
                    FOREIGN KEY (labelId) REFERENCES labels(id) ON DELETE CASCADE
                );
            `),
        },
        {
            // The vCard bytes move into the `vcard` column, so every v4 row is dropped: the card files that
            // held them are not adopted. Children before parents, because foreign_keys is ON.
            version: 5,
            up: (db) =>
                db.exec(`
                DROP TABLE IF EXISTS pending_label_renames;
                DROP TABLE IF EXISTS pending_card_writes;
                DROP TABLE IF EXISTS contacts_to_labels;
                DROP TABLE IF EXISTS contact_tombstones;
                DROP TABLE IF EXISTS contacts;
                DROP TABLE IF EXISTS labels;
                DROP TABLE IF EXISTS book;

                CREATE TABLE contacts (
                    id TEXT PRIMARY KEY,
                    uri TEXT NOT NULL,
                    uid TEXT NOT NULL,
                    vcard BLOB NOT NULL,
                    firstName TEXT NOT NULL,
                    lastName TEXT NOT NULL,
                    eigenId TEXT NOT NULL DEFAULT '',
                    isGroup INTEGER NOT NULL DEFAULT 0,
                    data TEXT,
                    etag TEXT NOT NULL,
                    cardCtag INTEGER NOT NULL,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
                    updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
                );

                CREATE TABLE book (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    ctag INTEGER NOT NULL DEFAULT 0,
                    syncGen INTEGER NOT NULL DEFAULT 1,
                    ownerSeeded INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE contact_tombstones (
                    uri TEXT PRIMARY KEY,
                    deletedAtCtag INTEGER NOT NULL
                );

                CREATE TABLE labels (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    nameKey TEXT NOT NULL,
                    color TEXT NOT NULL,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
                    updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
                );

                CREATE TABLE contacts_to_labels (
                    contactId TEXT NOT NULL,
                    labelId TEXT NOT NULL,
                    PRIMARY KEY (contactId, labelId),
                    FOREIGN KEY (contactId) REFERENCES contacts(id) ON DELETE CASCADE,
                    FOREIGN KEY (labelId) REFERENCES labels(id) ON DELETE CASCADE
                );

                CREATE UNIQUE INDEX idx_contacts_uri ON contacts(uri);
                CREATE UNIQUE INDEX idx_contacts_uid ON contacts(uid);
                CREATE INDEX idx_contacts_eigenId ON contacts(eigenId);
                CREATE INDEX idx_contacts_cardCtag ON contacts(cardCtag);
                CREATE UNIQUE INDEX idx_labels_nameKey ON labels(nameKey);
                CREATE INDEX idx_contact_tombstones_ctag ON contact_tombstones(deletedAtCtag);
                CREATE INDEX idx_contacts_to_labels_labelId ON contacts_to_labels(labelId);
            `),
        },
    ],
};
