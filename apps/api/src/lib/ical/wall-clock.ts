// Calendar time in a zone's wall clock: converting between an instant and local time, expanding an RRULE in
// local time, and the `YYYY-MM-DD` key an override, an exclusion or an RSVP names an occurrence by. Callers
// such as the iCalendar parser, the builder and the calendar store share it. It sits on the format side of
// the one-way edge, so `calendar` imports `ical`, never the reverse.

// Deep import (not the @workspace/lib/calendar barrel) to keep React out of the API module graph.
import { occurrenceDateToString } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import { RRule } from 'rrule';
import { MAX_OCCURRENCES, MAX_RECURRENCE_START } from './recurrence-limits';

type LocalComponents = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function utcToLocal(date: Date, tz: string): LocalComponents {
    const parts = getIntlFormatter(tz).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour') % 24,
        minute: get('minute'),
        second: get('second'),
    };
}

export function localToUtc(
    tz: string,
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
): Date {
    const targetMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetAt = (ms: number): number => {
        const local = utcToLocal(new Date(ms), tz);
        return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - ms;
    };

    let resolved = targetMs - offsetAt(targetMs);
    if (resolved + offsetAt(resolved) !== targetMs) {
        // The first guess landed the other side of a transition: solve again with the offset in effect there.
        const corrected = targetMs - offsetAt(resolved);
        // A wall time the spring-forward gap skips resolves with the pre-transition offset — the later instant.
        if (corrected + offsetAt(corrected) !== targetMs) return new Date(Math.max(resolved, corrected));
        resolved = corrected;
    }

    // RFC 5545 resolves an ambiguous fall-back time to the earlier occurrence. The step back is the day's own shift,
    // because Lord Howe moves 30 minutes.
    const shift = offsetAt(resolved - 86400_000) - offsetAt(resolved + 86400_000);
    const earlier = resolved - shift;
    return new Date(shift > 0 && earlier + offsetAt(earlier) === targetMs ? earlier : resolved);
}

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
        ...RRule.parseString(rrule),
        dtstart: tz ? wallClockDate(dtstart, tz) : dtstart,
    });

    return rule
        .between(from, to, true, (_d, len) => len < MAX_OCCURRENCES)
        .map((date) => ({
            startTime: tz ? fromWallClock(date, tz) : date,
            occurrenceDate: occurrenceDateToString(date),
        }));
}

// A key names a day in the series' wall clock, and only BYHOUR, BYMINUTE and BYSECOND move its time from DTSTART's, so
// the start follows from the key with no walk of the rule. A rule with several times a day keys to the earliest.
export function computeOccurrenceTimes(
    parent: CalendarEvent,
    recurrenceDate: string,
): { startTime: Date; endTime: Date } {
    const durationMs = parent.endTime.getTime() - parent.startTime.getTime();
    const tz = parent.timezone;
    const stated = tz ? wallClockDate(parent.startTime, tz) : parent.startTime;
    const rule = parent.rrule ? RRule.parseString(parent.rrule) : {};
    const earliest = (listed: number | number[] | null | undefined, own: number) => Math.min(...[listed ?? own].flat());
    const wall = new Date(`${recurrenceDate}T00:00:00Z`);
    wall.setUTCHours(
        earliest(rule.byhour, stated.getUTCHours()),
        earliest(rule.byminute, stated.getUTCMinutes()),
        earliest(rule.bysecond, stated.getUTCSeconds()),
    );
    const startTime = tz ? fromWallClock(wall, tz) : wall;
    return { startTime, endTime: new Date(startTime.getTime() + durationMs) };
}

const intlCache = new Map<string, Intl.DateTimeFormat>();

function getIntlFormatter(tz: string): Intl.DateTimeFormat {
    let formatter = intlCache.get(tz);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
        intlCache.set(tz, formatter);
    }
    return formatter;
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
