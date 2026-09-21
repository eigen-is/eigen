import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
    formatEventWhen,
    getEventsForDay,
    isInvitationFromOthers,
    isSeriesOccurrence,
    normalizeTimezone,
    rruleToText,
    viewerTimeZone,
} from '../../../core/calendar/calendar-utils';
import { WINDOWS_ZONES } from '../../../core/calendar/windows-zones';
import type { CalendarEventOccurrence, EventData } from '../../../types/calendar';

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

describe('isSeriesOccurrence', () => {
    const row = (rrule: string | null, parentEventId: string | null) => ({ rrule, parentEventId });

    test('the master and every occurrence expanded from it belong to a series', () => {
        expect(isSeriesOccurrence(row('FREQ=WEEKLY', null))).toBe(true);
    });

    test('an override belongs to its series even though it carries no rule of its own', () => {
        expect(isSeriesOccurrence(row(null, 'evt-master'))).toBe(true);
    });

    test('an event that repeats nowhere and overrides nothing is on its own', () => {
        expect(isSeriesOccurrence(row(null, null))).toBe(false);
    });
});

describe('isInvitationFromOthers', () => {
    const withOrganizer = (organizer: NonNullable<EventData['organizer']>) => ({ data: { organizer } });

    test('an organizer with the owner address is the owner, whatever its case', () => {
        const event = withOrganizer({ userId: '', email: 'Alice@Example.com', name: 'Alice' });
        expect(isInvitationFromOthers(event, 'alice@example.com')).toBe(false);
    });

    test('an owner without an address matches nobody', () => {
        // A team Home's synthetic user has no address, so a member-organized event on its calendar
        // stays a locked invitation rather than silently becoming the team's own event.
        const event = withOrganizer({ userId: 'team_7', email: 'someone@example.com' });
        expect(isInvitationFromOthers(event, '')).toBe(true);
    });

    test('another address is an invitation, and an event without an organizer never is', () => {
        const event = withOrganizer({ userId: 'bob-id', email: 'bob@example.com' });
        expect(isInvitationFromOthers(event, 'alice@example.com')).toBe(true);
        expect(isInvitationFromOthers({ data: null }, 'alice@example.com')).toBe(false);
    });
});

describe('formatEventWhen', () => {
    const start = new Date('2026-09-10T09:00:00Z');
    const end = new Date('2026-09-10T10:00:00Z');

    test('a valid IANA zone shifts the wall-clock time', () => {
        // Sept 2026 is CEST (UTC+2), so 09:00Z renders as 11:00.
        expect(formatEventWhen(start, end, false, 'Europe/Amsterdam', 'UTC')).toContain('11:00');
    });

    test('an event with no stored zone renders in the given fallback, not UTC', () => {
        // What the browser passes: the viewer zone the week grid positions the same event in.
        expect(formatEventWhen(start, end, false, null, 'Europe/Amsterdam')).toContain('11:00');
        expect(formatEventWhen(start, end, false, null, 'UTC')).toContain('9:00');
    });

    test('the viewer fallback agrees with the grid, which reads local Date getters', () => {
        const originalTz = process.env.TZ;
        process.env.TZ = 'Europe/Amsterdam';
        try {
            expect(formatEventWhen(start, end, false, null, viewerTimeZone())).toContain(
                `${start.getHours()}:${String(start.getMinutes()).padStart(2, '0')}`,
            );
        } finally {
            process.env.TZ = originalTz;
        }
    });

    test('an all-day event keeps its UTC date whatever the fallback is', () => {
        // Midnight-UTC bounds, exclusive end: one day, 10 Sept, for a viewer west of UTC too.
        const dayStart = new Date('2026-09-10T00:00:00Z');
        const dayEnd = new Date('2026-09-11T00:00:00Z');
        expect(formatEventWhen(dayStart, dayEnd, true, null, 'America/Los_Angeles')).toBe('Thursday, 10 Sep 2026');
    });

    test('a non-IANA zone (pre-normalization stored TZID) falls back instead of throwing', () => {
        expect(formatEventWhen(start, end, false, 'Not/A_Zone', 'Europe/Amsterdam')).toBe(
            formatEventWhen(start, end, false, null, 'Europe/Amsterdam'),
        );
    });
});

describe('rruleToText', () => {
    test('says a recurrence in words', () => {
        expect(rruleToText('FREQ=WEEKLY;BYDAY=SU')).toBe('every week on Sunday');
    });

    test('an event that does not repeat has nothing to say', () => {
        expect(rruleToText(null)).toBeNull();
    });

    // A file's own RRULE is untrusted input: the card prints it verbatim rather than nothing.
    test('a rule rrule cannot read comes back as itself', () => {
        expect(rruleToText('FREQ=NEVER')).toBe('FREQ=NEVER');
    });
});

// Every stored timezone, every parsed TZID and every serialized VEVENT passes through here, and one
// calendar file names the same handful of zones on every event it holds. The TZIDs are a stranger's
// strings, so whatever remembers an answer stays bounded and keeps answering correctly when it fills.
describe('normalizeTimezone', () => {
    test('an IANA zone is kept and anything else degrades to null', () => {
        expect(normalizeTimezone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
        expect(normalizeTimezone('Not/A_Zone')).toBeNull();
        expect(normalizeTimezone(null)).toBeNull();
        expect(normalizeTimezone('')).toBeNull();
    });

    test('a Windows zone name resolves to the IANA zone CLDR names for it', () => {
        expect(normalizeTimezone('W. Europe Standard Time')).toBe('Europe/Berlin');
        expect(normalizeTimezone('Pacific Standard Time')).toBe('America/Los_Angeles');
        expect(normalizeTimezone('AUS Eastern Standard Time')).toBe('Australia/Sydney');
    });

    test('every zone the Windows table names is one Intl knows', () => {
        expect([...WINDOWS_ZONES.keys()].filter((name) => normalizeTimezone(name) === null)).toEqual([]);
    });

    test('a file naming hundreds of zones still answers each of them correctly', () => {
        for (let i = 0; i < 500; i++) {
            expect(normalizeTimezone(`Not/A_Zone_${i}`)).toBeNull();
            expect(normalizeTimezone('Pacific/Auckland')).toBe('Pacific/Auckland');
        }

        expect(normalizeTimezone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
        expect(normalizeTimezone('Not/A_Zone')).toBeNull();
    });

    test('the zones one file repeats cost one formatter each', () => {
        const zones = ['Europe/Amsterdam', 'America/New_York', 'Pacific/Auckland', 'Not/A_Zone'];

        const startedAt = performance.now();
        for (let i = 0; i < 50_000; i++) normalizeTimezone(zones[i % zones.length]);

        expect(performance.now() - startedAt).toBeLessThan(300);
    });
});
