// Zone math every expansion, every parsed TZID datetime and every serialized wall time runs through.
// A wall time an hour either side of a DST transition is the case that decides whether an occurrence
// lands on the clock its author named.
import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import { expandRecurrence } from '../../lib/calendar/recurrence';
import { localToUtc, utcToLocal } from '../../lib/ical/wall-clock';

// Each zone's 2026 transition days, and the wall times its spring-forward day skips. A skipped wall
// time resolves with the pre-transition offset, so the clock reads one gap later (RFC 5545 §3.3.5).
const ZONES = [
    { tz: 'America/New_York', days: ['2026-03-08', '2026-11-01'], gaps: ['2026-03-08 02:00', '2026-03-08 02:30'] },
    { tz: 'Europe/Amsterdam', days: ['2026-03-29', '2026-10-25'], gaps: ['2026-03-29 02:00', '2026-03-29 02:30'] },
    { tz: 'Australia/Sydney', days: ['2026-04-05', '2026-10-04'], gaps: ['2026-10-04 02:00', '2026-10-04 02:30'] },
    { tz: 'Pacific/Auckland', days: ['2026-04-05', '2026-09-27'], gaps: ['2026-09-27 02:00', '2026-09-27 02:30'] },
    { tz: 'Asia/Kolkata', days: ['2026-03-08', '2026-11-01'], gaps: [] },
    { tz: 'America/Sao_Paulo', days: ['2026-03-08', '2026-11-01'], gaps: [] },
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
                    const expected = gaps.includes(wall) ? `${date} ${pad(hour + 1)}:${pad(minute)}` : wall;
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
});
