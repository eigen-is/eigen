import { Database as BunDatabase } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { is, sql } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { CALENDAR_DB_CONFIG } from '../../lib/calendar/db-config';
import * as schema from '../../lib/calendar/schema';
import { ManagedDatabase } from '../../lib/core';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-calendar-mig-${Date.now()}`);
let counter = 0;
const nextDbPath = () => join(TEST_DIR, `calendar-${counter++}.db`);

// A v1 calendar.db as origin/main shipped it: calendar definitions and share grants beside the event rows
// the blob schema drops.
const V1_SQL = `
    CREATE TABLE calendars (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
        isDefault INTEGER NOT NULL DEFAULT 0, ctag INTEGER NOT NULL DEFAULT 0, shares TEXT,
        visible INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER DEFAULT (unixepoch()), updatedAt INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE shared_calendars (
        id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL, calendarId TEXT NOT NULL,
        calendarName TEXT NOT NULL, calendarColor TEXT NOT NULL, permission TEXT NOT NULL,
        color TEXT, visible INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER DEFAULT (unixepoch()), updatedAt INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX idx_shared_calendars_ownerUserId ON shared_calendars(ownerUserId);
    CREATE TABLE events (
        id TEXT PRIMARY KEY, calendarId TEXT NOT NULL, uid TEXT NOT NULL, title TEXT NOT NULL,
        startTime INTEGER NOT NULL, endTime INTEGER NOT NULL
    );
    CREATE TABLE event_tombstones (id TEXT PRIMARY KEY, calendarId TEXT NOT NULL);
`;

function seedV1Database(dbPath: string): void {
    const raw = new BunDatabase(dbPath, { create: true });
    raw.exec(V1_SQL);
    // Every carried column is seeded away from its default, so a migration dropping one shows up as a change.
    raw.exec(`INSERT INTO calendars (id, name, color, isDefault, ctag, shares, visible)
                  VALUES ('work','Work','#2563eb',1,7,'[{"email":"bob@test.local","permission":"read"}]',0);
              INSERT INTO shared_calendars (id, ownerUserId, calendarId, calendarName, calendarColor, permission, color, visible)
                  VALUES ('s1','u-other','their-cal','Theirs','#16a34a','read','#f59e0b',0);
              INSERT INTO events (id, calendarId, uid, title, startTime, endTime)
                  VALUES ('e1','work','old@eigen','Old row',0,0);
              CREATE TABLE __schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0);
              INSERT INTO __schema_version (id, version) VALUES (1, 1);`);
    raw.close();
}

const tablesOf = (mdb: ManagedDatabase<typeof schema>): string[] =>
    (mdb.db.all(sql`SELECT name FROM sqlite_master WHERE type='table'`) as { name: string }[]).map((r) => r.name);

const columnsOf = (mdb: ManagedDatabase<typeof schema>, table: string): string[] =>
    (mdb.db.all(sql.raw(`PRAGMA table_info(${table})`)) as { name: string }[]).map((c) => c.name);

const versionOf = (mdb: ManagedDatabase<typeof schema>): number =>
    (mdb.db.all(sql`SELECT version FROM __schema_version WHERE id = 1`)[0] as { version: number }).version;

describe('calendar database migrations', () => {
    beforeAll(() => {
        mkdirSync(TEST_DIR, { recursive: true });
    });

    afterAll(() => {
        try {
            rmSync(TEST_DIR, { recursive: true, force: true });
        } catch {}
    });

    test('a populated v1 database reaches v2 keeping its calendars and share grants', async () => {
        const dbPath = nextDbPath();
        seedV1Database(dbPath);
        const seconds = Math.floor(Date.now() / 1000);

        const mdb = new ManagedDatabase(CALENDAR_DB_CONFIG, dbPath, {}, true);
        await mdb.open(0);

        expect(versionOf(mdb)).toBe(2);

        // The half no blob carries: a calendar's name and colors, and grants other Homes point at.
        expect(mdb.db.all(sql`SELECT id, name, color, isDefault, visible, ctag, shares FROM calendars`)).toEqual([
            {
                id: 'work',
                name: 'Work',
                color: '#2563eb',
                isDefault: 1,
                visible: 0,
                ctag: 7,
                shares: '[{"email":"bob@test.local","permission":"read"}]',
            },
        ]);
        expect(
            mdb.db.all(sql`SELECT id, ownerUserId, calendarId, calendarName, calendarColor, permission, color, visible
                           FROM shared_calendars`),
        ).toEqual([
            {
                id: 's1',
                ownerUserId: 'u-other',
                calendarId: 'their-cal',
                calendarName: 'Theirs',
                calendarColor: '#16a34a',
                permission: 'read',
                color: '#f59e0b',
                visible: 0,
            },
        ]);

        // The carried generation is clock-seeded, so every token a client holds from before is refused.
        const carried = mdb.db.all(sql`SELECT syncGen FROM calendars`) as { syncGen: number }[];
        expect(carried[0].syncGen).toBeGreaterThanOrEqual(seconds);

        // Every event row is dropped: its bytes lived in files the new schema does not adopt.
        expect(mdb.db.all(sql`SELECT * FROM events`)).toEqual([]);
        expect(tablesOf(mdb)).not.toContain('event_tombstones');
        expect(mdb.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);

        await mdb.close();
    });

    test('a fresh database reaches the same blob shape', async () => {
        const mdb = new ManagedDatabase(CALENDAR_DB_CONFIG, nextDbPath());
        await mdb.open(0);

        expect(versionOf(mdb)).toBe(2);
        const tables = tablesOf(mdb);
        expect(tables).toContain('calendars');
        expect(tables).toContain('shared_calendars');
        expect(tables).toContain('resources');
        expect(tables).toContain('events');
        expect(tables).toContain('resource_tombstones');
        expect(tables).not.toContain('pending_writes');
        expect(tables).not.toContain('event_tombstones');

        const cols = columnsOf(mdb, 'resources');
        expect(cols).toContain('ics');
        expect(cols).not.toContain('uriKey');
        expect(cols).not.toContain('mtime');
        expect(cols).not.toContain('size');
        expect(columnsOf(mdb, 'resource_tombstones')).not.toContain('uriKey');

        // The calendars are init's to seed, so the migration leaves the table empty.
        expect(mdb.db.all(sql`SELECT * FROM calendars`)).toEqual([]);

        await mdb.close();
    });

    // The DDL creates the indexes and the drizzle schema is what a query plan is read against, so a query
    // can only be proven to seek if the two name the same set.
    test('the migration and the schema name the same indexes', async () => {
        const mdb = new ManagedDatabase(CALENDAR_DB_CONFIG, nextDbPath());
        await mdb.open(0);

        const declared = Object.values(schema)
            .filter((table) => is(table, SQLiteTable))
            .flatMap((table) => getTableConfig(table).indexes.map((index) => index.config.name))
            .sort();
        const created = mdb.db
            .all<{
                name: string;
            }>(sql.raw("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"))
            .map((row) => row.name)
            .sort();

        expect(created).toEqual(declared);
        await mdb.close();
    });
});
