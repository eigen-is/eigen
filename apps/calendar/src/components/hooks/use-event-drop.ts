// The drop state the calendar views share, such as the time grid's and the month's: which events a drag may move, the
// list with a dropped event drawn at its new place while its save asks and runs, and the props of the host that saves
// it, bound to the event's owner. The list stays the one truth: the host goes once the save has refetched it, and a
// cancel or a refused save puts the event back where the list has it.

import { useAuth } from '@workspace/lib/auth';
import type { EventTimes } from '@workspace/lib/calendar';
import { useCanReschedule } from '@workspace/lib/calendar';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { useState } from 'react';
import { eventOwnerId, isSameOccurrence } from '../calendar-utils';
import type { EventDropHostProps } from '../event-drop-host';

type UseEventDropOptions = {
    events: readonly CalendarEventOccurrence[];
    calendars: readonly CalendarItem[];
    sharedCalendars: readonly SharedCalendar[];
};

type UseEventDropReturn = {
    shownEvents: readonly CalendarEventOccurrence[];
    canDrag: (event: CalendarEventOccurrence) => boolean;
    drop: (event: CalendarEventOccurrence, moved: EventTimes) => void;
    dropHostProps: EventDropHostProps | null;
};

type Dropped = { event: CalendarEventOccurrence; moved: EventTimes };

export function useEventDrop({ events, calendars, sharedCalendars }: UseEventDropOptions): UseEventDropReturn {
    const { user } = useAuth();
    const canReschedule = useCanReschedule(calendars, sharedCalendars);
    const [dropped, setDropped] = useState<Dropped | null>(null);

    const isDropped = (e: CalendarEventOccurrence) => !!dropped && isSameOccurrence(e, dropped.event);
    const current = dropped && (events.find(isDropped) ?? dropped.event);

    return {
        shownEvents: dropped ? events.map((e) => (isDropped(e) ? { ...e, ...dropped.moved } : e)) : events,
        // One drop at a time, since a second would unmount the first one's host mid-save.
        canDrag: (event) => !dropped && canReschedule(event),
        drop: (event, moved) => {
            const start = moved.startTime.getTime() !== event.startTime.getTime();
            if (start || moved.endTime.getTime() !== event.endTime.getTime()) setDropped({ event, moved });
        },
        dropHostProps:
            dropped && current
                ? {
                      event: current,
                      moved: dropped.moved,
                      ownerId: eventOwnerId(current, calendars, sharedCalendars, user?.id),
                      onDone: () => setDropped(null),
                  }
                : null,
    };
}
