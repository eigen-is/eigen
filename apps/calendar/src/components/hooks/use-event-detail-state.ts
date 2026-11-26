// Which event the calendar view's detail column shows: the one its URL names, as the current list has it, so what the
// column shows and the etag it writes with follow every refetch. The URL names an event by its series' id, uid or
// organizer's id, and an occurrence by its date; a link with no date opens the one nearest the view's day. While the
// list lacks it, such as during a save, the column keeps the last copy it found until the URL closes it, and after a
// save the URL takes the saved occurrence's key. The view route calls it with the URL's pair and the events it loaded.

import { useAuth } from '@workspace/lib/auth';
import { isFreeBusyEvent, isSeriesOccurrence } from '@workspace/lib/calendar';
import type {
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { useEffect, useEffectEvent, useState } from 'react';
import { isSameOccurrence } from '../calendar-utils';

export type EventKey = { eventId: string; occurrence?: string };

// A save as Edit event or a drop hands it back: the occurrence it started from, the event the server stored, and
// where that occurrence starts now.
export type EventSave = { occurrence: CalendarEventOccurrence; saved: CalendarEvent; startTime: Date };

type UseEventDetailStateOptions = {
    events: readonly CalendarEventOccurrence[];
    calendars: readonly CalendarItem[];
    sharedCalendars?: readonly SharedCalendar[];
    open: EventKey | undefined;
    focus: Date;
    // The key the URL moves to after a save, or null to close the column.
    onFollow: (next: EventKey | null) => void;
};

type UseEventDetailStateReturn = {
    event: CalendarEventOccurrence | null;
    calendar: CalendarItem | null;
    sharedCalendar: SharedCalendar | null;
    // The Home the event is saved in: the viewer's, or the owner's of the calendar shared with them.
    ownerId: string;
    onSaved: (save: EventSave) => void;
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
    onFollow,
}: UseEventDetailStateOptions): UseEventDetailStateReturn {
    const { user } = useAuth();
    const [kept, setKept] = useState<CalendarEventOccurrence | null>(null);
    // The last save, until the render after it, which reads the list the save refetched.
    const [save, setSave] = useState<EventSave | null>(null);

    let found: CalendarEventOccurrence | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    for (const e of events) {
        if (!open || isFreeBusyEvent(e) || !isNamedBy(e, open)) continue;
        const distance = Math.abs(e.startTime.getTime() - focus.getTime());
        if (distance < nearest) {
            found = e;
            nearest = distance;
        }
    }
    if (found && found !== kept) setKept(found);
    if (!open && kept) setKept(null);
    const event = found ?? (kept && open && isNamedBy(kept, open) ? kept : null);

    const calendar = event ? (calendars.find((c) => c.id === event.calendarId) ?? null) : null;
    const sharedCalendar =
        event && !calendar ? (sharedCalendars?.find((s) => s.calendarId === event.calendarId) ?? null) : null;

    // A save can give the open occurrence another key, such as a series split at "this and following".
    const follow = useEffectEvent(({ occurrence, saved, startTime }: EventSave) => {
        if (!open || !event || !isSameOccurrence(occurrence, event)) return;
        // The saved event's occurrence at its new start, else the open key while the list still names it.
        const landed = events.find(
            (e) => (e.id === saved.id || e.parentEventId === saved.id) && e.startTime.getTime() === startTime.getTime(),
        );
        const next = landed ? eventKey(landed) : events.some((e) => isNamedBy(e, open)) ? open : null;
        if (!next || next.eventId !== open.eventId || next.occurrence !== open.occurrence) onFollow(next);
    });
    useEffect(() => {
        if (!save) return;
        setSave(null);
        follow(save);
    }, [save]);

    return {
        event,
        calendar,
        sharedCalendar,
        ownerId: sharedCalendar?.ownerUserId ?? user?.id ?? '',
        onSaved: setSave,
    };
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
