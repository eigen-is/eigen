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

export function handleCalendarSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('calendar:')) return false;

    switch (event.type) {
        case SSEventType.CALENDAR_CREATED:
            if ('calendar' in event) invalidateCalendarCreated(queryClient, event.calendar.ownerId);
            return true;

        case SSEventType.CALENDAR_UPDATED:
            if ('calendar' in event) invalidateCalendarUpdated(queryClient, event.calendar.ownerId);
            return true;

        case SSEventType.CALENDAR_DELETED:
            if ('calendar' in event) invalidateCalendarDeleted(queryClient, event.calendar.ownerId);
            return true;

        case SSEventType.CALENDAR_EVENT_CREATED:
            if ('calendar' in event) invalidateEventCreated(queryClient, event.calendar.ownerId);
            return true;

        case SSEventType.CALENDAR_EVENT_UPDATED:
            if ('calendar' in event) invalidateEventUpdated(queryClient, event.calendar.ownerId);
            return true;

        case SSEventType.CALENDAR_EVENT_DELETED:
            if ('calendar' in event) invalidateEventDeleted(queryClient, event.calendar.ownerId);
            return true;

        case SSEventType.CALENDAR_SHARED:
            invalidateCalendarShared(queryClient, userId);
            if ('calendarShare' in event) toast('Calendar shared', {description: `"${event.calendarShare.calendarName}" was shared with you`});
            return true;

        case SSEventType.CALENDAR_UNSHARED:
            invalidateCalendarUnshared(queryClient, userId);
            if ('calendarShare' in event) toast('Calendar unshared', {description: `"${event.calendarShare.calendarName}" is no longer shared with you`});
            return true;

        case SSEventType.CALENDAR_INVITE_RECEIVED:
            invalidateEventCreated(queryClient, userId);
            if ('calendar' in event && event.calendar.title) toast('New invitation', {description: event.calendar.title});
            return true;

        case SSEventType.CALENDAR_INVITE_UPDATED:
            invalidateEventUpdated(queryClient, userId);
            return true;

        case SSEventType.CALENDAR_INVITE_CANCELLED:
            invalidateEventDeleted(queryClient, userId);
            return true;

        case SSEventType.CALENDAR_INVITE_RSVP:
            invalidateEventUpdated(queryClient, userId);
            return true;

        default:
            return false;
    }
}
