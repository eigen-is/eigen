// Calendar time in a zone's wall clock: converting between an instant and local time, expanding an RRULE in
// local time, and the `YYYY-MM-DD` key an override, an exclusion or an RSVP names an occurrence by. Callers
// such as the iCalendar parser, the builder and the calendar store share it. It sits on the format side of
// the one-way edge, so `calendar` imports `ical`, never the reverse.

// Deep import (not the @workspace/lib/calendar barrel) to keep React out of the API module graph.
import { normalizeTimezone, occurrenceDateToString } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import { RRule } from 'rrule';
import { isOutOfRangeRecurrenceStart, isSubDailyRrule, MAX_OCCURRENCES } from './recurrence-limits';

type LocalComponents = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const intlCache = new Map<string, Intl.DateTimeFormat>();

function getIntlFormatter(tz: string): Intl.DateTimeFormat {
    let fmt = intlCache.get(tz);
    if (!fmt) {
        // Degrade a pre-existing poisoned TZID to UTC instead of throwing RangeError (heals already-broken rows).
        const safeZone = normalizeTimezone(tz) ?? 'UTC';
        fmt = new Intl.DateTimeFormat('en-GB', {
            timeZone: safeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
        intlCache.set(tz, fmt);
    }
    return fmt;
}

export function utcToLocal(date: Date, tz: string): LocalComponents {
    const fmt = getIntlFormatter(tz);
    const parts = fmt.formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) => parseInt(parts.find((p) => p.type === type)!.value, 10);
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

    // RFC 5545 resolves an ambiguous fall-back time to the earlier occurrence; the step back is the day's own shift, and Lord Howe moves 30 minutes.
    const shift = offsetAt(resolved - 86400_000) - offsetAt(resolved + 86400_000);
    const earlier = resolved - shift;
    return new Date(shift > 0 && earlier + offsetAt(earlier) === targetMs ? earlier : resolved);
}

// rrule's own tzid handling is broken, so expansion runs in this wall-clock space instead.
export function wallClockDate(date: Date, tz: string): Date {
    const local = utcToLocal(date, tz);
    return new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second));
}

// Four digits, or `Date.parse` reads the year as no date; a year outside 0 to 9999 has no key, so a file naming one is refused.
export function recurrenceKey(year: number, month: number, day: number): string {
    if (year < 0 || year > 9999) throw new Error(`No recurrence key for year ${year}`);
    const pad = (n: number, width: number) => String(n).padStart(width, '0');
    return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

// A key someone else wrote, where an old client sends a full ISO datetime; one naming no date is null, as RRule.between throws on it.
export function parseRecurrenceKey(value: string): string | null {
    const key = value.substring(0, 10);
    return Number.isNaN(Date.parse(`${key}T00:00:00Z`)) ? null : key;
}

// A zoned rule iterates in wall-clock space and each hit converts back; the window stays in whatever space the caller asked in.
export function expandWallClock(
    rrule: string,
    dtstart: Date,
    tz: string | null,
    from: Date,
    to: Date,
): { startTime: Date; occurrenceDate: string }[] {
    const rule = new RRule({
        ...RRule.parseString(rrule),
        dtstart: tz ? wallClockDate(dtstart, tz) : dtstart,
    });

    return rule
        .between(from, to, true, (_d, len) => len < MAX_OCCURRENCES)
        .map((date) => ({
            startTime: tz
                ? localToUtc(
                      tz,
                      date.getUTCFullYear(),
                      date.getUTCMonth() + 1,
                      date.getUTCDate(),
                      date.getUTCHours(),
                      date.getUTCMinutes(),
                      date.getUTCSeconds(),
                  )
                : date,
            occurrenceDate: occurrenceDateToString(date),
        }));
}

export function computeOccurrenceTimes(
    parent: CalendarEvent,
    recurrenceDate: string,
): { startTime: Date; endTime: Date } {
    const durationMs = parent.endTime.getTime() - parent.startTime.getTime();
    const tz = parent.timezone;
    const occDate = new Date(`${recurrenceDate}T00:00:00Z`);

    // A sub-daily rule or out-of-range dtstart (untrusted files only) would iterate to the day window and hang.
    if (parent.rrule && !isSubDailyRrule(parent.rrule) && !isOutOfRangeRecurrenceStart(parent.startTime)) {
        const dayEnd = new Date(occDate);
        dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
        const matches = expandWallClock(parent.rrule, parent.startTime, tz, occDate, dayEnd);
        if (matches.length > 0) {
            const startTime = matches[0].startTime;
            return { startTime, endTime: new Date(startTime.getTime() + durationMs) };
        }
    }

    // Fallback: place dtstart's time-of-day onto the occurrence date
    if (tz) {
        const local = utcToLocal(parent.startTime, tz);
        const startTime = localToUtc(
            tz,
            occDate.getUTCFullYear(),
            occDate.getUTCMonth() + 1,
            occDate.getUTCDate(),
            local.hour,
            local.minute,
            local.second,
        );
        return { startTime, endTime: new Date(startTime.getTime() + durationMs) };
    }

    const startTime = new Date(
        occDate.getTime() +
            parent.startTime.getUTCHours() * 3600_000 +
            parent.startTime.getUTCMinutes() * 60_000 +
            parent.startTime.getUTCSeconds() * 1000,
    );
    return { startTime, endTime: new Date(startTime.getTime() + durationMs) };
}
