import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type DatabaseConfig, ManagedDatabase, PATHS } from '../../lib/core';
import { MAIL_DB_CONFIG } from '../../lib/mail/db-config';
import * as schema from '../../lib/mail/schema';
import { createTestUser, ensureServer } from '../setup';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-mail-schema-${Date.now()}`);

// The shape a home carries at an older schema version: the migrations up to it.
const configAt = (version: number): DatabaseConfig<typeof schema> => ({
    ...MAIL_DB_CONFIG,
    currentVersion: version,
    migrations: MAIL_DB_CONFIG.migrations.filter((m) => m.version <= version),
});

// A WAL database its owner is not holding open has no -shm beside it, and a read-only open of one
// fails outright. Read-write on purpose; only ever used for SELECTs and the v4 seed.
function openRaw(dbPath: string): Database {
    return new Database(dbPath, { readwrite: true, create: false });
}

function tableNames(dbPath: string): string[] {
    const raw = openRaw(dbPath);
    try {
        return raw
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((row) => row.name);
    } finally {
        raw.close();
    }
}

beforeAll(async () => {
    await ensureServer();
    mkdirSync(TEST_DIR, { recursive: true });
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('mail.db schema', () => {
    test('a fresh home gets no label tables', async () => {
        const user = await createTestUser(`mail-schema-${Date.now()}@test.eigen.is`, 'testpassword123', 'Mail Schema');
        const { getHome } = await import('../../lib/home');
        const home = await getHome(user.id);

        const names = tableNames(join(home.homeDir, PATHS.MAIL.DB));
        expect(names).toContain('emails');
        expect(names).not.toContain('email_labels');
        expect(names).not.toContain('emails_to_labels');
    });

    test('a v4 home drops its label tables and keeps every message row', async () => {
        const dbPath = join(TEST_DIR, 'mail-v4.db');
        // v1 creates `email_labels` + `emails_to_labels`.
        const v4 = new ManagedDatabase(configAt(4), dbPath, {});
        await v4.open(0);
        v4.db
            .insert(schema.emails)
            .values({
                id: 'keep-me',
                filename: '1700000000.keep:2,S',
                subject: 'Survives the drop',
                fromShort: 'Sender',
                fromAddress: 'sender@example.com',
                toShort: 'Owner',
                toAddress: 'owner@test.eigen.is',
                recipientsAll: 'owner@test.eigen.is',
                textShort: 'body',
                size: 42,
                date: new Date(Date.UTC(2021, 0, 1)),
                mailbox: '',
            })
            .run();
        await v4.close({ skipFinalSnapshot: true });

        // Populated tables: the drop order has to clear the child before the parent, or the
        // implicit DELETE behind DROP TABLE trips the foreign key (pragma foreign_keys is ON).
        const seed = openRaw(dbPath);
        seed.run("INSERT INTO email_labels (id, name, color) VALUES ('label-1', 'Work', '#ff0000')");
        seed.run("INSERT INTO emails_to_labels (emailId, labelId) VALUES ('keep-me', 'label-1')");
        seed.close();
        expect(tableNames(dbPath)).toContain('email_labels');

        const v5 = new ManagedDatabase(MAIL_DB_CONFIG, dbPath, {}, true);
        await v5.open(0);
        const rows = v5.db.select().from(schema.emails).all();
        expect(rows.map((row) => row.subject)).toEqual(['Survives the drop']);
        expect(rows[0].size).toBe(42);
        await v5.close({ skipFinalSnapshot: true });

        const names = tableNames(dbPath);
        expect(names).toContain('emails');
        expect(names).not.toContain('email_labels');
        expect(names).not.toContain('emails_to_labels');
    });

    test('a v5 home names its inbox INBOX and keeps every other mailbox', async () => {
        const dbPath = join(TEST_DIR, 'mail-v5.db');
        const v5 = new ManagedDatabase(configAt(5), dbPath, {});
        await v5.open(0);
        await v5.close({ skipFinalSnapshot: true });

        const seed = openRaw(dbPath);
        seed.run(
            `INSERT INTO emails (id, filename, subject, fromShort, textShort, date, mailbox)
             VALUES ('in', 'in:2,S', 'In', 'A', 'a', 0, ''), ('out', 'out:2,S', 'Out', 'B', 'b', 0, 'Sent')`,
        );
        seed.close();

        const v6 = new ManagedDatabase(MAIL_DB_CONFIG, dbPath, {}, true);
        await v6.open(0);
        const rows = v6.db.select({ id: schema.emails.id, mailbox: schema.emails.mailbox }).from(schema.emails).all();
        expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
            { id: 'in', mailbox: 'INBOX' },
            { id: 'out', mailbox: 'Sent' },
        ]);
        await v6.close({ skipFinalSnapshot: true });
    });
});
