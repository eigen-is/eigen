// A stored series on the calendar side: the occurrences of one master in a window, and how far an organizer's update may
// take a rule a guest shortened. The range reads and the inbound invitation paths call it; the wall-clock arithmetic and
// the limits on a rule belong to the iCalendar layer.

// Deep import (not the @workspace/lib/calendar barrel) to keep React out of the API module graph.
import { occurrenceDateToString } from '@workspace/lib/calendar/calendar-utils';
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

// Two UNTILs of one series are of one kind, so they compare as rrule parses them. A longer rule takes the guest's UNTIL
// as their rule spells it.
export function constrainRRule(incoming: string | null, local: string | null): string | null {
    if (!incoming || !local) return incoming;
    const localUntil = RRule.parseString(local).until;
    const incomingUntil = RRule.parseString(incoming).until;
    if (!localUntil || (incomingUntil && incomingUntil <= localUntil)) return incoming;
    const kept = incoming.split(';').filter((part) => !/^(UNTIL|COUNT)=/i.test(part));
    return [...kept, ...local.split(';').filter((part) => /^UNTIL=/i.test(part))].join(';');
}

// The last date a guest's shortened rule keeps, which constrainRRule holds every update to.
export function lastKeptDate(local: string | null, tz: string | null): string | null {
    const until = local && wallClockRule(local, tz).until;
    return until ? occurrenceDateToString(until) : null;
}
