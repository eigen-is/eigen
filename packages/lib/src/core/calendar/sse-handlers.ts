import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import {
    invalidateCalendarCreated,
    invalidateCalendarDeleted,
    invalidateCalendarShared,
    invalidateCalendarUnshared,
    invalidateCalendarUpdated,
    invalidateEventCreated,
    invalidateEventDeleted,
    invalidateEventUpdated,
} from './hooks/keys';

export function handleCalendarSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('calendar:')) return false;

    switch (event.type) {
        case SSEventType.CALENDAR_CREATED:
            invalidateCalendarCreated(queryClient, event.ownerId);
            return true;

        case SSEventType.CALENDAR_UPDATED:
            invalidateCalendarUpdated(queryClient, event.ownerId);
            return true;

        case SSEventType.CALENDAR_DELETED:
            invalidateCalendarDeleted(queryClient, event.ownerId);
            return true;

        case SSEventType.CALENDAR_EVENT_CREATED:
            invalidateEventCreated(queryClient, event.ownerId);
            return true;

        case SSEventType.CALENDAR_EVENT_UPDATED:
            invalidateEventUpdated(queryClient, event.ownerId);
            return true;

        case SSEventType.CALENDAR_EVENT_DELETED:
            invalidateEventDeleted(queryClient, event.ownerId);
            return true;

        case SSEventType.CALENDAR_SHARED:
            invalidateCalendarShared(queryClient, userId);
            return true;

        case SSEventType.CALENDAR_UNSHARED:
            invalidateCalendarUnshared(queryClient, userId);
            return true;

        case SSEventType.CALENDAR_INVITE_RECEIVED:
            invalidateEventCreated(queryClient, userId);
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
