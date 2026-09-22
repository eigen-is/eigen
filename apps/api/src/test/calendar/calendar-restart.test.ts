import { beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { CALENDAR_TEST_ROOT, makeCalendar, resourceTextOf } from '../calendar-test-helpers';

describe('calendar restart', () => {
    beforeAll(() => {
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
    });

    test('a calendar and its event come back over the same database, ctag included', async () => {
        const harness = await makeCalendar();
        const cal = await harness.instance.createCalendar({ name: 'Work', color: '#2563eb' });
        const event = await harness.instance.createEvent(cal.id, {
            title: 'Standup',
            startTime: new Date('2026-03-02T09:00:00Z'),
            endTime: new Date('2026-03-02T09:15:00Z'),
            allDay: false,
        });
        const ctag = (await harness.instance.getCalendarById(cal.id))!.ctag;
        const uri = (await harness.instance.getRawEvents(cal.id))[0].uri;
        const stored = await resourceTextOf(harness.instance, cal.id, uri);

        const restarted = await harness.reopen();
        try {
            const reopened = await restarted.instance.getCalendarById(cal.id);
            expect(reopened?.name).toBe('Work');
            // A ctag that reset would tell every CalDAV client the collection rewound.
            expect(reopened?.ctag).toBe(ctag);
            const rows = await restarted.instance.getRawEvents(cal.id);
            expect(rows.map((r) => r.title)).toEqual(['Standup']);
            expect(rows[0].uid).toBe(event.uid);
            // The bytes are the resource, so a restart serves back exactly what the write stored.
            expect(await resourceTextOf(restarted.instance, cal.id, uri)).toBe(stored);
        } finally {
            await restarted.close();
        }
    });

    test('reopening a home that has no calendar yet seeds exactly one default', async () => {
        const harness = await makeCalendar();
        const seeded = await harness.instance.getCalendars();
        expect(seeded).toHaveLength(1);
        expect(seeded[0].isDefault).toBe(true);

        const restarted = await harness.reopen();
        try {
            expect((await restarted.instance.getCalendars()).map((c) => c.id)).toEqual([seeded[0].id]);
        } finally {
            await restarted.close();
        }
    });
});
