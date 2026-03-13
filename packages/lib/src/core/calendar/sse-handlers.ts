import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {
    invalidateCalendarCreated,
    invalidateCalendarUpdated,
    invalidateCalendarDeleted,
    invalidateEventCreated,
    invalidateEventUpdated,
    invalidateEventDeleted,
    invalidateCalendarShared,
    invalidateCalendarUnshared,
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
            return true;

        case SSEventType.CALENDAR_UNSHARED:
            invalidateCalendarUnshared(queryClient);
            return true;

        default:
            return false;
    }
}
