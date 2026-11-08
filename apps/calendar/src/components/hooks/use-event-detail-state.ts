// The event-detail selection MonthView and WeekView share, so the two can't drift: the clicked occurrence, the dialog's
// open flag, the once-only ?eventId deep-link auto-open, and the calendar lookup the dialog needs. The dialog always
// gets the occurrence as the current list has it, so what it shows and the etag it writes with follow every refetch.

import { isFreeBusyEvent, isSeriesOccurrence } from '@workspace/lib/calendar';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { useEffect, useRef, useState } from 'react';

type UseEventDetailStateOptions = {
    events: readonly CalendarEventOccurrence[];
    calendars: readonly CalendarItem[];
    sharedCalendars?: readonly SharedCalendar[];
    initialEventId?: string;
};

type UseEventDetailStateReturn = {
    handleEventClick: (event: CalendarEventOccurrence, e: React.MouseEvent) => void;
    detailDialogProps: {
        open: boolean;
        onOpenChange: (open: boolean) => void;
        event: CalendarEventOccurrence | null;
        calendar: CalendarItem | null;
        sharedCalendar: SharedCalendar | null;
    };
};

// An override keeps the occurrence date and series of the occurrence it replaces. A lone event is its id alone, since
// its date moves with it.
function isSameOccurrence(a: CalendarEventOccurrence, b: CalendarEventOccurrence): boolean {
    if ((a.parentEventId || a.id) !== (b.parentEventId || b.id)) return false;
    return !isSeriesOccurrence(a) || !isSeriesOccurrence(b) || a.occurrenceDate === b.occurrenceDate;
}

export function useEventDetailState({
    events,
    calendars,
    sharedCalendars,
    initialEventId,
}: UseEventDetailStateOptions): UseEventDetailStateReturn {
    const [clicked, setClicked] = useState<CalendarEventOccurrence | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);

    // Gone from the list, it stays on screen as clicked: a save of two writes is still running, or the event left this
    // view, and the next write's answer says what became of it.
    const selectedEvent = clicked && (events.find((e) => isSameOccurrence(e, clicked)) ?? clicked);

    const didAutoOpen = useRef(false);
    useEffect(() => {
        if (!initialEventId || events.length === 0 || didAutoOpen.current) return;
        const match = events.find(
            (e) => e.id === initialEventId || e.uid === initialEventId || e.data?.organizerEventId === initialEventId,
        );
        if (match && !isFreeBusyEvent(match)) {
            didAutoOpen.current = true;
            setClicked(match);
            setDetailOpen(true);
        }
    }, [initialEventId, events]);

    const handleEventClick = (event: CalendarEventOccurrence, e: React.MouseEvent) => {
        e.stopPropagation();
        if (isFreeBusyEvent(event)) return;
        setClicked(event);
        setDetailOpen(true);
    };

    const selectedCalendar = selectedEvent ? calendars.find((c) => c.id === selectedEvent.calendarId) || null : null;
    const selectedSharedCalendar =
        selectedEvent && !selectedCalendar
            ? sharedCalendars?.find((s) => s.calendarId === selectedEvent.calendarId) || null
            : null;

    return {
        handleEventClick,
        detailDialogProps: {
            open: detailOpen,
            onOpenChange: setDetailOpen,
            event: selectedEvent,
            calendar: selectedCalendar,
            sharedCalendar: selectedSharedCalendar,
        },
    };
}
