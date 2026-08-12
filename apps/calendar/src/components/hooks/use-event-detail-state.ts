import { isFreeBusyEvent } from '@workspace/lib/calendar';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { useEffect, useRef, useState } from 'react';

type UseEventDetailStateOptions = {
    events: CalendarEventOccurrence[];
    calendars: CalendarItem[];
    sharedCalendars?: SharedCalendar[];
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

// Event-detail selection shared by MonthView and WeekView so the two can't drift: the picked event,
// the dialog's open flag, the once-only ?eventId deep-link auto-open, and the calendar lookup the
// dialog needs. detailDialogProps spreads straight onto <EventDetailDialog>.
export function useEventDetailState({
    events,
    calendars,
    sharedCalendars,
    initialEventId,
}: UseEventDetailStateOptions): UseEventDetailStateReturn {
    const [selectedEvent, setSelectedEvent] = useState<CalendarEventOccurrence | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);

    const didAutoOpen = useRef(false);
    useEffect(() => {
        if (!initialEventId || events.length === 0 || didAutoOpen.current) return;
        const match = events.find(
            (e) => e.id === initialEventId || e.uid === initialEventId || e.data?.organizerEventId === initialEventId,
        );
        if (match && !isFreeBusyEvent(match)) {
            didAutoOpen.current = true;
            setSelectedEvent(match);
            setDetailOpen(true);
        }
    }, [initialEventId, events]);

    const handleEventClick = (event: CalendarEventOccurrence, e: React.MouseEvent) => {
        e.stopPropagation();
        if (isFreeBusyEvent(event)) return;
        setSelectedEvent(event);
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
