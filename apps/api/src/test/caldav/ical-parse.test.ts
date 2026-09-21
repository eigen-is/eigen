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

// A UID is required, and an override carries its master's — but exporters skip it, and then the pair no
// longer groups. A weekly series at 09:00 Auckland whose second occurrence is moved: the UTC-Z
// RECURRENCE-ID is 2 January in UTC and 3 January in Auckland, so a file the two VEVENTs of which no
// longer find each other keys the override a day early.
describe('parseIcs over a file whose UIDs do not line up', () => {
    const shape = (masterUid: string[], overrideUid: string[]) =>
        vcal([
            'BEGIN:VEVENT',
            ...masterUid,
            'DTSTART;TZID=Pacific/Auckland:20250101T090000',
            'DTEND;TZID=Pacific/Auckland:20250101T100000',
            'RRULE:FREQ=WEEKLY',
            'SUMMARY:Standup',
            'END:VEVENT',
            'BEGIN:VEVENT',
            ...overrideUid,
            'RECURRENCE-ID:20250102T200000Z',
            'DTSTART:20250102T220000Z',
            'DTEND:20250102T230000Z',
            'SUMMARY:Standup moved',
            'END:VEVENT',
        ]);

    const overrideKey = (text: string) =>
        parseIcs(text).events.find((event) => event.recurrenceDate !== null)?.recurrenceDate;

    test('an override keys through the file master zone when its master carries no UID', () => {
        expect(overrideKey(shape([], ['UID:series@eigen']))).toBe('2025-01-03');
    });

    test('an override with no UID of its own keys through the file master zone', () => {
        expect(overrideKey(shape(['UID:series@eigen'], []))).toBe('2025-01-03');
    });
});

// A master that names no TZID keeps its series in UTC, which is not the same fact as "this file names no
// master for that UID": the file's first master's zone is the fallback for the second case only.
describe('parseIcs over a UTC series in a file that also holds a zoned one', () => {
    test('a UTC-Z override of a UTC series keys to its UTC day, not the file master zone', () => {
        const { events } = parseIcs(
            vcal([
                'BEGIN:VEVENT',
                'UID:tokyo@eigen',
                'DTSTART;TZID=Asia/Tokyo:20260302T090000',
                'DTEND;TZID=Asia/Tokyo:20260302T100000',
                'RRULE:FREQ=WEEKLY',
                'SUMMARY:Tokyo standup',
                'END:VEVENT',
                'BEGIN:VEVENT',
                'UID:utc@eigen',
                'DTSTART:20260302T220000Z',
                'DTEND:20260302T230000Z',
                'RRULE:FREQ=WEEKLY',
                'SUMMARY:Late call',
                'END:VEVENT',
                'BEGIN:VEVENT',
                'UID:utc@eigen',
                'RECURRENCE-ID:20260309T220000Z',
                'DTSTART:20260309T230000Z',
                'DTEND:20260310T000000Z',
                'SUMMARY:Late call moved',
                'END:VEVENT',
            ]),
        );

        // 9 March 22:00Z is 10 March in Tokyo: keyed through that zone the exception attaches to no
        // occurrence the series has.
        expect(events.find((event) => event.recurrenceDate !== null)?.recurrenceDate).toBe('2026-03-09');
    });
});

// RFC 5545 §3.6.1 lets an event state its length as a DURATION instead of a DTEND, which Apple and
// Outlook both emit — an end derived from DTSTART alone turns a three-hour meeting into an hour and a
// three-day trip into one day.
describe('parseIcs over an event whose length is a DURATION', () => {
    const only = (lines: string[]) =>
        parseIcs(vcal(['BEGIN:VEVENT', 'UID:duration@eigen', ...lines, 'END:VEVENT'])).events[0];

    test('a timed event ends a DURATION after its start', () => {
        expect(only(['DTSTART:20260601T100000Z', 'DURATION:PT3H']).endTime.toISOString()).toBe(
            '2026-06-01T13:00:00.000Z',
        );
    });

    test('a zoned timed event ends a DURATION after its start in its own zone', () => {
        // 10:00 Amsterdam on 1 June is 08:00Z, so 90 minutes later is 09:30Z.
        expect(only(['DTSTART;TZID=Europe/Amsterdam:20260601T100000', 'DURATION:PT90M']).endTime.toISOString()).toBe(
            '2026-06-01T09:30:00.000Z',
        );
    });

    test('an all-day event spans the whole DURATION, exclusive end', () => {
        const event = only(['DTSTART;VALUE=DATE:20260601', 'DURATION:P3D']);

        expect(event.allDay).toBe(true);
        expect(event.startTime.toISOString()).toBe('2026-06-01T00:00:00.000Z');
        expect(event.endTime.toISOString()).toBe('2026-06-04T00:00:00.000Z');
    });

    test('a DTEND still wins over a DURATION the same VEVENT carries', () => {
        expect(
            only(['DTSTART:20260601T100000Z', 'DTEND:20260601T110000Z', 'DURATION:PT5H']).endTime.toISOString(),
        ).toBe('2026-06-01T11:00:00.000Z');
    });

    test('an event with neither keeps the hour and the day a bare DTSTART means', () => {
        expect(only(['DTSTART:20260601T100000Z']).endTime.toISOString()).toBe('2026-06-01T11:00:00.000Z');
        expect(only(['DTSTART;VALUE=DATE:20260601']).endTime.toISOString()).toBe('2026-06-02T00:00:00.000Z');
    });
});

describe('parseIcs over a calendar export', () => {
    // ICAL.Event walks every sibling VEVENT to relate the overrides of the series it is given, unless it
    // is handed the exceptions itself — which makes parsing a whole file quadratic in its event count.
    // The same parser runs on the API thread for a CalDAV PUT and holds the one transform Worker for a
    // preview, so a calendar a user exported must not cost minutes.
    test('twenty thousand events parse in linear time', () => {
        const lines: string[] = [];
        for (let i = 0; i < 20_000; i++) {
            lines.push(
                'BEGIN:VEVENT',
                `UID:bulk-${i}@eigen`,
                'DTSTART:20260601T100000Z',
                'DTEND:20260601T110000Z',
                `SUMMARY:Event ${i}`,
                'END:VEVENT',
            );
        }

        const startedAt = performance.now();
        const { events } = parseIcs(vcal(lines));

        expect(events).toHaveLength(20_000);
        expect(performance.now() - startedAt).toBeLessThan(5000);
    });
});
