import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { toLocalDateString } from '../../../core/calendar/calendar-utils';
import {
    CALENDAR_VIEW_MODES,
    calendarEventLink,
    isCalendarViewMode,
    parseDayKey,
    stepFocus,
    viewDays,
    viewRange,
    viewTitle,
    WEEK_STARTS_ON,
    WEEKDAY_HEADERS,
} from '../../../core/calendar/calendar-view';

// The views lay days out with local Date getters, like the browser, so the DST weeks need a zone that has them.
const originalTz = process.env.TZ;
beforeAll(() => {
    process.env.TZ = 'Europe/Amsterdam';
});
// bun test runs in UTC with TZ unset, and neither deleting TZ nor assigning undefined brings UTC back.
afterAll(() => {
    process.env.TZ = originalTz ?? 'UTC';
});

const keys = (days: readonly Date[]) => days.map(toLocalDateString);
const midnight = (date: Date) => [date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];

describe('view modes', () => {
    test('are day, 3 days, week and month, and nothing else reads as one', () => {
        expect(CALENDAR_VIEW_MODES).toEqual(['day', '3day', 'week', 'month']);
        expect(CALENDAR_VIEW_MODES.every(isCalendarViewMode)).toBe(true);
        expect(['year', 'schedule', 'Week', ''].some(isCalendarViewMode)).toBe(false);
    });
});

describe('viewDays', () => {
    const focus = new Date(2026, 10, 24, 15, 30);

    test('a day is the focused day, from its midnight', () => {
        const days = viewDays('day', focus);
        expect(keys(days)).toEqual(['2026-11-24']);
        expect(midnight(days[0])).toEqual([0, 0, 0, 0]);
    });

    test('3 days start on the focused day', () => {
        expect(keys(viewDays('3day', focus))).toEqual(['2026-11-24', '2026-11-25', '2026-11-26']);
    });

    test('a week starts on Monday', () => {
        const days = viewDays('week', new Date(2026, 10, 29));
        expect(days[0].getDay()).toBe(WEEK_STARTS_ON);
        expect(keys(days)).toEqual([
            '2026-11-23',
            '2026-11-24',
            '2026-11-25',
            '2026-11-26',
            '2026-11-27',
            '2026-11-28',
            '2026-11-29',
        ]);
    });

    test('a month covers whole weeks, from the Monday before a 1st that falls on a Sunday', () => {
        const days = viewDays('month', new Date(2026, 10, 15));
        expect(days).toHaveLength(42);
        expect(toLocalDateString(days[0])).toBe('2026-10-26');
        expect(toLocalDateString(days[6])).toBe('2026-11-01');
        expect(toLocalDateString(days[41])).toBe('2026-12-06');
    });

    test('a month that starts on a Monday and ends on a Sunday shows four weeks', () => {
        expect(keys(viewDays('month', new Date(2027, 1, 10)))).toHaveLength(28);
    });

    test('switching month to week keeps the focused day', () => {
        const fromMonth = new Date(2026, 10, 24);
        expect(viewDays('month', fromMonth).map(toLocalDateString)).toContain('2026-11-24');
        expect(keys(viewDays('week', fromMonth))[0]).toBe('2026-11-23');
    });

    test.each([
        ['spring', new Date(2026, 2, 26), '2026-03-23', '2026-03-29'],
        ['autumn', new Date(2026, 9, 22), '2026-10-19', '2026-10-25'],
    ])('a week with the %s DST change keeps seven calendar days, each from midnight', (_, day, first, last) => {
        const days = viewDays('week', day);
        expect(keys(days)).toHaveLength(7);
        expect(new Set(keys(days)).size).toBe(7);
        expect([keys(days)[0], keys(days)[6]]).toEqual([first, last]);
        for (const d of days) expect(midnight(d)).toEqual([0, 0, 0, 0]);
    });
});

describe('viewRange', () => {
    test('runs from the first day at midnight to the last second of the last day, in unix seconds', () => {
        expect(viewRange('week', new Date(2026, 10, 24))).toEqual({
            from: new Date(2026, 10, 23).getTime() / 1000,
            to: new Date(2026, 10, 29, 23, 59, 59).getTime() / 1000,
        });
    });

    test('a month covers its whole weeks', () => {
        expect(viewRange('month', new Date(2026, 10, 15))).toEqual({
            from: new Date(2026, 9, 26).getTime() / 1000,
            to: new Date(2026, 11, 6, 23, 59, 59).getTime() / 1000,
        });
    });

    test('a week that ends on the autumn DST change ends on its Sunday, an hour longer than usual', () => {
        const { from, to } = viewRange('week', new Date(2026, 9, 22));
        expect(to).toBe(new Date(2026, 9, 25, 23, 59, 59).getTime() / 1000);
        expect(to + 1 - from).toBe(7 * 86400 + 3600);
    });
});

describe('stepFocus', () => {
    const step = (mode: Parameters<typeof stepFocus>[0], day: Date, dir: 1 | -1) =>
        toLocalDateString(stepFocus(mode, day, dir));

    test('a day, 3 days and a week step by their own length', () => {
        const focus = new Date(2026, 10, 24);
        expect([step('day', focus, 1), step('day', focus, -1)]).toEqual(['2026-11-25', '2026-11-23']);
        expect([step('3day', focus, 1), step('3day', focus, -1)]).toEqual(['2026-11-27', '2026-11-21']);
        expect([step('week', focus, 1), step('week', focus, -1)]).toEqual(['2026-12-01', '2026-11-17']);
    });

    test('a month keeps the day of the month', () => {
        expect(step('month', new Date(2026, 10, 24), 1)).toBe('2026-12-24');
        expect(step('month', new Date(2026, 0, 15), -1)).toBe('2025-12-15');
    });

    test('a month clamps a day the next month lacks to its last day', () => {
        expect(step('month', new Date(2026, 0, 31), 1)).toBe('2026-02-28');
        expect(step('month', new Date(2028, 0, 31), 1)).toBe('2028-02-29');
        expect(step('month', new Date(2026, 2, 31), -1)).toBe('2026-02-28');
        expect(step('month', new Date(2026, 4, 31), 1)).toBe('2026-06-30');
    });

    test('a week across the autumn DST change lands on the next Monday at midnight', () => {
        const next = stepFocus('week', new Date(2026, 9, 19), 1);
        expect(toLocalDateString(next)).toBe('2026-10-26');
        expect(midnight(next)).toEqual([0, 0, 0, 0]);
    });

    test('a day across the spring DST change lands on the next day at midnight', () => {
        const next = stepFocus('day', new Date(2026, 2, 29), 1);
        expect(toLocalDateString(next)).toBe('2026-03-30');
        expect(midnight(next)).toEqual([0, 0, 0, 0]);
    });
});

describe('viewTitle', () => {
    test('a month names the month and the year', () => {
        expect(viewTitle('month', new Date(2026, 10, 24))).toBe('November 2026');
    });

    test('a day names the weekday and the date, day first', () => {
        expect(viewTitle('day', new Date(2026, 10, 24))).toBe('Tuesday, 24 Nov 2026');
    });

    test('a week within one month names it once', () => {
        expect(viewTitle('week', new Date(2026, 10, 24))).toBe('23 – 29 Nov 2026');
    });

    test('a week across two months names both', () => {
        expect(viewTitle('week', new Date(2026, 11, 1))).toBe('30 Nov – 6 Dec 2026');
    });

    test('a week across two years names both', () => {
        expect(viewTitle('week', new Date(2026, 11, 30))).toBe('28 Dec 2026 – 3 Jan 2027');
    });

    test('3 days are titled by their own days', () => {
        expect(viewTitle('3day', new Date(2026, 10, 29))).toBe('29 Nov – 1 Dec 2026');
    });
});

describe('WEEKDAY_HEADERS', () => {
    test('start on Monday', () => {
        expect(WEEKDAY_HEADERS).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
    });
});

describe('parseDayKey', () => {
    test('reads a YYYY-MM-DD key as that local day at midnight', () => {
        expect(parseDayKey('2026-11-24')).toEqual(new Date(2026, 10, 24));
        expect(parseDayKey('2026-03-29')).toEqual(new Date(2026, 2, 29));
    });

    test('refuses a key that is not a real day', () => {
        expect(['2026-02-30', '2026-13-01', '2026-1-5', '1785412800', 'today', ''].map(parseDayKey)).toEqual([
            null,
            null,
            null,
            null,
            null,
            null,
        ]);
    });

    test('round-trips with the day key', () => {
        const day = new Date(2026, 9, 25);
        expect(parseDayKey(toLocalDateString(day))).toEqual(day);
    });
});

describe('calendarEventLink', () => {
    test("opens Calendar's start page on the local day of the event, with its id escaped", () => {
        expect(calendarEventLink({ date: new Date(2026, 10, 24, 23, 30), eventId: 'a b@x/y' })).toBe(
            '/?date=2026-11-24&eventId=a%20b%40x%2Fy',
        );
    });
});
