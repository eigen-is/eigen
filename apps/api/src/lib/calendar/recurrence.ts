// A stored series on the calendar side: the occurrences of one master in a window, and how far an organizer's update may
// take a rule a guest shortened. The range reads and the inbound invitation paths call it; the wall-clock arithmetic and
// the limits on a rule belong to the iCalendar layer.

// Deep import (not the @workspace/lib/calendar barrel) to keep React out of the API module graph.
import { occurrenceDateToString, truncateRRule } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { RRule } from 'rrule';
import { expandWallClock, wallClockDate, wallClockRule } from '../ical/wall-clock';

export function expandRecurrence(event: CalendarEvent, rangeStart: Date, rangeEnd: Date): CalendarEventOccurrence[] {
    if (!event.rrule) return [];

    const durationMs = event.endTime.getTime() - event.startTime.getTime();
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
    const localUntil = ruleUntil(local);
    if (!incoming || !localUntil) return incoming;
    const incomingUntil = ruleUntil(incoming);
    if (incomingUntil && incomingUntil <= localUntil) return incoming;
    return truncateRRule(incoming, new Date(localUntil.getTime() + 86400_000));
}

// The last date a guest's shortened rule keeps, which constrainRRule holds every update to.
export function lastKeptDate(local: string | null, tz: string | null): string | null {
    const until = local && wallClockRule(local, tz).until;
    return until ? occurrenceDateToString(until) : null;
}

function ruleUntil(rrule: string | null): Date | null {
    return rrule ? (RRule.parseString(rrule).until ?? null) : null;
}
