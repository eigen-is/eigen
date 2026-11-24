// The event-detail selection the calendar views share, such as the month view: the clicked occurrence, the dialog's open
// flag, the once-only ?eventId deep-link auto-open, and the calendar and owner the dialog needs. The dialog always gets
// the occurrence as the current list has it, so what it shows and the etag it writes with follow every refetch.

import { useAuth } from '@workspace/lib/auth';
import { isFreeBusyEvent } from '@workspace/lib/calendar';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { useEffect, useRef, useState } from 'react';
import { eventOwnerId, isSameOccurrence } from '../calendar-utils';

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
        ownerId: string;
    };
};

export function useEventDetailState({
    events,
    calendars,
    sharedCalendars,
    initialEventId,
}: UseEventDetailStateOptions): UseEventDetailStateReturn {
    const { user } = useAuth();
    const [clicked, setClicked] = useState<CalendarEventOccurrence | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);

    // Gone from the list, it stays on screen as clicked: a save of two writes is still running, or the event left this
    // view, and the next write's answer says what became of it.
    const current = clicked && events.find((e) => isSameOccurrence(e, clicked));
    const selectedEvent = current ?? clicked;

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
            ownerId: selectedEvent
                ? eventOwnerId(selectedEvent, calendars, sharedCalendars, user?.id)
                : (user?.id ?? ''),
        },
    };
}
