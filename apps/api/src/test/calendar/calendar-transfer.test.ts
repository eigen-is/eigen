import { beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { Calendar } from '../../lib/calendar/calendar';
import { CALENDAR_TEST_ROOT, makeCalendar } from '../calendar-test-helpers';
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
    (await calendar.getRawEvents(calendarId)).map((event) => event.title).sort();

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

    test('a write that fails mid-file keeps the series that landed and answers', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = (await calendar.getCalendars())[0].id;

        const restore = breakNthTransaction(calendar, 3);
        let result: Awaited<ReturnType<Calendar['importEvents']>>;
        try {
            result = await calendar.importEvents(calendarId, new TextEncoder().encode(FILE));
        } finally {
            restore();
        }

        // The loop holds no lock of its own, so the failing series is counted and the file goes on.
        expect(result).toEqual({ imported: 3, skipped: 0, failed: 1 });
        expect(await titlesOf(calendar, calendarId)).toEqual(['Series 1', 'Series 2', 'Series 4']);
        expect(await calendar.listResources(calendarId)).toHaveLength(3);
        expect(await calendar.getEventsByUid(UIDS[2])).toHaveLength(0);

        // A retry completes the file: the three that landed skip by UID, the refused one is written.
        expect(await calendar.importEvents(calendarId, new TextEncoder().encode(FILE))).toEqual({
            imported: 1,
            skipped: 3,
            failed: 0,
        });
        expect(await titlesOf(calendar, calendarId)).toEqual(['Series 1', 'Series 2', 'Series 3', 'Series 4']);
        expect(await calendar.listResources(calendarId)).toHaveLength(4);
    });
});
