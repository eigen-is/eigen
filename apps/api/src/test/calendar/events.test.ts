import { beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { Calendar } from '../../lib/calendar/calendar';
import {
    CALENDAR_TEST_ROOT,
    defaultCalendarId,
    makeCalendar,
    putResource,
    resourceRowOf,
    resourceTextOf,
    storedEvents,
    vevent,
} from '../calendar-test-helpers';
import { breakTransaction } from '../db-test-helpers';
import type { TestHome } from '../home-test-helpers';
import { vcal } from '../ics-test-helpers';

// The event writes that re-home a stored resource. See docs/CALENDAR.md § Every write takes one lock and one function.

beforeAll(() => {
    rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
});

describe('a patch that changes nothing', () => {
    // A client's own spelling, which a rewrite through the store must not get a chance to disturb.
    const CLIENT_LINES = [
        'DURATION:PT1H',
        'X-CLIENT;X-P="a b":kept',
        'ATTENDEE;PARTSTAT=TENTATIVE;ROLE=REQ-PARTICIPANT:mailto:g@example.com',
    ];
    const stored = async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const calendar = harness.instance;
        const body = vcal([
            'BEGIN:VEVENT',
            'UID:same',
            'DTSTART:20260401T100000Z',
            'SUMMARY:Same',
            ...CLIENT_LINES,
            'END:VEVENT',
        ]);
        await putResource(calendar, calendarId, 'same.ics', body);
        const event = storedEvents(calendar, calendarId)[0];
        return { calendar, calendarId, event, ctag: (await calendar.getCollection(calendarId))?.ctag };
    };

    test('a save restating the stored event leaves the row and the bytes alone', async () => {
        const { calendar, calendarId, event, ctag } = await stored();
        const row = resourceRowOf(calendar, calendarId, 'same.ics');

        const saved = await calendar.updateEvent(calendarId, event.id, {
            title: event.title,
            startTime: event.startTime,
            endTime: event.endTime,
            allDay: event.allDay,
            timezone: event.timezone,
            data: event.data,
        });

        expect(saved.etag).toBe(event.etag);
        expect((await calendar.getCollection(calendarId))?.ctag).toBe(ctag);
        expect(resourceRowOf(calendar, calendarId, 'same.ics').ics).toEqual(row.ics);
    });

    test('an answer the guest already gave moves no ctag', async () => {
        const { calendar, calendarId, event, ctag } = await stored();

        await calendar.receiveAttendeeStatus(event.id, 'g@example.com', 'tentative');

        expect((await calendar.getCollection(calendarId))?.ctag).toBe(ctag);
        expect(storedEvents(calendar, calendarId)[0].etag).toBe(event.etag);
    });
});

describe('moveEvent', () => {
    const seriesOf = async (harness: TestHome<Calendar>, calendarId: string, uid: string, uri: string) => {
        await putResource(harness.instance, calendarId, uri, vcal(vevent(uid, 'Movable')));
        return storedEvents(harness.instance, calendarId).find((e) => e.uid === uid)!;
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
        await putResource(harness.instance, target, 'b.ics', vcal(vevent('move-2@eigen', 'Twin')));

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
        await putResource(harness.instance, target, 'taken.ics', vcal(vevent('other@eigen', 'Already there')));

        await harness.instance.moveEvent(source, moved.id, target);

        const names = (await harness.instance.listResources(target)).map((r) => r.uri).sort();
        expect(names).toHaveLength(2);
        expect(names).toContain('taken.ics');
        expect(await harness.instance.listResources(source)).toHaveLength(0);
        // The one the target already held keeps its own bytes.
        expect(await resourceTextOf(harness.instance, target, 'taken.ics')).toContain('SUMMARY:Already there');
    });

    test('a uri the target holds only as a tombstone is free, and the move drops that removal', async () => {
        const harness = await makeCalendar();
        const source = await defaultCalendarId(harness);
        const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
        await putResource(harness.instance, target, 'reused.ics', vcal(vevent('reused@eigen', 'Removed later')));
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
        const before = resourceRowOf(calendar, source, 'rolled-back.ics');
        const sourceCtag = (await calendar.getCollection(source))!.ctag;
        const targetCtag = (await calendar.getCollection(target))!.ctag;

        const restore = breakTransaction(calendar);
        try {
            await expect(calendar.moveEvent(source, moved.id, target)).rejects.toThrow('transaction boom');
        } finally {
            restore();
        }

        expect(resourceRowOf(calendar, source, 'rolled-back.ics')).toEqual(before);
        expect(await calendar.listResources(target)).toHaveLength(0);
        expect((await calendar.getCollection(source))!.ctag).toBe(sourceCtag);
        expect((await calendar.getCollection(target))!.ctag).toBe(targetCtag);
        expect(await calendar.getDeletedResourcesSince(source, 0)).toEqual([]);
    });
});
