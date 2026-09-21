// Deep import (not the @workspace/lib/calendar barrel) to keep React out of the API module graph.
import { occurrenceDateToString, truncateRRule } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { RRule } from 'rrule';
import { isOutOfRangeRecurrenceStart, isSubDailyRrule, MAX_OCCURRENCES } from '../ical/recurrence-limits';
import { localToUtc, wallClockDate } from '../ical/wall-clock';

// What the index does with a stored series: expand it over a window, and bound an organizer's rule by
// what the attendee kept. The wall-clock arithmetic itself belongs to the format layer.

export function expandRecurrence(event: CalendarEvent, rangeStart: Date, rangeEnd: Date): CalendarEventOccurrence[] {
    if (!event.rrule) return [];

    const durationMs = event.endTime.getTime() - event.startTime.getTime();

    // Defense in depth: only an untrusted file can still carry a sub-daily rrule or an out-of-range
    // dtstart (the write and ICS boundaries reject/strip them). Never feed one to rrule.between — it
    // would iterate to the window and hang. Surface just the base occurrence if it falls in the
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
