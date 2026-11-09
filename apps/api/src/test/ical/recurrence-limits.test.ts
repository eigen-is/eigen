import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import { expandRecurrence } from '../../lib/calendar/recurrence';
import { parseIcs, parseResource, projectResource } from '../../lib/ical';
import { isExpandableRrule, isSubDailyRrule } from '../../lib/ical/recurrence-limits';
import { computeOccurrenceTimes } from '../../lib/ical/wall-clock';
import { defaultCalendarId, makeCalendar, putResource, resourceTextOf, storedEvents } from '../calendar-test-helpers';
import { cpuClock } from '../cpu-time';
import { vcal } from '../ics-test-helpers';

const START = new Date('2026-03-02T09:00:00Z');
const hours = Array.from({ length: 24 }, (_, i) => i).join(',');
const minutes = Array.from({ length: 60 }, (_, i) => i).join(',');

const rowWith = (rrule: string, startTime = START): CalendarEvent => ({
    id: 'series',
    calendarId: 'calendar',
    uid: 'series@eigen',
    uri: 'series.ics',
    title: 'Series',
    description: null,
    location: null,
    startTime,
    endTime: new Date(startTime.getTime() + 3600_000),
    allDay: false,
    rrule,
    timezone: null,
    parentEventId: null,
    recurrenceDate: null,
    status: 'confirmed',
    sequence: 0,
    etag: '',
    data: null,
    createByUserId: null,
    createdAt: startTime,
    updatedAt: startTime,
});

const series = (rrule: string, ...extra: string[]) => [
    'BEGIN:VEVENT',
    'UID:series@eigen',
    'DTSTART:20260302T090000Z',
    'DTEND:20260302T100000Z',
    `RRULE:${rrule}`,
    ...extra,
    'END:VEVENT',
];

const REAL_RULES: [string, string, string][] = [
    ['every day', 'FREQ=DAILY', '2026-03-03'],
    ['every weekday', 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', '2026-03-03'],
    ['every other week', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', '2026-03-04'],
    ['the last Friday of each month', 'FREQ=MONTHLY;BYDAY=-1FR', '2026-03-27'],
    ['the last working day of each month', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', '2026-03-31'],
    ['the 31st of each month', 'FREQ=MONTHLY;BYMONTHDAY=31', '2026-03-31'],
    ['each 29 February', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '2028-02-29'],
    ['each 29 February on a Monday', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO', '2044-02-29'],
    ['each 29 February, stepping day by day', 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29', '2028-02-29'],
    ['each January, every fifty years', 'FREQ=YEARLY;INTERVAL=50;BYMONTH=1;BYMONTHDAY=1', '2076-01-01'],
    ['every Monday, stepping seven days', 'FREQ=DAILY;INTERVAL=7;BYDAY=MO', '2026-03-09'],
    ['every other Monday, stepping fourteen days', 'FREQ=DAILY;INTERVAL=14;BYDAY=MO', '2026-03-16'],
    ['three times', 'FREQ=WEEKLY;COUNT=3', '2026-03-09'],
    ['until a date', 'FREQ=DAILY;UNTIL=20260310T000000Z', '2026-03-05'],
    ['twice a day', 'FREQ=DAILY;BYHOUR=9,17', '2026-03-03'],
    [
        'every twenty minutes of a working day',
        `FREQ=DAILY;BYHOUR=9,10,11,12,13,14,15,16;BYMINUTE=0,20,40`,
        '2026-03-03',
    ],
];

const COSTLY_RULES: [string, string][] = [
    ['a date no year holds', 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'],
    ['a week number no month holds', 'FREQ=DAILY;BYWEEKNO=1;BYMONTH=6'],
    ['a position past the last Monday', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=6'],
    ...['SU', 'TU', 'WE', 'TH', 'FR', 'SA'].map((day): [string, string] => [
        `a step that misses ${day}`,
        `FREQ=DAILY;INTERVAL=7;BYDAY=${day}`,
    ]),
    ['a step that misses every leap day', 'FREQ=YEARLY;INTERVAL=4;BYMONTH=2;BYMONTHDAY=29'],
    ['a position rrule refuses', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=0'],
    ['every second of a day in daily words', `FREQ=DAILY;BYHOUR=${hours};BYMINUTE=${minutes};BYSECOND=${minutes}`],
];

describe('isExpandableRrule', () => {
    test.each(REAL_RULES)('%s expands', (_name, rrule, day) => {
        expect(isExpandableRrule(rrule, START)).toBe(true);

        const [from, to] = [new Date(`${day}T00:00:00Z`), new Date(`${day}T23:59:59Z`)];
        const dates = expandRecurrence(rowWith(rrule), from, to).map((occurrence) => occurrence.occurrenceDate);
        expect(dates).toContain(day);
    });

    test.each(COSTLY_RULES)('%s does not, at little cost', (_name, rrule) => {
        const cpuMs = cpuClock();
        expect(isExpandableRrule(rrule, START)).toBe(false);
        expect(cpuMs()).toBeLessThan(500);
    });

    test('a start out of range does not', () => {
        expect(isExpandableRrule('FREQ=DAILY', new Date('1000-01-01T00:00:00Z'))).toBe(false);
    });

    test('a rule whose UNTIL or COUNT ended long ago stays a rule that ended', () => {
        expect(isExpandableRrule('FREQ=DAILY;UNTIL=20200101T000000Z', START)).toBe(true);
        expect(isExpandableRrule('FREQ=DAILY;COUNT=1', START)).toBe(true);
    });
});

describe('isSubDailyRrule', () => {
    test.each([
        ['FREQ=HOURLY', true],
        [`FREQ=DAILY;BYHOUR=${hours};BYMINUTE=0,30`, true],
        [`FREQ=DAILY;BYHOUR=${hours}`, false],
        ['FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0,30', false],
        ['FREQ=WEEKLY', false],
    ])('%s: %p', (rrule, expected) => {
        expect(isSubDailyRrule(rrule)).toBe(expected);
    });
});

describe('a stored rule that does not expand', () => {
    test.each(COSTLY_RULES)(
        '%s: the event stays, without its repeats, and the bytes keep the rule',
        async (_name, rrule) => {
            const harness = await makeCalendar();
            const calendarId = await defaultCalendarId(harness);
            const body = vcal(series(rrule, 'EXDATE:20260303T090000Z'));

            expect((await putResource(harness.instance, calendarId, 'series.ics', body)).ok).toBe(true);

            const rows = storedEvents(harness.instance, calendarId);
            expect(rows.map((row) => row.rrule)).toEqual([null]);
            expect(await resourceTextOf(harness.instance, calendarId, 'series.ics')).toContain('RRULE:');

            const week = await harness.instance.getEventsInRange(
                new Date('2026-03-01'),
                new Date('2026-03-08'),
                calendarId,
            );
            expect(week.map((occurrence) => occurrence.startTime)).toEqual([START]);
            const later = await harness.instance.getResourcesInRange(
                calendarId,
                new Date('2030-01-01'),
                new Date('2030-01-08'),
            );
            expect(later.map((resource) => resource.uri)).toEqual(['series.ics']);
        },
    );

    test('a calendar with one such event reads its other events', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const { instance } = harness;
        await putResource(instance, calendarId, 'costly.ics', vcal(series('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=0')));
        const plain = series('FREQ=DAILY').map((line) => line.replace('series@eigen', 'plain@eigen'));
        await putResource(instance, calendarId, 'plain.ics', vcal(plain));

        const week = await instance.getEventsInRange(new Date('2026-03-02'), new Date('2026-03-05'), calendarId);

        expect(week.filter((occurrence) => occurrence.uid === 'plain@eigen')).toHaveLength(3);
        expect(week.filter((occurrence) => occurrence.uid === 'series@eigen')).toHaveLength(1);
    });

    test('a row an older build stored reads as one occurrence, at little cost', () => {
        for (const [, rrule] of COSTLY_RULES) {
            const cpuMs = cpuClock();
            const week = expandRecurrence(rowWith(rrule), new Date('2026-03-01'), new Date('2026-03-08'));
            expect(week.map((occurrence) => occurrence.startTime)).toEqual([START]);
            expect(cpuMs()).toBeLessThan(500);
        }
    });

    test('parseIcs keeps a rule it does not walk, for the store to judge', () => {
        const { events } = parseIcs(vcal(series('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30')));
        expect(events[0].rrule).toBe('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30');
    });

    test('a file of many such masters reads for a look at little cost', () => {
        const masters = Array.from({ length: 5000 }, (_, i) =>
            series('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30').map((line) => line.replace('series@eigen', `s${i}@eigen`)),
        );
        const body = vcal(masters.flat());

        const cpuMs = cpuClock();
        expect(parseIcs(body).events).toHaveLength(5000);
        expect(cpuMs()).toBeLessThan(1500);
    });

    test('a resource of many masters tries one rule', () => {
        const body = vcal(Array.from({ length: 200 }, () => series('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30')).flat());

        const cpuMs = cpuClock();
        const { events, hasUnindexedRecurrence } = projectResource(parseResource(body));

        expect(cpuMs()).toBeLessThan(1000);
        expect(events.filter((row) => row.rrule === null)).toHaveLength(1);
        expect(hasUnindexedRecurrence).toBe(true);
    });

    test('an override states no repeats of its own', () => {
        const override = [
            'BEGIN:VEVENT',
            'UID:series@eigen',
            'RECURRENCE-ID:20260303T090000Z',
            'DTSTART:20260303T100000Z',
            'DTEND:20260303T110000Z',
            'RRULE:FREQ=DAILY',
            'END:VEVENT',
        ];
        const { events } = projectResource(parseResource(vcal(series('FREQ=DAILY'), override)));
        expect(events.map((row) => row.rrule)).toEqual(['FREQ=DAILY', null]);
    });
});

describe('a window far past any recurring start', () => {
    test('a daily series has no repeats there, at little cost', () => {
        const cpuMs = cpuClock();
        const week = expandRecurrence(rowWith('FREQ=DAILY'), new Date('9000-01-01'), new Date('9000-01-08'));
        expect(cpuMs()).toBeLessThan(200);
        expect(week).toEqual([]);
    });

    test('an occurrence key there places the start time without walking', () => {
        const cpuMs = cpuClock();
        const { startTime } = computeOccurrenceTimes(rowWith('FREQ=DAILY'), '9000-01-01');
        expect(cpuMs()).toBeLessThan(200);
        expect(startTime.toISOString()).toBe('9000-01-01T09:00:00.000Z');
    });

    test('a series still expands at the last year a start may have', () => {
        const row = rowWith('FREQ=DAILY', new Date('2199-12-01T09:00:00Z'));
        const days = expandRecurrence(row, new Date('2199-12-30'), new Date('2199-12-31'));
        expect(days).toHaveLength(1);
    });
});
