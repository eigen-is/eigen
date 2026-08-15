import { Database as BunDatabase } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { CONTACTS_DB_CONFIG } from '../lib/contacts/db-config';
import { ManagedDatabase } from '../lib/core';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-contacts-mig-${Date.now()}`);
let counter = 0;
const nextDbPath = () => join(TEST_DIR, `contacts-${counter++}.db`);

// The v1 migration SQL copied verbatim from contacts/db-config.ts — the shape a pre-CardDAV
// contacts.db carries on disk. The v2 migration drops it wholesale and rebuilds (Decision 2).
const V1_SQL = `
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
            `;

// Seed a db sitting at v1 with one populated contacts row, exactly as ManagedDatabase would
// leave it before the CardDAV upgrade runs.
function seedV1Database(dbPath: string): void {
    const raw = new BunDatabase(dbPath, { create: true });
    raw.exec(V1_SQL);
    raw.exec(`INSERT INTO contacts (id, firstName, lastName, eigenId, data) VALUES ('c1','Old','Row','', '{}');
              CREATE TABLE __schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0);
              INSERT INTO __schema_version (id, version) VALUES (1, 1);`);
    raw.close();
}

function seedHistoricalV2Database(dbPath: string): void {
    const raw = new BunDatabase(dbPath, { create: true });
    raw.exec('PRAGMA foreign_keys = ON;');
    CONTACTS_DB_CONFIG.migrations.find((migration) => migration.version === 1)!.up(raw);
    CONTACTS_DB_CONFIG.migrations.find((migration) => migration.version === 2)!.up(raw);
    raw.exec(`
        DROP INDEX idx_contact_tombstones_uriKey;
        DROP TABLE contact_tombstones;
        CREATE TABLE contact_tombstones (
            uri TEXT PRIMARY KEY,
            deletedAtCtag INTEGER NOT NULL
        );

        UPDATE book SET ctag = 11, syncGen = 7, ownerSeeded = 1 WHERE id = 1;
        INSERT INTO contacts (
            id, uri, uriKey, uid, firstName, lastName, eigenId, isGroup, data,
            etag, cardCtag, mtime, size
        ) VALUES (
            'c1', 'Kept.vcf', 'kept.vcf', 'uid-kept', 'Kept', 'Contact', '', 0,
            '{"email":["kept@example.com"],"phone":[]}', 'etag-kept', 10, 1234, 456
        );
        INSERT INTO labels (id, name, nameKey, color) VALUES ('l1', 'Friends', 'friends', '#123456');
        INSERT INTO contacts_to_labels (contactId, labelId) VALUES ('c1', 'l1');
        INSERT INTO contact_tombstones (uri, deletedAtCtag) VALUES ('Deleted.vcf', 11);

        CREATE TABLE __schema_version (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO __schema_version (id, version) VALUES (1, 2);
    `);
    raw.close();
}

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

describe('Contacts index-schema migrations', () => {
    test('v1 → current migration drops populated v1 tables and creates the index shape', async () => {
        const dbPath = nextDbPath();
        seedV1Database(dbPath);

        const mdb = new ManagedDatabase(CONTACTS_DB_CONFIG, dbPath);
        await mdb.open(0);

        expect(
            (mdb.db.all(sql`SELECT version FROM __schema_version WHERE id = 1`)[0] as { version: number }).version,
        ).toBe(3);

        const tables = (mdb.db.all(sql`SELECT name FROM sqlite_master WHERE type='table'`) as { name: string }[]).map(
            (r) => r.name,
        );
        expect(tables).toContain('book');
        expect(tables).toContain('contact_tombstones');

        const cols = (mdb.db.all(sql`PRAGMA table_info(contacts)`) as { name: string }[]).map((c) => c.name);
        expect(cols).toContain('uriKey');

        // The onboarding owner-seed latch lives on book; tombstones carry a folded uriKey for case-safe clears.
        const bookCols = (mdb.db.all(sql`PRAGMA table_info(book)`) as { name: string }[]).map((c) => c.name);
        expect(bookCols).toContain('ownerSeeded');
        const tombstoneCols = (mdb.db.all(sql`PRAGMA table_info(contact_tombstones)`) as { name: string }[]).map(
            (c) => c.name,
        );
        expect(tombstoneCols).toContain('uriKey');

        // The junction labelId index is dropped with the v1 table and must be recreated — label
        // rename/delete fan-outs seek contacts_to_labels by labelId.
        const indexes = (mdb.db.all(sql`SELECT name FROM sqlite_master WHERE type='index'`) as { name: string }[]).map(
            (r) => r.name,
        );
        expect(indexes).toContain('idx_contacts_to_labels_labelId');

        // v1 data is dropped by design, not migrated (the vCard files become the source of truth).
        expect(mdb.db.all(sql`SELECT * FROM contacts`).length).toBe(0);

        const bookRow = mdb.db.all(sql`SELECT ctag, syncGen, ownerSeeded FROM book`)[0] as {
            ctag: number;
            syncGen: number;
            ownerSeeded: number;
        };
        expect(bookRow).toEqual({ ctag: 0, syncGen: 1, ownerSeeded: 0 });

        await mdb.close();
    });

    test('fresh database reaches the same current end state', async () => {
        const mdb = new ManagedDatabase(CONTACTS_DB_CONFIG, nextDbPath());
        await mdb.open(0);

        expect(
            (mdb.db.all(sql`SELECT version FROM __schema_version WHERE id = 1`)[0] as { version: number }).version,
        ).toBe(3);

        const tables = (mdb.db.all(sql`SELECT name FROM sqlite_master WHERE type='table'`) as { name: string }[]).map(
            (r) => r.name,
        );
        expect(tables).toContain('contacts');
        expect(tables).toContain('labels');
        expect(tables).toContain('contacts_to_labels');
        expect(tables).toContain('book');
        expect(tables).toContain('contact_tombstones');

        const cols = (mdb.db.all(sql`PRAGMA table_info(contacts)`) as { name: string }[]).map((c) => c.name);
        expect(cols).toContain('uriKey');
        expect(cols).not.toContain('avatar');

        expect(mdb.db.all(sql`SELECT * FROM contacts`).length).toBe(0);
        const bookRow = mdb.db.all(sql`SELECT ctag, syncGen, ownerSeeded FROM book`)[0] as {
            ctag: number;
            syncGen: number;
            ownerSeeded: number;
        };
        expect(bookRow).toEqual({ ctag: 0, syncGen: 1, ownerSeeded: 0 });

        await mdb.close();
    });

    test('historical v2 tombstones gain uriKey without losing index data', async () => {
        const dbPath = nextDbPath();
        seedHistoricalV2Database(dbPath);

        const mdb = new ManagedDatabase(CONTACTS_DB_CONFIG, dbPath, {}, true);
        await mdb.open(0);

        expect(
            (mdb.db.all(sql`SELECT version FROM __schema_version WHERE id = 1`)[0] as { version: number }).version,
        ).toBe(3);
        expect(mdb.db.all(sql`SELECT id, uri, uid, data FROM contacts`)).toEqual([
            {
                id: 'c1',
                uri: 'Kept.vcf',
                uid: 'uid-kept',
                data: '{"email":["kept@example.com"],"phone":[]}',
            },
        ]);
        expect(mdb.db.all(sql`SELECT id, name, nameKey, color FROM labels`)).toEqual([
            { id: 'l1', name: 'Friends', nameKey: 'friends', color: '#123456' },
        ]);
        expect(mdb.db.all(sql`SELECT contactId, labelId FROM contacts_to_labels`)).toEqual([
            { contactId: 'c1', labelId: 'l1' },
        ]);
        expect(mdb.db.all(sql`SELECT ctag, syncGen, ownerSeeded FROM book`)).toEqual([
            { ctag: 11, syncGen: 7, ownerSeeded: 1 },
        ]);
        expect(mdb.db.all(sql`SELECT uri, uriKey, deletedAtCtag FROM contact_tombstones`)).toEqual([
            { uri: 'Deleted.vcf', uriKey: 'deleted.vcf', deletedAtCtag: 11 },
        ]);
        expect(
            (mdb.db.all(sql`SELECT name FROM sqlite_master WHERE type = 'index'`) as { name: string }[]).map(
                (row) => row.name,
            ),
        ).toContain('idx_contact_tombstones_uriKey');
        expect(mdb.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);

        await mdb.close();
    });

    test('interrupted v2 migration leaves v1 intact and a later clean run migrates', async () => {
        const dbPath = nextDbPath();
        seedV1Database(dbPath);

        // v2 whose up() throws after the first DROP — ManagedDatabase wraps each migration in
        // BEGIN/ROLLBACK, so the DROP must be undone and __schema_version must stay at 1.
        const failing: typeof CONTACTS_DB_CONFIG = {
            ...CONTACTS_DB_CONFIG,
            currentVersion: 2,
            migrations: [
                CONTACTS_DB_CONFIG.migrations[0],
                {
                    version: 2,
                    up: (db) => {
                        db.run('DROP TABLE IF EXISTS contacts_to_labels');
                        throw new Error('migration boom');
                    },
                },
            ],
        };
        const broken = new ManagedDatabase(failing, dbPath, {}, true);
        await expect(broken.open(0)).rejects.toThrow('migration boom');
        // A failed open releases its own raw handle — inspecting the file below needs no close().

        // On-disk state is untouched v1: version stayed 1, the row survived, the dropped table is back.
        const raw = new BunDatabase(dbPath, { readwrite: true, create: false });
        expect(
            (raw.query('SELECT version FROM __schema_version WHERE id = 1').get() as { version: number }).version,
        ).toBe(1);
        expect(raw.query('SELECT id FROM contacts').all()).toEqual([{ id: 'c1' }]);
        expect(
            (raw.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
                (r) => r.name,
            ),
        ).toContain('contacts_to_labels');
        raw.close();

        // The real config reopens and migrates cleanly through the current version.
        const reopened = new ManagedDatabase(CONTACTS_DB_CONFIG, dbPath, {}, true);
        await reopened.open(0);
        expect(
            (reopened.db.all(sql`SELECT version FROM __schema_version WHERE id = 1`)[0] as { version: number }).version,
        ).toBe(3);
        const tables = (
            reopened.db.all(sql`SELECT name FROM sqlite_master WHERE type='table'`) as { name: string }[]
        ).map((r) => r.name);
        expect(tables).toContain('book');
        expect(reopened.db.all(sql`SELECT * FROM contacts`).length).toBe(0);
        await reopened.close();
    });
});
