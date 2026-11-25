// Which event the calendar view's detail column shows: the one its URL names, as the current list has it, so what the
// column shows and the etag it writes with follow every refetch. The URL names an event by its series' id, or by the
// uid or organizer's id a link carries, and an occurrence of a series by its date; a link with no date opens the
// occurrence nearest the view's day. While the list lacks it, such as during a save or a refetch, the column keeps the
// last copy it found. The view route calls it with the URL's pair and the events it loaded.

import { useAuth } from '@workspace/lib/auth';
import { isFreeBusyEvent, isSeriesOccurrence } from '@workspace/lib/calendar';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { useState } from 'react';

export type EventKey = { eventId: string; occurrence?: string };

type UseEventDetailStateOptions = {
    events: readonly CalendarEventOccurrence[];
    calendars: readonly CalendarItem[];
    sharedCalendars?: readonly SharedCalendar[];
    open: EventKey | undefined;
    focus: Date;
};

type UseEventDetailStateReturn = {
    event: CalendarEventOccurrence | null;
    calendar: CalendarItem | null;
    sharedCalendar: SharedCalendar | null;
    // The Home the event is saved in: the viewer's, or the owner's of the calendar shared with them.
    ownerId: string;
};

export function eventKey(event: CalendarEventOccurrence): EventKey {
    return {
        eventId: event.parentEventId || event.id,
        occurrence: isSeriesOccurrence(event) ? event.occurrenceDate : undefined,
    };
}

export function useEventDetailState({
    events,
    calendars,
    sharedCalendars,
    open,
    focus,
}: UseEventDetailStateOptions): UseEventDetailStateReturn {
    const { user } = useAuth();
    const [kept, setKept] = useState<CalendarEventOccurrence | null>(null);

    let found: CalendarEventOccurrence | null = null;
    for (const e of events) {
        if (!open || isFreeBusyEvent(e) || !isNamedBy(e, open)) continue;
        if (!found || distance(e, focus) < distance(found, focus)) found = e;
    }
    if (found && found !== kept) setKept(found);
    const event = found ?? (kept && open && isNamedBy(kept, open) ? kept : null);

    const calendar = event ? (calendars.find((c) => c.id === event.calendarId) ?? null) : null;
    const sharedCalendar =
        event && !calendar ? (sharedCalendars?.find((s) => s.calendarId === event.calendarId) ?? null) : null;

    return { event, calendar, sharedCalendar, ownerId: sharedCalendar?.ownerUserId ?? user?.id ?? '' };
}

// An occurrence stays itself through a new override, which carries its series as the parent and keeps its date, and a
// lone event, or a series whose rule went, stays itself on any date.
function isNamedBy(event: CalendarEventOccurrence, { eventId, occurrence }: EventKey): boolean {
    const named =
        event.id === eventId ||
        event.parentEventId === eventId ||
        event.uid === eventId ||
        event.data?.organizerEventId === eventId;
    return named && (!occurrence || !isSeriesOccurrence(event) || event.occurrenceDate === occurrence);
}

function distance(event: CalendarEventOccurrence, focus: Date): number {
    return Math.abs(event.startTime.getTime() - focus.getTime());
}
