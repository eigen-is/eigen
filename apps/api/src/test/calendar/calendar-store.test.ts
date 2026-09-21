import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { calendarsDirOf, makeCalendar } from '../calendar-test-helpers';
import { vcal } from '../ics-test-helpers';

// The file store behind every calendar write: what lands on disk, what the index says about it, and what
// each of them looks like after a crash. See docs/CALENDAR.md § Storage.

const event = (uid: string, summary: string, extra: string[] = []): string[] => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTART:20260401T100000Z',
    'DTEND:20260401T110000Z',
    `SUMMARY:${summary}`,
    ...extra,
    'END:VEVENT',
];

const put = (harness: Awaited<ReturnType<typeof makeCalendar>>, calendarId: string, uri: string, body: string) =>
    harness.instance.putResource(calendarId, uri, body, { ifMatch: null, ifNoneMatch: null });

describe('calendar file store', () => {
    beforeAll(() => {
        rmSync(join(import.meta.dir, '../../../../../data-test'), { recursive: true, force: true });
    });

    test('a stored resource is the file on disk, and the index projects it', async () => {
        const harness = await makeCalendar();
        const [cal] = await harness.instance.getCalendars();

        const result = await put(harness, cal.id, 'first.ics', vcal(event('store-1@eigen', 'Kickoff')));
        expect(result.ok).toBe(true);

        const stored = readFileSync(join(calendarsDirOf(harness.dir), cal.id, 'first.ics'), 'utf8');
        expect(stored).toContain('SUMMARY:Kickoff');
        // The row id rides in the file, so the index can be thrown away and rebuilt from it.
        expect(stored).toContain('X-EIGEN-EVENT-ID:');

        const served = await harness.instance.getResource(cal.id, 'first.ics');
        expect(new TextDecoder().decode(served!.bytes)).toBe(stored);

        const rows = await harness.instance.getRawEvents(cal.id);
        expect(rows.map((r) => r.title)).toEqual(['Kickoff']);
        expect(rows[0].uri).toBe('first.ics');
        expect(rows[0].etag).toBe(served!.etag);
    });
});
