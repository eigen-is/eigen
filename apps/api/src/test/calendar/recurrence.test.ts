// Zone math every expansion, every parsed TZID datetime and every serialized wall time runs through.
// A wall time an hour either side of a DST transition is the case that decides whether an occurrence
// lands on the clock its author named.
import { describe, expect, test } from 'bun:test';
import { localToUtc, truncateRRule, utcToLocal } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import { RRule } from 'rrule';
import { constrainRRule, expandRecurrence } from '../../lib/calendar/recurrence';
import type { ParsedEvent } from '../../lib/ical/ical-parse';
import { computeOccurrenceTimes } from '../../lib/ical/wall-clock';

// Each zone's 2026 transition days, and the wall times its spring-forward day skips. A skipped wall
// time resolves with the pre-transition offset, so the clock reads one gap later (RFC 5545 §3.3.5).
const ZONES: { tz: string; days: string[]; gaps: Record<string, string> }[] = [
    {
        tz: 'America/New_York',
        days: ['2026-03-08', '2026-11-01'],
        gaps: { '2026-03-08 02:00': '2026-03-08 03:00', '2026-03-08 02:30': '2026-03-08 03:30' },
    },
    {
        tz: 'Europe/Amsterdam',
        days: ['2026-03-29', '2026-10-25'],
        gaps: { '2026-03-29 02:00': '2026-03-29 03:00', '2026-03-29 02:30': '2026-03-29 03:30' },
    },
    {
        tz: 'Australia/Sydney',
        days: ['2026-04-05', '2026-10-04'],
        gaps: { '2026-10-04 02:00': '2026-10-04 03:00', '2026-10-04 02:30': '2026-10-04 03:30' },
    },
    {
        tz: 'Pacific/Auckland',
        days: ['2026-04-05', '2026-09-27'],
        gaps: { '2026-09-27 02:00': '2026-09-27 03:00', '2026-09-27 02:30': '2026-09-27 03:30' },
    },
    // The clocks do not always move by an hour: Lord Howe goes forward 30 minutes, Troll two hours.
    { tz: 'Australia/Lord_Howe', days: ['2026-04-05', '2026-10-04'], gaps: { '2026-10-04 02:00': '2026-10-04 02:30' } },
    {
        tz: 'Antarctica/Troll',
        days: ['2026-03-29', '2026-10-25'],
        gaps: {
            '2026-03-29 01:00': '2026-03-29 03:00',
            '2026-03-29 01:30': '2026-03-29 03:30',
            '2026-03-29 02:00': '2026-03-29 04:00',
            '2026-03-29 02:30': '2026-03-29 04:30',
        },
    },
    { tz: 'Asia/Kolkata', days: ['2026-03-08', '2026-11-01'], gaps: {} },
    { tz: 'America/Sao_Paulo', days: ['2026-03-08', '2026-11-01'], gaps: {} },
];

const pad = (n: number) => String(n).padStart(2, '0');

function wallOf(instant: Date, tz: string): string {
    const { year, month, day, hour, minute } = utcToLocal(instant, tz);
    return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`;
}

function scannedDates(days: string[]): string[] {
    const dates = new Set<string>();
    for (const day of days) {
        for (const delta of [-1, 0, 1]) {
            const date = new Date(`${day}T00:00:00Z`);
            date.setUTCDate(date.getUTCDate() + delta);
            dates.add(date.toISOString().substring(0, 10));
        }
    }
    return [...dates];
}

const SERIES: CalendarEvent = {
    id: 'evt-series',
    calendarId: 'cal-1',
    uid: 'series@eigen',
    uri: 'series.ics',
    title: 'Night shift',
    description: null,
    location: null,
    // Sunday 2026-10-11 02:30 EDT
    startTime: new Date('2026-10-11T06:30:00Z'),
    endTime: new Date('2026-10-11T07:30:00Z'),
    allDay: false,
    rrule: 'FREQ=WEEKLY;BYDAY=SU',
    timezone: 'America/New_York',
    parentEventId: null,
    recurrenceDate: null,
    status: 'confirmed',
    sequence: 0,
    etag: 'e',
    data: null,
    createByUserId: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
};

describe('localToUtc', () => {
    test('every half-hour of a transition day and its neighbours names the wall time it was asked for', () => {
        const wrong: string[] = [];

        for (const { tz, days, gaps } of ZONES) {
            for (const date of scannedDates(days)) {
                const [year, month, day] = date.split('-').map(Number);
                for (let slot = 0; slot < 48; slot++) {
                    const hour = Math.floor(slot / 2);
                    const minute = (slot % 2) * 30;
                    const wall = `${date} ${pad(hour)}:${pad(minute)}`;
                    const expected = gaps[wall] ?? wall;
                    const resolved = wallOf(localToUtc(tz, year, month, day, hour, minute, 0), tz);
                    if (resolved !== expected) wrong.push(`${tz} ${wall} -> ${resolved} (expected ${expected})`);
                }
            }
        }

        expect(wrong).toEqual([]);
    });

    test('the repeated hour resolves to its first pass', () => {
        expect(localToUtc('America/New_York', 2026, 11, 1, 1, 30, 0).toISOString()).toBe('2026-11-01T05:30:00.000Z');
        expect(localToUtc('Europe/Amsterdam', 2026, 10, 25, 2, 30, 0).toISOString()).toBe('2026-10-25T00:30:00.000Z');
        // A repeat the clocks made 30 minutes wide, and one they made two hours wide
        expect(localToUtc('Australia/Lord_Howe', 2026, 4, 5, 1, 30, 0).toISOString()).toBe('2026-04-04T14:30:00.000Z');
        expect(localToUtc('Antarctica/Troll', 2026, 10, 25, 1, 30, 0).toISOString()).toBe('2026-10-24T23:30:00.000Z');
    });

    test('a wall time whose first guess crossed a transition resolves from that guess, not from the wall', () => {
        // 02:00 on the fall-back day is EST, and 03:30 on the spring-forward day is EDT
        expect(localToUtc('America/New_York', 2026, 11, 1, 2, 0, 0).toISOString()).toBe('2026-11-01T07:00:00.000Z');
        expect(localToUtc('America/New_York', 2026, 3, 8, 3, 30, 0).toISOString()).toBe('2026-03-08T07:30:00.000Z');
        // A zone far from UTC is off by its whole offset, not by the transition, when the guess misses
        expect(localToUtc('Pacific/Auckland', 2026, 9, 27, 15, 0, 0).toISOString()).toBe('2026-09-27T02:00:00.000Z');
    });

    test('a wall time the spring-forward gap skips resolves with the pre-transition offset', () => {
        expect(localToUtc('America/New_York', 2026, 3, 8, 2, 30, 0).toISOString()).toBe('2026-03-08T07:30:00.000Z');
        expect(localToUtc('Europe/Amsterdam', 2026, 3, 29, 2, 30, 0).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    });
});

describe('expandRecurrence', () => {
    test('a weekly 02:30 New York series keeps its wall time across the fall-back day', () => {
        const occurrences = expandRecurrence(
            SERIES,
            new Date('2026-10-11T00:00:00Z'),
            new Date('2026-11-16T00:00:00Z'),
        );

        expect(occurrences.map((o) => wallOf(o.startTime, 'America/New_York'))).toEqual([
            '2026-10-11 02:30',
            '2026-10-18 02:30',
            '2026-10-25 02:30',
            '2026-11-01 02:30',
            '2026-11-08 02:30',
            '2026-11-15 02:30',
        ]);
        expect(occurrences.map((o) => o.startTime.toISOString())).toContain('2026-11-01T07:30:00.000Z');
        expect(occurrences.map((o) => o.occurrenceDate)).toContain('2026-11-01');
    });

    // RFC 5545 §3.3.10: beside a TZID DTSTART, UNTIL is a UTC instant, as Apple writes it for a series that ends.
    test.each([
        ['Europe/Amsterdam', '2026-03-01T08:00:00Z', 'UNTIL=20260310T080000Z', '2026-03-10'],
        ['America/New_York', '2026-03-01T14:00:00Z', 'UNTIL=20260310T125959Z', '2026-03-09'],
    ])('a daily 09:00 %s series ends at the instant its UTC UNTIL names', (tz, start, until, last) => {
        const series = { ...SERIES, startTime: new Date(start), timezone: tz, rrule: `FREQ=DAILY;${until}` };
        const occurrences = expandRecurrence(
            series,
            new Date('2026-03-01T00:00:00Z'),
            new Date('2026-03-20T00:00:00Z'),
        );

        expect(occurrences.at(-1)?.occurrenceDate).toBe(last);
        expect(occurrences.every((o) => wallOf(o.startTime, tz).endsWith('09:00'))).toBe(true);
    });
});

describe('truncateRRule', () => {
    // Apple and Thunderbird read the UNTIL of a zoned series as an instant, so it falls between the kept and the cut day.
    test.each([
        ['America/New_York', '2026-03-02T01:00:00Z', 'FREQ=DAILY;UNTIL=20260310T035959Z'],
        ['Asia/Tokyo', '2026-02-28T23:00:00Z', 'FREQ=DAILY;UNTIL=20260309T145959Z'],
    ])('a cut of a daily %s series keeps the day before the cut day', (tz, start, cut) => {
        const rrule = truncateRRule('FREQ=DAILY', '2026-03-10', { timezone: tz, allDay: false });
        const series = { ...SERIES, startTime: new Date(start), timezone: tz, rrule };
        const occurrences = expandRecurrence(
            series,
            new Date('2026-03-01T00:00:00Z'),
            new Date('2026-03-20T00:00:00Z'),
        );
        const until = RRule.parseString(rrule).until?.getTime() ?? 0;

        expect(rrule).toBe(cut);
        expect(occurrences.at(-1)?.occurrenceDate).toBe('2026-03-09');
        expect(computeOccurrenceTimes(series, '2026-03-09').startTime.getTime()).toBeLessThanOrEqual(until);
        expect(computeOccurrenceTimes(series, '2026-03-10').startTime.getTime()).toBeGreaterThan(until);
    });

    test('a cut of an all-day series ends on the day before the cut day', () => {
        const rrule = truncateRRule('FREQ=DAILY;COUNT=30', '2026-03-10', { timezone: null, allDay: true });
        const series = {
            ...SERIES,
            allDay: true,
            startTime: new Date('2026-03-01T00:00:00Z'),
            endTime: new Date('2026-03-02T00:00:00Z'),
            timezone: null,
            rrule,
        };
        const occurrences = expandRecurrence(
            series,
            new Date('2026-03-01T00:00:00Z'),
            new Date('2026-04-01T00:00:00Z'),
        );

        expect(rrule).toBe('FREQ=DAILY;UNTIL=20260309');
        expect(occurrences.at(-1)?.occurrenceDate).toBe('2026-03-09');
    });
});

// The organizer's series starts on Monday 2 March 2026 at 09:00 New York, and the guest cut it from 10 March on.
describe('constrainRRule', () => {
    const CUT = '2026-03-10';
    const AT_CUT = 'FREQ=DAILY;UNTIL=20260310T035959Z';
    const organizer = (rrule: string): ParsedEvent => ({
        uid: 'constrained@example.com',
        title: 'Standup',
        description: null,
        location: null,
        startTime: new Date('2026-03-02T14:00:00Z'),
        endTime: new Date('2026-03-02T15:00:00Z'),
        allDay: false,
        rrule,
        timezone: 'America/New_York',
        status: 'confirmed',
        sequence: 0,
        dtstamp: null,
        recurrenceDate: null,
        recurrenceId: null,
        data: null,
    });
    const allDay = (rrule: string): ParsedEvent => ({
        ...organizer(rrule),
        startTime: new Date('2026-03-02T00:00:00Z'),
        endTime: new Date('2026-03-03T00:00:00Z'),
        allDay: true,
        timezone: null,
    });

    test.each([
        ['an endless rule', 'FREQ=DAILY', AT_CUT],
        ['an UNTIL past the cut', 'FREQ=DAILY;UNTIL=20260320T035959Z', AT_CUT],
        ['an UNTIL on the cut day', 'FREQ=DAILY;UNTIL=20260310T140000Z', AT_CUT],
        ['an UNTIL on the last kept day', 'FREQ=DAILY;UNTIL=20260310T035959Z', 'FREQ=DAILY;UNTIL=20260310T035959Z'],
        ['an UNTIL before the cut', 'FREQ=DAILY;UNTIL=20260305T035959Z', 'FREQ=DAILY;UNTIL=20260305T035959Z'],
        ['a DATE UNTIL before the cut', 'FREQ=DAILY;UNTIL=20260305', 'FREQ=DAILY;UNTIL=20260305'],
        ['a DATE UNTIL on the cut day', 'FREQ=DAILY;UNTIL=20260310', AT_CUT],
        // Accepted: an organizer's COUNT is not walked to its last date, so the guest's cut replaces it.
        ['a COUNT', 'FREQ=DAILY;COUNT=5', AT_CUT],
    ])('a timed copy ends at whichever comes first: %s', (_case, rrule, kept) => {
        expect(constrainRRule(organizer(rrule), CUT)).toBe(kept);
    });

    test.each([
        ['an endless rule', 'FREQ=DAILY', 'FREQ=DAILY;UNTIL=20260309'],
        ['a UTC UNTIL past the cut', 'FREQ=DAILY;UNTIL=20260320T000000Z', 'FREQ=DAILY;UNTIL=20260309'],
        ['a DATE UNTIL on the last kept day', 'FREQ=DAILY;UNTIL=20260309', 'FREQ=DAILY;UNTIL=20260309'],
        ['a DATE UNTIL before the cut', 'FREQ=DAILY;UNTIL=20260305', 'FREQ=DAILY;UNTIL=20260305'],
    ])('an all-day copy ends at whichever comes first, as a DATE: %s', (_case, rrule, kept) => {
        expect(constrainRRule(allDay(rrule), CUT)).toBe(kept);
    });

    test("a copy the guest never cut takes the organizer's rule as it is", () => {
        expect(constrainRRule(organizer('FREQ=DAILY;UNTIL=20261231T045959Z'), null)).toBe(
            'FREQ=DAILY;UNTIL=20261231T045959Z',
        );
    });

    test('a rule that never fires, from 1900, is cut without a walk', () => {
        const never = {
            ...organizer('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'),
            startTime: new Date('1900-01-02T14:00:00Z'),
        };
        const startedAt = performance.now();

        expect(constrainRRule(never, CUT)).toBe('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30;UNTIL=20260310T035959Z');
        expect(performance.now() - startedAt).toBeLessThan(100);
    });
});
