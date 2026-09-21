import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Calendar } from '../../lib/calendar/calendar';
import { PATHS } from '../../lib/core';
import { calendarsDirOf, DyingFilesystem, makeCalendar } from '../calendar-test-helpers';
import type { TestHome } from '../home-test-helpers';
import { vcal } from '../ics-test-helpers';

// What one `.ics` import promises per series: the series that landed stay, the one whose write failed leaves
// neither a file nor a row, and a retry finishes the file without duplicating anything.

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

const filesOf = (harness: TestHome<Calendar>, calendarId: string): string[] =>
    readdirSync(join(calendarsDirOf(harness.dir), calendarId));

describe('calendar import', () => {
    beforeAll(() => {
        rmSync(join(import.meta.dir, '../../../../../data-test'), { recursive: true, force: true });
    });

    test('a write that fails mid-file keeps the series that landed and answers', async () => {
        let storage!: DyingFilesystem;
        const harness = await makeCalendar((homeDir) => {
            storage = new DyingFilesystem(`${homeDir}/${PATHS.CALENDAR.ROOT}`);
            return storage;
        });
        const calendar = harness.instance;
        const calendarId = (await calendar.getCalendars())[0].id;

        storage.refuseWriteNumber = 3;
        const result = await calendar.importEvents(calendarId, new TextEncoder().encode(FILE));

        // The loop holds no lock of its own, so the failing series is counted and the file goes on.
        expect(result).toEqual({ imported: 3, skipped: 0, failed: 1 });
        expect(await titlesOf(calendar, calendarId)).toEqual(['Series 1', 'Series 2', 'Series 4']);
        expect(filesOf(harness, calendarId)).toHaveLength(3);
        expect(await calendar.getEventsByUid(UIDS[2])).toHaveLength(0);

        // A retry completes the file: the three that landed skip by UID, the refused one is written.
        storage.refuseWriteNumber = 0;
        expect(await calendar.importEvents(calendarId, new TextEncoder().encode(FILE))).toEqual({
            imported: 1,
            skipped: 3,
            failed: 0,
        });
        expect(await titlesOf(calendar, calendarId)).toEqual(['Series 1', 'Series 2', 'Series 3', 'Series 4']);
        expect(filesOf(harness, calendarId)).toHaveLength(4);
    });

    test('a write that died after the rename is recovered, not lost', async () => {
        let storage!: DyingFilesystem;
        const harness = await makeCalendar((homeDir) => {
            storage = new DyingFilesystem(`${homeDir}/${PATHS.CALENDAR.ROOT}`);
            return storage;
        });
        const calendar = harness.instance;
        const calendarId = (await calendar.getCalendars())[0].id;

        storage.dieAfterWrite = true;
        const result = await calendar.importEvents(calendarId, new TextEncoder().encode(vcal(series(UIDS[0], 'Torn'))));
        expect(result).toEqual({ imported: 0, skipped: 0, failed: 1 });
        storage.dieAfterWrite = false;

        // The file is on disk, so the next read re-indexes it rather than pretending the import never ran.
        expect(await titlesOf(calendar, calendarId)).toEqual(['Torn']);
        expect(existsSync(join(calendarsDirOf(harness.dir), calendarId, filesOf(harness, calendarId)[0]))).toBe(true);
    });
});
