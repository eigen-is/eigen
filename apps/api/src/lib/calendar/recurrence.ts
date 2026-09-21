// Deep import (not the @workspace/lib/calendar barrel) to keep React out of the API module graph.
import { occurrenceDateToString, truncateRRule } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { RRule } from 'rrule';
import { isOutOfRangeRecurrenceStart, isSubDailyRrule } from '../ical/recurrence-limits';
import { expandWallClock, wallClockDate } from '../ical/wall-clock';

// Expanding and bounding a stored series only; the wall-clock arithmetic belongs to the format layer.

export function expandRecurrence(event: CalendarEvent, rangeStart: Date, rangeEnd: Date): CalendarEventOccurrence[] {
    if (!event.rrule) return [];

    const durationMs = event.endTime.getTime() - event.startTime.getTime();

    // Never feed a sub-daily rule or an out-of-range dtstart to rrule.between — it iterates to the window and hangs.
    if (isSubDailyRrule(event.rrule) || isOutOfRangeRecurrenceStart(event.startTime)) {
        if (event.startTime >= rangeStart && event.startTime <= rangeEnd) {
            return [{ ...event, occurrenceDate: occurrenceDateToString(event.startTime) }];
        }
        return [];
    }

    const tz = event.timezone;
    // A zoned rule iterates in wall-clock space, so the window is padded by ±1 day for the offset and filtered back after.
    const from = tz ? wallClockDate(new Date(rangeStart.getTime() - 86400_000), tz) : rangeStart;
    const to = tz ? wallClockDate(new Date(rangeEnd.getTime() + 86400_000), tz) : rangeEnd;

    const results: CalendarEventOccurrence[] = [];
    for (const { startTime, occurrenceDate } of expandWallClock(event.rrule, event.startTime, tz, from, to)) {
        if (startTime < rangeStart || startTime > rangeEnd) continue;
        results.push({
            ...event,
            startTime,
            endTime: new Date(startTime.getTime() + durationMs),
            occurrenceDate,
        });
    }
    return results;
}

export function constrainRRule(incoming: string | null, local: string | null): string | null {
    if (!incoming || !local) return incoming;
    const localUntil = RRule.parseString(local).until ?? null;
    if (!localUntil) return incoming;
    const incomingUntil = RRule.parseString(incoming).until ?? null;
    if (incomingUntil && incomingUntil <= localUntil) return incoming;
    return truncateRRule(incoming, new Date(localUntil.getTime() + 86400_000));
}
