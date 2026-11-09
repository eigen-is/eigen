import { describe, expect, test } from 'bun:test';
import ICAL from 'ical.js';
import { parseIcs } from '../../lib/ical';
import { cpuClock } from '../cpu-time';
import { vcal } from '../ics-test-helpers';

const vtimezone = (tzid: string, offset: string) => [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    'END:STANDARD',
    'END:VTIMEZONE',
];

const vevent = (uid: string, tzid: string) => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART;TZID=${tzid}:20260601T120000`,
    'END:VEVENT',
];

const parsed = (...blocks: string[][]) => new ICAL.Component(ICAL.parse(vcal(...blocks)));

describe('ical.js time zone lookup', () => {
    test('a zone the file defines is found, whatever stands around it', () => {
        const root = parsed(vevent('a', 'Own'), vtimezone('Other', '+0300'), vtimezone('Own', '+0500'));

        expect(root.getTimeZoneByID('Own')?.tzid).toBe('Own');
        expect(root.getTimeZoneByID('Other')?.tzid).toBe('Other');
        expect(root.getTimeZoneByID('Missing')).toBeNull();
    });

    test('of two zones with one TZID the first is the one', () => {
        const { events } = parseIcs(vcal(vtimezone('Own', '+0500'), vtimezone('Own', '+0300'), vevent('a', 'Own')));

        expect(events[0].startTime.toISOString()).toBe('2026-06-01T07:00:00.000Z');
    });

    test('a zone added after a miss is found', () => {
        const root = parsed(vevent('a', 'Own'));
        expect(root.getTimeZoneByID('Own')).toBeNull();

        root.addSubcomponent(parsed(vtimezone('Own', '+0500')).getAllSubcomponents('vtimezone')[0]);

        expect(root.getTimeZoneByID('Own')?.tzid).toBe('Own');
    });

    test('a zone with no TZID hides no other zone and no event', () => {
        const { events, skipped } = parseIcs(
            vcal(
                ['BEGIN:VTIMEZONE', 'END:VTIMEZONE'],
                vtimezone('Own', '+0500'),
                vevent('a', 'Own'),
                vevent('b', 'Own'),
            ),
        );

        expect(skipped).toBe(0);
        expect(events.map((event) => event.startTime.toISOString())).toEqual([
            '2026-06-01T07:00:00.000Z',
            '2026-06-01T07:00:00.000Z',
        ]);
    });

    test.each([
        ['one zone', () => 'Nowhere'],
        ['a zone each', (i: number) => `Nowhere${i}`],
    ])('events naming an undefined zone, %s, cost one lookup each', (_name, zone) => {
        const events = Array.from({ length: 20_000 }, (_, i) => vevent('a', zone(i))).flat();
        const body = vcal(events);

        const cpuMs = cpuClock();
        const { events: rows } = parseIcs(body);

        expect(cpuMs()).toBeLessThan(1500);
        expect(rows).toHaveLength(20_000);
    });
});

// Outlook names a zone it can't match to a Windows one "Customized Time Zone" and states its rules only in the file.
const CUSTOM = 'Customized Time Zone';

const observance = (kind: 'STANDARD' | 'DAYLIGHT', dtstart: string, from: string, to: string, rrule?: string) => [
    `BEGIN:${kind}`,
    `DTSTART:${dtstart}`,
    `TZOFFSETFROM:${from}`,
    `TZOFFSETTO:${to}`,
    ...(rrule ? [`RRULE:${rrule}`] : []),
    `END:${kind}`,
];

const OUTLOOK_EUROPE = [
    ...observance('STANDARD', '16010101T030000', '+0200', '+0100', 'FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10'),
    ...observance('DAYLIGHT', '16010101T020000', '+0100', '+0200', 'FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3'),
];

const startsOf = (rules: string[], ...walls: string[]) =>
    parseIcs(
        vcal(
            ['BEGIN:VTIMEZONE', `TZID:${CUSTOM}`, ...rules, 'END:VTIMEZONE'],
            ...walls.map((wall, i) => ['BEGIN:VEVENT', `UID:${i}`, `DTSTART;TZID=${CUSTOM}:${wall}`, 'END:VEVENT']),
        ),
    ).events.map((event) => event.startTime.toISOString());

describe('a zone only the file defines', () => {
    test('summer and winter time both read right', () => {
        expect(startsOf(OUTLOOK_EUROPE, '20260715T100000', '20260115T100000')).toEqual([
            '2026-07-15T08:00:00.000Z',
            '2026-01-15T09:00:00.000Z',
        ]);
    });

    test('a zone without summer time keeps its one offset', () => {
        const india = observance('STANDARD', '16010101T000000', '+0530', '+0530');
        expect(startsOf(india, '20260715T100000', '20260115T100000')).toEqual([
            '2026-07-15T04:30:00.000Z',
            '2026-01-15T04:30:00.000Z',
        ]);
    });

    test('a southern zone has summer time across the new year', () => {
        const sydney = [
            ...observance(
                'STANDARD',
                '16010101T030000',
                '+1100',
                '+1000',
                'FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=4',
            ),
            ...observance(
                'DAYLIGHT',
                '16010101T020000',
                '+1000',
                '+1100',
                'FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=10',
            ),
        ];
        expect(startsOf(sydney, '20260115T100000', '20260715T100000', '20261215T100000')).toEqual([
            '2026-01-14T23:00:00.000Z',
            '2026-07-15T00:00:00.000Z',
            '2026-12-14T23:00:00.000Z',
        ]);
    });

    test('a zone whose rule changed reads each year by the rule then in force', () => {
        const eastern = [
            ...observance(
                'DAYLIGHT',
                '19870405T020000',
                '-0500',
                '-0400',
                'FREQ=YEARLY;UNTIL=20060402T070000Z;BYMONTH=4;BYDAY=1SU',
            ),
            ...observance(
                'STANDARD',
                '19671029T020000',
                '-0400',
                '-0500',
                'FREQ=YEARLY;UNTIL=20061029T060000Z;BYMONTH=10;BYDAY=-1SU',
            ),
            ...observance('DAYLIGHT', '20070311T020000', '-0500', '-0400', 'FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'),
            ...observance('STANDARD', '20071104T020000', '-0400', '-0500', 'FREQ=YEARLY;BYMONTH=11;BYDAY=1SU'),
        ];
        expect(
            startsOf(
                eastern,
                '20050320T120000',
                '20051028T120000',
                '20051103T120000',
                '20260320T120000',
                '20261028T120000',
                '20261103T120000',
            ),
        ).toEqual([
            '2005-03-20T17:00:00.000Z',
            '2005-10-28T16:00:00.000Z',
            '2005-11-03T17:00:00.000Z',
            '2026-03-20T16:00:00.000Z',
            '2026-10-28T16:00:00.000Z',
            '2026-11-03T17:00:00.000Z',
        ]);
    });

    test('a rule naming its day by month days reads like one naming the last Sunday', () => {
        const byMonthDay = [
            ...observance(
                'STANDARD',
                '19701025T030000',
                '+0200',
                '+0100',
                'FREQ=YEARLY;BYMONTH=10;BYDAY=SU;BYMONTHDAY=25,26,27,28,29,30,31',
            ),
            ...observance(
                'DAYLIGHT',
                '19700329T020000',
                '+0100',
                '+0200',
                'FREQ=YEARLY;BYMONTH=3;BYDAY=SU;BYMONTHDAY=25,26,27,28,29,30,31',
            ),
        ];
        expect(startsOf(byMonthDay, '20260715T100000', '20260115T100000')).toEqual([
            '2026-07-15T08:00:00.000Z',
            '2026-01-15T09:00:00.000Z',
        ]);
    });

    test('around the switch an hour the clock skips moves on, and an hour it repeats takes its first pass', () => {
        expect(
            startsOf(
                OUTLOOK_EUROPE,
                '20260329T015900',
                '20260329T023000',
                '20260329T030000',
                '20261025T023000',
                '20261025T030000',
            ),
        ).toEqual([
            '2026-03-29T00:59:00.000Z',
            '2026-03-29T01:30:00.000Z',
            '2026-03-29T01:00:00.000Z',
            '2026-10-25T00:30:00.000Z',
            '2026-10-25T02:00:00.000Z',
        ]);
    });

    test('a zone with a rule in another shape reads as standard time all year', () => {
        const listed = [
            ...observance('STANDARD', '16010101T030000', '+0200', '+0100', 'FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10'),
            'BEGIN:DAYLIGHT',
            'DTSTART:16010101T020000',
            'TZOFFSETFROM:+0100',
            'TZOFFSETTO:+0200',
            'RDATE:20260329T020000',
            'END:DAYLIGHT',
        ];
        const monthly = [
            ...observance('STANDARD', '16010101T030000', '+0200', '+0100', 'FREQ=MONTHLY;BYDAY=-1SU'),
            ...observance('DAYLIGHT', '16010101T020000', '+0100', '+0200', 'FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3'),
        ];
        expect([...startsOf(listed, '20260715T100000'), ...startsOf(monthly, '20260715T100000')]).toEqual([
            '2026-07-15T09:00:00.000Z',
            '2026-07-15T09:00:00.000Z',
        ]);
    });

    test('a minutely rule costs no walk', () => {
        const minutely = observance('STANDARD', '00010101T000000', '+0000', '+0100', 'FREQ=MINUTELY');
        const cpuMs = cpuClock();
        expect(startsOf(minutely, '20260715T100000')).toEqual(['2026-07-15T09:00:00.000Z']);
        expect(cpuMs()).toBeLessThan(100);
    });

    test('a stamp in such a zone costs no walk either', () => {
        const minutely = observance('STANDARD', '00010101T000000', '+0000', '+0100', 'FREQ=MINUTELY');
        const cpuMs = cpuClock();
        const { events } = parseIcs(
            vcal(
                ['BEGIN:VTIMEZONE', `TZID:${CUSTOM}`, ...minutely, 'END:VTIMEZONE'],
                [
                    'BEGIN:VEVENT',
                    'UID:a',
                    'DTSTART:20260715T100000Z',
                    `DTSTAMP;TZID=${CUSTOM}:20260701T100000`,
                    'END:VEVENT',
                ],
            ),
        );
        expect(events[0].dtstamp?.toISOString()).toBe('2026-07-01T09:00:00.000Z');
        expect(cpuMs()).toBeLessThan(100);
    });

    test('many observances cost no walk, whatever the year', () => {
        const rules = Array.from({ length: 2000 }, (_, i) =>
            observance(
                i % 2 ? 'DAYLIGHT' : 'STANDARD',
                `${String(1000 + i).padStart(4, '0')}0101T000000`,
                '+0000',
                '+0100',
                'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
            ),
        ).flat();
        const walls = Array.from({ length: 5000 }, (_, i) => `${2026 + (i % 7000)}0715T100000`);
        const cpuMs = cpuClock();
        expect(startsOf(rules, ...walls, '90000715T100000')).toHaveLength(5001);
        expect(cpuMs()).toBeLessThan(1500);
    });
});
