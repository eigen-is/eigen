// A stored series on the calendar side: the occurrences of one master in a window, and how far an organizer's update
// may take a rule a guest shortened. The range reads and the inbound invitation paths call it. The wall-clock
// arithmetic and the limits on a rule belong to the iCalendar layer.

// Deep import (not the @workspace/lib/calendar barrel) to keep React out of the API module graph.
import { occurrenceDateToString } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { RRule } from 'rrule';
import type { ParsedEvent } from '../ical/ical-parse';
import { expandWallClock, wallClockDate, wallClockRule } from '../ical/wall-clock';

export function expandRecurrence(event: CalendarEvent, rangeStart: Date, rangeEnd: Date): CalendarEventOccurrence[] {
    if (!event.rrule) return [];

    const durationMs = event.endTime.getTime() - event.startTime.getTime();
    const tz = event.timezone;
    // A zoned rule iterates in wall-clock space, so the window is padded a day each way for the offset and filtered
    // back after.
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

// A guest's copy ends at whichever comes first: an organizer's rule stands unless it yields a date past the guest's
// UNTIL, however it ends. One that runs on takes the guest's UNTIL as their rule spells it.
export function constrainRRule(incoming: ParsedEvent, local: string | null): string | null {
    if (!incoming.rrule || !local) return incoming.rrule;
    const tz = incoming.timezone;
    const until = wallClockRule(local, tz).until;
    if (!until) return incoming.rrule;
    const dtstart = tz ? wallClockDate(incoming.startTime, tz) : incoming.startTime;
    if (!new RRule({ ...wallClockRule(incoming.rrule, tz), dtstart }).after(until)) return incoming.rrule;
    const kept = incoming.rrule.split(';').filter((part) => !/^(UNTIL|COUNT)=/i.test(part));
    return [...kept, ...local.split(';').filter((part) => /^UNTIL=/i.test(part))].join(';');
}

// The last date a guest's shortened rule keeps, which constrainRRule holds every update to.
export function lastKeptDate(local: string | null, tz: string | null): string | null {
    const until = local && wallClockRule(local, tz).until;
    return until ? occurrenceDateToString(until) : null;
}
