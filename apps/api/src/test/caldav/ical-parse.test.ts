import { describe, expect, test } from 'bun:test';
import { parseIcs } from '../../lib/caldav/ical-parse';

// A CalDAV resource holds one UID, but a preview and an import feed the parser whole files: a calendar
// export carries every series the calendar holds, each in the timezone its author kept it in.

const vcal = (lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');

// Two weekly series, both starting 2 March 2026 at 09:00 local, each with one occurrence moved. The
// RECURRENCE-IDs are the UTC-Z form Exchange-lineage clients emit, so each one keys to a wall-clock date
// in ITS OWN master's zone: 20260308T200000Z is 9 March in Auckland and 8 March in UTC, and
// 20260309T160000Z is 9 March in Los Angeles and 10 March in Auckland.
const series = (uid: string, tz: string, recurrenceId: string, movedStart: string) => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART;TZID=${tz}:20260302T090000`,
    `DTEND;TZID=${tz}:20260302T100000`,
    'RRULE:FREQ=WEEKLY',
    `SUMMARY:Standup ${uid}`,
    'END:VEVENT',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `RECURRENCE-ID:${recurrenceId}`,
    `DTSTART;TZID=${tz}:${movedStart}`,
    `DTEND;TZID=${tz}:${movedStart}`,
    `SUMMARY:Standup ${uid} moved`,
    'END:VEVENT',
];

const AUCKLAND = series('auckland@eigen', 'Pacific/Auckland', '20260308T200000Z', '20260309T140000');
const LOS_ANGELES = series('la@eigen', 'America/Los_Angeles', '20260309T160000Z', '20260309T140000');

describe('parseIcs over a multi-series file', () => {
    test('every override keys to a wall-clock date in its own series timezone', () => {
        for (const order of [
            [...AUCKLAND, ...LOS_ANGELES],
            [...LOS_ANGELES, ...AUCKLAND],
        ]) {
            const { events } = parseIcs(vcal(order));
            const overrides = events.filter((event) => event.recurrenceDate !== null);

            expect(overrides.find((event) => event.uid === 'auckland@eigen')?.recurrenceDate).toBe('2026-03-09');
            expect(overrides.find((event) => event.uid === 'la@eigen')?.recurrenceDate).toBe('2026-03-09');
        }
    });

    test('a series whose only VEVENT is an override still keys through its own DTSTART zone', () => {
        const { events } = parseIcs(
            vcal([
                ...AUCKLAND,
                'BEGIN:VEVENT',
                'UID:orphan@eigen',
                'RECURRENCE-ID:20260309T160000Z',
                'DTSTART;TZID=America/Los_Angeles:20260309T140000',
                'DTEND;TZID=America/Los_Angeles:20260309T150000',
                'SUMMARY:Orphaned override',
                'END:VEVENT',
            ]),
        );

        expect(events.find((event) => event.uid === 'orphan@eigen')?.recurrenceDate).toBe('2026-03-09');
    });
});
