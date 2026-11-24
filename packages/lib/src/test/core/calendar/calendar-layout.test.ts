import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
    allocateLanes,
    eventDaySpan,
    inAllDayLane,
    layoutTimedEvents,
    monthWeekLayout,
    movedTimes,
    rescheduleScopes,
    resizedTimes,
    SNAP_MINUTES,
    slotAt,
    slotRange,
} from '../../../core/calendar/calendar-layout';
import type { CalendarEventOccurrence } from '../../../types/calendar';

// The grid reads local Date getters, like the browser's.
const originalTz = process.env.TZ;
beforeAll(() => {
    process.env.TZ = 'Europe/Amsterdam';
});
// bun test runs in UTC with TZ unset, and neither deleting TZ nor assigning undefined brings UTC back.
afterAll(() => {
    process.env.TZ = originalTz ?? 'UTC';
});

type Fields = Partial<CalendarEventOccurrence> & Pick<CalendarEventOccurrence, 'startTime' | 'endTime'>;

function event(fields: Fields): CalendarEventOccurrence {
    return {
        id: fields.title ?? 'evt',
        calendarId: 'cal-1',
        uid: 'uid-1',
        uri: 'uid-1.ics',
        title: 'Event',
        description: null,
        location: null,
        allDay: false,
        rrule: null,
        timezone: 'Europe/Amsterdam',
        parentEventId: null,
        recurrenceDate: null,
        status: 'confirmed',
        sequence: 0,
        etag: 'etag-1',
        data: null,
        createByUserId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        occurrenceDate: '2026-11-24',
        ...fields,
    };
}

// A timed event on a local day, from wall-clock hours (fractions are minutes).
function timed(title: string, day: [number, number, number], from: number, to: number): CalendarEventOccurrence {
    const [y, m, d] = day;
    return event({
        title,
        startTime: new Date(y, m - 1, d, 0, Math.round(from * 60)),
        endTime: new Date(y, m - 1, d, 0, Math.round(to * 60)),
    });
}

function allDay(title: string, first: string, daysLong: number): CalendarEventOccurrence {
    const startTime = new Date(`${first}T00:00:00Z`);
    return event({ title, allDay: true, startTime, endTime: new Date(startTime.getTime() + daysLong * 86400_000) });
}

function localDays(y: number, m: number, d: number, count: number): Date[] {
    return Array.from({ length: count }, (_, i) => new Date(y, m - 1, d + i));
}

// Monday 23 to Sunday 29 November 2026, and the week after.
const week = localDays(2026, 11, 23, 7);
const nextWeek = localDays(2026, 11, 30, 7);
const tue: [number, number, number] = [2026, 11, 24];

describe('eventDaySpan', () => {
    test('a timed event inside one day covers that day', () => {
        expect(eventDaySpan(timed('A', tue, 9, 10))).toEqual({ first: '2026-11-24', last: '2026-11-24' });
    });

    test('a timed event crossing midnight covers both local days', () => {
        expect(eventDaySpan(timed('A', tue, 22, 26))).toEqual({ first: '2026-11-24', last: '2026-11-25' });
    });

    test('a timed event ending at midnight stays on its day', () => {
        expect(eventDaySpan(timed('A', tue, 22, 24))).toEqual({ first: '2026-11-24', last: '2026-11-24' });
    });

    test('a zero-length event covers its day', () => {
        expect(eventDaySpan(timed('A', tue, 0, 0))).toEqual({ first: '2026-11-24', last: '2026-11-24' });
    });

    test('an all-day event covers its UTC dates, the end exclusive', () => {
        // The exclusive end is 01:00 on the 27th in Amsterdam, which a local reading would count.
        expect(eventDaySpan(allDay('Trip', '2026-11-24', 3))).toEqual({ first: '2026-11-24', last: '2026-11-26' });
    });
});

describe('inAllDayLane', () => {
    test('all-day events and timed ones of 24 hours or more go in the lane', () => {
        expect(inAllDayLane(allDay('A', '2026-11-24', 1))).toBe(true);
        expect(inAllDayLane(timed('A', tue, 9, 33))).toBe(true);
        expect(inAllDayLane(timed('A', tue, 9, 32.75))).toBe(false);
    });
});

describe('allocateLanes', () => {
    test('a multi-day bar across a week boundary is clipped to each row with continuation flags', () => {
        const trip = allDay('Trip', '2026-11-28', 4);
        expect(allocateLanes([trip], week)).toEqual([
            { event: trip, lane: 0, start: 5, span: 2, continuesBefore: false, continuesAfter: true },
        ]);
        expect(allocateLanes([trip], nextWeek)).toEqual([
            { event: trip, lane: 0, start: 0, span: 2, continuesBefore: true, continuesAfter: false },
        ]);
    });

    test('each item takes the lowest lane free over its whole run', () => {
        const a = allDay('A', '2026-11-23', 3);
        const b = allDay('B', '2026-11-24', 1);
        const c = allDay('C', '2026-11-26', 1);
        const d = allDay('D', '2026-11-25', 2);
        const lanes = allocateLanes([c, d, b, a], week).map((bar) => [bar.event.title, bar.lane]);
        expect(lanes).toEqual([
            ['A', 0],
            ['B', 1],
            ['D', 1],
            ['C', 0],
        ]);
    });

    test('order is earlier start, then longer span, then start time, then title', () => {
        const zeta = timed('Zeta', tue, 9, 10);
        const alpha = timed('Alpha', tue, 9, 10);
        // 00:30 here starts before the bar's midnight UTC, so only the span puts the bar first.
        const early = timed('Early', tue, 0.5, 1);
        const bar = allDay('Bar', '2026-11-24', 2);
        const titles = allocateLanes([zeta, alpha, early, bar], week).map((b) => [b.event.title, b.lane]);
        expect(titles).toEqual([
            ['Bar', 0],
            ['Early', 1],
            ['Alpha', 2],
            ['Zeta', 3],
        ]);
    });

    test('items outside the days are left out', () => {
        expect(allocateLanes([allDay('Before', '2026-11-20', 2), timed('After', [2026, 12, 1], 9, 10)], week)).toEqual(
            [],
        );
    });
});

describe('monthWeekLayout', () => {
    test('hides lanes past maxLanes and counts them per day', () => {
        const trip = allDay('Trip', '2026-11-24', 2);
        const crowded = [trip, timed('A', tue, 9, 10), timed('B', tue, 10, 11), timed('C', tue, 11, 12)];
        const layout = monthWeekLayout(week, crowded, 2);
        expect(layout.bars.map((b) => b.event.title)).toEqual(['Trip', 'A']);
        expect(layout.hidden).toEqual([0, 2, 0, 0, 0, 0, 0]);
    });

    test('a hidden multi-day bar counts on every day it covers', () => {
        const events = [
            allDay('One', '2026-11-23', 3),
            allDay('Two', '2026-11-23', 2),
            allDay('Three', '2026-11-24', 2),
        ];
        const layout = monthWeekLayout(week, events, 2);
        expect(layout.bars.map((b) => b.event.title)).toEqual(['One', 'Two']);
        expect(layout.hidden).toEqual([0, 1, 1, 0, 0, 0, 0]);
    });
});

describe('layoutTimedEvents', () => {
    const day = [new Date(2026, 10, 24)];

    function columns(events: CalendarEventOccurrence[], days: readonly Date[] = day) {
        return layoutTimedEvents(events, days).map((blocks) =>
            blocks.map((b) => [b.event.title, b.top, b.bottom, b.column, b.columns, b.span]),
        );
    }

    test('places one event by wall-clock minutes', () => {
        expect(columns([timed('A', tue, 9, 10.5)])).toEqual([[['A', 540, 630, 0, 1, 1]]]);
    });

    test('three events overlapping at 14:00 share three columns', () => {
        const events = [timed('A', tue, 13, 15), timed('B', tue, 13.5, 14.5), timed('C', tue, 14, 16)];
        expect(columns(events)).toEqual([
            [
                ['A', 780, 900, 0, 3, 1],
                ['B', 810, 870, 1, 3, 1],
                ['C', 840, 960, 2, 3, 1],
            ],
        ]);
    });

    test('a chain A over B over C reuses the first column for C', () => {
        const events = [timed('A', tue, 9, 10), timed('B', tue, 9.5, 11), timed('C', tue, 10.5, 12)];
        expect(columns(events)).toEqual([
            [
                ['A', 540, 600, 0, 2, 1],
                ['B', 570, 660, 1, 2, 1],
                ['C', 630, 720, 0, 2, 1],
            ],
        ]);
    });

    test('an event widens right while the neighbouring columns are free', () => {
        const events = [
            timed('A', tue, 9, 11),
            timed('B', tue, 9, 10),
            timed('C', tue, 9, 10),
            timed('D', tue, 10, 11),
        ];
        expect(columns(events)).toEqual([
            [
                ['A', 540, 660, 0, 3, 1],
                ['B', 540, 600, 1, 3, 1],
                ['C', 540, 600, 2, 3, 1],
                ['D', 600, 660, 1, 3, 2],
            ],
        ]);
    });

    test('events that do not overlap are separate clusters', () => {
        expect(columns([timed('A', tue, 9, 10), timed('B', tue, 10, 11)])).toEqual([
            [
                ['A', 540, 600, 0, 1, 1],
                ['B', 600, 660, 0, 1, 1],
            ],
        ]);
    });

    test('an event crossing midnight is split per local day', () => {
        const days = localDays(2026, 11, 24, 2);
        expect(columns([timed('Late', tue, 22, 26)], days)).toEqual([
            [['Late', 1320, 1440, 0, 1, 1]],
            [['Late', 0, 120, 0, 1, 1]],
        ]);
    });

    test('all-day events and timed ones of 24 hours or more stay out of the grid', () => {
        expect(columns([allDay('A', '2026-11-24', 1), timed('Long', tue, 0, 24)])).toEqual([[]]);
    });

    test('a zero-length event gets the minimum visual length, kept inside the day', () => {
        expect(columns([timed('Ping', tue, 9, 9), timed('Late', tue, 23.75, 23.75)])).toEqual([
            [
                ['Ping', 540, 540 + SNAP_MINUTES, 0, 1, 1],
                ['Late', 1440 - SNAP_MINUTES, 1440, 0, 1, 1],
            ],
        ]);
    });

    test('a spring-forward day keeps 09:00 at 09:00', () => {
        const dst = [new Date(2026, 2, 29)];
        const events = [timed('Morning', [2026, 3, 29], 9, 10), timed('Night', [2026, 3, 29], 1, 4)];
        // 04:00 is three wall hours after 01:00, though only two pass on 29 March.
        expect(columns(events, dst)).toEqual([
            [
                ['Night', 60, 240, 0, 1, 1],
                ['Morning', 540, 600, 0, 1, 1],
            ],
        ]);
    });

    test('a fall-back day keeps 09:00 at 09:00 and ends at 1440', () => {
        const dst = [new Date(2026, 9, 25)];
        const events = [timed('Morning', [2026, 10, 25], 9, 10), timed('Evening', [2026, 10, 25], 23, 25)];
        expect(columns(events, dst)).toEqual([
            [
                ['Morning', 540, 600, 0, 1, 1],
                ['Evening', 1380, 1440, 0, 1, 1],
            ],
        ]);
    });
});

describe('slotAt', () => {
    test('snaps down to the slot the minute is in, inside the day', () => {
        expect([0, 14, 15, 600.5, 1439, 1440, -5].map(slotAt)).toEqual([0, 0, 15, 600, 1425, 1425, 0]);
    });
});

describe('slotRange', () => {
    test('keeps the pressed slot and stretches to the snap line nearest the pointer, either way', () => {
        expect(slotRange(605, 690)).toEqual({ top: 600, bottom: 690 });
        expect(slotRange(605, 612)).toEqual({ top: 600, bottom: 615 });
        expect(slotRange(605, 548)).toEqual({ top: 555, bottom: 615 });
        expect(slotRange(1430, 1500)).toEqual({ top: 1425, bottom: 1440 });
        expect(slotRange(20, -30)).toEqual({ top: 0, bottom: 30 });
    });
});

describe('movedTimes', () => {
    test('an all-day event steps whole UTC days and ignores minutes', () => {
        const trip = allDay('Trip', '2026-11-24', 2);
        expect(movedTimes(trip, 2, 90)).toEqual({
            startTime: new Date('2026-11-26T00:00:00Z'),
            endTime: new Date('2026-11-28T00:00:00Z'),
        });
    });

    test('a timed event steps local days and snapped minutes, keeping its length', () => {
        expect(movedTimes(timed('A', tue, 9, 10), 1, 37)).toEqual({
            startTime: new Date(2026, 10, 25, 9, 30),
            endTime: new Date(2026, 10, 25, 10, 30),
        });
    });

    test('a move onto a spring-forward day keeps the wall-clock time', () => {
        const moved = movedTimes(timed('A', [2026, 3, 28], 9, 10), 1, 0);
        expect(moved.startTime.toISOString()).toBe('2026-03-29T07:00:00.000Z');
        expect(moved.endTime.toISOString()).toBe('2026-03-29T08:00:00.000Z');
    });

    test('a move onto a fall-back day keeps the wall-clock time', () => {
        const moved = movedTimes(timed('A', [2026, 10, 24], 9, 10), 1, 0);
        expect(moved.startTime.toISOString()).toBe('2026-10-25T08:00:00.000Z');
        expect(moved.endTime.toISOString()).toBe('2026-10-25T09:00:00.000Z');
    });
});

describe('resizedTimes', () => {
    test('moves the end to the snapped minute of its day', () => {
        expect(resizedTimes(timed('A', tue, 9, 10), 680)).toEqual({
            startTime: new Date(2026, 10, 24, 9, 0),
            endTime: new Date(2026, 10, 24, 11, 15),
        });
    });

    test('keeps the event at least one slot long', () => {
        expect(resizedTimes(timed('A', tue, 9, 10), 500).endTime).toEqual(new Date(2026, 10, 24, 9, 15));
    });

    test('an event crossing midnight resizes on its last day', () => {
        expect(resizedTimes(timed('Late', tue, 22, 26), 180).endTime).toEqual(new Date(2026, 10, 25, 3, 0));
    });
});

describe('rescheduleScopes', () => {
    const series = (fields: Fields) => event({ rrule: 'FREQ=WEEKLY', ...fields });
    const all = ['this', 'this-and-following', 'all'] as const;

    test('a single event saves without a choice', () => {
        const a = timed('A', tue, 9, 10);
        expect(rescheduleScopes(a, movedTimes(a, 1, 0))).toEqual([]);
    });

    test('a series occurrence at another time on its day offers every scope', () => {
        const a = series({ startTime: new Date(2026, 10, 24, 9), endTime: new Date(2026, 10, 24, 10) });
        expect(rescheduleScopes(a, movedTimes(a, 0, 120))).toEqual(all);
    });

    test('a series occurrence on another day offers only this event', () => {
        const a = series({ startTime: new Date(2026, 10, 24, 9), endTime: new Date(2026, 10, 24, 10) });
        expect(rescheduleScopes(a, movedTimes(a, 1, 0))).toEqual(['this']);
    });

    test('a moved override of a series is a series occurrence too', () => {
        const a = event({
            parentEventId: 'master',
            startTime: new Date(2026, 10, 24, 9),
            endTime: new Date(2026, 10, 24, 10),
        });
        expect(rescheduleScopes(a, movedTimes(a, 1, 0))).toEqual(['this']);
    });

    test('an override moved within its day has no rule to cut, so it offers this event and all', () => {
        const a = event({
            parentEventId: 'master',
            startTime: new Date(2026, 10, 24, 9),
            endTime: new Date(2026, 10, 24, 10),
        });
        expect(rescheduleScopes(a, movedTimes(a, 0, 120))).toEqual(['this', 'all']);
    });

    test("the day is judged in the series' zone, not the viewer's", () => {
        // 17:00 in New York is 23:00 in Amsterdam: two hours later is the next day here, the same day there.
        const ny = series({
            timezone: 'America/New_York',
            startTime: new Date('2026-11-24T22:00:00Z'),
            endTime: new Date('2026-11-24T23:00:00Z'),
        });
        expect(rescheduleScopes(ny, movedTimes(ny, 0, 120))).toEqual(all);
        // Nine hours later is 08:00 here and 02:00 the next day in New York.
        expect(rescheduleScopes(ny, movedTimes(ny, 0, 9 * 60))).toEqual(['this']);
    });

    test('an all-day series is judged by its UTC date', () => {
        const a = event({ ...allDay('A', '2026-11-24', 1), rrule: 'FREQ=WEEKLY' });
        expect(rescheduleScopes(a, movedTimes(a, 1, 0))).toEqual(['this']);
        expect(rescheduleScopes(a, movedTimes(a, 0, 0))).toEqual(all);
    });
});
