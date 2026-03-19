import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {toast} from 'sonner';
import {
    invalidateCalendarCreated,
    invalidateCalendarDeleted,
    invalidateCalendarShared,
    invalidateCalendarUnshared,
    invalidateCalendarUpdated,
    invalidateEventCreated,
    invalidateEventDeleted,
    invalidateEventUpdated,
} from './hooks/use-calendar';

export function handleCalendarSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event?.type?.startsWith('calendar:')) return false;

    switch (event.type) {
        case SSEventType.CALENDAR_CREATED:
            invalidateCalendarCreated(queryClient);
            return true;

        case SSEventType.CALENDAR_UPDATED:
            invalidateCalendarUpdated(queryClient);
            return true;

        case SSEventType.CALENDAR_DELETED:
            invalidateCalendarDeleted(queryClient);
            return true;

        case SSEventType.CALENDAR_EVENT_CREATED:
            invalidateEventCreated(queryClient);
            return true;

        case SSEventType.CALENDAR_EVENT_UPDATED:
            invalidateEventUpdated(queryClient);
            return true;

        case SSEventType.CALENDAR_EVENT_DELETED:
            invalidateEventDeleted(queryClient);
            return true;

        case SSEventType.CALENDAR_SHARED:
            invalidateCalendarShared(queryClient);
            if ('calendarShare' in event) toast('Calendar shared', {description: `"${event.calendarShare.calendarName}" was shared with you`});
            return true;

        case SSEventType.CALENDAR_UNSHARED:
            invalidateCalendarUnshared(queryClient);
            if ('calendarShare' in event) toast('Calendar unshared', {description: `"${event.calendarShare.calendarName}" is no longer shared with you`});
            return true;

        case SSEventType.CALENDAR_INVITE_RECEIVED:
            invalidateEventCreated(queryClient);
            if ('calendar' in event && event.calendar.title) toast('New invitation', {description: event.calendar.title});
            return true;

        case SSEventType.CALENDAR_INVITE_UPDATED:
            invalidateEventUpdated(queryClient);
            return true;

        case SSEventType.CALENDAR_INVITE_CANCELLED:
            invalidateEventDeleted(queryClient);
            return true;

        case SSEventType.CALENDAR_INVITE_RSVP:
            invalidateEventUpdated(queryClient);
            return true;

        default:
            return false;
    }
}
