import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
    CALENDAR_TEST_ROOT,
    defaultCalendarId,
    makeCalendar,
    putResource,
    resourceRowOf,
    resourceTextOf,
    vevent,
} from '../calendar-test-helpers';
import { breakTransaction } from '../db-test-helpers';
import { vcal } from '../ics-test-helpers';

// The store behind every calendar write: the blob the row carries, and what it looks like when the
// transaction that would have moved it does not commit. See docs/CALENDAR.md § Storage model.

describe('calendar blob store', () => {
    beforeAll(() => {
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
    });

    test('a stored resource is the row’s bytes, and the index projects them', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);

        expect(
            (await putResource(harness.instance, calendarId, 'first.ics', vcal(vevent('store-1@eigen', 'Kickoff')))).ok,
        ).toBe(true);

        const stored = await resourceTextOf(harness.instance, calendarId, 'first.ics');
        expect(stored).toContain('SUMMARY:Kickoff');
        // The row id rides in the bytes, so the projection can be thrown away and rebuilt from them.
        expect(stored).toContain('X-EIGEN-EVENT-ID:');

        const rows = await harness.instance.getRawEvents(calendarId);
        expect(rows.map((r) => r.title)).toEqual(['Kickoff']);
        expect(rows[0].uri).toBe('first.ics');
        expect(rows[0].etag).toBe((await harness.instance.getResource(calendarId, 'first.ics'))!.etag);
    });
});

describe('a write that does not commit', () => {
    test('a replacement whose transaction throws leaves the previous bytes, etag and byte count', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        await putResource(calendar, calendarId, 'kept.ics', vcal(vevent('kept@eigen', 'Before')));
        const before = resourceRowOf(calendar, calendarId, 'kept.ics');
        const bytesBefore = await calendar.size();
        const ctagBefore = (await calendar.getCollection(calendarId))!.ctag;

        const restore = breakTransaction(calendar);
        try {
            await expect(
                putResource(calendar, calendarId, 'kept.ics', vcal(vevent('kept@eigen', 'After'))),
            ).rejects.toThrow('transaction boom');
        } finally {
            restore();
        }

        // The stored bytes are the resource: a failed write hands the reader the previous ones, unchanged.
        expect(await resourceTextOf(calendar, calendarId, 'kept.ics')).toContain('SUMMARY:Before');
        expect((await calendar.getResource(calendarId, 'kept.ics'))!.etag).toBe(before.etag);
        expect(resourceRowOf(calendar, calendarId, 'kept.ics')).toEqual(before);
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
                putResource(calendar, calendarId, 'orphan.ics', vcal(vevent('orphan@eigen', 'Orphan'))),
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
        await putResource(calendar, calendarId, 'doomed.ics', vcal(vevent('doomed@eigen', 'Doomed')));
        const before = resourceRowOf(calendar, calendarId, 'doomed.ics');
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

        expect(resourceRowOf(calendar, calendarId, 'doomed.ics')).toEqual(before);
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
        await putResource(calendar, calendarId, 'gone.ics', vcal(vevent('gone@eigen', 'Gone')));
        const bytesBefore = await calendar.size();
        const row = resourceRowOf(calendar, calendarId, 'gone.ics');

        expect(await calendar.deleteResource(calendarId, 'gone.ics', { ifMatch: null })).toEqual({ ok: true });

        expect(await calendar.getResource(calendarId, 'gone.ics')).toBeNull();
        expect((await calendar.getDeletedResourcesSince(calendarId, 0)).map((d) => d.uri)).toEqual(['gone.ics']);
        expect(await calendar.size()).toBe(bytesBefore - row.ics.byteLength);
    });

    test('a REST delete of an event that is already gone is a no-op, where the DAV one is a 404', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        await putResource(calendar, calendarId, 'erased.ics', vcal(vevent('erased@eigen', 'Erased')));
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
