import { beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { CALENDAR_TEST_ROOT, makeCalendar } from '../calendar-test-helpers';

describe('calendar restart', () => {
    beforeAll(() => {
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
    });

    test('a calendar and its event come back over the same directory, ctag included', async () => {
        const harness = await makeCalendar();
        const cal = harness.instance.createCalendar({ name: 'Work', color: '#2563eb' });
        const event = harness.instance.createEvent(cal.id, {
            title: 'Standup',
            startTime: new Date('2026-03-02T09:00:00Z'),
            endTime: new Date('2026-03-02T09:15:00Z'),
            allDay: false,
        });
        const ctag = harness.instance.getCalendarById(cal.id)!.ctag;

        const restarted = await harness.reopen();
        try {
            const reopened = restarted.instance.getCalendarById(cal.id);
            expect(reopened?.name).toBe('Work');
            // A ctag that reset would tell every CalDAV client the collection rewound.
            expect(reopened?.ctag).toBe(ctag);
            const rows = restarted.instance.getRawEvents(cal.id);
            expect(rows.map((r) => r.title)).toEqual(['Standup']);
            expect(rows[0].uid).toBe(event.uid);
        } finally {
            await restarted.close();
        }
    });

    test('reopening a home that has no calendar yet seeds exactly one default', async () => {
        const harness = await makeCalendar();
        const seeded = harness.instance.getCalendars();
        expect(seeded).toHaveLength(1);
        expect(seeded[0].isDefault).toBe(true);

        const restarted = await harness.reopen();
        try {
            expect(restarted.instance.getCalendars().map((c) => c.id)).toEqual([seeded[0].id]);
        } finally {
            await restarted.close();
        }
    });
});
