import { describe, expect, test } from 'bun:test';
import ICAL from 'ical.js';
import { parseIcs, parseResource } from '../../lib/ical';
import { cpuClock } from '../cpu-time';
import { vcal } from '../ics-test-helpers';

// A CalDAV resource holds one UID, but a preview and an import feed the parser whole files: a calendar
// export carries every series the calendar holds, each in the timezone its author kept it in.

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

    test('a series whose only VEVENT is an override keys on the date its RECURRENCE-ID is written in', () => {
        const { events } = parseIcs(
            vcal([
                ...AUCKLAND,
                'BEGIN:VEVENT',
                'UID:orphan@eigen',
                'RECURRENCE-ID:20260310T020000Z',
                'DTSTART;TZID=America/Los_Angeles:20260309T140000',
                'DTEND;TZID=America/Los_Angeles:20260309T150000',
                'SUMMARY:Orphaned override',
                'END:VEVENT',
            ]),
        );

        expect(events.find((event) => event.uid === 'orphan@eigen')?.recurrenceDate).toBe('2026-03-10');
    });
});

// One VEVENT a stranger's file spells wrong is not the whole calendar: the parser reports how many it
// could not read, and every caller counts them as the members they are.
describe('parseIcs over a file holding a VEVENT it cannot read', () => {
    test('the readable events survive and the unreadable ones are counted', () => {
        const { events, skipped } = parseIcs(
            vcal([
                'BEGIN:VEVENT',
                'UID:good@eigen',
                'DTSTART:20260601T100000Z',
                'DTEND:20260601T110000Z',
                'SUMMARY:Readable',
                'END:VEVENT',
                // No DTSTART at all: there is no instant to store, and no date to key an occurrence by.
                'BEGIN:VEVENT',
                'UID:broken@eigen',
                'SUMMARY:Unreadable',
                'END:VEVENT',
                'BEGIN:VEVENT',
                'UID:also-good@eigen',
                'DTSTART:20260602T100000Z',
                'DTEND:20260602T110000Z',
                'SUMMARY:Readable too',
                'END:VEVENT',
            ]),
        );

        expect(events.map((event) => event.uid)).toEqual(['good@eigen', 'also-good@eigen']);
        expect(skipped).toBe(1);
    });

    test('a readable file skips nothing', () => {
        const { events, skipped } = parseIcs(
            vcal(['BEGIN:VEVENT', 'UID:good@eigen', 'DTSTART:20260601T100000Z', 'END:VEVENT']),
        );

        expect(events).toHaveLength(1);
        expect(skipped).toBe(0);
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

// A key is `YYYY-MM-DD`: a year below 1000 is zero-padded, or `Date.parse` reads the key as no date, and
// a year past 9999 has no key at all, so its VEVENT is one the parser cannot read.
describe('parseIcs over a year that is not four digits', () => {
    const master = (uid: string, tz: string, extra: string[] = []) => [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTART;TZID=${tz}:20260302T090000`,
        `DTEND;TZID=${tz}:20260302T100000`,
        'RRULE:FREQ=WEEKLY',
        ...extra,
        'END:VEVENT',
    ];
    const override = (uid: string, recurrenceId: string, start: string) => [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `RECURRENCE-ID${recurrenceId}`,
        `DTSTART:${start}`,
        'END:VEVENT',
    ];

    test('an exception and an exclusion in year 500 key to a four-digit year in every form', () => {
        const uid = 'year-500@eigen';
        const { events, skipped } = parseIcs(
            vcal([
                ...master(uid, 'Europe/Amsterdam', [
                    'EXDATE;VALUE=DATE:05000105',
                    'EXDATE;TZID=Europe/Amsterdam:05000106T090000',
                    'EXDATE:05000107T080000Z',
                ]),
                ...override(uid, ';VALUE=DATE:05000108', '05000108T090000Z'),
                ...override(uid, ';TZID=Europe/Amsterdam:05000109T090000', '05000109T090000Z'),
                ...override(uid, ':05000110T080000Z', '05000110T090000Z'),
            ]),
        );

        expect(skipped).toBe(0);
        const keys = (status: string) =>
            events.filter((event) => event.status === status && event.recurrenceDate).map((e) => e.recurrenceDate);
        expect(keys('cancelled')).toEqual(['0500-01-05', '0500-01-06', '0500-01-07']);
        expect(keys('confirmed')).toEqual(['0500-01-08', '0500-01-09', '0500-01-10']);
    });

    test('an exception keyed past year 9999 is a VEVENT it cannot read', () => {
        // 31 December 9999 23:00Z is already 1 January 10000 in the series' zone.
        const { events, skipped } = parseIcs(
            vcal([
                ...master('tokyo@eigen', 'Asia/Tokyo'),
                ...override('tokyo@eigen', ':99991231T230000Z', '99991231T230000Z'),
            ]),
        );

        expect(events).toHaveLength(1);
        expect(skipped).toBe(1);
    });
});

describe('parseIcs over an all-day series with a timed EXDATE', () => {
    test('the cancelled row is all day, on the date the EXDATE is written on', () => {
        const { events } = parseIcs(
            vcal([
                'BEGIN:VEVENT',
                'UID:all-day',
                'DTSTART;VALUE=DATE:20260504',
                'DTEND;VALUE=DATE:20260505',
                'RRULE:FREQ=DAILY;COUNT=4',
                'EXDATE;TZID=Pacific/Auckland:20260505T000000',
                'SUMMARY:Holiday',
                'END:VEVENT',
            ]),
        );
        const cancelled = events.find((e) => e.status === 'cancelled');

        expect(
            cancelled && [cancelled.recurrenceDate, cancelled.allDay, cancelled.startTime, cancelled.endTime],
        ).toEqual(['2026-05-05', true, new Date('2026-05-05T00:00:00Z'), new Date('2026-05-06T00:00:00Z')]);
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

    test('a zoned DURATION across a clock change is that much real time', () => {
        // 25 October 2026, 01:30 Amsterdam is 23:30Z the day before, and the clocks go back at 01:00Z.
        expect(only(['DTSTART;TZID=Europe/Amsterdam:20261025T013000', 'DURATION:PT3H']).endTime.toISOString()).toBe(
            '2026-10-25T02:30:00.000Z',
        );
    });

    test('an all-day event counts whole days of its DURATION', () => {
        expect(only(['DTSTART;VALUE=DATE:20260601', 'DURATION:P2W']).endTime.toISOString()).toBe(
            '2026-06-15T00:00:00.000Z',
        );
        expect(only(['DTSTART;VALUE=DATE:20260601', 'DURATION:PT5H']).endTime.toISOString()).toBe(
            '2026-06-01T00:00:00.000Z',
        );
    });

    test('a DURATION of a thousand years is an ordinary end', () => {
        expect(only(['DTSTART:20260101T000000Z', 'DURATION:P52000W']).endTime.getUTCFullYear()).toBe(3022);
    });

    test.each([
        ['no DTEND could spell', 'P1000000W'],
        ['no Date can hold', 'P1000000000W'],
        ['no number can hold', `P${'9'.repeat(400)}W`],
    ])('an end %s is an unreadable event, at no cost', (_name, duration) => {
        const cpuMs = cpuClock();
        const { events, skipped } = parseIcs(
            vcal(['BEGIN:VEVENT', 'UID:far@eigen', 'DTSTART:20260101T000000Z', `DURATION:${duration}`, 'END:VEVENT']),
        );

        expect(cpuMs()).toBeLessThan(100);
        expect(events).toEqual([]);
        expect(skipped).toBe(1);
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

// libical and its descendants name a zone by a TZID no standard knows and state the IANA name only as an
// X-LIC-LOCATION inside the file's own VTIMEZONE.
describe('parseIcs over a TZID only its VTIMEZONE names', () => {
    const zoned = (tzid: string, location: string) =>
        parseIcs(
            vcal([
                'BEGIN:VTIMEZONE',
                `TZID:${tzid}`,
                `X-LIC-LOCATION:${location}`,
                'BEGIN:STANDARD',
                'DTSTART:19701025T030000',
                'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
                'TZOFFSETFROM:+0200',
                'TZOFFSETTO:+0100',
                'END:STANDARD',
                'BEGIN:DAYLIGHT',
                'DTSTART:19700329T020000',
                'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
                'TZOFFSETFROM:+0100',
                'TZOFFSETTO:+0200',
                'END:DAYLIGHT',
                'END:VTIMEZONE',
                'BEGIN:VEVENT',
                'UID:lic@eigen',
                `DTSTART;TZID=${tzid}:20260601T100000`,
                `DTEND;TZID=${tzid}:20260601T110000`,
                'RRULE:FREQ=WEEKLY',
                'SUMMARY:Standup',
                'END:VEVENT',
            ]),
        ).events[0];

    test('the event stores the IANA zone its X-LIC-LOCATION names', () => {
        for (const tzid of ['/freeassociation.sourceforge.net/Tzfile/Europe/Amsterdam', 'My Custom Zone']) {
            const event = zoned(tzid, 'Europe/Amsterdam');

            expect(event.timezone).toBe('Europe/Amsterdam');
            expect(event.startTime.toISOString()).toBe('2026-06-01T08:00:00.000Z');
        }
    });

    test('an X-LIC-LOCATION Eigen cannot name either leaves the zone unset', () => {
        const event = zoned('My Custom Zone', 'Not/A_Zone');

        expect(event.timezone).toBeNull();
        expect(event.startTime.toISOString()).toBe('2026-06-01T08:00:00.000Z');
    });
});

describe('parseResource refuses what no calendar file is', () => {
    // A VEVENT in a VCALENDAR is two levels already.
    const nested = (extraLevels: number) =>
        vcal([
            'BEGIN:VEVENT',
            'UID:nested@eigen',
            'DTSTART:20260601T080000Z',
            ...Array<string>(extraLevels).fill('BEGIN:X-LEVEL'),
            ...Array<string>(extraLevels).fill('END:X-LEVEL'),
            'END:VEVENT',
        ]);

    test('a calendar eight levels deep parses', () => {
        expect(parseResource(nested(6)).getAllSubcomponents('vevent')).toHaveLength(1);
    });

    test('a calendar nine levels deep is refused', () => {
        expect(() => parseResource(nested(7))).toThrow(ICAL.parse.ParserError);
        expect(() => parseIcs(nested(7))).toThrow(ICAL.parse.ParserError);
    });

    test('a calendar two hundred thousand levels deep is refused like any other', () => {
        expect(() => parseResource(nested(200_000))).toThrow(ICAL.parse.ParserError);
    });

    test('two VCALENDAR objects are no one resource', () => {
        const text = `${nested(0)}\r\n${nested(0)}`;
        expect(() => parseResource(text)).toThrow(ICAL.parse.ParserError);
    });

    test('a text holding no calendar is refused', () => {
        expect(() => parseResource('')).toThrow(ICAL.parse.ParserError);
    });
});

describe('parseIcs over zone spellings', () => {
    const named = (uid: string, tzid: string) => [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTART;TZID=${tzid}:20260601T100000`,
        'END:VEVENT',
    ];
    const zone = 'America/Argentina/ComodRivadavia';
    const letters = [...zone].flatMap((char, index) => (/[a-z]/i.test(char) ? [index] : []));
    const spelled = (n: number) => {
        const chars = [...zone.toLowerCase()];
        letters.slice(0, 20).forEach((index, bit) => {
            if ((n >> bit) & 1) chars[index] = chars[index].toUpperCase();
        });
        return chars.join('');
    };

    test("a zone in another case is stored in Intl's spelling at the same instant", () => {
        const [first, second] = parseIcs(vcal(named('a', 'EUROPE/amsterdam'), named('b', 'Europe/Amsterdam'))).events;

        expect(first.timezone).toBe('Europe/Amsterdam');
        expect(first.startTime).toEqual(second.startTime);
    });

    test('a Windows zone takes its table row', () => {
        expect(parseIcs(vcal(named('a', 'W. Europe Standard Time'))).events[0].timezone).toBe('Europe/Berlin');
    });

    test('a zone nobody knows stores none', () => {
        expect(parseIcs(vcal(named('a', 'Not/A_Zone'))).events[0].timezone).toBeNull();
    });

    // One stored spelling keeps the server's per-zone formatter maps at one key per zone.
    test('many spellings of one zone store one spelling', () => {
        const body = vcal(Array.from({ length: 1000 }, (_, i) => named('a', spelled(i))).flat());

        const { events } = parseIcs(body);

        expect(events).toHaveLength(1000);
        expect(new Set(events.map((event) => event.timezone))).toEqual(new Set([zone]));
    });
});
