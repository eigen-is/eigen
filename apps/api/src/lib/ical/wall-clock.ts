// Calendar time in a zone's wall clock: an RRULE read and expanded in local time, an occurrence's start from its
// key, and the `YYYY-MM-DD` key an override, an exclusion or an RSVP names an occurrence by. Callers such as the
// iCalendar parser, the builder and the calendar store share it. It sits on the format side of the one-way edge,
// so `calendar` imports `ical`, never the reverse.

// Deep import (not the @workspace/lib/calendar barrel) to keep React out of the API module graph.
import { localToUtc, occurrenceDateToString, utcToLocal } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import type { Options } from 'rrule';
import { RRule } from 'rrule';
import { MAX_OCCURRENCES, MAX_RECURRENCE_START } from './recurrence-limits';

// rrule's own tzid handling is broken, so expansion runs in this wall-clock space instead.
export function wallClockDate(date: Date, tz: string): Date {
    const local = utcToLocal(date, tz);
    return new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second));
}

// Four digits, or `Date.parse` reads the year as no date.
export function recurrenceKey(year: number, month: number, day: number): string {
    if (year > 9999) throw new Error(`No recurrence key for year ${year}`);
    const pad = (n: number, width: number) => String(n).padStart(width, '0');
    return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

// The key of the day an instant falls on in a zone's wall clock, or in UTC without one.
export function recurrenceKeyIn(instant: Date, tz: string | null): string {
    if (!tz) return recurrenceKey(instant.getUTCFullYear(), instant.getUTCMonth() + 1, instant.getUTCDate());
    const { year, month, day } = utcToLocal(instant, tz);
    return recurrenceKey(year, month, day);
}

// `Date.parse` reads 30 February as 2 March, so only a date that comes back unchanged is a key.
export function parseRecurrenceKey(value: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return recurrenceKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()) === value ? value : null;
}

// A zoned rule iterates in wall-clock space and each hit converts back. The window stays in whatever space the caller
// asked in.
export function expandWallClock(
    rrule: string,
    dtstart: Date,
    tz: string | null,
    from: Date,
    to: Date,
): { startTime: Date; occurrenceDate: string }[] {
    // The walk goes from DTSTART to the window, so a window this far out has no repeats.
    if (from.getTime() > MAX_RECURRENCE_START) return [];

    const rule = new RRule({
        ...wallClockRule(rrule, tz),
        dtstart: tz ? wallClockDate(dtstart, tz) : dtstart,
    });

    return rule
        .between(from, to, true, (_d, len) => len < MAX_OCCURRENCES)
        .map((date) => ({
            startTime: tz ? fromWallClock(date, tz) : date,
            occurrenceDate: occurrenceDateToString(date),
        }));
}

// RFC 5545 makes a UTC UNTIL beside a zoned start an instant, so it moves into the wall clock the rule steps in. A
// date-only or floating UNTIL names wall-clock time already, and rrule parses all three alike.
export function wallClockRule(rrule: string, tz: string | null): Partial<Options> {
    const options = RRule.parseString(rrule);
    if (tz && options.until && /UNTIL=\d{8}T\d{6}Z/i.test(rrule)) options.until = wallClockDate(options.until, tz);
    return options;
}

export function computeOccurrenceTimes(
    parent: CalendarEvent,
    recurrenceDate: string,
): { startTime: Date; endTime: Date } {
    const durationMs = parent.endTime.getTime() - parent.startTime.getTime();
    const startTime = occurrenceStart(parent.startTime, parent.timezone, parent.rrule, recurrenceDate);
    return { startTime, endTime: new Date(startTime.getTime() + durationMs) };
}

// A key names a day in the series' wall clock, and only BYHOUR, BYMINUTE and BYSECOND move its time from DTSTART's, so
// the start follows from the key with no walk of the rule. A rule with several times a day keys to the earliest.
export function occurrenceStart(dtstart: Date, tz: string | null, rrule: string | null, recurrenceDate: string): Date {
    const stated = tz ? wallClockDate(dtstart, tz) : dtstart;
    const rule = rrule ? RRule.parseString(rrule) : {};
    const earliest = (listed: number | number[] | null | undefined, own: number) => Math.min(...[listed ?? own].flat());
    const wall = new Date(`${recurrenceDate}T00:00:00Z`);
    wall.setUTCHours(
        earliest(rule.byhour, stated.getUTCHours()),
        earliest(rule.byminute, stated.getUTCMinutes()),
        earliest(rule.bysecond, stated.getUTCSeconds()),
    );
    return tz ? fromWallClock(wall, tz) : wall;
}

function fromWallClock(date: Date, tz: string): Date {
    return localToUtc(
        tz,
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
    );
}
