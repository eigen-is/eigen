import { beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Calendar } from '../../lib/calendar/calendar';
import {
    CALENDAR_TEST_ROOT,
    defaultCalendarId,
    makeCalendar,
    putResource,
    storedEvents,
} from '../calendar-test-helpers';
import { waitFor } from '../fault-storage-helpers';
import { vcal } from '../ics-test-helpers';

// What one `.ics` import promises per series: the series that landed stay, the one whose commit failed
// leaves neither bytes nor rows, and a retry finishes the file without duplicating anything.

const series = (uid: string, summary: string): string[] => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTART:20261001T090000Z',
    'DTEND:20261001T100000Z',
    `SUMMARY:${summary}`,
    'END:VEVENT',
];

const UIDS = ['import-1@other', 'import-2@other', 'import-3@other', 'import-4@other'];
const FILE = vcal(...UIDS.map((uid, index) => series(uid, `Series ${index + 1}`)));

const titlesOf = async (calendar: Calendar, calendarId: string): Promise<string[]> =>
    storedEvents(calendar, calendarId)
        .map((event) => event.title)
        .sort();

// The one failure a blob write has left: the transaction carrying the third series does not commit.
function breakNthTransaction(calendar: Calendar, nth: number): () => void {
    const db = calendar.db as unknown as { transaction: (cb: unknown) => unknown };
    const original = db.transaction;
    let seen = 0;
    db.transaction = (cb: unknown) => {
        seen++;
        if (seen === nth) throw new Error('transaction boom');
        return original.call(db, cb);
    };
    return () => {
        db.transaction = original;
    };
}

describe('calendar import', () => {
    beforeAll(() => {
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
    });

    test('a write that fails mid-file keeps the series that landed, and a retry finishes the file', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = (await calendar.getCalendars())[0].id;

        const restore = breakNthTransaction(calendar, 3);
        try {
            await expect(calendar.importEvents(calendarId, new TextEncoder().encode(FILE))).rejects.toThrow(
                'transaction boom',
            );
        } finally {
            restore();
        }

        expect(await titlesOf(calendar, calendarId)).toEqual(['Series 1', 'Series 2']);
        expect(await calendar.listResources(calendarId)).toHaveLength(2);
        expect(await calendar.getEventsByUid(UIDS[2])).toHaveLength(0);

        // The two that landed skip by UID, and the rest are written.
        expect(await calendar.importEvents(calendarId, new TextEncoder().encode(FILE))).toEqual({
            imported: 2,
            skipped: 2,
            failed: 0,
        });
        expect(await titlesOf(calendar, calendarId)).toEqual(['Series 1', 'Series 2', 'Series 3', 'Series 4']);
        expect(await calendar.listResources(calendarId)).toHaveLength(4);
    });

    test("another request's event is announced while an import runs, and the import announces once at its end", async () => {
        const { instance: calendar, broadcasts, user } = await makeCalendar();
        const calendarId = (await calendar.getCalendars())[0].id;
        broadcasts.length = 0;

        // With the lock held, the import's first series and then the other request queue, so the other event lands mid-import.
        const gate = Promise.withResolvers<void>();
        const held = calendar.writeLock.run(() => gate.promise);
        const imported = calendar.importEvents(calendarId, new TextEncoder().encode(FILE));
        await waitFor(() => calendar.writeLock.waiting === 1);
        const other = calendar.putResource(calendarId, 'other.ics', vcal(series('other@other', 'Other request')), {
            ifMatch: null,
            ifNoneMatch: '*',
        });
        await waitFor(() => calendar.writeLock.waiting === 2);
        gate.resolve();
        await held;

        expect((await other).ok).toBe(true);
        expect(await imported).toEqual({ imported: 4, skipped: 0, failed: 0 });
        expect(broadcasts).toEqual([
            { type: SSEventType.CALENDAR_EVENT_CREATED, ownerId: user.id },
            { type: SSEventType.CALENDAR_EVENTS_CHANGED, ownerId: user.id },
        ]);
        expect(await titlesOf(calendar, calendarId)).toEqual([
            'Other request',
            'Series 1',
            'Series 2',
            'Series 3',
            'Series 4',
        ]);
    });
});

describe('two files that define one TZID', () => {
    const zone = (tzid: string, offset: string) => [
        'BEGIN:VTIMEZONE',
        `TZID:${tzid}`,
        'BEGIN:STANDARD',
        'DTSTART:19700101T000000',
        `TZOFFSETFROM:${offset}`,
        `TZOFFSETTO:${offset}`,
        'END:STANDARD',
        'END:VTIMEZONE',
    ];
    const zoned = (uid: string, block: string[], param: string) =>
        vcal(block, [
            'BEGIN:VEVENT',
            `UID:${uid}`,
            `DTSTART;TZID=${param}:20261110T100000`,
            `DTEND;TZID=${param}:20261110T110000`,
            'SUMMARY:Zoned',
            'END:VEVENT',
        ]);
    const CUSTOM = 'Customized Time Zone';
    const QUOTED = `"${CUSTOM}"`;

    const roundTrip = async (files: Record<string, string>) => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        for (const [uid, body] of Object.entries(files))
            await putResource(harness.instance, calendarId, `${uid}.ics`, body);
        const text = await harness.instance.exportEvents(calendarId);

        const target = await makeCalendar();
        await target.instance.importEvents(await defaultCalendarId(target), new TextEncoder().encode(text));
        const start = async (uid: string) => (await target.instance.getEventsByUid(uid))[0].startTime.toISOString();
        return { text, start, blocks: text.match(/BEGIN:VTIMEZONE/g)?.length };
    };

    test('keeps each time when the definitions differ', async () => {
        const { start, blocks } = await roundTrip({
            tokyo: zoned('tokyo', zone(CUSTOM, '+0900'), QUOTED),
            amsterdam: zoned('amsterdam', zone(CUSTOM, '+0100'), QUOTED),
            amsterdamToo: zoned('amsterdamToo', zone(CUSTOM, '+0100'), QUOTED),
        });

        expect(await start('tokyo')).toBe('2026-11-10T01:00:00.000Z');
        expect(await start('amsterdam')).toBe('2026-11-10T09:00:00.000Z');
        expect(await start('amsterdamToo')).toBe('2026-11-10T09:00:00.000Z');
        expect(blocks).toBe(2);
    });

    test('keeps each time when the name needs quoting and escaping', async () => {
        const name = '(UTC+01:00) Amsterdam, Berlin';
        const { start } = await roundTrip({
            first: zoned('first', zone(name.replace(',', '\\,'), '+0100'), `"${name}"`),
            second: zoned('second', zone(name.replace(',', '\\,'), '+0900'), `"${name}"`),
        });

        expect(await start('first')).toBe('2026-11-10T09:00:00.000Z');
        expect(await start('second')).toBe('2026-11-10T01:00:00.000Z');
    });

    test('carries an identical definition once and a client file as it was written', async () => {
        const { text, blocks } = await roundTrip({
            one: zoned('one', zone(CUSTOM, '+0100'), QUOTED),
            two: zoned('two', zone(CUSTOM, '+0100'), QUOTED),
        });

        expect(blocks).toBe(1);
        expect(text.match(/DTSTART;TZID=Customized Time Zone:20261110T100000/g)).toHaveLength(2);
    });

    test('keeps an IANA name, which resolves through Intl whatever a file defines for it', async () => {
        const IANA = 'Europe/Amsterdam';
        const { text, start, blocks } = await roundTrip({
            apple: zoned('apple', zone(IANA, '+0100'), IANA),
            other: zoned('other', zone(IANA, '+0200'), IANA),
        });

        expect(blocks).toBe(1);
        expect(text.match(/DTSTART;TZID=Europe\/Amsterdam:20261110T100000/g)).toHaveLength(2);
        expect(await start('apple')).toBe('2026-11-10T09:00:00.000Z');
        expect(await start('other')).toBe('2026-11-10T09:00:00.000Z');
    });
});
