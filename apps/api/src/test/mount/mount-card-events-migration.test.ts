import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { MOUNT_DB_CONFIG } from '../../lib/mount/db-config';

function migrateUpTo(db: Database, version: number): void {
    for (const m of MOUNT_DB_CONFIG.migrations) {
        if (m.version <= version) m.up(db);
    }
}

function eventTypes(db: Database): Record<string, string> {
    const rows = db.query<{ id: string; eventType: string }, []>('SELECT id, eventType FROM file_events').all();
    return Object.fromEntries(rows.map((r) => [r.id, r.eventType]));
}

describe('mount metadata v9 migration', () => {
    test('renames the stored sticky-* card events to card-* and leaves every other event alone', () => {
        const db = new Database(':memory:');
        migrateUpTo(db, 8);
        db.exec(
            `INSERT INTO paths (id, name, type, ownerId, mimeType) VALUES ('board', 'Board', 'stickies', 'o', 'x')`,
        );
        const insert = db.prepare(
            `INSERT INTO file_events (id, pathId, eventType, actorUserId, actorEmail, details) VALUES (?, 'board', ?, 'u', 'u@test.eigen.is', ?)`,
        );
        insert.run('a', 'sticky-added', '{"card":"Ship it","toColumn":"Done","cardId":"c1"}');
        insert.run('m', 'sticky-moved', '{"card":"Ship it","toColumn":"Doing","cardId":"c1"}');
        insert.run('r', 'sticky-removed', '{"card":"Ship it","cardId":"c1"}');
        insert.run('e', 'edited', null);
        insert.run('c', 'commented', '{"preview":"sticky-added"}');

        const v9 = MOUNT_DB_CONFIG.migrations.find((m) => m.version === 9);
        expect(v9).toBeDefined();
        v9?.up(db);

        expect(eventTypes(db)).toEqual({
            a: 'card-added',
            m: 'card-moved',
            r: 'card-removed',
            e: 'edited',
            c: 'commented',
        });
        const details = db.query<{ details: string }, []>(`SELECT details FROM file_events WHERE id = 'a'`).get();
        expect(details?.details).toBe('{"card":"Ship it","toColumn":"Done","cardId":"c1"}');
    });
});
