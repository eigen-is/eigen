// Deep import (not the @workspace/lib/calendar barrel) to keep React out of the API module graph.
import { occurrenceDateToString, truncateRRule } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { RRule } from 'rrule';
import { isOutOfRangeRecurrenceStart, isSubDailyRrule, MAX_OCCURRENCES } from './recurrence-limits';
import { normalizeTimezone } from './timezone';

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

function utcToLocal(date: Date, tz: string): LocalComponents {
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

function localToUtc(
    tz: string,
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
): Date {
    const guessMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const local = utcToLocal(new Date(guessMs), tz);
    const localMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const offsetMs = localMs - guessMs;
    const adjusted = new Date(guessMs - offsetMs);
    const verify = utcToLocal(adjusted, tz);
    const verifyMs = Date.UTC(verify.year, verify.month - 1, verify.day, verify.hour, verify.minute, verify.second);
    if (verifyMs !== guessMs) {
        const offsetMs2 = verifyMs - guessMs;
        return new Date(guessMs - offsetMs2);
    }
    return adjusted;
}

// Convert a real UTC instant to the Date whose UTC fields hold its wall-clock time in tz — the space
// rrule expands in, since rrule's own tzid handling is broken.
function wallClockDate(date: Date, tz: string): Date {
    const local = utcToLocal(date, tz);
    return new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second));
}

export function expandRecurrence(event: CalendarEvent, rangeStart: Date, rangeEnd: Date): CalendarEventOccurrence[] {
    if (!event.rrule) return [];

    const durationMs = event.endTime.getTime() - event.startTime.getTime();

    // Defence in depth: only a legacy stored row can still hold a sub-daily rrule or an out-of-range
    // dtstart (the write and ICS boundaries now reject/strip them). Never feed one to rrule.between —
    // it would iterate to the window and hang. Surface just the base occurrence if it falls in the
    // window (treat as a single event, matching the ingest-time degrade).
    if (isSubDailyRrule(event.rrule) || isOutOfRangeRecurrenceStart(event.startTime)) {
        if (event.startTime >= rangeStart && event.startTime <= rangeEnd) {
            return [{ ...event, occurrenceDate: occurrenceDateToString(event.startTime) }];
        }
        return [];
    }

    const tz = event.timezone;

    if (tz) {
        // Timezone-aware expansion: convert to wall-clock, let rrule work in wall-clock space,
        // then convert results back to real UTC. This avoids rrule's broken built-in tzid handling.
        const rule = new RRule({
            ...RRule.parseString(event.rrule),
            dtstart: wallClockDate(event.startTime, tz),
        });

        // Pad range by ±1 day to handle timezone offset edge cases, then filter
        const wallClockFrom = wallClockDate(new Date(rangeStart.getTime() - 86400_000), tz);
        const wallClockTo = wallClockDate(new Date(rangeEnd.getTime() + 86400_000), tz);

        // Cap the number of occurrences materialised (see recurrence-limits) — bounds the array and the
        // iteration for an allowed frequency over a very wide window.
        const dates = rule.between(wallClockFrom, wallClockTo, true, (_d, len) => len < MAX_OCCURRENCES);
        const results: CalendarEventOccurrence[] = [];

        for (const date of dates) {
            const startTime = localToUtc(
                tz,
                date.getUTCFullYear(),
                date.getUTCMonth() + 1,
                date.getUTCDate(),
                date.getUTCHours(),
                date.getUTCMinutes(),
                date.getUTCSeconds(),
            );
            if (startTime >= rangeStart && startTime <= rangeEnd) {
                results.push({
                    ...event,
                    startTime,
                    endTime: new Date(startTime.getTime() + durationMs),
                    occurrenceDate: occurrenceDateToString(date),
                });
            }
        }
        return results;
    }

    // No timezone: original UTC behavior
    const rule = new RRule({
        ...RRule.parseString(event.rrule),
        dtstart: event.startTime,
    });

    const dates = rule.between(rangeStart, rangeEnd, true, (_d, len) => len < MAX_OCCURRENCES);

    return dates.map((date) => ({
        ...event,
        startTime: date,
        endTime: new Date(date.getTime() + durationMs),
        occurrenceDate: occurrenceDateToString(date),
    }));
}

export function constrainRRule(incoming: string | null, local: string | null): string | null {
    if (!incoming || !local) return incoming;
    const localUntil = RRule.parseString(local).until ?? null;
    if (!localUntil) return incoming;
    const incomingUntil = RRule.parseString(incoming).until ?? null;
    if (incomingUntil && incomingUntil <= localUntil) return incoming;
    return truncateRRule(incoming, new Date(localUntil.getTime() + 86400_000));
}

export function computeOccurrenceTimes(
    parent: CalendarEvent,
    recurrenceDate: string,
): { startTime: Date; endTime: Date } {
    const durationMs = parent.endTime.getTime() - parent.startTime.getTime();
    const tz = parent.timezone;
    const occDate = new Date(`${recurrenceDate}T00:00:00Z`);

    // Skip a sub-daily rrule or out-of-range dtstart (only a legacy stored row can hold one) — it
    // would iterate to the day window and hang; fall through to the time-of-day fallback below.
    if (parent.rrule && !isSubDailyRrule(parent.rrule) && !isOutOfRangeRecurrenceStart(parent.startTime)) {
        if (tz) {
            // Timezone-aware: expand in wall-clock space, convert back to UTC
            const rule = new RRule({
                ...RRule.parseString(parent.rrule),
                dtstart: wallClockDate(parent.startTime, tz),
            });
            const dayStart = new Date(occDate);
            const dayEnd = new Date(occDate);
            dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
            const matches = rule.between(dayStart, dayEnd, true, (_d, len) => len < MAX_OCCURRENCES);
            if (matches.length > 0) {
                const match = matches[0];
                const startTime = localToUtc(
                    tz,
                    match.getUTCFullYear(),
                    match.getUTCMonth() + 1,
                    match.getUTCDate(),
                    match.getUTCHours(),
                    match.getUTCMinutes(),
                    match.getUTCSeconds(),
                );
                return { startTime, endTime: new Date(startTime.getTime() + durationMs) };
            }
        } else {
            const rule = new RRule({ ...RRule.parseString(parent.rrule), dtstart: parent.startTime });
            const dayStart = new Date(occDate);
            const dayEnd = new Date(occDate);
            dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
            const matches = rule.between(dayStart, dayEnd, true, (_d, len) => len < MAX_OCCURRENCES);
            if (matches.length > 0) {
                const startTime = matches[0];
                return { startTime, endTime: new Date(startTime.getTime() + durationMs) };
            }
        }
    }

    // Fallback: place dtstart's time-of-day onto the occurrence date
    if (tz) {
        const local = utcToLocal(parent.startTime, tz);
        const occDateParts = occDate.toISOString().substring(0, 10).split('-');
        const startTime = localToUtc(
            tz,
            parseInt(occDateParts[0], 10),
            parseInt(occDateParts[1], 10),
            parseInt(occDateParts[2], 10),
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
