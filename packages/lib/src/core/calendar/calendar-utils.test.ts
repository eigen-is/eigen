import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CalendarEventOccurrence } from '../../types/calendar';
import { formatEventWhen, getEventsForDay } from './calendar-utils';

function occurrence(occurrenceDate: string, startTime: Date, endTime: Date): CalendarEventOccurrence {
    return {
        id: 'evt-1',
        calendarId: 'cal-1',
        uid: 'uid-1',
        uri: 'uid-1.ics',
        title: 'Late Sunday',
        description: null,
        location: null,
        startTime,
        endTime,
        allDay: false,
        rrule: 'FREQ=WEEKLY;BYDAY=SU',
        timezone: 'Europe/Amsterdam',
        parentEventId: null,
        recurrenceDate: null,
        status: 'confirmed',
        sequence: 0,
        etag: 'etag-1',
        data: null,
        createByUserId: null,
        createdAt: new Date('2025-09-14T21:00:00Z'),
        updatedAt: new Date('2025-09-14T21:00:00Z'),
        occurrenceDate,
    };
}

describe('getEventsForDay', () => {
    // Day buckets are built from the runtime's local timezone, like the browser's.
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = 'Europe/Amsterdam';
    });
    afterAll(() => {
        process.env.TZ = originalTz;
    });

    // Weekly Sunday 23:30 Europe/Amsterdam, as expanded by the API (real UTC instants).
    const weekly = [
        occurrence('2025-10-19', new Date('2025-10-19T21:30:00Z'), new Date('2025-10-19T22:00:00Z')), // CEST
        occurrence('2025-10-26', new Date('2025-10-26T22:30:00Z'), new Date('2025-10-26T23:00:00Z')), // fall-back day, CET
        occurrence('2025-11-02', new Date('2025-11-02T22:30:00Z'), new Date('2025-11-02T23:00:00Z')), // CET
    ];

    test('keeps a 23:30 occurrence on the 25-hour DST fall-back day', () => {
        const hits = getEventsForDay(weekly, new Date(2025, 9, 26));
        expect(hits.map((e) => e.occurrenceDate)).toEqual(['2025-10-26']);
    });

    test('does not shift the fall-back occurrence to the next day', () => {
        expect(getEventsForDay(weekly, new Date(2025, 9, 27))).toEqual([]);
    });

    test('keeps neighbouring Sundays on their own day', () => {
        expect(getEventsForDay(weekly, new Date(2025, 9, 19)).map((e) => e.occurrenceDate)).toEqual(['2025-10-19']);
        expect(getEventsForDay(weekly, new Date(2025, 10, 2)).map((e) => e.occurrenceDate)).toEqual(['2025-11-02']);
    });

    test("keeps next year's fall-back Sunday too", () => {
        const occ = [occurrence('2026-10-25', new Date('2026-10-25T22:30:00Z'), new Date('2026-10-25T23:00:00Z'))];
        expect(getEventsForDay(occ, new Date(2026, 9, 25)).map((e) => e.occurrenceDate)).toEqual(['2026-10-25']);
    });

    test('does not duplicate an early-morning event onto the 23-hour spring-forward day', () => {
        // 00:30 CEST on Mon 2025-03-31 = 22:30Z on Mar 30; the 25th hour of a +24h bucket for Sun Mar 30.
        const occ = [occurrence('2025-03-31', new Date('2025-03-30T22:30:00Z'), new Date('2025-03-30T23:00:00Z'))];
        expect(getEventsForDay(occ, new Date(2025, 2, 30))).toEqual([]);
        expect(getEventsForDay(occ, new Date(2025, 2, 31)).map((e) => e.occurrenceDate)).toEqual(['2025-03-31']);
    });
});

describe('formatEventWhen', () => {
    const start = new Date('2026-09-10T09:00:00Z');
    const end = new Date('2026-09-10T10:00:00Z');

    test('a valid IANA zone shifts the wall-clock time', () => {
        // Sept 2026 is CEST (UTC+2), so 09:00Z renders as 11:00.
        expect(formatEventWhen(start, end, false, 'Europe/Amsterdam')).toContain('11:00');
    });

    test('a non-IANA zone (pre-normalization stored TZID) degrades to UTC instead of throwing', () => {
        expect(formatEventWhen(start, end, false, 'W. Europe Standard Time')).toBe(
            formatEventWhen(start, end, false, 'UTC'),
        );
    });
});
