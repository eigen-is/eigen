import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import type { Calendar } from '../../lib/calendar/calendar';
import * as schema from '../../lib/calendar/schema';
import { CALENDAR_TEST_ROOT, makeCalendar, resourceTextOf } from '../calendar-test-helpers';
import type { TestHome } from '../home-test-helpers';
import { vcal } from '../ics-test-helpers';

// The store behind every calendar write: the blob the row carries, the byte counter beside it, and what
// each of them looks like when the transaction that would have moved them does not commit.
// See docs/CALENDAR.md § Storage model.

const event = (uid: string, summary: string, extra: string[] = []): string[] => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTART:20260401T100000Z',
    'DTEND:20260401T110000Z',
    `SUMMARY:${summary}`,
    ...extra,
    'END:VEVENT',
];

const put = (calendar: Calendar, calendarId: string, uri: string, body: string) =>
    calendar.putResource(calendarId, uri, body, { ifMatch: null, ifNoneMatch: null });

const rowOf = (calendar: Calendar, calendarId: string, uri: string) =>
    calendar.db
        .select()
        .from(schema.resources)
        .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uri, uri)))
        .get()!;

const storedBytes = (calendar: Calendar): number =>
    calendar.db
        .select({ total: sql<number>`COALESCE(SUM(length(${schema.resources.ics})), 0)` })
        .from(schema.resources)
        .get()!.total;

async function defaultCalendarId(harness: TestHome<Calendar>): Promise<string> {
    return (await harness.instance.getCalendars())[0].id;
}

// The one failure a blob write has left: the transaction carrying it rolls back. The throw goes inside the
// callback, so SQLite really does undo the statements — a throw before it would prove nothing. Returns the undo.
function breakTransaction(calendar: Calendar): () => void {
    const db = calendar.db as unknown as { transaction: (cb: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    db.transaction = (cb) =>
        original.call(db, (tx: unknown) => {
            cb(tx);
            throw new Error('transaction boom');
        });
    return () => {
        db.transaction = original;
    };
}

describe('calendar blob store', () => {
    beforeAll(() => {
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
    });

    test('a stored resource is the row’s bytes, and the index projects them', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);

        expect((await put(harness.instance, calendarId, 'first.ics', vcal(event('store-1@eigen', 'Kickoff')))).ok).toBe(
            true,
        );

        const stored = await resourceTextOf(harness.instance, calendarId, 'first.ics');
        expect(stored).toContain('SUMMARY:Kickoff');
        // The row id rides in the bytes, so the projection can be thrown away and rebuilt from them.
        expect(stored).toContain('X-EIGEN-EVENT-ID:');

        const rows = await harness.instance.getRawEvents(calendarId);
        expect(rows.map((r) => r.title)).toEqual(['Kickoff']);
        expect(rows[0].uri).toBe('first.ics');
        expect(rows[0].etag).toBe((await harness.instance.getResource(calendarId, 'first.ics'))!.etag);
    });

    test('two concurrent attendee updates keep both answers, and the byte counter stays exact', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const created = await harness.instance.createEvent(calendarId, {
            title: 'Standup',
            startTime: new Date('2026-04-01T10:00:00Z'),
            endTime: new Date('2026-04-01T11:00:00Z'),
            allDay: false,
            data: {
                attendees: [
                    { email: 'one@test.local', status: 'pending', role: 'required' },
                    { email: 'two@test.local', status: 'pending', role: 'required' },
                ],
            },
        });

        await Promise.all([
            harness.instance.receiveAttendeeStatus(created.id, 'one@test.local', 'accepted'),
            harness.instance.receiveAttendeeStatus(created.id, 'two@test.local', 'declined'),
        ]);

        const stored = (await harness.instance.getRawEvents(calendarId))[0];
        expect(stored.data?.attendees?.map((a) => a.status).sort()).toEqual(['accepted', 'declined']);
        expect(await harness.instance.size()).toBe(storedBytes(harness.instance));
    });

    test('the byte counter follows the blobs through a write, a replace and a delete', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);

        await put(harness.instance, calendarId, 'counted.ics', vcal(event('counted@eigen', 'Counted')));
        expect(await harness.instance.size()).toBe(storedBytes(harness.instance));

        await put(
            harness.instance,
            calendarId,
            'counted.ics',
            vcal(event('counted@eigen', 'Counted', ['DESCRIPTION:Much longer than it was'])),
        );
        expect(await harness.instance.size()).toBe(storedBytes(harness.instance));

        await harness.instance.deleteResource(calendarId, 'counted.ics', { ifMatch: null });
        expect(await harness.instance.size()).toBe(0);
    });

    test('a reopened Home seeds its counter from the blobs it holds', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'seeded.ics', vcal(event('seeded@eigen', 'Seeded')));
        const before = await harness.instance.size();

        const restarted = await harness.reopen();
        try {
            expect(await restarted.instance.size()).toBe(before);
            expect(await resourceTextOf(restarted.instance, calendarId, 'seeded.ics')).toContain('SUMMARY:Seeded');
        } finally {
            await restarted.close();
        }
    });
});

describe('a write that does not commit', () => {
    test('a replacement whose transaction throws leaves the previous bytes, etag and byte count', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        await put(calendar, calendarId, 'kept.ics', vcal(event('kept@eigen', 'Before')));
        const before = rowOf(calendar, calendarId, 'kept.ics');
        const bytesBefore = await calendar.size();
        const ctagBefore = (await calendar.getCollection(calendarId))!.ctag;

        const restore = breakTransaction(calendar);
        try {
            await expect(put(calendar, calendarId, 'kept.ics', vcal(event('kept@eigen', 'After')))).rejects.toThrow(
                'transaction boom',
            );
        } finally {
            restore();
        }

        // The stored bytes are the resource: a failed write hands the reader the previous ones, unchanged.
        expect(await resourceTextOf(calendar, calendarId, 'kept.ics')).toContain('SUMMARY:Before');
        expect((await calendar.getResource(calendarId, 'kept.ics'))!.etag).toBe(before.etag);
        expect(rowOf(calendar, calendarId, 'kept.ics')).toEqual(before);
        expect((await calendar.getCollection(calendarId))!.ctag).toBe(ctagBefore);
        // The delta is applied only once the transaction returns, so a rollback leaves no drift.
        expect(await calendar.size()).toBe(bytesBefore);
    });

    test('a create whose transaction throws stores no row and no blob', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        const bytesBefore = await calendar.size();

        const restore = breakTransaction(calendar);
        try {
            await expect(
                put(calendar, calendarId, 'orphan.ics', vcal(event('orphan@eigen', 'Orphan'))),
            ).rejects.toThrow('transaction boom');
        } finally {
            restore();
        }

        expect(await calendar.listResources(calendarId)).toHaveLength(0);
        expect(await calendar.size()).toBe(bytesBefore);
    });

    test('a delete whose transaction throws leaves the row, ctag, tombstones and bytes untouched', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        await put(calendar, calendarId, 'doomed.ics', vcal(event('doomed@eigen', 'Doomed')));
        const before = rowOf(calendar, calendarId, 'doomed.ics');
        const ctagBefore = (await calendar.getCollection(calendarId))!.ctag;
        const bytesBefore = await calendar.size();

        const restore = breakTransaction(calendar);
        try {
            await expect(calendar.deleteResource(calendarId, 'doomed.ics', { ifMatch: null })).rejects.toThrow(
                'transaction boom',
            );
        } finally {
            restore();
        }

        expect(rowOf(calendar, calendarId, 'doomed.ics')).toEqual(before);
        expect((await calendar.getCollection(calendarId))!.ctag).toBe(ctagBefore);
        expect(await calendar.getDeletedResourcesSince(calendarId, 0)).toEqual([]);
        expect(await calendar.size()).toBe(bytesBefore);
    });
});

describe('deleting', () => {
    test('a delete removes the row and its blob, and tombstones the uri, in one transaction', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        await put(calendar, calendarId, 'gone.ics', vcal(event('gone@eigen', 'Gone')));
        const bytesBefore = await calendar.size();
        const row = rowOf(calendar, calendarId, 'gone.ics');

        expect(await calendar.deleteResource(calendarId, 'gone.ics', { ifMatch: null })).toEqual({ ok: true });

        expect(await calendar.getResource(calendarId, 'gone.ics')).toBeNull();
        expect((await calendar.getDeletedResourcesSince(calendarId, 0)).map((d) => d.uri)).toEqual(['gone.ics']);
        expect(await calendar.size()).toBe(bytesBefore - row.ics.byteLength);
    });

    test('a REST delete of an event that is already gone is a no-op, where the DAV one is a 404', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        await put(calendar, calendarId, 'erased.ics', vcal(event('erased@eigen', 'Erased')));
        const stored = (await calendar.getRawEvents(calendarId))[0];

        await calendar.deleteEvent(calendarId, stored.id);
        const ctagAfterDelete = (await calendar.getCollection(calendarId))!.ctag;

        await calendar.deleteEvent(calendarId, stored.id);

        expect((await calendar.getCollection(calendarId))!.ctag).toBe(ctagAfterDelete);
        expect(await calendar.deleteResource(calendarId, 'erased.ics', { ifMatch: null })).toEqual({
            ok: false,
            error: 'not-found',
        });
    });

    test('deleting a calendar takes its blobs off the byte counter and its tombstones with it', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const scratch = (await calendar.createCalendar({ name: 'Scratch', color: '#2563eb' })).id;
        const before = await calendar.size();
        await put(calendar, scratch, 'a.ics', vcal(event('cal-delete-a@eigen', 'A')));
        await put(calendar, scratch, 'b.ics', vcal(event('cal-delete-b@eigen', 'B')));
        const added = (await calendar.size()) - before;
        expect(added).toBeGreaterThan(0);
        await calendar.deleteResource(scratch, 'b.ics', { ifMatch: null });

        await calendar.deleteCalendar(scratch);

        expect(await calendar.size()).toBe(before);
        expect(await calendar.size()).toBe(storedBytes(calendar));
        // The resources and their event rows went with the row, by cascade.
        expect(calendar.db.select().from(schema.events).all()).toEqual([]);
        // No cascade reaches a tombstone, so a calendar recreated at this id would inherit its 404s.
        expect(calendar.db.select().from(schema.resourceTombstones).all()).toEqual([]);
    });
});

describe('the syncGen of a calendar row', () => {
    test('is clock-seeded at creation, and a calendar made later gets its own', async () => {
        const seconds = Math.floor(Date.now() / 1000);
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const seeded = (await calendar.getCollections())[0];
        expect(seeded.syncGen).toBeGreaterThanOrEqual(seconds);

        // A calendar recreated at a deleted id must never reissue a generation a client has already seen, so
        // the clock — not a constant — decides it.
        const ticked = spyOn(Date, 'now').mockReturnValue((seconds + 5) * 1000);
        try {
            const later = await calendar.createCalendar({ name: 'Later', color: '#16a34a' });
            expect((await calendar.getCollection(later.id))!.syncGen).toBe(seconds + 5);
        } finally {
            ticked.mockRestore();
        }
    });
});

describe('rebuildProjection', () => {
    test('every event row and projected column comes back from the blobs', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        // Seeded through the store, because a VEVENT without X-EIGEN-EVENT-ID gets a fresh id on projection.
        await put(
            calendar,
            calendarId,
            'series.ics',
            vcal(event('rebuild-series@eigen', 'Weekly', ['RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE:20260415T100000Z']), [
                'BEGIN:VEVENT',
                'UID:rebuild-series@eigen',
                'RECURRENCE-ID:20260408T100000Z',
                'DTSTART:20260408T140000Z',
                'DTEND:20260408T150000Z',
                'SUMMARY:Moved occurrence',
                'END:VEVENT',
            ]),
        );
        await put(calendar, calendarId, 'plain.ics', vcal(event('rebuild-plain@eigen', 'Plain')));
        await put(calendar, calendarId, 'deleted.ics', vcal(event('rebuild-deleted@eigen', 'Deleted')));
        await calendar.deleteResource(calendarId, 'deleted.ics', { ifMatch: null });

        const resourcesBefore = calendar.db.select().from(schema.resources).all();
        const eventsBefore = calendar.db.select().from(schema.events).all();
        const tombstonesBefore = calendar.db.select().from(schema.resourceTombstones).all();
        expect(tombstonesBefore).toHaveLength(1);
        const ctagBefore = (await calendar.getCollection(calendarId))!.ctag;
        expect(eventsBefore.length).toBeGreaterThan(2);

        // Corrupt every column the blob decides, plus the event rows themselves.
        calendar.db
            .update(schema.resources)
            .set({ uid: sql`'corrupt-' || ${schema.resources.id}`, etag: 'corrupt', hasUnindexedRecurrence: true })
            .run();
        calendar.db.update(schema.events).set({ title: 'corrupt', parentEventId: null, rrule: null }).run();
        calendar.db.delete(schema.events).where(eq(schema.events.uid, 'rebuild-plain@eigen')).run();

        calendar.rebuildProjection();

        expect(calendar.db.select().from(schema.resources).all()).toEqual(resourcesBefore);
        expect(calendar.db.select().from(schema.events).all()).toEqual(eventsBefore);
        // No blob carries a deletion, so a rebuild leaves the tombstone a syncing client still needs.
        expect(calendar.db.select().from(schema.resourceTombstones).all()).toEqual(tombstonesBefore);
        // A rebuild is not a change: no ctag moves, so no client is told to resync.
        expect((await calendar.getCollection(calendarId))!.ctag).toBe(ctagBefore);
    });
});

describe('moveEvent', () => {
    const seriesOf = async (harness: TestHome<Calendar>, calendarId: string, uid: string, uri: string) => {
        await put(harness.instance, calendarId, uri, vcal(event(uid, 'Movable')));
        return (await harness.instance.getRawEvents(calendarId)).find((e) => e.uid === uid)!;
    };

    test('the blob and its rows re-home together, under the same ids', async () => {
        const harness = await makeCalendar();
        const source = await defaultCalendarId(harness);
        const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
        const moved = await seriesOf(harness, source, 'move-1@eigen', 'movable.ics');
        const bytes = await harness.instance.size();

        const after = await harness.instance.moveEvent(source, moved.id, target);

        expect(after.id).toBe(moved.id);
        expect(after.calendarId).toBe(target);
        expect(await harness.instance.listResources(source)).toHaveLength(0);
        expect((await harness.instance.listResources(target)).map((r) => r.uri)).toEqual(['movable.ics']);
        expect(await resourceTextOf(harness.instance, target, 'movable.ics')).toContain('SUMMARY:Movable');
        // Nothing was written or removed, so the counter cannot have moved.
        expect(await harness.instance.size()).toBe(bytes);
        // The source lists the uri as gone exactly once, and the target never as both.
        expect((await harness.instance.getDeletedResourcesSince(source, 0)).map((d) => d.uri)).toEqual(['movable.ics']);
        expect(await harness.instance.getDeletedResourcesSince(target, 0)).toEqual([]);
    });

    test('a target that already holds the UID refuses the move', async () => {
        const harness = await makeCalendar();
        const source = await defaultCalendarId(harness);
        const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
        const moved = await seriesOf(harness, source, 'move-2@eigen', 'a.ics');
        await put(harness.instance, target, 'b.ics', vcal(event('move-2@eigen', 'Twin')));

        await expect(harness.instance.moveEvent(source, moved.id, target)).rejects.toThrow(
            'The target calendar already holds this event',
        );
        expect((await harness.instance.listResources(source)).map((r) => r.uri)).toEqual(['a.ics']);
    });

    test('a name the target already uses becomes a fresh one', async () => {
        const harness = await makeCalendar();
        const source = await defaultCalendarId(harness);
        const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
        const moved = await seriesOf(harness, source, 'move-3@eigen', 'taken.ics');
        await put(harness.instance, target, 'taken.ics', vcal(event('other@eigen', 'Already there')));

        await harness.instance.moveEvent(source, moved.id, target);

        const names = (await harness.instance.listResources(target)).map((r) => r.uri).sort();
        expect(names).toHaveLength(2);
        expect(names).toContain('taken.ics');
        expect(await harness.instance.listResources(source)).toHaveLength(0);
        // The one the target already held keeps its own bytes.
        expect(await resourceTextOf(harness.instance, target, 'taken.ics')).toContain('SUMMARY:Already there');
    });

    test('a uri the target holds only as a tombstone still yields a fresh name', async () => {
        const harness = await makeCalendar();
        const source = await defaultCalendarId(harness);
        const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
        await put(harness.instance, target, 'reused.ics', vcal(event('reused@eigen', 'Removed later')));
        await harness.instance.deleteResource(target, 'reused.ics', { ifMatch: null });
        const moved = await seriesOf(harness, source, 'move-4@eigen', 'reused.ics');

        await harness.instance.moveEvent(source, moved.id, target);

        // The name is free, so the move keeps it — and the stale removal is dropped with the write.
        expect((await harness.instance.listResources(target)).map((r) => r.uri)).toEqual(['reused.ics']);
        expect(await harness.instance.getDeletedResourcesSince(target, 0)).toEqual([]);
    });

    test('a move whose transaction throws leaves both calendars as they were', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const source = await defaultCalendarId(harness);
        const target = (await calendar.createCalendar({ name: 'Target', color: '#2563eb' })).id;
        const moved = await seriesOf(harness, source, 'move-5@eigen', 'rolled-back.ics');
        const before = rowOf(calendar, source, 'rolled-back.ics');
        const sourceCtag = (await calendar.getCollection(source))!.ctag;
        const targetCtag = (await calendar.getCollection(target))!.ctag;

        const restore = breakTransaction(calendar);
        try {
            await expect(calendar.moveEvent(source, moved.id, target)).rejects.toThrow('transaction boom');
        } finally {
            restore();
        }

        expect(rowOf(calendar, source, 'rolled-back.ics')).toEqual(before);
        expect(await calendar.listResources(target)).toHaveLength(0);
        expect((await calendar.getCollection(source))!.ctag).toBe(sourceCtag);
        expect((await calendar.getCollection(target))!.ctag).toBe(targetCtag);
        expect(await calendar.getDeletedResourcesSince(source, 0)).toEqual([]);
    });
});

describe('calendar ids', () => {
    test('two calendars cannot share one id, and an unsafe one is refused', async () => {
        const harness = await makeCalendar();
        await harness.instance.createCalendar({ name: 'Work', color: '#2563eb', id: 'Work' });

        await expect(harness.instance.createCalendar({ name: 'work', color: '#16a34a', id: 'Work' })).rejects.toThrow(
            'Calendar already exists',
        );
        // The case variant is a name of its own: nothing folds an id the client chose.
        expect((await harness.instance.createCalendar({ name: 'work', color: '#16a34a', id: 'work' })).id).toBe('work');
        await expect(
            harness.instance.createCalendar({ name: 'bad', color: '#16a34a', id: '../escape' }),
        ).rejects.toThrow('Invalid calendar name');
    });
});
