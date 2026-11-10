// A stored series on the calendar side: the occurrences of one master in a window, and how far an organizer's update
// may take a rule a guest shortened. The range reads and the inbound invitation paths call it. The wall-clock
// arithmetic and the limits on a rule belong to the iCalendar layer.

// Deep import (not the @workspace/lib/calendar barrel) to keep React out of the API module graph.
import { occurrenceDateToString, truncateRRule } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
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

// `cut` is the first date the guest's own "delete this and following" removed. An organizer's UNTIL before it stands,
// and any other end, a COUNT included, is cut there in the event's own UNTIL form, so nothing walks the rule.
export function constrainRRule(incoming: ParsedEvent, cut: string | null): string | null {
    if (!incoming.rrule || !cut) return incoming.rrule;
    const until = wallClockRule(incoming.rrule, incoming.timezone).until;
    if (until && occurrenceDateToString(until) < cut) return incoming.rrule;
    return truncateRRule(incoming.rrule, cut, incoming);
}
